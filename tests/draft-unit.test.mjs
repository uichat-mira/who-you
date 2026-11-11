import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	SignJWT,
} from "jose";
import {
	CLOUD_AUTH_TOKEN_ISSUER,
	WHOYOU_MAIL_SEND_SCOPE,
	WHOYOU_SERVICE_AUDIENCE,
	buildDraftContent,
	canonicalDraftPayload,
	createCloudAuthConfirmationVerifier,
	draftContentHash,
} from "../dist/unit.mjs";

const NOW = Math.floor(Date.now() / 1000);
const JWKS_URL = new URL("https://auth.example.com/.well-known/jwks.json");
const { publicKey, privateKey } = await generateKeyPair("Ed25519");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "confirmation-key", alg: "EdDSA", use: "sig" };
const keySet = createLocalJWKSet({ keys: [publicJwk] });

const verifier = createCloudAuthConfirmationVerifier({
	issuer: CLOUD_AUTH_TOKEN_ISSUER,
	audience: WHOYOU_SERVICE_AUDIENCE,
	jwksUrl: JWKS_URL,
	keySet,
});

const CONTENT_HASH = "a".repeat(64);

const validConfirmation = (overrides = {}) => ({
	actor: "user",
	draft_id: "drf_abc123",
	draft_version: 3,
	content_hash: CONTENT_HASH,
	nonce: "nonce_abcdefghijklmnop",
	...overrides,
});

async function credential(options = {}) {
	const {
		issuer = CLOUD_AUTH_TOKEN_ISSUER,
		audience = WHOYOU_SERVICE_AUDIENCE,
		expiresAt = NOW + 3600,
		subject = "account-a",
		consumer = "account-a",
		scope = [WHOYOU_MAIL_SEND_SCOPE],
		confirmation = validConfirmation(),
		key = privateKey,
	} = options;
	const payload = { scope };
	if (consumer !== null) payload.consumer_id = consumer;
	if (confirmation !== null) payload.confirmation = confirmation;
	return new SignJWT(payload)
		.setProtectedHeader({ alg: "EdDSA" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject(subject)
		.setExpirationTime(expiresAt)
		.sign(key);
}

test("draft content normalizes addresses, subject and body", () => {
	const built = buildDraftContent({
		to: [
			{ name: "  Alice  ", address: " ALICE@Example.COM " },
			{ name: "Alias", address: "alice@example.com" },
		],
		subject: "  Quarterly   report\r\n",
		text: "Hello\r\nthere",
	});
	assert.equal(built.ok, true);
	assert.deepEqual(built.content.to, [{ name: "Alice", address: "alice@example.com" }]);
	assert.equal(built.content.subject, "Quarterly report");
	assert.equal(built.content.text, "Hello\nthere");
	assert.equal(built.content.html, null);
});

test("draft content rejects unusable input instead of guessing", () => {
	assert.equal(buildDraftContent({ text: "hi" }).reason, "no_recipients");
	assert.equal(
		buildDraftContent({ to: [{ name: "", address: "not-an-address" }], text: "hi" }).reason,
		"invalid_recipient",
	);
	assert.equal(
		buildDraftContent({
			to: [{ name: "", address: "a@b.com" }, { name: "", address: "a@b" }],
			text: "hi",
		}).reason,
		"invalid_recipient",
	);
	assert.equal(
		buildDraftContent({ to: [{ name: "", address: "a@b.com" }], text: "" }).reason,
		"empty_body",
	);
	assert.equal(
		buildDraftContent({ to: [{ name: "", address: "a@b.com" }], subject: "x".repeat(999), text: "hi" })
			.reason,
		"invalid_subject",
	);
});

test("draft content hash is stable and covers every content field", async () => {
	const base = { to: [{ name: "A", address: "a@b.com" }], subject: "Hi", text: "Body" };
	const first = await draftContentHash(buildDraftContent(base).content);
	const second = await draftContentHash(buildDraftContent({ ...base }).content);
	assert.equal(first, second);
	assert.match(first, /^[a-f0-9]{64}$/);

	const changed = await draftContentHash(
		buildDraftContent({ ...base, subject: "Hi!" }).content,
	);
	assert.notEqual(changed, first);

	const payload = JSON.parse(canonicalDraftPayload(buildDraftContent(base).content));
	assert.deepEqual(payload.attachments, []);
	assert.deepEqual(Object.keys(payload), ["to", "cc", "bcc", "subject", "text", "html", "attachments"]);
});

test("a valid confirmation credential yields the account and bound claims", async () => {
	const verified = await verifier.verifyConfirmation(await credential());
	assert.equal(verified.accountId, "account-a");
	assert.deepEqual(verified.confirmation, {
		actor: "user",
		draftId: "drf_abc123",
		draftVersion: 3,
		contentHash: CONTENT_HASH,
		nonce: "nonce_abcdefghijklmnop",
	});
});

test("confirmation credentials fail closed on audience, scope and consumer drift", async () => {
	await assert.rejects(verifier.verifyConfirmation(await credential({ audience: "mira:cloud-guanlan" })));
	await assert.rejects(
		verifier.verifyConfirmation(await credential({ scope: ["whoyou.read", WHOYOU_MAIL_SEND_SCOPE] })),
	);
	await assert.rejects(verifier.verifyConfirmation(await credential({ consumer: "consumer-1" })));
	await assert.rejects(verifier.verifyConfirmation(await credential({ consumer: null })));
	await assert.rejects(verifier.verifyConfirmation(await credential({ expiresAt: 1 })));
});

test("a confirmation claim must match the issuer contract exactly", async () => {
	const cases = [
		validConfirmation({ actor: "agent" }),
		validConfirmation({ draft_version: 0 }),
		validConfirmation({ content_hash: CONTENT_HASH.toUpperCase() }),
		validConfirmation({ nonce: "short" }),
		{ ...validConfirmation(), extra: "not-in-contract" },
	];
	for (const confirmation of cases) {
		await assert.rejects(verifier.verifyConfirmation(await credential({ confirmation })));
	}
	await assert.rejects(verifier.verifyConfirmation(await credential({ confirmation: null })));
	await assert.rejects(verifier.verifyConfirmation("not-a-token"));
});
