-- S1 inbound-only mail model. No drafts, flags, sends or receipts exist in this
-- slice; see docs/product-design.md v1 §6.
--
-- All timestamps are integer epoch milliseconds. All queries must be scoped by
-- the token-derived account id; mailbox ids are opaque and never accepted from
-- tool arguments as an authority claim.

CREATE TABLE mailboxes (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	address TEXT NOT NULL COLLATE NOCASE,
	local_part TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
	quota_bytes INTEGER NOT NULL,
	bytes_used INTEGER NOT NULL DEFAULT 0,
	message_count INTEGER NOT NULL DEFAULT 0,
	quarantine_count INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	-- S1: exactly one address per Cloud Account.
	UNIQUE (account_id),
	UNIQUE (address)
);

CREATE TABLE threads (
	id TEXT PRIMARY KEY,
	mailbox_id TEXT NOT NULL,
	thread_key TEXT NOT NULL,
	root_message_id TEXT,
	last_message_at INTEGER NOT NULL,
	message_count INTEGER NOT NULL DEFAULT 0,
	UNIQUE (mailbox_id, thread_key)
);

CREATE INDEX threads_mailbox_last ON threads (mailbox_id, last_message_at DESC);

CREATE TABLE messages (
	id TEXT PRIMARY KEY,
	mailbox_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
	internet_message_id TEXT NOT NULL,
	envelope_from TEXT,
	envelope_to TEXT NOT NULL,
	from_json TEXT NOT NULL,
	to_json TEXT NOT NULL,
	cc_json TEXT NOT NULL,
	subject TEXT,
	-- Normalized lowercase copies used for LIKE/instr search while D1 FTS5
	-- support remains unverified (product design §10 #6).
	from_text TEXT NOT NULL DEFAULT '',
	search_text TEXT NOT NULL DEFAULT '',
	sent_at INTEGER,
	received_at INTEGER NOT NULL,
	size_bytes INTEGER NOT NULL,
	snippet TEXT NOT NULL DEFAULT '',
	attachment_count INTEGER NOT NULL DEFAULT 0,
	auth_results TEXT NOT NULL,
	dmarc TEXT NOT NULL CHECK (dmarc IN ('pass', 'fail', 'none', 'unknown')),
	state TEXT NOT NULL CHECK (state IN ('visible', 'quarantined')),
	quarantine_reason TEXT,
	raw_key TEXT NOT NULL,
	text_key TEXT,
	html_key TEXT,
	-- Idempotency key for duplicate delivery; scoped per mailbox.
	UNIQUE (mailbox_id, internet_message_id)
);

CREATE INDEX messages_mailbox_received ON messages (mailbox_id, state, received_at DESC, id);
CREATE INDEX messages_thread ON messages (mailbox_id, thread_id, received_at);

CREATE TABLE attachments (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL,
	mailbox_id TEXT NOT NULL,
	part_path TEXT NOT NULL,
	filename TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	disposition TEXT NOT NULL,
	content_id TEXT,
	r2_key TEXT NOT NULL,
	UNIQUE (message_id, part_path)
);

CREATE INDEX attachments_message ON attachments (message_id);
