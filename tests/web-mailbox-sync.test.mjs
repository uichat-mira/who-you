import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { URLSearchParams } from "node:url";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { MIGRATIONS } from "./workerd-harness.mjs";

/**
 * OPS-044: manual, single-batch Gmail sync from the mailbox page.
 *
 * The production Worker is exercised with its real Gmail client, credential
 * vault, D1/R2 bindings and Cloud Auth verifier. Only Google/Cloud Auth HTTP is
 * scripted. Every account, address, message and token below is synthetic.
 */

const ORIGIN = "https://127.0.0.1";
const MCP_ORIGIN = ORIGIN;
const AUTH = "https://cloud-auth.tomzlab.cn";
const TOKEN_URL = AUTH + "/v1/oauth/token";
const SESSION_URL = AUTH + "/v1/oauth/application-session";
const JWKS_URL = AUTH + "/.well-known/jwks.json";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_PROFILE_URL = GMAIL_API + "/profile";
const GMAIL_MESSAGES_URL = GMAIL_API + "/messages";
const GMAIL_HISTORY_URL = GMAIL_API + "/history";
const GMAIL_MESSAGES_PATH = new URL(GMAIL_MESSAGES_URL).pathname;
const SESSION_KEY = Buffer.alloc(32, 7).toString("base64url");

const SESSIONS = new Map([
	["mas_v1.fixture.owner", "account-sync-owner"],
	["mas_v1.fixture.syncother", "account-sync-other"],
]);
const CODES = new Map([
	["code-sync-owner", "mas_v1.fixture.owner"],
	["code-sync-other", "mas_v1.fixture.syncother"],
]);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = {
	...(await exportJWK(publicKey)),
	kid: "test-key",
	use: "sig",
	alg: "EdDSA",
};

const accessCredential = (accountId, scope = ["whoyou.read"], confirmation) =>
	new SignJWT({
		app_id: "app-fixture-instance", service_id: "mail", resource: ORIGIN + "/mcp",
		device_id: "web-device-" + accountId,
		scope,
		...(confirmation ? { confirmation } : {}),
	})
		.setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "test-key" })
		.setIssuer("mira:cloud-auth")
		.setAudience(ORIGIN + "/mcp")
		.setSubject(accountId)
		.setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000))
		.setExpirationTime("5m")
		.sign(privateKey);

const gmailScopes =
	"https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

const rawMessage = (index) =>
	[
		`From: Fixture Sender <sender${index}@example.net>`,
		"To: linked@gmail.com",
		`Subject: Batch message ${index}`,
		`Message-ID: <ops-044-${index}@example.net>`,
		"Date: Mon, 10 Nov 2025 10:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		`Fixture body ${index}.`,
		"",
	].join("\r\n");

const gmailMessage = (index) => ({
	id: `gmail-msg-${index}`,
	threadId: `gmail-thread-${index}`,
	internalDate: String(1_795_000_000_000 + index * 1000),
	raw: Buffer.from(rawMessage(index), "utf8").toString("base64url"),
});

const createOutbound = (trace = {}) => async (request) => {
	const url = new URL(request.url);

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
		const body = new URLSearchParams(await request.text());
		if (body.get("grant_type") === "authorization_code") {
			trace.googleCodeExchanges = (trace.googleCodeExchanges ?? 0) + 1;
			assert.equal(body.get("client_id"), "synthetic-client");
			assert.equal(body.get("client_secret"), "synthetic-secret");
			assert.equal(body.get("redirect_uri"), ORIGIN + "/mail/oauth/gmail/callback");
			return Response.json({
				access_token: "synthetic-access",
				refresh_token: "synthetic-refresh",
				token_type: "Bearer",
				expires_in: 3600,
				scope: gmailScopes,
			});
		}
		trace.googleRefreshes = (trace.googleRefreshes ?? 0) + 1;
		if (trace.refreshInvalidGrant) {
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		return Response.json({
			access_token: "synthetic-access",
			token_type: "Bearer",
			expires_in: 3600,
			scope: gmailScopes,
		});
	}

	if (request.url === GMAIL_PROFILE_URL) {
		assert.equal(request.headers.get("authorization"), "Bearer synthetic-access");
		trace.gmailProfiles = (trace.gmailProfiles ?? 0) + 1;
		return Response.json({ emailAddress: "linked@gmail.com", historyId: "777" });
	}

	if (url.origin + url.pathname === GMAIL_MESSAGES_URL) {
		trace.gmailListCalls = (trace.gmailListCalls ?? 0) + 1;
		const maxResults = Number(url.searchParams.get("maxResults"));
		assert.ok(maxResults > 0 && maxResults <= 20, "the batch ceiling is requested from Gmail");
		const start = Number(url.searchParams.get("pageToken") ?? "0");
		if (trace.gmailListEntered) trace.gmailListEntered();
		if (trace.gmailListGate) await trace.gmailListGate;
		const messages = trace.gmailMessages ?? [];
		const take = trace.ignoreMaxResults ? messages.length - start : maxResults;
		const page = messages.slice(start, start + take);
		const next = start + page.length < messages.length
			? String(start + page.length)
			: null;
		return Response.json({
			messages: page.map((message) => ({ id: message.id, threadId: message.threadId })),
			...(next ? { nextPageToken: next } : {}),
		});
	}

	if (url.origin + url.pathname === GMAIL_HISTORY_URL) {
		trace.gmailHistoryCalls = (trace.gmailHistoryCalls ?? 0) + 1;
		if (trace.gmailHistoryEntered) trace.gmailHistoryEntered();
		if (trace.gmailHistoryGate) await trace.gmailHistoryGate;
		const messages = trace.gmailMessages ?? [];
		return Response.json({
			historyId: "778",
			history: messages.map((message) => ({
				messagesAdded: [{ message: { id: message.id } }],
			})),
		});
	}

	if ((url.origin + url.pathname).startsWith(GMAIL_MESSAGES_URL + "/")) {
		const id = decodeURIComponent(url.pathname.slice(GMAIL_MESSAGES_PATH.length + 1));
		if (trace.failMessageId === id) return Response.json({ error: { code: 503 } }, { status: 503 });
		const message = (trace.gmailMessages ?? []).find((entry) => entry.id === id);
		if (!message) return Response.json({ error: { code: 404 } }, { status: 404 });
		assert.equal(url.searchParams.get("format"), "raw");
		return Response.json(message);
	}

	if (request.url === GOOGLE_REVOKE_URL) {
		trace.googleRevokes = (trace.googleRevokes ?? 0) + 1;
		if (trace.googleRevokeEntered) trace.googleRevokeEntered();
		if (trace.googleRevokeGate) await trace.googleRevokeGate;
		return new Response(null, { status: 200 });
	}

	return Response.json({ error: "unexpected_upstream", url: request.url }, { status: 404 });
};

