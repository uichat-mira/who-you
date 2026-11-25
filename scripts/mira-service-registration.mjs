// OPS-048: explicit service-side publication. Never runs as part of a user login,
// build, Worker startup, or default CI. The management bearer is not a user token.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const AUTH = "https://cloud-auth.tomzlab.cn";
const PATH = "/v1/application/services";
const SERVICE_ID = "who-you";
export const definition = JSON.parse(readFileSync(new URL("../config/mira-service-registry/who-you.json", import.meta.url), "utf8"));

function validateRecord(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.retired !== "boolean" || !value.definition ||
      typeof value.definition.serviceId !== "string") throw new Error("Invalid declaration response");
  return value;
}

export async function manageDeclaration({ token, action, request = globalThis.fetch }) {
  if (typeof token !== "string" || !/^mca_admin_v1\.who-you-web\.[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("Who You application management credential required");
  if (!["status", "publish", "retire", "reactivate"].includes(action)) throw new Error("Unknown declaration action");
  const call = async (path, method = "GET", body) => {
    const response = await request(AUTH + path, {
      method, redirect: "error", signal: globalThis.AbortSignal.timeout(10000),
      headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    // Never emit response bodies, headers, or exceptions that could expose secrets.
    if (!response.ok) throw new Error("Cloud Auth declaration request failed (HTTP " + response.status + ")");
    return response.json();
  };
  const catalog = await call(PATH);
  if (!Array.isArray(catalog?.services)) throw new Error("Invalid declaration catalog");
  const matches = catalog.services.map(validateRecord).filter(s => s.definition.serviceId === SERVICE_ID);
  if (matches.length > 1) throw new Error("Ambiguous declaration catalog");
  const current = matches[0];
  if (current && (current.definition.projectId !== definition.projectId ||
      current.definition.audience !== definition.audience ||
      !isDeepStrictEqual(current.definition.scopes, definition.scopes)))
    throw new Error("Declaration identity or scopes conflict; maintainer review required");
  if (action === "status") return current ? {serviceId:SERVICE_ID, revision:current.revision, retired:current.retired, matchesManifest:isDeepStrictEqual(current.definition,definition)} : {serviceId:SERVICE_ID, registered:false};
  if (action === "retire") {
    if (!current) throw new Error("No declaration to retire");
    if (current.retired) return {serviceId:SERVICE_ID, revision:current.revision, retired:true};
    const result = validateRecord(await call(PATH + "/" + SERVICE_ID + "/retire", "POST", {expectedRevision:current.revision}));
    if (!result.retired || result.revision !== current.revision + 1 ||
        !isDeepStrictEqual(result.definition,current.definition)) throw new Error("Unexpected retirement response");
    return {serviceId:SERVICE_ID, revision:result.revision, retired:true};
  }
  if (current?.retired && action !== "reactivate") throw new Error("Declaration retired; explicit reactivate required");
  if (action === "reactivate" && !current?.retired) throw new Error("No retired declaration to reactivate");
  if (current && !current.retired && isDeepStrictEqual(current.definition,definition))
    return {serviceId:SERVICE_ID,revision:current.revision,retired:false};
  const result = validateRecord(await call(PATH + "/" + SERVICE_ID, "PUT", {
    definition, expectedRevision:current?.revision ?? 0,
  }));
  if (result.retired || result.revision !== (current?.revision ?? 0) + 1 ||
      !isDeepStrictEqual(result.definition,definition)) throw new Error("Unexpected publication response");
  return {serviceId:SERVICE_ID,revision:result.revision,retired:false};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2];
    // No token in command arguments, no configurable destination, no redirect.
    const token = process.env.WHOYOU_APPLICATION_MANAGEMENT_TOKEN;
    console.log(JSON.stringify(await manageDeclaration({token,action})));
  } catch {
    console.error("Declaration operation failed. Inspect status and the approved manifest before retrying; no automatic retry or reactivation.");
    process.exitCode = 1;
  }
}
