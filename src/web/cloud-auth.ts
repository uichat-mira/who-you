import { errorIllustration } from "./error-illustrations";
import { webIcon } from "./icons";
import { webStylesCss } from "./web-styles";
import { createMailServices, resolveCredentialKeys, type WhoYouEnv } from "../mail/config";
import { applicationManifest, resolveApplicationInstance, resolveInstanceResource } from "../application/instance";
import {
  ApplicationSecretRepository,
  generateAppSecret,
  type AppSecretState,
  type AppSecretStatus,
} from "../application/app-secret";
import { listIdentities, unlinkMailbox } from "../mail/identity";
import { startGmailLink } from "../mail/gmail-link";
import { syncGmailMailbox } from "../mail/gmail-sync";
import { normalizeDomain } from "../mail/address";
import { handleGmailCallback } from "../mail/gmail-http";
import { GMAIL_SYNC_MAX_MESSAGES_PER_RUN } from "../mail/gmail-sync";
import { GMAIL_CALLBACK_PATH, resolveGmailOAuthConfig } from "../mail/gmail-link";
import { GOOGLE_AUTHORIZATION_ENDPOINT } from "../mail/oauth-client";
import { resolveMicrosoftOAuthConfig } from "../mail/microsoft-link";
import {
  authenticateOwner,
  isOwnerSession,
  ownerAccountId,
  validateOwnerPassword,
  verifyOwnerPassword,
  OwnerRepository,
  OWNER_LOGIN_NAME,
  OWNER_PASSWORD_MAX_LENGTH,
  OWNER_SESSION_SECONDS,
  type OwnerCredential,
  type OwnerSession,
} from "./owner-auth";
import { publicIntroduction, miraIntroduction, privacyPolicy, serviceTerms, publicFooter } from "./public-pages";

const STATE_COOKIE = "__Host-who_you_oauth";
const SESSION_COOKIE = "__Host-who_you_session";
const OWNER_SESSION_COOKIE = "__Host-who_you_owner_session";
const MAIL_OAUTH_COOKIE = "__Host-who_you_mail_oauth";
const MAIL_OAUTH_RESULT_COOKIE = "__Host-who_you_mail_oauth_result";
const SESSION_AAD = "who-you-application-session-v1";
const OWNER_SESSION_AAD = "who-you-owner-session-v1";
const APPLICATIONS_PATH = "/account/applications";
const APPLICATIONS_PASSWORD_PATH = "/account/applications/password";
const APPLICATIONS_SECRET_VIEW_PATH = "/account/applications/secret/view";
const APPLICATIONS_SECRET_ROTATE_PATH = "/account/applications/secret/rotate";
type ProtectedPage = "/account" | "/account/mailboxes" | typeof APPLICATIONS_PATH;
type Flow = { state: string; verifier: string; appId: string; at: number; returnTo?: ProtectedPage };
type Session = { accessToken: string; expiresAt: string; subject: string; audience: string; appId: string; issuer: "mira:cloud-auth" };
type OwnerPrincipal = {
  kind: "owner";
  accountId: string;
  session: OwnerSession;
  credentialVersion: number;
  mustChangePassword: boolean;
};
type MiraPrincipal = {
  kind: "mira";
  accountId: string;
  session: Session;
};
type WebPrincipal = MiraPrincipal | OwnerPrincipal;
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
type MailboxAvailability =
  | "configured"
  | "service_unavailable"
  | "disabled"
  | "reauth_required"
  | "credential_unavailable"
  | "credential_missing";

type WebMailboxSync = {
  lastSyncedAt: number | null;
  lastError: string | null;
  inProgress: boolean;
  initialImportComplete: boolean;
};

type WebMailbox = {
  mailboxId: string;
  address: string;
  kind: "own_domain" | "third_party";
  provider: "gmail" | "microsoft" | "imap_smtp" | null;
  credentialStatus: "active" | "reauth_required" | "unreadable" | "revoked" | null;
  availability: MailboxAvailability;
  sync: WebMailboxSync | null;
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
function sameOriginPost(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expectedOrigin;
  const referer = request.headers.get("referer");
  if (referer !== null) {
    try { return new URL(referer).origin === expectedOrigin; }
    catch { return false; }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}
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
async function seal(
  key: CryptoKey,
  data: Flow | Session | OwnerSession | MailOAuthFlow | MailOAuthResult,
  aad = SESSION_AAD,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key, new TextEncoder().encode(JSON.stringify(data)),
  ));
  const bytes = new Uint8Array(iv.length + encrypted.length);
  bytes.set(iv); bytes.set(encrypted, iv.length);
  return encode(bytes);
}
async function rememberMailOAuthResult(
  headers: Headers,
  key: CryptoKey,
  state: string,
  notice: GmailCallbackNotice,
): Promise<void> {
  addCookie(headers, MAIL_OAUTH_RESULT_COOKIE, await seal(key, {
    provider: "gmail",
    state,
    notice,
    expiresAt: Date.now() + 60_000,
  }), 60);
}

async function unseal(key: CryptoKey, raw: string | null, aad = SESSION_AAD): Promise<unknown> {
  if (!raw || raw.length > 6000) return null;
  try {
    const bytes = decode(raw);
    if (bytes.length < 29) return null;
    const clear = await crypto.subtle.decrypt({
      name: "AES-GCM", iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(aad),
    }, key, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(clear)) as unknown;
  } catch { return null; }
}
function validReturnTo(v: unknown): v is ProtectedPage {
  return v === "/account" || v === "/account/mailboxes" || v === APPLICATIONS_PATH;
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
    && typeof x.appId === "string" && typeof x.at === "number"
    && (x.returnTo === undefined || validReturnTo(x.returnTo))
    && x.at <= Date.now() && Date.now() - x.at < 300_000;
}
function isSession(v: unknown): v is Session {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Partial<Session>;
  return typeof x.accessToken === "string" && /^mas_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(x.accessToken) && x.accessToken.length < 4096
    && x.issuer === "mira:cloud-auth" && typeof x.subject === "string" && !!x.subject.trim()
    && typeof x.appId === "string" && typeof x.audience === "string" && typeof x.expiresAt === "string"
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
async function sessionBinding(principal: WebPrincipal): Promise<string> {
  const secret = principal.kind === "mira"
    ? principal.session.accessToken
    : `owner\n${principal.session.appId}\n${principal.session.sessionId}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
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
  shell?: "auth" | "app" | "home";
  active?: "account" | "mailboxes" | "applications";
  sessionVerified?: boolean;
  /** Only the instance-local Owner gains the extra 应用管理 entry. */
  isOwner?: boolean;
  /** While true, only 应用管理 is reachable; business nav stays hidden. */
  ownerPendingPasswordChange?: boolean;
};

function page(content: string, outgoing = headers(), status = 200,
  options: PageOptions = {}): Response {
  const h = outgoing;
  h.set("content-type", "text/html; charset=utf-8");
  const app = options.shell === "app";
  const home = options.shell === "home";
  // Chromium applies form-action to the redirect after a native POST as well.
  // Only the mailbox page may navigate a form flow to the pinned Google endpoint.
  const formAction = app && options.active === "mailboxes"
    ? `'self' ${GOOGLE_AUTHORIZATION_ENDPOINT}` : "'self'";
  h.set("content-security-policy",
    `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`);
  // Native same-origin forms need browser-supplied same-origin evidence on POST.
  // Keep all HTML documents on same-origin so login forms can emit Referer without
  // leaking referrers to external origins; redirects and JSON keep their own headers.
  h.set("referrer-policy", "same-origin");
  const navItems = options.ownerPendingPasswordChange
    ? [{ href: APPLICATIONS_PATH, label: "应用管理", key: "applications" }]
    : [
      { href: "/account", label: "账户", key: "account" },
      { href: "/account/mailboxes", label: "邮箱", key: "mailboxes" },
      ...(options.isOwner ? [{ href: APPLICATIONS_PATH, label: "应用管理", key: "applications" }] : []),
    ];
  const nav = app ? `<nav class="appnav" aria-label="狐邮配置">
${navItems.map((item) => `<a href="${item.href}"${options.active === item.key ? ' aria-current="page"' : ""}>${item.label}</a>`).join("\n")}
</nav>` : "";
  const sessionMark = options.sessionVerified
    ? (options.isOwner
      ? '<span class="session-mark">本地 Owner 已登录</span>'
      : '<span class="session-mark">Mira ID 已连接</span>')
    : "";
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>狐邮 · Who-You</title>
<link rel="icon" href="/brand/favicon/favicon.ico" sizes="any">
<link rel="icon" href="/brand/favicon/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/brand/favicon/apple-touch-icon.png">
<style>
${webStylesCss}
</style></head><body class="page-${home ? "home" : app ? "app" : "auth"}"><main>
<header class="brandbar"><a class="brand" href="/"><img src="/brand/logo/light/horizontal-bilingual.webp" alt="狐邮 Who-You" width="1536" height="472"></a>${app ? sessionMark : home ? '<nav class="site-nav" aria-label="网站导航"><a class="button secondary" href="#login">使用 Mira ID 继续</a></nav>' : ""}</header>
${nav}<div class="content${app ? "" : " auth"}">${content}</div>${publicFooter}</main></body></html>`, { status, headers: h });
}

