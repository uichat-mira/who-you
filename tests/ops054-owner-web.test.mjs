import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "./workerd-harness.mjs";

/**
 * OPS-054 contract tests: a deployment-local Owner is a separate principal from
 * a Mira ID account. Every address, app id and credential below is synthetic.
 */

const ORIGIN = "https://who-you.tomz.io";
const AUTH = "https://cloud-auth.tomzlab.cn";
const SESSION_KEY = Buffer.alloc(32, 7).toString("base64url");
const INITIAL_PASSWORD = "synthetic-owner-initial-password-2026";
const NEW_PASSWORD = "synthetic-owner-rotated-password-2026";
const FINAL_PASSWORD = "synthetic-owner-final-password-2026";
const OWNER_ACCOUNT = "local-owner:app-fixture-instance";
const APP_SECRET = "fixture-registration-not-a-real-secret";
const TOKEN_URL = AUTH + "/v1/oauth/token";
const SESSION_URL = AUTH + "/v1/oauth/application-session";
const MIRA_SUBJECT = "account-e2e";

const CODES = new Map([["code-e2e", "mas_v1.fixture.e2e"]]);
const TOKENS = new Map([["mas_v1.fixture.e2e", MIRA_SUBJECT]]);

function createOutbound(trace = {}) {
	return async (request) => {
		if (request.url === TOKEN_URL) {
			const form = new URLSearchParams(await request.text());
			const token = CODES.get(form.get("code"));
			if (!token) return Response.json({ error: "invalid_grant" }, { status: 400 });
			const identity = {
				issuer: "mira:cloud-auth",
				subject: TOKENS.get(token),
				appId: "app-fixture-instance",
				audience: ORIGIN + "/oauth-client",
				expiresAt: new Date(Date.now() + 1800_000).toISOString(),
			};
			trace.sessions ??= new Map();
			trace.sessions.set(token, identity);
			return Response.json({
				access_token: token,
				token_type: "Bearer",
				expires_in: 1800,
				...identity,
			});
		}
		if (request.url === SESSION_URL) {
			const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
			const identity = trace.sessions?.get(token);
			return identity
				? Response.json(identity)
				: Response.json({ error: "invalid_token" }, { status: 401 });
		}
		if (request.url === SESSION_URL + "/logout" && request.method === "POST") {
			const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
			if (!trace.sessions?.delete(token)) return new Response(null, { status: 401 });
			return new Response(null, { status: 204 });
		}
		return Response.json({ error: "unexpected_upstream", url: request.url }, { status: 404 });
	};
}

async function withWorker(run, overrides = {}) {
	const mf = new Miniflare({
		modules: true,
		scriptPath: "dist/worker.mjs",
		compatibilityDate: "2026-08-06",
		cf: false,
		bindings: {
			WHOYOU_WEB_SESSION_KEY: SESSION_KEY,
			MCP_RESOURCE_URL: ORIGIN + "/mcp",
			CLOUD_AUTH_ISSUER: AUTH,
			CLOUD_AUTH_JWKS_URL: AUTH + "/.well-known/jwks.json",
			WHOYOU_APP_ID: "app-fixture-instance",
			WHOYOU_APP_SECRET: APP_SECRET,
			WHOYOU_MANIFEST_REVISION: "1",
			WHOYOU_OWNER_INITIAL_PASSWORD: INITIAL_PASSWORD,
			MAIL_DOMAIN: "tomlab.cn",
			MAIL_CREDENTIAL_KEK: Buffer.alloc(32, 9).toString("base64"),
			...overrides,
		},
		d1Databases: ["DB"],
		r2Buckets: ["MAIL_BUCKET"],
		outboundService: createOutbound(),
	});
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
		await run({ mf, db });
	} finally {
		await mf.dispose();
	}
}

const cookies = (response) =>
	response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

function cookieValue(response, name) {
	const entry = response.headers.getSetCookie()
		.find((value) => value.startsWith(name + "="));
	return entry ? entry.split(";")[0] : null;
}

function loginOwner(mf, password, options = {}) {
	return mf.dispatchFetch(ORIGIN + "/auth/owner/login?" +
		new URLSearchParams({ returnTo: options.returnTo ?? "/account" }), {
		method: "POST",
		redirect: "manual",
		headers: {
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
			...(options.cookie ? { cookie: options.cookie } : {}),
		},
		body: new URLSearchParams({
			username: options.username ?? "admin",
			password,
			...(options.extra ?? {}),
		}).toString(),
	});
}

