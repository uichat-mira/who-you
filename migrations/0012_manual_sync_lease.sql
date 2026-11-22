-- OPS-044: serialise one bounded provider sync per identity.
--
-- The cursor row already exists per third-party identity, so the lease lives
-- with it instead of a second table. A lease is acquired with one conditional
-- UPSERT; only one concurrent request can win while it has an owner. An empty
-- `lease_id` means idle; elapsed expiry is diagnostic, never an automatic
-- takeover. The same owner excludes Gmail sync, unlink and reauthorization. Nothing here is provider- or content-bearing.

ALTER TABLE mailbox_sync_state ADD COLUMN lease_id TEXT;
ALTER TABLE mailbox_sync_state ADD COLUMN lease_expires_at INTEGER;