// Browser document navigation only; API clients retain the existing JSON contract.
function acceptsHtml(request: Request): boolean {
  if (request.headers.has("authorization")) return false;
  return (request.headers.get("accept") ?? "").split(",").some(part => {
    const [media, ...params] = part.trim().toLowerCase().split(";");
    return media?.trim() === "text/html" && !params.some(p => /^q\s*=\s*0(?:\.0*)?$/.test(p.trim()));
  });
}

type ErrorContent = { title: string; detail: string; action?: string; href?: string; secondary?: string; secondaryHref?: string };
function errorContent(status: number, code: string): ErrorContent {
  if (code === "logout_unconfirmed") return { title: "退出尚未确认", detail: "本机登录凭据已清除，但未能确认远端会话已结束。你可以返回首页，或在 Mira ID 检查授权状态。" };
  if (code === "cloud_auth_code_rejected" || code === "login_incomplete") return { title: "登录没有完成", detail: "登录已过期、被取消或验证失败。请重新登录。", action: "重新登录", href: "/" };
  if (code === "invalid_state" || code === "provider_reauth_required") return { title: "邮箱连接没有完成", detail: "授权请求可能已过期或被取消。请返回邮箱管理，重新发起连接。", action: "返回邮箱管理", href: "/account/mailboxes" };
  if (code === "authentication_link_unavailable") return { title: "暂时无法获取账户", detail: "服务暂时不可用，或当前登录需要重新验证。请重试；如授权已失效，可重新登录。", action: "重新登录", href: "/auth/start?returnTo=%2Faccount", secondary: "重试", secondaryHref: "/account" };
  if (status === 404) return { title: "这封信走错了路。", detail: "你要找的页面不存在，或已经移动。返回狐邮首页，重新出发。" };
  if (status === 403) return { title: "这一步无法继续", detail: "当前请求未通过安全验证。请返回狐邮，从原来的入口重新操作。" };
  if (status === 401) return { title: "需要重新登录", detail: "当前登录状态无法验证，请重新登录后继续。", action: "重新登录", href: "/" };
  if (status === 405) return { title: "这个操作暂不可用", detail: "请从狐邮页面中的正常入口发起操作。" };
  if (status === 400 || status === 413 || status === 415) return { title: "请求没有完成", detail: "提交的内容无法处理，请返回原页面检查后再试。" };
  if (status === 503) return { title: "狐邮暂时无法服务", detail: "服务正在准备中或暂时不可用。请稍后再试。", action: "返回首页", href: "/" };
  return { title: "暂时遇到一点问题", detail: "服务没有按预期响应，请稍后再试。", action: "返回首页", href: "/" };
}

function errorPage(status: number, code: string, outgoing = headers()): Response {
  const content = errorContent(status, code);
  const label = code === "login_incomplete" ? "SIGN IN / 未完成" : `ERROR / ${status}`;
  outgoing.set("vary", "Accept");
  return page(`<section class="error-page" aria-labelledby="error-title">
<div class="error-copy"><p class="eyebrow">${label}</p>
<h1 id="error-title">${content.title}</h1><p class="lead">${content.detail}</p>
<div class="auth-actions"><a class="button" href="${content.href ?? "/"}">${content.action ?? "返回首页"} ${webIcon("arrow")}</a>
${content.secondary ? `<a class="button secondary" href="${content.secondaryHref}">${content.secondary}</a>` : ""}</div></div>
<div class="error-art" aria-hidden="true">${errorIllustration(status, code)}</div></section>`, outgoing, status);
}

const machinePaths = /^\/(?:api|mcp|\.well-known|mira|mail|brand)(?:\/|$)/;
export function webNotFound(request: Request, env: WhoYouEnv): Response | null {
  const url = new URL(request.url);
  const resource = resolveInstanceResource(env);
  if (request.method !== "GET" || machinePaths.test(url.pathname) || !acceptsHtml(request)
      || !resource || resource.origin !== url.origin) return null;
  return errorPage(404, "not_found");
}

function renderLoginPage(returnTo: ProtectedPage, blocked: boolean, ownerError = false): string {
  const href = "/auth/start?" + new URLSearchParams({ returnTo }).toString();
  const ownerAction = "/auth/owner/login?" + new URLSearchParams({ returnTo }).toString();
  return `<section class="hero" aria-labelledby="hero-title">
<div class="hero-copy">
<h1 id="hero-title"><ruby class="brand-ruby">狐<rt lang="en">Who</rt>邮<rt lang="en">You</rt></ruby>，<br>不止于忽悠。</h1>
<p class="lead">连接你的邮箱与智能体，让查找邮件、整理信息和日常通信变得更加自然。</p>
${blocked ? `<div class="notice auth-required" role="status"><strong>这个页面需要先登录</strong>
<p>登录完成后会回到你刚才要访问的位置。</p></div>` : ""}
${ownerError ? `<div class="notice error" role="alert"><strong>登录没有完成</strong>
<p>登录名或密码不正确，或当前实例尚未初始化 Owner 登录。请重试。</p></div>` : ""}
<div class="auth-actions" id="login"><a class="button" href="${escapeText(href)}">使用 Mira ID 继续 ${webIcon("arrow")}</a></div>
<details class="owner-login">
<summary>实例 Owner 登录</summary>
<p class="hint">仅适用于当前部署实例的本地 Owner，与 Mira ID 账号相互独立。首次登录后必须先修改初始密码。</p>
<form method="post" action="${escapeText(ownerAction)}">
<input type="hidden" name="username" value="${OWNER_LOGIN_NAME}">
<p><label for="owner-password">Owner 密码</label><br>
<input id="owner-password" type="password" name="password" autocomplete="current-password" required maxlength="${OWNER_PASSWORD_MAX_LENGTH}"></p>
<button class="button secondary" type="submit">使用本地 Owner 登录</button>
</form>
</details>
<p class="footnote">连接 Mira ID 后，你可以管理自己的邮箱，并授权 Mira 客户端使用狐邮提供的邮件能力。登录不会自动授予邮箱访问权限。</p>
</div>
<div class="hero-poster" aria-hidden="true">
<div class="poster-top"><span>WHO-YOU</span><span>MAIL / MCP</span></div>
<div class="poster-orbit"></div><span class="poster-dot"></span>
<img class="poster-mark" src="/brand/logo/dark/symbol.webp" width="720" height="720" alt="">
<div class="poster-bottom"><span>YOUR MAIL.</span><span>YOUR CALL.</span></div>
</div>
</section>
<section class="capabilities" aria-label="产品定位"><div class="capabilities-inner">
<div class="capability"><span class="capability-icon">${webIcon("connect")}</span><div><h2>连接</h2><p>让邮箱与智能体相遇。</p></div></div>
<div class="capability"><span class="capability-icon">${webIcon("collaborate")}</span><div><h2>协作</h2><p>让邮件信息为你所用。</p></div></div>
<div class="capability"><span class="capability-icon">${webIcon("control")}</span><div><h2>掌控</h2><p>每一份授权，由你决定。</p></div></div>
</div></section>
${publicIntroduction}
${miraIntroduction}`;
}

