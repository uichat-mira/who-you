import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Miniflare } from "miniflare";

const ORIGIN = "https://who-you-tomz-preview.dangjingtao.workers.dev";
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
    const r = await mf.dispatchFetch(ORIGIN + "/");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const body = await r.text();
    assert.match(body, /使用 Mira 云账号登录/);
    assert.doesNotMatch(body, /sessionToken|Bearer |client_secret/);
  });
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
    assert.match(await callback.text(), /登录已过期或验证失败/);
  });
});

test("Web routes fail closed without session key, valid encrypted cookie or same-origin logout", async () => {
  await withPreview(async (mf) => {
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
