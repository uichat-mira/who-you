-- S7a: a Cloud Account may hold several mailbox identities. The S1 constraint
-- "one address per account" becomes "one of each address per account"; the
-- own-domain address stays unique because S6 derives it from the username.
--
-- SQLite cannot alter a UNIQUE constraint in place, so the table is rebuilt with
-- the same columns plus kind/provider. Existing rows are own-domain identities.

CREATE TABLE mailboxes_v3 (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	address TEXT NOT NULL COLLATE NOCASE,
	local_part TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'own_domain' CHECK (kind IN ('own_domain', 'third_party')),
	provider TEXT CHECK (provider IN ('gmail', 'microsoft', 'imap_smtp')),
	status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
	quota_bytes INTEGER NOT NULL,
	bytes_used INTEGER NOT NULL DEFAULT 0,
	message_count INTEGER NOT NULL DEFAULT 0,
	quarantine_count INTEGER NOT NULL DEFAULT 0,
	send_paused_at INTEGER,
	send_paused_reason TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (account_id, address),
	UNIQUE (address),
	CHECK (
		(kind = 'own_domain' AND provider IS NULL)
		OR (kind = 'third_party' AND provider IS NOT NULL)
	)
);

INSERT INTO mailboxes_v3 (
	id, account_id, address, local_part, kind, provider, status, quota_bytes,
	bytes_used, message_count, quarantine_count, send_paused_at,
	send_paused_reason, created_at, updated_at
	)
SELECT
	id, account_id, address, local_part, 'own_domain', NULL, status, quota_bytes,
	bytes_used, message_count, quarantine_count, send_paused_at,
	send_paused_reason, created_at, updated_at
	FROM mailboxes;

DROP TABLE mailboxes;

ALTER TABLE mailboxes_v3 RENAME TO mailboxes;