function createWorker(trace = {}, options = {}) {
	return new Miniflare({
		modules: true,
		scriptPath: "dist/worker.mjs",
		compatibilityDate: "2026-08-06",
		cf: false,
		bindings: {
			WHOYOU_WEB_SESSION_KEY: SESSION_KEY,
			MCP_RESOURCE_URL: MCP_ORIGIN + "/mcp",
			CLOUD_AUTH_ISSUER: AUTH,
			CLOUD_AUTH_JWKS_URL: JWKS_URL,
			WHOYOU_APP_ID: "app-fixture-instance",
			WHOYOU_APP_SECRET: "fixture-registration-not-a-real-secret",
			WHOYOU_MANIFEST_REVISION: "1",
			MAIL_DOMAIN: "tomlab.cn",
			MAIL_CREDENTIAL_KEK: Buffer.alloc(32, 9).toString("base64"),
			GMAIL_OAUTH_CLIENT_ID: "synthetic-client",
			GMAIL_OAUTH_CLIENT_SECRET: "synthetic-secret",
			GMAIL_OAUTH_REDIRECT_URI: ORIGIN + "/mail/oauth/gmail/callback",
			...(options.bindings ?? {}),
		},
		d1Databases: ["DB"],
		r2Buckets: ["MAIL_BUCKET"],
		outboundService: createOutbound(trace),
		unsafeTriggerHandlers: options.unsafeTriggerHandlers ?? false,
		...(trace.logs
			? { handleStructuredLogs: (event) => { trace.logs.push(event.message); } }
			: {}),
	});
}

const cookies = (response) =>
	response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

async function login(mf, code) {
	const start = await mf.dispatchFetch(ORIGIN + "/auth/start", { redirect: "manual" });
	assert.equal(start.status, 303);
	const state = new URL(start.headers.get("location")).searchParams.get("state");
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

async function linkGmail(mf, cookie, expectedNotice = "gmail_connected") {
	const started = await mf.dispatchFetch(ORIGIN + "/account/mailboxes/gmail/link", {
		method: "POST",
		redirect: "manual",
		headers: { cookie, origin: ORIGIN },
	});
	assert.equal(started.status, 303, await started.text());
	const authorization = new URL(started.headers.get("location"));
	const state = authorization.searchParams.get("state");
	assert.ok(state);
	const callback = await mf.dispatchFetch(
		ORIGIN + "/mail/oauth/gmail/callback?" +
			new URLSearchParams({ state, code: "synthetic-provider-code" }),
		{ redirect: "manual", headers: { cookie: cookie + "; " + cookies(started) } },
	);
	assert.equal(callback.status, 303, await callback.text());
	assert.equal(callback.headers.get("location"), `/account/mailboxes?notice=${expectedNotice}`);
}

async function mailboxIdOf(db, accountId) {
	return db
		.prepare("SELECT id FROM mailboxes WHERE account_id = ? AND provider = 'gmail'")
		.bind(accountId)
		.first()
		.then((row) => row?.id);
}

async function sync(mf, cookie, mailboxId) {
	return mf.dispatchFetch(ORIGIN + "/account/mailboxes/sync", {
		method: "POST",
		redirect: "manual",
		headers: {
			cookie,
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ mailboxId }).toString(),
	});
}

/**
 * Dispatches the production five-minute scheduled event. Miniflare only exposes
 * the handler through this reserved path when `unsafeTriggerHandlers` is set.
 */
