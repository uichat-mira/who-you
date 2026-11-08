# Who You（狐邮）产品与服务设计 v1

> Status: **设计提案 v1（方案 C：混合架构）。尚未获批实施。**
>
> 日期：2026-11-08 · Owner：Mira Cloud · 仓库：uichat-mira/who-you
>
> 本文件取代同分支的 v0（同日）。v0 中「聚合用户已有邮箱」「不替用户发信」「不做邮件托管/自有域名」的段落与维护者裁决冲突，已作废。
>
> 证据等级：**已裁决**（维护者明确给出）｜**已核实**（当前代码/配置可验证）｜**提案**（本文建议，未获批）｜**待核实**（平台或外部事实，实施前必须实测）｜**待决**（需要维护者裁决）。

## 0. 维护者已裁决（本文件的前提）

1. **产品是自建邮件服务**，不是「聚合用户已有 Gmail/Outlook 的只读索引层」。
2. 托管自有域名邮箱：每个 **Mira Cloud Account** 分配一个 `localpart@tomlab.cn` 地址。
3. Mira 手机端 / 桌面端通过 **MCP** 控制收发；**发送必须由用户在 Mira 客户端对具体草稿显式确认**。
4. 首版**只服务 Mira 自己的域名**，不接 Gmail / Foxmail / 第三方邮箱，不做 IMAP/JMAP/SMTP submission，不向第三方 MCP 客户端开放。
5. 架构采用 **方案 C**：入站 Cloudflare Email Routing → Email Worker；出站自建 SMTP relay；存储 D1 + R2；控制面沿用现有 Worker 的单一 `/mcp`。

## 1. 一句话定位

**Who You 是 Mira Cloud 的自有域名邮件服务：为每个 Mira Cloud Account 分配 `xxx@tomlab.cn`，接收外部邮件并持久化，通过 Mira 客户端内的远程 MCP 提供检索、阅读、草稿，以及「用户对具体草稿显式确认后」的受控发送。**

它不是什么：

- 不是邮件客户端：不做富文本编辑器、联系人、日历、规则引擎。
- 不是聚合器：首版不代收、不同步任何第三方邮箱，不持有第三方 OAuth token。
- 不是开放 MCP 服务：接入方只有 Mira Desktop / Mobile。
- 不做 AI 摘要、分类、优先级、自动回复——这些属于调用它的 Agent。
- 不是通用 SMTP 中继：只发本域地址，绝不转发任意发件人。

## 2. 硬性产品规则

**R1 · 草稿而不是发送。** Agent 只能创建/修改草稿。真实发送必须由用户在 Mira 客户端对某一具体草稿版本执行显式确认；服务端凭该确认签发的一次性凭证发送。邮件正文、工具输出、模型推理、Agent 自述的「用户已同意」都不构成授权。

**R2 · 发送内容不可在发送时改写。** `send` 只接受 `draftId + draftVersion + confirmationToken`，不接受收件人、主题、正文、附件参数。服务端重算草稿内容哈希并与凭证绑定值比对；不一致即拒绝。

**R3 · 入站内容是敌意输入。** 正文、HTML、附件名、链接、二维码文本都不可信：不得作为指令、权限依据、URL 抓取目标。工具返回正文必须带 `UNTRUSTED_EMAIL_CONTENT` 标记，且正文不进入日志。

**R4 · 只服务自有域名。** 发件地址只能是该账户被分配的 `@tomlab.cn` 地址；不提供任意 From、不代发第三方地址、不提供别名转发到外部。

**R5 · 最小暴露。** MCP 不暴露 SMTP/IMAP 接口、不返回邮箱凭据、不返回 R2 直链或长期下载地址；不提供跨账户查询入口。

## 3. 事实基线与现状

### 3.1 仓库现状（已核实，`dev@c99a4a7`）

