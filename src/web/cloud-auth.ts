import { createMailServices, resolveCredentialKeys, type WhoYouEnv } from "../mail/config";
import { createWhoYouRuntime } from "../mcp/runtime";
import { normalizeDomain } from "../mail/address";
import { handleGmailCallback } from "../mail/gmail-http";
import { GMAIL_CALLBACK_PATH, resolveGmailOAuthConfig } from "../mail/gmail-link";
import { GOOGLE_AUTHORIZATION_ENDPOINT } from "../mail/oauth-client";
import { resolveMicrosoftOAuthConfig } from "../mail/microsoft-link";

const CLIENT_ID = "who-you-web";
const CALLBACK = "https://who-you.tomz.io/auth/callback";
const ORIGIN = new URL(CALLBACK).origin;
const STATE_COOKIE = "__Host-who_you_oauth";
const SESSION_COOKIE = "__Host-who_you_session";
const INSTALL_COOKIE = "__Host-who_you_installation";
const MAIL_OAUTH_COOKIE = "__Host-who_you_mail_oauth";
const MAIL_OAUTH_RESULT_COOKIE = "__Host-who_you_mail_oauth_result";
type ProtectedPage = "/account" | "/account/mailboxes";
type Flow = { state: string; verifier: string; installation: string; at: number; returnTo?: ProtectedPage };
type Session = { sessionToken: string; expiresAt: string };
type GmailCallbackNotice = "gmail_connected" | "gmail_relinked" | "gmail_denied" | "gmail_link_failed";
type MailOAuthFlow = {
  provider: "gmail";
  state: string;
  expiresAt: number;
  sessionBinding: string;
};
type MailOAuthResult = {
  provider: "gmail";
  state: string;
  notice: GmailCallbackNotice;
  expiresAt: number;
};
type WhoYouCredentialRequest = {
  audience: "mira:who-you";
  scopes?: ["whoyou.read", "whoyou.mail.write"];
  confirmation?: {
    actor: "user";
    action: "link" | "unlink";
    provider: "gmail";
    mailbox_id: string | null;
    nonce: string;
  };
};

type ToolCallResult =
  | { ok: true; structured: unknown }
  | { ok: false; reason: "authentication_link_unavailable" }
  | { ok: false; reason: "not_configured"; detail: string }
  | { ok: false; reason: "tool_rejected"; code: string };

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
async function seal(key: CryptoKey, data: Flow | Session | MailOAuthFlow | MailOAuthResult): Promise<string> {
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
function validReturnTo(v: unknown): v is ProtectedPage {
  return v === "/account" || v === "/account/mailboxes";
}
function returnToFrom(value: string | null): ProtectedPage {
  return validReturnTo(value) ? value : "/account";
}
function guardLocation(path: ProtectedPage): string {
  return "/?" + new URLSearchParams({ reason: "sign_in_required", returnTo: path }).toString();
}
function isFlow(v: unknown): v is Flow {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Partial<Flow>;
  return typeof x.state === "string" && /^[\w-]{43}$/.test(x.state)
    && typeof x.verifier === "string" && /^[\w-]{43}$/.test(x.verifier)
    && validInstallation(x.installation) && typeof x.at === "number"
    && (x.returnTo === undefined || validReturnTo(x.returnTo))
    && x.at <= Date.now() && Date.now() - x.at < 300_000;
}
function isSession(v: unknown): v is Session {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Partial<Session>;
  return typeof x.sessionToken === "string" && x.sessionToken.length > 16
    && x.sessionToken.length < 4096 && typeof x.expiresAt === "string"
    && Number.isFinite(Date.parse(x.expiresAt)) && Date.parse(x.expiresAt) > Date.now();
}
function isMailOAuthFlow(v: unknown): v is MailOAuthFlow {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Partial<MailOAuthFlow>;
  return x.provider === "gmail"
    && typeof x.state === "string" && /^[\w-]{43}$/.test(x.state)
    && typeof x.sessionBinding === "string" && /^[\w-]{43}$/.test(x.sessionBinding)
    && typeof x.expiresAt === "number" && Number.isFinite(x.expiresAt)
    && x.expiresAt > Date.now() && x.expiresAt <= Date.now() + 10 * 60_000;
}
function isMailOAuthResult(v: unknown): v is MailOAuthResult {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Partial<MailOAuthResult>;
  return x.provider === "gmail"
    && typeof x.state === "string" && /^[\w-]{43}$/.test(x.state)
    && (x.notice === "gmail_connected" || x.notice === "gmail_relinked"
      || x.notice === "gmail_denied" || x.notice === "gmail_link_failed")
    && typeof x.expiresAt === "number" && Number.isFinite(x.expiresAt)
    && x.expiresAt > Date.now() && x.expiresAt <= Date.now() + 60_000;
}
async function sessionBinding(session: Session): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(session.sessionToken),
  );
  return encode(new Uint8Array(digest));
}
async function discardWebGmailState(env: WhoYouEnv, state: string): Promise<boolean> {
  const resolved = createMailServices(env);
  if (!resolved.ok) return false;
  try {
    return await resolved.services.oauthStates.consume(state, Date.now()) !== null;
  } catch {
    return false;
  }
}
function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;" })[c]!);
}
type PageOptions = {
  shell?: "auth" | "app";
  active?: "account" | "mailboxes";
};

