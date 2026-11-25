import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Miniflare } from "miniflare";

const origin = "https://mail-instance.example";
const appId = "app-fixture-instance";
const secret = randomBytes(32).toString("base64url");
const bindings = {
  WHOYOU_APP_ID: appId, WHOYOU_APP_SECRET: secret,
  WHOYOU_MANIFEST_REVISION: "2", MCP_RESOURCE_URL: origin + "/mcp",
};

test("real Worker publishes the instance declaration and verifies only the configured proof", async () => {
  const mf = new Miniflare({ modules: true, scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06", cf: false, bindings });
  try {
    const r = await mf.dispatchFetch(origin + "/.well-known/mira-application");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const body = await r.text();
    assert.ok(!body.includes(secret));
    const manifest = JSON.parse(body);
    assert.equal(manifest.appId, appId);
    assert.equal(manifest.manifestRevision, 2);
    assert.deepEqual(manifest.oauth, { clientId: origin + "/oauth-client", redirectUris: [origin + "/auth/callback"] });
    assert.equal(manifest.services[0].resource, origin + "/mcp");
    assert.equal(manifest.services[0].protocol.version, "2026-07-28");
    assert.deepEqual(manifest.services[0].scopes, ["whoyou.read"]);
    assert.ok(manifest.services[0].capabilities.flatMap(cap => cap.toolRefs).includes("whoyou_mail_search"));
    const verify = (data, headers = {}) => mf.dispatchFetch(manifest.registrationVerification.endpoint, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data),
    });
    const success = await verify({ appId, appSecret: secret });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true, appId });
    for (const data of [
      { appId: "app-other-instance", appSecret: secret },
      { appId, appSecret: "invalid-fixture-secret" },
      { appId, appSecret: secret, managementToken: "not-allowed" },
      { appId, appSecret: "x".repeat(5000) },
    ]) assert.equal((await verify(data)).status, 403);
    assert.equal((await verify({ appId, appSecret: secret }, { origin })).status, 403);
    assert.equal((await mf.dispatchFetch("https://another.example/.well-known/mira-application")).status, 404);
  } finally { await mf.dispose(); }
});
test("unconfigured instance never publishes or accepts registration", async () => {
  const mf = new Miniflare({ modules: true, scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06", cf: false, bindings: { ...bindings, WHOYOU_APP_SECRET: "" } });
  try {
    assert.equal((await mf.dispatchFetch(origin + "/.well-known/mira-application")).status, 503);
  } finally { await mf.dispose(); }
});