function renderAccountPage(
  principal: MiraPrincipal | OwnerPrincipal,
  instance: NonNullable<ReturnType<typeof resolveApplicationInstance>>,
  base: string,
  outcome: MailboxListOutcome,
): string {
  const manifest = applicationManifest(instance);
  const service = manifest.services[0]!;
  const appsUrl = escapeText(new URL("/account/applications", base).href);
  const grantsUrl = escapeText(new URL("/account/services", base).href);
  const mailboxStatus = outcome.ok
    ? outcome.mailboxes.length === 0 ? "尚未连接" : `已登记 ${outcome.mailboxes.length} 个邮箱`
    : "暂时无法获取邮箱状态";
  const owner = principal.kind === "owner";
  const identityRow = owner
    ? `<div class="setting-row"><div class="account-identity"><img class="account-avatar" src="/brand/logo/dark/symbol.webp" alt="" width="48" height="48"><div><strong>本地 Owner</strong>
<p class="hint">当前账号 · 仅属于本部署实例</p><p><code>${escapeText(principal.accountId)}</code></p></div></div><span class="pill ok">已登录</span></div>
<div class="setting-row"><div><strong>狐邮应用访问</strong>
<p class="hint">本地 Owner 直接使用本部署实例，不需要 Mira ID 应用授权，也不会因此获得任何 Mira ID 账号的数据。</p></div><span class="pill muted">本地实例</span></div>
<div class="setting-row"><div><strong>授权能力 · ${escapeText(service.name)}</strong>
<p class="hint">MCP 服务能力由狐邮实例自行声明；本地 Owner 登录不是 Mira ID 服务授权。</p></div><span class="pill muted">实例声明</span></div>`
    : `<div class="setting-row"><div class="account-identity"><img class="account-avatar" src="/brand/mira-id/mira-id-app.svg" alt="" width="48" height="48"><div><strong>Mira ID</strong>
<p class="hint">当前账号</p><p><code>${escapeText(principal.accountId)}</code></p></div></div><span class="pill ok">已连接</span></div>
<div class="setting-row"><div><strong>狐邮应用访问</strong>
<p class="hint">你已授权狐邮使用你的 Mira ID 身份。此状态不代表邮件服务权限或邮箱授权。</p></div><span class="pill ok">已授权</span></div>
<div class="setting-row"><div><strong>授权能力 · ${escapeText(service.name)}</strong>
<p class="hint">在 Mira ID 查看和管理智能体的实际服务授权。</p></div><a href="${grantsUrl}">查看授权 ${webIcon("arrow")}</a></div>`;
  const applicationsRow = owner
    ? `<div class="setting-row"><div><strong>应用管理</strong>
<p class="hint">修改本地 Owner 密码并查看本实例公开摘要；APP Secret 不在本页管理。</p></div><a href="${APPLICATIONS_PATH}">进入应用管理 ${webIcon("arrow")}</a></div>`
    : "";
  const footnote = owner
    ? "退出狐邮不会解绑你的邮箱。本地 Owner 密码与邮箱服务商授权是不同凭据。"
    : "退出狐邮不会解绑你的邮箱，也不会撤销 Mira ID 中的服务授权。";
  return `<h1>账户</h1>
<p class="lead">${owner
    ? "当前使用本部署实例的本地 Owner 账号。账户、邮箱与业务能力与 Mira ID 用户共用同一套狐邮页面。"
    : "使用 Mira ID 进入狐邮。你的身份、应用授权与邮箱连接分别管理。"}</p>
<div class="settings">
${identityRow}
${applicationsRow}
<div class="setting-row"><div><strong>邮箱</strong><p class="hint">${mailboxStatus}</p></div><a href="/account/mailboxes">管理邮箱 ${webIcon("arrow")}</a></div>
</div>
<div class="setting-actions"><form method="post" action="/auth/logout"><button class="button secondary" type="submit">退出狐邮</button></form></div>
<p class="footnote">${footnote}</p>
<details class="instance-details">
<summary>应用实例</summary>
<div class="instance-content">
<h2>${escapeText(manifest.name)}</h2>
<p class="hint">当前部署公开信息，不代表你拥有或管理此应用。</p>
<dl class="instance-fields">
<div><dt>应用 ID</dt><dd><code>${escapeText(manifest.appId)}</code></dd></div>
<div><dt>应用地址</dt><dd><code>${escapeText(instance.origin)}</code></dd></div>
<div><dt>MCP</dt><dd><code>${escapeText(service.protocol.endpoint)}</code></dd></div>
<div><dt>实例声明权限（非当前用户授权）</dt><dd><code>${escapeText(service.scopes.join(", "))}</code></dd></div>
</dl>
<p class="hint">登记凭据由部署环境安全保管。应用登记与所有权管理在 Mira ID 的「我的应用」完成。</p>
<a class="button secondary" href="${appsUrl}">在 Mira ID 中管理 ${webIcon("arrow")}</a>
</div></details>`;
}

type ApplicationSecretPanel = {
  state: AppSecretStatus | null;
  error: "password" | "conflict" | "rotated" | "unavailable" | null;
  revealed: { value: string; state: AppSecretStatus } | null;
};

function renderApplicationsPage(
  instance: NonNullable<ReturnType<typeof resolveApplicationInstance>>,
  credential: OwnerCredential,
  notice: "owner_password_changed" | null,
  passwordError: boolean,
  secrets: ApplicationSecretPanel,
): string {
  const manifest = applicationManifest(instance);
  const service = manifest.services[0]!;
  const banner = passwordError
    ? `<div class="notice error" role="alert"><strong>密码没有修改</strong>
<p>当前密码不正确，或新密码不符合要求。新密码至少 12 个字符，且不能与当前密码相同。</p></div>`
    : credential.mustChangePassword
      ? `<div class="notice auth-required" role="status"><strong>首次登录需要修改初始密码</strong>
<p>完成修改前，账户与邮箱业务页面不可用。这是本部署实例唯一的本地 Owner 账号。</p></div>`
      : notice === "owner_password_changed"
        ? `<div class="notice ok" role="status"><p>Owner 密码已更新。旧密码和此前签发的 Owner 会话已失效。</p></div>`
        : "";
  const secretError = secrets.error === "password"
    ? `<div class="notice error" role="alert"><strong>操作没有完成</strong>
<p>当前 Owner 密码不正确。请重新输入后重试。</p></div>`
    : secrets.error === "conflict"
      ? `<div class="notice error" role="alert"><strong>操作没有完成</strong>
<p>AppSecret 状态已经变化，本次请求未生效。请刷新页面后重试。</p></div>`
      : secrets.error === "rotated"
        ? `<div class="notice" role="status"><strong>初始 AppSecret 已不可查看</strong>
<p>本实例已经完成过轮换，部署初始 Secret 不再显示。如果当前轮换 Secret 已遗失，请直接再次轮换。</p></div>`
        : secrets.error === "unavailable"
          ? `<div class="notice error" role="alert"><strong>AppSecret 操作暂不可用</strong>
<p>无法读取本实例的 AppSecret 状态，因此没有执行查看或轮换。请稍后重试。</p></div>`
          : "";
  const secretStatus = secrets.state === null
    ? `<div class="setting-row"><div><strong>当前状态</strong>
<p class="hint">暂时无法读取本实例的 AppSecret 状态，因此不提供查看或轮换操作。请稍后重试。</p></div><span class="pill bad">不可用</span></div>`
    : secrets.state.kind === "bootstrap"
      ? `<div class="setting-row"><div><strong>当前状态</strong>
<p class="hint">当前有效的是部署环境提供的初始 Secret，本实例内尚未轮换。</p></div><span class="pill warn">部署初始 Secret</span></div>`
      : `<div class="setting-row"><div><strong>当前状态</strong>
<p class="hint">已由本实例 Owner 轮换。部署初始 Secret 和此前所有轮换 Secret 都已失效。</p>
<p class="hint">当前版本 <code>${secrets.state.version}</code> · 轮换时间 <code>${escapeText(new Date(secrets.state.rotatedAt).toISOString())}</code></p></div><span class="pill ok">已轮换</span></div>`;
  const revealed = secrets.revealed
    ? `<div class="notice ok" role="status">
<strong>${secrets.revealed.state.kind === "bootstrap" ? "部署初始 AppSecret" : "新的 AppSecret（仅显示一次）"}</strong>
<p>${secrets.revealed.state.kind === "bootstrap"
    ? "该 Secret 来自部署环境，仅用于本实例现在的 Mira ID 登记验证。首次轮换后它会立即失效，并且不再可查看。"
    : "请立即复制并安全保存。离开本页后不会再次完整显示；遗失后只能由 Owner 再次轮换。"}</p>
<pre class="secret-value" aria-label="当前 AppSecret">${escapeText(secrets.revealed.value)}</pre>
<p class="hint">不要把 Secret 写入 URL、聊天记录、工单、日志或公开仓库。</p>
</div>`
    : "";
  const secretActions = credential.mustChangePassword || secrets.state === null
    ? ""
    : `${secrets.state.kind === "bootstrap"
      ? `<form class="owner-password-form" method="post" action="${APPLICATIONS_SECRET_VIEW_PATH}">
<p><label for="owner-view-secret-password">当前 Owner 密码</label><br>
<input id="owner-view-secret-password" type="password" name="currentPassword" autocomplete="current-password" required maxlength="${OWNER_PASSWORD_MAX_LENGTH}"></p>
<button class="button secondary" type="submit">查看部署初始 AppSecret</button>
</form>`
      : `<p class="hint">部署初始 Secret 在首次轮换后不可再查看。如果当前轮换 Secret 已遗失，请直接再次轮换。</p>`}
<form class="owner-password-form" method="post" action="${APPLICATIONS_SECRET_ROTATE_PATH}">
<p><label for="owner-rotate-secret-password">当前 Owner 密码</label><br>
<input id="owner-rotate-secret-password" type="password" name="currentPassword" autocomplete="current-password" required maxlength="${OWNER_PASSWORD_MAX_LENGTH}"></p>
<button class="button" type="submit">轮换 AppSecret</button>
</form>
<p class="footnote">轮换只改变未来登记验证使用的凭据；不会撤销 Mira ID ownership、普通用户登录、邮箱连接、服务授权或 MCP 凭据。</p>`;
  return `<h1>应用管理</h1>
<p class="lead">仅本部署实例的本地 Owner 可见。这里管理 Owner 登录凭据、实例登记信息与 AppSecret 生命周期。</p>
${banner}
<section aria-labelledby="owner-password">
<h2 id="owner-password">Owner 登录</h2>
<div class="settings">
<div class="setting-row"><div><strong>登录名</strong><p class="hint">固定为 <code>${OWNER_LOGIN_NAME}</code>，仅属于本部署实例。</p></div><span class="pill ok">本地账号</span></div>
<div class="setting-row"><div><strong>账号 ID</strong><p><code>${escapeText(credential.accountId)}</code></p></div><span class="pill muted">独立于 Mira ID</span></div>
<div class="setting-row"><div><strong>密码状态</strong><p class="hint">${credential.mustChangePassword
    ? "仍在使用部署提供的初始密码；必须先修改。"
    : "已使用本地设置的密码；修改后旧会话和旧密码会立即失效。"}</p></div><span class="pill ${credential.mustChangePassword ? "warn" : "ok"}">${credential.mustChangePassword ? "需要修改" : "已设置"}</span></div>
</div>
<form class="owner-password-form" method="post" action="${APPLICATIONS_PASSWORD_PATH}">
<p><label for="owner-current-password">当前密码</label><br>
<input id="owner-current-password" type="password" name="currentPassword" autocomplete="current-password" required maxlength="${OWNER_PASSWORD_MAX_LENGTH}"></p>
<p><label for="owner-new-password">新密码</label><br>
<input id="owner-new-password" type="password" name="newPassword" autocomplete="new-password" required minlength="12" maxlength="${OWNER_PASSWORD_MAX_LENGTH}"></p>
<p><label for="owner-confirm-password">再次输入新密码</label><br>
<input id="owner-confirm-password" type="password" name="confirmPassword" autocomplete="new-password" required minlength="12" maxlength="${OWNER_PASSWORD_MAX_LENGTH}"></p>
<button class="button" type="submit">修改 Owner 密码</button>
</form>
<p class="footnote">密码只以加盐的不可逆摘要保存；页面、日志和响应都不会回显密码。</p>
</section>
<section aria-labelledby="instance-summary">
<h2 id="instance-summary">实例摘要</h2>
<dl class="instance-fields">
<div><dt>应用 ID</dt><dd><code>${escapeText(manifest.appId)}</code></dd></div>
<div><dt>应用地址</dt><dd><code>${escapeText(instance.origin)}</code></dd></div>
<div><dt>MCP</dt><dd><code>${escapeText(service.protocol.endpoint)}</code></dd></div>
<div><dt>实例声明权限（非当前用户授权）</dt><dd><code>${escapeText(service.scopes.join(", "))}</code></dd></div>
</dl>
</section>
<section aria-labelledby="app-secret">
<h2 id="app-secret">APP Secret</h2>
<p class="hint">APP_ID 稳定不变。AppSecret 只用于在 Mira ID 登记本实例的管理权，不是 OAuth client_secret、MCP 凭据或用户密码。</p>
${secretError}
${revealed}
<div class="settings">
${secretStatus}
</div>
${secretActions}
</section>
<div class="setting-actions"><form method="post" action="/auth/logout"><button class="button secondary" type="submit">退出狐邮</button></form></div>`;
}

