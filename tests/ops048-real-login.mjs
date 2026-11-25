// Disposable compiled-runtime smoke. Never uses a real account, DB or signing key.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";
import { definition as service, manageDeclaration } from "../scripts/mira-service-registration.mjs";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { BASE_BINDINGS, MIGRATIONS, mfFetch, NOW, seedMailbox, seedMessage } from "./workerd-harness.mjs";
const ORIGIN = "https://who-you.tomz.io";
const ISSUER = "https://cloud-auth.tomzlab.cn";
const AUTH_CWD = process.env.OPS048_CLOUD_AUTH_API_DIR;
const AUTH_NODE = process.env.OPS048_CLOUD_AUTH_NODE ?? process.execPath;
const expectedSha = process.env.OPS048_CLOUD_AUTH_SHA;
assert.ok(AUTH_CWD, "Provide compiled Cloud Auth apps/api checkout");
assert.match(expectedSha ?? "", /^[0-9a-f]{40}$/);
assert.equal(execFileSync("git", ["rev-parse","HEAD"], {cwd:AUTH_CWD,encoding:"utf8"}).trim(), expectedSha);
assert.equal(execFileSync("git", ["status","--porcelain","--untracked-files=no"], {cwd:AUTH_CWD,encoding:"utf8"}).trim(), "");
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
  return JSON.parse(execFileSync(AUTH_NODE, ["dist/admin-cli.js", ...args], {env,input,encoding:"utf8",cwd:AUTH_CWD}));
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
  const transport=new StreamableHTTPClientTransport(new URL("https://127.0.0.1/mcp"),{requestInit:{headers:{authorization:"Bearer "+token}},fetch:mfFetch(mf)});
  await client.connect(transport);
  return client;
}
try {
  const password=randomBytes(32).toString("hex");
  const alice=admin(["provision","registry-smoke-a"],password);
  const bob=admin(["provision","registry-smoke-b"],password);
  const enrollment = admin(["application-enroll","who-you-web"],JSON.stringify({
    projectId:"who-you",displayName:"Who You",redirectUri:ORIGIN+"/auth/callback",endpointOrigins:[ORIGIN],
  }));
  const manage = action => manageDeclaration({token:enrollment.managementToken,action,request:(url,init)=>{
    const target=new URL(url); assert.equal(target.origin,ISSUER);
    return globalThis.fetch(root+target.pathname+target.search,init);
  }});
  runtime=spawn(AUTH_NODE,["dist/server.js"],{env,cwd:AUTH_CWD,stdio:"ignore"});
  for(let i=0;i<30;i++){try{if((await request("/ready")).ok)break;}catch{/* waiting for disposable server */} await delay(200);}
  assert.equal((await request("/ready")).status,200);
  const a=await login("registry-smoke-a",password), b=await login("registry-smoke-b",password);
  assert.deepEqual(await manage("publish"),{serviceId:"who-you",revision:1,retired:false});
  assert.deepEqual(await manage("publish"),{serviceId:"who-you",revision:1,retired:false});
  const catalogFor=async token=>(await (await request("/v1/services",token)).json()).services;
  assert.deepEqual(await catalogFor(a.sessionToken),[]);
  assert.deepEqual(await catalogFor(b.sessionToken),[]);
  let jwksHits=0;
  // Miniflare uses a loopback Host for MCP requests. The real BFF still
  // generates the canonical exact HTTPS OAuth callback. No public traffic.
  mf=new Miniflare({modules:true,scriptPath:"dist/worker.mjs",compatibilityDate:"2026-08-06",cf:false,
    bindings:{...BASE_BINDINGS,WHOYOU_WEB_SESSION_KEY:Buffer.alloc(32,9).toString("base64url"),MCP_RESOURCE_URL:"https://127.0.0.1/mcp",CLOUD_AUTH_ISSUER:ISSUER,CLOUD_AUTH_JWKS_URL:ISSUER+"/.well-known/jwks.json"},
    d1Databases:["DB"],r2Buckets:["MAIL_BUCKET"],outboundService:async req=>{
      const target=new URL(req.url);
      if(target.origin!==ISSUER)return new Response("blocked",{status:403});
      if(target.pathname==="/.well-known/jwks.json")jwksHits++;
      return globalThis.fetch(root+target.pathname+target.search,{method:req.method,headers:req.headers,redirect:"manual",...(req.method==="GET"?{}:{body:await req.text()})});
    }});
  const cookieHeader=res=>res.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");
  const webLogin=async username=>{
    const start=await mf.dispatchFetch(ORIGIN+"/auth/start",{redirect:"manual"});
    assert.equal(start.status,303);
    const authorize=new URL(start.headers.get("location"));
    assert.equal(authorize.origin,ISSUER);
    const page=await globalThis.fetch(root+authorize.pathname+authorize.search);
    assert.equal(page.status,200);
    const csrf=cookieHeader(page);
    const form=new URLSearchParams(authorize.search);
    form.set("csrf_token",csrf.split("=")[1]);
    form.set("username",username);form.set("password",password);
    const consent=await globalThis.fetch(root+authorize.pathname,{method:"POST",redirect:"manual",headers:{cookie:csrf,"content-type":"application/x-www-form-urlencoded"},body:form.toString()});
    assert.equal(consent.status,303);
    const callback=new URL(consent.headers.get("location"));
    assert.equal(callback.origin,ORIGIN);
    const logged=await mf.dispatchFetch(callback.href,{redirect:"manual",headers:{cookie:cookieHeader(start)}});
    assert.equal(logged.status,303);
    return cookieHeader(logged);
  };
  const webCookie=await webLogin("registry-smoke-a");
  const account=await mf.dispatchFetch(ORIGIN+"/account",{redirect:"manual",headers:{cookie:webCookie}});
  assert.equal(account.status,200);assert.match(await account.text(),/whoyou.read/);
  assert.deepEqual(await catalogFor(a.sessionToken),[{definition:service,revision:1}]);
  assert.deepEqual(await catalogFor(b.sessionToken),[]);
  assert.equal((await request("/v1/services/who-you/credential",b.sessionToken,{expectedRevision:1})).status,404);
  const issue=await request("/v1/services/who-you/credential",a.sessionToken,{expectedRevision:1});
  assert.equal(issue.status,200);
  const bearer=await issue.json();
  const db=await mf.getD1Database("DB"); await db.batch(MIGRATIONS.map(s=>db.prepare(s)));
  const client=await connect(bearer.token);
  try {
    const who=await client.callTool({name:"whoyou_whoami",arguments:{}});
    assert.equal(who.structuredContent.accountId,alice.id);
    assert.equal(who.structuredContent.consumerId,alice.id);
    assert.deepEqual(who.structuredContent.scopes,["whoyou.read"]);
    assert.ok(jwksHits>0);
    const empty=await client.callTool({name:"whoyou_mail_search",arguments:{limit:1}});
    assert.equal(empty.structuredContent.messages.length,0);
    await seedMailbox(db,{id:"mbx_a",accountId:alice.id,address:"alpha@tomlab.cn",localPart:"alpha"});
    await seedMailbox(db,{id:"mbx_b",accountId:bob.id,address:"beta@tomlab.cn",localPart:"beta"});
    await seedMessage(db,{id:"msg_a1",mailboxId:"mbx_a",accountId:alice.id,subject:"Disposable fixture alpha",receivedAt:NOW});
    await seedMessage(db,{id:"msg_b1",mailboxId:"mbx_b",accountId:bob.id,subject:"Disposable fixture beta",receivedAt:NOW});
    const own=await client.callTool({name:"whoyou_mail_search",arguments:{limit:1}});
    assert.equal(own.structuredContent.messages.length,1);
    const foreign=await client.callTool({name:"whoyou_mail_message_get",arguments:{messageId:"msg_b1"}});
    assert.equal(foreign.structuredContent.error,"message_not_found");
    const write=await client.callTool({name:"whoyou_mail_flag_set",arguments:{messageId:"msg_a1",read:true}});
    assert.equal(write.structuredContent.error,"insufficient_scope");
    const repeated=await webLogin("registry-smoke-a");
    assert.equal((await catalogFor(a.sessionToken))[0].revision,1);
    assert.equal((await mf.dispatchFetch(ORIGIN+"/auth/logout",{method:"POST",headers:{origin:ORIGIN,cookie:repeated},redirect:"manual"})).status,303);
    assert.equal((await catalogFor(a.sessionToken))[0].revision,1);
    assert.equal((await request("/v1/services/who-you/revoke",a.sessionToken,{expectedRevision:1})).status,200);
    assert.equal((await request("/v1/service-credentials",a.sessionToken,{audience:"mira:who-you"})).status,409);
    assert.equal((await mf.dispatchFetch(ORIGIN+"/account",{redirect:"manual",headers:{cookie:webCookie}})).status,502);
    assert.equal((await request("/v1/services/who-you/credential",a.sessionToken,{expectedRevision:1})).status,404);
    assert.deepEqual((await (await request("/v1/services",a.sessionToken)).json()).services,[]);
    const offline=await client.callTool({name:"whoyou_whoami",arguments:{}});
    assert.equal(offline.structuredContent.accountId,alice.id);
    await delay(10);
    const restored=await webLogin("registry-smoke-a");
    assert.equal((await mf.dispatchFetch(ORIGIN+"/account",{headers:{cookie:restored}})).status,200);
    assert.equal((await catalogFor(a.sessionToken))[0].revision,3);
    assert.equal((await request("/v1/services/who-you/credential",a.sessionToken,{expectedRevision:3})).status,200);
    assert.equal((await manage("retire")).retired,true);
    assert.deepEqual(await catalogFor(a.sessionToken),[]);
    await assert.rejects(manage("publish"));
    assert.equal((await manage("reactivate")).revision,3);
    assert.deepEqual(await catalogFor(a.sessionToken),[]);
  } finally {await client.close();}
  console.log("OPS-048 PASS: real management API, workerd BFF login, OAuth PKCE, device-bound directory, actual EdDSA/JWKS and MCP, account isolation, revoke/relogin and retirement");
} finally {
  if(mf) await mf.dispose();
  if(runtime && runtime.exitCode===null){runtime.kill();await once(runtime,"exit");}
  rmSync(directory,{recursive:true,force:true});
}
