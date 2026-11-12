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
};

export type OAuthSyncSweepOutcome =
	| { ok: true; imported: number }
	| { ok: false; code: OAuthSyncFailureCode };

/**
 * Cron sweep: at most 20 identities per tick, each bounded by the provider
 * module. A failed identity records a reason code and is retried next tick.
 * Logs only whitelisted fields, never an address or message content.
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
	const summary: OAuthSyncSweepSummary = { identities: 0, imported: 0, failed: 0 };
	const resolved = createMailServices(env, options);
	if (!resolved.ok) return summary;
	const sweep = config.build(resolved.services);
	if (!sweep) return summary;

	await resolved.services.oauthStates.deleteExpired(now).catch(() => 0);
	const mailboxes = await resolved.services.repository.listMailboxesByProvider(
		config.provider,
		OAUTH_SYNC_SWEEP_LIMIT,
	);
	for (const mailbox of mailboxes) {
		summary.identities += 1;
		try {
			const outcome = await sweep(mailbox, now);
			if (outcome.ok) {
				summary.imported += outcome.imported;
			} else {
				summary.failed += 1;
			}
			console.log(
				JSON.stringify({
					event: "whoyou_mail_sync",
					outcome: outcome.ok ? "synced" : "failed",
					provider: config.provider,
					accountId: mailbox.accountId,
					mailboxId: mailbox.id,
					message_count: outcome.ok ? outcome.imported : 0,
					reason_code: outcome.ok ? undefined : outcome.code,
				}),
			);
		} catch {
			summary.failed += 1;
			console.log(
				JSON.stringify({
					event: "whoyou_mail_sync",
					outcome: "failed",
					provider: config.provider,
					accountId: mailbox.accountId,
					mailboxId: mailbox.id,
					reason_code: "sync_failed",
				}),
			);
		}
	}
	return summary;
}
