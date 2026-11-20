-- S6: mailbox provisioning audit.
--
-- SQLite cannot amend a CHECK constraint in place, so the audit table is
-- rebuilt with the extended action list. Rows are copied verbatim; the index is
-- recreated because dropping the table drops it too.
CREATE TABLE mail_audit_log_v2 (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	action TEXT NOT NULL CHECK (
		action IN ('export', 'delete_message', 'delete_mailbox', 'provision_mailbox')
	),
	target_id TEXT,
	detail TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);

INSERT INTO mail_audit_log_v2 (id, account_id, action, target_id, detail, created_at)
SELECT id, account_id, action, target_id, detail, created_at FROM mail_audit_log;

DROP TABLE mail_audit_log;

ALTER TABLE mail_audit_log_v2 RENAME TO mail_audit_log;

CREATE INDEX mail_audit_account_time ON mail_audit_log (account_id, created_at DESC);
