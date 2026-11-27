import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "./workerd-harness.mjs";

/**
 * OPS-055 contract tests: the instance Owner can inspect and rotate the Mira ID
 * registration AppSecret without changing ownership, user grants or mail data.
 * Every address, app id, password and secret below is synthetic.
 */

const ORIGIN = "https://who-you.tomz.io";
const AUTH = "https://cloud-auth.tomzlab.cn";
const SESSION_KEY = Buffer.alloc(32, 7).toString("base64url");
const INITIAL_PASSWORD = "synthetic-owner-initial-password-2026";
const OWNER_PASSWORD = "synthetic-owner-rotated-password-2026";
const APP_ID = "app-fixture-instance";
const APP_SECRET = "fixture-registration-not-a-real-secret";
const OWNER_ACCOUNT = "local-owner:app-fixture-instance";
const MIRA_SUBJECT = "account-e2e";
const TOKEN_URL = AUTH + "/v1/oauth/token";
const SESSION_URL = AUTH + "/v1/oauth/application-session";

const CODES = new Map([["code-e2e", "mas_v1.fixture.e2e"]]);
const TOKENS = new Map([["mas_v1.fixture.e2e", MIRA_SUBJECT]]);

const SECRET_PATTERN = /<pre class="secret-value"[^>]*>([^<]+)<\/pre>/;

function createOutbound(trace = {}) {
	return async (request) => {
		if (request.url === TOKEN_URL) {
			const form = new URLSearchParams(await request.text());
			const token = CODES.get(form.get("code"));
			if (!token) return Response.json({ error: "invalid_grant" }, { status: 400 });
			const identity = {
				issuer: "mira:cloud-auth",
				subject: TOKENS.get(token),
				appId: APP_ID,
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
			WHOYOU_APP_ID: APP_ID,
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

const cookieValue = (response, name) => {
	const entry = response.headers.getSetCookie()
		.find((value) => value.startsWith(name + "="));
	return entry ? entry.split(";")[0] : null;
};

const cookies = (response) =>
	response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

function loginOwner(mf, password) {
	return mf.dispatchFetch(ORIGIN + "/auth/owner/login?" +
		new URLSearchParams({ returnTo: "/account" }), {
		method: "POST",
		redirect: "manual",
		headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ username: "admin", password }).toString(),
	});
}

function changeOwnerPassword(mf, cookie, current, next) {
	return mf.dispatchFetch(ORIGIN + "/account/applications/password", {
		method: "POST",
		redirect: "manual",
		headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", cookie },
		body: new URLSearchParams({
			currentPassword: current,
			newPassword: next,
			confirmPassword: next,
		}).toString(),
	});
}

async function bootstrapOwner(mf) {
	const login = await loginOwner(mf, INITIAL_PASSWORD);
	assert.equal(login.status, 303, await login.text());
	const pending = cookieValue(login, "__Host-who_you_owner_session");
	assert.ok(pending);
	const changed = await changeOwnerPassword(mf, pending, INITIAL_PASSWORD, OWNER_PASSWORD);
	assert.equal(changed.status, 303, await changed.text());
	const active = cookieValue(changed, "__Host-who_you_owner_session");
	assert.ok(active);
	return active;
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

function secretAction(mf, path, cookie, origin = ORIGIN) {
	return mf.dispatchFetch(ORIGIN + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			origin,
			"content-type": "application/x-www-form-urlencoded",
			...(cookie ? { cookie } : {}),
		},
		body: "",
	});
}

function verifyRegistration(mf, secret) {
	return mf.dispatchFetch(ORIGIN + "/mira/verify-registration", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ appId: APP_ID, appSecret: secret }),
	});
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

function revealedSecret(body) {
	const match = SECRET_PATTERN.exec(body);
	assert.ok(match, "expected one revealed AppSecret in the protected response");
	return match[1];
}

