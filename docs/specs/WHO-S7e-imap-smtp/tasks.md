# WHO-S7e 任务清单

前置：`spec.md` 已批准。所有代码/注释英文，交付说明中文。每个任务完成即勾选。

## 阶段 A：数据与纯函数

- [x] A1. 新建 `migrations/0009_imap_smtp_identity.sql`（`mailbox_remote_targets` + 端口 CHECK + host 索引）。
- [x] A2. `tests/workerd-harness.mjs` 的 `MIGRATIONS` 追加 0009。
- [x] A3. 新建 `src/mail/remote-target.ts`：`validateRemoteTarget`、`quoteImapString`；线性扫描，无回溯正则。
- [x] A4. 新建 `src/mail/remote-targets.ts`：`RemoteTargetRepository.upsert/get/delete`。

## 阶段 B：传输与协议客户端

- [x] B1. 新建 `src/mail/socket-transport.ts`：`MailConnection`/`MailTransport`/`createSocketTransport`；静态导入 + 打包期 `--external:cloudflare:sockets`（替代非字面量动态导入，见 spec §4.2 注）；隐式 TLS 两参 `connect` + `startTls({expectedServerHostname})`；10s/30s 超时；无忽略证书开关。
- [x] B2. 新建 `src/mail/smtp-client.ts`：greeting/EHLO/STARTTLS/AUTH PLAIN→LOGIN/MAIL FROM/RCPT/DATA dot-stuffing/QUIT；固定错误码；身份不一致在认证前拒绝。
- [x] B3. 新建 `src/mail/imap-client.ts`：CAPABILITY/STARTTLS(143)/LOGIN/SELECT 严格解析 `UIDVALIDITY`+`UIDNEXT`/`UID SEARCH`/`UID FETCH (BODY.PEEK[])`；行数与字面量上限；参数引号化。

## 阶段 C：生命周期与同步

- [x] C1. 新建 `src/mail/imap-link.ts`：目标校验 → 身份一致性 → 地址冲突 → IMAP 登录验证 → mailbox/凭据/target/游标/审计；失败回滚；固定失败码。
- [x] C2. 新建 `src/mail/imap-sync.ts`：读 `imap_password` → SELECT → `UIDVALIDITY` 变化清游标 → 30 天/500 封回填与增量 → 每轮 20 封 → 复用/泛化 importer。
- [x] C3. 新建 `src/mail/imap-http.ts`：`runImapSyncSweep`，形状对齐 `runOAuthSyncSweep`。

## 阶段 D：接线

- [x] D1. `src/mail/identity.ts`：`imap_smtp` 发送分支；unlink shred `imap_password`+`smtp_password` 并删 target；OAuth 路径不变。
- [x] D2. `src/mail/config.ts`：`MailServices` 增 `transport`/`remoteTargets`；`createMailServices(env, options?)` 支持注入。
- [x] D3. `src/mcp/runtime.ts`：传入 `transport`/`remoteTargets`；更新 sender 可用性判定。
- [x] D4. `src/mcp/identities.ts`：link 工具三 provider 分支校验；list 的 credentialStatus 对 `imap_smtp` 取 `imap_password`。
- [x] D5. `src/index.ts`：Cron 分支追加 `runImapSyncSweep`。
- [x] D6. `tests/unit-entry.ts` 导出新增纯函数与常量；`package.json` 追加两个测试文件。

## 阶段 E：测试

- [x] E1. `tests/s7e-unit.test.mjs`：
  - 目标负例表（IPv4 变体、IPv6、userinfo、路径、localhost/.local/.internal、空标签、连字符边界、下划线、非 ASCII、>253、端口 25/110/995、143 默认拒绝）；
  - `quoteImapString` CR/LF/超长/转义；
  - SMTP fake：465 隐式 TLS、587 无 STARTTLS 不认证、AUTH 失败、from 不一致、dot-stuffing；
  - IMAP fake：UIDVALIDITY/UIDNEXT 严格解析、BODY.PEEK、解析失败断连；
  - 断言无真实网络调用。
- [x] E2. `tests/s7e-workerd.test.mjs` + `tests/worker-entry.ts` 路由 `/__imap/link|sync|send`（FakeTransport）：
  - 绑定成功/地址冲突/无确认凭证拒绝；
  - 全表无明文密码；
  - 发信产生 `send_receipts(provider="imap_smtp")`；
  - `UIDVALIDITY` 变化幂等重扫；
  - unlink 清空 target/凭据/邮件/R2 且重复调用幂等；
  - 自有域与 gmail fake 回归不破坏。

## 阶段 F：验证与交付

- [x] F1. `npm run check` 全绿；修复 lint/类型/重复率问题。
- [ ] F2. 新建 `tmp/s6/push-s7e.mjs`（改自 `push-s7d.mjs`）与 `tmp/s6/pr-body-s7e.md`；推 `feat/s7e-imap-smtp-identity`，Draft PR → `dev`。
- [ ] F3. `wait-ci.mjs` 跟踪 Mira Gate / Repository Contract / Branch Policy / SonarCloud；失败则修复后重推。
- [ ] F4. `ready25.mjs` → `merge19.mjs`；记录 PR 链接与 merge SHA。
- [ ] F5. 向用户汇报证据；说明真实 IMAP/SMTP 联网验证需后续显式授权。