function changeOwnerPassword(mf, cookie, current, next, confirm = next) {
	return mf.dispatchFetch(ORIGIN + "/account/applications/password", {
		method: "POST",
		redirect: "manual",
		headers: {
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
			cookie,
		},
		body: new URLSearchParams({
			currentPassword: current,
			newPassword: next,
			confirmPassword: confirm,
		}).toString(),
	});
}

async function loginMira(mf) {
	const start = await mf.dispatchFetch(ORIGIN + "/auth/start", { redirect: "manual" });
	assert.equal(start.status, 303);
	const state = new URL(start.headers.get("location")).searchParams.get("state");
	const callback = await mf.dispatchFetch(
		ORIGIN + "/auth/callback?" + new URLSearchParams({ state, code: "code-e2e" }),
		{ redirect: "manual", headers: { cookie: cookies(start) } },
	);
	assert.equal(callback.status, 303, await callback.text());
	const cookie = cookieValue(callback, "__Host-who_you_session");
	assert.ok(cookie);
	return cookie;
}

async function bootstrapOwner(mf) {
	const login = await loginOwner(mf, INITIAL_PASSWORD);
	assert.equal(login.status, 303, await login.text());
	assert.equal(login.headers.get("location"), "/account/applications");
	const pending = cookieValue(login, "__Host-who_you_owner_session");
	assert.ok(pending);
	const changed = await changeOwnerPassword(mf, pending, INITIAL_PASSWORD, NEW_PASSWORD);
	assert.equal(changed.status, 303, await changed.text());
	const active = cookieValue(changed, "__Host-who_you_owner_session");
	assert.ok(active);
	assert.notEqual(active, pending);
	return { pending, active };
}

async function seedMailbox(db, input) {
	await db.prepare(
		`INSERT INTO mailboxes (
		 id, account_id, address, local_part, kind, provider, status, quota_bytes,
		 bytes_used, message_count, quarantine_count, created_at, updated_at
		 ) VALUES (?,?,?,?,'own_domain',NULL,'active',?,0,0,0,?,?)`,
	).bind(
		input.id,
		input.accountId,
		input.address,
		input.localPart,
		1024 * 1024,
		1_795_000_000_000,
		1_795_000_000_000,
	).run();
}