test("Owner views the bootstrap secret, rotates it, and only the current version verifies", async () => {
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
		const mira = await loginMira(mf);
		const manifestBefore = await mf.dispatchFetch(ORIGIN + "/.well-known/mira-application");
		assert.equal(manifestBefore.status, 200);
		const manifestJson = await manifestBefore.json();
		const owner = await bootstrapOwner(mf);

		const applications = await mf.dispatchFetch(ORIGIN + "/account/applications",
			{ headers: { cookie: owner } });
		assert.equal(applications.status, 200);
		const applicationsBody = await applications.text();
		assert.match(applicationsBody, /<h1>应用管理<\/h1>/);
		assert.ok(applicationsBody.includes(ORIGIN));
		assert.match(applicationsBody, /href="\/account\/applications\/current"/);
		assert.doesNotMatch(applicationsBody, /APP ID|AppSecret/);
		assert.ok(!applicationsBody.includes(APP_SECRET));

		const instancePage = await mf.dispatchFetch(ORIGIN + "/account/applications/current",
			{ headers: { cookie: owner } });
		assert.equal(instancePage.status, 200);
		const instanceBody = await instancePage.text();
		assert.ok(instanceBody.includes(APP_ID));
		assert.match(instanceBody, /显示 AppSecret/);
		assert.match(instanceBody, /确认轮换/);
		assert.doesNotMatch(instanceBody, /当前 Owner 密码|currentPassword/);
		assert.ok(!instanceBody.includes(APP_SECRET));
		assert.doesNotMatch(instanceBody, SECRET_PATTERN);

		const view = await secretAction(mf, "/account/applications/secret/view", owner);
		assert.equal(view.status, 200);
		assert.equal(view.headers.get("cache-control"), "no-store");
		assert.equal(view.headers.get("location"), null);
		assert.equal(view.headers.getSetCookie().length, 0);
		const viewBody = await view.text();
		assert.equal(revealedSecret(viewBody), APP_SECRET);
		assert.equal(viewBody.split(APP_SECRET).length - 1, 1);

		const bootstrapProof = await verifyRegistration(mf, APP_SECRET);
		assert.equal(bootstrapProof.status, 200);
		assert.deepEqual(await bootstrapProof.json(), { ok: true, appId: APP_ID });

		const stillBootstrap = await db.prepare(
			`SELECT COUNT(*) AS count FROM application_app_secret`,
		).first();
		assert.equal(stillBootstrap.count, 0);
		assert.equal((await verifyRegistration(mf, APP_SECRET)).status, 200);

		const rotated = await secretAction(mf, "/account/applications/secret/rotate", owner);
		assert.equal(rotated.status, 200);
		assert.equal(rotated.headers.get("cache-control"), "no-store");
		assert.equal(rotated.headers.get("location"), null);
		assert.equal(rotated.headers.getSetCookie().length, 0);
		const rotatedBody = await rotated.text();
		const firstRotated = revealedSecret(rotatedBody);
		assert.notEqual(firstRotated, APP_SECRET);
		assert.match(firstRotated, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(rotatedBody.split(firstRotated).length - 1, 1);
		assert.match(rotatedBody, /新的 AppSecret（仅显示一次）/);

		const refresh = await mf.dispatchFetch(ORIGIN + "/account/applications/current",
			{ headers: { cookie: owner } });
		assert.equal(refresh.status, 200);
		const refreshBody = await refresh.text();
		assert.match(refreshBody, /已轮换/);
		assert.match(refreshBody, /轮换后的 Secret 不保存可恢复明文/);
		assert.ok(!refreshBody.includes(firstRotated));
		assert.ok(!refreshBody.includes(APP_SECRET));
		assert.doesNotMatch(refreshBody, SECRET_PATTERN);
		const viewAfterRotation = await secretAction(mf, "/account/applications/secret/view", owner);
		assert.equal(viewAfterRotation.status, 409);
		const viewAfterBody = await viewAfterRotation.text();
		assert.match(viewAfterBody, /当前 AppSecret 不可再次查看/);
		assert.ok(!viewAfterBody.includes(firstRotated));
		assert.ok(!viewAfterBody.includes(APP_SECRET));

		const oldRejected = await verifyRegistration(mf, APP_SECRET);
		assert.equal(oldRejected.status, 403);
		assert.deepEqual(await oldRejected.json(), { error: "registration_rejected" });
		assert.equal((await verifyRegistration(mf, firstRotated)).status, 200);

		const stored = await db.prepare(
			`SELECT secret_hash, secret_salt, secret_version, rotated_at
			 FROM application_app_secret WHERE id = 'current'`,
		).first();
		assert.equal(stored.secret_version, 1);
		assert.ok(stored.rotated_at > 0);
		assert.ok(stored.secret_hash);
		assert.ok(stored.secret_salt);
		assert.ok(!JSON.stringify(stored).includes(firstRotated));
		assert.ok(!JSON.stringify(stored).includes(APP_SECRET));

		const manifestAfter = await mf.dispatchFetch(ORIGIN + "/.well-known/mira-application");
		assert.deepEqual(await manifestAfter.json(), manifestJson);

		const ownerMailboxes = await mf.dispatchFetch(ORIGIN + "/api/mailboxes",
			{ headers: { cookie: owner } });
		assert.equal(ownerMailboxes.status, 200);
		assert.deepEqual((await ownerMailboxes.json()).mailboxes.map((mailbox) => mailbox.address),
			["owner@tomlab.cn"]);
		const miraMailboxes = await mf.dispatchFetch(ORIGIN + "/api/mailboxes",
			{ headers: { cookie: mira } });
		assert.equal(miraMailboxes.status, 200);
		assert.deepEqual((await miraMailboxes.json()).mailboxes.map((mailbox) => mailbox.address),
			["alpha@tomlab.cn"]);

		const second = await secretAction(mf, "/account/applications/secret/rotate", owner);
		assert.equal(second.status, 200);
		const secondSecret = revealedSecret(await second.text());
		assert.match(secondSecret, /^[A-Za-z0-9_-]{43}$/);
		assert.notEqual(secondSecret, firstRotated);

		const previousRejected = await verifyRegistration(mf, firstRotated);
		assert.equal(previousRejected.status, 403);
		assert.deepEqual(await previousRejected.json(), { error: "registration_rejected" });
		assert.equal((await verifyRegistration(mf, secondSecret)).status, 200);
		const versionTwo = await db.prepare(
			`SELECT secret_version FROM application_app_secret WHERE id = 'current'`,
		).first();
		assert.equal(versionTwo.secret_version, 2);

		const crossOrigin = await secretAction(mf, "/account/applications/secret/rotate",
			owner, "https://evil.invalid");
		assert.equal(crossOrigin.status, 403);
		assert.ok(!await crossOrigin.text().then((body) => body.includes(secondSecret)));
		assert.equal((await verifyRegistration(mf, secondSecret)).status, 200);

		for (const path of ["/account/applications/secret/view",
			"/account/applications/secret/rotate"]) {
			const get = await mf.dispatchFetch(ORIGIN + path, { headers: { cookie: owner } });
			assert.equal(get.status, 405);
			assert.ok(!await get.text().then((body) => body.includes(secondSecret)));
		}

		const anonymous = await secretAction(mf, "/account/applications/secret/view", null);
		assert.equal(anonymous.status, 303);
		assert.match(anonymous.headers.get("location"), /^\/\?reason=sign_in_required/);
		assert.ok(!await anonymous.text().then((body) => body.includes(APP_SECRET)));

		const miraView = await secretAction(mf, "/account/applications/secret/view", mira);
		assert.equal(miraView.status, 404);

		const withQuery = await mf.dispatchFetch(
			ORIGIN + "/account/applications/secret/rotate?notice=x", {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", cookie: owner },
			body: "",
		});
		assert.equal(withQuery.status, 400);

		// A missing/unreadable state table must reject proofs instead of falling
		// back to the deployment bootstrap secret.
		await db.prepare("DROP TABLE application_app_secret").run();
		const unavailable = await mf.dispatchFetch(ORIGIN + "/account/applications/current",
			{ headers: { cookie: owner } });
		assert.equal(unavailable.status, 200);
		const unavailableBody = await unavailable.text();
		assert.match(unavailableBody, /AppSecret/);
		assert.match(unavailableBody, /不可用/);
		assert.ok(!unavailableBody.includes(secondSecret));
		assert.equal((await verifyRegistration(mf, secondSecret)).status, 403);
		assert.equal((await verifyRegistration(mf, APP_SECRET)).status, 403);
	});
});
