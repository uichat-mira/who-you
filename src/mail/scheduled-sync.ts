import type { WhoYouEnv } from "./config";
import { runGmailSyncSweep } from "./gmail-http";
import { runImapSyncSweep } from "./imap-http";
import { runMicrosoftSyncSweep } from "./microsoft-http";
import type { OAuthSyncSweepSummary } from "./oauth-http";
import type { MailboxProvider } from "./store";

/**
 * Scheduled third-party sync (OPS-045).
 *
 * Every provider reuses its existing bounded sweep; this module only decides
 * which providers a scheduled tick may touch. The allowlist is empty by
 * default, so a deployment that has not explicitly opted in performs no
 * provider request at all. That keeps an unverified Worker from silently
 * starting Gmail, Microsoft or IMAP sync merely because the cron exists.
 */

export const MAIL_SYNC_CRON = "*/5 * * * *";

const PROVIDERS: readonly MailboxProvider[] = ["gmail", "microsoft", "imap_smtp"];

const sweeps: Record<
	MailboxProvider,
	(env: WhoYouEnv, now: number) => Promise<OAuthSyncSweepSummary>
> = {
	gmail: runGmailSyncSweep,
	microsoft: runMicrosoftSyncSweep,
	imap_smtp: runImapSyncSweep,
};

/**
 * Parses the explicit allowlist. Unknown tokens, duplicates and casing are
 * irrelevant; only the exact provider names have any effect.
 */
export function resolveScheduledSyncProviders(env: {
	MAIL_SCHEDULE_SYNC_PROVIDERS?: string;
}): MailboxProvider[] {
	const configured = new Set(
		(env.MAIL_SCHEDULE_SYNC_PROVIDERS ?? "")
			.split(",")
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean),
	);
	return PROVIDERS.filter((provider) => configured.has(provider));
}

export type ScheduledSyncProviderSummary = OAuthSyncSweepSummary & {
	enabled: boolean;
};

export type ScheduledSyncSummary = {
	checkedAt: number;
	providers: Record<MailboxProvider, ScheduledSyncProviderSummary>;
};

const emptyProvider = (enabled: boolean): ScheduledSyncProviderSummary => ({
	enabled,
	identities: 0,
	imported: 0,
	failed: 0,
	skipped: 0,
	lastSyncedAt: null,
});

/**
 * Runs one bounded sweep per explicitly enabled provider. Only counts and fixed
 * codes are recorded; no address, subject, body or credential enters the log.
 */
export async function runScheduledSync(
	env: WhoYouEnv,
	now: number = Date.now(),
): Promise<ScheduledSyncSummary> {
	const enabled = new Set(resolveScheduledSyncProviders(env));
	const summary: ScheduledSyncSummary = {
		checkedAt: now,
		providers: {
			gmail: emptyProvider(enabled.has("gmail")),
			microsoft: emptyProvider(enabled.has("microsoft")),
			imap_smtp: emptyProvider(enabled.has("imap_smtp")),
		},
	};

	for (const provider of PROVIDERS) {
		if (!enabled.has(provider)) continue;
		const outcome = await sweeps[provider](env, now);
		summary.providers[provider] = { ...outcome, enabled: true };
	}

	const totals = PROVIDERS.map((provider) => summary.providers[provider]).reduce(
		(acc, run) => ({
			identities: acc.identities + run.identities,
			imported: acc.imported + run.imported,
			failed: acc.failed + run.failed,
			skipped: acc.skipped + run.skipped,
			lastSyncedAt:
				run.lastSyncedAt !== null && (acc.lastSyncedAt === null || run.lastSyncedAt > acc.lastSyncedAt)
					? run.lastSyncedAt
					: acc.lastSyncedAt,
		}),
		{
			identities: 0,
			imported: 0,
			failed: 0,
			skipped: 0,
			lastSyncedAt: null as number | null,
		},
	);

	console.log(
		JSON.stringify({
			event: "whoyou_mail_scheduled_sync",
			checkedAt: now,
			enabledProviders: [...enabled],
			identities: totals.identities,
			imported: totals.imported,
			failed: totals.failed,
			skipped: totals.skipped,
			lastSyncedAt: totals.lastSyncedAt,
			providers: Object.fromEntries(
				PROVIDERS.filter((provider) => enabled.has(provider)).map((provider) => [
					provider,
					{
						identities: summary.providers[provider].identities,
						imported: summary.providers[provider].imported,
						failed: summary.providers[provider].failed,
						skipped: summary.providers[provider].skipped,
					},
				]),
			),
		}),
	);

	return summary;
}
