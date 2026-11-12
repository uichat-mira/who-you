import type { MailboxProvider } from "./store";

/**
 * Per-identity incremental sync cursor (S7c). A missing row means the identity
 * has never synced; `backfillBefore` marks the bounded initial scan.
 */

export type MailboxSyncState = {
	mailboxId: string;
	provider: MailboxProvider;
	cursor: string | null;
	backfillBefore: number | null;
	backfillPage: string | null;
	backfillHistoryId: string | null;
	lastSyncedAt: number | null;
	lastError: string | null;
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
});

export class SyncStateRepository {
	constructor(private readonly db: D1Database) {}

	async get(mailboxId: string): Promise<MailboxSyncState | null> {
		const row = await this.db
			.prepare(
				`SELECT mailbox_id, provider, cursor, backfill_before, backfill_page,
				 backfill_history_id, last_synced_at, last_error
				 FROM mailbox_sync_state WHERE mailbox_id = ?`,
			)
			.bind(mailboxId)
			.first<MailboxSyncStateRow>();
		return row ? toState(row) : null;
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
