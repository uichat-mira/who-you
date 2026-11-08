import type { MailRepository } from "./store";

/**
 * Retention policy for S3.
 *
 * User mail (raw MIME, bodies, attachments) has no TTL: it lives until the user
 * deletes it, which is the approved default. The only time-bounded store in this
 * slice is the audit log. The bounce-record window is an approved value, but the
 * bounce store itself belongs to S4 and does not exist yet, so no sweep touches
 * it — this file is the single place S4 must inherit the number from.
 */

export type RetentionPolicy = {
	/** Audit entries are swept after this many days. */
	auditDays: number;
	/** Approved bounce-record window; enforced once S4 adds the bounce store. */
	bounceDays: number;
};

export type RetentionEnv = {
	MAIL_RETENTION_AUDIT_DAYS?: string;
	MAIL_RETENTION_BOUNCE_DAYS?: string;
};

export const DEFAULT_RETENTION: RetentionPolicy = {
	auditDays: 180,
	bounceDays: 90,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const positiveInt = (value: string | undefined, fallback: number): number => {
	if (!value) return fallback;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
};

/**
 * An invalid binding falls back to the documented default instead of disabling
 * the sweep, so a typo can never make retention infinite.
 */
export function resolveRetention(env: RetentionEnv): RetentionPolicy {
	return {
		auditDays: positiveInt(env.MAIL_RETENTION_AUDIT_DAYS, DEFAULT_RETENTION.auditDays),
		bounceDays: positiveInt(env.MAIL_RETENTION_BOUNCE_DAYS, DEFAULT_RETENTION.bounceDays),
	};
}

export type SweepResult = {
	deletedAuditEntries: number;
};

/** Deletes audit rows older than the policy window. Safe to re-run. */
export async function runRetentionSweep(
	repository: MailRepository,
	policy: RetentionPolicy,
	now: number,
): Promise<SweepResult> {
	const cutoff = now - policy.auditDays * DAY_MS;
	return { deletedAuditEntries: await repository.deleteAuditBefore(cutoff) };
}
