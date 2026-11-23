# Gmail 服务端定时增量同步（OPS-045）

本文说明 `src/index.ts` 五分钟定时入口如何为已授权 Gmail 邮箱做**有界增量同步**，以及启用、观测、暂停和回滚的最小操作。它不宣称任何真实 Worker 已启用 Cron；部署事实以对应 Worker 的绑定、Triggers 与真实证据为准。

## 1. 开关与默认值

- 定时同步使用 `MAIL_SCHEDULE_SYNC_PROVIDERS` 作为**显式 allowlist**，逗号分隔，大小写不敏感。
- 该变量为空或缺失时，五分钟 tick **不访问任何邮件提供商**（fail-closed）。仅“存在 Cron”不等于允许自动同步。
- 可选值只有 `gmail`、`microsoft`、`imap_smtp`。OPS-045 只批准并验证 Gmail；Microsoft / IMAP-SMTP 需要各自的实际证据和授权后才能加入。
- 仓库默认部署配置 `cloudflare.config.ts` 声明 `MAIL_SCHEDULE_SYNC_PROVIDERS=gmail`，因此该配置所描述的目标环境只运行 Gmail 定时同步。`who-you.tomz.io` 的独立预览 Worker 目前仍是**无 Cron** 的受限环境；在那里启用定时同步属于单独部署任务。

```text
MAIL_SCHEDULE_SYNC_PROVIDERS=gmail              # 只自动同步 Gmail
MAIL_SCHEDULE_SYNC_PROVIDERS=                   # 暂停全部定时同步（推荐回滚方式）
```

未配置 Gmail OAuth 客户端、凭据 KEK 或存储绑定的环境会安全跳过：sweep 不列出邮箱，也不发起请求。

## 2. 有界语义

- 每五分钟一个 tick，只推进**一个**有界批次，不循环扫库。
- 每个 tick 最多检查 20 个同 provider 的 active 第三方邮箱（`OAUTH_SYNC_SWEEP_LIMIT`）。
- 每个邮箱每轮最多导入 20 封（`GMAIL_SYNC_MAX_MESSAGES_PER_RUN`）。
- 首次回填仍受 30 天窗口与总计 500 封上限约束（`GMAIL_BACKFILL_WINDOW_MS` / `GMAIL_BACKFILL_MAX_MESSAGES`）。
- 回填分页游标、history 游标、未处理的 pending IDs 和 Message-ID 去重全部沿用 OPS-044 的既有实现；tick 只负责再次调用同一条导入管线。
- 单邮箱的 Gmail sync、手动同步、解绑与重授权共享同一 D1 owner lease；并发 tick、手动操作或解绑只会有其中一个写入，其余按固定错误码拒绝或跳过。过期 owner 不自动抢锁，恢复流程见 [gmail-sync-ownership.md](gmail-sync-ownership.md)。

## 3. 可观测事实

### 3.1 覆盖状态

既有只读 MCP 已足以区分“没有匹配”和“尚未同步 / 部分覆盖 / 同步失败”：

- `whoyou_mailbox_list`：每个第三方身份返回 `sync.lastSyncedAt`、`sync.lastError`、`sync.inProgress`、`sync.initialImportComplete`。
- `whoyou_mail_search`：返回 `coverage.mailboxes`（按邮箱的同一组同步事实）和 `coverage.partial`。空结果文案明确说明它只代表“当前已同步范围内无匹配”，在覆盖不完整时不会断言邮箱没有该邮件。
- 邮箱设置页：沿用现有状态文案，例如“初始同步进行中”“需要重新授权”“同步待恢复”。

### 3.2 运行日志

只记录非敏感计数与固定错误码：

- `whoyou_mail_sync`：单个身份的 `outcome`（`synced` / `skipped` / `failed`）、provider、不透明 `accountId` / `mailboxId`、导入数量、固定 `reason_code`。
- `whoyou_mail_scheduled_sync`：`checkedAt`、启用的 provider、检查/导入/失败/跳过数量、最晚成功同步时间，以及按 provider 的计数。

日志**不得**包含邮箱地址、OAuth/IMAP 凭据、主题、正文、附件内容或授权 URL。测试与 PR 也不使用真实邮件或凭据。

“跳过”表示本次未执行（例如另一写入方持有 lease），不是成功；失败会保留固定错误码并留待下一 tick 重试。

## 4. 成本与调度

- 免费/按量环境的关键成本来自：每 tick 最多 20 个邮箱的 D1 读取、每个新邮件的一次 Gmail API 读取与 R2/D1 写入；没有新邮件时不会重复写入消息行。
- 每五分钟 = 288 tick/天。实际 Gmail API 调用随邮箱数量和新邮件数量增长，而不是随 history 页无限增长；单邮箱单 tick 最多 20 封。
- 关闭 allowlist 后定时 tick 不产生 provider 请求；保留 Cron 但不做邮件同步可作为临时止血，彻底停止调度则移除对应 Trigger。

## 5. 暂停与回滚

1. **暂停同步（优先）**：把 `MAIL_SCHEDULE_SYNC_PROVIDERS` 置空并部署。已同步数据保留；再次启用后从已持久化游标继续。
2. **停止调度**：移除目标环境的五分钟 Trigger。这属于部署变更，需要该环境自己的授权。
3. **回滚代码**：恢复上一版本的定时入口；不得为了回滚删除已入库邮件或复用旧 owner。异常遗留 owner 仍按 [gmail-sync-ownership.md](gmail-sync-ownership.md) 人工确认后处理。
4. **单邮箱排障**：可继续使用需要登录与 `whoyou.mail.write` 的受控手动同步路径（MCP `whoyou_mailbox_sync` 或认证 Web 路由 `/account/mailboxes/sync`）。普通邮箱设置页不显示“同步一次”按钮；自动同步承担正常工作，手动路径只用于 OPS-044 验证和必要运维。

## 6. 验证边界

- 代码级证据：单元测试覆盖 provider allowlist 的 fail-closed 行为；workerd + 隔离 D1/R2 + 脚本化 Gmail API 的集成测试覆盖定时 tick → 入库 → 只读 MCP 元数据与正文、单轮 20 封、去重、游标续跑、Cron/手动/解绑互斥、Gmail-only 隔离与撤销授权。
- 未完成：真实 Worker 的 Cron 绑定核对、真实 Gmail 邮箱的 T4/T5 同步、生产部署与回滚演练。这些需要单独的维护者授权与真实环境证据；在此之前不得声称线上已自动同步。
