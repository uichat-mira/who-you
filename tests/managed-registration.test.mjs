import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { manageDeclaration, AUTH_ORIGIN } from "../scripts/mira-service-registration.mjs";
const manifest = JSON.parse(readFileSync(new URL("../config/mira-service-registry/who-you.json",import.meta.url),"utf8"));
const token = "mca_admin_v1.who-you-web." + "x".repeat(43);
test("management reconciles by revision, never reactivates implicitly, and does not retry conflicts", async () => {
	let current = null, writes = 0, conflict = false;
	const transport = async (url, init) => {
		assert.ok(url.startsWith(AUTH_ORIGIN + "/v1/application/services"));
		assert.equal(init.redirect,"error");
		assert.equal(init.headers.authorization,"Bearer " + token);
		if(init.method==="GET") return Response.json({services:current?[current]:[]});
		writes++;
		const body=JSON.parse(init.body);
		assert.equal(body.expectedRevision,current?.revision??0);
		if(conflict) return Response.json({error:{code:"APPLICATION_DECLARATION_CHANGED"}},{status:409});
		current = {definition:body.definition??current.definition,revision:body.expectedRevision+1,retired:init.method==="POST"};
		return Response.json(current);
	};
	const run=action=>manageDeclaration({token,action,transport});
	assert.equal((await run("status")).status,"absent");
	assert.deepEqual(await run("sync"),{status:"active",revision:1});
	assert.deepEqual(current.definition,manifest);
	assert.deepEqual(await run("sync"),{status:"active",revision:1});
	assert.equal(writes,1);
	current.definition={...manifest,protocol:{...manifest.protocol,version:"old"}};
	assert.deepEqual(await run("sync"),{status:"active",revision:2});
	assert.deepEqual(await run("retire"),{status:"retired",revision:3});
	await assert.rejects(run("sync"),/explicit reactivate/);
	assert.deepEqual(await run("reactivate"),{status:"active",revision:4});
	current.definition={...manifest,protocol:{...manifest.protocol,version:"old"}};
	conflict=true;
	await assert.rejects(run("sync"),/HTTP 409/);
	assert.equal(writes,5);
});
test("invalid management authority never reaches network", async () => {
	await assert.rejects(manageDeclaration({token:"cloud-session",action:"sync",transport:()=>assert.fail("unexpected request")}),/management token required/);
});
