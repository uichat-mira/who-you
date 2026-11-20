-- S4 deliverability / abuse model. See docs/task-cards/WHO-S4-deliverability-abuse.md.
--
-- All timestamps are integer epoch milliseconds. Delivery events are written only
-- by the HMAC-authenticated internal relay callback, never by agents.
--
-- Privacy boundary: `delivery_events` keeps a recipient hash and domain only.
-- The `suppressions` table must keep the exact normalized address because send
-- verification has to compare it; nothing from either table is copied into
-- logs, alert details, tool output or error messages.

CREATE TABLE delivery_events (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	send_receipt_id TEXT,
	provider_message_id TEXT,
	type TEXT NOT NULL CHECK (type IN ('delivered', 'soft_bounce', 'hard_bounce', 'complaint', 'dsn')),
	recipient_hash TEXT NOT NULL,
	recipient_domain TEXT NOT NULL DEFAULT '',
	status TEXT,
	diagnostic_code TEXT,
	occurred_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX delivery_events_account_time ON delivery_events (account_id, occurred_at DESC);
CREATE INDEX delivery_events_type_time ON delivery_events (type, occurred_at);
CREATE INDEX delivery_events_receipt ON delivery_events (send_receipt_id);

-- One row per (account, recipient). A repeat bounce or complaint keeps the
-- original reason: suppression is permanent for this slice, so there is no
-- update path and no expiry column.
CREATE TABLE suppressions (
	account_id TEXT NOT NULL,
	recipient TEXT NOT NULL COLLATE NOCASE,
	reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint')),
	source_event_id TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, recipient)
);

CREATE INDEX suppressions_recipient ON suppressions (recipient);

-- PII-free alarm trail. `detail` only carries counters and machine reasons;
-- it must never contain an address, subject or body.
CREATE TABLE deliverability_alerts (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('hard_bounce_rate', 'complaint_rate', 'external_volume', 'send_paused')),
	detail TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);

CREATE INDEX deliverability_alerts_account_time
	ON deliverability_alerts (account_id, created_at DESC);

-- Replay guard for the internal relay callback. Rows only need to outlive the
-- accepted timestamp skew, so the retention sweep clears them after one day.
CREATE TABLE internal_webhook_nonces (
	nonce TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);

CREATE INDEX internal_webhook_nonces_time ON internal_webhook_nonces (created_at);

-- Automatic pause is account state, not mailbox disablement: receiving must
-- keep working while outbound is stopped until a human resumes the account.
ALTER TABLE mailboxes ADD COLUMN send_paused_at INTEGER;
ALTER TABLE mailboxes ADD COLUMN send_paused_reason TEXT;

-- Recipient counters make volume abuse measurable from receipts alone, without
-- storing addresses in the receipt row.
ALTER TABLE send_receipts ADD COLUMN recipient_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE send_receipts ADD COLUMN external_recipient_count INTEGER NOT NULL DEFAULT 0;
