import { test } from "node:test";
import assert from "node:assert/strict";
import {
	APP_SECRET_ENTROPY_BYTES,
	APP_SECRET_MAX_LENGTH,
	APP_SECRET_MIN_LENGTH,
	digestAppSecret,
	generateAppSecret,
	isValidAppSecret,
	verifyAppSecret,
} from "../dist/unit.mjs";

const SALT = new Uint8Array(16).fill(11);

test("rotated AppSecrets are high-entropy and only their salted digest verifies", async () => {
	const first = generateAppSecret();
	const second = generateAppSecret();
	assert.match(first, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(APP_SECRET_ENTROPY_BYTES, 32);
	assert.equal(first.length, 43);
	assert.notEqual(first, second);
	assert.equal(isValidAppSecret(first), true);

	const digest = await digestAppSecret(first, SALT);
	assert.match(digest.secretHash, /^[\w-]{43}$/);
	assert.match(digest.secretSalt, /^[\w-]{22}$/);
	assert.ok(!digest.secretHash.includes(first));
	assert.ok(!digest.secretSalt.includes(first));
	assert.equal(await verifyAppSecret(first, digest), true);
	assert.equal(await verifyAppSecret(second, digest), false);

	const otherSalt = await digestAppSecret(first, new Uint8Array(16).fill(12));
	assert.notEqual(otherSalt.secretHash, digest.secretHash);
	assert.equal(await verifyAppSecret(first, otherSalt), true);
	assert.equal(await verifyAppSecret(first, { ...digest, secretSalt: otherSalt.secretSalt }), false);

	const tampered = {
		...digest,
		secretHash: (digest.secretHash[0] === "A" ? "B" : "A") + digest.secretHash.slice(1),
	};
	assert.equal(await verifyAppSecret(first, tampered), false);
	assert.equal(await verifyAppSecret(first, { ...digest, secretHash: "short" }), false);
	assert.equal(await verifyAppSecret(first, { ...digest, secretSalt: "short" }), false);
	assert.equal(await verifyAppSecret("", digest), false);
});

test("AppSecret length rules match the Mira ID V1 registration contract", () => {
	assert.equal(APP_SECRET_MIN_LENGTH, 16);
	assert.equal(APP_SECRET_MAX_LENGTH, 512);
	assert.equal(isValidAppSecret("x".repeat(APP_SECRET_MIN_LENGTH - 1)), false);
	assert.equal(isValidAppSecret("x".repeat(APP_SECRET_MIN_LENGTH)), true);
	assert.equal(isValidAppSecret("x".repeat(APP_SECRET_MAX_LENGTH)), true);
	assert.equal(isValidAppSecret("x".repeat(APP_SECRET_MAX_LENGTH + 1)), false);
	assert.equal(isValidAppSecret(""), false);
	assert.equal(isValidAppSecret(42), false);
});
