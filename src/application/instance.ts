import { SERVICE_CAPABILITIES_MANIFEST } from "../mcp/service-capabilities";
import { WHOYOU_REQUIRED_SCOPE, WHOYOU_INSTANCE_SERVICE_ID } from "../mcp/config";
import { ApplicationSecretRepository, isValidAppSecret, verifyAppSecret } from "./app-secret";

export const APPLICATION_MANIFEST_PATH = "/.well-known/mira-application";
export const APPLICATION_VERIFY_PATH = "/mira/verify-registration";


export type ApplicationEnv = {
  WHOYOU_APP_ID?: string;
  WHOYOU_APP_SECRET?: string;
  WHOYOU_MANIFEST_REVISION?: string;
  MCP_RESOURCE_URL?: string;
  DB?: D1Database;
};

const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
export function resolveInstanceResource(env: ApplicationEnv): URL | null {
  try {
    const resource = new URL(env.MCP_RESOURCE_URL ?? "");
    if (resource.protocol !== "https:" || resource.pathname !== "/mcp" ||
        resource.username || resource.password || resource.search || resource.hash ||
        resource.href !== env.MCP_RESOURCE_URL) return null;
    return resource;
  } catch { return null; }
}

export function resolveApplicationInstance(env: ApplicationEnv) {
  const appId = env.WHOYOU_APP_ID;
  const revision = Number(env.WHOYOU_MANIFEST_REVISION);
  const secret = env.WHOYOU_APP_SECRET;
  if (!appId || !appIdPattern.test(appId) || !secret || !isValidAppSecret(secret) ||
      !Number.isSafeInteger(revision) || revision < 1) return null;
  const resource = resolveInstanceResource(env);
  if (!resource) return null;
  const origin = resource.origin;
  return { appId, origin, resource: resource.href, revision,
    clientId: origin + "/oauth-client", callback: origin + "/auth/callback" };
}

export function applicationManifest(instance: NonNullable<ReturnType<typeof resolveApplicationInstance>>) {
  const readCapabilities = SERVICE_CAPABILITIES_MANIFEST.capabilities.filter(
    capability => capability.access === "read" &&
      capability.requiredScopes.every(scope => scope === WHOYOU_REQUIRED_SCOPE),
  );
  return {
    schemaVersion: "1", appId: instance.appId, projectId: "who-you",
    name: "狐邮 Who You", homeUrl: instance.origin + "/",
    manifestRevision: instance.revision,
    oauth: { clientId: instance.clientId, redirectUris: [instance.callback] },
    registrationVerification: { endpoint: instance.origin + APPLICATION_VERIFY_PATH },
    services: [{
      serviceId: WHOYOU_INSTANCE_SERVICE_ID, name: "狐邮邮件服务", type: "mcp",
      protocol: { name: "mcp", version: "2026-07-28", endpoint: instance.resource },
      resource: instance.resource, scopes: [WHOYOU_REQUIRED_SCOPE],
      capabilities: readCapabilities.map(capability => ({
        id: capability.id, title: capability.title.slice(0, 100),
        description: capability.description.slice(0, 500), toolRefs: capability.tools,
      })),
      toolGovernance: readCapabilities.flatMap(capability => capability.tools.map(toolRef => ({
        toolRef, riskHints: ["sensitive-data-read"],
      }))),
    }],
  };
}

const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
});
const denied = () => json({ error: "registration_rejected" }, 403);

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0, body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) { await reader.cancel(); return null; }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch { return null; }
  finally { reader.releaseLock(); }
}

async function equalSecret(actual: string, expected: string) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([actual, expected].map(async value =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
  ));
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

/**
 * Registry authority is D1 once rotated. A missing DB binding, a failed read or
 * a malformed row rejects the proof: there is deliberately no fallback to the
 * deployment bootstrap secret after an instance has rotated.
 */
async function verifyCurrentAppSecret(env: ApplicationEnv, presented: string): Promise<boolean> {
  if (!env.DB) return false;
  try {
    const current = await new ApplicationSecretRepository(env.DB).current();
    return current.kind === "rotated"
      ? await verifyAppSecret(presented, current)
      : await equalSecret(presented, env.WHOYOU_APP_SECRET!);
  } catch {
    return false;
  }
}

/** Public declaration and same-origin, server-to-server registration proof.
 * No browser session, management token, or secret is returned or logged.
 */
export async function handleApplicationRequest(request: Request, env: ApplicationEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== APPLICATION_MANIFEST_PATH && url.pathname !== APPLICATION_VERIFY_PATH) return null;
  const instance = resolveApplicationInstance(env);
  if (!instance) return json({ error: "application_not_configured" }, 503);
  if (url.origin !== instance.origin || url.search) return json({ error: "not_found" }, 404);
  if (url.pathname === APPLICATION_MANIFEST_PATH) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return json(applicationManifest(instance));
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (request.headers.has("origin") ||
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return denied();
  const input = await boundedJson(request);
  if (!input || typeof input !== "object" || Array.isArray(input)) return denied();
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || fields.appId !== instance.appId ||
      !isValidAppSecret(fields.appSecret) ||
      !await verifyCurrentAppSecret(env, fields.appSecret)) return denied();
  return json({ ok: true, appId: instance.appId });
}
