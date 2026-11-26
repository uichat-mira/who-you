import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Miniflare } from "miniflare";

const ORIGIN = "https://who-you.tomz.io";
const AUTH = "https://cloud-auth.tomzlab.cn";
const bindings = {
  WHOYOU_WEB_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  MCP_RESOURCE_URL: ORIGIN + "/mcp",
  CLOUD_AUTH_ISSUER: AUTH,
  CLOUD_AUTH_JWKS_URL: AUTH + "/.well-known/jwks.json",
  WHOYOU_APP_ID: "app-fixture-instance",
			WHOYOU_APP_SECRET: "fixture-registration-not-a-real-secret",
			WHOYOU_MANIFEST_REVISION: "1",
};

async function withPreview(run, overrides = {}) {
  const mf = new Miniflare({
    modules: true, scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06", cf: false,
    bindings: { ...bindings, ...overrides },
    d1Databases: ["DB"], r2Buckets: ["MAIL_BUCKET"],
  });
  try { await run(mf); } finally { await mf.dispose(); }
}

test("Web login shows a human entrance without exposing a credential", async () => {
  await withPreview(async (mf) => {
    const oldHost = await mf.dispatchFetch("https://who-you-tomz-preview.dangjingtao.workers.dev/");
    assert.equal(oldHost.status, 404);
    const r = await mf.dispatchFetch(ORIGIN + "/");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const body = await r.text();
    assert.match(body, /连接你的邮箱与智能体/);
    assert.match(body, /Mira 组织出品/);
    assert.match(body, /href="https:\/\/mira\.tomz\.io\/"/);
    assert.match(body, /href="https:\/\/github\.com\/uichat-mira"/);
    assert.match(body, /<ruby class="brand-ruby">狐<rt lang="en">Who<\/rt>邮<rt lang="en">You<\/rt><\/ruby>，<br>不止于忽悠。/);
    assert.match(body, /狐邮 Who-You 是独立的邮件服务/);
    assert.match(body, /src="\/brand\/logo\/light\/horizontal-bilingual\.webp"/);
    assert.match(body, /href="\/brand\/favicon\/favicon\.ico"/);
    assert.match(r.headers.get("content-security-policy"), /img-src 'self'/);
    assert.match(body, /href="\/privacy"/);
    assert.match(body, /href="\/terms"/);
    assert.match(body, /gmail\.readonly/);
    assert.match(body, /gmail\.send/);
    assert.match(body, /使用 Mira ID 继续/);
    assert.doesNotMatch(body, /href="#about"/);
    assert.match(body, /登录不会自动授予邮箱访问权限/);
    assert.doesNotMatch(body, /sessionToken|Bearer |client_secret/);
    assert.ok(!body.includes(bindings.WHOYOU_APP_SECRET));
    assert.doesNotMatch(body, /AppSecret|WHOYOU_APP_SECRET|app-fixture-instance|已登记|实例所有者|注册狐邮/);
    assert.doesNotMatch(body, /<details class="instance-details">/);
  });
});

test("Public disclosures are readable without login or configured secrets", async () => {
  await withPreview(async (mf) => {
    for (const [path, title] of [["/privacy", "隐私政策"], ["/terms", "服务条款"]]) {
      const response = await mf.dispatchFetch(ORIGIN + path, { redirect: "manual" });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/html/);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.match(response.headers.get("content-security-policy"), /form-action 'self'/);
      const body = await response.text();
      assert.ok(body.includes(title));
      assert.match(body, /href="\/privacy"/);
      assert.match(body, /href="\/terms"/);
      assert.doesNotMatch(body, /sessionToken|Bearer |client_secret/);
      const rejected = await mf.dispatchFetch(ORIGIN + path, { method: "POST" });
      assert.equal(rejected.status, 405);
    }
    const privacy = await (await mf.dispatchFetch(ORIGIN + "/privacy")).text();
    assert.match(privacy, /Google API Services User Data Policy/);
    assert.match(privacy, /Limited Use/);
    assert.match(privacy, /解绑/);
    assert.match(privacy, /模型训练/);
    assert.match(privacy, /Cloudflare/);
    const oldHost = await mf.dispatchFetch("https://who-you-tomz-preview.dangjingtao.workers.dev/privacy");
    assert.equal(oldHost.status, 404);
  }, { WHOYOU_WEB_SESSION_KEY: "", GMAIL_OAUTH_CLIENT_SECRET: "", WHOYOU_APP_SECRET: "" });
});

