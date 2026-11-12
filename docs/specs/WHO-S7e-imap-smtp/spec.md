# WHO-S7e 规格：自填 IMAP/SMTP 身份（发信 + 收信 + SSRF 威胁模型）

状态：**待批准（批准后才进入实现）**

上位依据：`uichat-mira/.github@main/AGENTS.md`（Policy revision `2026-09-16.2`，sha `50d7ce67`）、仓库 `AGENTS.md`、`docs/engineering/CREDENTIAL-SECURITY-CONTRACT.md` v1.2 §5、`docs/task-cards/WHO-S7-third-party-mailbox.md` S7e。

## 1. 目标与不做的事

目标：用户自填主机、端口与应用专用密码，接入一个 `imap_smtp` 身份；发信经 SMTP，收信经 IMAP 轮询入库；全链路只走 TLS，且不改变自有域收发行为。

不做：POP3/EWS/ActiveSync；无认证投递；任何明文回退；143 默认开启；真实网络测试进 CI；连接性探测工具面（连通性测试交互不在本片）。

## 2. 决策冻结（实现不得偏离）

| 项 | 决策 |
|---|---|
| 迁移 | 新增 `0009_imap_smtp_identity.sql`，只建 `mailbox_remote_targets` |
| 目标校验 | 纯函数，只接受主机名；端口白名单 IMAP 993/143、SMTP 465/587；25 永不允许；143 需显式 `allowImap143` |
| 传输 | 隐式 TLS 用 `connect({hostname,port},{secureTransport:"starttls"})` + `startTls({expectedServerHostname})`；587/143 必须看到 `STARTTLS` 广播后才认证 |
| 超时 | 连接 10s，单次读写 30s；失败断开，不对同一目标重试 |
| SMTP | 必须 AUTH（PLAIN，失败回退 LOGIN）；`MAIL FROM` 与 AUTH 账号一致，否则 `provider_identity_mismatch` |
| IMAP | CAPABILITY → （143 需 STARTTLS）→ LOGIN → SELECT INBOX → `UID SEARCH` → `UID FETCH ... (BODY.PEEK[])`，不回写已读 |
| 游标 | `{"uidValidity":number,"lastUid":number}`；`UIDVALIDITY` 变化即清游标并记 `uidvalidity_changed`，下一轮全量 |
| 回填 | `UID SEARCH SINCE` 最近 30 天、最多 500 封；每轮每身份最多 20 封 |
| 凭据 | `imap_password` 与 `smtp_password` 两条，值相同；AAD 绑定方式沿用现有 `credentials.store` |
| 绑定/解绑 | 必须携带 S4 确认凭证；解绑 shred 两条凭据 + 删 target 行 + 删邮件/附件/R2（幂等） |
| 日志 | 只允许契约 §7 白名单字段；不得出现 host、地址、密码、邮件内容 |

## 3. 数据模型（迁移 0009）

```sql
CREATE TABLE mailbox_remote_targets (
	mailbox_id TEXT PRIMARY KEY,
	imap_host TEXT NOT NULL,
	imap_port INTEGER NOT NULL CHECK (imap_port IN (993, 143)),
	smtp_host TEXT NOT NULL,
	smtp_port INTEGER NOT NULL CHECK (smtp_port IN (465, 587)),
	username TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX mailbox_remote_targets_host ON mailbox_remote_targets (smtp_host);
```

理由：host 是用户数据，只存库、不进日志；端口 CHECK 是最后一道白名单；`username` 用于发送前比对 `MAIL FROM`。不加外键，与 `mailbox_sync_state` 一致，删除由 unlink 显式完成。

涉及文件：`migrations/0009_imap_smtp_identity.sql`（新建）、`tests/workerd-harness.mjs`（`MIGRATIONS` 追加 0009）。

## 4. 模块与签名

### 4.1 `src/mail/remote-target.ts`（新建，纯函数）

```ts
export type RemoteProtocol = "imap" | "smtp";
export type RemoteTransport = "implicit" | "starttls";
export type RemoteTarget = { host: string; port: number; tls: RemoteTransport };
export type RemoteTargetResult =
	| { ok: true; target: RemoteTarget }
	| { ok: false; code: "host_invalid" | "port_not_allowed" };

export function validateRemoteTarget(input: {
	protocol: RemoteProtocol;
	host: string;
	port: number;
	allowImap143?: boolean;
}): RemoteTargetResult;

export function quoteImapString(value: string): string | null;
```

