-- S7c: Gmail OAuth linking, incremental sync cursors and provider receipts.
--
-- oauth_link_states holds the one-time PKCE verifier for an in-flight link. A
-- row is deleted as soon as it is consumed and carries a 10-minute TTL, so a
-- leaked authorization URL cannot be replayed. No authorization code, access
-- token or refresh token is ever written here.

CREATE TABLE oauth_link_states (
	state TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	provider TEXT NOT NULL CHECK (provider IN ('gmail', 'microsoft')),
	code_verifier TEXT NOT NULL,
	redirect_uri TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX oauth_link_states_expiry ON oauth_link_states (expires_at);

-- Identity link/unlink is a high-risk write: the confirmation nonce is spent
-- once, atomically, before any provider call or row mutation.
CREATE TABLE identity_confirmation_nonces (
	nonce TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('link', 'unlink')),
	provider TEXT,
	consumed_at INTEGER NOT NULL
);

-- One cursor row per third-party identity. `cursor` is the provider-specific
-- incremental token (Gmail historyId). The bounded initial scan is tracked by
-- backfill_before/backfill_page/backfill_history_id; when the pages run out the
-- cursor takes over and the backfill columns are cleared.
CREATE TABLE mailbox_sync_state (
	mailbox_id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	cursor TEXT,
	backfill_before INTEGER,
	backfill_page TEXT,
	backfill_history_id TEXT,
	last_synced_at INTEGER,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX mailbox_sync_state_provider
	ON mailbox_sync_state (provider, updated_at);

-- The receipt records which provider actually accepted the message. Existing
-- rows stay NULL because their provider is not knowable retrospectively.
ALTER TABLE send_receipts ADD COLUMN provider TEXT;
