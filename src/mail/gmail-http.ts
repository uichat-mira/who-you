import type { WhoYouEnv } from "./config";
import { completeGmailLink, GMAIL_CALLBACK_PATH } from "./gmail-link";
import { syncGmailMailbox } from "./gmail-sync";
import {
	createOAuthCallbackHandler,
	OAUTH_SYNC_SWEEP_LIMIT,
	runOAuthSyncSweep,
	type OAuthSyncSweepSummary,
} from "./oauth-http";

/**
 * HTTP and scheduled entry points for Gmail identities (S7c). The shared
 * handler owns the callback contract and the cron sweep; this module only wires
 * the Gmail clients and keeps the public export names.
 */

export const GMAIL_SYNC_CRON = "*/5 * * * *";
export const GMAIL_SYNC_SWEEP_LIMIT = OAUTH_SYNC_SWEEP_LIMIT;

export const handleGmailCallback = createOAuthCallbackHandler({
	path: GMAIL_CALLBACK_PATH,
	build: (services) => {
		const { oauth, gmail, credentialKeys } = services;
		if (!oauth || !gmail || !credentialKeys) return null;
		return (input, now) =>
			completeGmailLink(
				{
					repository: services.repository,
					credentials: services.credentials,
					keys: credentialKeys,
					states: services.oauthStates,
					syncStates: services.syncStates,
					oauth,
					gmail,
					limits: services.limits,
					now,
				},
				input,
			);
	},
});

export type GmailSyncSweepSummary = OAuthSyncSweepSummary;

export function runGmailSyncSweep(
	env: WhoYouEnv,
	now: number = Date.now(),
): Promise<GmailSyncSweepSummary> {
	return runOAuthSyncSweep(
		env,
		{
			provider: "gmail",
			build: (services) => {
				const { oauth, gmail, credentialKeys } = services;
				if (!oauth || !gmail || !credentialKeys) return null;
				return (mailbox, sweepNow) =>
					syncGmailMailbox(
						{
							repository: services.repository,
							limits: services.limits,
							credentials: services.credentials,
							keys: credentialKeys,
							oauth,
							gmail,
							syncStates: services.syncStates,
							now: sweepNow,
						},
						mailbox,
					);
			},
		},
		now,
	);
}
