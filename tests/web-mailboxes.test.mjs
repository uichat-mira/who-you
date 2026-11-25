import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { webcrypto } from "node:crypto";
import { URLSearchParams } from "node:url";
import { Miniflare } from "miniflare";
import { exportJWK, generateKeyPair } from "jose";
import { MIGRATIONS } from "./workerd-harness.mjs";

/**
 * Browser BFF mailbox listing (OPS-039). The production Worker is exercised
 * with its real Cloud Auth verifier; only the Cloud Auth endpoints are scripted.
 * Every mailbox, account and credential below is synthetic.
 */

const ORIGIN = "https://who-you.tomz.io";
const AUTH = "https://cloud-auth.tomzlab.cn";
const TOKEN_URL = AUTH + "/v1/oauth/token";
const SESSION_URL = AUTH + "/v1/oauth/application-session";
const JWKS_URL = AUTH + "/.well-known/jwks.json";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const SESSION_KEY = Buffer.alloc(32, 7).toString("base64url");
const NOW = 1_795_000_000_000;

const SESSIONS = new Map([
	["mas_v1.fixture.e2e", "account-e2e"],
	["mas_v1.fixture.other", "account-other"],
	["mas_v1.fixture.empty", "account-empty"],
]);
const CODES = new Map([
	["code-e2e", "mas_v1.fixture.e2e"],
	["code-other", "mas_v1.fixture.other"],
	["code-empty", "mas_v1.fixture.empty"],
]);

const { publicKey } = await generateKeyPair("EdDSA");
const jwk = {
	...(await exportJWK(publicKey)),
	kid: "test-key",
	use: "sig",
	alg: "EdDSA",
};

const createOutbound = (trace = {}) => async (request) => {
	if (request.url === TOKEN_URL) {
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get("client_id"), ORIGIN + "/oauth-client");
    assert.equal(form.get("installation_id"), null);
    assert.equal(form.get("platform"), null);
    const token = CODES.get(form.get("code"));
    if (!token) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const identity = { issuer: "mira:cloud-auth", subject: SESSIONS.get(token),
      audience: ORIGIN + "/oauth-client", appId: "app-fixture-instance",
      expiresAt: new Date(Date.now() + 1800_000).toISOString() };
    trace.sessions ??= new Map();
    trace.sessions.set(token, identity);
    return Response.json({ access_token: token, token_type: "Bearer", expires_in: 1800, ...identity });
  }
  if (request.url === SESSION_URL) {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const identity = trace.sessions?.get(token);
    trace.sessionChecks = (trace.sessionChecks ?? 0) + 1;
    return identity ? Response.json(identity) : Response.json({ error: "invalid_token" }, { status: 401 });
  }
  if (request.url.endsWith("/v1/service-credentials")) {
    trace.legacyRequests = (trace.legacyRequests ?? 0) + 1;
    return new Response(null, { status: 404 });
  }
	if (request.url === JWKS_URL) return Response.json({ keys: [jwk] });
	if (request.url === GOOGLE_TOKEN_URL) {
		trace.googleTokenExchanges = (trace.googleTokenExchanges ?? 0) + 1;
		const body = new URLSearchParams(await request.text());
		assert.equal(body.get("grant_type"), "authorization_code");
		assert.equal(body.get("client_id"), "synthetic-test-client");
		assert.equal(body.get("client_secret"), "synthetic-test-secret");
		assert.equal(body.get("redirect_uri"), ORIGIN + "/mail/oauth/gmail/callback");
		assert.match(body.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43}$/);
		return Response.json({
			access_token: "synthetic-google-access",
			refresh_token: "synthetic-google-refresh",
			token_type: "Bearer",
			expires_in: 3600,
			scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
		});
	}
	if (request.url === GMAIL_PROFILE_URL) {
		trace.gmailProfiles = (trace.gmailProfiles ?? 0) + 1;
		assert.equal(request.headers.get("authorization"), "Bearer synthetic-google-access");
		return Response.json({ emailAddress: "linked@gmail.com", historyId: "12345" });
	}
	if (request.url === GOOGLE_REVOKE_URL) {
		trace.googleRevokes = (trace.googleRevokes ?? 0) + 1;
		return new Response(null, { status: 200 });
	}
	return Response.json({ error: "unexpected_upstream", url: request.url }, { status: 404 });
};

