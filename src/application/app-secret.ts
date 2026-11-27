/**
 * Instance registration AppSecret lifecycle (OPS-055).
 *
 * A fresh deployment answers registration proofs with `WHOYOU_APP_SECRET`.
 * After the instance Owner rotates the secret, D1 is authoritative: only the
 * current row's salted, one-way digest is kept, and the plaintext is returned
 * exactly once in the rotation response. The bootstrap binding stays in place
 * as the deployment fallback for an instance that has never rotated.
 *
 * This secret proves management of one deployment instance to Mira ID. It is
 * not an OAuth client secret, an MCP bearer, a user password or an Owner
 * session key, and rotating it never touches ownership or user grants.
 */

export const APP_SECRET_MIN_LENGTH = 16;
export const APP_SECRET_MAX_LENGTH = 512;
/** 32 random bytes encode to the 43-character V1 secret shape. */
export const APP_SECRET_ENTROPY_BYTES = 32;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const DIGEST_DOMAIN = "who-you/app-secret/v1\n";

export type AppSecretStatus =
	| { kind: "bootstrap" }
	| { kind: "rotated"; version: number; rotatedAt: number };

export type AppSecretState =
	| { kind: "bootstrap" }
	| {
			kind: "rotated";
			version: number;
			rotatedAt: number;
			secretHash: string;
			secretSalt: string;
		};

export type AppSecretDigest = {
	secretHash: string;
	secretSalt: string;
};

function encode(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 8192) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode(value: string): Uint8Array {
	if (!/^[\w-]+$/.test(value)) throw new Error("invalid_encoding");
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) {
		difference |= a[index]! ^ b[index]!;
	}
	return difference === 0;
}

/** Length rule shared with the existing Mira ID V1 registration contract. */
export function isValidAppSecret(value: unknown): value is string {
	return typeof value === "string"
		&& value.length >= APP_SECRET_MIN_LENGTH
		&& value.length <= APP_SECRET_MAX_LENGTH;
}

export function generateAppSecret(): string {
	return encode(crypto.getRandomValues(new Uint8Array(APP_SECRET_ENTROPY_BYTES)));
}

async function deriveSecretHash(secret: string, salt: Uint8Array): Promise<Uint8Array> {
	const domain = new TextEncoder().encode(DIGEST_DOMAIN);
	const value = new TextEncoder().encode(secret);
	const input = new Uint8Array(domain.length + salt.length + value.length);
	input.set(domain, 0);
	input.set(salt, domain.length);
	input.set(value, domain.length + salt.length);
	return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

/**
 * Salted SHA-256 is sufficient here: the rotated secret has 256 bits of
 * entropy, so the digest is not a password-style offline guessing target.
 */
export async function digestAppSecret(
	secret: string,
	salt: Uint8Array = crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
): Promise<AppSecretDigest> {
	return {
		secretHash: encode(await deriveSecretHash(secret, salt)),
		secretSalt: encode(salt),
	};
}

export async function verifyAppSecret(
	secret: string,
	digest: AppSecretDigest,
): Promise<boolean> {
	try {
		if (!isValidAppSecret(secret)) return false;
		const expected = decode(digest.secretHash);
		const salt = decode(digest.secretSalt);
		if (expected.length !== HASH_BYTES || salt.length < SALT_BYTES || salt.length > 64) {
			return false;
		}
		return equalBytes(await deriveSecretHash(secret, salt), expected);
	} catch {
		return false;
	}
}

type AppSecretRow = {
	secret_hash: string;
	secret_salt: string;
	secret_version: number;
	rotated_at: number;
};

/** D1 access for the single current registration secret. */
export class ApplicationSecretRepository {
	constructor(private readonly db: D1Database) {}

	/** Throws on storage failure so callers can fail closed instead of falling back. */
	async current(): Promise<AppSecretState> {
		const row = await this.db
			.prepare(
				`SELECT secret_hash, secret_salt, secret_version, rotated_at
				 FROM application_app_secret WHERE id = 'current'`,
			)
			.first<AppSecretRow>();
		if (!row) return { kind: "bootstrap" };
		if (typeof row.secret_hash !== "string" || typeof row.secret_salt !== "string"
			|| !Number.isSafeInteger(row.secret_version) || row.secret_version < 1
			|| !Number.isSafeInteger(row.rotated_at) || row.rotated_at < 1
			|| row.rotated_at > 8_640_000_000_000_000) {
			throw new Error("invalid_app_secret_state");
		}
		return {
			kind: "rotated",
			version: row.secret_version,
			rotatedAt: row.rotated_at,
			secretHash: row.secret_hash,
			secretSalt: row.secret_salt,
		};
	}

	/**
	 * Atomically switches the current secret. `expectedVersion` is 0 while the
	 * instance still uses the deployment bootstrap secret. A lost race returns
	 * null instead of overwriting a newer rotation.
	 */
	async rotate(input: {
		expectedVersion: number;
		secret: string;
		now: number;
	}): Promise<number | null> {
		const digest = await digestAppSecret(input.secret);
		if (input.expectedVersion === 0) {
			const result = await this.db
				.prepare(
					`INSERT INTO application_app_secret (
					 id, secret_hash, secret_salt, secret_version, rotated_at, updated_at
					 ) VALUES ('current', ?, ?, 1, ?, ?)
					 ON CONFLICT(id) DO NOTHING`,
				)
				.bind(digest.secretHash, digest.secretSalt, input.now, input.now)
				.run();
			return (result.meta.changes ?? 0) === 1 ? 1 : null;
		}
		const result = await this.db
			.prepare(
				`UPDATE application_app_secret
				 SET secret_hash = ?, secret_salt = ?, secret_version = secret_version + 1,
				 rotated_at = ?, updated_at = ?
				 WHERE id = 'current' AND secret_version = ?`,
			)
			.bind(digest.secretHash, digest.secretSalt, input.now, input.now,
				input.expectedVersion)
			.run();
		return (result.meta.changes ?? 0) === 1 ? input.expectedVersion + 1 : null;
	}
}
