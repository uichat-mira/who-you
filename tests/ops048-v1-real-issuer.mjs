/** Local cross-repository T3. Run with Cloud Auth's tsx from its isolated checkout.
 * The transport adapters route HTTPS-shaped requests into actual Fastify and
 * workerd instances. No simulated issuer, signature, registry or mail handler.
 * Public DNS/TLS/deployment acceptance remains OPS-053.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const { MIGRATIONS, seedMailbox, seedMessage } = await import("./workerd-harness.mjs");
assert.ok(process.argv[2], "Supply the isolated Cloud Auth checkout path");
const cloud = resolve(process.argv[2]);
const load = path => import(pathToFileURL(join(cloud, path)).href);
const { createTestOAuthContext, createFirstPartySession } = await load("apps/api/tests/helpers/oauth.ts");
const { createTestServiceCredentialKeyMaterial } = await load("apps/api/tests/helpers/service-credential.ts");
const { buildApp } = await load("apps/api/src/app.ts");
const temp = mkdtempSync(join(tmpdir(), "ops048-v1-"));
process.chdir(join(cloud, "apps/api"));
const context = createTestOAuthContext(join(temp, "auth.sqlite"), {
  serviceCredentialKeyMaterial: createTestServiceCredentialKeyMaterial(),
});
const origin = "https://127.0.0.1";
const issuer = "https://auth.fixture.example";
const appId = randomUUID();
const secret = randomBytes(32).toString("base64url");
const password = randomBytes(24).toString("base64url");
let mf, app;
let legacyHits = 0;
const bearer = token => ({ authorization: "Bearer " + token });
const cookies = res => res.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
const rpc = (method, url, token, payload) => app.inject({ method, url, headers: bearer(token), ...(payload ? {payload} : {}) });
try {
  await context.service.provisionAccount("alice", password);
  await context.service.provisionAccount("bob", password);
  const alice = await createFirstPartySession(context, {username:"alice",password,platform:"mobile"});
  const bob = await createFirstPartySession(context, {username:"bob",password,platform:"mobile"});
  process.chdir(root);
  mf = new Miniflare({
    modules:true, scriptPath:join(root,"dist/worker.mjs"), compatibilityDate:"2026-08-06",cf:false,
    d1Databases:["DB"],r2Buckets:["MAIL_BUCKET"],
    bindings:{ WHOYOU_APP_ID:appId,WHOYOU_APP_SECRET:secret,WHOYOU_MANIFEST_REVISION:"1",
      WHOYOU_WEB_SESSION_KEY:randomBytes(32).toString("base64url"),MCP_RESOURCE_URL:origin+"/mcp",
      CLOUD_AUTH_ISSUER:issuer,CLOUD_AUTH_JWKS_URL:issuer+"/.well-known/jwks.json",MAIL_DOMAIN:"fixture.example" },
    outboundService:async request=>{
      const url=new URL(request.url);
      assert.equal(url.origin,issuer);
      if(url.pathname==="/v1/service-credentials") legacyHits++;
      const res=await app.inject({method:request.method,url:url.pathname+url.search,
        headers:Object.fromEntries(request.headers),...(request.method==="GET"?{}:{payload:await request.text()})});
      return new Response([204,304].includes(res.statusCode)?null:res.body,{status:res.statusCode,headers:res.headers});
    },
  });
  const transport={
    get:async url=>{const r=await mf.dispatchFetch(url);return {status:r.status,body:await r.json()};},
    post:async(url,body)=>{const r=await mf.dispatchFetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};},
  };
  app=buildApp({db:context.db,authService:context.service,deviceService:context.deviceService,
    hostService:context.hostService,hostGrantService:context.hostGrantService,oauthService:context.oauthService,
    serviceCredentialService:context.serviceCredentialService,applicationRegistrationTransport:transport});
  const wrong=await rpc("POST","/v1/account/applications",bob.sessionToken,{origin,appId,appSecret:"invalid-registration-fixture"});
  assert.notEqual(wrong.statusCode,200);
  const registered=await rpc("POST","/v1/account/applications",bob.sessionToken,{origin,appId,appSecret:secret});
  assert.equal(registered.statusCode,200,registered.body);
  assert.equal(registered.json().application.manifest.oauth.redirectUris[0],origin+"/auth/callback");
  assert.equal((await rpc("GET","/v1/account/applications/"+appId,alice.sessionToken)).statusCode,404);
  const db=await mf.getD1Database("DB");
  await db.batch(MIGRATIONS.map(s=>db.prepare(s)));
  await seedMailbox(db,{id:"mbx_alice",accountId:alice.account.id,address:"alice@fixture.example",localPart:"alice"});
  await seedMailbox(db,{id:"mbx_bob",accountId:bob.account.id,address:"bob@fixture.example",localPart:"bob"});
  await seedMessage(db,{id:"message_a",mailboxId:"mbx_alice",accountId:alice.account.id,subject:"Synthetic owner message"});
  await seedMessage(db,{id:"message_b",mailboxId:"mbx_bob",accountId:bob.account.id,subject:"Synthetic other message"});
  const start=await mf.dispatchFetch(origin+"/auth/start",{redirect:"manual"});
  assert.equal(start.status,303);
  const authUrl=new URL(start.headers.get("location"));
  const page=await app.inject({method:"GET",url:authUrl.pathname+authUrl.search});
  assert.equal(page.statusCode,200,page.body);
  const fields=authUrl.searchParams;
  const cookie=String(page.headers["set-cookie"]).split(";")[0];
  fields.set("csrf_token",cookie.split("=")[1]);
  fields.set("manifest_revision","1");fields.set("username","alice");fields.set("password",password);
  const nativeSessions=context.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  const authorized=await app.inject({method:"POST",url:"/v1/oauth/authorize",headers:{cookie,"content-type":"application/x-www-form-urlencoded"},payload:fields.toString()});
  assert.equal(authorized.statusCode,303,authorized.body);
  const callback=await mf.dispatchFetch(String(authorized.headers.location),{redirect:"manual",headers:{cookie:cookies(start)}});
  assert.equal(callback.status,303,await callback.text());
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,nativeSessions);
  const webCookie=cookies(callback);
  const web=await mf.dispatchFetch(origin+"/api/mailboxes",{headers:{cookie:webCookie}});
  assert.equal(web.status,200,await web.clone().text());
  assert.deepEqual((await web.json()).mailboxes.map(m=>m.mailboxId),["mbx_alice"]);
  const catalog=await rpc("GET","/v1/application-services",alice.sessionToken);
  assert.equal(catalog.statusCode,200,catalog.body);
  const [service]=catalog.json().services;
  assert.equal(service.appId,appId);assert.equal(service.serviceId,"mail");
  assert.deepEqual(service.scopes,["whoyou.read"]);
  assert.deepEqual((await rpc("GET","/v1/application-services",bob.sessionToken)).json().services,[]);
  const path="/v1/application-services/"+appId+"/mail/credential";
  const body={resource:origin+"/mcp",expectedRevision:service.revision};
  assert.equal((await rpc("POST",path,bob.sessionToken,body)).statusCode,404);
  assert.equal((await rpc("POST",path,alice.sessionToken,{...body,resource:"https://other.example/mcp"})).statusCode,404);
  const issued=await rpc("POST",path,alice.sessionToken,body);
  assert.equal(issued.statusCode,200,issued.body);
  const ticket=issued.json().token;
  const client=new Client({name:"ops048-v1-local",version:"1.0.0"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(origin+"/mcp"),{requestInit:{headers:bearer(ticket)},
      fetch:(input,init)=>mf.dispatchFetch(typeof input==="string"?input:input instanceof URL?input.href:input.url,init)}));
    const tools=await client.listTools();
    assert.ok(tools.tools.some(t=>t.name==="whoyou_mail_search"));
    const whoami=await client.callTool({name:"whoyou_whoami",arguments:{}});
    assert.equal(whoami.structuredContent.accountId,alice.account.id);
    const mailboxes=await client.callTool({name:"whoyou_mailbox_list",arguments:{}});
    assert.deepEqual(mailboxes.structuredContent.identities.map(m=>m.mailboxId),["mbx_alice"]);
    const searched=await client.callTool({name:"whoyou_mail_search",arguments:{query:"Synthetic"}});
    assert.ok(!searched.isError,JSON.stringify(searched.structuredContent));
    const text=JSON.stringify(searched.structuredContent);
    assert.match(text,/Synthetic owner message/);assert.doesNotMatch(text,/Synthetic other message/);
    const denied=await client.callTool({name:"whoyou_mailbox_sync",arguments:{mailboxId:"mbx_alice"}});
    assert.equal(denied.structuredContent.error,"insufficient_scope");
    const revoked=await rpc("POST","/v1/account/application-authorizations/"+appId+"/revoke",alice.sessionToken);
    assert.equal(revoked.statusCode,204,revoked.body);
    assert.equal((await rpc("POST",path,alice.sessionToken,body)).statusCode,404);
    assert.equal((await mf.dispatchFetch(origin+"/api/mailboxes",{headers:{cookie:webCookie}})).status,502);
    const offline=await client.callTool({name:"whoyou_whoami",arguments:{}});
    assert.equal(offline.structuredContent.accountId,alice.account.id);
  } finally {await client.close();}
  assert.equal(legacyHits,0);
  console.log("PASS OPS-048 real Cloud Auth + workerd: registration, browser OAuth, V1 grants, signed JWT, read/isolation, write denial, revoke and offline expiry contract.");
} finally {
  await mf?.dispose();await app?.close();await context.app.close();context.db.close();rmSync(temp,{recursive:true,force:true});
}