function createWorker({ storage = true, mailConfigured = true, gmailConfigured = true, trace = {} } = {}) {
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
			WHOYOU_APP_ID: "app-fixture-instance",
			WHOYOU_APP_SECRET: "fixture-registration-not-a-real-secret",
			WHOYOU_MANIFEST_REVISION: "1",
            ...(mailConfigured ? {
              MAIL_DOMAIN: "tomlab.cn",
              MAIL_CREDENTIAL_KEK: Buffer.alloc(32, 9).toString("base64"),
              ...(gmailConfigured ? {
                GMAIL_OAUTH_CLIENT_ID: "synthetic-test-client",
                GMAIL_OAUTH_CLIENT_SECRET: "synthetic-test-secret",
                GMAIL_OAUTH_REDIRECT_URI: ORIGIN + "/mail/oauth/gmail/callback",
              } : {}),
            } : {}),
		},
		...(storage ? { d1Databases: ["DB"], r2Buckets: ["MAIL_BUCKET"] } : {}),
		outboundService: createOutbound(trace),
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

async function startGmailFlow(mf, cookie) {
	const started = await mf.dispatchFetch(ORIGIN + "/account/mailboxes/gmail/link", {
		method: "POST",
		redirect: "manual",
		headers: { cookie, origin: ORIGIN },
	});
	assert.equal(started.status, 303, await started.text());
	const authorization = new URL(started.headers.get("location"));
	const state = authorization.searchParams.get("state");
	assert.ok(state);
	return { started, authorization, state, flowCookie: cookies(started) };
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
	"sync",
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
				availability: "configured",
				sync: null,
			},
			{
				mailboxId: "mbx_ms",
				address: "broken@outlook.com",
				kind: "third_party",
				provider: "microsoft",
				credentialStatus: "reauth_required",
				availability: "reauth_required",
				sync: null,
			},
			{
				mailboxId: "mbx_own",
				address: "alpha@tomlab.cn",
				kind: "own_domain",
				provider: null,
				credentialStatus: null,
				availability: "configured",
				sync: null,
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


test("a stored active credential is not usable without the deployment KEK/provider bindings", async () => {
  const mf = createWorker({ mailConfigured: false });
  try {
    const db = await mf.getD1Database("DB");
    await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
    await seedAccounts(db);
    const response = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
      headers: { cookie: await login(mf, "code-e2e") },
    });
    assert.equal(response.status, 200);
    const { mailboxes } = await response.json();
    const byId = Object.fromEntries(mailboxes.map((m) => [m.mailboxId, m]));
    assert.equal(byId.mbx_own.availability, "service_unavailable");
    assert.equal(byId.mbx_gmail.credentialStatus, "active");
    assert.equal(byId.mbx_gmail.availability, "credential_unavailable");
    assert.equal(byId.mbx_ms.availability, "reauth_required");
  } finally {
    await mf.dispose();
  }
});

test("an active Gmail record without a registered OAuth provider is not ready", async () => {
  const mf = createWorker({ gmailConfigured: false });
  try {
    const db = await mf.getD1Database("DB");
    await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
    await seedAccounts(db);
    const response = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
      headers: { cookie: await login(mf, "code-e2e") },
    });
    assert.equal(response.status, 200);
    const { mailboxes } = await response.json();
    const gmail = mailboxes.find((m) => m.mailboxId === "mbx_gmail");
    assert.equal(gmail.credentialStatus, "active");
    assert.equal(gmail.availability, "service_unavailable");
  } finally {
    await mf.dispose();
  }
});

test("a configured D1/R2 preview with no mail service does not pretend an empty list is an enabled mailbox product", async () => {
  const mf = createWorker({ mailConfigured: false });
  try {
    const db = await mf.getD1Database("DB");
    await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
    const response = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
      headers: { cookie: await login(mf, "code-empty") },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "mailboxes_unavailable",
      reason: "mail_service_not_configured",
    });
  } finally {
    await mf.dispose();
  }
});

