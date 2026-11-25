import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createCloudAuthVerifier, principalFromAuthInfo, authInfoFromPrincipal, resolveMcpConfig } from "../dist/unit.mjs";
const resource = "https://who.example.com/mcp";
const appId = "app-fixture-instance";
const issuer = "mira:cloud-auth";
const jwksUrl = new URL("https://auth.example.com/jwks.json");
const trusted = await generateKeyPair("Ed25519"), rogue = await generateKeyPair("Ed25519");
const keySet = createLocalJWKSet({ keys: [await exportJWK(trusted.publicKey)] });
const verifier = createCloudAuthVerifier({ issuer, audience: resource, appId, serviceId: "mail", jwksUrl, keySet });
const now = Math.floor(Date.now()/1000);
const claims = { iss: issuer, aud: resource, sub: "account-a", device_id: "device-fixture", app_id: appId,
  service_id: "mail", resource, scope: ["whoyou.read"], iat: now, nbf: now, exp: now+300 };
async function token(overrides={}, key=trusted.privateKey) {
  return new SignJWT({...claims,...overrides}).setProtectedHeader({alg:"EdDSA"}).sign(key);
}
test("V1 subject is the mailbox owner and the SDK preserves it", async()=>{
  const principal=await verifier.verifyAccessToken(await token());
  assert.equal(principal.accountId,"account-a");
  assert.equal(principal.consumerId,"account-a");
  assert.deepEqual(principal.scopes,["whoyou.read"]);
  assert.equal(principal.expiresAt,now+300);
  assert.equal(principal.username,undefined);
  assert.deepEqual(principalFromAuthInfo(authInfoFromPrincipal("fixture",principal,new URL(resource))),principal);
  assert.throws(()=>principalFromAuthInfo(undefined));
});
test("wrong signature, instance, resource, service, scope, time and legacy claims fail closed",async()=>{
  for(const c of [
    {iss:"other"}, {aud:"mira:who-you"}, {aud:[resource]}, {resource:"https://other.example/mcp"},
    {app_id:"app-other-instance"}, {service_id:"other"}, {sub:""}, {device_id:""},
    {scope:["whoyou.read","whoyou.mail.write"]}, {scope:"whoyou.read"}, {scope:[]},
    {exp:now-1},{exp:now+601},{nbf:now+60},{iat:now+1},
    {consumer_id:"account-a"},{preferred_username:"someone"},{app_id:undefined},{resource:undefined}
  ]) await assert.rejects(verifier.verifyAccessToken(await token(c)),undefined,JSON.stringify(c));
  await assert.rejects(verifier.verifyAccessToken(await token({},rogue.privateKey)));
});
test("instance binding is required and the audience is the exact HTTPS resource",()=>{
  const env={ MCP_RESOURCE_URL:resource,CLOUD_AUTH_ISSUER:"https://auth.example.com",CLOUD_AUTH_JWKS_URL:jwksUrl.href,WHOYOU_APP_ID:appId };
  assert.equal(resolveMcpConfig(env).config.audience,resource);
  assert.equal(resolveMcpConfig(env).config.appId,appId);
  for(const bad of [{WHOYOU_APP_ID:""}, {MCP_RESOURCE_URL:"http://example.com/mcp"},
    {MCP_RESOURCE_URL:"https://who.example.com/other"}, {CLOUD_AUTH_JWKS_URL:""}])
    assert.equal(resolveMcpConfig({...env,...bad}).ok,false);
  assert.equal(resolveMcpConfig({ ...env, WHOYOU_APP_ID:undefined, MCP_AUDIENCE:"mira:who-you" }).ok,false);
});