- 只有 Worker 骨架、单一 `/mcp`、RFC 9728 元数据、Cloud Auth JWKS 校验、`whoyou_whoami`。
- 没有 `email()` handler、没有 D1/R2 绑定、没有 DNS/Email Routing/relay 配置、没有任何邮件模型。
- 配置缺失时 fail-closed（`503 mcp_not_configured`）；身份只来自 token。

### 3.2 桌面端邮件中心现状（已核实，另一条独立路径）

现有 Mira Desktop 邮件中心基于 IMAP/SMTP + 应用专用密码，只拉最近 20 封，写操作与附件下载缺失。它是**本地最小收件箱**，与本设计不是同一条数据路径。

本设计**不改动、不接管、不承诺迁移**现有桌面邮件中心；两者关系在 S5 单独裁决。

### 3.3 域名现状

FOUNDATION 记录：Cloudflare 账户内有 `tomz.io`。**`tomlab.cn` 是否已托管在同一个 Cloudflare 账户、NS 是否受控、MX 能否修改，均为待核实**（见 §10）。在核实前不得修改任何 DNS 记录。

### 3.4 资源声明

本文不代表任何资源已创建或已预留。Worker 名称、D1、R2、Email Routing、DKIM selector、relay 均需独立 Issue 授权后才能创建。

## 4. 架构（方案 C）

```mermaid
flowchart LR
  A[外部发件人] -->|SMTP| MX[MX: tomlab.cn<br/>Cloudflare Email Routing]
  MX -->|Email Worker| IN[Who You Worker<br/>email handler]
  IN -->|元数据| D1[(D1)]
  IN -->|原始 MIME / 附件| R2[(R2)]

  C[Mira Mobile / Desktop] -->|Streamable HTTP + bearer| MCP[/mcp]
  MCP -->|读| D1
  MCP -->|正文 / 附件短签| R2
  MCP -->|草稿 / 本地状态| D1
  MCP -->|send + 一次性确认凭证| RELAY[自建 SMTP relay]
  RELAY -->|SMTP| B[外部收件人]
  RELAY -->|DSN / 投诉 webhook| IN
```

### 4.1 入站（必须经 Email Routing）

平台约束（已核实）：Workers 不能监听 25/587，不能充当入站 SMTP 服务器。因此入站唯一可行路径是 Cloudflare Email Routing 把邮件投递给 Email Worker 的 `email()` handler。

Worker 侧职责：

1. 解析 envelope（MAIL FROM / RCPT TO）与原始 MIME。
2. **收件地址归属校验**：不存在或已停用的地址默认拒收（`550 5.1.1 no such user`），不静默丢弃、不做黑洞 catch-all。
3. 幂等键：以 `(mailbox_id, internet_message_id)` 去重；重复投递合并为一条，不重复入库。
4. 大小、部件数、嵌套深度、附件数量上限检查；超限显式拒收或隔离。
5. 读取并落库 SPF / DKIM / DMARC 结果（来源与头字段待核实，见 §10）。
6. 元数据写 D1，原始 RFC822 与附件写 R2；正文派生文本与净化 HTML 写 R2。
7. DMARC fail、伪造高风险、解析失败的邮件进入**隔离区**，默认不可被 MCP 检索（可取回、可审计，见 §7）。

失败语义：可判定的永久失败应拒收，让发件方得到 DSN；平台/存储临时失败应返回临时失败（4xx），不吞信。

### 4.2 出站（自建 SMTP relay）

Worker 不维持长连接 SMTP 会话。出站采用 **Worker → relay 的 HTTPS API** 作为首选契约（Worker 经 `cloudflare:sockets` 直连 relay 的 587/465 作为候选，二者待决）。

relay 职责：

- 对每封邮件做 **DKIM 签名**（私钥只在 relay 侧，绝不进入 Worker、仓库或 CI）。
- SPF 对齐：envelope sender / HELO 与 `@tomlab.cn` 一致。
- 队列、重试、退避、连接池、TLS。
- DSN / 退信 / 投诉回流到 Who You webhook。
- 出口速率限制、按账户配额、异常暂停。
- **拒绝开放中继**：只接受 Who You 服务身份、只接受本域 envelope。

