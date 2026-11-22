import type { MailboxProvider } from "./store";

/**
 * Per-identity incremental sync cursor (S7c). A missing row means the identity
 * has never synced; `backfillBefore` marks the bounded initial scan.
 *
 * The row also carries the single-sync lease (OPS-044): a manual or scheduled
 * run must acquire it before touching a provider, so two batches can never run
 * the same identity concurrently. `leaseExpiresAt` lets a crashed run age out
 * instead of blocking the identity forever.
 */

/** Longer than one bounded batch; recovery is automatic after a crash. */
export const SYNC_LEASE_TTL_MS = 5 * 60_000;

export type MailboxSyncState = {
	mailboxId: string;
	provider: MailboxProvider;
	cursor: string | null;
	backfillBefore: number | null;
	backfillPage: string | null;
	backfillHistoryId: string | null;
	lastSyncedAt: number | null;
	lastError: string | null;
	leaseId: string | null;
	leaseExpiresAt: number | null;
};

type MailboxSyncStateRow = {
	mailbox_id: string;
	provider: MailboxProvider;
	cursor: string | null;
	backfill_before: number | null;
	backfill_page: string | null;
	backfill_history_id: string | null;
	last_synced_at: number | null;
	last_error: string | null;
	lease_id: string | null;
	lease_expires_at: number | null;
};

const toState = (row: MailboxSyncStateRow): MailboxSyncState => ({
	mailboxId: row.mailbox_id,
	provider: row.provider,
	cursor: row.cursor,
	backfillBefore: row.backfill_before,
	backfillPage: row.backfill_page,
	backfillHistoryId: row.backfill_history_id,
	lastSyncedAt: row.last_synced_at,
	lastError: row.last_error,
	leaseId: row.lease_id,
	leaseExpiresAt: row.lease_expires_at,
});

export class SyncStateRepository {
	constructor(private readonly db: D1Database) {}

	async get(mailboxId: string): Promise<MailboxSyncState | null> {
		const row = await this.db
			.prepare(
				`SELECT mailbox_id, provider, cursor, backfill_before, backfill_page,
				 backfill_history_id, last_synced_at, last_error, lease_id, lease_expires_at
				 FROM mailbox_sync_state WHERE mailbox_id = ?`,
			)
			.bind(mailboxId)
			.first<MailboxSyncStateRow>();
		return row ? toState(row) : null;
	}

	/**
	 * Takes the single sync lease for one identity. The conditional UPSERT is the
	 * whole race: an unexpired lease owned by any run makes the update a no-op.
	 * `true` means this caller owns the lease and must release it.
	 */
	async acquireLease(input: {
		mailboxId: string;
		provider: MailboxProvider;
		leaseId: string;
		now: number;
	}): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO mailbox_sync_state (
				 mailbox_id, provider, cursor, backfill_before, backfill_page,
				 backfill_history_id, last_synced_at, last_error,
				 lease_id, lease_expires_at, created_at, updated_at
				 ) VALUES (?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?,?)
				 ON CONFLICT (mailbox_id) DO UPDATE SET
				 lease_id = excluded.lease_id,
				 lease_expires_at = excluded.lease_expires_at,
				 updated_at = excluded.updated_at
				 WHERE mailbox_sync_state.lease_expires_at IS NULL
				 OR mailbox_sync_state.lease_expires_at <= ?`,
			)
			.bind(
				input.mailboxId,
				input.provider,
				input.leaseId,
				input.now + SYNC_LEASE_TTL_MS,
				input.now,
				input.now,
				input.now,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	/** Releases only this run's lease; a takeover by another run is untouched. */
	async releaseLease(mailboxId: string, leaseId: string, now: number): Promise<void> {
		await this.db
			.prepare(
				`UPDATE mailbox_sync_state
				 SET lease_id = NULL, lease_expires_at = NULL, updated_at = ?
				 WHERE mailbox_id = ? AND lease_id = ?`,
			)
			.bind(now, mailboxId, leaseId)
			.run();
	}

	async upsert(input: MailboxSyncState & { now: number }): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO mailbox_sync_state (
				 mailbox_id, provider, cursor, backfill_before, backfill_page,
				 backfill_history_id, last_synced_at, last_error, created_at, updated_at
				 ) VALUES (?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT (mailbox_id) DO UPDATE SET
				 cursor = excluded.cursor,
				 backfill_before = excluded.backfill_before,
				 backfill_page = excluded.backfill_page,
				 backfill_history_id = excluded.backfill_history_id,
				 last_synced_at = excluded.last_synced_at,
				 last_error = excluded.last_error,
				 updated_at = excluded.updated_at`,
			)
			.bind(
				input.mailboxId,
				input.provider,
				input.cursor,
				input.backfillBefore,
				input.backfillPage,
				input.backfillHistoryId,
				input.lastSyncedAt,
				input.lastError,
				input.now,
				input.now,
			)
			.run();
	}

	/** Records a fixed reason code; never a provider response body. */
	async markError(mailboxId: string, reason: string, now: number): Promise<void> {
		await this.db
			.prepare(
				`UPDATE mailbox_sync_state SET last_error = ?, updated_at = ?
				 WHERE mailbox_id = ?`,
			)
			.bind(reason, now, mailboxId)
			.run();
	}
}