校验顺序（全部线性扫描，无回溯正则）：

1. `trim` 后长度 1..253；拒绝空串。
2. 拒绝含 `@`、`/`、`?`、`#`、`:`、`[`、`]`、空白、控制字符、非 ASCII（`char.charCodeAt(0) > 127`）。
3. 按 `.` 切标签：非空、长度 ≤63、不以 `-` 开头或结尾、不含 `_`；标签全为数字且整体形如 IPv4（4 段）→ `host_invalid`；单段全数字（十进制/八进制/十六进制整数形态，如 `2130706433`、`0x7f000001`）→ `host_invalid`。
4. 小写化后等于 `localhost` 或以 `.localhost`、`.local`、`.internal` 结尾 → `host_invalid`；等于 `metadata.google.internal` 已被后缀规则覆盖。
5. 端口：IMAP 允许 993，143 仅在 `allowImap143 === true` 时允许；SMTP 允许 465、587；其余（含 25、110、995、自定义）→ `port_not_allowed`。
6. TLS：993/465 → `implicit`；143/587 → `starttls`。

`quoteImapString`：含 `\r` 或 `\n` → `null`；UTF-8 字节数 >1024 → `null`；转义 `\` 与 `"`；返回带双引号字符串。

### 4.2 `src/mail/socket-transport.ts`（新建）

```ts
export type MailConnection = {
	readLine(): Promise<string>;
	readBytes(length: number): Promise<Uint8Array>;
	write(data: string | Uint8Array): Promise<void>;
	upgradeTls(expectedHostname: string): Promise<void>;
	close(): Promise<void>;
};
export type MailTransport = {
	connect(input: { host: string; port: number; tls: RemoteTransport }): Promise<MailConnection>;
};
export function createSocketTransport(): MailTransport;
```

- `cloudflare:sockets` 用**非字面量**说明符动态导入（`const moduleName = "cloudflare:sockets"; await import(moduleName)`），避免 esbuild 打包解析；类型用 `@cloudflare/workers-types` 的全局声明。
  - 实现注（2026-11-12）：esbuild 对非字面量动态导入报 `ERR_MODULE_DYNAMIC_SPEC`，改为静态 `import { connect } from "cloudflare:sockets"` + 打包期 `--external:cloudflare:sockets`（效果等价：产物保留运行时说明符，不参与打包解析）；`dist/unit.mjs` 在 Node 下改用 `tests/cloudflare-sockets-shim.ts` alias，单测不触网。
- 隐式 TLS：`connect({hostname,port},{secureTransport:"starttls"})` → `socket.startTls({expectedServerHostname: host})`。
- STARTTLS：先明文 `connect`，由上层在收到 STARTTLS 后调用 `upgradeTls`（内部 `startTls`）。
- 无「忽略证书」选项；连接 10s、读写 30s 超时；每次读写带长度上限（行 8 KiB、单次字节 ≤ `maxRawBytes` 级别）。
- 所有异常只抛固定 `MailTransportError`，不携带底层文本。

### 4.3 `src/mail/smtp-client.ts`（新建）

```ts
export type SmtpErrorCode =
	| "provider_unreachable"
	| "provider_tls_required"
	| "provider_auth_failed"
	| "smtp_rejected"
	| "provider_identity_mismatch";
export class SmtpError extends Error { constructor(readonly code: SmtpErrorCode) }

export async function sendSmtpMessage(
	connection: MailConnection,
	input: {
		host: string;
		tls: RemoteTransport;
		username: string;
		password: string;
		from: string;
		to: string[];
		cc: string[];
		bcc: string[];
		raw: string;
	},
): Promise<{ messageId: string | null }>;
```

