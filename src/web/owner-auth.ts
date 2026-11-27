/**
 * Instance-local Owner authentication (OPS-054).
 *
 * The Owner is a product identity inside one Who You deployment, not a Mira ID
 * account. It is stored as a salted PBKDF2 digest, never as plaintext, and it
 * never aliases, merges with or impersonates a Mira ID `subject`. The browser
 * session lives in a separate `__Host-` cookie; password changes bump the
 * credential version so every older session stops resolving.
 *
 * See docs/product-design.md for the product boundary.
 */

export const OWNER_LOGIN_NAME = "admin";
export const OWNER_PASSWORD_MIN_LENGTH = 12;
export const OWNER_PASSWORD_MAX_LENGTH = 200;
/** PBKDF2-HMAC-SHA-256 work factor kept inside the Worker CPU budget. */
export const OWNER_PBKDF2_ITERATIONS = 100_000;
export const OWNER_SESSION_SECONDS = 8 * 60 * 60;
export const OWNER_MAX_FAILED_ATTEMPTS = 5;
export const OWNER_FAILURE_WINDOW_MS = 5 * 60_000;
export const OWNER_LOCKOUT_MS = 5 * 60_000;

const HASH_BYTES = 32;
const SALT_BYTES = 16;
/** Reject absurd stored parameters instead of turning them into a CPU sink. */
const MAX_STORED_ITERATIONS = 1_000_000;

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

function randomSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** Constant-time comparison for digest bytes. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) {
		difference |= a[index]! ^ b[index]!;
	}
	return difference === 0;
}

async function constantTimeEqualText(actual: string, expected: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(actual)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	return equalBytes(new Uint8Array(a), new Uint8Array(b));
}

export type OwnerPasswordDigest = {
	passwordHash: string;
	passwordSalt: string;
	iterations: number;
};

async function pbkdf2(
	password: string,
	salt: Uint8Array,
	iterations: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		key,
		HASH_BYTES * 8,
	);
	return new Uint8Array(bits);
}

/** Hashes a password with a fresh random salt unless one is supplied. */
export async function digestOwnerPassword(
	password: string,
	options: { salt?: Uint8Array; iterations?: number } = {},
): Promise<OwnerPasswordDigest> {
	const iterations = options.iterations ?? OWNER_PBKDF2_ITERATIONS;
	const salt = options.salt ?? randomSalt();
	const hash = await pbkdf2(password, salt, iterations);
	return {
		passwordHash: encode(hash),
		passwordSalt: encode(salt),
		iterations,
	};
}

export async function verifyOwnerPassword(
	password: string,
	digest: OwnerPasswordDigest,
): Promise<boolean> {
	try {
		if (!Number.isInteger(digest.iterations) || digest.iterations < 1
			|| digest.iterations > MAX_STORED_ITERATIONS) return false;
		const expected = decode(digest.passwordHash);
		if (expected.length !== HASH_BYTES) return false;
		const salt = decode(digest.passwordSalt);
		if (salt.length < SALT_BYTES || salt.length > 64) return false;
		const actual = await pbkdf2(password, salt, digest.iterations);
		return equalBytes(actual, expected);
	} catch {
		return false;
	}
}

/** Password policy for both the initial deployment credential and later changes. */
export function validateOwnerPassword(password: string): boolean {
	return password.length >= OWNER_PASSWORD_MIN_LENGTH
		&& password.length <= OWNER_PASSWORD_MAX_LENGTH;
}

/** Stable Owner account id, scoped only to this deployment instance. */
export function ownerAccountId(appId: string): string {
	return `local-owner:${appId}`;
}

export type OwnerCredential = OwnerPasswordDigest & {
	accountId: string;
	loginName: typeof OWNER_LOGIN_NAME;
	credentialVersion: number;
	mustChangePassword: boolean;
};

export type OwnerSession = {
	kind: "owner";
	appId: string;
	accountId: string;
	credentialVersion: number;
	sessionId: string;
	expiresAt: string;
};

/** Shape check only; the credential version is rechecked against D1 per request. */
export function isOwnerSession(
	value: unknown,
	expected: { appId: string; accountId: string },
): value is OwnerSession {
	if (typeof value !== "object" || value === null) return false;
	const session = value as Partial<OwnerSession>;
	return session.kind === "owner"
		&& session.appId === expected.appId
		&& session.accountId === expected.accountId
		&& typeof session.credentialVersion === "number"
		&& Number.isInteger(session.credentialVersion)
		&& session.credentialVersion >= 1
		&& typeof session.sessionId === "string"
		&& /^[\w-]{43}$/.test(session.sessionId)
		&& typeof session.expiresAt === "string"
		&& Number.isFinite(Date.parse(session.expiresAt))
		&& Date.parse(session.expiresAt) > Date.now()
		&& Date.parse(session.expiresAt) <= Date.now() + OWNER_SESSION_SECONDS * 1000;
}

type OwnerRow = {
	account_id: string;
	login_name: string;
	password_hash: string;
	password_salt: string;
	iterations: number;
	credential_version: number;
	must_change_password: number;
};

const credentialFromRow = (row: OwnerRow): OwnerCredential => ({
	accountId: row.account_id,
	loginName: OWNER_LOGIN_NAME,
	passwordHash: row.password_hash,
	passwordSalt: row.password_salt,
	iterations: row.iterations,
	credentialVersion: row.credential_version,
	mustChangePassword: row.must_change_password === 1,
});

/** D1 access for the singleton Owner credential and its login throttle. */
export class OwnerRepository {
	constructor(private readonly db: D1Database) {}

