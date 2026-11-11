import { createMailServices, type WhoYouEnv } from "./config";
import { completeGmailLink, GMAIL_CALLBACK_PATH } from "./gmail-link";
import { syncGmailMailbox } from "./gmail-sync";

/**
 * HTTP and scheduled entry points for Gmail identities (S7c).
 *
 * The callback never echoes the authorization code, state, token or provider
 * response body. Failures collapse to fixed codes from the security contract.
 */

export const GMAIL_SYNC_CRON = "*/5 * * * *";
export const GMAIL_SYNC_SWEEP_LIMIT = 20;

const json = (status: number, body: Record<string, unknown>): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});

const statusFor = (code: string): number => (code === "invalid_state" ? 400 : 502);

export async function handleGmailCallback(
	request: Request,
	env: WhoYouEnv,
): Promise<Response> {
	if (new URL(request.url).pathname !== GMAIL_CALLBACK_PATH) {
		return json(404, { error: "not_found" });
	}
	const resolved = createMailServices(env);
	if (!resolved.ok) return json(503, { error: "mail_storage_not_configured" });
	const services = resolved.services;
	if (!services.oauth || !services.gmail || !services.credentialKeys) {
		return json(503, { error: "provider_not_configured" });
	}

	const url = new URL(request.url);
	if (url.searchParams.get("error")) {
		// Google returns access_denied or a policy error; the user must retry.
		return json(400, { error: "provider_reauth_required" });
	}
	const code = url.searchParams.get("code") ?? "";
	const state = url.searchParams.get("state") ?? "";
	if (!code || !state) return json(400, { error: "invalid_state" });

	const result = await completeGmailLink(
		{
			repository: services.repository,
			credentials: services.credentials,
			keys: services.credentialKeys,
			states: services.oauthStates,
			syncStates: services.syncStates,
			oauth: services.oauth,
			gmail: services.gmail,
			limits: services.limits,
			now: Date.now(),
		},
		{ code, state },
	);
	if (!result.ok) return json(statusFor(result.code), { error: result.code });
	return json(200, {
		ok: true,
		mailboxId: result.mailboxId,
		address: result.address,
		relinked: result.relinked,
	});
}

export type GmailSyncSweepSummary = {
	identities: number;
	imported: number;
	failed: number;
};

/**
 * Cron sweep: at most 20 identities per tick, each bounded to 20 messages. A
 * failed identity records a reason code and is retried on the next tick.
 */
export async function runGmailSyncSweep(
	env: WhoYouEnv,
	now: number = Date.now(),
): Promise<GmailSyncSweepSummary> {
	const summary: GmailSyncSweepSummary = { identities: 0, imported: 0, failed: 0 };
	const resolved = createMailServices(env);
	if (!resolved.ok) return summary;
	const services = resolved.services;
	if (!services.oauth || !services.gmail || !services.credentialKeys) return summary;

	await services.oauthStates.deleteExpired(now).catch(() => 0);
	const mailboxes = await services.repository.listMailboxesByProvider(
		"gmail",
		GMAIL_SYNC_SWEEP_LIMIT,
	);
	for (const mailbox of mailboxes) {
		summary.identities += 1;
		try {
			const outcome = await syncGmailMailbox(
				{
					repository: services.repository,
					limits: services.limits,
					credentials: services.credentials,
					keys: services.credentialKeys,
					oauth: services.oauth,
					gmail: services.gmail,
					syncStates: services.syncStates,
					now,
				},
				mailbox,
			);
			if (outcome.ok) {
				summary.imported += outcome.imported;
			} else {
				summary.failed += 1;
			}
			console.log(
				JSON.stringify({
					event: "whoyou_mail_sync",
					outcome: outcome.ok ? "synced" : "failed",
					provider: "gmail",
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
					provider: "gmail",
					accountId: mailbox.accountId,
					mailboxId: mailbox.id,
					reason_code: "sync_failed",
				}),
			);
		}
	}
	return summary;
}