test("OAuth start pins HTTPS callback, PKCE-S256 and a short HttpOnly state", async () => {
  await withPreview(async (mf) => {
    const r = await mf.dispatchFetch(ORIGIN + "/auth/start", { redirect: "manual" });
    assert.equal(r.status, 303);
    const location = new URL(r.headers.get("location"));
    assert.equal(location.origin, AUTH);
    assert.equal(location.pathname, "/v1/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), ORIGIN + "/oauth-client");
    assert.equal(location.searchParams.get("redirect_uri"), ORIGIN + "/auth/callback");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.match(location.searchParams.get("code_challenge"), /^[\w-]{43}$/);
    assert.match(location.searchParams.get("state"), /^[\w-]{43}$/);
    const cookies = r.headers.getSetCookie();
    assert.ok(cookies.some((v) => v.startsWith("__Host-who_you_oauth=")));
    assert.ok(!cookies.some((v) => v.startsWith("__Host-who_you_installation=")));
    for (const value of cookies) {
      assert.match(value, /HttpOnly/);
      assert.match(value, /Secure/);
      assert.match(value, /SameSite=Lax/);
    }
    const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
    const callback = await mf.dispatchFetch(
      ORIGIN + "/auth/callback?state=attacker&code=not-a-code",
      { headers: { cookie: cookieHeader }, redirect: "manual" },
    );
    assert.equal(callback.status, 200);
    assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
    assert.match(await callback.text(), /登录没有完成/);
  });
});

test("Web routes fail closed without session key, valid encrypted cookie or same-origin logout", async () => {
  await withPreview(async (mf) => {
    const guardedAccount = await mf.dispatchFetch(ORIGIN + "/account", { redirect: "manual" });
    assert.equal(guardedAccount.status, 303);
    assert.equal(guardedAccount.headers.get("location"),
      "/?reason=sign_in_required&returnTo=%2Faccount");

    const guardedMailboxes = await mf.dispatchFetch(ORIGIN + "/account/mailboxes", {
      redirect: "manual",
    });
    assert.equal(guardedMailboxes.status, 303);
    assert.equal(guardedMailboxes.headers.get("location"),
      "/?reason=sign_in_required&returnTo=%2Faccount%2Fmailboxes");

    const gate = await mf.dispatchFetch(ORIGIN +
      "/?reason=sign_in_required&returnTo=%2Faccount%2Fmailboxes");
    const gateBody = await gate.text();
    assert.match(gateBody, /这个页面需要先登录/);
    assert.match(gateBody, /returnTo=%2Faccount%2Fmailboxes/);

    const malicious = await mf.dispatchFetch(ORIGIN +
      "/?reason=sign_in_required&returnTo=https%3A%2F%2Fevil.invalid");
    const maliciousBody = await malicious.text();
    assert.doesNotMatch(maliciousBody, /evil\.invalid/);
    assert.match(maliciousBody, /returnTo=%2Faccount/);

    const unauth = await mf.dispatchFetch(ORIGIN + "/api/whoami");
    assert.equal(unauth.status, 401);
    const fake = await mf.dispatchFetch(ORIGIN + "/api/whoami", {
      headers: { cookie: "__Host-who_you_session=forged-session" },
    });
    assert.equal(fake.status, 401);
    const crossOrigin = await mf.dispatchFetch(ORIGIN + "/auth/logout", {
      method: "POST", headers: { origin: "https://evil.invalid" },
    });
    assert.equal(crossOrigin.status, 403);
    for (const origin of [undefined, "null"]) {
      const rejected = await mf.dispatchFetch(ORIGIN + "/auth/logout", {
        method: "POST", headers: origin === undefined ? {} : { origin },
      });
      assert.equal(rejected.status, 403);
      assert.equal((await rejected.json()).error, "origin_not_allowed");
    }
    const normal = await mf.dispatchFetch(ORIGIN + "/auth/logout", {
      method: "POST", headers: { origin: ORIGIN }, redirect: "manual",
    });
    assert.equal(normal.status, 303);
    assert.equal(normal.headers.get("location"), "/");
    assert.match(normal.headers.get("set-cookie"), /Max-Age=0/);
  });
  await withPreview(async (mf) => {
    const disabled = await mf.dispatchFetch(ORIGIN + "/");
    assert.equal(disabled.status, 503);
  }, { WHOYOU_WEB_SESSION_KEY: "" });
});

test("Unknown paths remain 404; existing MCP bearer gate remains authoritative", async () => {
  await withPreview(async (mf) => {
    const unknown = await mf.dispatchFetch(ORIGIN + "/unknown");
    assert.equal(unknown.status, 404);
    const mcp = await mf.dispatchFetch(ORIGIN + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.ok([401, 403].includes(mcp.status));
  });
});

test("Browser errors render recovery pages without changing machine contracts", async () => {
  await withPreview(async (mf) => {
    const html = { accept: "text/html,application/xhtml+xml" };
    const missing = await mf.dispatchFetch(ORIGIN + "/lost", { headers: html });
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type"), /text\/html/);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    const body = await missing.text();
    assert.match(body, /这封信走错了路/);
    assert.match(body, /href="\/"/);
    assert.match(body, /data-scene="lost"/);
    assert.doesNotMatch(body, /brand\/logo\/dark\/symbol\.webp/);
    const forbidden = await mf.dispatchFetch(ORIGIN + "/auth/logout", {
      method: "POST", headers: { ...html, origin: "https://evil.invalid" },
    });
    assert.equal(forbidden.status, 403);
    const forbiddenBody = await forbidden.text();
    assert.match(forbiddenBody, /这一步无法继续/);
    assert.match(forbiddenBody, /data-scene="locked"/);
    assert.equal(forbidden.headers.get("set-cookie"), null);
    const method = await mf.dispatchFetch(ORIGIN + "/auth/logout", { headers: html });
    assert.equal(method.status, 405);
    assert.match(await method.text(), /这个操作暂不可用/);
    const bare = await mf.dispatchFetch(ORIGIN + "/auth/callback?code=untrusted-test-value", {headers: html});
    assert.equal(bare.status, 200);
    const callbackBody = await bare.text();
    assert.match(callbackBody, /登录没有完成/);
    assert.match(callbackBody, /data-scene="expired"/);
    assert.doesNotMatch(callbackBody, /untrusted-test-value/);
    assert.match(bare.headers.get("set-cookie"), /Max-Age=0/);
    for (const route of ["/api/unknown", "/mcp/unknown", "/.well-known/unknown", "/mira/unknown", "/brand/missing.webp"]) {
      const r = await mf.dispatchFetch(ORIGIN + route, { headers: html });
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: "not_found" });
    }
    const api = await mf.dispatchFetch(ORIGIN + "/api/whoami", {headers: html});
    assert.equal(api.status, 401);
    assert.deepEqual(await api.json(), {error: "sign_in_required"});
    const wrong = await mf.dispatchFetch("https://other.invalid/", {headers: html});
    assert.equal(wrong.status, 404);
    assert.deepEqual(await wrong.json(), {error: "not_found"});
    const machine = await mf.dispatchFetch(ORIGIN + "/lost", {headers: {accept: "application/json"}});
    assert.deepEqual(await machine.json(), {error: "not_found"});
  });
  await withPreview(async (mf) => {
    const browser = await mf.dispatchFetch(ORIGIN + "/", {headers: {accept: "text/html"}});
    assert.equal(browser.status, 503);
    const body = await browser.text();
    assert.match(body, /狐邮暂时无法服务/);
    assert.match(body, /data-scene="paused"/);
    assert.doesNotMatch(body, /web_login_not_configured/);
    const machine = await mf.dispatchFetch(ORIGIN + "/");
    assert.equal(machine.status, 503);
    assert.deepEqual(await machine.json(), {error: "web_login_not_configured"});
  }, {WHOYOU_WEB_SESSION_KEY: ""});
});