test("Owner first login is password-change gated and rotates credentials and sessions", async () => {
	await withWorker(async ({ mf, db }) => {
		const home = await mf.dispatchFetch(ORIGIN + "/");
		assert.equal(home.status, 200);
		const homeBody = await home.text();
		assert.match(homeBody, /实例 Owner 登录/);
		assert.match(homeBody, /name="username" value="admin"/);
		assert.ok(!homeBody.includes(INITIAL_PASSWORD));
		assert.doesNotMatch(homeBody, /name="appSecret"|APP Secret/);

		const initial = await loginOwner(mf, INITIAL_PASSWORD,
			{ returnTo: "/account/mailboxes" });
		assert.equal(initial.status, 303, await initial.text());
		assert.equal(initial.headers.get("location"), "/account/applications");
		const pending = cookieValue(initial, "__Host-who_you_owner_session");
		assert.ok(pending);
		assert.match(pending, /__Host-who_you_owner_session=/);
		const setCookies = initial.headers.getSetCookie();
		const ownerCookieHeader = setCookies
			.find((value) => value.startsWith("__Host-who_you_owner_session="));
		assert.match(ownerCookieHeader, /HttpOnly/);
		assert.match(ownerCookieHeader, /Secure/);
		assert.match(ownerCookieHeader, /SameSite=Lax/);

		for (const path of ["/account", "/account/mailboxes"]) {
			const gated = await mf.dispatchFetch(ORIGIN + path,
				{ redirect: "manual", headers: { cookie: pending } });
			assert.equal(gated.status, 303);
			assert.equal(gated.headers.get("location"), "/account/applications");
		}
		const api = await mf.dispatchFetch(ORIGIN + "/api/whoami", { headers: { cookie: pending } });
		assert.equal(api.status, 403);
		assert.deepEqual(await api.json(), { error: "password_change_required" });

		const applications = await mf.dispatchFetch(ORIGIN + "/account/applications",
			{ headers: { cookie: pending } });
		assert.equal(applications.status, 200);
		const applicationsBody = await applications.text();
		assert.match(applicationsBody, /首次登录需要修改初始密码/);
		assert.match(applicationsBody, /固定为 <code>admin<\/code>/);
		assert.ok(applicationsBody.includes(OWNER_ACCOUNT));
		assert.match(applicationsBody, /action="\/account\/applications\/password"/);
		assert.match(applicationsBody, /APP Secret/);
		assert.ok(!applicationsBody.includes(APP_SECRET));
		assert.ok(!applicationsBody.includes(INITIAL_PASSWORD));
		assert.doesNotMatch(applicationsBody, /name="appSecret"|rotateSecret|WHOYOU_APP_SECRET/);

		const wrongCurrent = await changeOwnerPassword(mf, pending, "wrong-current-password", NEW_PASSWORD);
		assert.equal(wrongCurrent.status, 400);
		assert.ok(!await wrongCurrent.text().then((body) => body.includes(NEW_PASSWORD)));

		const weak = await changeOwnerPassword(mf, pending, INITIAL_PASSWORD, "short");
		assert.equal(weak.status, 400);
		const mismatch = await changeOwnerPassword(mf, pending, INITIAL_PASSWORD, NEW_PASSWORD, "different-password");
		assert.equal(mismatch.status, 400);
		const unchanged = await loginOwner(mf, INITIAL_PASSWORD);
		assert.equal(unchanged.status, 303);
		assert.equal(unchanged.headers.get("location"), "/account/applications");

		const changed = await changeOwnerPassword(mf, pending, INITIAL_PASSWORD, NEW_PASSWORD);
		assert.equal(changed.status, 303, await changed.text());
		assert.equal(changed.headers.get("location"),
			"/account/applications?notice=owner_password_changed");
		const active = cookieValue(changed, "__Host-who_you_owner_session");
		assert.ok(active);
		assert.notEqual(active, pending);

		const oldSession = await mf.dispatchFetch(ORIGIN + "/account",
			{ redirect: "manual", headers: { cookie: pending } });
		assert.equal(oldSession.status, 303);
		assert.match(oldSession.headers.get("location"), /^\/\?reason=sign_in_required/);

		const account = await mf.dispatchFetch(ORIGIN + "/account", { headers: { cookie: active } });
		assert.equal(account.status, 200);
		const accountBody = await account.text();
		assert.match(accountBody, /本地 Owner/);
		assert.match(accountBody, /本地 Owner 已登录/);
		assert.match(accountBody, /href="\/account\/applications"/);
		assert.doesNotMatch(accountBody, /Mira ID 已连接/);
		assert.ok(accountBody.includes(OWNER_ACCOUNT));

		const applicationsAfter = await mf.dispatchFetch(ORIGIN + "/account/applications",
			{ headers: { cookie: active } });
		assert.equal(applicationsAfter.status, 200);
		assert.doesNotMatch(await applicationsAfter.text(), /首次登录需要修改初始密码/);

		const oldPassword = await loginOwner(mf, INITIAL_PASSWORD);
		assert.equal(oldPassword.status, 401);
		assert.equal(cookieValue(oldPassword, "__Host-who_you_owner_session"), null);
		const newPassword = await loginOwner(mf, NEW_PASSWORD);
		assert.equal(newPassword.status, 303);
		assert.equal(newPassword.headers.get("location"), "/account");
		const activeSession = cookieValue(newPassword, "__Host-who_you_owner_session");
		assert.ok(activeSession);

		const mailboxPage = await mf.dispatchFetch(ORIGIN + "/account/mailboxes",
			{ headers: { cookie: activeSession } });
		assert.equal(mailboxPage.status, 200);
		assert.match(await mailboxPage.text(), /<h1>邮箱<\/h1>/);

		const secondChange = await changeOwnerPassword(mf, activeSession, NEW_PASSWORD, FINAL_PASSWORD);
		assert.equal(secondChange.status, 303, await secondChange.text());
		const finalSession = cookieValue(secondChange, "__Host-who_you_owner_session");
		assert.ok(finalSession);
		for (const stale of [active, activeSession]) {
			const rejected = await mf.dispatchFetch(ORIGIN + "/account",
				{ redirect: "manual", headers: { cookie: stale } });
			assert.equal(rejected.status, 303);
			assert.match(rejected.headers.get("location"), /^\/\?reason=sign_in_required/);
		}
		const retiredPassword = await loginOwner(mf, NEW_PASSWORD);
		assert.equal(retiredPassword.status, 401);
		const finalPassword = await loginOwner(mf, FINAL_PASSWORD);
		assert.equal(finalPassword.status, 303);
		assert.ok(cookieValue(finalPassword, "__Host-who_you_owner_session"));

		const row = await db.prepare(
			`SELECT account_id, login_name, password_hash, must_change_password
			 FROM owner_credentials WHERE id = 'owner'`,
		).first();
		assert.equal(row.account_id, OWNER_ACCOUNT);
		assert.equal(row.login_name, "admin");
		assert.equal(row.must_change_password, 0);
		assert.ok(row.password_hash);
		assert.ok(!row.password_hash.includes(NEW_PASSWORD));
		assert.ok(!row.password_hash.includes(INITIAL_PASSWORD));
		assert.ok(!row.password_hash.includes(FINAL_PASSWORD));

		const logout = await mf.dispatchFetch(ORIGIN + "/auth/logout", {
			method: "POST",
			redirect: "manual",
			headers: { origin: ORIGIN, cookie: finalSession },
		});
		assert.equal(logout.status, 303);
		const cleared = logout.headers.getSetCookie()
			.find((value) => value.startsWith("__Host-who_you_owner_session="));
		assert.match(cleared, /Max-Age=0/);
	});
});

