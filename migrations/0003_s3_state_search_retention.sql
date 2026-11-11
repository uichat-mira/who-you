-- S3 mailbox state, signed download evidence and data-lifecycle model. See
-- docs/task-cards/WHO-S3-state-search-retention.md.
--
-- All timestamps are integer epoch milliseconds. Every query must be scoped by
-- the token-derived account id; message ids are opaque and never an authority
-- claim on their own.
--
-- Retention: user mail has no TTL (it lives until the user deletes it). The only
-- time-bounded rows are audit entries, swept after MAIL_RETENTION_AUDIT_DAYS.

-- Mailbox-level message state. Flags are shared mailbox state, not a per-consumer
-- ledger (v0 ledger stays unimplemented by decision).
ALTER TABLE messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN is_trashed INTEGER NOT NULL DEFAULT 0;
-- Monotonic revision for optimistic concurrency. It advances only when the
-- effective flag set actually changes, so a repeated identical write is a no-op.
ALTER TABLE messages ADD COLUMN flag_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN flags_updated_at INTEGER;

CREATE INDEX messages_mailbox_folder
	ON messages (mailbox_id, is_trashed, is_archived, state, received_at DESC, id);

-- Bounded, non-content audit trail. Never stores addresses, subjects, bodies or
-- attachment names; `detail` is a small machine-readable summary.
CREATE TABLE mail_audit_log (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('export', 'delete_message', 'delete_mailbox')),
	target_id TEXT,
	detail TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);

CREATE INDEX mail_audit_account_time ON mail_audit_log (account_id, created_at DESC);

-- One export per account per UTC calendar day. The unique key is the rate-limit
-- authority, so a concurrent second request loses the insert instead of
-- producing two packages.
CREATE TABLE mail_exports (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	mailbox_id TEXT NOT NULL,
	export_day TEXT NOT NULL,
	message_count INTEGER NOT NULL,
	skipped_count INTEGER NOT NULL DEFAULT 0,
	byte_size INTEGER NOT NULL,
	r2_key TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (account_id, export_day)
);

CREATE INDEX mail_exports_account ON mail_exports (account_id, created_at DESC);
