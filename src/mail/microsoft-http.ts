import type { WhoYouEnv } from "./config";
import { completeMicrosoftLink, MICROSOFT_CALLBACK_PATH } from "./microsoft-link";
import { syncMicrosoftMailbox } from "./microsoft-sync";
import {
	createOAuthCallbackHandler,
	OAUTH_SYNC_SWEEP_LIMIT,
	runOAuthSyncSweep,
	type OAuthSyncSweepSummary,
} from "./oauth-http";

/**
 * HTTP and scheduled entry points for Microsoft identities (S7d). The shared
 * handler owns the callback contract and the cron sweep, including expiry of
 * stale one-time state rows.
 */

export const MICROSOFT_SYNC_SWEEP_LIMIT = OAUTH_SYNC_SWEEP_LIMIT;

export const handleMicrosoftCallback = createOAuthCallbackHandler({
	path: MICROSOFT_CALLBACK_PATH,
	build: (services) => {
		const { microsoftOauth, credentialKeys } = services;
		if (!microsoftOauth || !credentialKeys) return null;
		return (input, now) =>
			completeMicrosoftLink(
				{
					repository: services.repository,
					credentials: services.credentials,
					keys: credentialKeys,
					states: services.oauthStates,
					syncStates: services.syncStates,
					oauth: microsoftOauth,
					limits: services.limits,
					now,
				},
				input,
			);
	},
});

export type MicrosoftSyncSweepSummary = OAuthSyncSweepSummary;

export function runMicrosoftSyncSweep(
	env: WhoYouEnv,
	now: number = Date.now(),
): Promise<MicrosoftSyncSweepSummary> {
	return runOAuthSyncSweep(
		env,
		{
			provider: "microsoft",
			build: (services) => {
				const { microsoftOauth, microsoft, credentialKeys } = services;
				if (!microsoftOauth || !microsoft || !credentialKeys) return null;
				return (mailbox, sweepNow) =>
					syncMicrosoftMailbox(
						{
							repository: services.repository,
							limits: services.limits,
							credentials: services.credentials,
							keys: credentialKeys,
							oauth: microsoftOauth,
							microsoft,
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