test("the mailbox page renders the signed-in account's real list with explicit states", async () => {
	const mf = createWorker();
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		await seedAccounts(db);
		const response = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {
			headers: { cookie: await login(mf, "code-e2e") },
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const body = await response.text();
		assert.match(body, /alpha@tomlab\.cn/);
		assert.match(body, /user@gmail\.com/);
		assert.match(body, /broken@outlook\.com/);
		assert.match(body, /自有域邮箱/);
		assert.match(body, /Gmail/);
		assert.match(body, /Microsoft/);
		assert.match(body, /IMAP\/SMTP/);
		assert.match(body, /本地配置就绪/);
		assert.match(body, /仅表示狐邮当前运行环境的必要依赖已配置/);
		assert.match(body, /需要重新授权/);
		assert.match(body, /有授权记录（不代表已可收发）/);
		assert.doesNotMatch(body, /beta@tomlab\.cn/);
		assert.doesNotMatch(body, /account-e2e|account-other/);
		assert.doesNotMatch(body, /example\.com|demo@|placeholder@/i);
		assert.equal(response.headers.get("referrer-policy"), "same-origin");
		assert.equal(response.headers.get("content-security-policy")?.split("; ")
			.find((directive) => directive.startsWith("form-action ")),
			"form-action 'self' https://accounts.google.com/o/oauth2/v2/auth");
		assert.match(body, /action="\/account\/mailboxes\/gmail\/link"/);
		assert.match(body, /action="\/account\/mailboxes\/unlink"/);
		assert.doesNotMatch(body, /action="\/account\/mailboxes\/sync"/);
		assert.doesNotMatch(body, /同步一次/);
		assert.match(body, /尚未同步/);
		assert.match(body, /更新 Gmail 授权/);
		assert.match(body, /解绑 Gmail/);
		assert.match(body, /Gmail<\/strong> <span class="pill ok">可接入<\/span>/);
		assert.match(body, /Microsoft<\/strong> <span class="pill muted">尚未开放<\/span>/);
		assert.match(body, /IMAP\/SMTP<\/strong> <span class="pill muted">尚未开放<\/span>/);
	} finally {
		await mf.dispose();
	}
});

test("the mailbox page explains an empty account without inventing mailboxes", async () => {
	const mf = createWorker();
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		await seedAccounts(db);
		const response = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {
			headers: { cookie: await login(mf, "code-empty") },
		});
		assert.equal(response.status, 200);
		const body = await response.text();
		assert.match(body, /当前账号还没有登记邮箱/);
		assert.doesNotMatch(body, /alpha@tomlab\.cn|beta@tomlab\.cn|user@gmail\.com/);
		assert.doesNotMatch(body, /<li class="mailbox">/);
	} finally {
		await mf.dispose();
	}
});

test("the mailbox page reports service failure instead of a fake empty list", async () => {
	const mf = createWorker({ storage: false });
	try {
		const response = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {
			headers: { cookie: await login(mf, "code-e2e") },
		});
		assert.equal(response.status, 503);
		const body = await response.text();
		assert.match(body, /邮箱服务尚未配置或暂时不可用/);
		assert.doesNotMatch(body, /当前账号还没有登记邮箱/);
		assert.doesNotMatch(body, /mail_storage_not_configured/);
	} finally {
		await mf.dispose();
	}
});

test("an unauthenticated mailbox page redirects to login and never leaks a list", async () => {
	const mf = createWorker();
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		await seedAccounts(db);
		const response = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {
			redirect: "manual",
		});
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"),
			"/?reason=sign_in_required&returnTo=%2Faccount%2Fmailboxes");
		assert.doesNotMatch(await response.text(), /alpha@tomlab\.cn|user@gmail\.com/);
	} finally {
		await mf.dispose();
	}
});