流程：读 greeting（非 220 → `provider_unreachable`）→ 465 直接 AUTH；587 先 `EHLO`，响应无 `STARTTLS` → `provider_tls_required` 且**不发送 AUTH**；有则 `STARTTLS` → `upgradeTls(host)` → 再 `EHLO`。`from.toLowerCase() !== username.toLowerCase()` → `provider_identity_mismatch`（连接建立前判定，不发送凭据）。`AUTH PLAIN`；失败回退 `AUTH LOGIN`；非 235 → `provider_auth_failed`。`MAIL FROM` / `RCPT TO` / `DATA`，正文按行 dot-stuffing，`\r\n.\r\n` 结束；`QUIT`。返回从 raw 头解析的 `Message-ID`（缺失为 `null`）。邮件地址参数禁止 CR/LF，出现即 `smtp_rejected`。

### 4.4 `src/mail/imap-client.ts`（新建）

```ts
export type ImapErrorCode =
	| "provider_unreachable"
	| "provider_tls_required"
	| "provider_auth_failed"
	| "imap_protocol_error";
export class ImapError extends Error { constructor(readonly code: ImapErrorCode) }

export type ImapMailboxState = { uidValidity: number; uidNext: number };

export async function openImapSession(connection: MailConnection, input: {
	host: string;
	tls: RemoteTransport;
	username: string;
	password: string;
}): Promise<{ selectInbox(): Promise<ImapMailboxState>; close(): Promise<void> }>;

export async function searchUids(
	connection: MailConnection,
	input: { since: string | null; afterUid: number | null; limit: number },
): Promise<number[]>;

export async function fetchRawMessage(
	connection: MailConnection,
	uid: number,
	maxBytes: number,
): Promise<Uint8Array>;
```

- 全部命令参数走 `quoteImapString`；返回 `null` → `imap_protocol_error`。
- SELECT 严格解析 `UIDVALIDITY` 与 `UIDNEXT` 为整数，缺失/非整数 → `imap_protocol_error`。
- `UID SEARCH SINCE <date>` 或 `UID <n>:*`；结果按数值升序去重。
- `UID FETCH <uid> (BODY.PEEK[])`；字面量长度必须 ≤ `maxBytes`，否则该条跳过（由调用方计 skipped）。
- 单轮响应行数上限（如 10_000）与嵌套上限；超限断连。
- 不写 `\Seen`（只允许 `BODY.PEEK[]`）。

### 4.5 `src/mail/imap-link.ts`（新建）

```ts
export type ImapLinkFailureCode =
	| "invalid_target_host"
	| "invalid_target_port"
	| "provider_identity_mismatch"
	| "provider_auth_failed"
	| "provider_unreachable"
	| "provider_tls_required"
	| "credential_vault_unavailable"
	| "address_already_linked"
	| "link_failed";

export async function linkImapIdentity(deps: {
	repository: MailRepository;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	syncStates: SyncStateRepository;
	limits: MailLimits;
	remoteTargets: RemoteTargetRepository;
	transport: MailTransport | null;
	now: number;
}, input: {
	accountId: string;
	address: string;
	username: string;
	imapHost: string;
	imapPort: number;
	smtpHost: string;
	smtpPort: number;
	appPassword: string;
}): Promise<{ ok: true; mailboxId: string; address: string; relinked: boolean } | { ok: false; code: ImapLinkFailureCode }>;
```

顺序：校验 IMAP/SMTP 目标（失败映射 `invalid_target_host`/`invalid_target_port`）→ `address === username`（否则 `provider_identity_mismatch`）→ `keys` 缺失 → `credential_vault_unavailable` → 地址冲突规则与 `completeOAuthLink` 一致 → 用 IMAP 登录做一次真实认证（失败映射固定码）→ 复用或插入 mailbox（`kind:"third_party"`,`provider:"imap_smtp"`）→ 存两条凭据 → 写 target 行 → `syncStates.upsert`（`cursor:null`，`backfillBefore=now-30d`）→ 审计 `link_mailbox`，`detail="provider=imap_smtp"`。任一步失败回滚已插入的 mailbox/target/凭据。返回不含 host/密码。

### 4.6 `src/mail/remote-targets.ts`（新建仓库）

```ts
export type RemoteTargetRecord = {
	mailboxId: string; imapHost: string; imapPort: number;
	smtpHost: string; smtpPort: number; username: string;
};
export class RemoteTargetRepository {
	constructor(db: D1Database);
	upsert(record: RemoteTargetRecord & { now: number }): Promise<void>;
	get(mailboxId: string): Promise<RemoteTargetRecord | null>;
	delete(mailboxId: string): Promise<void>;
}
```

