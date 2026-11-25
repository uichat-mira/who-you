// Operator-side application management, never imported into the Worker/browser.
// The canonical manifest is checked against runtime constants by the existing unit suite.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const manifest = JSON.parse(readFileSync(new URL("../config/mira-service-registry/who-you.json", import.meta.url), "utf8"));
export const AUTH_ORIGIN = "https://cloud-auth.tomzlab.cn";
const path = "/v1/application/services";
const validRevision = value => Number.isSafeInteger(value) && value > 0;
function record(value) {
	if (!value || !validRevision(value.revision) || typeof value.retired !== "boolean" ||
		value.definition?.serviceId !== manifest.serviceId ||
		value.definition.projectId !== manifest.projectId ||
		value.definition.audience !== manifest.audience ||
		!isDeepStrictEqual(value.definition.scopes, manifest.scopes)) throw new Error("Unexpected Who You declaration");
	return value;
}
export async function manageDeclaration({ token, action, transport = globalThis.fetch }) {
	if (!/^mca_admin_v1\.who-you-web\.[A-Za-z0-9_-]{43}$/.test(token ?? "")) throw new Error("Who You application management token required");
	if (!["status", "sync", "retire", "reactivate"].includes(action)) throw new Error("Expected status, sync, retire or reactivate");
	async function request(route, method = "GET", body) {
		let response;
		try {
			response = await transport(AUTH_ORIGIN + route, {
				method, redirect: "error",
				headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : {"content-type":"application/json"}) },
				...(body === undefined ? {} : {body:JSON.stringify(body)}),
				signal: globalThis.AbortSignal.timeout(15000),
			});
		} catch { throw new Error("Cloud Auth request failed; check status before retrying"); }
		if (!response.ok) throw new Error("Cloud Auth management HTTP " + response.status + "; check status before retrying");
		try { return await response.json(); }
		catch { throw new Error("Invalid Cloud Auth response"); }
	}
	const catalog = await request(path);
	if (!Array.isArray(catalog?.services)) throw new Error("Invalid declaration catalog");
	const matches = catalog.services.filter(item => item?.definition?.serviceId === manifest.serviceId);
	if (matches.length > 1) throw new Error("Duplicate declaration");
	const current = matches.length ? record(matches[0]) : null;
	if (action === "status") return { status: current ? (current.retired ? "retired" : "active") : "absent", revision: current?.revision ?? 0, matchesManifest: Boolean(current && isDeepStrictEqual(current.definition,manifest)) };
	if (action === "retire") {
		if (!current) throw new Error("No declaration to retire");
		if (current.retired) return {status:"retired",revision:current.revision};
		const result = record(await request(path + "/who-you/retire", "POST", {expectedRevision:current.revision}));
		if (!result.retired || result.revision !== current.revision + 1) throw new Error("Unexpected retirement result");
		return {status:"retired",revision:result.revision};
	}
	if (action === "reactivate" && !current?.retired) throw new Error("Reactivation requires a retired declaration");
	if (action === "sync" && current?.retired) throw new Error("Declaration retired; explicit reactivate required");
	if (current && !current.retired && isDeepStrictEqual(current.definition,manifest)) return {status:"active",revision:current.revision};
	const result = record(await request(path + "/who-you", "PUT", {definition:manifest,expectedRevision:current?.revision ?? 0}));
	if (result.retired || !isDeepStrictEqual(result.definition,manifest) || result.revision !== (current?.revision ?? 0) + 1) throw new Error("Unexpected declaration update result");
	return {status:"active",revision:result.revision};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const result = await manageDeclaration({token:process.env.WHOYOU_APPLICATION_MANAGEMENT_TOKEN,action:process.argv[2]});
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Declaration management failed");
		process.exitCode = 1;
	}
}