function page(content: string, outgoing = headers(), status = 200,
  options: PageOptions = {}): Response {
  const h = outgoing;
  h.set("content-type", "text/html; charset=utf-8");
  h.set("content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  const app = options.shell === "app";
  const nav = app ? `<nav class="appnav" aria-label="狐邮配置">
<a href="/account"${options.active === "account" ? ' aria-current="page"' : ""}>账户</a>
<a href="/account/mailboxes"${options.active === "mailboxes" ? ' aria-current="page"' : ""}>邮箱</a>
</nav>` : "";
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>狐邮 · Who You</title>
<style>
:root{color-scheme:light;--ink:#232426;--muted:#686b70;--line:#e5e6e7;--soft:#f4f5f5;--accent:#155867;--accent-soft:#edf4f5}
*{box-sizing:border-box}body{margin:0;background:#f6f6f4;color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body:before{content:"";display:block;height:6px;background:var(--accent)}
main{width:min(620px,calc(100% - 28px));margin:5vh auto;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 10px 34px rgba(28,35,38,.035)}
.brandbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:24px 28px 18px}
.brand{color:var(--ink);text-decoration:none;font:600 24px/1.1 "Iowan Old Style",Georgia,serif;letter-spacing:.01em}.brand span{font-weight:400;color:#45484b}
.session-mark{font-size:12px;color:#3d6a54;background:#eef6f1;border:1px solid #d5e8dc;border-radius:999px;padding:3px 9px}
.appnav{display:flex;gap:4px;padding:0 20px 10px;border-bottom:1px solid var(--line)}.appnav a{color:#555b60;text-decoration:none;padding:7px 10px;border-radius:6px}
.appnav a[aria-current="page"]{color:var(--ink);background:var(--soft);font-weight:600}
.content{padding:28px}.content.auth{padding-top:18px;padding-bottom:34px}
h1{font:600 27px/1.25 "Iowan Old Style",Georgia,serif;margin:0 0 10px}h2{font-size:17px;margin:28px 0 10px}p{color:#52565a;margin:8px 0 14px}.lead{font-size:16px;max-width:44ch}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#73777c;margin:0 0 12px}
a{color:#1762b0}.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;border-radius:7px;padding:9px 15px;border:1px solid #282a2c;background:#282a2c;color:#fff;text-decoration:none;font:inherit;cursor:pointer}
.button.secondary{background:#fff;color:#282a2c;border-color:#d5d7d8}.button:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #8ab4e8;outline-offset:2px}
button[disabled]{background:#e5e5e5;border-color:#e5e5e5;color:#777;cursor:not-allowed}
.auth-actions{margin:22px 0 14px}.footnote{font-size:13px;color:#767a7e;max-width:50ch}
.settings{border-top:1px solid var(--line);margin-top:22px}.setting-row{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:18px 0;border-bottom:1px solid var(--line)}
.setting-row strong{font-size:15px}.setting-row p{margin:4px 0 0}.setting-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}.setting-actions form{margin:0}
code{overflow-wrap:anywhere;font-size:13px;background:#f3f3f2;padding:2px 5px;border-radius:4px}
.mailboxes,.providers{list-style:none;margin:0;padding:0}.mailbox,.providers li{border:1px solid var(--line);border-radius:8px;padding:14px;margin:0 0 10px}
.address{overflow-wrap:anywhere;margin:0 0 6px}.meta{margin:0 0 6px;color:#333}.hint{color:#707479;font-size:13px;margin:4px 0 0}
.pill{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:1px 9px;font-size:12px;line-height:1.55;white-space:nowrap}.pill.ok{color:#2f6b48}.pill.warn{color:#8a5b12}.pill.bad{color:#a33a35}.pill.muted{color:#74777b}
.notice{background:var(--soft);border:1px solid #e0e2e3;border-radius:8px;padding:12px 14px;margin:16px 0}.notice p:last-child{margin-bottom:0}.notice.error{background:#fcf3f2;border-color:#efd6d3}.notice.auth-required{background:var(--accent-soft);border-color:#d7e7ea}
.inline-actions{display:flex;gap:14px;flex-wrap:wrap}.inline-actions a{text-decoration:none;font-weight:600}
.mailbox-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.mailbox-actions form{margin:0}
.notice.ok{background:#eef6f1;border-color:#d5e8dc}
@media (max-width:520px){main{margin:0;width:100%;min-height:100vh;border:0;border-radius:0;box-shadow:none}.brandbar{padding:20px 20px 14px}.content{padding:22px 20px}.appnav{padding-left:12px}.setting-row{gap:10px}}
</style></head><body><main>
<header class="brandbar"><a class="brand" href="/">狐邮 <span>· Who You</span></a>${app ? '<span class="session-mark">云账号已登录</span>' : ""}</header>
${nav}<div class="content${app ? "" : " auth"}">${content}</div></main></body></html>`, { status, headers: h });
}

function renderLoginPage(returnTo: ProtectedPage, blocked: boolean): string {
  const href = "/auth/start?" + new URLSearchParams({ returnTo }).toString();
  return `<p class="eyebrow">Mail capability settings</p>
<h1>连接 Mira 云账号</h1>
<p class="lead">登录后可以管理狐邮的邮箱连接与授权状态。这里不是邮箱客户端，只保留必要的配置。</p>
${blocked ? `<div class="notice auth-required" role="status"><strong>这个页面需要先登录</strong>
<p>登录完成后会回到你刚才要访问的位置。</p></div>` : ""}
<div class="auth-actions"><a class="button" href="${escapeText(href)}">使用 Mira 云账号登录</a></div>
<p class="footnote">登录由 Cloud Auth 完成。登录只确认你的 Mira 云账号身份，不会自动授权 Gmail、Microsoft 或其他邮箱。</p>`;
}

function renderAccountPage(id: { accountId: string; consumerId: string; scopes: string[] }): string {
  return `<h1>账户</h1>
<p class="lead">Who You 只保留与邮件能力有关的少量配置。身份由 Cloud Auth 管理，邮箱授权由狐邮单独管理。</p>
<div class="settings">
<div class="setting-row"><div><strong>Mira 云账号</strong>
<p class="hint">当前浏览器会话已通过 Cloud Auth 验证。</p>
<p><code>${escapeText(id.accountId)}</code></p></div><span class="pill ok">已登录</span></div>
<div class="setting-row"><div><strong>狐邮访问</strong>
<p class="hint">当前服务凭证范围：${id.scopes.map(escapeText).join("、") || "无"}</p></div><span class="pill ok">已连接</span></div>
</div>
<div class="setting-actions">
<a class="button secondary" href="/account/mailboxes">邮箱设置</a>
<form method="post" action="/auth/logout"><button type="submit">退出登录</button></form>
</div>`;
}

function baseUrl(env: WhoYouEnv): string | null {
  try {
    const u = new URL(env.CLOUD_AUTH_ISSUER ?? "");
    return u.protocol === "https:" && u.pathname === "/" && !u.username && !u.password
      ? u.origin : null;
  } catch { return null; }
}
/**
 * Exchanges the sealed browser Cloud Session for one short-lived Who You
 * credential. Cloud Auth derives account/device/consumer from the session; the
 * browser never sees this credential.
 */
async function issueWhoYouCredential(
  env: WhoYouEnv,
  session: Session,
  body: WhoYouCredentialRequest,
): Promise<
  | { ok: true; token: string }
  | { ok: false; reason: "authentication_link_unavailable" | "not_configured"; detail?: string }
> {
  const base = baseUrl(env);
  if (!base) return { ok: false, reason: "not_configured", detail: "cloud_auth_issuer" };
  try {
    const r = await fetch(new URL("/v1/service-credentials", base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, reason: "authentication_link_unavailable" };
    const issued = await r.json() as { token?: string };
    return typeof issued.token === "string"
      ? { ok: true, token: issued.token }
      : { ok: false, reason: "authentication_link_unavailable" };
  } catch {
    return { ok: false, reason: "authentication_link_unavailable" };
  }
}

const READ_CREDENTIAL_REQUEST: WhoYouCredentialRequest = {
  audience: "mira:who-you",
};

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
  credentialRequest: WhoYouCredentialRequest = READ_CREDENTIAL_REQUEST,
): Promise<ToolCallResult> {
  const issued = await issueWhoYouCredential(env, session, credentialRequest);
  if (!issued.ok) {
    return issued.reason === "not_configured"
      ? { ok: false, reason: "not_configured", detail: issued.detail ?? "cloud_auth_issuer" }
      : { ok: false, reason: "authentication_link_unavailable" };
  }

  const runtime = createWhoYouRuntime(env);
  // The runtime is cached per isolate and shared with `/mcp`; closing it after
  // one BFF call would break every later call in the same isolate.
  if (!runtime.ok) return { ok: false, reason: "not_configured", detail: runtime.reason };
  if (!env.MCP_RESOURCE_URL) return { ok: false, reason: "not_configured", detail: "mcp_resource_url" };
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
    if (body.result?.isError) {
      const structured = body.result.structuredContent;
      const rawCode = typeof structured === "object" && structured !== null
        ? (structured as { error?: unknown }).error : null;
      const code = typeof rawCode === "string" && /^[a-z0-9_]{1,64}$/.test(rawCode)
        ? rawCode : "tool_rejected";
      return { ok: false, reason: "tool_rejected", code };
    }
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

const WRITE_SCOPES: ["whoyou.read", "whoyou.mail.write"] = [
  "whoyou.read", "whoyou.mail.write",
];

type GmailLinkStart = { authorizationUrl: string; state: string; expiresAt: number };
type GmailWebAction =
  | { ok: true; start: GmailLinkStart }
  | { ok: false; code: string };

function gmailWebReady(env: WhoYouEnv): boolean {
  return Boolean(
    env.DB && env.MAIL_BUCKET
    && resolveCredentialKeys(env)
    && resolveGmailOAuthConfig(env),
  );
}

async function issueGmailIdentityConfirmation(
  env: WhoYouEnv,
  session: Session,
  action: "link" | "unlink",
  mailboxId: string | null,
): Promise<{ ok: true; token: string } | { ok: false; code: string }> {
  const issued = await issueWhoYouCredential(env, session, {
    audience: "mira:who-you",
    confirmation: {
      actor: "user", action, provider: "gmail", mailbox_id: mailboxId, nonce: random(),
    },
  });
  return issued.ok
    ? { ok: true, token: issued.token }
    : { ok: false, code: issued.reason };
}

function parseGmailLinkStart(value: unknown): GmailLinkStart | null {
  if (typeof value !== "object" || value === null) return null;
  const x = value as Record<string, unknown>;
  if (x.provider !== "gmail" || typeof x.authorizationUrl !== "string"
      || typeof x.state !== "string" || !/^[\w-]{43}$/.test(x.state)
      || typeof x.expiresAt !== "number" || !Number.isFinite(x.expiresAt)
      || x.expiresAt <= Date.now()) return null;
  try {
    const authorization = new URL(x.authorizationUrl);
    const expected = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    if (authorization.protocol !== "https:" || authorization.origin !== expected.origin
        || authorization.pathname !== expected.pathname
        || authorization.searchParams.get("state") !== x.state) return null;
  } catch { return null; }
  return { authorizationUrl: x.authorizationUrl, state: x.state, expiresAt: x.expiresAt };
}

async function startWebGmailLink(env: WhoYouEnv, session: Session): Promise<GmailWebAction> {
  if (!gmailWebReady(env)) return { ok: false, code: "provider_not_configured" };
  const confirmation = await issueGmailIdentityConfirmation(env, session, "link", null);
  if (!confirmation.ok) return confirmation;
  const called = await callWhoYouTool(
    env, session, "whoyou_mailbox_link",
    { provider: "gmail", confirmationCredential: confirmation.token },
    { audience: "mira:who-you", scopes: WRITE_SCOPES },
  );
  if (!called.ok) return {
    ok: false,
    code: called.reason === "tool_rejected" ? called.code : called.reason,
  };
  const start = parseGmailLinkStart(called.structured);
  return start ? { ok: true, start } : { ok: false, code: "invalid_link_response" };
}

type GmailUnlinkOutcome = { ok: true } | { ok: false; code: string };
async function unlinkWebGmail(
  env: WhoYouEnv,
  session: Session,
  mailboxId: string,
): Promise<GmailUnlinkOutcome> {
  const listed = await fetchMailboxList(env, session);
  if (!listed.ok) return { ok: false, code: listed.error };
  const mailbox = listed.mailboxes.find((entry) => entry.mailboxId === mailboxId);
  if (!mailbox) return { ok: true };
  if (mailbox.kind !== "third_party" || mailbox.provider !== "gmail") {
    return { ok: false, code: "mailbox_not_gmail" };
  }
  if (!resolveCredentialKeys(env)) return { ok: false, code: "credential_vault_unavailable" };
  const confirmation = await issueGmailIdentityConfirmation(
    env, session, "unlink", mailbox.mailboxId,
  );
  if (!confirmation.ok) return confirmation;
  const called = await callWhoYouTool(
    env, session, "whoyou_mailbox_unlink",
    { mailboxId: mailbox.mailboxId, confirmationCredential: confirmation.token },
    { audience: "mira:who-you", scopes: WRITE_SCOPES },
  );
  if (!called.ok) return {
    ok: false,
    code: called.reason === "tool_rejected" ? called.code : called.reason,
  };
  return { ok: true };
}

type MailboxNotice = GmailCallbackNotice
  | "gmail_unlinked" | "gmail_unlink_failed" | "gmail_unavailable";
const MAILBOX_NOTICE_MESSAGES: Record<MailboxNotice, { tone: "ok" | "error"; text: string }> = {
  gmail_connected: { tone: "ok", text: "Gmail 已连接。邮箱地址来自 Google 授权结果。" },
  gmail_relinked: { tone: "ok", text: "Gmail 授权已更新。" },
  gmail_denied: { tone: "error", text: "Gmail 授权没有完成，没有保存新的授权凭据。" },
  gmail_link_failed: { tone: "error", text: "Gmail 连接失败，没有把这次尝试标记为已连接。" },
  gmail_unlinked: { tone: "ok", text: "Gmail 已解绑；狐邮本地凭据与同步副本已删除。" },
  gmail_unlink_failed: { tone: "error", text: "Gmail 解绑没有完成，请稍后重试。" },
  gmail_unavailable: { tone: "error", text: "当前运行环境还没有配置 Gmail OAuth 或凭据加密能力。" },
};
function mailboxNotice(value: string | null): MailboxNotice | null {
  return value && value in MAILBOX_NOTICE_MESSAGES ? value as MailboxNotice : null;
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

function renderMailbox(mailbox: WebMailbox, env: WhoYouEnv): string {
  const availability = AVAILABILITY_LABELS[mailbox.availability];
  const isGmail = mailbox.kind === "third_party" && mailbox.provider === "gmail";
  const canLink = gmailWebReady(env);
  const canUnlink = Boolean(resolveCredentialKeys(env));
  const actions = isGmail ? `<div class="mailbox-actions">
${canLink ? `<form method="post" action="/account/mailboxes/gmail/link">
<button class="button secondary" type="submit">${mailbox.credentialStatus === "reauth_required" ? "重新授权 Gmail" : "更新 Gmail 授权"}</button></form>` : ""}
${canUnlink ? `<form method="post" action="/account/mailboxes/unlink">
<input type="hidden" name="mailboxId" value="${escapeText(mailbox.mailboxId)}">
<button class="button secondary" type="submit">解绑 Gmail</button></form>` : ""}
</div>` : "";
  return `<li class="mailbox">
<p class="address"><strong>${escapeText(mailbox.address)}</strong></p>
<p class="meta">${escapeText(mailboxKindLabel(mailbox))}</p>
<p class="meta"><span class="pill ${availability.tone}">${escapeText(availability.label)}</span>
${escapeText(credentialLabel(mailbox))}</p>
<p class="hint">${escapeText(availability.hint)}</p>
${actions}
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

function renderMailboxesPage(
  outcome: MailboxListOutcome,
  env: WhoYouEnv,
  notice: MailboxNotice | null,
): string {
  const noticeContent = notice ? MAILBOX_NOTICE_MESSAGES[notice] : null;
  const banner = noticeContent
    ? `<div class="notice ${noticeContent.tone === "ok" ? "ok" : "error"}" role="status"><p>${escapeText(noticeContent.text)}</p></div>`
    : "";
  const mailboxSection = outcome.ok
    ? (outcome.mailboxes.length
      ? `<ul class="mailboxes">${outcome.mailboxes.map((mailbox) => renderMailbox(mailbox, env)).join("")}</ul>`
      : `<div class="notice"><p>当前账号还没有登记邮箱。</p>
<p>连接 Gmail 后，真实授权成功的邮箱会出现在这里。</p></div>`)
    : `<div class="notice error" role="alert">
<p>${escapeText(mailboxFailureMessage(outcome.error))}</p>
<div class="inline-actions"><a href="/account/mailboxes">重试</a>
<a href="/auth/start?returnTo=%2Faccount%2Fmailboxes">重新登录</a></div></div>`;
  const gmailReady = gmailWebReady(env);
  return `<h1>邮箱</h1>
<p class="lead">查看当前账号在狐邮登记的邮箱与连接状态。</p>
${banner}
<section aria-labelledby="mailbox-list">
<h2 id="mailbox-list">已连接</h2>
${mailboxSection}
</section>
<section aria-labelledby="add-mailbox">
<h2 id="add-mailbox">添加邮箱</h2>
<ul class="providers">
<li><strong>Gmail</strong> ${gmailReady ? '<span class="pill ok">可接入</span>' : '<span class="pill muted">尚未配置</span>'}
<p class="hint">通过 Google OAuth 授权狐邮读取与发送邮件；登录 Mira 云账号本身不会授予 Gmail 权限。</p>
${gmailReady ? '<form method="post" action="/account/mailboxes/gmail/link"><button type="submit">连接 Gmail</button></form>' : ""}</li>
<li><strong>Microsoft</strong> <span class="pill muted">尚未开放</span>
<p class="hint">本卡不开放 Microsoft 真实接入。</p></li>
<li><strong>IMAP/SMTP</strong> <span class="pill muted">尚未开放</span>
<p class="hint">本卡不开放自填服务器真实接入。</p></li>
</ul>
</section>
<p class="footnote">“本地配置就绪”只说明狐邮运行环境已准备好必要依赖，不代表邮箱连接成功或可以收发邮件。</p>`;
}

/** Isolated browser login/BFF. The existing /mcp bearer gate is unchanged. */
export async function handleWebRequest(request: Request, env: WhoYouEnv): Promise<Response | null> {
  const u = new URL(request.url), path = u.pathname;
  const webPaths = [
    "/", "/auth/start", "/auth/callback", "/auth/logout", "/account",
    "/account/mailboxes", "/account/mailboxes/gmail/link", "/account/mailboxes/unlink",
    "/api/whoami", "/api/mailboxes",
  ];
  const hasWebGmailFlow = path === GMAIL_CALLBACK_PATH
    && (getCookie(request, MAIL_OAUTH_COOKIE) !== null
      || getCookie(request, MAIL_OAUTH_RESULT_COOKIE) !== null);
  if (!webPaths.includes(path) && !hasWebGmailFlow) return null;
  if (u.origin !== ORIGIN) return jsonError(404, "not_found");
  const key = await importSessionKey(env.WHOYOU_WEB_SESSION_KEY), base = baseUrl(env);
  if (!key || !base) return jsonError(503, "web_login_not_configured");

  if (path === GMAIL_CALLBACK_PATH) {
    const state = u.searchParams.get("state");
    const h = headers();
    const prior = await unseal(key, getCookie(request, MAIL_OAUTH_RESULT_COOKIE));
    if (isMailOAuthResult(prior) && prior.state === state) {
      addCookie(h, MAIL_OAUTH_COOKIE, "", 0);
      return redirect(`/account/mailboxes?notice=${prior.notice}`, h);
    }

    const rawFlowCookie = getCookie(request, MAIL_OAUTH_COOKIE);
    if (rawFlowCookie === null) return null;

    const flow = await unseal(key, rawFlowCookie);
    const currentSession = await unseal(key, getCookie(request, SESSION_COOKIE));
    if (!isMailOAuthFlow(flow)) {
      addCookie(h, MAIL_OAUTH_COOKIE, "", 0);
      return redirect("/account/mailboxes?notice=gmail_link_failed", h);
    }
    if (flow.state !== state) {
      // Do not destroy the legitimate pending flow because an unrelated callback
      // reached this browser. Keeping the sealed flow cookie prevents raw fallback.
      return redirect("/account/mailboxes?notice=gmail_link_failed", h);
    }
    if (!isSession(currentSession)
        || flow.sessionBinding !== await sessionBinding(currentSession)) {
      if (await discardWebGmailState(env, flow.state)) {
        addCookie(h, MAIL_OAUTH_COOKIE, "", 0);
        addCookie(h, MAIL_OAUTH_RESULT_COOKIE, await seal(key, {
          provider: "gmail",
          state: flow.state,
          notice: "gmail_link_failed",
          expiresAt: Date.now() + 60_000,
        }), 60);
      }
      return redirect("/account/mailboxes?notice=gmail_link_failed", h);
    }

    addCookie(h, MAIL_OAUTH_COOKIE, "", 0);
    if (u.searchParams.has("error") || !u.searchParams.get("code")) {
      await discardWebGmailState(env, flow.state);
      const notice: GmailCallbackNotice = u.searchParams.has("error")
        ? "gmail_denied" : "gmail_link_failed";
      addCookie(h, MAIL_OAUTH_RESULT_COOKIE, await seal(key, {
        provider: "gmail",
        state: flow.state,
        notice,
        expiresAt: Date.now() + 60_000,
      }), 60);
      return redirect(`/account/mailboxes?notice=${notice}`, h);
    }

    const completed = await handleGmailCallback(request, env);
    let payload: { relinked?: unknown; error?: unknown } = {};
    try { payload = await completed.json() as { relinked?: unknown; error?: unknown }; }
    catch { payload = {}; }

    // A concurrent duplicate can lose the single-use state race. It must not
    // overwrite the winner's result cookie or turn a successful link into a
    // visible failure. The mailbox page itself is the authoritative outcome.
    if (!completed.ok && payload.error === "invalid_state") {
      return redirect("/account/mailboxes", h);
    }

    const notice: GmailCallbackNotice = completed.ok
      ? (payload.relinked === true ? "gmail_relinked" : "gmail_connected")
      : payload.error === "provider_reauth_required"
        ? "gmail_denied" : "gmail_link_failed";
    addCookie(h, MAIL_OAUTH_RESULT_COOKIE, await seal(key, {
      provider: "gmail",
      state: flow.state,
      notice,
      expiresAt: Date.now() + 60_000,
    }), 60);
    return redirect(`/account/mailboxes?notice=${notice}`, h);
  }

  if (path === "/") {
    if (request.method !== "GET") return jsonError(405, "method_not_allowed");
    const session = await unseal(key, getCookie(request, SESSION_COOKIE));
    if (isSession(session)) return redirect("/account");
    const returnTo = returnToFrom(u.searchParams.get("returnTo"));
    const blocked = u.searchParams.get("reason") === "sign_in_required";
    return page(renderLoginPage(returnTo, blocked));
  }

  if (path === "/auth/start") {
    if (request.method !== "GET") return jsonError(405, "method_not_allowed");
    const prior = getCookie(request, INSTALL_COOKIE);
    const installation = validInstallation(prior) ? prior : crypto.randomUUID();
    const returnTo = returnToFrom(u.searchParams.get("returnTo"));
    const state = random(), verifier = random();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const h = headers();
    addCookie(h, STATE_COOKIE, await seal(key, {
      state, verifier, installation, returnTo, at: Date.now(),
    }), 300);
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
      return page(`<h1>登录没有完成</h1>
<p>登录已过期、被取消或验证失败。</p>
<div class="auth-actions"><a class="button" href="/">重新登录</a></div>`, h);
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
      return redirect(flow.returnTo ?? "/account", h);
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

  const mutation = path === "/account/mailboxes/gmail/link"
    || path === "/account/mailboxes/unlink";
  if (mutation) {
    if (request.method !== "POST") return jsonError(405, "method_not_allowed");
    if (request.headers.get("origin") !== ORIGIN) return jsonError(403, "origin_not_allowed");
    if (request.headers.has("authorization")) return jsonError(400, "unexpected_authorization");
    if ([...u.searchParams.keys()].length > 0) return jsonError(400, "unexpected_parameter");
  } else if (request.method !== "GET") return jsonError(405, "method_not_allowed");
  const session = await unseal(key, getCookie(request, SESSION_COOKIE));
  if (!isSession(session)) {
    if (mutation) return redirect(guardLocation("/account/mailboxes"));
    if (validReturnTo(path)) return redirect(guardLocation(path));
    return jsonError(401, "sign_in_required");
  }

  if (path === "/account/mailboxes/gmail/link") {
    const started = await startWebGmailLink(env, session);
    if (!started.ok) {
      const notice = started.code === "provider_not_configured"
        || started.code === "credential_vault_unavailable"
        ? "gmail_unavailable" : "gmail_link_failed";
      return redirect(`/account/mailboxes?notice=${notice}`);
    }
    const h = headers();
    addCookie(h, MAIL_OAUTH_COOKIE, await seal(key, {
      provider: "gmail",
      state: started.start.state,
      expiresAt: started.start.expiresAt,
      sessionBinding: await sessionBinding(session),
    }), 600);
    return redirect(started.start.authorizationUrl, h);
  }

  if (path === "/account/mailboxes/unlink") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return jsonError(415, "unsupported_media_type");
    }
    const raw = await request.text();
    if (raw.length > 512) return jsonError(413, "request_too_large");
    const form = new URLSearchParams(raw);
    if ([...form.keys()].some((name) => name !== "mailboxId")) {
      return jsonError(400, "unexpected_parameter");
    }
    const mailboxId = form.get("mailboxId") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(mailboxId)) {
      return jsonError(400, "invalid_mailbox_id");
    }
    const unlinked = await unlinkWebGmail(env, session, mailboxId);
    return redirect(`/account/mailboxes?notice=${unlinked.ok ? "gmail_unlinked" : "gmail_unlink_failed"}`);
  }

  if (path === "/account/mailboxes") {
    const outcome = await fetchMailboxList(env, session);
    return page(renderMailboxesPage(outcome, env, mailboxNotice(u.searchParams.get("notice"))), headers(),
      outcome.ok ? 200 : outcome.error === "mailboxes_unavailable" ? 503 : 502,
      { shell: "app", active: "mailboxes" });
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
  return page(renderAccountPage(id), headers(), 200, { shell: "app", active: "account" });
}
