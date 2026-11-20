-- S8b: audit actions for the mail job contract.
--
-- SQLite cannot widen a CHECK constraint in place, so the audit table is
-- rebuilt with the job actions added. Existing rows are copied unchanged; the
-- detail column still carries only fixed codes, never an address or a subject.

CREATE TABLE mail_audit_log_v4 (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN (
		'export', 'delete_message', 'delete_mailbox', 'provision_mailbox',
		'link_mailbox', 'unlink_mailbox',
		'job_create', 'job_stage_update', 'job_stage_accept',
		'job_annotate', 'job_annotation_resolve', 'job_pause', 'job_resume'
	)),
	target_id TEXT,
	detail TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);

INSERT INTO mail_audit_log_v4 (id, account_id, action, target_id, detail, created_at)
	SELECT id, account_id, action, target_id, detail, created_at FROM mail_audit_log;

DROP TABLE mail_audit_log;

ALTER TABLE mail_audit_log_v4 RENAME TO mail_audit_log;

CREATE INDEX mail_audit_account_time ON mail_audit_log (account_id, created_at DESC);
