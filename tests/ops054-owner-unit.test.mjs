import { test } from "node:test";
import assert from "node:assert/strict";
import {
	OWNER_LOGIN_NAME,
	OWNER_PASSWORD_MAX_LENGTH,
	OWNER_PASSWORD_MIN_LENGTH,
	OWNER_PBKDF2_ITERATIONS,
	OWNER_SESSION_SECONDS,
	digestOwnerPassword,
	isOwnerSession,
	ownerAccountId,
	validateOwnerPassword,
	verifyOwnerPassword,
} from "../dist/unit.mjs";

const SALT = new Uint8Array(16).fill(5);

test("Owner passwords are stored as salted PBKDF2 digests and verified without plaintext", async () => {
	const password = "correct horse battery staple";
	const digest = await digestOwnerPassword(password, { salt: SALT });
	assert.equal(digest.iterations, OWNER_PBKDF2_ITERATIONS);
	assert.match(digest.passwordHash, /^[\w-]{43}$/);
	assert.match(digest.passwordSalt, /^[\w-]{22}$/);
	assert.ok(!digest.passwordHash.includes(password));
	assert.ok(!digest.passwordSalt.includes(password));
	assert.equal(await verifyOwnerPassword(password, digest), true);
	assert.equal(await verifyOwnerPassword("wrong password value", digest), false);

	const sameSalt = await digestOwnerPassword(password, { salt: SALT });
	assert.deepEqual(sameSalt, digest);
	const otherSalt = await digestOwnerPassword(password, { salt: new Uint8Array(16).fill(6) });
	assert.notEqual(otherSalt.passwordHash, digest.passwordHash);
	const otherPassword = await digestOwnerPassword("another strong password", { salt: SALT });
	assert.notEqual(otherPassword.passwordHash, digest.passwordHash);

	const tampered = { ...digest, passwordHash: digest.passwordHash.slice(0, -1) + "A" };
	assert.equal(await verifyOwnerPassword(password, tampered), false);
	assert.equal(await verifyOwnerPassword(password, { ...digest, iterations: 1 }), false);
});

test("Owner password policy enforces a bounded length for initial and replacement secrets", () => {
	assert.equal(OWNER_LOGIN_NAME, "admin");
	assert.equal(validateOwnerPassword("x".repeat(OWNER_PASSWORD_MIN_LENGTH - 1)), false);
	assert.equal(validateOwnerPassword("x".repeat(OWNER_PASSWORD_MIN_LENGTH)), true);
	assert.equal(validateOwnerPassword("x".repeat(OWNER_PASSWORD_MAX_LENGTH)), true);
	assert.equal(validateOwnerPassword("x".repeat(OWNER_PASSWORD_MAX_LENGTH + 1)), false);
	assert.equal(validateOwnerPassword(""), false);
});

test("Owner account ids are stable per instance and cannot collide across deployments", () => {
	assert.equal(ownerAccountId("app-fixture-instance"), "local-owner:app-fixture-instance");
	assert.equal(ownerAccountId("app-fixture-instance"), ownerAccountId("app-fixture-instance"));
	assert.notEqual(ownerAccountId("app-a"), ownerAccountId("app-b"));
	assert.ok(!ownerAccountId("app-a").includes("mira"));
});

test("Owner session parsing rejects another app, account, expiry or malformed id", () => {
	const expected = { appId: "app-fixture-instance", accountId: "local-owner:app-fixture-instance" };
	const session = {
		kind: "owner",
		appId: expected.appId,
		accountId: expected.accountId,
		credentialVersion: 3,
		sessionId: "a".repeat(43),
		expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
	};
	assert.equal(isOwnerSession(session, expected), true);
	assert.equal(isOwnerSession({ ...session, appId: "app-other" }, expected), false);
	assert.equal(isOwnerSession({ ...session, accountId: "local-owner:app-other" }, expected), false);
	assert.equal(isOwnerSession({ ...session, credentialVersion: 0 }, expected), false);
	assert.equal(isOwnerSession({ ...session, sessionId: "short" }, expected), false);
	assert.equal(isOwnerSession({
		...session,
		expiresAt: new Date(Date.now() - 1000).toISOString(),
	}, expected), false);
	assert.equal(isOwnerSession({
		...session,
		expiresAt: new Date(Date.now() + OWNER_SESSION_SECONDS * 1000 + 60_000).toISOString(),
	}, expected), false);
	assert.equal(isOwnerSession({ ...session, kind: "mira" }, expected), false);
	assert.equal(isOwnerSession(null, expected), false);
});
