-- S7e: user-supplied IMAP/SMTP endpoint for one identity.
--
-- The host is user data: it is stored only here and never written to logs,
-- audit rows, errors or MCP output. The port CHECK constraints are the final
-- allowlist; application validation rejects everything else before a socket is
-- opened.

CREATE TABLE mailbox_remote_targets (
	mailbox_id TEXT PRIMARY KEY,
	imap_host TEXT NOT NULL,
	imap_port INTEGER NOT NULL CHECK (imap_port IN (993, 143)),
	smtp_host TEXT NOT NULL,
	smtp_port INTEGER NOT NULL CHECK (smtp_port IN (465, 587)),
	username TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX mailbox_remote_targets_host ON mailbox_remote_targets (smtp_host);