async function scheduledTick(mf) {
	return mf.dispatchFetch(
		"https://127.0.0.1/cdn-cgi/handler/scheduled?" +
			new URLSearchParams({ cron: "*/5 * * * *", format: "json" }),
	);
}

/** A non-Gmail identity must exist without ever being touched by the sweep. */
async function seedThirdPartyMailbox(db, input) {
	await db
		.prepare(
			`INSERT INTO mailboxes (
			 id, account_id, address, local_part, kind, provider, status,
			 quota_bytes, bytes_used, message_count, quarantine_count, created_at, updated_at
			 ) VALUES (?,?,?,?, 'third_party', ?, 'active', ?, 0, 0, 0, ?, ?)`,
		)
		.bind(
			input.id,
			input.accountId,
			input.address,
			input.localPart,
			input.provider,
			input.quotaBytes ?? 1024 * 1024,
			Date.now(),
			Date.now(),
		)
		.run();
}

async function mcpClient(mf, token) {
	const transport = new StreamableHTTPClientTransport(new URL(MCP_ORIGIN + "/mcp"), {
		requestInit: { headers: { authorization: `Bearer ${token}`, host: new URL(MCP_ORIGIN).host } },
		fetch: (input, init) =>
			mf.dispatchFetch(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				init,
			),
	});
	const client = new Client(
		{ name: "ops-044-test", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(transport);
	return client;
}

test("manual Gmail sync is bounded, account-scoped, deduped and readable through MCP", async () => {
	const trace = { gmailMessages: Array.from({ length: 25 }, (_, index) => gmailMessage(index)) };
	const mf = createWorker(trace);
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const ownerCookie = await login(mf, "code-sync-owner");
		await linkGmail(mf, ownerCookie);
		const mailboxId = await mailboxIdOf(db, "account-sync-owner");
		assert.ok(mailboxId);

		// 1) The first action imports exactly one 20-message page.
		const first = await sync(mf, ownerCookie, mailboxId);
		assert.equal(first.status, 303, await first.text());
		assert.equal(
			first.headers.get("location"),
			"/account/mailboxes?notice=gmail_sync_completed&imported=20&duplicates=0&skipped=0",
		);
		const countAfterFirst = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(countAfterFirst.total, 20);
		const stateAfterFirst = await db
			.prepare(
				`SELECT cursor, backfill_page, last_synced_at, last_error, lease_id, lease_expires_at
				 FROM mailbox_sync_state WHERE mailbox_id = ?`,
			)
			.bind(mailboxId)
			.first();
		assert.equal(stateAfterFirst.cursor, null, "the initial scan is not complete yet");
		assert.ok(stateAfterFirst.backfill_page, "the next page cursor is persisted");
		assert.ok(stateAfterFirst.last_synced_at);
		assert.equal(stateAfterFirst.last_error, null);
		assert.equal(stateAfterFirst.lease_id, null, "the lease is released after the batch");
		assert.equal(stateAfterFirst.lease_expires_at, null);

		const partialPage = await mf.dispatchFetch(
			ORIGIN + "/account/mailboxes?notice=gmail_sync_completed&imported=20&duplicates=0&skipped=0",
			{ headers: { cookie: ownerCookie } },
		);
		assert.equal(partialPage.status, 200);
		const partialHtml = await partialPage.text();
		assert.match(partialHtml, /本次 Gmail 同步批次已完成/);
		assert.match(partialHtml, /本次导入 20 封/);
		assert.match(partialHtml, /初始同步进行中/);
		assert.doesNotMatch(partialHtml, /action="\/account\/mailboxes\/sync"/);
		assert.doesNotMatch(partialHtml, /synthetic-access|synthetic-refresh/);
		assert.doesNotMatch(partialHtml, /account-sync-owner/);

		// 2) The second action continues from the persisted page and completes.
		const second = await sync(mf, ownerCookie, mailboxId);
		assert.equal(
			second.headers.get("location"),
			"/account/mailboxes?notice=gmail_sync_completed&imported=5&duplicates=0&skipped=0",
		);
		const afterSecond = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(afterSecond.total, 25);
		const completed = await db
			.prepare("SELECT cursor, backfill_page FROM mailbox_sync_state WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.ok(completed.cursor, "a successful bounded scan advances the cursor");
		assert.equal(completed.backfill_page, null);

		const completedPage = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {
			headers: { cookie: ownerCookie },
		});
		const completedHtml = await completedPage.text();
		assert.match(completedHtml, /同步成功/);
		assert.match(completedHtml, /最近同步时间/);

		// 3) Repeating the action never creates duplicate rows.
		const third = await sync(mf, ownerCookie, mailboxId);
		assert.equal(
			third.headers.get("location"),
			"/account/mailboxes?notice=gmail_sync_completed&imported=0&duplicates=20&skipped=0",
		);
		const afterThird = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(afterThird.total, 25);
		const remainingHistory = await sync(mf, ownerCookie, mailboxId);
		assert.match(remainingHistory.headers.get("location"), /imported=0&duplicates=5&skipped=0/);

		// 4) The existing read-only MCP surface reaches the synced third-party mail.
		const client = await mcpClient(mf, await accessCredential("account-sync-owner"));
		try {
			const search = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { query: "batch message" },
			});
			assert.equal(search.isError, undefined);
			const results = search.structuredContent.messages;
			assert.equal(results.length, 20);
			assert.ok(results.every((message) => message.direction === "inbound"));
			const firstResult = results[0];
			const message = await client.callTool({
				name: "whoyou_mail_message_get",
				arguments: { messageId: firstResult.id, include: "text" },
			});
			assert.equal(message.isError, undefined);
			assert.equal(message.structuredContent.untrusted, true);
			assert.equal(message.structuredContent.bodyKind, "text");
			assert.match(message.structuredContent.body, /Fixture body/);
		} finally {
			await client.close();
		}

		// 5) Another account cannot start a sync for this mailbox.
		const otherCookie = await login(mf, "code-sync-other");
		const listBefore = trace.gmailListCalls;
		const crossAccount = await sync(mf, otherCookie, mailboxId);
		assert.equal(crossAccount.status, 303);
		assert.equal(crossAccount.headers.get("location"), "/account/mailboxes?notice=gmail_sync_rejected");
		assert.equal(trace.gmailListCalls, listBefore, "no provider call for a foreign mailbox");
		const stillThere = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(stillThere.total, 25);

		// 6) A concurrent second request fails safely instead of re-entering.
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		let entered;
		const enteredPromise = new Promise((resolve) => { entered = resolve; });
		trace.gmailHistoryGate = gate;
		trace.gmailHistoryEntered = entered;
		const running = sync(mf, ownerCookie, mailboxId);
		await Promise.race([
			enteredPromise,
			delay(5000).then(() => {
				throw new Error("sync never started");
			}),
		]);
		const runningPage = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {
			headers: { cookie: ownerCookie },
		});
		assert.match(await runningPage.text(), /同步进行中/);
		const duplicate = await sync(mf, ownerCookie, mailboxId);
		assert.equal(duplicate.status, 303);
		assert.equal(duplicate.headers.get("location"), "/account/mailboxes?notice=gmail_sync_busy");
		release();
		const finished = await running;
		assert.equal(finished.status, 303);
		assert.match(finished.headers.get("location"), /notice=gmail_sync_completed/);
		trace.gmailHistoryGate = null;
		const afterConcurrent = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(afterConcurrent.total, 25);

		// 7) A revoked authorization fails with a fixed code and never says success.
		trace.refreshInvalidGrant = true;
		const revoked = await sync(mf, ownerCookie, mailboxId);
		assert.equal(revoked.status, 303);
		assert.equal(revoked.headers.get("location"), "/account/mailboxes?notice=gmail_sync_reauth");
		const credential = await db
			.prepare("SELECT status FROM provider_credentials WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(credential.status, "reauth_required");
		const failedState = await db
			.prepare("SELECT last_error FROM mailbox_sync_state WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(failedState.last_error, "provider_reauth_required");
		const revokedPage = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {
			headers: { cookie: ownerCookie },
		});
		const revokedHtml = await revokedPage.text();
		assert.match(revokedHtml, /需要重新授权/);
		assert.doesNotMatch(revokedHtml, /action="\/account\/mailboxes\/sync"/);
		assert.doesNotMatch(revokedHtml, /synthetic-access|synthetic-refresh|synthetic-provider-code/);
	} finally {
		await mf.dispose();
	}
});

