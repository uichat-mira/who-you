import type { WhoYouEnv } from "./config";
import { syncImapMailbox } from "./imap-sync";
import {
	runOAuthSyncSweep,
	type OAuthSyncSweepSummary,
} from "./oauth-http";
import type { MailTransport } from "./socket-transport";

/**
 * Scheduled sweep for user-supplied IMAP/SMTP identities (S7e).
 *
 * Reuses the OAuth sweep's budget, logging and failure isolation, with the
 * transport injectable so tests never open a real socket. There is no callback
 * endpoint because no browser redirect is involved.
 */
export function runImapSyncSweep(
	env: WhoYouEnv,
	now: number = Date.now(),
	options: { transport?: MailTransport } = {},
): Promise<OAuthSyncSweepSummary> {
	return runOAuthSyncSweep(
		env,
		{
			provider: "imap_smtp",
			build: (services) => (mailbox, at) =>
				syncImapMailbox(
					{
						repository: services.repository,
						limits: services.limits,
						credentials: services.credentials,
						keys: services.credentialKeys,
						syncStates: services.syncStates,
						remoteTargets: services.remoteTargets,
						transport: services.transport,
						now: at,
					},
					mailbox,
				),
		},
		now,
		options,
	);
}