function ownerNotice(value: string | null): "owner_password_changed" | null {
  return value === "owner_password_changed" ? value : null;
}

function baseUrl(env: WhoYouEnv): string | null {
  try {
    const u = new URL(env.CLOUD_AUTH_ISSUER ?? "");
    return u.protocol === "https:" && u.pathname === "/" && !u.username && !u.password && !u.search && !u.hash
      ? u.origin : null;
  } catch { return null; }
}
/** The app credential is only identity. Every protected request rechecks
 * issuer, instance, audience, subject and lifetime at the authoritative issuer.
 * No terminal credential or MCP write authority is minted for browser users.
 */
async function validateSession(env: WhoYouEnv, session: Session): Promise<boolean> {
  const base = baseUrl(env), instance = resolveApplicationInstance(env);
  if (!base || !instance || session.appId !== instance.appId ||
      session.audience !== instance.clientId || !isSession(session)) return false;
  try {
    const response = await fetch(new URL("/v1/oauth/application-session", base), {
      headers: { authorization: "Bearer " + session.accessToken }, redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const identity = await response.json() as Record<string, unknown>;
    return identity.issuer === session.issuer && identity.subject === session.subject &&
      identity.appId === session.appId && identity.audience === session.audience &&
      identity.expiresAt === session.expiresAt && Date.parse(session.expiresAt) > Date.now();
  } catch { return false; }
}

function ownerRepository(env: WhoYouEnv): OwnerRepository | null {
  return env.DB ? new OwnerRepository(env.DB) : null;
}

function applicationSecretRepository(env: WhoYouEnv): ApplicationSecretRepository | null {
  return env.DB ? new ApplicationSecretRepository(env.DB) : null;
}

/** A failed read is `null`, never a synthesized bootstrap state. */
async function loadAppSecretState(env: WhoYouEnv): Promise<AppSecretState | null> {
  const repository = applicationSecretRepository(env);
  if (!repository) return null;
  try { return await repository.current(); } catch { return null; }
}

async function loadOwnerCredential(env: WhoYouEnv): Promise<OwnerCredential | null> {
  const repository = ownerRepository(env);
  if (!repository) return null;
  try { return await repository.get(); } catch { return null; }
}

/**
 * Resolves exactly one authenticated browser principal. The two identity kinds
 * never mix: a present Owner cookie makes Owner the only candidate, and a
 * failed Owner resolution does not fall back to a co-existing Mira ID cookie.
 * The Mira branch is re-verified at the issuer by `verifyPrincipal` before any
 * protected business path; the Owner version is rechecked against D1.
 */
async function resolveWebPrincipal(
  request: Request,
  key: CryptoKey,
  env: WhoYouEnv,
  instance: NonNullable<ReturnType<typeof resolveApplicationInstance>>,
): Promise<WebPrincipal | null> {
  const rawOwner = getCookie(request, OWNER_SESSION_COOKIE);
  if (rawOwner !== null && rawOwner !== "") {
    const accountId = ownerAccountId(instance.appId);
    const session = await unseal(key, rawOwner, OWNER_SESSION_AAD);
    if (!isOwnerSession(session, { appId: instance.appId, accountId })) return null;
    const credential = await loadOwnerCredential(env);
    if (!credential || credential.accountId !== accountId
        || credential.credentialVersion !== session.credentialVersion) return null;
    return {
      kind: "owner",
      accountId,
      session,
      credentialVersion: credential.credentialVersion,
      mustChangePassword: credential.mustChangePassword,
    };
  }
  const session = await unseal(key, getCookie(request, SESSION_COOKIE));
  if (!isSession(session) || session.appId !== instance.appId
      || session.audience !== instance.clientId) return null;
  return { kind: "mira", accountId: session.subject, session };
}

/** Rechecks the resolved principal at its authority after any awaited work. */
async function verifyPrincipal(
  env: WhoYouEnv,
  principal: WebPrincipal,
): Promise<{ accountId: string } | null> {
  if (principal.kind === "mira") {
    return await validateSession(env, principal.session)
      ? { accountId: principal.session.subject } : null;
  }
  const credential = await loadOwnerCredential(env);
  return credential && credential.accountId === principal.accountId
    && credential.credentialVersion === principal.session.credentialVersion
    ? { accountId: credential.accountId } : null;
}

function createOwnerSession(
  instance: NonNullable<ReturnType<typeof resolveApplicationInstance>>,
  credential: OwnerCredential,
): OwnerSession {
  return {
    kind: "owner",
    appId: instance.appId,
    accountId: credential.accountId,
    credentialVersion: credential.credentialVersion,
    sessionId: random(),
    expiresAt: new Date(Date.now() + OWNER_SESSION_SECONDS * 1000).toISOString(),
  };
}

async function readForm(
  request: Request,
  allowed: string[],
  maxBytes: number,
): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const raw = await request.text();
  if (raw.length > maxBytes) return null;
  const form = new URLSearchParams(raw);
  if ([...form.keys()].some((name) => !allowed.includes(name))) return null;
  return form;
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

/** Whitelists the server list into the fields the browser is allowed to see. */
const INVALID_SYNC = Symbol("invalid_sync");
function projectSync(value: unknown): WebMailboxSync | null | typeof INVALID_SYNC {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return INVALID_SYNC;
  const item = value as Record<string, unknown>;
  const lastSyncedAt = item.lastSyncedAt;
  const lastError = item.lastError;
  if (lastSyncedAt !== null
      && (typeof lastSyncedAt !== "number" || !Number.isInteger(lastSyncedAt) || lastSyncedAt < 0)) {
    return INVALID_SYNC;
  }
  if (lastError !== null
      && (typeof lastError !== "string" || !/^[a-z0-9_]{1,64}$/.test(lastError))) {
    return INVALID_SYNC;
  }
  if (typeof item.inProgress !== "boolean" || typeof item.initialImportComplete !== "boolean") {
    return INVALID_SYNC;
  }
  return {
    lastSyncedAt: lastSyncedAt === null ? null : lastSyncedAt as number,
    lastError: lastError === null ? null : lastError as string,
    inProgress: item.inProgress,
    initialImportComplete: item.initialImportComplete,
  };
}

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
    const sync = projectSync(item.sync);
    if (sync === INVALID_SYNC) return null;
    projected.push({
      mailboxId: item.mailboxId,
      address: item.address,
      kind: item.kind,
      provider: item.provider,
      credentialStatus,
      availability: mailboxAvailability(item.kind, item.status, credentialStatus, item.provider, env),
      sync,
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

async function fetchMailboxList(env: WhoYouEnv, principal: WebPrincipal): Promise<MailboxListOutcome> {
  const verified = await verifyPrincipal(env, principal);
  if (!verified) return { ok: false, error: "authentication_link_unavailable" };
  return listVerifiedAccountMailboxes(env, verified.accountId);
}

// Caller has already verified the application session for this exact account.
async function listVerifiedAccountMailboxes(env: WhoYouEnv, accountId: string): Promise<MailboxListOutcome> {
  const resolved = createMailServices(env);
  if (!resolved.ok) return { ok: false, error: "mailboxes_unavailable", reason: resolved.reason };
  const services = resolved.services;
  const identities = await listIdentities(services.repository, services.credentials, services.syncStates, accountId);
  const mailboxes = projectMailboxes({ identities: identities.map(entry => ({
    mailboxId: entry.mailbox.id, address: entry.mailbox.address, kind: entry.mailbox.kind,
    provider: entry.mailbox.provider, status: entry.mailbox.status,
    credentialStatus: entry.credentialStatus, sync: entry.sync,
  })) }, env);
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
  principal: WebPrincipal,
  url: URL,
): Promise<Response> {
  if ([...url.searchParams.keys()].length > 0) return jsonError(400, "unexpected_parameter");
  if (request.headers.has("authorization")) return jsonError(400, "unexpected_authorization");
  const outcome = await fetchMailboxList(env, principal);
  if (!outcome.ok) {
    return outcome.error === "mailboxes_unavailable"
      ? jsonError(503, "mailboxes_unavailable", headers(), { reason: outcome.reason ?? "" })
      : jsonError(502, outcome.error);
  }
  const h = headers(); h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ mailboxes: outcome.mailboxes }), { headers: h });
}

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

async function startWebGmailLink(env: WhoYouEnv, principal: WebPrincipal): Promise<GmailWebAction> {
  const verified = await verifyPrincipal(env, principal);
  if (!verified) return { ok: false, code: "authentication_link_unavailable" };
  if (!gmailWebReady(env)) return { ok: false, code: "provider_not_configured" };
  const resolved = createMailServices(env);
  if (!resolved.ok) return { ok: false, code: resolved.reason };
  const services = resolved.services;
  if (!services.oauth || !services.gmailRedirectUri) return { ok: false, code: "provider_not_configured" };
  // Human-only same-origin POST; the existing provider state is single-use
  // and account-bound. It cannot be invoked via the MCP bearer surface.
  const started = await startGmailLink({ states: services.oauthStates, oauth: services.oauth,
    redirectUri: services.gmailRedirectUri }, { accountId: verified.accountId, now: Date.now() });
  const start = parseGmailLinkStart({ provider: "gmail", ...started });
  return start ? { ok: true, start } : { ok: false, code: "invalid_link_response" };
}

type GmailUnlinkOutcome = { ok: true } | { ok: false; code: string };
async function unlinkWebGmail(
  env: WhoYouEnv,
  principal: WebPrincipal,
  mailboxId: string,
): Promise<GmailUnlinkOutcome> {
  const listed = await fetchMailboxList(env, principal);
  if (!listed.ok) return { ok: false, code: listed.error };
  const mailbox = listed.mailboxes.find((entry) => entry.mailboxId === mailboxId);
  if (!mailbox) return { ok: true };
  if (mailbox.kind !== "third_party" || mailbox.provider !== "gmail") {
    return { ok: false, code: "mailbox_not_gmail" };
  }
  if (!resolveCredentialKeys(env)) return { ok: false, code: "credential_vault_unavailable" };
  const resolved = createMailServices(env);
  if (!resolved.ok) return { ok: false, code: resolved.reason };
  const services = resolved.services;
  const verified = await verifyPrincipal(env, principal);
  if (!verified) return { ok: false, code: "authentication_link_unavailable" };
  // Ownership is resolved again under the existing unlink lease. Same-origin
  // human POST is separate from the agent's identity-confirmation credential.
  const result = await unlinkMailbox({ repository: services.repository, credentials: services.credentials,
    keys: services.credentialKeys, oauth: services.oauth, remoteTargets: services.remoteTargets,
    syncStates: services.syncStates }, { accountId: verified.accountId, mailboxId: mailbox.mailboxId, now: Date.now() });
  return result.ok ? { ok: true } : { ok: false, code: result.code };
}

type WebGmailSync =
  | { ok: true; counts: SyncCounts }
  | { ok: false; code: string };

/**
 * Starts one bounded Gmail batch for the verified human account; the existing
 * sync lease and owner checks are shared with the MCP business implementation.
 */
async function syncWebGmail(
  env: WhoYouEnv,
  principal: WebPrincipal,
  mailboxId: string,
): Promise<WebGmailSync> {
  const listed = await fetchMailboxList(env, principal);
  if (!listed.ok) return { ok: false, code: listed.error };
  const mailbox = listed.mailboxes.find((entry) => entry.mailboxId === mailboxId);
  if (!mailbox) return { ok: false, code: "mailbox_not_found" };
  if (mailbox.kind !== "third_party" || mailbox.provider !== "gmail") {
    return { ok: false, code: "mailbox_not_gmail" };
  }
  if (!gmailWebReady(env)) return { ok: false, code: "provider_not_configured" };

  const resolved = createMailServices(env);
  if (!resolved.ok) return { ok: false, code: resolved.reason };
  const services = resolved.services;
  const { credentialKeys, oauth, gmail } = services;
  if (!credentialKeys || !oauth || !gmail) return { ok: false, code: "provider_not_configured" };
  const verified = await verifyPrincipal(env, principal);
  if (!verified) return { ok: false, code: "authentication_link_unavailable" };
  const owned = await services.repository.findMailboxById(verified.accountId, mailboxId);
  if (!owned || owned.kind !== "third_party" || owned.provider !== "gmail") return { ok: false, code: "mailbox_not_found" };
  if (owned.status !== "active") return { ok: false, code: "mailbox_disabled" };
  const outcome = await syncGmailMailbox({ repository: services.repository, limits: services.limits,
    credentials: services.credentials, keys: credentialKeys, oauth, gmail,
    syncStates: services.syncStates, now: Date.now() }, owned);
  if (!outcome.ok) return { ok: false, code: outcome.code };
  const counts = parseSyncCounts(outcome);
  return counts ? { ok: true, counts } : { ok: false, code: "invalid_sync_response" };
}

function syncNotice(code: string): MailboxNotice {
  switch (code) {
    case "sync_in_progress": return "gmail_sync_busy";
    case "provider_reauth_required":
    case "credential_reauth_required": return "gmail_sync_reauth";
    case "provider_not_configured":
    case "credential_vault_unavailable":
    case "mail_storage_not_configured": return "gmail_sync_unavailable";
    case "mailbox_not_found":
    case "mailbox_not_gmail":
    case "mailbox_disabled":
    case "insufficient_scope": return "gmail_sync_rejected";
    default: return "gmail_sync_failed";
  }
}

function syncRedirectLocation(sync: WebGmailSync): string {
  if (!sync.ok) return `/account/mailboxes?notice=${syncNotice(sync.code)}`;
  const query = new URLSearchParams({
    notice: "gmail_sync_completed",
    imported: String(sync.counts.imported),
    duplicates: String(sync.counts.duplicates),
    skipped: String(sync.counts.skipped),
  });
  return `/account/mailboxes?${query.toString()}`;
}

type MailboxNotice = GmailCallbackNotice
  | "gmail_unlinked" | "gmail_unlink_failed" | "gmail_unlink_busy" | "gmail_unavailable"
  | "gmail_sync_completed" | "gmail_sync_busy" | "gmail_sync_reauth"
  | "gmail_sync_failed" | "gmail_sync_unavailable" | "gmail_sync_rejected";
const MAILBOX_NOTICE_MESSAGES: Record<MailboxNotice, { tone: "ok" | "error"; text: string }> = {
  gmail_connected: { tone: "ok", text: "Gmail 已连接。邮箱地址来自 Google 授权结果。" },
  gmail_relinked: { tone: "ok", text: "Gmail 授权已更新。" },
  gmail_denied: { tone: "error", text: "Gmail 授权没有完成，没有保存新的授权凭据。" },
  gmail_link_failed: { tone: "error", text: "Gmail 连接失败，没有把这次尝试标记为已连接。" },
  gmail_unlinked: { tone: "ok", text: "Gmail 已解绑；狐邮本地凭据与同步副本已删除。" },
  gmail_unlink_failed: { tone: "error", text: "Gmail 解绑没有完成，请稍后重试。" },
  gmail_unlink_busy: { tone: "error", text: "该邮箱有尚未结束的操作，本次未解绑。请在操作完成后重试。" },
  gmail_unavailable: { tone: "error", text: "当前运行环境还没有配置 Gmail OAuth 或凭据加密能力。" },
  gmail_sync_completed: { tone: "ok", text: "本次 Gmail 同步批次已完成。" },
  gmail_sync_busy: { tone: "error", text: "该邮箱已有同步批次正在运行；本次没有重复启动。" },
  gmail_sync_reauth: { tone: "error", text: "Gmail 授权已失效；需要重新授权后才能继续同步。" },
  gmail_sync_failed: { tone: "error", text: "本次 Gmail 同步失败，未标记为成功。" },
  gmail_sync_unavailable: { tone: "error", text: "当前运行环境缺少 Gmail 同步所需配置。" },
  gmail_sync_rejected: { tone: "error", text: "同步请求被拒绝；没有读取任何邮件。" },
};
function mailboxNotice(value: string | null): MailboxNotice | null {
  return value && value in MAILBOX_NOTICE_MESSAGES ? value as MailboxNotice : null;
}

type SyncCounts = { imported: number; duplicates: number; skipped: number };

const boundedCount = (value: unknown, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value : null;

/** Reads only the three bounded counters the manual batch may report. */
function parseSyncCounts(value: unknown): SyncCounts | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const imported = boundedCount(item.imported, GMAIL_SYNC_MAX_MESSAGES_PER_RUN);
  const duplicates = boundedCount(item.duplicates, 500);
  const skipped = boundedCount(item.skipped, 500);
  return imported === null || duplicates === null || skipped === null
    ? null : { imported, duplicates, skipped };
}

function syncCountsFromQuery(url: URL): SyncCounts | null {
  const imported = parseCount(url.searchParams.get("imported"), GMAIL_SYNC_MAX_MESSAGES_PER_RUN);
  const duplicates = parseCount(url.searchParams.get("duplicates"), 500);
  const skipped = parseCount(url.searchParams.get("skipped"), 500);
  return imported === null || duplicates === null || skipped === null
    ? null : { imported, duplicates, skipped };
}

function parseCount(value: string | null, max: number): number | null {
  if (value === null || !/^\d{1,4}$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed <= max ? parsed : null;
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

type MailboxSyncState = { label: string; tone: "ok" | "warn" | "bad" | "muted"; hint: string };

/**
 * Sync state is projected from the stored cursor row, never inferred from a
 * button click. "成功" requires a recorded lastSyncedAt with no lastError;
 * a backfill that has not handed over to the cursor stays visibly partial.
 */
function mailboxSyncState(mailbox: WebMailbox): MailboxSyncState | null {
  if (mailbox.kind !== "third_party" || mailbox.provider !== "gmail") return null;
  if (!mailbox.sync) {
    return { label: "尚未同步", tone: "muted", hint: "还没有可用的同步记录。" };
  }
  if (mailbox.sync.lastError === "sync_recovery_required") {
    return { label: "同步待恢复", tone: "bad", hint: "有未确认结束的邮箱操作；请联系维护者确认安全恢复，不能自动重试或解绑。" };
  }
  if (mailbox.sync.inProgress) {
    return { label: "同步进行中", tone: "warn", hint: "一次同步批次正在运行；完成后状态会更新。" };
  }
  if (mailbox.sync.lastError === "unlink_pending") {
    return { label: "解绑未完成", tone: "bad", hint: "上次解绑尚未完成清理；请重试解绑，不可继续同步或更新授权。" };
  }
  if (mailbox.credentialStatus === "reauth_required") {
    return { label: "需要重新授权", tone: "warn",
      hint: "授权已失效，同步已停止；重新授权后才能继续。" };
  }
  if (mailbox.credentialStatus === "unreadable" || mailbox.credentialStatus === "revoked") {
    return { label: "凭据不可用", tone: "bad", hint: "无法读取授权凭据，当前不能同步。" };
  }
  if (mailbox.sync.lastError) {
    return { label: "上次同步失败", tone: "bad",
      hint: `固定错误分类：${mailbox.sync.lastError}。失败不会标记为成功。` };
  }
  if (mailbox.sync.lastSyncedAt !== null) {
    const time = new Date(mailbox.sync.lastSyncedAt).toISOString();
    return mailbox.sync.initialImportComplete
      ? { label: "同步成功", tone: "ok", hint: `最近同步时间：${time}。` }
      : { label: "初始同步进行中", tone: "warn",
        hint: `最近批次时间：${time}；初始回填尚未完成，再次同步会继续推进。` };
  }
  return { label: "尚未同步", tone: "muted", hint: "还没有可用的同步记录。" };
}

function renderMailbox(mailbox: WebMailbox, env: WhoYouEnv): string {
  const availability = AVAILABILITY_LABELS[mailbox.availability];
  const isGmail = mailbox.kind === "third_party" && mailbox.provider === "gmail";
  const canLink = gmailWebReady(env);
  const canUnlink = Boolean(resolveCredentialKeys(env));
  const syncState = mailboxSyncState(mailbox);
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
${syncState ? `<p class="meta"><span class="pill ${syncState.tone}">${escapeText(syncState.label)}</span>
${escapeText(syncState.hint)}</p>` : ""}
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
  counts: SyncCounts | null,
  loginHref: string,
): string {
  const noticeContent = notice ? MAILBOX_NOTICE_MESSAGES[notice] : null;
  const syncDetail = notice === "gmail_sync_completed" && counts
    ? `<p>本次导入 ${counts.imported} 封，重复 ${counts.duplicates} 封，跳过 ${counts.skipped} 封。</p>`
    : "";
  const banner = noticeContent
    ? `<div class="notice ${noticeContent.tone === "ok" ? "ok" : "error"}" role="status"><p>${escapeText(noticeContent.text)}</p>${syncDetail}</div>`
    : "";
  const mailboxSection = outcome.ok
    ? (outcome.mailboxes.length
      ? `<ul class="mailboxes">${outcome.mailboxes.map((mailbox) => renderMailbox(mailbox, env)).join("")}</ul>`
      : `<div class="notice"><p>当前账号还没有登记邮箱。尚未连接。</p>
<p>连接 Gmail 后，真实授权成功的邮箱会出现在这里。</p></div>`)
    : `<div class="notice error" role="alert">
<strong class="notice-heading">${webIcon("control")} 暂时无法获取邮箱</strong>
<p>${escapeText(mailboxFailureMessage(outcome.error))}</p>
<div class="inline-actions"><a href="/account/mailboxes">重试</a>
<a href="${escapeText(loginHref)}">重新登录</a></div></div>`;
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
<p class="hint">通过 Google OAuth 授权狐邮读取与发送邮件；连接 Mira ID 本身不会授予 Gmail 权限。</p>
${gmailReady ? '<form method="post" action="/account/mailboxes/gmail/link"><button type="submit">连接 Gmail</button></form>' : ""}</li>
<li><strong>Microsoft</strong> <span class="pill muted">尚未开放</span>
<p class="hint">暂不支持连接 Microsoft 邮箱。</p></li>
<li><strong>IMAP/SMTP</strong> <span class="pill muted">尚未开放</span>
<p class="hint">暂不支持自定义邮箱服务器。</p></li>
</ul>
</section>
<p class="footnote">“本地配置就绪”只说明狐邮运行环境已准备好必要依赖，不代表邮箱连接成功或可以收发邮件。
同步状态只反映服务端已有的真实同步记录，不代表自动调度已经启用。</p>`;
}

/** Isolated browser login/BFF. The existing /mcp bearer gate is unchanged. */
async function handleWebRequestInternal(request: Request, env: WhoYouEnv): Promise<Response | null> {
  const u = new URL(request.url), path = u.pathname;
  const webPaths = [
    "/", "/privacy", "/terms", "/auth/start", "/auth/callback", "/auth/logout",
    "/auth/owner/login", "/account",
    "/account/mailboxes", "/account/mailboxes/gmail/link", "/account/mailboxes/unlink",
    "/account/mailboxes/sync", APPLICATIONS_PATH, APPLICATIONS_PASSWORD_PATH,
    APPLICATIONS_SECRET_VIEW_PATH, APPLICATIONS_SECRET_ROTATE_PATH,
    "/api/whoami", "/api/mailboxes",
  ];
  if (!webPaths.includes(path) && path !== GMAIL_CALLBACK_PATH) return null;
  const browser = !path.startsWith("/api/") && acceptsHtml(request);
  const respondError = (status: number, code: string, outgoing = headers()): Response => {
    if (browser) return errorPage(status, code, outgoing);
    if (!path.startsWith("/api/")) outgoing.set("vary", "Accept");
    return jsonError(status, code, outgoing);
  };

  const resource = resolveInstanceResource(env);
  if (!resource) return respondError(503, "application_not_configured");
  const ORIGIN = resource.origin;
  if (u.origin !== ORIGIN) return jsonError(404, "not_found");
  // Public disclosures do not depend on login or registration secrets.
  if (path === "/privacy" || path === "/terms") {
    if (request.method !== "GET") return respondError(405, "method_not_allowed");
    return page(path === "/privacy" ? privacyPolicy : serviceTerms);
  }
  const instance = resolveApplicationInstance(env);
  if (!instance) return respondError(503, "application_not_configured");
  const key = await importSessionKey(env.WHOYOU_WEB_SESSION_KEY), base = baseUrl(env);
  if (!key || !base) return respondError(503, "web_login_not_configured");

  if (path === "/auth/owner/login") {
    if (request.method !== "POST") return respondError(405, "method_not_allowed");
    if (!sameOriginPost(request, ORIGIN)) return respondError(403, "origin_not_allowed");
    if (request.headers.has("authorization")) return respondError(400, "unexpected_authorization");
    if ([...u.searchParams.keys()].some((name) => name !== "returnTo")) {
      return respondError(400, "unexpected_parameter");
    }
    const form = await readForm(request, ["username", "password"], 4096);
    if (!form) return respondError(400, "invalid_request");
    const repository = ownerRepository(env);
    if (!repository) return respondError(503, "owner_login_not_configured");
    let login: Awaited<ReturnType<typeof authenticateOwner>>;
    try {
      login = await authenticateOwner({
        repository,
        accountId: ownerAccountId(instance.appId),
        initialPassword: env.WHOYOU_OWNER_INITIAL_PASSWORD,
        loginName: form.get("username") ?? "",
        password: form.get("password") ?? "",
        now: Date.now(),
      });
    } catch {
      return respondError(503, "owner_login_not_configured");
    }
    const returnTo = returnToFrom(u.searchParams.get("returnTo"));
    if (!login.ok) {
      return page(renderLoginPage(returnTo, false, true), headers(),
        login.code === "temporarily_locked" ? 429 : 401, { shell: "home" });
    }
    const h = headers();
    addCookie(h, OWNER_SESSION_COOKIE,
      await seal(key, createOwnerSession(instance, login.credential), OWNER_SESSION_AAD),
      OWNER_SESSION_SECONDS);
    // One browser acts as one principal; local caches of the other identity go away.
    addCookie(h, SESSION_COOKIE, "", 0);
    return redirect(login.credential.mustChangePassword ? APPLICATIONS_PATH : returnTo, h);
  }

  if (path === GMAIL_CALLBACK_PATH) {
    if (request.method !== "GET") return respondError(405, "method_not_allowed");
    const state = u.searchParams.get("state");
    const h = headers();
    const prior = await unseal(key, getCookie(request, MAIL_OAUTH_RESULT_COOKIE));
    if (isMailOAuthResult(prior) && prior.state === state) {
      addCookie(h, MAIL_OAUTH_COOKIE, "", 0);
      return redirect(`/account/mailboxes?notice=${prior.notice}`, h);
    }

    const rawFlowCookie = getCookie(request, MAIL_OAUTH_COOKIE);
    // The public V1 MCP grant is read-only. Only the human Web flow can
    // start Gmail linking; a bare callback cannot bypass app-session checks.
    if (rawFlowCookie === null) return respondError(400,
      u.searchParams.has("error") ? "provider_reauth_required" : "invalid_state");

    const flow = await unseal(key, rawFlowCookie);
    if (!isMailOAuthFlow(flow)) {
      // Never treat an unreadable sealed flow as valid provider authorization.
      return redirect("/account/mailboxes?notice=gmail_link_failed", h);
    }
    if (flow.state !== state) {
      // Do not destroy the legitimate pending flow because an unrelated callback
      // reached this browser.
      return redirect("/account/mailboxes?notice=gmail_link_failed", h);
    }
    const current = await resolveWebPrincipal(request, key, env, instance);
    const currentVerified = current && !(current.kind === "owner" && current.mustChangePassword)
      ? await verifyPrincipal(env, current) : null;
    if (!current || !currentVerified
        || flow.sessionBinding !== await sessionBinding(current)) {
      if (await discardWebGmailState(env, flow.state)) {
        addCookie(h, MAIL_OAUTH_COOKIE, "", 0);
        await rememberMailOAuthResult(h, key, flow.state, "gmail_link_failed");
      }
      return redirect("/account/mailboxes?notice=gmail_link_failed", h);
    }

    if (u.searchParams.has("error") || !u.searchParams.get("code")) {
      const discarded = await discardWebGmailState(env, flow.state);
      const notice: GmailCallbackNotice = u.searchParams.has("error")
        ? "gmail_denied" : "gmail_link_failed";
      if (discarded) {
        addCookie(h, MAIL_OAUTH_COOKIE, "", 0);
        await rememberMailOAuthResult(h, key, flow.state, notice);
      }
      return redirect(`/account/mailboxes?notice=${notice}`, h);
    }

    addCookie(h, MAIL_OAUTH_COOKIE, "", 0);
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
    await rememberMailOAuthResult(h, key, flow.state, notice);
    return redirect(`/account/mailboxes?notice=${notice}`, h);
  }

  if (path === "/") {
    if (request.method !== "GET") return respondError(405, "method_not_allowed");
    const current = await resolveWebPrincipal(request, key, env, instance);
    if (current && await verifyPrincipal(env, current)) {
      return redirect(current.kind === "owner" && current.mustChangePassword
        ? APPLICATIONS_PATH : "/account");
    }
    const returnTo = returnToFrom(u.searchParams.get("returnTo"));
    const blocked = u.searchParams.get("reason") === "sign_in_required";
    return page(renderLoginPage(returnTo, blocked), headers(), 200, { shell: "home" });
  }

  if (path === "/auth/start") {
    if (request.method !== "GET") return respondError(405, "method_not_allowed");
    const returnTo = returnToFrom(u.searchParams.get("returnTo"));
    const state = random(), verifier = random();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const h = headers();
    addCookie(h, STATE_COOKIE, await seal(key, {
      state, verifier, appId: instance.appId, returnTo, at: Date.now(),
    }), 300);
    const authorize = new URL("/v1/oauth/authorize", base);
    authorize.search = new URLSearchParams({
      response_type: "code", client_id: instance.clientId, redirect_uri: instance.callback,
      state, code_challenge: encode(hash), code_challenge_method: "S256",
    }).toString();
    return redirect(authorize.href, h);
  }

  if (path === "/auth/callback") {
    if (request.method !== "GET") return respondError(405, "method_not_allowed");
    const flow = await unseal(key, getCookie(request, STATE_COOKIE));
    const h = headers(); addCookie(h, STATE_COOKIE, "", 0);
    if (!isFlow(flow) || flow.appId !== instance.appId || flow.state !== u.searchParams.get("state")
      || u.searchParams.has("error") || !u.searchParams.get("code"))
      return errorPage(200, "login_incomplete", h);
    try {
      const r = await fetch(new URL("/v1/oauth/token", base), {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual", signal: AbortSignal.timeout(5000),
        body: new URLSearchParams({
          grant_type: "authorization_code", client_id: instance.clientId,
          code: u.searchParams.get("code")!, redirect_uri: instance.callback,
          code_verifier: flow.verifier,
        }).toString(),
      });
      if (!r.ok) return respondError(401, "cloud_auth_code_rejected", h);
      const value = await r.json() as Record<string, unknown>;
      const issued = { accessToken: value.access_token, expiresAt: value.expiresAt, subject: value.subject,
        audience: value.audience, appId: value.appId, issuer: value.issuer };
      if (Object.keys(value).some(k => !["access_token","token_type","expires_in","expiresAt","issuer","subject","audience","appId"].includes(k)) ||
          value.token_type !== "Bearer" || typeof value.expires_in !== "number" ||
          !Number.isInteger(value.expires_in) || value.expires_in <= 0 || value.expires_in > 3600 ||
          !isSession(issued) || Date.parse(issued.expiresAt) > Date.now() + 3600_000 ||
          !await validateSession(env, issued)) return respondError(502, "cloud_auth_invalid_session", h);
      const age = Math.min(3600, Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000));
      addCookie(h, SESSION_COOKIE, await seal(key, issued), age);
      // One browser acts as one principal; local caches of the other identity go away.
      addCookie(h, OWNER_SESSION_COOKIE, "", 0);
      return redirect(flow.returnTo === APPLICATIONS_PATH ? "/account" : flow.returnTo ?? "/account", h);
    } catch { return respondError(502, "cloud_auth_unavailable", h); }
  }

  if (path === "/auth/logout") {
    if (request.method !== "POST") return respondError(405, "method_not_allowed");
    if (!sameOriginPost(request, ORIGIN)) return respondError(403, "origin_not_allowed");
    const raw = await unseal(key, getCookie(request, SESSION_COOKIE));
    const h = headers();
    addCookie(h, SESSION_COOKIE, "", 0);
    addCookie(h, OWNER_SESSION_COOKIE, "", 0);
    if (isSession(raw) && raw.appId === instance.appId && raw.audience === instance.clientId) {
      try {
        const r = await fetch(new URL("/v1/oauth/application-session/logout", base), {
          method: "POST", headers: { authorization: `Bearer ${raw.accessToken}` }, redirect: "manual", signal: AbortSignal.timeout(5000),
        });
        if (!r.ok && r.status !== 401) return respondError(502, "logout_unconfirmed", h);
      } catch { return respondError(502, "logout_unconfirmed", h); }
    }
    return redirect("/", h);
  }

  const applicationsMutation = path === APPLICATIONS_PASSWORD_PATH
    || path === APPLICATIONS_SECRET_VIEW_PATH
    || path === APPLICATIONS_SECRET_ROTATE_PATH;
  const mutation = path === "/account/mailboxes/gmail/link"
    || path === "/account/mailboxes/unlink"
    || path === "/account/mailboxes/sync"
    || applicationsMutation;
  if (mutation) {
    if (request.method !== "POST") return respondError(405, "method_not_allowed");
    if (!sameOriginPost(request, ORIGIN)) return respondError(403, "origin_not_allowed");
    if (request.headers.has("authorization")) return respondError(400, "unexpected_authorization");
    if ([...u.searchParams.keys()].length > 0) return respondError(400, "unexpected_parameter");
  } else if (request.method !== "GET") return respondError(405, "method_not_allowed");
  const principal = await resolveWebPrincipal(request, key, env, instance);
  if (!principal) {
    if (mutation) {
      return redirect(guardLocation(applicationsMutation
        ? APPLICATIONS_PATH : "/account/mailboxes"));
    }
    if (validReturnTo(path)) return redirect(guardLocation(path));
    return respondError(401, "sign_in_required");
  }
  // A first-login Owner may only reach the application-management password
  // form until the initial password has been replaced.
  if (principal.kind === "owner" && principal.mustChangePassword
      && path !== APPLICATIONS_PATH && path !== APPLICATIONS_PASSWORD_PATH) {
    if (path.startsWith("/api/")) return respondError(403, "password_change_required");
    return redirect(APPLICATIONS_PATH);
  }

  if (path === "/account/mailboxes/gmail/link") {
    const started = await startWebGmailLink(env, principal);
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
      sessionBinding: await sessionBinding(principal),
    }), 600);
    return redirect(started.start.authorizationUrl, h);
  }

  if (path === "/account/mailboxes/unlink") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return respondError(415, "unsupported_media_type");
    }
    const raw = await request.text();
    if (raw.length > 512) return respondError(413, "request_too_large");
    const form = new URLSearchParams(raw);
    if ([...form.keys()].some((name) => name !== "mailboxId")) {
      return respondError(400, "unexpected_parameter");
    }
    const mailboxId = form.get("mailboxId") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(mailboxId)) {
      return respondError(400, "invalid_mailbox_id");
    }
    const unlinked = await unlinkWebGmail(env, principal, mailboxId);
    return redirect(`/account/mailboxes?notice=${unlinked.ok ? "gmail_unlinked" : unlinked.code === "sync_in_progress" ? "gmail_unlink_busy" : "gmail_unlink_failed"}`);
  }

  if (path === "/account/mailboxes/sync") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return respondError(415, "unsupported_media_type");
    }
    const raw = await request.text();
    if (raw.length > 512) return respondError(413, "request_too_large");
    const form = new URLSearchParams(raw);
    if ([...form.keys()].some((name) => name !== "mailboxId")) {
      return respondError(400, "unexpected_parameter");
    }
    const mailboxId = form.get("mailboxId") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(mailboxId)) {
      return respondError(400, "invalid_mailbox_id");
    }
    const synced = await syncWebGmail(env, principal, mailboxId);
    return redirect(syncRedirectLocation(synced));
  }

  if (path === "/account/mailboxes") {
    const outcome = await fetchMailboxList(env, principal);
    const notice = mailboxNotice(u.searchParams.get("notice"));
    const counts = notice === "gmail_sync_completed" ? syncCountsFromQuery(u) : null;
    const loginHref = principal.kind === "owner"
      ? "/" : "/auth/start?returnTo=%2Faccount%2Fmailboxes";
    return page(renderMailboxesPage(outcome, env, notice, counts, loginHref), headers(),
      outcome.ok ? 200 : outcome.error === "mailboxes_unavailable" ? 503 : 502,
      { shell: "app", active: "mailboxes", isOwner: principal.kind === "owner",
        sessionVerified: outcome.ok || outcome.error !== "authentication_link_unavailable" });
  }
  if (path === "/api/mailboxes") return handleMailboxList(request, env, principal, u);

  if (path === APPLICATIONS_PATH) {
    if (principal.kind !== "owner") return respondError(404, "not_found");
    const credential = await loadOwnerCredential(env);
    if (!credential || credential.credentialVersion !== principal.credentialVersion) {
      return respondError(401, "sign_in_required");
    }
    return page(renderApplicationsPage(instance, credential,
      ownerNotice(u.searchParams.get("notice")), false, {
        state: await loadAppSecretState(env), error: null, revealed: null,
      }), headers(), 200,
      { shell: "app", active: "applications", isOwner: true, sessionVerified: true,
        ownerPendingPasswordChange: credential.mustChangePassword });
  }

  if (path === APPLICATIONS_SECRET_VIEW_PATH) {
    if (principal.kind !== "owner") return respondError(404, "not_found");
    const form = await readForm(request, ["currentPassword"], 4096);
    if (!form) return respondError(400, "invalid_request");
    const credential = await loadOwnerCredential(env);
    if (!credential || credential.credentialVersion !== principal.credentialVersion) {
      return respondError(401, "sign_in_required");
    }
    const state = await loadAppSecretState(env);
    const render = (error: ApplicationSecretPanel["error"], revealed:
      ApplicationSecretPanel["revealed"], status: number): Response =>
      page(renderApplicationsPage(instance, credential, null, false, {
        state, error, revealed,
      }), headers(), status,
      { shell: "app", active: "applications", isOwner: true, sessionVerified: true });
    if (!await verifyOwnerPassword(form.get("currentPassword") ?? "", credential)) {
      return render("password", null, 403);
    }
    if (state === null) return render("unavailable", null, 503);
    if (state.kind === "rotated") return render("rotated", null, 409);
    if (!env.WHOYOU_APP_SECRET) return respondError(503, "application_not_configured");
    return render(null, { value: env.WHOYOU_APP_SECRET, state }, 200);
  }

  if (path === APPLICATIONS_SECRET_ROTATE_PATH) {
    if (principal.kind !== "owner") return respondError(404, "not_found");
    const form = await readForm(request, ["currentPassword"], 4096);
    if (!form) return respondError(400, "invalid_request");
    const credential = await loadOwnerCredential(env);
    if (!credential || credential.credentialVersion !== principal.credentialVersion) {
      return respondError(401, "sign_in_required");
    }
    const state = await loadAppSecretState(env);
    const render = (error: ApplicationSecretPanel["error"], status: number): Response =>
      page(renderApplicationsPage(instance, credential, null, false, {
        state, error, revealed: null,
      }), headers(), status,
      { shell: "app", active: "applications", isOwner: true, sessionVerified: true });
    if (!await verifyOwnerPassword(form.get("currentPassword") ?? "", credential)) {
      return render("password", 403);
    }
    if (state === null) return render("unavailable", 503);
    const repository = applicationSecretRepository(env);
    if (!repository) return render("unavailable", 503);
    const secret = generateAppSecret(), now = Date.now();
    let nextVersion: number | null;
    try {
      nextVersion = await repository.rotate({
        expectedVersion: state.kind === "rotated" ? state.version : 0,
        secret,
        now,
      });
    } catch {
      return render("unavailable", 503);
    }
    if (nextVersion === null) return render("conflict", 409);
    const rotated: AppSecretStatus = { kind: "rotated", version: nextVersion, rotatedAt: now };
    return page(renderApplicationsPage(instance, credential, null, false, {
      state: rotated, error: null, revealed: { value: secret, state: rotated },
    }), headers(), 200,
    { shell: "app", active: "applications", isOwner: true, sessionVerified: true });
  }

  if (path === APPLICATIONS_PASSWORD_PATH) {
    if (principal.kind !== "owner") return respondError(404, "not_found");
    const form = await readForm(request,
      ["currentPassword", "newPassword", "confirmPassword"], 8192);
    if (!form) return respondError(400, "invalid_request");
    const credential = await loadOwnerCredential(env);
    if (!credential || credential.credentialVersion !== principal.credentialVersion) {
      return respondError(401, "sign_in_required");
    }
    const currentPassword = form.get("currentPassword") ?? "";
    const newPassword = form.get("newPassword") ?? "";
    const confirmPassword = form.get("confirmPassword") ?? "";
    const currentValid = await verifyOwnerPassword(currentPassword, credential);
    if (!currentValid || !validateOwnerPassword(newPassword)
        || newPassword !== confirmPassword || newPassword === currentPassword) {
      return page(renderApplicationsPage(instance, credential, null, true, {
        state: await loadAppSecretState(env), error: null, revealed: null,
      }), headers(), 400,
        { shell: "app", active: "applications", isOwner: true, sessionVerified: true,
          ownerPendingPasswordChange: credential.mustChangePassword });
    }
    const repository = ownerRepository(env);
    if (!repository) return respondError(503, "owner_auth_unavailable");
    const nextVersion = await repository.updatePassword({
      expectedVersion: credential.credentialVersion,
      password: newPassword,
      now: Date.now(),
    });
    if (nextVersion === null) return respondError(409, "password_change_conflict");
    const h = headers();
    addCookie(h, OWNER_SESSION_COOKIE,
      await seal(key, createOwnerSession(instance, {
        ...credential,
        credentialVersion: nextVersion,
        mustChangePassword: false,
      }), OWNER_SESSION_AAD),
      OWNER_SESSION_SECONDS);
    return redirect(`${APPLICATIONS_PATH}?notice=owner_password_changed`, h);
  }

  // An existing session may predate managed enrollment or its grant may
  // have been explicitly revoked. Never regrant on page load; offer the
  // same active OAuth login flow that the user already uses.
  let verified: { accountId: string } | null;
  try { verified = await verifyPrincipal(env, principal); }
  catch { verified = null; }
  if (!verified) {
    if (path === "/api/whoami") return respondError(502, "authentication_link_unavailable");
    return errorPage(502, "authentication_link_unavailable");
  }
  if (path === "/api/whoami") {
    const h = headers(); h.set("content-type", "application/json; charset=utf-8");
    const identity = principal.kind === "owner"
      ? { accountId: verified.accountId, principal: "local_owner" }
      : { accountId: verified.accountId, consumerId: verified.accountId, scopes: [] };
    return new Response(JSON.stringify(identity), { headers: h });
  }
  // An unavailable mailbox list is not an empty list or a failed identity.
  let mailboxOutcome: MailboxListOutcome;
  try { mailboxOutcome = await listVerifiedAccountMailboxes(env, verified.accountId); }
  catch { mailboxOutcome = { ok: false, error: "mailboxes_unavailable" }; }
  const accountView: MiraPrincipal | OwnerPrincipal = principal.kind === "owner"
    ? principal : { kind: "mira", accountId: verified.accountId, session: principal.session };
  return page(renderAccountPage(accountView, instance, base, mailboxOutcome), headers(), 200,
    { shell: "app", active: "account", isOwner: principal.kind === "owner", sessionVerified: true });
}

/** Preserve fail-closed behavior; only a document gets a branded unexpected-error response. */
export async function handleWebRequest(request: Request, env: WhoYouEnv): Promise<Response | null> {
  try {
    return await handleWebRequestInternal(request, env);
  } catch (error) {
    const url = new URL(request.url);
    const resource = resolveInstanceResource(env);
    if (!acceptsHtml(request) || url.pathname.startsWith("/api/") || !resource || resource.origin !== url.origin) throw error;
    // Do not log the exception text: provider errors can contain sensitive data.
    console.error("who_you_web_unexpected_error");
    return errorPage(500, "unexpected_error");
  }
}
