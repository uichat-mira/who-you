import { positiveInt } from "./limits";
import type { MailRepository } from "./store";

/**
 * Retention policy for S3 and S4.
 *
 * User mail (raw MIME, bodies, attachments) has no TTL: it lives until the user
 * deletes it, which is the approved default. Time-bounded stores are the audit
 * log and S4 delivery evidence. Suppressions are deliberately not swept: a hard
 * bounce must keep blocking that recipient until a human changes it.
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
	deletedDeliveryEvents: number;
	/** Relay nonces only need to outlive the accepted timestamp skew. */
	deletedWebhookNonces: number;
};

/** Deletes time-bounded evidence older than the policy window. Safe to re-run. */
export async function runRetentionSweep(
	repository: MailRepository,
	policy: RetentionPolicy,
	now: number,
): Promise<SweepResult> {
	const auditCutoff = now - policy.auditDays * DAY_MS;
	const bounceCutoff = now - policy.bounceDays * DAY_MS;
	const nonceCutoff = now - DAY_MS;
	return {
		deletedAuditEntries: await repository.deleteAuditBefore(auditCutoff),
		deletedDeliveryEvents: await repository.deleteDeliveryEventsBefore(bounceCutoff),
		deletedWebhookNonces: await repository.deleteWebhookNoncesBefore(nonceCutoff),
	};
}