### 4.7 `src/mail/imap-sync.ts`（新建）

```ts
export const IMAP_BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const IMAP_BACKFILL_MAX_MESSAGES = 500;
export const IMAP_SYNC_MAX_MESSAGES_PER_RUN = 20;

export async function syncImapMailbox(
	deps: { repository: MailRepository; limits: MailLimits; credentials: CredentialRepository;
		keys: CredentialKeys | null; syncStates: SyncStateRepository;
		remoteTargets: RemoteTargetRepository; transport: MailTransport | null; now: number },
	mailbox: MailboxRecord,
): Promise<{ ok: true; imported: number } | { ok: false; code: "provider_credentials_not_configured" | "provider_unreachable" | "provider_tls_required" | "provider_auth_failed" | "sync_failed" | "credential_unavailable" }>;
```

- 守卫 `kind==="third_party" && provider==="imap_smtp"`，否则 `sync_failed`。
- 读 `imap_password`；解不开 → `credential_unavailable`（并 markError）。
- 读 target；缺失 → `sync_failed`。
- 连接 → 认证 → SELECT：若游标 `uidValidity` 与 `UIDVALIDITY` 不同，写 `cursor:null`、`lastError:"uidvalidity_changed"` 并按全量处理。
- 回填：`backfillBefore` 非空时用 `SINCE`（最多 500，按 `lastUid` 续跑）；否则 `UID <lastUid+1>:*`。
- 每轮最多消费 20 个 UID，用 `createOAuthMailImporter` 的等价逻辑（可泛化为共享 `createRemoteMailImporter`，避免 Sonar 重复率）；成功入库后更新 `cursor={uidValidity,lastUid}`；`BODY.PEEK[]` 超限计 skipped 但不阻断游标。
- 失败只写固定码；不记录 host/响应文本。

### 4.8 `src/mail/imap-http.ts`（新建）

- `runImapSyncSweep(env, now?)`：复用 `runOAuthSyncSweep` 的形状，provider `imap_smtp`，每轮 20 个身份；`createMailServices` 时允许测试注入 transport。
- 无 OAuth 回调路径：自填身份不需要浏览器回调。

### 4.9 既有文件改动

| 文件 | 改动 |
|---|---|
| `src/mail/identity.ts` | `RoutedMailSenderDependencies` 增 `transport: MailTransport \| null`、`remoteTargets: RemoteTargetRepository \| null`；新增 `imap_smtp` 分支：读 `smtp_password` + target → `sendSmtpMessage`（`from=identity.address`），`providerMessageId` 取信件 `Message-ID ?? ""`，返回 `provider:"imap_smtp"`；`unlinkMailbox` 对 `imap_smtp` revoke `imap_password` 与 `smtp_password`，并 `remoteTargets.delete(mailboxId)`；OAuth 路径不变。 |
| `src/mail/config.ts` | `MailServices` 增 `transport: MailTransport`、`remoteTargets: RemoteTargetRepository`；`createMailServices(env, options?: { transport?: MailTransport })`，默认 `createSocketTransport()`。 |
| `src/mcp/runtime.ts` | `createRoutedMailSender` 传入 `transport`、`remoteTargets`；`sender` 构造条件把 `mail.services.transport` 视为可用 provider（自填身份无需 OAuth 配置）。 |
| `src/mcp/identities.ts` | `whoyou_mailbox_link` 的 `inputSchema` 扩为三 provider 的扁平对象：`provider` 枚举加 `imap_smtp`，新增可选 `address`/`username`/`imapHost`/`imapPort`/`smtpHost`/`smtpPort`/`appPassword`；handler 内按 provider 分支校验（`imap_smtp` 要求全部字段，`gmail`/`microsoft` 拒绝自填字段）；确认凭证的 provider 必须等于请求 provider；不在输出中返回密码/host。`whoyou_mailbox_list` 的 `credentialStatus`：`imap_smtp` 取 `imap_password` 状态。 |
| `src/index.ts` | `GMAIL_SYNC_CRON` 分支追加 `await runImapSyncSweep(env)`。 |
| `tests/unit-entry.ts` | 导出 `validateRemoteTarget`、`quoteImapString`、`sendSmtpMessage`、`openImapSession`/`searchUids`/`fetchRawMessage`、`IMAP_*` 常量。 |
| `tests/workerd-harness.mjs` | `MIGRATIONS` 追加 `0009_imap_smtp_identity.sql`。 |
| `package.json` | `test:unit` 追加 `tests/s7e-unit.test.mjs`；`test:integration` 追加 `tests/s7e-workerd.test.mjs`。 |

