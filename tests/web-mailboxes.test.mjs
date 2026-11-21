import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { webcrypto } from "node:crypto";
import { URLSearchParams } from "node:url";
import { Miniflare } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { MIGRATIONS } from "./workerd-harness.mjs";

/**
 * Browser BFF mailbox listing (OPS-039). The production Worker is exercised
 * with its real Cloud Auth verifier; only the Cloud Auth endpoints are scripted.
 * Every mailbox, account and credential below is synthetic.
 */

const ORIGIN = "https://who-you.tomz.io";
const AUTH = "https://cloud-auth.tomzlab.cn";
const TOKEN_URL = AUTH + "/v1/oauth/token";
const ISSUE_URL = AUTH + "/v1/service-credentials";
const JWKS_URL = AUTH + "/.well-known/jwks.json";
const SESSION_KEY = Buffer.alloc(32, 7).toString("base64url");
const NOW = 1_795_000_000_000;

const SESSIONS = new Map([
	["session-account-e2e", "account-e2e"],
	["session-account-other", "account-other"],
	["session-account-empty", "account-empty"],
]);
const CODES = new Map([
	["code-e2e", "session-account-e2e"],
	["code-other", "session-account-other"],
	["code-empty", "session-account-empty"],
]);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = {
	...(await exportJWK(publicKey)),
	kid: "test-key",
	use: "sig",
	alg: "EdDSA",
};

const credential = (accountId) =>
	new SignJWT({ consumer_id: `consumer-${accountId}`, scope: ["whoyou.read"] })
		.setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "test-key" })
		.setIssuer("mira:cloud-auth")
		.setAudience("mira:who-you")
		.setSubject(accountId)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);

const outbound = async (request) => {
	if (request.url === TOKEN_URL) {
		const sessionToken = CODES.get(new URLSearchParams(await request.text()).get("code"));
		if (!sessionToken) return Response.json({ error: "invalid_grant" }, { status: 400 });
		return Response.json({
			sessionToken,
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		});
	}
	if (request.url === ISSUE_URL) {
		const sessionToken = request.headers.get("authorization")?.replace(/^Bearer /, "");
		const accountId = SESSIONS.get(sessionToken ?? "");
		if (!accountId) return Response.json({ error: "invalid_token" }, { status: 401 });
		assert.deepEqual(await request.json(), { audience: "mira:who-you" });
		return Response.json({
			token: await credential(accountId),
			tokenType: "Bearer",
			audience: "mira:who-you",
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
		});
	}
	if (request.url === JWKS_URL) return Response.json({ keys: [jwk] });
	return Response.json({ error: "unexpected_upstream", url: request.url }, { status: 404 });
};

function createWorker({ storage = true } = {}) {
	return new Miniflare({
		modules: true,
		scriptPath: "dist/worker.mjs",
		compatibilityDate: "2026-08-06",
		cf: false,
		bindings: {
			WHOYOU_WEB_SESSION_KEY: SESSION_KEY,
			MCP_RESOURCE_URL: ORIGIN + "/mcp",
			CLOUD_AUTH_ISSUER: AUTH,
			CLOUD_AUTH_JWKS_URL: JWKS_URL,
			MCP_AUDIENCE: "mira:who-you",
		},
		...(storage ? { d1Databases: ["DB"], r2Buckets: ["MAIL_BUCKET"] } : {}),
		outboundService: outbound,
	});
}

const cookies = (response) =>
	response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

async function login(mf, code) {
	const start = await mf.dispatchFetch(ORIGIN + "/auth/start", { redirect: "manual" });
	assert.equal(start.status, 303);
	const state = new URL(start.headers.get("location")).searchParams.get("state");
	assert.ok(state);
	const callback = await mf.dispatchFetch(
		ORIGIN + "/auth/callback?" + new URLSearchParams({ state, code }),
		{ redirect: "manual", headers: { cookie: cookies(start) } },
	);
	assert.equal(callback.status, 303, await callback.text());
	const session = callback.headers
		.getSetCookie()
		.find((value) => value.startsWith("__Host-who_you_session="));
	assert.ok(session);
	return session.split(";")[0];
}