	async get(): Promise<OwnerCredential | null> {
		const row = await this.db
			.prepare(
				`SELECT account_id, login_name, password_hash, password_salt, iterations,
				 credential_version, must_change_password
				 FROM owner_credentials WHERE id = 'owner'`,
			)
			.first<OwnerRow>();
		return row ? credentialFromRow(row) : null;
	}

	/** Inserts the only allowed row; a concurrent winner makes this a no-op. */
	async createInitial(input: {
		accountId: string;
		password: string;
		now: number;
	}): Promise<boolean> {
		const digest = await digestOwnerPassword(input.password);
		const result = await this.db
			.prepare(
				`INSERT OR IGNORE INTO owner_credentials (
				 id, account_id, login_name, password_hash, password_salt, iterations,
				 credential_version, must_change_password, created_at, updated_at
				 ) VALUES ('owner', ?, 'admin', ?, ?, ?, 1, 1, ?, ?)`,
			)
			.bind(
				input.accountId,
				digest.passwordHash,
				digest.passwordSalt,
				digest.iterations,
				input.now,
				input.now,
			)
			.run();
		return (result.meta.changes ?? 0) === 1;
	}

	/** Bumps the credential version, which invalidates every older session. */
	async updatePassword(input: {
		expectedVersion: number;
		password: string;
		now: number;
	}): Promise<number | null> {
		const digest = await digestOwnerPassword(input.password);
		const result = await this.db
			.prepare(
				`UPDATE owner_credentials
				 SET password_hash = ?, password_salt = ?, iterations = ?,
				 credential_version = credential_version + 1, must_change_password = 0,
				 updated_at = ?
				 WHERE id = 'owner' AND credential_version = ?`,
			)
			.bind(
				digest.passwordHash,
				digest.passwordSalt,
				digest.iterations,
				input.now,
				input.expectedVersion,
			)
			.run();
		return (result.meta.changes ?? 0) === 1 ? input.expectedVersion + 1 : null;
	}

	async isLocked(now: number): Promise<boolean> {
		const row = await this.db
			.prepare(`SELECT locked_until FROM owner_login_throttle WHERE id = 'owner'`)
			.first<{ locked_until: number | null }>();
		return row?.locked_until !== null && row?.locked_until !== undefined
			&& row.locked_until > now;
	}

	async recordFailure(now: number): Promise<void> {
		const row = await this.db
			.prepare(
				`SELECT window_started_at, failures, locked_until
				 FROM owner_login_throttle WHERE id = 'owner'`,
			)
			.first<{ window_started_at: number; failures: number; locked_until: number | null }>();
		const withinWindow = row !== null && now - row.window_started_at < OWNER_FAILURE_WINDOW_MS;
		const failures = withinWindow ? row.failures + 1 : 1;
		const windowStartedAt = withinWindow ? row.window_started_at : now;
		const lockedUntil = failures >= OWNER_MAX_FAILED_ATTEMPTS ? now + OWNER_LOCKOUT_MS : null;
		await this.db
			.prepare(
				`INSERT INTO owner_login_throttle (id, window_started_at, failures, locked_until)
				 VALUES ('owner', ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				 window_started_at = excluded.window_started_at,
				 failures = excluded.failures,
				 locked_until = excluded.locked_until`,
			)
			.bind(windowStartedAt, failures, lockedUntil)
			.run();
	}

	async clearFailures(now: number): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO owner_login_throttle (id, window_started_at, failures, locked_until)
				 VALUES ('owner', ?, 0, NULL)
				 ON CONFLICT(id) DO UPDATE SET
				 window_started_at = excluded.window_started_at,
				 failures = 0,
				 locked_until = NULL`,
			)
			.bind(now)
			.run();
	}
}

export type OwnerLoginOutcome =
	| { ok: true; credential: OwnerCredential }
	| { ok: false; code: "invalid_credentials" | "temporarily_locked" };

/**
 * Verifies an Owner login, lazily bootstrapping the single row from the
 * deployment-provided initial password on first use. A wrong password, a
 * missing/short initial credential and a throttled instance all fail closed
 * with the same non-sensitive error surface.
 */
export async function authenticateOwner(input: {
	repository: OwnerRepository;
	accountId: string;
	initialPassword: string | undefined;
	loginName: string;
	password: string;
	now: number;
}): Promise<OwnerLoginOutcome> {
	if (await input.repository.isLocked(input.now)) {
		return { ok: false, code: "temporarily_locked" };
	}
	const invalid = async (): Promise<OwnerLoginOutcome> => {
		await input.repository.recordFailure(input.now);
		return { ok: false, code: "invalid_credentials" };
	};
	if (input.loginName !== OWNER_LOGIN_NAME
		|| input.password.length < 1
		|| input.password.length > OWNER_PASSWORD_MAX_LENGTH) {
		return invalid();
	}

	let credential = await input.repository.get();
	if (!credential) {
		const configured = input.initialPassword ?? "";
		if (!validateOwnerPassword(configured)
			|| !await constantTimeEqualText(input.password, configured)) {
			return invalid();
		}
		await input.repository.createInitial({
			accountId: input.accountId,
			password: input.password,
			now: input.now,
		});
		// A lost insert race must still verify against whichever row won.
		credential = await input.repository.get();
	}
	if (!credential || credential.accountId !== input.accountId
		|| !await verifyOwnerPassword(input.password, credential)) {
		return invalid();
	}
	await input.repository.clearFailures(input.now);
	return { ok: true, credential };
}