test("Web Gmail link -> provider callback -> list -> unlink is account-bound and idempotent", async () => {
	const trace = {};
	const mf = createWorker({ trace });
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const ownerCookie = await login(mf, "code-empty");

		const started = await mf.dispatchFetch(ORIGIN + "/account/mailboxes/gmail/link", {
			method: "POST",
			redirect: "manual",
			headers: { cookie: ownerCookie, origin: ORIGIN },
		});
		assert.equal(started.status, 303, await started.text());
		const authorization = new URL(started.headers.get("location"));
		assert.equal(authorization.origin, "https://accounts.google.com");
		assert.equal(authorization.pathname, "/o/oauth2/v2/auth");
		assert.equal(authorization.searchParams.get("client_id"), "synthetic-test-client");
		assert.equal(
			authorization.searchParams.get("redirect_uri"),
			ORIGIN + "/mail/oauth/gmail/callback",
		);
		assert.equal(authorization.searchParams.get("access_type"), "offline");
		assert.equal(authorization.searchParams.get("prompt"), "consent");
		assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
		const state = authorization.searchParams.get("state");
		assert.match(state ?? "", /^[A-Za-z0-9_-]{43}$/);
		const scope = authorization.searchParams.get("scope") ?? "";
		assert.match(scope, /gmail\.send/);
		assert.match(scope, /gmail\.readonly/);
		const flowCookie = cookies(started);
		assert.match(flowCookie, /__Host-who_you_mail_oauth=/);
		assert.doesNotMatch(
			started.headers.get("location") + flowCookie,
			/session-account|synthetic-google-refresh|synthetic-google-access/,
		);

        const bare = await mf.dispatchFetch(ORIGIN + "/mail/oauth/gmail/callback?" +
            new URLSearchParams({ state, code: "must-not-exchange" }), { redirect: "manual" });
        assert.equal(bare.status, 400);
        assert.deepEqual(await bare.json(), { error: "invalid_state" });
        assert.equal(trace.googleTokenExchanges ?? 0, 0);

		const callback = await mf.dispatchFetch(
			ORIGIN + "/mail/oauth/gmail/callback?" +
				new URLSearchParams({ state, code: "synthetic-provider-code" }),
			{
				redirect: "manual",
				headers: { cookie: ownerCookie + "; " + flowCookie },
			},
		);
		assert.equal(callback.status, 303, await callback.text());
		assert.equal(callback.headers.get("location"), "/account/mailboxes?notice=gmail_connected");
		assert.equal(trace.googleTokenExchanges, 1);
		assert.equal(trace.gmailProfiles, 1);

		const resultCookie = callback.headers
			.getSetCookie()
			.find((value) => value.startsWith("__Host-who_you_mail_oauth_result="));
		assert.ok(resultCookie);
		const repeatedCallback = await mf.dispatchFetch(
			ORIGIN + "/mail/oauth/gmail/callback?" +
				new URLSearchParams({ state, code: "synthetic-provider-code" }),
			{
				redirect: "manual",
				headers: { cookie: ownerCookie + "; " + resultCookie.split(";")[0] },
			},
		);
		assert.equal(repeatedCallback.status, 303, await repeatedCallback.text());
		assert.equal(
			repeatedCallback.headers.get("location"),
			"/account/mailboxes?notice=gmail_connected",
		);
		assert.equal(trace.googleTokenExchanges, 1);
		assert.equal(trace.gmailProfiles, 1);

		const page = await mf.dispatchFetch(
			ORIGIN + "/account/mailboxes?notice=gmail_connected",
			{ headers: { cookie: ownerCookie } },
		);
		assert.equal(page.status, 200);
		const html = await page.text();
		assert.match(html, /linked@gmail\.com/);
		assert.match(html, /Gmail 已连接/);
		assert.match(html, /更新 Gmail 授权/);
		assert.match(html, /解绑 Gmail/);
		assert.doesNotMatch(
			html,
			/synthetic-google-refresh|synthetic-google-access|session-account/,
		);

		const listed = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie: ownerCookie },
		});
		assert.equal(listed.status, 200);
		const ownerMailboxes = (await listed.json()).mailboxes;
		const gmail = ownerMailboxes.find((entry) => entry.address === "linked@gmail.com");
		assert.ok(gmail);
		assert.equal(gmail.provider, "gmail");
		assert.equal(gmail.credentialStatus, "active");
		assert.equal(gmail.availability, "configured");

		assert.equal(trace.legacyRequests ?? 0, 0);
		assert.ok(trace.sessionChecks > 0);

		const otherCookie = await login(mf, "code-other");
		const crossAccount = await mf.dispatchFetch(ORIGIN + "/account/mailboxes/unlink", {
			method: "POST",
			redirect: "manual",
			headers: {
				cookie: otherCookie,
				origin: ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ mailboxId: gmail.mailboxId }).toString(),
		});
		assert.equal(crossAccount.status, 303);
		assert.equal(trace.googleRevokes ?? 0, 0);
		const ownerStillHas = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie: ownerCookie },
		});
		assert.ok(
			(await ownerStillHas.json()).mailboxes.some(
				(entry) => entry.mailboxId === gmail.mailboxId,
			),
		);

		const unlink = await mf.dispatchFetch(ORIGIN + "/account/mailboxes/unlink", {
			method: "POST",
			redirect: "manual",
			headers: {
				cookie: ownerCookie,
				origin: ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ mailboxId: gmail.mailboxId }).toString(),
		});
		assert.equal(unlink.status, 303);
		assert.equal(unlink.headers.get("location"), "/account/mailboxes?notice=gmail_unlinked");
		assert.equal(trace.googleRevokes, 1);

		assert.equal(trace.legacyRequests ?? 0, 0);
		assert.equal(
			await db
				.prepare("SELECT COUNT(*) AS total FROM mailboxes WHERE id = ?")
				.bind(gmail.mailboxId)
				.first()
				.then((row) => row.total),
			0,
		);
		assert.equal(
			await db
				.prepare("SELECT COUNT(*) AS total FROM provider_credentials WHERE mailbox_id = ?")
				.bind(gmail.mailboxId)
				.first()
				.then((row) => row.total),
			0,
		);

		const repeated = await mf.dispatchFetch(ORIGIN + "/account/mailboxes/unlink", {
			method: "POST",
			redirect: "manual",
			headers: {
				cookie: ownerCookie,
				origin: ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ mailboxId: gmail.mailboxId }).toString(),
		});
		assert.equal(repeated.status, 303);
		assert.equal(trace.googleRevokes, 1);
	} finally {
		await mf.dispose();
	}
});

