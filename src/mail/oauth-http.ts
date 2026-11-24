import { createMailServices, type MailServices, type WhoYouEnv } from "./config";
import type { CompleteOAuthLinkResult } from "./oauth-link";
import type { OAuthSyncFailureCode } from "./oauth-sync";
import type { MailboxProvider, MailboxRecord } from "./store";

/**
 * Shared HTTP and scheduled entry points for third-party identities (S7c/S7d).
 *
 * The callback never echoes the authorization code, state, token or provider
 * response body. Failures collapse to fixed codes from the security contract.
 */

export const OAUTH_SYNC_SWEEP_LIMIT = 20;
const SWEEP_TICK_MS = 5 * 60 * 1000;

/**
 * Rotate a fixed-size window on each scheduled slot; an early identity that
 * always fails or holds an unrecoverable lease cannot starve later mailboxes.
 * A wrapped page is read in two bounded queries without a persistent cursor.
 */
export function scheduledSyncBatchWindow(now: number, total: number): {
	offset: number;
	first: number;
	wrap: number;
} {
	if (!Number.isSafeInteger(total) || total <= 0) {
		return { offset: 0, first: 0, wrap: 0 };
	}
	const size = Math.min(total, OAUTH_SYNC_SWEEP_LIMIT);
	const slot = Math.floor(now / SWEEP_TICK_MS);
	const offset = ((slot % total) * size) % total;
	const first = Math.min(size, total - offset);
	return { offset, first, wrap: size - first };
}


const json = (status: number, body: Record<string, unknown>): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});

const statusFor = (code: string): number => (code === "invalid_state" ? 400 : 502);

export type OAuthCallbackHandler = (request: Request, env: WhoYouEnv) => Promise<Response>;

/**
 * `build` returns the provider's link function only when its client and the
 * credential vault are configured; that single check both closes the endpoint
 * and narrows the client types for the closure.
 */
export function createOAuthCallbackHandler(config: {
	path: string;
	build: (
		services: MailServices,
	) => ((input: { code: string; state: string }, now: number) => Promise<CompleteOAuthLinkResult>) | null;
}): OAuthCallbackHandler {
	return async (request, env) => {
		if (new URL(request.url).pathname !== config.path) {
			return json(404, { error: "not_found" });
		}
		const resolved = createMailServices(env);
		if (!resolved.ok) return json(503, { error: "mail_storage_not_configured" });
		const complete = config.build(resolved.services);
		if (!complete) return json(503, { error: "provider_not_configured" });

		const url = new URL(request.url);
		if (url.searchParams.get("error")) {
			// The provider returns access_denied or a consent error; the user must retry.
			return json(400, { error: "provider_reauth_required" });
		}
		const code = url.searchParams.get("code") ?? "";
		const state = url.searchParams.get("state") ?? "";
		if (!code || !state) return json(400, { error: "invalid_state" });

		const result = await complete({ code, state }, Date.now());
		if (!result.ok) return json(statusFor(result.code), { error: result.code });
		return json(200, {
			ok: true,
			mailboxId: result.mailboxId,
			address: result.address,
			relinked: result.relinked,
		});
	};
}

export type OAuthSyncSweepSummary = {
	identities: number;
	imported: number;
	failed: number;
	/** Identities that were not attempted because another writer owns them. */
	skipped: number;
	/** Latest `lastSyncedAt` actually persisted by this sweep. */
	lastSyncedAt: number | null;
};

export type OAuthSyncSweepOutcome =
	| { ok: true; imported: number }
	| { ok: false; code: OAuthSyncFailureCode };

/** The telemetry projector cannot receive account/mailbox identities. */
export function projectOAuthSyncMetric(
	provider: MailboxProvider,
	outcome: OAuthSyncSweepOutcome | null,
): {
	event: "whoyou_mail_sync";
	provider: MailboxProvider;
	outcome: "synced" | "skipped" | "failed";
	message_count: number;
	reason_code?: OAuthSyncFailureCode | "sync_failed";
} {
	if (outcome?.ok) {
		return { event: "whoyou_mail_sync", provider, outcome: "synced", message_count: outcome.imported };
	}
	const busy = outcome?.ok === false && outcome.code === "sync_in_progress";
	return {
		event: "whoyou_mail_sync", provider, outcome: busy ? "skipped" : "failed",
		message_count: 0, reason_code: outcome?.ok === false ? outcome.code : "sync_failed",
	};
}

/**
 * Cron sweep: at most 20 identities per tick, each bounded by the provider
 * module. A busy identity (another writer holds its lease) is counted as
 * skipped; any other failure records a fixed reason code and is retried next
 * tick. Logs only counters and fixed codes, never any account or mailbox identity.
 */
export async function runOAuthSyncSweep(
	env: WhoYouEnv,
	config: {
		provider: MailboxProvider;
		build: (
			services: MailServices,
		) => ((mailbox: MailboxRecord, now: number) => Promise<OAuthSyncSweepOutcome>) | null;
	},
	now: number = Date.now(),
	options: { transport?: MailServices["transport"] } = {},
): Promise<OAuthSyncSweepSummary> {
	const summary: OAuthSyncSweepSummary = {
		identities: 0,
		imported: 0,
		failed: 0,
		skipped: 0,
		lastSyncedAt: null,
	};
	const resolved = createMailServices(env, options);
	if (!resolved.ok) return summary;
	const sweep = config.build(resolved.services);
	if (!sweep) return summary;

	await resolved.services.oauthStates.deleteExpired(now).catch(() => 0);
	const total = await resolved.services.repository.countMailboxesByProvider(config.provider);
	const window = scheduledSyncBatchWindow(now, total);
	const mailboxes = window.first
		? await resolved.services.repository.listMailboxesByProvider(
				config.provider, window.first, window.offset,
			)
		: [];
	if (window.wrap) {
		mailboxes.push(...await resolved.services.repository.listMailboxesByProvider(
			config.provider, window.wrap, 0,
		));
	}
	for (const mailbox of mailboxes) {
		summary.identities += 1;
		try {
			const outcome = await sweep(mailbox, now);
			if (outcome.ok) {
				summary.imported += outcome.imported;
				// The sweep only reads the committed row to enrich its own summary;
				// that read cannot turn a successful batch into a reported failure.
				try {
					const state = await resolved.services.syncStates.get(mailbox.id);
					if (
						state?.lastSyncedAt != null &&
						(summary.lastSyncedAt === null || state.lastSyncedAt > summary.lastSyncedAt)
					) {
						summary.lastSyncedAt = state.lastSyncedAt;
					}
				} catch {
					// The batch has already settled; only the aggregate timestamp is absent.
				}
				console.log(JSON.stringify(projectOAuthSyncMetric(config.provider, outcome)));
				continue;
			}
			// A lease held by a manual call, another tick or an unlink is not a
			// provider failure: this tick simply imported nothing for that identity.
			const busy = outcome.code === "sync_in_progress";
			if (busy) summary.skipped += 1;
			else summary.failed += 1;
			console.log(JSON.stringify(projectOAuthSyncMetric(config.provider, outcome)));
		} catch {
			summary.failed += 1;
			console.log(JSON.stringify(projectOAuthSyncMetric(config.provider, null)));
		}
	}
	return summary;
}
