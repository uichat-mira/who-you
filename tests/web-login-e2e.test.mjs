import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";
import { Miniflare } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ORIGIN = "https://who-you.tomz.io";
const AUTH = "https://cloud-auth.tomzlab.cn";
const jwksUrl = AUTH + "/.well-known/jwks.json";
const issuedUrl = AUTH + "/v1/service-credentials";
const tokenUrl = AUTH + "/v1/oauth/token";
function cookies(res) {
  return res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
}
test("real workerd: Web OAuth callback -> server-side credential -> verified whoyou_whoami", async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", use: "sig", alg: "EdDSA" };
  const jwt = await new SignJWT({
    consumer_id: "account-e2e", scope: ["whoyou.read"], device_id: "web-device-e2e",
  }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "test-key" })
    .setIssuer("mira:cloud-auth").setAudience("mira:who-you")
    .setSubject("account-e2e").setIssuedAt().setExpirationTime("5m")
    .sign(privateKey);
  const counters = {token: 0, issue: 0, jwks: 0};
  const mf = new Miniflare({
    modules: true, scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06", cf: false,
    bindings: {
      WHOYOU_WEB_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
      MCP_RESOURCE_URL: ORIGIN + "/mcp",
      CLOUD_AUTH_ISSUER: AUTH,
      CLOUD_AUTH_JWKS_URL: jwksUrl,
      MCP_AUDIENCE: "mira:who-you",
    },
    d1Databases: ["DB"], r2Buckets: ["MAIL_BUCKET"],
    outboundService: async (request) => {
      if (request.url === tokenUrl) {
        counters.token++;
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get("client_id"), "who-you-web");
        assert.equal(body.get("platform"), "web");
        assert.equal(body.get("redirect_uri"), ORIGIN + "/auth/callback");
        return Response.json({
          sessionToken: "mira-device-session-test-only-placeholder-secret",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (request.url === issuedUrl) {
        counters.issue++;
        assert.match(request.headers.get("authorization"), /^Bearer mira-device-session/);
        assert.deepEqual(await request.json(), {audience: "mira:who-you"});
        return Response.json({token: jwt, tokenType: "Bearer", audience: "mira:who-you",
          expiresAt: new Date(Date.now() + 300000).toISOString()});
      }
      if (request.url === jwksUrl) {
        counters.jwks++;
        return Response.json({keys: [jwk]});
      }
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
    assert.equal(callback.headers.get("location"), "/account/mailboxes");
    const page = await mf.dispatchFetch(ORIGIN + "/account", {
      redirect: "manual", headers: {cookie: cookies(callback)},
    });
    const body = await page.text();
    assert.equal(page.status, 200, body);
    assert.match(body, /<h1>账户<\/h1>/);
    assert.match(body, /Mira 云账号/);
    assert.match(body, /account-e2e/);
    assert.match(body, /whoyou.read/);
    assert.match(body, /href="\/account\/mailboxes"/);
    assert.match(body, /aria-current="page">账户<\/a>/);
    assert.doesNotMatch(body, /mira-device-session-test-only-placeholder-secret/);
    const root = await mf.dispatchFetch(ORIGIN + "/", {
      redirect: "manual", headers: {cookie: cookies(callback)},
    });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get("location"), "/account");
    assert.ok(counters.token >= 1);
    assert.ok(counters.issue >= 1);
    assert.ok(counters.jwks >= 1);
  } finally {
    await mf.dispose();
  }
});