test("concurrent Web Gmail callbacks preserve the winning result", async () => {
	const trace = {};
	const mf = createWorker({ trace });
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const ownerCookie = await login(mf, "code-empty");

		const { state, flowCookie } = await startGmailFlow(mf, ownerCookie);
		const callbackUrl =
			ORIGIN + "/mail/oauth/gmail/callback?" +
			new URLSearchParams({ state, code: "synthetic-provider-code" });

		const [first, second] = await Promise.all([
			mf.dispatchFetch(callbackUrl, {
				redirect: "manual",
				headers: { cookie: ownerCookie + "; " + flowCookie },
			}),
			mf.dispatchFetch(callbackUrl, {
				redirect: "manual",
				headers: { cookie: ownerCookie + "; " + flowCookie },
			}),
		]);

		const locations = [first.headers.get("location"), second.headers.get("location")].sort();
		assert.deepEqual(locations, [
			"/account/mailboxes",
			"/account/mailboxes?notice=gmail_connected",
		]);
		assert.equal(trace.googleTokenExchanges, 1);
		assert.equal(trace.gmailProfiles, 1);
		const resultCookies = [first, second].flatMap((response) =>
			response.headers
				.getSetCookie()
				.filter((value) => value.startsWith("__Host-who_you_mail_oauth_result=")),
		);
		assert.equal(resultCookies.length, 1);

		const listed = await mf.dispatchFetch(ORIGIN + "/api/mailboxes", {
			headers: { cookie: ownerCookie },
		});
		assert.equal(listed.status, 200);
		assert.ok(
			(await listed.json()).mailboxes.some((entry) => entry.address === "linked@gmail.com"),
		);
	} finally {
		await mf.dispose();
	}
});

