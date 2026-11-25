import { test } from "node:test";
import assert from "node:assert/strict";
import { definition, manageDeclaration } from "../scripts/mira-service-registration.mjs";

const testToken = "mca_admin_v1.who-you-web." + "a".repeat(43);
test("publishes the canonical declaration with revision zero, then is idempotent", async () => {
  let current, writes = 0;
  const request = async (url, init) => {
    assert.equal(new URL(url).origin, "https://cloud-auth.tomzlab.cn");
    assert.equal(init.redirect, "error");
    if (init.method === "GET") return Response.json({services:current?[current]:[]});
    assert.equal(init.method, "PUT");
    assert.deepEqual(JSON.parse(init.body), {definition,expectedRevision:0});
    writes++;
    current = {definition,revision:1,retired:false};
    return Response.json(current);
  };
  assert.deepEqual(await manageDeclaration({token:testToken,action:"publish",request}),{serviceId:"who-you",revision:1,retired:false});
  await manageDeclaration({token:testToken,action:"publish",request});
  assert.equal(writes,1);
});
test("requires explicit reactivation and uses the current revision for retirement", async () => {
  let current={definition,revision:2,retired:false};
  const request=async (_url,init)=>{
    if(init.method==="GET")return Response.json({services:[current]});
    assert.equal(JSON.parse(init.body).expectedRevision,current.revision);
    current={definition,revision:current.revision+1,retired:init.method==="POST"};
    return Response.json(current);
  };
  await manageDeclaration({token:testToken,action:"retire",request});
  await assert.rejects(manageDeclaration({token:testToken,action:"publish",request}),/explicit reactivate/);
  assert.equal((await manageDeclaration({token:testToken,action:"reactivate",request})).revision,4);
});
test("does not retry conflicts or accept account sessions as publisher credentials", async()=>{
  let writes=0;
  const request=async (_url,init)=>{
    if(init.method==="GET")return Response.json({services:[]});
    writes++;
    return Response.json({error:{code:"APPLICATION_DECLARATION_CHANGED"}},{status:409});
  };
  await assert.rejects(manageDeclaration({token:testToken,action:"publish",request}),/409/);
  assert.equal(writes,1);
  await assert.rejects(manageDeclaration({token:"invalid",action:"publish",request}),/management credential/);
  assert.equal(writes,1);
});