### 4.10 测试注入面

`tests/worker-entry.ts` 增加路由：`/__imap/link`、`/__imap/sync`、`/__imap/send`，均使用进程内 `FakeTransport`（脚本化 socket 应答），绝不真实联网。测试 helper 沿用 `tests/s7-helpers.mjs` 的 HMAC/确认凭证风格。

## 5. 威胁模型映射（可执行断言）

| 威胁 | 断言位置 |
|---|---|
| T5 SSRF | `s7e-unit` 目标表：IPv4 字面量/十进制/八进制/十六进制/IPv6/`userinfo@`/路径/`localhost`/`.local`/`.internal`/空标签/连字符边界/下划线/非 ASCII/超长；workerd 负例断言 `FakeTransport.connectCalls === 0` |
| T6 明文降级 | fake 587 不广播 `STARTTLS` → `provider_tls_required` 且断言未收到任何 `AUTH`；证书失败 → 失败且无凭据外发 |
| T7 开放中继 | `MAIL FROM` 地址 ≠ `username` → `provider_identity_mismatch`，且未发送 `AUTH`；无认证路径不存在 |
| T10 预言机 | 绑定失败只返回固定码，无 host/异常文本；同一目标限流在 workerd 用例中计数 |
| T13 IMAP 注入 | `quoteImapString` CR/LF/超 1024 字节返回 `null`；解析失败 → `imap_protocol_error` |
| T12 残留副本 | unlink 后 `mailbox_remote_targets` 无行、两条凭据 `revoked`、邮件/附件/R2 为空，重复调用幂等 |

## 6. 验收对照（任务卡 13 项）

1. 三身份并存：`s7e-workerd` 断言自有域 + gmail（fake）+ imap_smtp 列表互不覆盖。
2. 凭据密文：对 `provider_credentials` 全表子串扫描无明文密码。
3. 三类发信：S7c/S7d 已有 fake 用例 + 新增 SMTP fake 用例，断言 `send_receipts.provider="imap_smtp"` 与 `provider_message_id`。
4. 撤销后固定码：认证失败 → `provider_auth_failed`，不落 receipt、不重试。
5. 收信入库同构：fake IMAP 返回 RFC822，断言正文/附件/线程与既有模型一致。
6. 游标失效：`UIDVALIDITY` 变化 → 幂等重扫，不重复行。
7. SSRF 负例：见 §5 T5。
8. 明文负例：见 §5 T6。
9. 预算：每轮 20 封，剩余保留可续跑游标。
10. 自有域回归：既有 integration 全绿。
11. 撤销顺序：workerd 断言 revoke 时仍可解密、删除后不可解。
12. 确认凭证：无凭证 → `confirmation_invalid`；解绑幂等。
13. KEK 轮换：沿用 S7b 已有用例（AAD 不含 `key_version`），不新增回归破坏。

## 7. 验证与交付

1. `npm run check` 全绿（typecheck、lint、unit、integration）。
2. 新建 `feat/s7e-imap-smtp-identity` 分支，Draft PR → `dev`；PR body 用 `tmp/s6/pr-body-s7e.md`，不含 host/密码/邮件内容。
3. CI：Mira Gate、Repository Contract、Branch Policy、SonarCloud 全绿（重复率 ≤3%）。
4. mark ready → squash merge；汇报 PR 链接与 merge SHA。
5. 真实 IMAP/SMTP 联网验证**不在本次范围**，需用户后续显式授权。

## 8. 需要的批准

请确认：
1. 是否同意上述决策冻结项与模块划分；
2. 是否同意 `whoyou_mailbox_link` 采用「扁平 inputSchema + handler 分支校验」而非 discriminated union；
3. 是否同意本片不包含真实网络连通性测试（仅 fake transport）。
