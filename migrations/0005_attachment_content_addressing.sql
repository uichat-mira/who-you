-- S5 attachment content addressing and orphan reclamation.
--
-- Attachments are stored once per distinct byte sequence under
-- `attachments/content/<sha256>` instead of once per (message, part). Each
-- `attachments` row keeps its own id (`att_` + sha256(message_id \n part_path)),
-- so every existing attachment id and signed-link shape stays stable; only the
-- R2 key becomes shared.
--
-- Historical rows keep their per-message `r2_key` and a NULL `content_hash`:
-- SQL cannot compute a SHA-256, so they are never backfilled, never deduplicated
-- and never reclaimed by the orphan sweep. Their objects are still deleted by the
-- normal message/mailbox delete paths.

ALTER TABLE attachments ADD COLUMN content_hash TEXT;

CREATE INDEX attachments_content_hash ON attachments (content_hash);

-- One row per distinct attachment byte sequence. There is deliberately no
-- ref_count: reclamation is decided by "does any attachments row still reference
-- this hash", so a missed increment can never delete a live object.
CREATE TABLE attachment_objects (
	content_hash TEXT PRIMARY KEY,
	r2_key TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX attachment_objects_time ON attachment_objects (created_at);
