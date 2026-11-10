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
	/** Content-addressed attachment objects no attachments row references any more. */
	deletedAttachmentObjects: number;
};

/**
 * Grace period before an unreferenced attachment object may be reclaimed.
 *
 * Object bytes are written before the `attachments` row is inserted, so a
 * freshly written object can briefly have no reference. Sweeping inside that
 * window would delete the bytes of an inbound message still being committed.
 * 24h is far longer than any inbound write and keeps the sweep idempotent.
 */
export const ATTACHMENT_OBJECT_GRACE_MS = DAY_MS;

const ATTACHMENT_RECLAIM_BATCH = 200;

const reclaimAttachmentObjects = async (
	repository: MailRepository,
	cutoff: number,
): Promise<number> => {
	let deleted = 0;
	for (;;) {
		const batch = await repository.listUnreferencedAttachmentObjects(
			cutoff,
			ATTACHMENT_RECLAIM_BATCH,
		);
		if (!batch.length) break;
		for (const object of batch) {
			// Object first, row second. If the R2 delete throws, the row survives and
			// the next sweep run retries; the error is never swallowed.
			await repository.deleteObjects([object.r2Key]);
			await repository.deleteAttachmentObject(object.contentHash);
			deleted += 1;
		}
		if (batch.length < ATTACHMENT_RECLAIM_BATCH) break;
	}
	return deleted;
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
		deletedAttachmentObjects: await reclaimAttachmentObjects(
			repository,
			now - ATTACHMENT_OBJECT_GRACE_MS,
		),
	};
}
