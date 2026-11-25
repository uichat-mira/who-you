// Disposable compiled-runtime smoke. Never uses a real account, DB or signing key.
import assert from "node:assert/strict";
import { manageDeclaration, AUTH_ORIGIN } from "../scripts/mira-service-registration.mjs";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { BASE_BINDINGS, MIGRATIONS, mfFetch, NOW, seedMailbox, seedMessage } from "./workerd-harness.mjs";
const MCP_TEST_JWKS_URL=AUTH_ORIGIN+"/.well-known/jwks.json";
// Local workerd transport uses its loopback resource; the OAuth callback and registered declaration retain the canonical HTTPS origin.
const MCP_TEST_RESOURCE_URL="https://127.0.0.1/mcp";
const WHO_ORIGIN="https://who-you.tomz.io";
// Required explicit checkout of the reviewed upstream contract. No production host.
const AUTH_CWD=process.env.OPS048_AUTH_API_DIR;
if (!AUTH_CWD) throw new Error("Set OPS048_AUTH_API_DIR to a compiled, isolated Cloud Auth apps/api checkout");
const expectedSha="6c48415f4f5f7180e12ddbf8d643374eb43f3b55";
assert.equal(execFileSync("git",["rev-parse","HEAD"],{cwd:AUTH_CWD,encoding:"utf8"}).trim(),expectedSha);
assert.equal(execFileSync("git",["status","--porcelain","--untracked-files=no"],{cwd:AUTH_CWD,encoding:"utf8"}).trim(),"");
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const directory = mkdtempSync(join(tmpdir(), "mira-registry-smoke-"));
const portProbe = createServer();
portProbe.listen(0, "127.0.0.1");
await once(portProbe, "listening");
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const { privateKey } = generateKeyPairSync("ed25519");
const env = {
  PATH: process.env.PATH ?? "",
  HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "error",
  MIRA_AUTH_DB_PATH: join(directory, "auth.sqlite"),
  MIRA_AUTH_SERVICE_CREDENTIAL_ACTIVE_KID: "isolated-smoke",
  MIRA_AUTH_SERVICE_CREDENTIAL_ACTIVE_PRIVATE_KEY: privateKey.export({type:"pkcs8",format:"pem"}).toString(),
  MIRA_AUTH_SERVICE_CREDENTIAL_TTL_SECONDS: "300",
};
const root = "http://127.0.0.1:" + port;
let runtime;
function admin(args, input = "") {
  return JSON.parse(execFileSync(process.execPath, ["dist/admin-cli.js", ...args], {env,input,encoding:"utf8",cwd:AUTH_CWD}));
}
async function request(path, token, body) {
  return globalThis.fetch(root + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {...(token ? {authorization:"Bearer " + token}:{}), ...(body === undefined ? {} : {"content-type":"application/json"})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    signal: globalThis.AbortSignal.timeout(5000),
  });
}
async function login(username, password) {
  const res = await request("/v1/auth/login", null, {username,password});
  assert.equal(res.status,200);
  const session = await res.json();
  const registration = await request("/v1/devices",session.sessionToken,{installationId:randomUUID(),platform:"mobile"});
  assert.equal(registration.status,200);
  const device = await registration.json();
  const bound = await request("/v1/auth/session",session.sessionToken);
  assert.equal(bound.status,200);
  assert.equal((await bound.json()).deviceId,device.id);
  return {...session,deviceId:device.id};
}
let mf;
async function connect(token) {
  const client = new Client({name:"ops048-real-issuer",version:"1"});
  const transport=new StreamableHTTPClientTransport(new URL(MCP_TEST_RESOURCE_URL),{requestInit:{headers:{authorization:"Bearer "+token,host:new URL(MCP_TEST_RESOURCE_URL).host}},fetch:mfFetch(mf)});
  await client.connect(transport);
  return client;
}
try {
  const password=randomBytes(32).toString("hex");
  const alice=admin(["provision","registry-smoke-a"],password);
  const bob=admin(["provision","registry-smoke-b"],password);
  const enrollment=admin(["application-enroll","who-you-web"],JSON.stringify({
    projectId:"who-you",displayName:"Who You",redirectUri:WHO_ORIGIN+"/auth/callback",endpointOrigins:[WHO_ORIGIN],
  }));
  const transport=(url,init)=>globalThis.fetch(root+new URL(url).pathname,init);
  const manage=action=>manageDeclaration({token:enrollment.managementToken,action,transport});
  runtime=spawn(process.execPath,["dist/server.js"],{env,cwd:AUTH_CWD,stdio:"ignore"});
  for(let i=0;i<30;i++){try{if((await request("/ready")).ok)break;}catch{/* wait for local readiness */} await delay(200);}
  assert.equal((await request("/ready")).status,200);
  assert.deepEqual(await manage("sync"),{status:"active",revision:1});
  assert.deepEqual(await manage("sync"),{status:"active",revision:1});
  const a=await login("registry-smoke-a",password), b=await login("registry-smoke-b",password);
  assert.deepEqual((await (await request("/v1/services",a.sessionToken)).json()).services,[]);
  assert.deepEqual((await (await request("/v1/services",b.sessionToken)).json()).services,[]);
  assert.equal((await request("/v1/services/who-you/credential",b.sessionToken,{expectedRevision:1})).status,404);
  let jwksHits=0, exchanges=0;
  mf=new Miniflare({modules:true,scriptPath:"dist/worker.mjs",compatibilityDate:"2026-08-06",cf:false,bindings:{
    ...BASE_BINDINGS,MCP_RESOURCE_URL:MCP_TEST_RESOURCE_URL,CLOUD_AUTH_ISSUER:AUTH_ORIGIN,CLOUD_AUTH_JWKS_URL:MCP_TEST_JWKS_URL,
    WHOYOU_WEB_SESSION_KEY:randomBytes(32).toString("base64url"),
  },d1Databases:["DB"],r2Buckets:["MAIL_BUCKET"],outboundService:async req=>{
    const url=new URL(req.url);
    if(url.origin!==AUTH_ORIGIN) return new Response("not found",{status:404});
    if(url.pathname==="/.well-known/jwks.json") jwksHits++;
    if(url.pathname==="/v1/oauth/token") exchanges++;
    // Real compiled issuer for every BFF auth, signing and JWKS request.
    return globalThis.fetch(root+url.pathname+url.search,{
      method:req.method,headers:req.headers,
      ...(req.method==="GET"||req.method==="HEAD"?{}:{body:await req.arrayBuffer()}),redirect:"manual",
    });
  }});
  const cookie=res=>res.headers.getSetCookie().map(x=>x.split(";")[0]).join("; ");
  const browserLogin=async username=>{
    const begin=await mf.dispatchFetch(WHO_ORIGIN+"/auth/start",{redirect:"manual"});
    assert.equal(begin.status,303);
    const authorization=new URL(begin.headers.get("location"));
    assert.equal(authorization.origin,AUTH_ORIGIN);
    const page=await globalThis.fetch(root+authorization.pathname+authorization.search,{redirect:"manual"});
    assert.equal(page.status,200);
    const csrf=cookie(page);
    const form=new globalThis.URLSearchParams(authorization.search);
    form.set("csrf_token",csrf.split("=")[1]);
    form.set("username",username);form.set("password",password);
    const approved=await globalThis.fetch(root+authorization.pathname,{method:"POST",headers:{cookie:csrf,"content-type":"application/x-www-form-urlencoded"},body:form,redirect:"manual"});
    assert.equal(approved.status,303);
    const callback=new URL(approved.headers.get("location"));
    assert.equal(callback.origin,WHO_ORIGIN);
    const result=await mf.dispatchFetch(callback.href,{redirect:"manual",headers:{cookie:cookie(begin)}});
    assert.equal(result.status,303);
    return cookie(result);
  };
  const webCookie=await browserLogin("registry-smoke-a");
  const account=await mf.dispatchFetch(WHO_ORIGIN+"/api/whoami",{headers:{cookie:webCookie}});
  assert.equal(account.status,200);
  assert.equal((await account.json()).accountId,alice.id);
  const catalog=await (await request("/v1/services",a.sessionToken)).json();
  assert.equal(catalog.services.length,1);
  assert.equal(catalog.services[0].definition.serviceId,"who-you");
  assert.equal(catalog.services[0].revision,1);
  assert.deepEqual((await (await request("/v1/services",b.sessionToken)).json()).services,[]);
  const issue=await request("/v1/services/who-you/credential",a.sessionToken,{expectedRevision:1});
  assert.equal(issue.status,200);
  const bearer=await issue.json();
  const db=await mf.getD1Database("DB"); await db.batch(MIGRATIONS.map(s=>db.prepare(s)));
  await seedMailbox(db,{id:"mbx_a",accountId:alice.id,address:"alpha@tomlab.cn",localPart:"alpha"});
  // A second account may have mail data but no service grant. A third
  // enrolled account with no mailbox must receive an empty read surface.
  const empty=admin(["provision","registry-smoke-empty"],password);
  const emptySession=await login("registry-smoke-empty",password);
  await browserLogin("registry-smoke-empty");
  const emptyIssue=await request("/v1/services/who-you/credential",emptySession.sessionToken,{expectedRevision:1});
  assert.equal(emptyIssue.status,200);
  const emptyClient=await connect((await emptyIssue.json()).token);
  try {
    const id=await emptyClient.callTool({name:"whoyou_whoami",arguments:{}});
    assert.equal(id.structuredContent.accountId,empty.id);
    const search=await emptyClient.callTool({name:"whoyou_mail_search",arguments:{limit:1}});
    assert.deepEqual(search.structuredContent.messages,[]);
  } finally {await emptyClient.close();}
  await seedMailbox(db,{id:"mbx_b",accountId:bob.id,address:"beta@tomlab.cn",localPart:"beta"});
  await seedMessage(db,{id:"msg_a1",mailboxId:"mbx_a",accountId:alice.id,subject:"Disposable fixture alpha",receivedAt:NOW});
  await seedMessage(db,{id:"msg_b1",mailboxId:"mbx_b",accountId:bob.id,subject:"Disposable fixture beta",receivedAt:NOW});
  const client=await connect(bearer.token);
  try {
    const who=await client.callTool({name:"whoyou_whoami",arguments:{}});
    assert.equal(who.structuredContent.accountId,alice.id);
    assert.equal(who.structuredContent.consumerId,alice.id);
    assert.deepEqual(who.structuredContent.scopes,["whoyou.read"]);
    assert.ok(jwksHits>0);
    const own=await client.callTool({name:"whoyou_mail_search",arguments:{limit:1}});
    assert.equal(own.structuredContent.messages.length,1);
    const foreign=await client.callTool({name:"whoyou_mail_message_get",arguments:{messageId:"msg_b1"}});
    assert.equal(foreign.structuredContent.error,"message_not_found");
    const write=await client.callTool({name:"whoyou_mail_flag_set",arguments:{messageId:"msg_a1",read:true}});
    assert.equal(write.structuredContent.error,"insufficient_scope");
    const legacyWrite=await request("/v1/service-credentials",a.sessionToken,{audience:"mira:who-you",scopes:["whoyou.read","whoyou.mail.write"]});
    assert.equal(legacyWrite.status,200);
    const again=await browserLogin("registry-smoke-a");
    const logout=await mf.dispatchFetch(WHO_ORIGIN+"/auth/logout",{method:"POST",redirect:"manual",headers:{origin:WHO_ORIGIN,cookie:again}});
    assert.equal(logout.status,303);
    assert.equal((await (await request("/v1/services",a.sessionToken)).json()).services[0].revision,1);
    const revoked=await request("/v1/services/who-you/revoke",a.sessionToken,{expectedRevision:1});
    assert.equal(revoked.status,200);
    assert.equal((await revoked.json()).revision,2);
    assert.equal((await request("/v1/service-credentials",a.sessionToken,{audience:"mira:who-you"})).status,409);
    assert.equal((await request("/v1/services/who-you/credential",a.sessionToken,{expectedRevision:1})).status,404);
    assert.deepEqual((await (await request("/v1/services",a.sessionToken)).json()).services,[]);
    assert.equal((await mf.dispatchFetch(WHO_ORIGIN+"/api/whoami",{headers:{cookie:webCookie}})).status,502);
    const recovery=await mf.dispatchFetch(WHO_ORIGIN+"/account",{headers:{cookie:webCookie}});
    assert.equal(recovery.status,502);
    assert.match(await recovery.text(),/href="\/auth\/start\?returnTo=%2Faccount"/);
    assert.deepEqual((await (await request("/v1/services",a.sessionToken)).json()).services,[]);
    const offline=await client.callTool({name:"whoyou_whoami",arguments:{}});
    assert.equal(offline.structuredContent.accountId,alice.id);
    await delay(10);
    const restored=await browserLogin("registry-smoke-a");
    assert.equal((await mf.dispatchFetch(WHO_ORIGIN+"/api/whoami",{headers:{cookie:restored}})).status,200);
    assert.equal((await (await request("/v1/services",a.sessionToken)).json()).services[0].revision,3);
    assert.equal((await request("/v1/services/who-you/credential",a.sessionToken,{expectedRevision:3})).status,200);
    assert.ok(exchanges>=3);
    await manage("retire");
    assert.deepEqual((await (await request("/v1/services",a.sessionToken)).json()).services,[]);
    assert.equal((await request("/v1/service-credentials",a.sessionToken,{audience:"mira:who-you"})).status,409);
  } finally {await client.close();}
  console.log("OPS-048 REAL MANAGED ISSUER + WORKER PASS: application API, BFF OAuth+PKCE, directory, EdDSA/JWKS, MCP isolation, repeat/logout/revoke/relogin/retire");
} finally {
  if(mf) await mf.dispose();
  if(runtime && runtime.exitCode===null){runtime.kill();await once(runtime,"exit");}
  rmSync(directory,{recursive:true,force:true});
}
