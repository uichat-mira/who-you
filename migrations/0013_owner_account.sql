-- OPS-054: one instance-local Owner credential for the Web console.
--
-- The Owner is deliberately not a Mira ID subject. Exactly one row may exist
-- per deployment instance; `id` is a fixed singleton key and `account_id` is
-- derived from the instance's public app id. Only a salted PBKDF2 digest is
-- stored: there is no plaintext password, reversible ciphertext or recovery
-- token in this schema.
--
-- `credential_version` is bumped on every password change. Browser sessions
-- carry the version they were minted with, so changing the password invalidates
-- every older Owner session without a separate session table.

CREATE TABLE owner_credentials (
	id TEXT PRIMARY KEY CHECK (id = 'owner'),
	account_id TEXT NOT NULL UNIQUE,
	login_name TEXT NOT NULL CHECK (login_name = 'admin'),
	password_hash TEXT NOT NULL,
	password_salt TEXT NOT NULL,
	iterations INTEGER NOT NULL CHECK (iterations > 0),
	credential_version INTEGER NOT NULL CHECK (credential_version > 0),
	must_change_password INTEGER NOT NULL CHECK (must_change_password IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- A tiny, non-identity singleton throttle. It stores only counters and a lock
-- deadline so repeated wrong credentials cannot be used as an unlimited oracle.
CREATE TABLE owner_login_throttle (
	id TEXT PRIMARY KEY CHECK (id = 'owner'),
	window_started_at INTEGER NOT NULL,
	failures INTEGER NOT NULL CHECK (failures >= 0),
	locked_until INTEGER
);