服务 → relay 鉴权：mTLS 或 HMAC（时间戳 + nonce + 请求体摘要），具体选型待决/待核实。Cloudflare Email Sending 作为候选替代方案记录在案，未裁决。

### 4.3 存储

- **D1**：mailbox/address、message 元数据、thread、flags、draft、send receipt、delivery event、quota counter、suppression。
- **R2**：原始 RFC822、正文文本、净化 HTML、附件对象；按 `accountId/mailboxId/messageId` 前缀隔离。
- 正文不内联进 D1（行大小与成本考虑）。
- 检索：优先 D1 FTS5；**D1 是否支持 FTS5 待核实**。不支持时退化为规范化 `search_text` 列 + 发件人/时间/方向索引 + 游标分页，不引入第二套搜索基础设施。
- 删除顺序：先删 R2 对象，再删 D1 行；删除任务幂等、可重试。备份中的残留窗口在保留策略中说明。

### 4.4 控制面

- 唯一 Agent 面：`/mcp`（Streamable HTTP, stateless）+ RFC 9728 metadata。
- 鉴权：bearer + Cloud Auth JWKS；`aud=mira:who-you`，`iss=mira:cloud-auth`；身份只来自 token。
- 新增 `email()` handler 与内部回调（relay DSN/投诉）必须使用独立鉴权，**不挂到 `/mcp`**，不对客户端暴露。
- 配置缺失一律 fail-closed，不提供匿名或 fixture 回退。

## 5. 域名与地址分配

### 5.1 域名前提（待核实 / 待决）

接入前必须确认：`tomlab.cn` 的区域归属与 NS、是否已启用 Email Routing、是否允许修改 MX、是否已有其他邮件用途、DKIM selector 命名、DMARC 记录现状、`dev` / `test` 是否使用子域。

**未经授权不得改 DNS / MX。** MX 变更属高风险变更，需人工审批、明确 TTL 与回滚步骤。

### 5.2 地址分配

- 每个 Cloud Account 首版 **1 个主地址**：`localpart@tomlab.cn`，账户创建时幂等开通，无需二次申请。
- localpart 规则（提案）：长度 3–32；仅 ASCII 小写 `[a-z0-9]` 与 `.` `_` `-`；首尾必须是字母或数字；连续分隔符合并；大小写不敏感、Unicode 归一化后再判重。
- 保留字（大小写不敏感，提案）：`postmaster`、`abuse`、`admin`、`administrator`、`root`、`hostmaster`、`webmaster`、`security`、`mailer-daemon`、`noreply`、`no-reply`、`bounce`、`dmarc`、`spf`、`dkim`、`who-you`、`whoyou`、`mira`、`support`、`billing`、`legal`、`privacy`、`api`、`mcp`、`system`、`daemon`、`www`、`mail`、`hello`、`info`。
- 冲突处理：自动追加 `-` + 4 位随机后缀；MCP 不提供自助改名。
- 改名/别名（待决）：提案 30 天 1 次，旧地址保留为只收不发别名 90 天。
- 回收（待决）：账户删除 → 立即停收发；地址隔离期内不可重新分配；有发送历史的地址是否永久不回收需裁决。
- 配额（配置化，默认值待决）：单地址存储上限、单封入站大小、附件上限、每日发送封数、单封收件人数、每分钟速率。超限返回显式错误码，不静默丢弃。

### 5.3 身份关系

邮箱地址是 Cloud Account 的子资源，不是独立登录主体。多地址、别名、共享邮箱首版不做，列入待决。

## 6. 领域模型

逻辑实体（不是冻结的表结构）：

