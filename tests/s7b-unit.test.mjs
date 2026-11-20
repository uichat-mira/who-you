import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
	CredentialCryptoError,
	credentialAad,
	dekWrapAad,
	openSecret,
	parseKek,
	resolveCredentialKeys,
	rewrapDek,
	sealSecret,
} from "../dist/unit.mjs";

const kekBytes = (fill) => Buffer.alloc(32, fill);
const kekBase64 = (fill) => kekBytes(fill).toString("base64");

const slot = {
	accountId: "account-a",
	provider: "gmail",
	mailboxId: "mbx_gmail",
	credentialType: "oauth_refresh",
};

const isCryptoError = (code) => (error) =>
	error instanceof CredentialCryptoError && error.code === code;

test("parseKek accepts exactly one base64 32-byte key", () => {
	assert.deepEqual([...parseKek(kekBase64(1))], [...kekBytes(1)]);
	assert.equal(parseKek(undefined), null);
	assert.equal(parseKek(""), null);
	assert.equal(parseKek("   "), null);
	assert.equal(parseKek(Buffer.alloc(31, 1).toString("base64")), null);
	assert.equal(parseKek(Buffer.alloc(33, 1).toString("base64")), null);
	assert.equal(parseKek("!!!not-base64!!!"), null);
});

test("AAD strings are stable so drift is visible", () => {
	assert.equal(
		credentialAad({ ...slot, dekId: "dek_abc" }),
		"account-a|gmail|mbx_gmail|dek_abc|oauth_refresh",
	);
	assert.equal(dekWrapAad("account-a", "dek_abc"), "dek|account-a|dek_abc");
});

test("a sealed secret opens only in its own slot", async () => {
	const kek = kekBytes(1);
	const envelope = await sealSecret(kek, "refresh-token-value", slot);
	assert.match(envelope.dekId, /^dek_[0-9a-f]{32}$/);
	assert.equal(envelope.wrappedDek.includes("refresh-token-value"), false);
	assert.equal(envelope.ciphertext.includes("refresh-token-value"), false);

	assert.equal(
		await openSecret(kek, envelope, { ...slot, dekId: envelope.dekId }),
		"refresh-token-value",
	);

	// The DEK wrap binds the account; the secret binds provider/identity/slot.
	await assert.rejects(
		() => openSecret(kek, envelope, { ...slot, dekId: envelope.dekId, accountId: "account-b" }),
		isCryptoError("dek_unwrap_failed"),
	);
	for (const mutation of [
		{ provider: "microsoft" },
		{ mailboxId: "mbx_other" },
		{ credentialType: "imap_password" },
	]) {
		await assert.rejects(
			() => openSecret(kek, envelope, { ...slot, dekId: envelope.dekId, ...mutation }),
			isCryptoError("secret_open_failed"),
			JSON.stringify(mutation),
		);
	}
});

test("a wrong KEK fails the unwrap instead of returning plaintext", async () => {
	const envelope = await sealSecret(kekBytes(1), "refresh-token-value", slot);
	await assert.rejects(
		() => openSecret(kekBytes(2), envelope, { ...slot, dekId: envelope.dekId }),
		isCryptoError("dek_unwrap_failed"),
	);
});

test("rewrapping moves the DEK to a new KEK without re-encrypting the secret", async () => {
	const envelope = await sealSecret(kekBytes(1), "imap-app-password", {
		...slot,
		provider: "imap_smtp",
		credentialType: "imap_password",
	});
	const rewrapped = await rewrapDek(
		kekBytes(1),
		kekBytes(2),
		envelope,
		slot.accountId,
	);
	assert.notEqual(rewrapped.wrappedDek, envelope.wrappedDek);

	const moved = { ...envelope, ...rewrapped };
	const readSlot = {
		...slot,
		provider: "imap_smtp",
		credentialType: "imap_password",
		dekId: envelope.dekId,
	};
	assert.equal(await openSecret(kekBytes(2), moved, readSlot), "imap-app-password");
	await assert.rejects(
		() => openSecret(kekBytes(1), moved, readSlot),
		isCryptoError("dek_unwrap_failed"),
	);
});

test("resolveCredentialKeys fails closed and only keeps a distinct previous key", () => {
	assert.equal(resolveCredentialKeys({}), null);
	assert.equal(resolveCredentialKeys({ MAIL_CREDENTIAL_KEK: "short" }), null);

	const current = resolveCredentialKeys({ MAIL_CREDENTIAL_KEK: kekBase64(1) });
	assert.equal(current.current.version, 1);
	assert.equal(current.previous, null);

	const rotated = resolveCredentialKeys({
		MAIL_CREDENTIAL_KEK: kekBase64(2),
		MAIL_CREDENTIAL_KEK_VERSION: "2",
		MAIL_CREDENTIAL_KEK_PREVIOUS: kekBase64(1),
		MAIL_CREDENTIAL_KEK_PREVIOUS_VERSION: "1",
	});
	assert.equal(rotated.current.version, 2);
	assert.equal(rotated.previous.version, 1);
	assert.deepEqual([...rotated.previous.kek], [...kekBytes(1)]);

	const sameVersion = resolveCredentialKeys({
		MAIL_CREDENTIAL_KEK: kekBase64(2),
		MAIL_CREDENTIAL_KEK_VERSION: "2",
		MAIL_CREDENTIAL_KEK_PREVIOUS: kekBase64(1),
		MAIL_CREDENTIAL_KEK_PREVIOUS_VERSION: "2",
	});
	assert.equal(sameVersion.previous, null);

	const noPreviousVersion = resolveCredentialKeys({
		MAIL_CREDENTIAL_KEK: kekBase64(2),
		MAIL_CREDENTIAL_KEK_PREVIOUS: kekBase64(1),
	});
	assert.equal(noPreviousVersion.previous, null);
});
