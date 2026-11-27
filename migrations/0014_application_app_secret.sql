-- OPS-055: current instance registration AppSecret, after an Owner rotation.
--
-- No row means the instance still answers Mira ID registration proofs with the
-- deployment-provided WHOYOU_APP_SECRET. The first successful Owner rotation
-- inserts this singleton row; later rotations bump `secret_version` atomically.
-- Only a salted, one-way SHA-256 digest is stored: there is no plaintext,
-- reversible ciphertext, recovery token or previous-version history here.

CREATE TABLE application_app_secret (
	id TEXT PRIMARY KEY CHECK (id = 'current'),
	secret_hash TEXT NOT NULL,
	secret_salt TEXT NOT NULL,
	secret_version INTEGER NOT NULL CHECK (secret_version > 0),
	rotated_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
