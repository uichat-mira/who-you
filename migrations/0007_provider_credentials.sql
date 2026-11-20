-- S7b: sealed third-party credentials. Only long-lived material is stored:
-- an OAuth refresh token, or the IMAP/SMTP password (app password) for
-- self-hosted providers. Every row carries its own DEK, wrapped by the
-- deployment KEK; revoking nulls the wrapped DEK and the ciphertext
-- (crypto-shredding) while keeping the row for audit.
--
-- AAD lives in code (src/mail/credential-crypto.ts) and never includes
-- key_version, so rotating the KEK only rewrites wrapped_dek/wrap_nonce.

CREATE TABLE provider_credentials (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	mailbox_id TEXT NOT NULL,
	provider TEXT NOT NULL CHECK (provider IN ('gmail', 'microsoft', 'imap_smtp')),
	credential_type TEXT NOT NULL CHECK (credential_type IN ('oauth_refresh', 'imap_password', 'smtp_password')),
	status TEXT NOT NULL CHECK (status IN ('active', 'reauth_required', 'unreadable', 'revoked')),
	dek_id TEXT NOT NULL,
	wrapped_dek TEXT,
	wrap_nonce TEXT,
	ciphertext TEXT,
	nonce TEXT,
	key_version INTEGER NOT NULL,
	scope TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	revoked_at INTEGER,
	CHECK (
		(status = 'revoked' AND wrapped_dek IS NULL AND ciphertext IS NULL)
		OR (status <> 'revoked' AND wrapped_dek IS NOT NULL AND ciphertext IS NOT NULL)
	)
);

-- One active credential per slot. A self-hosted identity legitimately holds both
-- an imap_password and an smtp_password row, so uniqueness is per type.
CREATE UNIQUE INDEX provider_credentials_active
	ON provider_credentials (mailbox_id, credential_type)
	WHERE status = 'active';

CREATE INDEX provider_credentials_account
	ON provider_credentials (account_id, status);

-- Rotation sweep scans rows that are still on an older KEK.
CREATE INDEX provider_credentials_key_version
	ON provider_credentials (key_version);

-- Linking and unlinking an identity is an auditable account-level action.
CREATE TABLE mail_audit_log_v3 (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN (
		'export', 'delete_message', 'delete_mailbox', 'provision_mailbox',
		'link_mailbox', 'unlink_mailbox'
	)),
	target_id TEXT,
	detail TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);

INSERT INTO mail_audit_log_v3 (id, account_id, action, target_id, detail, created_at)
	SELECT id, account_id, action, target_id, detail, created_at FROM mail_audit_log;

DROP TABLE mail_audit_log;

ALTER TABLE mail_audit_log_v3 RENAME TO mail_audit_log;

CREATE INDEX mail_audit_account_time ON mail_audit_log (account_id, created_at DESC);
