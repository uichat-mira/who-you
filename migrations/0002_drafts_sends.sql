-- S2 draft / confirm / send model. See docs/task-cards/WHO-S2-draft-confirm-send.md.
--
-- All timestamps are integer epoch milliseconds. Every query must be scoped by
-- the token-derived account id; draft ids are opaque and never an authority
-- claim on their own.

CREATE TABLE mail_drafts (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	mailbox_id TEXT NOT NULL,
	-- Monotonic revision. Every content change increments it and recomputes
	-- content_hash, so a confirmation for an older revision cannot be replayed.
	version INTEGER NOT NULL,
	content_hash TEXT NOT NULL,
	to_json TEXT NOT NULL,
	cc_json TEXT NOT NULL,
	bcc_json TEXT NOT NULL,
	subject TEXT NOT NULL DEFAULT '',
	text_body TEXT NOT NULL DEFAULT '',
	html_body TEXT,
	-- Soft delete only: a discarded draft keeps its row but is never sendable.
	status TEXT NOT NULL CHECK (status IN ('draft', 'discarded')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX mail_drafts_account_updated
	ON mail_drafts (account_id, status, updated_at DESC, id);

-- Atomic single-use gate for a confirmation credential. A conflicting insert is
-- the only signal Who You needs: the nonce was already spent, so no send may
-- happen even when the same credential is replayed concurrently.
CREATE TABLE confirmation_nonces (
	nonce TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	draft_id TEXT NOT NULL,
	consumed_at INTEGER NOT NULL
);

-- Immutable successful-send evidence. `status` and `error_code` are reserved for
-- a later provider-async path; this slice writes only `sent` rows, because a
-- failed attempt must stay retryable instead of pinning an idempotency key.
-- (account_id, idempotency_key) is the durable at-most-once answer.
CREATE TABLE send_receipts (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	draft_id TEXT NOT NULL,
	draft_version INTEGER NOT NULL,
	content_hash TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
	error_code TEXT,
	provider_message_id TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE (account_id, idempotency_key)
);

CREATE INDEX send_receipts_draft
	ON send_receipts (account_id, draft_id, created_at DESC);