| 概念 | 关键字段 | 不变式 |
| --- | --- | --- |
| Mailbox | `id, accountId, address, status(active\|disabled\|quarantined), quota, createdAt` | 地址全库唯一；一个账户首版一个 |
| Message | `id, mailboxId, direction, internetMessageId, envelopeFrom, envelopeTo[], from, to, cc, subject, sentAt, receivedAt, size, snippet, authResults, threadId, flags, bodyRef, rawRef` | `(mailboxId, internetMessageId)` 唯一；重复投递幂等 |
| Attachment | `id, messageId, partPath, filename, mime, size, disposition, r2Key, sha256` | 文件名净化；只存引用，不进日志 |
| Thread | `id, mailboxId, threadKey, rootMessageId, lastMessageAt, messageCount` | 归属单一 mailbox，不跨邮箱合并 |
| Draft | `id, accountId, mailboxId, version, to[], cc[], bcc[], subject, bodyText, bodyHtml, inReplyTo, attachments[], contentHash, status(open\|sending\|sent\|failed\|discarded)` | 每次内容变更 `version+1` 并重算 `contentHash` |
| SendConfirmation | `id, draftId, draftVersion, contentHash, issuedAt, expiresAt, consumedAt, actor` | 一次性；绑定版本与哈希；过期即失效 |
| SendReceipt | `id, messageId, draftId, draftVersion, contentHash, confirmedAt, relayJobId, acceptedAt, finalStatus` | 不可改写；发送审计的单一真相 |
| DeliveryEvent | `id, messageId, type(delivered\|soft_bounce\|hard_bounce\|complaint\|dsn), occurredAt, recipient, rawRef` | 只用于退信与抑制；按保留策略清理 |
| Suppression | `accountId, recipient, reason, since` | 命中即拒发并返回 `recipient_suppressed` |
| QuotaCounter | `accountId, period, sentCount, recipientCount, bytesIn, bytesOut` | 原子累加，超限拒绝 |

关键不变式：

1. 所有查询的最外层过滤条件必须是 token 派生的 `accountId`。
2. 同一封邮件被多个收件人收到时不合并，各 mailbox 独立存储。
3. 发送成功后写入不可变 receipt；草稿被删除不影响 receipt。
4. 出站 message 在 relay 接受前只能是 `queued`，不得伪装为已发送。
5. 邮箱级 `flags`（未读/星标/归档/垃圾篓）由本地维护，因为本域邮件以 Who You 为唯一权威。
6. 原 v0 的「消费者账本」在 v1 降级为可选：是否保留、是否在 S3 引入，待决（§11）。

## 7. MCP 工具面

### 7.1 传输与 scope

- 沿用现有：`/mcp`、bearer 门禁、Cloud Auth JWKS、`aud=mira:who-you`、`iss=mira:cloud-auth`。
- scope 提案（实施时需同步修改 `src/mcp/config.ts` 中的占位常量）：
  - `whoyou.read`：读邮件的既有门禁 scope（已在代码中存在）。
  - `whoyou.mail.write`：草稿与邮箱本地状态写入（取代占位 `whoyou.ledger.write`）。
  - `whoyou.mail.send`：发送，默认不签发，需单独审批。
- 身份永不从工具入参获取。

### 7.2 工具草案

只读（`readOnlyHint: true`）：

| 工具 | 作用 |
| --- | --- |
| `whoyou_whoami` | 已存在；返回账户、消费者、scope |
| `whoyou_mailbox_get` | 本账户地址、状态、配额用量 |
| `whoyou_mail_search` | 查询可选；支持方向、未读/星标、发件人、时间范围、附件、thread；`limit 1..50`，游标分页 |
| `whoyou_mail_thread_get` | 按 threadId 取有界消息列表，默认不含正文 |
| `whoyou_mail_message_get` | 单封详情；`include: metadata \| text \| html`；正文带不可信标记与大小上限 |
| `whoyou_mail_attachment_get` | 返回短时效下载引用；不存在或已隔离时显式失败，不返回空 |

