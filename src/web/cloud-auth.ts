import type { WhoYouEnv } from "../mail/config";
import { createWhoYouRuntime } from "../mcp/runtime";

const CLIENT_ID = "who-you-web";
const CALLBACK = "https://who-you.tomz.io/auth/callback";
const ORIGIN = new URL(CALLBACK).origin;
const STATE_COOKIE = "__Host-who_you_oauth";
const SESSION_COOKIE = "__Host-who_you_session";
const INSTALL_COOKIE = "__Host-who_you_installation";
type Flow = { state: string; verifier: string; installation: string; at: number };
type Session = { sessionToken: string; expiresAt: string };

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(value: string): Uint8Array {
  if (!/^[\w-]+$/.test(value)) throw new Error("invalid_encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const headers = () => new Headers({
  "cache-control": "no-store", "pragma": "no-cache", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff", "x-frame-options": "DENY",
});
function getCookie(req: Request, name: string): string | null {
  const items = (req.headers.get("cookie") ?? "").split(";")
    .map((x) => x.trim()).filter((x) => x.startsWith(name + "="));
  return items.length === 1 ? items[0]!.slice(name.length + 1) : null;
}
function addCookie(h: Headers, name: string, value: string, age: number): void {
  h.append("set-cookie", `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`);
}
function jsonError(status: number, message: string, outgoing = headers()): Response {
  const h = outgoing; h.set("content-type", "application/json");
  return new Response(JSON.stringify({ error: message }), { status, headers: h });
}
function redirect(location: string, h = headers()): Response {
  h.set("location", location);
  return new Response(null, { status: 303, headers: h });
}
async function importSessionKey(raw: string | undefined): Promise<CryptoKey | null> {
  if (!raw || raw.length > 128) return null;
  try {
    const bytes = decode(raw.replace(/=+$/, ""));
    if (bytes.length !== 32) return null;
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch { return null; }
}
async function seal(key: CryptoKey, data: Flow | Session): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ORIGIN) },
    key, new TextEncoder().encode(JSON.stringify(data)),
  ));
  const bytes = new Uint8Array(iv.length + encrypted.length);
  bytes.set(iv); bytes.set(encrypted, iv.length);
  return encode(bytes);
}
async function unseal(key: CryptoKey, raw: string | null): Promise<unknown> {
  if (!raw || raw.length > 6000) return null;
  try {
    const bytes = decode(raw);
    if (bytes.length < 29) return null;
    const clear = await crypto.subtle.decrypt({
      name: "AES-GCM", iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(ORIGIN),
    }, key, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(clear)) as unknown;
  } catch { return null; }
}
function validInstallation(v: unknown): v is string {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
}
function isFlow(v: unknown): v is Flow {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Partial<Flow>;
  return typeof x.state === "string" && /^[\w-]{43}$/.test(x.state)
    && typeof x.verifier === "string" && /^[\w-]{43}$/.test(x.verifier)
    && validInstallation(x.installation) && typeof x.at === "number"
    && x.at <= Date.now() && Date.now() - x.at < 300_000;
}
function isSession(v: unknown): v is Session {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Partial<Session>;
  return typeof x.sessionToken === "string" && x.sessionToken.length > 16
    && x.sessionToken.length < 4096 && typeof x.expiresAt === "string"
    && Number.isFinite(Date.parse(x.expiresAt)) && Date.parse(x.expiresAt) > Date.now();
}
function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;" })[c]!);
}
function page(content: string, outgoing = headers()): Response {
  const h = outgoing;
  h.set("content-type", "text/html; charset=utf-8");
  h.set("content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>狐邮 · Who You</title>
<style>body{background:#f8f8f8;color:#272727;font:16px/1.65 system-ui;padding:6vh 1rem}
main{max-width:460px;margin:auto;padding:36px;background:white;border:1px solid #e9e9e9;border-radius:12px}
h1{font:normal 32px Georgia,serif}p{color:#555}a,button{display:inline-block;background:#252525;color:white;text-decoration:none;border:0;border-radius:6px;padding:9px 16px;font:inherit;cursor:pointer}
code{overflow-wrap:anywhere}small{color:#777}</style></head><body><main><h1>狐邮 · Who You</h1>${content}</main></body></html>`, { headers: h });
}
function baseUrl(env: WhoYouEnv): string | null {
  try {
    const u = new URL(env.CLOUD_AUTH_ISSUER ?? "");
    return u.protocol === "https:" && u.pathname === "/" && !u.username && !u.password
      ? u.origin : null;
  } catch { return null; }
}
async function readIdentity(env: WhoYouEnv, session: Session): Promise<unknown | null> {
  const base = baseUrl(env);
  if (!base) return null;
  const r = await fetch(new URL("/v1/service-credentials", base), {
    method: "POST", headers: {
      authorization: `Bearer ${session.sessionToken}`,
      "content-type": "application/json",
    }, body: JSON.stringify({ audience: "mira:who-you" }),
  });
  if (!r.ok) return null;
  const issued = await r.json() as { token?: string };
  if (typeof issued.token !== "string") return null;
  const runtime = createWhoYouRuntime(env);
  if (!runtime.ok || !env.MCP_RESOURCE_URL) return null;
  try {
    const reply = await runtime.runtime.fetch(new Request(env.MCP_RESOURCE_URL, {
      method: "POST", headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call",
        "Mcp-Name": "whoyou_whoami",
        // This is a trusted in-process request, not a browser-supplied Host.
        host: new URL(env.MCP_RESOURCE_URL).host,
      }, body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: "whoyou_whoami", arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "who-you-web", version: "0.1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }));
    if (!reply.ok) return null;
    const body = await reply.json() as { result?: { structuredContent?: unknown } };
    const id = body.result?.structuredContent as Partial<{ accountId: string;
      consumerId: string; scopes: unknown[] }> | undefined;
    return typeof id?.accountId === "string" && typeof id.consumerId === "string"
      && Array.isArray(id.scopes) && id.scopes.every((x) => typeof x === "string")
      ? { accountId: id.accountId, consumerId: id.consumerId, scopes: id.scopes } : null;
  } finally { await runtime.runtime.close(); }
}

/** Isolated browser login/BFF. The existing /mcp bearer gate is unchanged. */
export async function handleWebRequest(request: Request, env: WhoYouEnv): Promise<Response | null> {
  const u = new URL(request.url), path = u.pathname;
  if (!["/", "/auth/start", "/auth/callback", "/auth/logout", "/account", "/api/whoami"].includes(path)) return null;
  if (u.origin !== ORIGIN) return jsonError(404, "not_found");
  const key = await importSessionKey(env.WHOYOU_WEB_SESSION_KEY), base = baseUrl(env);
  if (!key || !base) return jsonError(503, "web_login_not_configured");
  if (path === "/") {
    if (request.method !== "GET") return jsonError(405, "method_not_allowed");
    return page('<p>使用 Mira 云账号连接狐邮，无须手动复制凭证。</p><a href="/auth/start">使用 Mira 云账号登录</a><p><small>仅验证云认证，暂不启用邮件收发。</small></p>');
  }
  if (path === "/auth/start") {
    if (request.method !== "GET") return jsonError(405, "method_not_allowed");
    const prior = getCookie(request, INSTALL_COOKIE);
    const installation = validInstallation(prior) ? prior : crypto.randomUUID();
    const state = random(), verifier = random();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const h = headers();
    addCookie(h, STATE_COOKIE, await seal(key, { state, verifier, installation, at: Date.now() }), 300);
    addCookie(h, INSTALL_COOKIE, installation, 365 * 86400);
    const authorize = new URL("/v1/oauth/authorize", base);
    authorize.search = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: CALLBACK,
      state, code_challenge: encode(hash), code_challenge_method: "S256",
    }).toString();
    return redirect(authorize.href, h);
  }
  if (path === "/auth/callback") {
    if (request.method !== "GET") return jsonError(405, "method_not_allowed");
    const flow = await unseal(key, getCookie(request, STATE_COOKIE));
    const h = headers(); addCookie(h, STATE_COOKIE, "", 0);
    if (!isFlow(flow) || flow.state !== u.searchParams.get("state")
      || u.searchParams.has("error") || !u.searchParams.get("code"))
      return page('<p>登录已过期或验证失败。</p><a href="/">重新登录</a>', h);
    try {
      const r = await fetch(new URL("/v1/oauth/token", base), {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", client_id: CLIENT_ID,
          code: u.searchParams.get("code")!, redirect_uri: CALLBACK,
          code_verifier: flow.verifier, installation_id: flow.installation, platform: "web",
        }).toString(),
      });
      if (!r.ok) return jsonError(401, "cloud_auth_code_rejected", h);
      const issued = await r.json() as unknown;
      if (!isSession(issued)) return jsonError(502, "cloud_auth_invalid_session", h);
      const age = Math.min(3600, Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000));
      addCookie(h, SESSION_COOKIE, await seal(key, issued), age);
      return redirect("/account", h);
    } catch { return jsonError(502, "cloud_auth_unavailable", h); }
  }
  if (path === "/auth/logout") {
    if (request.method !== "POST") return jsonError(405, "method_not_allowed");
    if (request.headers.get("origin") !== ORIGIN) return jsonError(403, "origin_not_allowed");
    const raw = await unseal(key, getCookie(request, SESSION_COOKIE));
    const h = headers(); addCookie(h, SESSION_COOKIE, "", 0);
    if (isSession(raw)) {
      try {
        const r = await fetch(new URL("/v1/auth/logout", base), {
          method: "POST", headers: { authorization: `Bearer ${raw.sessionToken}` },
        });
        if (!r.ok && r.status !== 401) return jsonError(502, "logout_unconfirmed", h);
      } catch { return jsonError(502, "logout_unconfirmed", h); }
    }
    return redirect("/", h);
  }
  if (request.method !== "GET") return jsonError(405, "method_not_allowed");
  const session = await unseal(key, getCookie(request, SESSION_COOKIE));
  if (!isSession(session))
    return path === "/account" ? redirect("/") : jsonError(401, "sign_in_required");
  let identity: unknown;
  try { identity = await readIdentity(env, session); }
  catch { return jsonError(502, "authentication_link_unavailable"); }
  if (!identity) return jsonError(502, "authentication_link_unavailable");
  if (path === "/api/whoami") {
    const h = headers(); h.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(identity), { headers: h });
  }
  const id = identity as { accountId: string; consumerId: string; scopes: string[] };
  return page(`<p>已通过 Cloud Auth 身份验证，狐邮 MCP 已连接。</p>
<p>账号：<code>${escapeText(id.accountId)}</code></p>
<p>权限：${id.scopes.map(escapeText).join("、")}</p>
<form method="post" action="/auth/logout"><button type="submit">退出登录</button></form>
<p><small>这是云认证接线验收页，尚未启用邮件收发。</small></p>`);
}
