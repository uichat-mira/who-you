-- S8a: mail job contract (delegation, staged requirements, versioned annotations).
--
-- A job is the reviewable unit of work a user hands to Who You. It never stores
-- mail bodies or address copies: message content stays in `messages`, addresses
-- stay in `mailboxes` / `mail_drafts`. `quote` holds only the requirement text
-- the user selected, never mail content.
--
-- All timestamps are integer epoch milliseconds. Every read must be scoped by the
-- token-derived account id; a job id is never an authority claim on its own.

CREATE TABLE mail_jobs (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	mailbox_id TEXT NOT NULL,
	template_key TEXT NOT NULL CHECK (template_key IN ('digest', 'single', 'followup')),
	title TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'active', 'paused')),
	current_stage INTEGER NOT NULL DEFAULT 1 CHECK (current_stage BETWEEN 1 AND 3),
	-- Long-term hosting only exists after the final stage is accepted, so the
	-- column is a request flag until `canActivateJob` agrees.
	long_term INTEGER NOT NULL DEFAULT 0 CHECK (long_term IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX mail_jobs_account_updated
	ON mail_jobs (account_id, status, updated_at DESC, id);

CREATE TABLE mail_job_stages (
	job_id TEXT NOT NULL,
	stage_no INTEGER NOT NULL CHECK (stage_no BETWEEN 1 AND 3),
	title TEXT NOT NULL,
	body_md TEXT NOT NULL DEFAULT '',
	-- Controlled settings, never a second body. Unknown keys are rejected in code.
	agreed_json TEXT NOT NULL DEFAULT '{}',
	-- Monotonic revision; every body or settings change increments it and
	-- recomputes content_hash, so a stale annotation cannot silently re-anchor.
	version INTEGER NOT NULL DEFAULT 1,
	content_hash TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'accepted')),
	accepted_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (job_id, stage_no)
);

CREATE TABLE mail_job_annotations (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	stage_no INTEGER NOT NULL CHECK (stage_no BETWEEN 1 AND 3),
	-- Version of the stage body this anchor was taken from.
	stage_version INTEGER NOT NULL,
	-- Null/zero-length offsets mean a stage-wide annotation.
	anchor_start INTEGER,
	anchor_end INTEGER,
	quote TEXT NOT NULL DEFAULT '',
	body TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'stale')),
	created_at INTEGER NOT NULL,
	resolved_at INTEGER
);

CREATE INDEX mail_job_annotations_stage
	ON mail_job_annotations (job_id, stage_no, status, created_at);

-- Bounded run history. Only a fixed reason code; never a subject, address or body.
CREATE TABLE mail_job_runs (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	run_no INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
	reason_code TEXT,
	started_at INTEGER NOT NULL,
	finished_at INTEGER,
	UNIQUE (job_id, run_no)
);