只写本地（需要 `whoyou.mail.write`）：

| 工具 | 作用 |
| --- | --- |
| `whoyou_mail_flag_set` | 未读/星标/归档/垃圾篓；幂等 + 版本 CAS |
| `whoyou_mail_draft_create` / `_update` / `_discard` / `_get` / `_list` | 草稿生命周期；不触达外部 |

发送（需要 `whoyou.mail.send`，默认不签发）：

| 工具 | 作用 |
| --- | --- |
| `whoyou_mail_send` | 参数仅 `draftId, draftVersion, confirmationToken`；校验通过后入 relay 队列并写 receipt |

不提供：原始 MIME 下载、SMTP/IMAP 代理、任意收件人发送、批量群发、别名管理、跨账户查询。

### 7.3 确认契约（发送闸门）

这是 v1 最关键的安全设计，必须先于 `send` 实现定稿：

1. Agent 调 `draft_create/update`，得到 `draftId + version + contentHash`。
2. Mira 客户端渲染该草稿的最终形态：收件人、主题、正文、附件全量展示。
3. 用户点击发送 → 客户端取得**仅能由用户会话产生**的一次性确认凭证，绑定 `draftId + version + contentHash`，短时效（提案 ≤10 分钟），单次使用。
4. Agent 调 `whoyou_mail_send` 携带该凭证。
5. 服务端重新读取草稿、重算哈希、校验版本未漂移、校验凭证未过期未消费；任一不满足即拒绝。
6. 通过后写入 `queued` 与 receipt，再投递 relay；同一凭证重复调用返回既有结果，绝不重复发信。

凭证来源二选一，S2 合同定稿（**待决/待核实**）：

- **A**：Cloud Auth 签发 `aud=mira:who-you` 的短时断言（含 `draftId/version/contentHash/actor=user/nonce`）。需确认 Cloud Auth 是否支持自定义断言与单次 nonce。
- **B**：Mira 客户端后端写入确认记录，MCP `send` 只消费该记录。需确认客户端后端归属与鉴权。

明确禁止：把「确认」做成 MCP 工具（Agent 可自行调用即失去意义）；scope 具备即可发送；配置项 `auto_send`；用邮件正文里的「请发送」作为授权。

### 7.4 结果与错误

- Markdown 优先（人与 Agent 直读），`structuredContent` 提供稳定 ID、`nextCursor`、`stateVersion`。
- 正文缺失返回 `bodyAvailable: false`，不返回空字符串。
- 错误码至少覆盖：`mailbox_disabled`、`quota_exceeded`、`draft_version_conflict`、`confirmation_invalid|expired|consumed`、`recipient_suppressed`、`rate_limited`、`relay_unavailable`、`message_quarantined`。
- 不区分「不存在」与「无权」；同步/授权/限流错误不得渲染为空列表。

## 8. 安全与隐私

### 8.1 入站

1. **认证结果落库**：SPF/DKIM/DMARC 结果必须随邮件持久化；DMARC fail、对齐失败、From 域与 envelope 域严重不一致的邮件进隔离区，默认不进可检索箱。
2. **伪造与同形字**：显示名不可信；Unicode 同形字域名在 UI 侧标注；不在正文渲染时自动加载远程图片。
3. **HTML 净化**：脚本、iframe、表单、事件属性、`javascript:`/`data:` 链接全部移除；链接外跳需显式确认。
4. **MIME 硬化**：限制嵌套深度、部件数、附件数、解压后大小；拒绝畸形 MIME；附件名去路径、去控制字符、限长。
5. **收件人上限**：单封 RCPT 数量上限，防退信放大与滥用。

### 8.2 出站与滥用

