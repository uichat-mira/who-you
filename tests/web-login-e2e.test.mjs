import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";
import { Miniflare } from "miniflare";

const ORIGIN = "https://who-you.tomz.io";
const AUTH = "https://cloud-auth.tomzlab.cn";
const jwksUrl = AUTH + "/.well-known/jwks.json";
const issuedUrl = AUTH + "/v1/service-credentials";
const tokenUrl = AUTH + "/v1/oauth/token";
function cookies(res) {
  return res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
}
test("real workerd: V1 OAuth callback -> app session -> revalidated account", async () => {
  const token = "mas_v1.fixture.session";
  const identity = { issuer: "mira:cloud-auth", subject: "account-e2e",
    appId: "app-fixture-instance", audience: ORIGIN + "/oauth-client",
    expiresAt: new Date(Date.now() + 1800_000).toISOString() };
  const counters = { token: 0, session: 0, legacy: 0 };
  let revoked = false;
  const mf = new Miniflare({
    modules: true, scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06", cf: false,
    bindings: {
      WHOYOU_WEB_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
      MCP_RESOURCE_URL: ORIGIN + "/mcp",
      CLOUD_AUTH_ISSUER: AUTH,
      CLOUD_AUTH_JWKS_URL: jwksUrl,
      WHOYOU_APP_ID: "app-fixture-instance",
			WHOYOU_APP_SECRET: "fixture-registration-not-a-real-secret",
			WHOYOU_MANIFEST_REVISION: "1",
    },
    d1Databases: ["DB"], r2Buckets: ["MAIL_BUCKET"],
    outboundService: async (request) => {
      if (request.url === tokenUrl) {
        counters.token++;
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get("client_id"), ORIGIN + "/oauth-client");
        assert.equal(body.get("platform"), null);
        assert.equal(body.get("installation_id"), null);
        assert.equal(body.get("redirect_uri"), ORIGIN + "/auth/callback");
        return Response.json({ access_token: token, token_type: "Bearer", expires_in: 1800, ...identity });
      }
      if (request.url === AUTH + "/v1/oauth/application-session") {
        counters.session++;
        assert.equal(request.headers.get("authorization"), "Bearer " + token);
        return revoked ? new Response(null, { status: 401 }) : Response.json(identity);
      }
      if (request.url === issuedUrl) { counters.legacy++; return new Response(null, {status: 404}); }
      return Response.json({error: "unexpected_upstream", url: request.url}, {status: 404});
    },
  });
  try {
    const initial = await mf.dispatchFetch(
      ORIGIN + "/auth/start?returnTo=%2Faccount%2Fmailboxes",
      {redirect: "manual"},
    );
    assert.equal(initial.status, 303);
    const redirect = new URL(initial.headers.get("location"));
    const state = redirect.searchParams.get("state");
    assert.ok(state);
    const callback = await mf.dispatchFetch(ORIGIN + "/auth/callback?" +
      new URLSearchParams({state, code: "test-one-time-code"}), {
      redirect: "manual", headers: {cookie: cookies(initial)},
    });
    assert.equal(callback.status, 303, await callback.text());
    assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
    assert.equal(callback.headers.get("location"), "/account/mailboxes");
    const page = await mf.dispatchFetch(ORIGIN + "/account", {
      redirect: "manual", headers: {cookie: cookies(callback)},
    });
    const body = await page.text();
    assert.equal(page.status, 200, body);
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    assert.equal(page.headers.get("content-security-policy")?.split("; ")
      .find((directive) => directive.startsWith("form-action ")), "form-action 'self'");
    assert.match(body, /action="\/auth\/logout"/);
    assert.match(body, /<h1>账户<\/h1>/);
    assert.match(body, /Mira ID 已连接/);
    assert.match(body, /class="account-avatar" src="\/brand\/mira-id\/mira-id-app\.svg"/);
    assert.match(body, /account-e2e/);
    assert.match(body, /狐邮应用访问/);
    assert.match(body, /狐邮邮件服务/);
    assert.match(body, /暂时无法获取邮箱状态/);
    assert.match(body, /href="\/account\/mailboxes"/);
    assert.match(body, /aria-current="page">账户<\/a>/);
    assert.match(body, /<details class="instance-details">/);
    assert.ok(body.includes(identity.appId));
    assert.ok(body.includes(ORIGIN + "/mcp"));
    assert.ok(body.includes(AUTH + "/account/applications"));
    assert.ok(body.includes(AUTH + "/account/services"));
    assert.match(body, /实例声明权限（非当前用户授权）/);
    assert.match(body, /不代表你拥有或管理此应用/);
    assert.ok(!body.includes(token));
    assert.doesNotMatch(body, /fixture-registration-not-a-real-secret|AppSecret|WHOYOU_APP_SECRET|邮箱已连接/);
    assert.doesNotMatch(body, /mira-device-session-test-only-placeholder-secret/);
    const root = await mf.dispatchFetch(ORIGIN + "/", {
      redirect: "manual", headers: {cookie: cookies(callback)},
    });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get("location"), "/account");
    assert.ok(counters.token >= 1);
    assert.ok(counters.session >= 1);
    assert.equal(counters.legacy, 0);
    revoked = true;
    const denied = await mf.dispatchFetch(ORIGIN + "/api/whoami", { headers: {cookie: cookies(callback)} });
    assert.equal(denied.status, 502);
    assert.doesNotMatch(await denied.text(), /account-e2e/);
    const rejected = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {headers: {cookie: cookies(callback)}});
    assert.equal(rejected.status, 502);
    assert.doesNotMatch(await rejected.text(), /Mira ID 已连接/);
  } finally {
    await mf.dispose();
  }
});