test("a provider that over-returns still cannot exceed the 20-message batch ceiling", async () => {
	const trace = {
		gmailMessages: Array.from({ length: 25 }, (_, index) => gmailMessage(index)),
		ignoreMaxResults: true,
	};
	const mf = createWorker(trace);
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const ownerCookie = await login(mf, "code-sync-owner");
		await linkGmail(mf, ownerCookie);
		const mailboxId = await mailboxIdOf(db, "account-sync-owner");

		const response = await sync(mf, ownerCookie, mailboxId);
		assert.equal(response.status, 303);
		assert.equal(
			response.headers.get("location"),
			"/account/mailboxes?notice=gmail_sync_completed&imported=20&duplicates=0&skipped=0",
		);
		const count = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(count.total, 20, "the local batch ceiling wins over the provider listing");

		const second = await sync(mf, ownerCookie, mailboxId);
		assert.match(second.headers.get("location"), /imported=5&duplicates=0&skipped=0/);
		const total = () => db.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?").bind(mailboxId).first().then((row) => row.total);
		assert.equal(await total(), 25, "over-returned backfill IDs are not lost");

		trace.gmailMessages = Array.from({ length: 25 }, (_, index) => gmailMessage(index + 25));
		const third = await sync(mf, ownerCookie, mailboxId);
		assert.match(third.headers.get("location"), /imported=20&duplicates=0&skipped=0/);
		assert.equal(await total(), 45);
		const beforeFailure = await db.prepare("SELECT cursor, last_synced_at FROM mailbox_sync_state WHERE mailbox_id = ?").bind(mailboxId).first();
		assert.equal(JSON.parse(beforeFailure.cursor).pendingIds.length, 5);
		trace.failMessageId = trace.gmailMessages[20].id;
		const failed = await sync(mf, ownerCookie, mailboxId);
		assert.equal(failed.headers.get("location"), "/account/mailboxes?notice=gmail_sync_failed");
		assert.deepEqual(await db.prepare("SELECT cursor, last_synced_at FROM mailbox_sync_state WHERE mailbox_id = ?").bind(mailboxId).first(), beforeFailure);
		trace.failMessageId = null;
		const retried = await sync(mf, ownerCookie, mailboxId);
		assert.match(retried.headers.get("location"), /imported=5&duplicates=0&skipped=0/);
		assert.equal(await total(), 50, "history page has no dropped IDs");
	} finally {
		await mf.dispose();
	}
});