1. 只有「MCP + 一次性确认凭证」一条发送路径；relay 不接受任何其他来源。
2. 每账户速率、每收件域速率、新账户冷启动限额；异常（大量外域、重复内容、短时间高量）自动暂停并告警。
3. SPF / DKIM / DMARC 全链路配置；本域 DMARC 策略提案从 `p=none` 起步，逐步收紧（需人工裁决）。
4. 退信闭环：DSN 解析 → hard bounce 永久抑制、soft bounce 退避重试、投诉立即抑制并人工复核。
5. 不提供订阅退订自动化、不代发营销邮件；滥用处置流程必须有人工环节。

### 8.3 数据与日志

1. 日志、指标、错误栈只记录 ID、状态、耗时、字节数；**不记录地址、主题、正文、附件名、收件人**。
2. 发送审计记录不可改写；管理操作单独审计。
3. 测试与 fixture 必须是合成的假邮件；禁止真实邮件、真实截图、真实地址进入仓库、PR、AI prompt。
4. 用户数据导出与删除入口必须存在；导出格式、频率、删除 SLA 待决。
5. 附件下载链接短时效、绑定账户与会话；是否允许转发给第三方待决。

## 9. 环境与运维

- **隔离**：`dev` / `test` / `prod` 的 Worker、D1、R2、relay、DKIM selector、Email Routing 规则全部独立；测试环境使用子域，避免污染生产域声誉（子域方案待核实）。
- **迁移**：D1 migrations 版本化、可回滚；先加列/加表再收紧约束；禁止一次性破坏性变更。
- **观测**：入站量、拒收量、隔离量、存储增长、发送量、队列延迟、退信率、投诉率、配额命中。
- **发布**：沿用 `feat/* → dev → test → prod` 与 `Mira Gate`；`prod` 只从 `prod` 分支部署；DNS/MX 变更单独审批并附回滚步骤。
- **灾备**：D1 导出、R2 生命周期与版本、relay 队列持久化；RPO/RTO 待决。
- **成本**：入站与存储是持续成本，需在 S1 前给出容量估算与计费档位结论（Workers Paid 是否为前提待决）。

## 10. 实施前必须闭环的核实项（P0）

| # | 核实项 | 为什么必须先核实 |
| --- | --- | --- |
| 1 | `tomlab.cn` 是否在目标 Cloudflare 账户、NS 状态、能否改 MX | 域名不在手则方案 C 无法落地 |
| 2 | Email Routing 是否已启用；catch-all 与 Email Worker 绑定方式 | 入站唯一路径 |
| 3 | Email Routing 单封大小、附件、每日量、CPU、subrequest 限制 | 决定附件上限与拒收策略 |
| 4 | Email Routing 是否传递 SPF/DKIM/DMARC 结果、以何头字段传递 | 决定伪造防护能否成立 |
| 5 | `email()` handler 的可用性与计费档位 | 决定能否用 Free 试跑 |
| 6 | D1 是否支持 FTS5；行大小、库大小、读写配额 | 决定检索方案 |
| 7 | R2 对象大小、生命周期、签名 URL 能力 | 决定附件下载形态 |
| 8 | relay 部署形态、出口 IP 声誉、云厂商是否封锁 25 出站 | 决定能否自建 relay、是否必须用 smarthost |
| 9 | relay 鉴权（mTLS/HMAC）与 DKIM 私钥托管、selector | 出站可信与域声誉 |
| 10 | Cloud Auth 能否签发草稿绑定的短时断言 | 确认契约 A 是否可行 |
| 11 | Mira 客户端会话与 Cloud Auth 的边界 | 确认契约 B 是否可行 |
| 12 | 退信/投诉回流通道（DSN 邮箱、ARF/FBL） | 无回流则无法抑制与止损 |
| 13 | 合规：邮件内容存储、日志保留、用户协议与隐私政策 | 邮件正文属高敏感数据 |

未闭环的项不得以「按经验应该是」写入实现或验收标准。

## 11. 待决（需要维护者裁决）