test("Owner and Mira ID principals see one shell but never each other's mailboxes", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_owner",
			accountId: OWNER_ACCOUNT,
			address: "owner@tomlab.cn",
			localPart: "owner",
		});
		await seedMailbox(db, {
			id: "mbx_mira",
			accountId: MIRA_SUBJECT,
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});
		const { active } = await bootstrapOwner(mf);

		const ownerMailboxes = await mf.dispatchFetch(ORIGIN + "/api/mailboxes",
			{ headers: { cookie: active } });
		assert.equal(ownerMailboxes.status, 200);
		const ownerPayload = await ownerMailboxes.json();
		assert.deepEqual(ownerPayload.mailboxes.map((mailbox) => mailbox.address),
			["owner@tomlab.cn"]);
		const ownerWho = await mf.dispatchFetch(ORIGIN + "/api/whoami", { headers: { cookie: active } });
		assert.equal(ownerWho.status, 200);
		assert.deepEqual(await ownerWho.json(), { accountId: OWNER_ACCOUNT, principal: "local_owner" });

		const ownerPage = await mf.dispatchFetch(ORIGIN + "/account/mailboxes",
			{ headers: { cookie: active } });
		assert.equal(ownerPage.status, 200);
		const ownerPageBody = await ownerPage.text();
		assert.match(ownerPageBody, /owner@tomlab\.cn/);
		assert.doesNotMatch(ownerPageBody, /alpha@tomlab\.cn/);
		assert.match(ownerPageBody, /应用管理/);
		assert.match(ownerPageBody, /本地 Owner 已登录/);

		const ownerApplications = await mf.dispatchFetch(ORIGIN + "/account/applications",
			{ headers: { cookie: active } });
		assert.equal(ownerApplications.status, 200);
		const ownerApplicationsBody = await ownerApplications.text();
		assert.ok(!ownerApplicationsBody.includes(APP_SECRET));
		assert.doesNotMatch(ownerApplicationsBody, /name="appSecret"|rotateSecret/);
		const secretRoute = await mf.dispatchFetch(ORIGIN + "/account/applications/secret");
		assert.equal(secretRoute.status, 404);
		assert.deepEqual(await secretRoute.json(), { error: "not_found" });

		const mira = await loginMira(mf);
		const miraMailboxes = await mf.dispatchFetch(ORIGIN + "/api/mailboxes",
			{ headers: { cookie: mira } });
		assert.equal(miraMailboxes.status, 200);
		const miraPayload = await miraMailboxes.json();
		assert.deepEqual(miraPayload.mailboxes.map((mailbox) => mailbox.address),
			["alpha@tomlab.cn"]);

		const miraAccount = await mf.dispatchFetch(ORIGIN + "/account",
			{ headers: { cookie: mira } });
		assert.equal(miraAccount.status, 200);
		const miraAccountBody = await miraAccount.text();
		assert.match(miraAccountBody, /Mira ID 已连接/);
		assert.match(miraAccountBody, /account-e2e/);
		assert.doesNotMatch(miraAccountBody, /本地 Owner 已登录/);
		assert.doesNotMatch(miraAccountBody, /local-owner:/);
		assert.doesNotMatch(miraAccountBody, /<a href="\/account\/applications"/);
		assert.match(miraAccountBody, /<a href="\/account\/mailboxes"/);

		for (const headers of [{ cookie: mira }, { cookie: mira, accept: "application/json" }]) {
			const denied = await mf.dispatchFetch(ORIGIN + "/account/applications", { headers });
			assert.equal(denied.status, 404);
		}
		const deniedPost = await mf.dispatchFetch(ORIGIN + "/account/applications/password", {
			method: "POST",
			headers: {
				origin: ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
				cookie: mira,
			},
			body: new URLSearchParams({
				currentPassword: NEW_PASSWORD,
				newPassword: "irrelevant-password-value",
				confirmPassword: "irrelevant-password-value",
			}).toString(),
		});
		assert.equal(deniedPost.status, 404);

		const link = await mf.dispatchFetch(ORIGIN + "/account/mailboxes/gmail/link", {
			method: "POST",
			redirect: "manual",
			headers: { origin: ORIGIN, cookie: active },
		});
		assert.equal(link.status, 303, await link.text());
		const authorization = new URL(link.headers.get("location"));
		assert.equal(authorization.origin, "https://accounts.google.com");
		const state = authorization.searchParams.get("state");
		assert.ok(state);
		const stateRow = await db.prepare(
			`SELECT account_id, provider FROM oauth_link_states WHERE state = ?`,
		).bind(state).first();
		assert.equal(stateRow.account_id, OWNER_ACCOUNT);
		assert.equal(stateRow.provider, "gmail");
		assert.ok(link.headers.getSetCookie()
			.some((value) => value.startsWith("__Host-who_you_mail_oauth=")));

		const row = await db.prepare(
			`SELECT COUNT(*) AS count FROM owner_credentials WHERE account_id = ?`,
		).bind(MIRA_SUBJECT).first();
		assert.equal(row.count, 0);
	}, {
		GMAIL_OAUTH_CLIENT_ID: "synthetic-test-client",
		GMAIL_OAUTH_CLIENT_SECRET: "synthetic-test-secret",
		GMAIL_OAUTH_REDIRECT_URI: ORIGIN + "/mail/oauth/gmail/callback",
	});
});