async function expiredSessionCookie() {
	const key = await webcrypto.subtle.importKey(
		"raw",
		Buffer.from(SESSION_KEY, "base64url"),
		"AES-GCM",
		false,
		["encrypt"],
	);
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const sealed = new Uint8Array(
		await webcrypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ORIGIN) },
			key,
			new TextEncoder().encode(JSON.stringify({
				sessionToken: "expired-session-token-value",
				expiresAt: new Date(Date.now() - 1000).toISOString(),
			})),
		),
	);
	const bytes = new Uint8Array(iv.length + sealed.length);
	bytes.set(iv);
	bytes.set(sealed, iv.length);
	return "__Host-who_you_session=" + Buffer.from(bytes).toString("base64url");
}

async function seedMailbox(db, input) {
	await db
		.prepare(
			`INSERT INTO mailboxes (
			 id, account_id, address, local_part, kind, provider, status, quota_bytes,
			 bytes_used, message_count, quarantine_count, created_at, updated_at
			 ) VALUES (?,?,?,?,?,?,?,?,0,0,0,?,?)`,
		)
		.bind(
			input.id,
			input.accountId,
			input.address,
			input.localPart,
			input.kind ?? "own_domain",
			input.provider ?? null,
			input.status ?? "active",
			1024 * 1024,
			NOW,
			NOW,
		)
		.run();
}

async function seedCredential(db, input) {
	await db
		.prepare(
			`INSERT INTO provider_credentials (
			 id, account_id, mailbox_id, provider, credential_type, status, dek_id,
			 wrapped_dek, wrap_nonce, ciphertext, nonce, key_version, scope,
			 created_at, updated_at, revoked_at
			 ) VALUES (?,?,?,?, 'oauth_refresh', ?, ?, 'wrapped-dek', 'wrap-nonce',
			 'sealed-ciphertext', 'nonce', 1, '', ?, ?, NULL)`,
		)
		.bind(
			`cred_${input.mailboxId}`,
			input.accountId,
			input.mailboxId,
			input.provider,
			input.status,
			`dek_${input.mailboxId}`,
			NOW,
			NOW,
		)
		.run();
}

async function seedAccounts(db) {
	await seedMailbox(db, {
		id: "mbx_own",
		accountId: "account-e2e",
		address: "alpha@tomlab.cn",
		localPart: "alpha",
	});
	await seedMailbox(db, {
		id: "mbx_gmail",
		accountId: "account-e2e",
		address: "user@gmail.com",
		localPart: "user",
		kind: "third_party",
		provider: "gmail",
	});
	await seedCredential(db, {
		accountId: "account-e2e",
		mailboxId: "mbx_gmail",
		provider: "gmail",
		status: "active",
	});
	await seedMailbox(db, {
		id: "mbx_ms",
		accountId: "account-e2e",
		address: "broken@outlook.com",
		localPart: "broken",
		kind: "third_party",
		provider: "microsoft",
	});
	await seedCredential(db, {
		accountId: "account-e2e",
		mailboxId: "mbx_ms",
		provider: "microsoft",
		status: "reauth_required",
	});
	await seedMailbox(db, {
		id: "mbx_other",
		accountId: "account-other",
		address: "beta@tomlab.cn",
		localPart: "beta",
	});
}

const EXPECTED_KEYS = [
	"address",
	"availability",
	"credentialStatus",
	"kind",
	"mailboxId",
	"provider",
];

