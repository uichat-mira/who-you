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
  MCP_AUDIENCE: "mira:who-you",
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
    assert.match(body, /连接 Mira 云账号/);
    assert.match(body, /邮件能力服务/);
    assert.match(body, /href="\/privacy"/);
    assert.match(body, /href="\/terms"/);
    assert.match(body, /gmail\.readonly/);
    assert.match(body, /gmail\.send/);
    assert.match(body, /使用 Mira 云账号登录/);
    assert.match(body, /登录只确认你的 Mira 云账号身份/);
    assert.doesNotMatch(body, /sessionToken|Bearer |client_secret/);
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
  }, { WHOYOU_WEB_SESSION_KEY: "", GMAIL_OAUTH_CLIENT_SECRET: "" });
});

test("OAuth start pins HTTPS callback, PKCE-S256 and a short HttpOnly state", async () => {
  await withPreview(async (mf) => {
    const r = await mf.dispatchFetch(ORIGIN + "/auth/start", { redirect: "manual" });
    assert.equal(r.status, 303);
    const location = new URL(r.headers.get("location"));
    assert.equal(location.origin, AUTH);
    assert.equal(location.pathname, "/v1/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), "who-you-web");
    assert.equal(location.searchParams.get("redirect_uri"), ORIGIN + "/auth/callback");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.match(location.searchParams.get("code_challenge"), /^[\w-]{43}$/);
    assert.match(location.searchParams.get("state"), /^[\w-]{43}$/);
    const cookies = r.headers.getSetCookie();
    assert.ok(cookies.some((v) => v.startsWith("__Host-who_you_oauth=")));
    assert.ok(cookies.some((v) => v.startsWith("__Host-who_you_installation=")));
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