1. S1 是否只做收件，发送推迟到 S2（本文建议：是）。
2. 地址由系统派生还是用户自选；改名与别名策略。
3. 地址回收隔离期；有发送历史的地址是否永久不回收。
4. 配额默认值（存储 / 单封 / 日发送 / 收件人数 / 附件）。
5. 保留期：正文、附件、原始 MIME、退信记录、审计记录；删除后备份残留窗口。
6. 附件下载链接是否允许转发；TTL 取值。
7. 是否保留 v0 的「消费者处理账本」，还是只做邮箱级 flags。
8. Cloudflare Email Sending 是否作为 relay 的替代或备份。
9. relay 自建还是采用托管 SMTP 服务（成本 / 声誉 / 合规）。
10. 垃圾邮件与病毒过滤：完全依赖上游、引入第三方网关、还是明确不做并接受风险。
11. 现有桌面邮件中心与 Who You 的关系：长期并存、逐步迁移、还是后者取代前者。
12. 是否支持多地址、别名、共享邮箱（首版明确不做）。
13. 移动端离线缓存与正文本地落盘策略。
14. 数据导出格式与频率限制。

## 12. 交付路线（S1–S5）

每个阶段独立 Issue、独立 PR，不合并成大改。

| 阶段 | 范围 | 可观察验收 |
| --- | --- | --- |
| **S1 只收** | 域名接入、地址分配、Email Worker 入站、D1/R2 落库、隔离区、MCP 读取（search/thread/message/attachment）、配额 | 外部真实邮件可投递到测试域并被 MCP 检索；未知收件人被拒；DMARC fail 进隔离；重复投递不重复入库 |
| **S2 草稿 + 确认 + 发送** | 草稿 CRUD、确认契约、relay 契约与鉴权、send、receipt、速率与幂等 | 无确认不可发；改稿后旧确认失效；同一确认只发一封；外部收件箱收到且通过 SPF/DKIM/DMARC |
| **S3 状态与检索补齐** | flags、附件体验、搜索优化、保留与导出/删除、（可选）消费者账本 | 状态写入幂等；删除可验证；检索在真实数据量下可用 |
| **S4 可投递性与反滥用** | 退信/投诉闭环、抑制表、告警、滥用暂停、域声誉监控 | 硬退信进入抑制；投诉可触发暂停；告警可达 |
| **S5 客户端与产品化** | Desktop/Mobile 邮箱界面、确认 UI、错误态；与现有桌面邮件中心关系的裁决 | 用户在客户端完成一次「查看草稿 → 确认 → 发送 → 看到回执」全流程 |

S1 开工前必须完成 §10 的 P0 核实项，并把结论写回本文件或对应 Issue。

## 13. 与既有文档的关系

- 本文件是 Who You 产品与服务设计的当前提案；v0 的冲突段落作废。
- `docs/engineering/FOUNDATION.md` 仍是基础设施 handoff，不因本文件而声称资源已创建；两者冲突时，资源事实以 FOUNDATION 与账户实况为准。
- 代码与本文不一致时：**当前技术现实以代码为准**；本文描述目标态。
- 任何资源创建、DNS 变更、部署、真实收发测试都需独立 Issue 授权，不能用「文档已写」替代授权。

## 14. 参考

- [桌面端 MicroApp 当前真相](https://github.com/uichat-mira/mira-desktop/blob/prod/docs/microapp/README.md)
- [观澜产品与服务设计](https://github.com/uichat-mira/cloud-mcp-guanlan/blob/dev/docs/product-design.md)
- [观澜 MCP 协议入口与 Cloud Auth 边界](https://github.com/uichat-mira/cloud-mcp-guanlan/blob/dev/docs/engineering/gln-004-mcp.md)
- [Mira Cloud Auth 设计](https://github.com/uichat-mira/.github/blob/main/docs/engineering/mira-cloud-auth.md)
- [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/)
- [Cloudflare Email Workers](https://developers.cloudflare.com/email-routing/email-workers/)
- [本仓库工程基线](engineering/FOUNDATION.md)