test("a signed-in account receives only its own mailboxes with minimal fields", async () => {
	const mf = createWorker();
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		await seedAccounts(db);
		const cookie = await login(mf, "code-e2e");
		const response = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie },
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const body = await response.json();
		const entries = [...body.mailboxes].sort((a, b) => a.mailboxId.localeCompare(b.mailboxId));
		assert.deepEqual(entries, [
			{
				mailboxId: "mbx_gmail",
				address: "user@gmail.com",
				kind: "third_party",
				provider: "gmail",
				credentialStatus: "active",
				availability: "ready",
			},
			{
				mailboxId: "mbx_ms",
				address: "broken@outlook.com",
				kind: "third_party",
				provider: "microsoft",
				credentialStatus: "reauth_required",
				availability: "reauth_required",
			},
			{
				mailboxId: "mbx_own",
				address: "alpha@tomlab.cn",
				kind: "own_domain",
				provider: null,
				credentialStatus: null,
				availability: "ready",
			},
		]);
		for (const entry of body.mailboxes) assert.deepEqual(Object.keys(entry).sort(), EXPECTED_KEYS);
		const serialized = JSON.stringify(body);
		assert.doesNotMatch(serialized, /beta@tomlab\.cn/);
		assert.doesNotMatch(serialized, /account-e2e|account-other/);
		assert.doesNotMatch(serialized, /wrapped-dek|sealed-ciphertext|session-account|eyJ/);
	} finally {
		await mf.dispose();
	}
});

test("another account and an empty account stay isolated", async () => {
	const mf = createWorker();
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		await seedAccounts(db);

		const other = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie: await login(mf, "code-other") },
		});
		assert.equal(other.status, 200);
		const otherBody = await other.json();
		assert.deepEqual(otherBody.mailboxes.map((entry) => entry.address), ["beta@tomlab.cn"]);

		const empty = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie: await login(mf, "code-empty") },
		});
		assert.equal(empty.status, 200);
		assert.deepEqual(await empty.json(), { mailboxes: [] });
	} finally {
		await mf.dispose();
	}
});

test("no session, forged cookie and client-selected account are rejected", async () => {
	const mf = createWorker();
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		await seedAccounts(db);

		const anonymous = await mf.dispatchFetch(ORIGIN + "/api/mailboxes");
		assert.equal(anonymous.status, 401);
		const anonymousText = await anonymous.text();
		assert.doesNotMatch(anonymousText, /alpha@tomlab\.cn|beta@tomlab\.cn|user@gmail\.com/);

		const forged = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie: "__Host-who_you_session=forged-session" },
		});
		assert.equal(forged.status, 401);
		assert.doesNotMatch(await forged.text(), /alpha@tomlab\.cn|beta@tomlab\.cn/);

		const expired = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie: await expiredSessionCookie() },
		});
		assert.equal(expired.status, 401);
		assert.doesNotMatch(await expired.text(), /alpha@tomlab\.cn|beta@tomlab\.cn/);

		const cookie = await login(mf, "code-e2e");
		for (const query of [
			"?accountId=account-other",
			"?address=beta%40tomlab.cn",
			"?mailboxId=mbx_other",
			"?bearer=anything",
		]) {
			const response = await mf.dispatchFetch(ORIGIN + "/api/mailboxes" + query, {
				headers: { cookie },
			});
			assert.equal(response.status, 400, query);
			assert.equal((await response.json()).error, "unexpected_parameter");
		}

		const bearer = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie, authorization: "Bearer client-supplied" },
		});
		assert.equal(bearer.status, 400);
		assert.equal((await bearer.json()).error, "unexpected_authorization");
	} finally {
		await mf.dispose();
	}
});

test("a deployment without mail storage reports mailboxes unavailable, not empty", async () => {
	const mf = createWorker({ storage: false });
	try {
		const cookie = await login(mf, "code-e2e");
		const response = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie },
		});
		assert.equal(response.status, 503);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(await response.json(), {
			error: "mailboxes_unavailable",
			reason: "mail_storage_not_configured",
		});
	} finally {
		await mf.dispose();
	}
});
