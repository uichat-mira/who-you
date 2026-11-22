import type { MailboxProvider } from "./store";

/**
 * Per-identity incremental sync cursor (S7c). A missing row means the identity
 * has never synced; `backfillBefore` marks the bounded initial scan.
 *
 * The row also carries the exclusive operation lease (OPS-044): Gmail sync,
 * unlink and relink share it. The expiry timestamp is diagnostic
 * only: a Cloudflare HTTP invocation can outlive an elapsed wall-clock TTL,
 * so time alone must never authorize another writer.
 */

/** Age at which an outstanding exclusive operation needs investigation. */
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
	 * Takes exclusive ownership for one still-linked identity. No automatic
	 * expiry takeover: D1 and R2 do not share an atomic fencing transaction.
	 * `true` means this caller owns the lease and must release it.
	 */
	async acquireLease(input: {
		mailboxId: string;
		accountId: string;
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
				 ) SELECT id, provider, NULL,NULL,NULL,NULL,NULL,NULL,?,?,?,?
				 FROM mailboxes WHERE id = ? AND account_id = ? AND provider = ?
				 ON CONFLICT (mailbox_id) DO UPDATE SET
				 lease_id = excluded.lease_id,
				 lease_expires_at = excluded.lease_expires_at,
				 updated_at = excluded.updated_at
				 WHERE mailbox_sync_state.lease_id IS NULL`,
			)
			.bind(
				input.leaseId,
				input.now + SYNC_LEASE_TTL_MS,
				input.now,
				input.now,
				input.mailboxId,
				input.accountId,
				input.provider,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	/** Releases only the exact owner after all its operations have settled. */
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
