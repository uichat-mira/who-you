# WHO-S7e 验收清单

逐项核对 `spec.md` 的冻结决策与验收对照。全部勾选后才可交付。

- [x] 迁移 `0009_imap_smtp_identity.sql` 只建 `mailbox_remote_targets`，端口白名单由 CHECK 兜底，host 索引存在，且 `tests/workerd-harness.mjs` 已加载 0009。
- [x] `validateRemoteTarget` 只接受主机名：IP 字面量（含十进制/八进制/十六进制/IPv6）、userinfo、路径、`localhost`/`.local`/`.internal`、空标签、连字符边界、下划线、非 ASCII、超长均拒绝；端口仅 IMAP 993/143（143 需 `allowImap143`）、SMTP 465/587。
- [x] `quoteImapString` 对 CR/LF 与 >1024 字节返回 `null`，其余正确转义 `\` 与 `"`。
- [x] `socket-transport` 隐式 TLS 走两参 `connect` + `startTls({expectedServerHostname})`，无忽略证书开关，连接 10s / 读写 30s 超时，异常只抛固定 `MailTransportError`。
- [x] SMTP 必须认证且 `from === username` 在连接前判定；587 未见 `STARTTLS` 返回 `provider_tls_required` 且不发送任何 `AUTH`；正文 dot-stuffing，返回 `Message-ID`。
- [x] IMAP 严格解析 `UIDVALIDITY`/`UIDNEXT`；143 必须 STARTTLS；只使用 `BODY.PEEK[]`；行数与字面量有上限，超限断开并返回固定码。
- [x] `linkImapIdentity` 顺序为目标校验 → 身份一致性 → 地址冲突 → IMAP 登录验证 → 落库/凭据/target/游标/审计，失败回滚且只返回固定码。
- [x] `syncImapMailbox` 使用 `{uidValidity,lastUid}` 游标；`UIDVALIDITY` 变化清游标并记 `uidvalidity_changed`；30 天/500 封回填、每轮 20 封。
- [x] `unlinkMailbox` 对 `imap_smtp` shred `imap_password` 与 `smtp_password`、删除 target 行与邮件/附件/R2，重复调用幂等。
- [x] MCP `whoyou_mailbox_link` 支持三 provider 扁平 schema，自填字段与 provider 交叉校验，输出不含 host/密码；`whoyou_mailbox_list` 的 `credentialStatus` 对 `imap_smtp` 取 `imap_password`。
- [x] `GMAIL_SYNC_CRON` 追加 `runImapSyncSweep`，形状对齐 `runOAuthSyncSweep`。
- [x] 测试全程零真实网络：单测用 fake connection，workerd 用 `FakeTransport`；负例断言 `connectCalls === 0`。
- [x] 密码/token/host/邮件内容不出现在日志、审计、错误码、快照或 PR body 中（审计 detail 固定为 `provider=imap_smtp`）。
- [x] 既有自有域、Gmail、Microsoft 用例全部保持通过。
- [x] `npm run check`（typecheck、lint、unit、integration）全绿。