test("outstanding Gmail ownership excludes unlink and expiry takeover; retry deletes all objects", async () => {
	const trace = {
		gmailMessages: Array.from({ length: 5 }, (_, index) => gmailMessage(index)),
	};
	const mf = createWorker(trace);
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const ownerCookie = await login(mf, "code-sync-owner");
		await linkGmail(mf, ownerCookie);
		const mailboxId = await mailboxIdOf(db, "account-sync-owner");

		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		let entered;
		const enteredPromise = new Promise((resolve) => { entered = resolve; });
		trace.gmailListGate = gate;
		trace.gmailListEntered = entered;
		const running = sync(mf, ownerCookie, mailboxId);
		await Promise.race([
			enteredPromise,
			delay(5000).then(() => {
				throw new Error("sync never started");
			}),
		]);

		// Advance the diagnostic timestamp while the original provider request
		// remains in flight. Never let a successor replace its ownership.
		const held = await db.prepare("SELECT lease_id FROM mailbox_sync_state WHERE mailbox_id = ?").bind(mailboxId).first();
		assert.ok(held.lease_id);
		await db.prepare("UPDATE mailbox_sync_state SET lease_expires_at = ? WHERE mailbox_id = ?")
			.bind(Date.now() - 1, mailboxId).run();
		const recoveryPage = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", { headers: { cookie: ownerCookie } });
		assert.match(await recoveryPage.text(), /同步待恢复/);
		const successor = await sync(mf, ownerCookie, mailboxId);
		assert.equal(successor.headers.get("location"), "/account/mailboxes?notice=gmail_sync_busy");
		const after = await db.prepare("SELECT lease_id FROM mailbox_sync_state WHERE mailbox_id = ?").bind(mailboxId).first();
		assert.equal(after.lease_id, held.lease_id, "elapsed time is not evidence that the writer stopped");
		const beforeRelink = await db.prepare("SELECT cursor, last_synced_at, lease_id FROM mailbox_sync_state WHERE mailbox_id = ?").bind(mailboxId).first();
		await linkGmail(mf, ownerCookie, "gmail_link_failed");
		assert.deepEqual(await db.prepare("SELECT cursor, last_synced_at, lease_id FROM mailbox_sync_state WHERE mailbox_id = ?").bind(mailboxId).first(), beforeRelink);


		const requestUnlink = () => mf.dispatchFetch(ORIGIN + "/account/mailboxes/unlink", {
			method: "POST",
			redirect: "manual",
			headers: {
				cookie: ownerCookie,
				origin: ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ mailboxId }).toString(),
		});
		const unlink = await requestUnlink();
		assert.equal(unlink.status, 303, await unlink.text());
		assert.equal(unlink.headers.get("location"), "/account/mailboxes?notice=gmail_unlink_busy");
		assert.ok(await db.prepare("SELECT id FROM mailboxes WHERE id = ?").bind(mailboxId).first(), "busy unlink does not remove identity");
		assert.ok(await db.prepare("SELECT id FROM provider_credentials WHERE mailbox_id = ?").bind(mailboxId).first(), "busy unlink does not revoke credentials");

		release();
		const finished = await running;
		assert.equal(finished.status, 303);
		assert.match(finished.headers.get("location"), /notice=gmail_sync_completed/);
		const bucket = await mf.getR2Bucket("MAIL_BUCKET");
		// Model an interrupted R2 write with no D1 row. Successful unlink must
		// erase the entire owned namespace, not only keys found in D1.
		await bucket.put(`accounts/account-sync-owner/mailboxes/${mailboxId}/messages/orphan/raw.eml`, "fixture");
		await bucket.put("accounts/other-account/mailboxes/other-mailbox/messages/keep/raw.eml", "other fixture");
		// A prior unlink may have stopped after revocation or partial object cleanup.
		// Even without an owner, the durable intent blocks new sync.
		await db.prepare("UPDATE mailbox_sync_state SET last_error = 'unlink_pending' WHERE mailbox_id = ?").bind(mailboxId).run();
		const blocked = await sync(mf, ownerCookie, mailboxId);
		assert.equal(blocked.headers.get("location"), "/account/mailboxes?notice=gmail_sync_failed");
		const pending = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", { headers: { cookie: ownerCookie } });
		assert.match(await pending.text(), /解绑未完成/);
		let finishRevoke;
		trace.googleRevokeGate = new Promise((resolve) => { finishRevoke = resolve; });
		const revokeEntered = new Promise((resolve) => { trace.googleRevokeEntered = resolve; });
		const finishingUnlink = requestUnlink();
		try {
			await Promise.race([revokeEntered, delay(5000).then(() => { throw new Error("unlink never reached revocation"); })]);
			const refreshes = trace.googleRefreshes;
			const duringUnlink = await sync(mf, ownerCookie, mailboxId);
			assert.equal(duringUnlink.headers.get("location"), "/account/mailboxes?notice=gmail_sync_busy");
			assert.equal(trace.googleRefreshes, refreshes, "unlink prevents provider access");
			await linkGmail(mf, ownerCookie, "gmail_link_failed");
		} finally {
			finishRevoke();
		}
		const retried = await finishingUnlink;
		assert.equal(retried.headers.get("location"), "/account/mailboxes?notice=gmail_unlinked");
		assert.ok(await bucket.head("accounts/other-account/mailboxes/other-mailbox/messages/keep/raw.eml"));
		const stale = await sync(mf, ownerCookie, mailboxId);
		assert.equal(stale.headers.get("location"), "/account/mailboxes?notice=gmail_sync_rejected");


		for (const table of ["messages", "threads", "provider_credentials", "mailbox_sync_state"]) {
			const row = await db
				.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE mailbox_id = ?`)
				.bind(mailboxId)
				.first();
			assert.equal(row.total, 0, `${table} must not be resurrected after unlink`);
		}
		const mailbox = await db
			.prepare("SELECT COUNT(*) AS total FROM mailboxes WHERE id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(mailbox.total, 0);
		const objects = await bucket.list({
			prefix: `accounts/account-sync-owner/mailboxes/${mailboxId}/`,
		});
		assert.equal(objects.objects.length, 0, "in-flight R2 objects are cleaned up");
	} finally {
		await mf.dispose();
	}
});

test("manual sync requires a write credential and refuses read-only callers", async () => {
	const trace = { gmailMessages: [gmailMessage(0)] };
	const mf = createWorker(trace);
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const ownerCookie = await login(mf, "code-sync-owner");
		await linkGmail(mf, ownerCookie);
		const mailboxId = await mailboxIdOf(db, "account-sync-owner");

		const readOnly = await mcpClient(mf, await accessCredential("account-sync-owner"));
		try {
			const denied = await readOnly.callTool({
				name: "whoyou_mailbox_sync",
				arguments: { mailboxId },
			});
			assert.equal(denied.structuredContent.error, "insufficient_scope");
			const foreign = await readOnly.callTool({
				name: "whoyou_mailbox_sync",
				arguments: { mailboxId: "mbx_not_this_account" },
			});
			assert.equal(foreign.structuredContent.error, "insufficient_scope");
			assert.equal(trace.googleRefreshes ?? 0, 0, "no credential is used without write scope");
		} finally {
			await readOnly.close();
		}

		// This application declares only read scope; even a valid signature
        // carrying an undeclared write scope must not reach the service.
        await assert.rejects(mcpClient(mf,
          await accessCredential("account-sync-owner", ["whoyou.read", "whoyou.mail.write"])));
        assert.equal(trace.googleRefreshes ?? 0, 0);
	} finally {
		await mf.dispose();
	}
});

async function requestUnlinkFor(mf, cookie, mailboxId) {
	return mf.dispatchFetch(ORIGIN + "/account/mailboxes/unlink", {
		method: "POST",
		redirect: "manual",
		headers: {
			cookie,
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ mailboxId }).toString(),
	});
}

const scheduledLogLines = (trace) =>
	trace.logs.filter((line) => line.includes("whoyou_mail_scheduled_sync"));

test("the scheduled tick is closed by default and never polls an unverified provider", async () => {
	const trace = {
		gmailMessages: [gmailMessage(0)],
		logs: [],
	};
	const mf = createWorker(trace, { unsafeTriggerHandlers: true });
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const ownerCookie = await login(mf, "code-sync-owner");
		await linkGmail(mf, ownerCookie);
		const mailboxId = await mailboxIdOf(db, "account-sync-owner");
		await seedThirdPartyMailbox(db, {
			id: "mbx_ms_scheduled",
			accountId: "account-sync-owner",
			address: "linked-outlook@example.net",
			localPart: "linked-outlook",
			provider: "microsoft",
		});
		await seedThirdPartyMailbox(db, {
			id: "mbx_imap_scheduled",
			accountId: "account-sync-owner",
			address: "linked-imap@example.net",
			localPart: "linked-imap",
			provider: "imap_smtp",
		});

		const refreshesBefore = trace.googleRefreshes ?? 0;
		const listsBefore = trace.gmailListCalls ?? 0;
		const tick = await scheduledTick(mf);
		assert.equal(tick.status, 200);

		// No provider was contacted, even though two more identities are linked.
		assert.equal(trace.googleRefreshes ?? 0, refreshesBefore);
		assert.equal(trace.gmailListCalls ?? 0, listsBefore);
		const count = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(count.total, 0);
		for (const id of [mailboxId, "mbx_ms_scheduled", "mbx_imap_scheduled"]) {
			const state = await db
				.prepare(
					`SELECT last_synced_at, lease_id FROM mailbox_sync_state WHERE mailbox_id = ?`,
				)
				.bind(id)
				.first();
			if (id === mailboxId) {
				// Linking creates the row; a closed schedule must not advance it.
				assert.ok(state, "the linked Gmail row exists");
				assert.equal(state.last_synced_at, null);
				assert.equal(state.lease_id, null);
			} else {
				assert.equal(state, null, `${id} was not claimed by any sweep`);
			}
		}

		const aggregate = JSON.parse(scheduledLogLines(trace).at(-1));
		assert.deepEqual(aggregate.enabledProviders, []);
		assert.equal(aggregate.identities, 0);
		assert.equal(aggregate.imported, 0);
		assert.equal(aggregate.failed, 0);
		assert.equal(aggregate.skipped, 0);
		assert.equal(aggregate.lastSyncedAt, null);
		const logs = trace.logs.join("\n");
		assert.doesNotMatch(logs, /linked@gmail\.com|linked-outlook@|linked-imap@/);
		assert.doesNotMatch(logs, /synthetic-access|synthetic-refresh|Batch message|Fixture body/);
	} finally {
		await mf.dispose();
	}
});

test("the five-minute tick auto-syncs Gmail only, stays bounded and stays readable through MCP", async () => {
	const trace = {
		gmailMessages: Array.from({ length: 25 }, (_, index) => gmailMessage(index)),
		logs: [],
	};
	const mf = createWorker(trace, {
		unsafeTriggerHandlers: true,
		bindings: { MAIL_SCHEDULE_SYNC_PROVIDERS: "gmail" },
	});
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		const ownerCookie = await login(mf, "code-sync-owner");
		await linkGmail(mf, ownerCookie);
		const mailboxId = await mailboxIdOf(db, "account-sync-owner");
		assert.ok(mailboxId);
		const totalMessages = () =>
			db
				.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
				.bind(mailboxId)
				.first()
				.then((row) => row.total);

		const client = await mcpClient(mf, await accessCredential("account-sync-owner"));
		try {
			// Before any tick the read-only surface must not imply an empty mailbox.
			const before = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { query: "batch message" },
			});
			assert.equal(before.structuredContent.messages.length, 0);
			assert.equal(before.structuredContent.coverage.partial, true);
			const beforeCoverage = before.structuredContent.coverage.mailboxes.find(
				(entry) => entry.mailboxId === mailboxId,
			);
			assert.equal(beforeCoverage.initialImportComplete, false);
			assert.match(before.content[0].text, /coverage is partial/);
			assert.match(before.content[0].text, /does not prove/);

			// Hold the first tick inside the provider call to prove mutual exclusion.
			let release;
			const gate = new Promise((resolve) => { release = resolve; });
			let entered;
			const enteredPromise = new Promise((resolve) => { entered = resolve; });
			trace.gmailListGate = gate;
			trace.gmailListEntered = entered;
			const firstTick = scheduledTick(mf);
			await Promise.race([
				enteredPromise,
				delay(5000).then(() => {
					throw new Error("scheduled tick never reached Gmail");
				}),
			]);

			// Manual sync and unlink share the same owner and refuse while Cron runs.
			const manual = await sync(mf, ownerCookie, mailboxId);
			assert.equal(manual.headers.get("location"), "/account/mailboxes?notice=gmail_sync_busy");
			const unlink = await requestUnlinkFor(mf, ownerCookie, mailboxId);
			assert.equal(unlink.headers.get("location"), "/account/mailboxes?notice=gmail_unlink_busy");
			assert.ok(
				await db.prepare("SELECT id FROM mailboxes WHERE id = ?").bind(mailboxId).first(),
				"a busy unlink does not remove the identity",
			);

			// A second tick while the first is in flight is skipped, not duplicated.
			const skippedTick = await scheduledTick(mf);
			assert.equal(skippedTick.status, 200);
			const skippedLog = JSON.parse(scheduledLogLines(trace).at(-1));
			assert.equal(skippedLog.identities, 1);
			assert.equal(skippedLog.imported, 0);
			assert.equal(skippedLog.failed, 0);
			assert.equal(skippedLog.skipped, 1);

			release();
			assert.equal((await firstTick).status, 200);
			trace.gmailListGate = null;
			assert.equal(await totalMessages(), 20, "one tick imports at most 20 messages");
			const partial = await db
				.prepare(
					`SELECT cursor, backfill_page, last_synced_at, last_error, lease_id
					 FROM mailbox_sync_state WHERE mailbox_id = ?`,
				)
				.bind(mailboxId)
				.first();
			assert.equal(partial.cursor, null);
			assert.ok(partial.backfill_page, "the next page survives the tick");
			assert.ok(partial.last_synced_at);
			assert.equal(partial.last_error, null);
			assert.equal(partial.lease_id, null, "the cron releases its lease after the batch");

			// A partial backfill is reported as partial coverage, not as a full mailbox.
			const mid = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { query: "batch message" },
			});
			assert.equal(mid.structuredContent.coverage.partial, true);
			const midCoverage = mid.structuredContent.coverage.mailboxes.find(
				(entry) => entry.mailboxId === mailboxId,
			);
			assert.equal(midCoverage.initialImportComplete, false);
			assert.ok(midCoverage.lastSyncedAt);

			// The next tick resumes naturally from the persisted page.
			assert.equal((await scheduledTick(mf)).status, 200);
			assert.equal(await totalMessages(), 25);
			const complete = await db
				.prepare("SELECT cursor, backfill_page FROM mailbox_sync_state WHERE mailbox_id = ?")
				.bind(mailboxId)
				.first();
			assert.ok(complete.cursor, "a completed backfill hands over to the cursor");
			assert.equal(complete.backfill_page, null);

			// Re-running the same provider page never duplicates a Message-ID row.
			assert.equal((await scheduledTick(mf)).status, 200);
			assert.equal(await totalMessages(), 25);
			const distinct = await db
				.prepare(
					"SELECT COUNT(DISTINCT internet_message_id) AS total FROM messages WHERE mailbox_id = ?",
				)
				.bind(mailboxId)
				.first();
			assert.equal(distinct.total, 25, "each Message-ID is stored once");

			// Newest first metadata and the stored body are available without a manual sync.
			const after = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { query: "batch message", limit: 5 },
			});
			const results = after.structuredContent.messages;
			assert.equal(results.length, 5);
			const timestamps = results.map((message) => message.receivedAt);
			assert.deepEqual([...timestamps].sort((left, right) => right - left), timestamps);
			assert.match(String(results[0].subject), /Batch message/);
			assert.equal(after.structuredContent.coverage.partial, false);
			const latestCoverage = after.structuredContent.coverage.mailboxes.find(
				(entry) => entry.mailboxId === mailboxId,
			);
			assert.equal(latestCoverage.initialImportComplete, true);
			assert.ok(latestCoverage.lastSyncedAt);
			const body = await client.callTool({
				name: "whoyou_mail_message_get",
				arguments: { messageId: results[0].id, include: "text" },
			});
			assert.equal(body.isError, undefined);
			assert.match(body.structuredContent.body, /Fixture body/);

			const noMatch = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { query: "zzz-no-such-message" },
			});
			assert.equal(noMatch.structuredContent.messages.length, 0);
			assert.match(noMatch.content[0].text, /currently synced mail/);

			// Linking unverified providers must not make the Gmail tick poll them.
			await seedThirdPartyMailbox(db, {
				id: "mbx_ms_scheduled",
				accountId: "account-sync-owner",
				address: "linked-outlook@example.net",
				localPart: "linked-outlook",
				provider: "microsoft",
			});
			await seedThirdPartyMailbox(db, {
				id: "mbx_imap_scheduled",
				accountId: "account-sync-owner",
				address: "linked-imap@example.net",
				localPart: "linked-imap",
				provider: "imap_smtp",
			});
			assert.equal((await scheduledTick(mf)).status, 200);
			assert.equal(await totalMessages(), 25);
			const afterIsolation = await db
				.prepare("SELECT last_synced_at, last_error FROM mailbox_sync_state WHERE mailbox_id = ?")
				.bind(mailboxId)
				.first();
			assert.ok(afterIsolation.last_synced_at);
			assert.equal(afterIsolation.last_error, null);
			for (const id of ["mbx_ms_scheduled", "mbx_imap_scheduled"]) {
				const state = await db
					.prepare("SELECT COUNT(*) AS total FROM mailbox_sync_state WHERE mailbox_id = ?")
					.bind(id)
					.first();
				assert.equal(state.total, 0, `${id} is never claimed by the Gmail-only tick`);
			}

			// A revoked grant is reported as a fixed error, never as a successful tick.
			trace.refreshInvalidGrant = true;
			assert.equal((await scheduledTick(mf)).status, 200);
			assert.equal(await totalMessages(), 25);
			const revoked = await db
				.prepare(
					`SELECT s.last_error AS sync_error, c.status AS credential_status
					 FROM mailbox_sync_state s
					 JOIN provider_credentials c ON c.mailbox_id = s.mailbox_id
					 WHERE s.mailbox_id = ?`,
				)
				.bind(mailboxId)
				.first();
			assert.equal(revoked.sync_error, "provider_reauth_required");
			assert.equal(revoked.credential_status, "reauth_required");
			const revokedLog = JSON.parse(scheduledLogLines(trace).at(-1));
			assert.equal(revokedLog.failed, 1);
			assert.equal(revokedLog.imported, 0);
			const revokedSearch = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { query: "batch message" },
			});
			assert.equal(revokedSearch.structuredContent.coverage.partial, true);
			const revokedCoverage = revokedSearch.structuredContent.coverage.mailboxes.find(
				(entry) => entry.mailboxId === mailboxId,
			);
			assert.equal(revokedCoverage.lastError, "provider_reauth_required");
			assert.match(revokedSearch.content[0].text, /last error: provider_reauth_required/);

			const syncMetrics = trace.logs.filter((line) => line.includes('"event":"whoyou_mail_sync"'));
			assert.ok(syncMetrics.length > 0);
			for (const metric of syncMetrics) {
				assert.doesNotMatch(metric, /accountId|mailboxId|account-sync-owner|mbx_ms_scheduled/);
			}
			const logs = trace.logs.join("\n");
			assert.doesNotMatch(logs, /linked@gmail\.com|linked-outlook@|linked-imap@/);
			assert.doesNotMatch(logs, /synthetic-access|synthetic-refresh|Batch message|Fixture body/);
		} finally {
			await client.close();
		}
	} finally {
		await mf.dispose();
	}
});
