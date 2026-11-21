import type { WhoYouEnv } from "../mail/config";
import { createWhoYouRuntime } from "../mcp/runtime";
import { normalizeDomain } from "../mail/address";
import { resolveCredentialKeys } from "../mail/config";
import { resolveGmailOAuthConfig } from "../mail/gmail-link";
import { resolveMicrosoftOAuthConfig } from "../mail/microsoft-link";

const CLIENT_ID = "who-you-web";
const CALLBACK = "https://who-you.tomz.io/auth/callback";
const ORIGIN = new URL(CALLBACK).origin;
const STATE_COOKIE = "__Host-who_you_oauth";
const SESSION_COOKIE = "__Host-who_you_session";
const INSTALL_COOKIE = "__Host-who_you_installation";
type Flow = { state: string; verifier: string; installation: string; at: number };
type Session = { sessionToken: string; expiresAt: string };

type ToolCallResult =
  | { ok: true; structured: unknown }
  | { ok: false; reason: "authentication_link_unavailable" }
  | { ok: false; reason: "not_configured"; detail: string };

type MailboxAvailability =
  | "configured"
  | "service_unavailable"
  | "disabled"
  | "reauth_required"
  | "credential_unavailable"
  | "credential_missing";

type WebMailbox = {
  mailboxId: string;
  address: string;
  kind: "own_domain" | "third_party";
  provider: "gmail" | "microsoft" | "imap_smtp" | null;
  credentialStatus: "active" | "reauth_required" | "unreadable" | "revoked" | null;
  availability: MailboxAvailability;
};

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
function jsonError(status: number, message: string, outgoing = headers(),
  extra?: Record<string, string>): Response {
  const h = outgoing; h.set("content-type", "application/json");
  return new Response(JSON.stringify({ error: message, ...extra }), { status, headers: h });
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
function page(content: string, outgoing = headers(), status = 200): Response {
  const h = outgoing;
  h.set("content-type", "text/html; charset=utf-8");
  h.set("content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>狐邮 · Who You</title>
<style>body{background:#f8f8f8;color:#272727;font:16px/1.65 system-ui;padding:6vh 1rem}
main{max-width:460px;margin:auto;padding:36px;background:white;border:1px solid #e9e9e9;border-radius:12px}
h1{font:normal 32px Georgia,serif}h2{font-size:20px;margin:28px 0 10px}p{color:#555}
a,button{display:inline-flex;align-items:center;min-height:44px;box-sizing:border-box;background:#252525;color:white;text-decoration:none;border:0;border-radius:6px;padding:9px 16px;font:inherit;cursor:pointer}
a:focus-visible,button:focus-visible{outline:3px solid #1a5fd0;outline-offset:2px}
button[disabled]{background:#e2e2e2;color:#666;cursor:not-allowed}
code{overflow-wrap:anywhere}.topnav{margin-bottom:12px}.topnav a{background:none;color:#1a5fd0;padding:0}
.mailboxes,.providers{list-style:none;margin:0;padding:0}
.mailbox,.providers li{border:1px solid #e9e9e9;border-radius:8px;padding:14px;margin:0 0 12px}
.address{overflow-wrap:anywhere;margin:0 0 6px}.meta{margin:0 0 6px;color:#333}
.hint{color:#666;font-size:14px;margin:4px 0 0}
.pill{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:1px 10px;font-size:14px;line-height:1.5}
.pill.ok{color:#1d6b32}.pill.warn{color:#8a5300}.pill.bad{color:#a11c1c}.pill.muted{color:#666}
.notice{background:#f4f6fa;border:1px solid #dbe2ef;border-radius:8px;padding:14px}
.notice.error{background:#fdf2f2;border-color:#f0c9c9}
small{color:#777}
@media (max-width:420px){body{padding:3vh .75rem}main{padding:20px}h1{font-size:26px}}</style></head><body><main><h1>狐邮 · Who You</h1>${content}</main></body></html>`, { status, headers: h });
}
function baseUrl(env: WhoYouEnv): string | null {
  try {
    const u = new URL(env.CLOUD_AUTH_ISSUER ?? "");
    return u.protocol === "https:" && u.pathname === "/" && !u.username && !u.password
      ? u.origin : null;
  } catch { return null; }
}
/**
 * Calls one MCP tool with a server-side service credential derived from the
 * browser session. The credential never leaves this Worker: the browser only
 * holds the sealed session cookie.
 */
async function callWhoYouTool(
  env: WhoYouEnv,
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const base = baseUrl(env);
  if (!base) return { ok: false, reason: "not_configured", detail: "cloud_auth_issuer" };
  let issued: { token?: string };
  try {
    const r = await fetch(new URL("/v1/service-credentials", base), {
      method: "POST", headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      }, body: JSON.stringify({ audience: "mira:who-you" }),
    });
    if (!r.ok) return { ok: false, reason: "authentication_link_unavailable" };
    issued = await r.json() as { token?: string };
  } catch {
    return { ok: false, reason: "authentication_link_unavailable" };
  }
  if (typeof issued.token !== "string") return { ok: false, reason: "authentication_link_unavailable" };

  const runtime = createWhoYouRuntime(env);
  if (!runtime.ok) return { ok: false, reason: "not_configured", detail: runtime.reason };
  if (!env.MCP_RESOURCE_URL) return { ok: false, reason: "not_configured", detail: "mcp_resource_url" };
  // The runtime is cached per isolate and shared with `/mcp`; closing it after
  // one BFF call would break every later call in the same isolate.
  try {
    const reply = await runtime.runtime.fetch(new Request(env.MCP_RESOURCE_URL, {
      method: "POST", headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call",
        "Mcp-Name": name,
        // This is a trusted in-process request, not a browser-supplied Host.
        host: new URL(env.MCP_RESOURCE_URL).host,
      }, body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name, arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "who-you-web", version: "0.1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }));
    if (!reply.ok) return { ok: false, reason: "authentication_link_unavailable" };
    const body = await reply.json() as {
      result?: { structuredContent?: unknown; isError?: boolean };
    };
    if (body.result?.isError) return { ok: false, reason: "authentication_link_unavailable" };
    return { ok: true, structured: body.result?.structuredContent };
  } catch {
    return { ok: false, reason: "authentication_link_unavailable" };
  }
}

async function readIdentity(env: WhoYouEnv, session: Session): Promise<unknown | null> {
  const called = await callWhoYouTool(env, session, "whoyou_whoami", {});
  if (!called.ok) return null;
  const id = called.structured as Partial<{ accountId: string;
    consumerId: string; scopes: unknown[] }> | undefined;
  return typeof id?.accountId === "string" && typeof id.consumerId === "string"
    && Array.isArray(id.scopes) && id.scopes.every((x) => typeof x === "string")
    ? { accountId: id.accountId, consumerId: id.consumerId, scopes: id.scopes } : null;
}

/**
 * Availability is a *local capability/configuration* statement, not a claim
 * that a remote provider was successfully contacted. A linked credential row
 * is never proof that its decryption key or OAuth client exists in this Worker.
 */
const mailboxAvailability = (
  kind: "own_domain" | "third_party",
  status: "active" | "disabled",
  credentialStatus: WebMailbox["credentialStatus"],
  provider: WebMailbox["provider"],
  env: WhoYouEnv,
): MailboxAvailability => {
  if (status === "disabled") return "disabled";
  if (kind === "own_domain") {
    return normalizeDomain(env.MAIL_DOMAIN ?? "") ? "configured" : "service_unavailable";
  }
  if (credentialStatus === "reauth_required") return "reauth_required";
  if (credentialStatus === "unreadable" || credentialStatus === "revoked") {
    return "credential_unavailable";
  }
  if (credentialStatus !== "active") return "credential_missing";
  if (!resolveCredentialKeys(env)) return "credential_unavailable";
  if (provider === "gmail" && !resolveGmailOAuthConfig(env)) return "service_unavailable";
  if (provider === "microsoft" && !resolveMicrosoftOAuthConfig(env)) return "service_unavailable";
  return "configured";
};

/** Whitelists the server list into the six fields the browser is allowed to see. */
function projectMailboxes(value: unknown, env: WhoYouEnv): WebMailbox[] | null {
  if (typeof value !== "object" || value === null) return null;
  const identities = (value as { identities?: unknown }).identities;
  if (!Array.isArray(identities)) return null;
  const projected: WebMailbox[] = [];
  for (const entry of identities) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.mailboxId !== "string" || typeof item.address !== "string") return null;
    if (item.kind !== "own_domain" && item.kind !== "third_party") return null;
    if (item.provider !== null && item.provider !== "gmail"
      && item.provider !== "microsoft" && item.provider !== "imap_smtp") return null;
    if (item.status !== "active" && item.status !== "disabled") return null;
    const credentialStatus = item.credentialStatus;
    if (credentialStatus !== null && credentialStatus !== "active"
      && credentialStatus !== "reauth_required" && credentialStatus !== "unreadable"
      && credentialStatus !== "revoked") return null;
    projected.push({
      mailboxId: item.mailboxId,
      address: item.address,
      kind: item.kind,
      provider: item.provider,
      credentialStatus,
      availability: mailboxAvailability(item.kind, item.status, credentialStatus, item.provider, env),
    });
  }
  return projected;
}

type MailboxListOutcome =
  | { ok: true; mailboxes: WebMailbox[] }
  | {
    ok: false;
    error: "authentication_link_unavailable" | "mailbox_list_invalid" | "mailboxes_unavailable";
    reason?: string;
  };

async function fetchMailboxList(env: WhoYouEnv, session: Session): Promise<MailboxListOutcome> {
  const listed = await callWhoYouTool(env, session, "whoyou_mailbox_list", {});
  if (!listed.ok) {
    return listed.reason === "not_configured"
      ? { ok: false, error: "mailboxes_unavailable", reason: listed.detail }
      : { ok: false, error: "authentication_link_unavailable" };
  }
  const mailboxes = projectMailboxes(listed.structured, env);
  if (!mailboxes) return { ok: false, error: "mailbox_list_invalid" };
  // Storage bindings alone do not mean this preview can actually manage mail.
  // With no account identities and no configured provider/own-domain capability,
  // an empty D1 is not evidence that a usable mail service is available.
  if (mailboxes.length === 0 && !normalizeDomain(env.MAIL_DOMAIN ?? "")
      && !resolveCredentialKeys(env)) {
    return { ok: false, error: "mailboxes_unavailable",
      reason: "mail_service_not_configured" };
  }
  return { ok: true, mailboxes };
}

async function handleMailboxList(
  request: Request,
  env: WhoYouEnv,
  session: Session,
  url: URL,
): Promise<Response> {
  if ([...url.searchParams.keys()].length > 0) return jsonError(400, "unexpected_parameter");
  if (request.headers.has("authorization")) return jsonError(400, "unexpected_authorization");
  const outcome = await fetchMailboxList(env, session);
  if (!outcome.ok) {
    return outcome.error === "mailboxes_unavailable"
      ? jsonError(503, "mailboxes_unavailable", headers(), { reason: outcome.reason ?? "" })
      : jsonError(502, outcome.error);
  }
  const h = headers(); h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ mailboxes: outcome.mailboxes }), { headers: h });
}

const PROVIDER_LABELS: Record<NonNullable<WebMailbox["provider"]>, string> = {
  gmail: "Gmail",
  microsoft: "Microsoft",
  imap_smtp: "IMAP/SMTP",
};

const AVAILABILITY_LABELS: Record<MailboxAvailability,
  { label: string; tone: "ok" | "warn" | "bad"; hint: string }> = {
  configured: {
    label: "本地配置就绪",
    tone: "ok",
    hint: "仅表示狐邮当前运行环境的必要依赖已配置，不代表已完成真实连接或可以收发邮件。",
  },
  service_unavailable: {
    label: "服务不可用",
    tone: "bad",
    hint: "当前运行环境缺少该邮箱类型所需的配置，暂时无法使用。",
  },
  disabled: {
    label: "已停用",
    tone: "bad",
    hint: "该邮箱已被停用，不会参与同步或收信。",
  },
  reauth_required: {
    label: "需要重新授权",
    tone: "warn",
    hint: "该邮箱的授权已失效，需要重新完成邮箱授权才能继续同步。",
  },
  credential_unavailable: {
    label: "凭据不可用",
    tone: "bad",
    hint: "狐邮当前无法解密或读取该邮箱的授权凭据。",
  },
  credential_missing: {
    label: "尚未授权",
    tone: "warn",
    hint: "该邮箱还没有保存可用的授权凭据。",
  },
};

function mailboxKindLabel(mailbox: WebMailbox): string {
  if (mailbox.kind === "own_domain") return "自有域邮箱";
  return mailbox.provider ? PROVIDER_LABELS[mailbox.provider] : "第三方邮箱";
}

function credentialLabel(mailbox: WebMailbox): string {
  if (mailbox.kind === "own_domain") return "自有域邮箱不需要第三方授权";
  switch (mailbox.credentialStatus) {
    case "active": return "有授权记录（不代表已可收发）";
    case "reauth_required": return "授权需要更新";
    case "unreadable": return "授权记录无法读取";
    case "revoked": return "授权已撤销";
    default: return "没有授权记录";
  }
}

function renderMailbox(mailbox: WebMailbox): string {
  const availability = AVAILABILITY_LABELS[mailbox.availability];
  return `<li class="mailbox">
<p class="address"><strong>${escapeText(mailbox.address)}</strong></p>
<p class="meta">${escapeText(mailboxKindLabel(mailbox))}</p>
<p class="meta"><span class="pill ${availability.tone}">${escapeText(availability.label)}</span>
${escapeText(credentialLabel(mailbox))}</p>
<p class="hint">${escapeText(availability.hint)}</p>
</li>`;
}

type MailboxListError = "authentication_link_unavailable"
  | "mailbox_list_invalid" | "mailboxes_unavailable";

function mailboxFailureMessage(error: MailboxListError): string {
  switch (error) {
    case "mailboxes_unavailable":
      return "邮箱服务尚未配置或暂时不可用，当前无法列出邮箱。";
    case "mailbox_list_invalid":
      return "邮箱列表响应异常，暂时无法显示。";
    default:
      return "无法获取邮箱列表，登录状态可能已失效。";
  }
}

function renderMailboxesPage(outcome: MailboxListOutcome): string {
  const mailboxSection = outcome.ok
    ? (outcome.mailboxes.length
      ? `<ul class="mailboxes">${outcome.mailboxes.map(renderMailbox).join("")}</ul>`
      : `<div class="notice"><p>当前账号还没有登记邮箱。</p>
<p>添加邮箱入口尚未开放；开通后这里会显示真实邮箱及其连接状态。</p></div>`)
    : `<div class="notice error" role="alert">
<p>${escapeText(mailboxFailureMessage(outcome.error))}</p>
<p><a href="/account/mailboxes">重试</a> <a href="/auth/start">重新登录</a></p></div>`;
  return `<nav class="topnav"><a href="/account">← 返回账号页</a></nav>
<p>当前 Mira 云账号已登录。以下是狐邮为当前账号登记的邮箱。</p>
<section aria-labelledby="mailbox-list">
<h2 id="mailbox-list">我的邮箱</h2>
${mailboxSection}
</section>
<section aria-labelledby="add-mailbox">
<h2 id="add-mailbox">添加邮箱</h2>
<p>以下入口尚未开放，当前不会发起授权或任何网络请求。</p>
<ul class="providers">
<li><strong>自有域邮箱</strong> <span class="pill muted">尚未开放</span>
<p class="hint">使用狐邮域名下的地址。需要先在服务端开通域名与邮件路由。</p></li>
<li><strong>Gmail</strong> <span class="pill muted">尚未开放</span>
<p class="hint">通过 Google OAuth 授权狐邮读取邮件。</p></li>
<li><strong>Microsoft</strong> <span class="pill muted">尚未开放</span>
<p class="hint">通过 Microsoft OAuth 授权狐邮读取邮件。</p></li>
<li><strong>IMAP/SMTP</strong> <span class="pill muted">尚未开放</span>
<p class="hint">使用 IMAP/SMTP 服务器与授权码接入。</p></li>
</ul>
</section>
<section aria-labelledby="unlink-mailbox">
<h2 id="unlink-mailbox">解绑邮箱</h2>
<p>解绑会删除狐邮服务器上该邮箱的本地同步副本并停止后续同步，但不会删除邮箱服务商中的原始邮件。</p>
<p>该操作尚未开放，当前无法提交。</p>
<button type="button" disabled aria-disabled="true">解绑邮箱（尚未开放）</button>
</section>
<form method="post" action="/auth/logout"><button type="submit">退出登录</button></form>
<p><small>“本地配置就绪”只说明狐邮运行环境已准备好必要依赖，既不代表邮箱连接成功，也不代表可以收发邮件。</small></p>`;
}

/** Isolated browser login/BFF. The existing /mcp bearer gate is unchanged. */
export async function handleWebRequest(request: Request, env: WhoYouEnv): Promise<Response | null> {
  const u = new URL(request.url), path = u.pathname;
  if (!["/", "/auth/start", "/auth/callback", "/auth/logout", "/account", "/account/mailboxes", "/api/whoami", "/api/mailboxes"].includes(path)) return null;
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
    return path === "/account" || path === "/account/mailboxes"
      ? redirect("/") : jsonError(401, "sign_in_required");
  if (path === "/account/mailboxes") {
    const outcome = await fetchMailboxList(env, session);
    return page(renderMailboxesPage(outcome), headers(),
      outcome.ok ? 200 : outcome.error === "mailboxes_unavailable" ? 503 : 502);
  }
  if (path === "/api/mailboxes") return handleMailboxList(request, env, session, u);
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
<p><a href="/account/mailboxes">管理邮箱</a></p>
<form method="post" action="/auth/logout"><button type="submit">退出登录</button></form>
<p><small>这是云认证接线验收页，尚未启用邮件收发。</small></p>`);
}