test("Web Gmail mutations fail closed on CSRF/auth and provider denial", async () => {
	const trace = {};
	const mf = createWorker({ trace });
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const cookie = await login(mf, "code-empty");

		const wrongOrigin = await mf.dispatchFetch(
			ORIGIN + "/account/mailboxes/gmail/link",
			{ method: "POST", headers: { cookie, origin: "https://evil.invalid" } },
		);
		assert.equal(wrongOrigin.status, 403);
		for (const path of [
			"/account/mailboxes/gmail/link",
			"/account/mailboxes/unlink",
			"/account/mailboxes/sync",
		]) {
			for (const origin of [undefined, "null", "https://evil.invalid"]) {
				const rejected = await mf.dispatchFetch(ORIGIN + path, {
					method: "POST", headers: origin === undefined ? { cookie } : { cookie, origin },
				});
				assert.equal(rejected.status, 403);
				assert.equal((await rejected.json()).error, "origin_not_allowed");
			}
		}
		assert.equal(trace.googleTokenExchanges ?? 0, 0);

		const suppliedBearer = await mf.dispatchFetch(
			ORIGIN + "/account/mailboxes/gmail/link",
			{
				method: "POST",
				headers: { cookie, origin: ORIGIN, authorization: "Bearer browser-supplied" },
			},
		);
		assert.equal(suppliedBearer.status, 400);

		const anonymous = await mf.dispatchFetch(
			ORIGIN + "/account/mailboxes/gmail/link",
			{ method: "POST", redirect: "manual", headers: { origin: ORIGIN } },
		);
		assert.equal(anonymous.status, 303);
		assert.equal(
			anonymous.headers.get("location"),
			"/?reason=sign_in_required&returnTo=%2Faccount%2Fmailboxes",
		);

		const anonymousSync = await mf.dispatchFetch(
			ORIGIN + "/account/mailboxes/sync",
			{
				method: "POST",
				redirect: "manual",
				headers: {
					origin: ORIGIN,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ mailboxId: "mbx_gmail" }).toString(),
			},
		);
		assert.equal(anonymousSync.status, 303);
		assert.equal(
			anonymousSync.headers.get("location"),
			"/?reason=sign_in_required&returnTo=%2Faccount%2Fmailboxes",
		);

		const { state, flowCookie } = await startGmailFlow(mf, cookie);
		const otherCookie = await login(mf, "code-other");
		const wrongSession = await mf.dispatchFetch(
			ORIGIN + "/mail/oauth/gmail/callback?" +
				new URLSearchParams({ state, code: "must-not-exchange" }),
			{
				redirect: "manual",
				headers: { cookie: otherCookie + "; " + flowCookie },
			},
		);
		assert.equal(wrongSession.status, 303);
		assert.equal(
			wrongSession.headers.get("location"),
			"/account/mailboxes?notice=gmail_link_failed",
		);
		assert.equal(trace.googleTokenExchanges ?? 0, 0);

		const replayAfterWrongSession = await mf.dispatchFetch(
			ORIGIN + "/mail/oauth/gmail/callback?" +
				new URLSearchParams({ state, code: "must-not-exchange" }),
			{ redirect: "manual" },
		);
		assert.equal(replayAfterWrongSession.status, 400);
		assert.deepEqual(await replayAfterWrongSession.json(), { error: "invalid_state" });
		assert.equal(trace.googleTokenExchanges ?? 0, 0);

		const {
			state: deniedState,
			flowCookie: deniedFlowCookie,
		} = await startGmailFlow(mf, cookie);
		const denied = await mf.dispatchFetch(
			ORIGIN + "/mail/oauth/gmail/callback?" +
				new URLSearchParams({ state: deniedState, error: "access_denied" }),
			{
				redirect: "manual",
				headers: { cookie: cookie + "; " + deniedFlowCookie },
			},
		);
		assert.equal(denied.status, 303);
		assert.equal(denied.headers.get("location"), "/account/mailboxes?notice=gmail_denied");
		assert.equal(trace.googleTokenExchanges ?? 0, 0);

		const replayAfterDenied = await mf.dispatchFetch(
			ORIGIN + "/mail/oauth/gmail/callback?" +
				new URLSearchParams({ state: deniedState, code: "must-not-exchange" }),
			{ redirect: "manual" },
		);
		assert.equal(replayAfterDenied.status, 400);
		assert.deepEqual(await replayAfterDenied.json(), { error: "invalid_state" });
		assert.equal(trace.googleTokenExchanges ?? 0, 0);

		const rawCallback = await mf.dispatchFetch(
			ORIGIN + "/mail/oauth/gmail/callback?error=access_denied",
		);
		assert.equal(rawCallback.status, 400);
		assert.deepEqual(await rawCallback.json(), { error: "provider_reauth_required" });
	} finally {
		await mf.dispose();
	}
});

test("Web Gmail link stays disabled when OAuth or credential vault is unavailable", async () => {
	const trace = {};
	const mf = createWorker({ gmailConfigured: false, trace });
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const cookie = await login(mf, "code-empty");
		const page = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {
			headers: { cookie },
		});
		const html = await page.text();
		assert.doesNotMatch(html, /action="\/account\/mailboxes\/gmail\/link"/);
		assert.match(html, /Gmail<\/strong> <span class="pill muted">尚未配置<\/span>/);

		const attempted = await mf.dispatchFetch(
			ORIGIN + "/account/mailboxes/gmail/link",
			{
				method: "POST",
				redirect: "manual",
				headers: { cookie, origin: ORIGIN },
			},
		);
		assert.equal(attempted.status, 303);
		assert.equal(
			attempted.headers.get("location"),
			"/account/mailboxes?notice=gmail_unavailable",
		);
		assert.equal(
			trace.legacyRequests ?? 0,
			0,
		);
	} finally {
		await mf.dispose();
	}
});