test("Owner login fails closed for missing initialization, bad input, cross-origin and throttling", async () => {
	await withWorker(async ({ mf, db }) => {
		const crossOrigin = await mf.dispatchFetch(ORIGIN + "/auth/owner/login", {
			method: "POST",
			redirect: "manual",
			headers: {
				origin: "https://evil.invalid",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ username: "admin", password: INITIAL_PASSWORD }).toString(),
		});
		assert.equal(crossOrigin.status, 403);
		assert.equal(cookieValue(crossOrigin, "__Host-who_you_owner_session"), null);

		const getLogin = await mf.dispatchFetch(ORIGIN + "/auth/owner/login");
		assert.equal(getLogin.status, 405);

		const oversized = await mf.dispatchFetch(ORIGIN + "/auth/owner/login", {
			method: "POST",
			redirect: "manual",
			headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
			body: "username=admin&password=" + "x".repeat(5000),
		});
		assert.equal(oversized.status, 400);
		assert.equal(cookieValue(oversized, "__Host-who_you_owner_session"), null);

		const unknown = await loginOwner(mf, INITIAL_PASSWORD, {
			extra: { unexpected: "value" },
		});
		assert.equal(unknown.status, 400);
		assert.equal(cookieValue(unknown, "__Host-who_you_owner_session"), null);

		const wrongName = await loginOwner(mf, INITIAL_PASSWORD, { username: "root" });
		assert.equal(wrongName.status, 401);
		assert.equal(cookieValue(wrongName, "__Host-who_you_owner_session"), null);
		const wrongPassword = await loginOwner(mf, "not-the-initial-password");
		assert.equal(wrongPassword.status, 401);
		const wrongBody = await wrongPassword.text();
		assert.match(wrongBody, /登录没有完成/);
		assert.ok(!wrongBody.includes(INITIAL_PASSWORD));
		assert.ok(!wrongBody.includes("not-the-initial-password"));

		for (let attempt = 0; attempt < 3; attempt++) {
			const rejected = await loginOwner(mf, `wrong-password-${attempt}`);
			assert.equal(rejected.status, 401);
		}
		const locked = await loginOwner(mf, INITIAL_PASSWORD);
		assert.equal(locked.status, 429);
		assert.equal(cookieValue(locked, "__Host-who_you_owner_session"), null);
		const row = await db.prepare(
			`SELECT failures, locked_until FROM owner_login_throttle WHERE id = 'owner'`,
		).first();
		assert.ok(row.failures >= 5);
		assert.ok(row.locked_until > Date.now());
		const credentialCount = await db.prepare(
			`SELECT COUNT(*) AS count FROM owner_credentials`,
		).first();
		assert.equal(credentialCount.count, 0);
	});

	await withWorker(async ({ mf, db }) => {
		const missing = await loginOwner(mf, "some-long-password-without-initial");
		assert.equal(missing.status, 401);
		assert.equal(cookieValue(missing, "__Host-who_you_owner_session"), null);
		const credentialCount = await db.prepare(
			`SELECT COUNT(*) AS count FROM owner_credentials`,
		).first();
		assert.equal(credentialCount.count, 0);
	}, { WHOYOU_OWNER_INITIAL_PASSWORD: "" });
});
