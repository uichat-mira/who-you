# Who You（狐邮）产品与服务设计 v0

> Status: **设计提案。尚未获批，仓库内无任何运行时、部署、邮箱授权或真实邮件数据。**
>
> 日期：2026-11-06 · Owner：Mira Cloud · 仓库：uichat-mira/who-you
>
> 本文是 Who You 产品设计的**提案性单一真相源**，目的是把「云端邮件中心 + 远程 MCP」的边界、契约与风险讲清楚，供维护者逐条裁决。下文严格区分 **已确定**、**建议方案**、**待决**；后两者都不是已获批能力，不得当成上线功能引用。

## 1. 一句话定位

**Who You 是 Mira Cloud 的邮件中心服务：把用户显式授权的邮箱聚合成一份云端、常驻、可检索的邮件索引，以远程 MCP 工具的形式提供给 Mira 自有客户端中的 Agent，并分别记录每个消费者对每封邮件的处理状态。**

它是 **Mira Cloud Account 下的内建多用户服务**，不是桌面端邮件中心的替代品，也不是 Agent：

- 不依赖桌面开机，手机和桌面共享同一份索引与处理记忆；
- 不负责「理解邮件」——分类、摘要、决定要不要回，由调用它的 Agent 自己做；
- **不替用户发信**。Agent 只能产出草稿，发送必须是用户的显式动作。

## 2. 现状：桌面端邮件中心已经做了什么

做云端设计前先对齐现有实现。以下为 `uichat-mira/mira-desktop@prod` 当前事实（据代码核查）：

| 能力 | 桌面端现状 | 代码位置 | 云端机会 |
| --- | --- | --- | --- |
| 收件箱列表 | 已实现，但只拉最近 **20 封** | `server/src/microapps/mail-center/index.ts` | 全量索引 + 分页游标 |
| 阅读 | 已实现（HTML 在隔离 iframe 中渲染） | `desktop/src/features/Settings/pages/MicroApps/MailCenter/index.tsx` | 按需取正文，默认不落正文 |
| 撰写/发送 | **仅有 text 测试邮件**，无真实写信/回复/转发/草稿 | `server/src/routes/microapps/mail-center/index.ts` | 草稿实体 + 用户确认后发送 |
| 多账号 | 已实现，账号维度隔离，唯一默认账号 | `server/src/db/schema.ts` → `mail_accounts` | 云端多账号 + 每账号独立授权状态 |
| 附件 | **只有元数据，`available: false`，不可下载** | `mail_messages.attachmentsJson` | 按需换取下载地址，或明确不做 |
| 搜索 | UI 无搜索框；服务端有 LIKE 检索仅供 Agent | `server/src/mcp/tools/mail-query.tool.ts` | 索引化检索 + FTS 候选 |
| 会话聚合 | **无 thread 实体**，只能靠 `messageId`/subject 猜 | — | 用 provider 原生 threadId（Gmail `threadId` / Graph `conversationId`） |
| AI 摘要/优先级 | 已实现，但在工作台 `/dashboard/mail` 侧，不在邮件中心 | `server/src/dashboard/mail-priority.ts` | 云端不做模型推理，交给 Agent |
| 远端写操作 | **未实现**（已读、星标、归档、移动、删除均无） | — | 独立授权的高风险工具，见 §4.3 |
| 接入方式 | **纯 IMAP/SMTP + 应用专用密码**，无 OAuth | `imapflow` / `nodemailer` / `mailparser` | 云端首选 provider HTTPS API，见 §7 |

**结论**：桌面端邮件中心是一个「本地可用的最小收件箱」，7 处明显缺口（thread、OAuth、附件、真实写信、远端写、UI 搜索、全量同步）。云端不是在 Worker 上重跑一遍 IMAP，而是把这 7 项缺口放到云端补齐，并额外提供 Agent 可消费的稳定契约。

桌面端邮件中心在 M1 期间**保持不变**，云端不接管它的写状态，也不要求它迁移。

## 3. 为什么值得放到云端

1. **常驻**：邮件是异步到达的。桌面关机时，本地 IMAP 拉取停止；云端索引不会。
2. **跨端一致**：手机、桌面、未来的自动化任务看到同一份「哪些邮件还没处理」。
3. **Agent 需要稳定 ID 与游标**：本地 SQLite 的 `remoteUid` 随重连失效，无法作为长期引用；云端需要 provider 级稳定 ID。
4. **处理记忆**：一份持久账本让 Agent 换会话、换模型、换设备后不重复处理同一封邮件。
5. **多消费者**：同一个账号下，不同的 Agent（如「发票助手」「客户跟进」）各自维护独立进度，互不污染。

## 4. 已确定的产品边界

### 4.1 必须提供

1. **多邮箱、多账号**：一个 Cloud Account 下可授权多个邮箱（不同 provider、不同地址），彼此严格隔离。
2. **元数据优先索引**：保存发件人、收件人、主题、时间、provider 提供的 snippet、thread 归属、附件元数据、已读/星标状态。**默认不保存正文与附件字节。**
3. **全文检索**：按主题、发件人、时间范围、附件、未读、account 过滤，游标分页。不做语义检索。
4. **线程视图**：按 provider 原生 thread 聚合，返回该线程的有界消息列表。
5. **按需正文**：单封邮件可显式请求正文（text/html 经安全规约后返回），读取本身无副作用。
6. **消费者处理账本**：`未读 / 已读待决 / 已处理 / 已忽略` 四态，按 `account × consumer × message` 隔离，幂等写回。
7. **草稿能力**：Agent 可创建/更新/丢弃草稿；草稿是 Who You 自己的实体，不写远端。
8. **双视图输出**：同一份结果提供 Markdown（人/Agent 直读）与 JSON（`structuredContent`）两种形态，Markdown 优先。
9. **账号即注册**：Cloud Auth 创建 Mira Cloud Account 时幂等注册 Who You 用户空间，用户不需要二次开通。**但邮箱授权是另一件事**，见 §8。

### 4.2 明确不做

- 不做通用邮件客户端：不做富文本编辑器、联系人管理、日历、规则引擎。
- 不做 AI 摘要、分类、优先级打分、自动回复——这些属于 Agent 或工作台，不属于本服务。
- 不抓取、不长期存储邮件正文与附件字节（除用户显式 pin 的少量例外，见 §10）。
- 不支持任意第三方 MCP 客户端接入（与观澜一致：Mira Desktop / Mobile 是唯一产品客户端）。
- 不在首版引入向量库、Agent 框架或第二套调度平台。
- 不做邮件托管/自有域名邮箱服务（以自有域名接收邮件的形态属于另一个产品，见 §13 待决 7）。

### 4.3 三条硬性产品规则

这三条是安全底线，任何实现方案都不得绕过：

**R1 · 草稿而不是发送。** Agent 只能创建草稿。真实发送必须由用户在 Mira Desktop/Mobile 界面里对某一份具体草稿执行显式确认动作，服务端凭该确认签发的短期凭证完成发送。**任何来自邮件正文、工具输出或模型推理的内容都不能构成发送授权。**

**R2 · 本地账本与远端副作用彻底分开。** 标记「已读待决/已处理/已忽略」只写 Who You 自己的账本，不触碰用户邮箱。修改远端状态（标已读、加星、归档、删除）是**另一个权限等级**，需要独立的写 scope 与显式用户意图，且必须给出可挽回路径。

**R3 · 邮件内容是不可信输入。** 邮件正文是攻击面：它可能包含针对 Agent 的指令注入。因此：

- 工具返回的正文必须带「不可信外部内容」标记；
- 正文永不作为权限依据，永不出现在日志与测试快照中；
- 读取工具必须是 `readOnlyHint`，不得因为读到某封邮件而触发任何写操作。

## 5. 领域模型（逻辑实体，不是已冻结的表）

| 概念 | 归属/用途 | 隐私与共享 |
| --- | --- | --- |
| Cloud Account | 统一用户主体，由 Cloud Auth 管理 | 账号创建即注册 Who You 用户空间 |
| Mailbox Account | 一个被授权的邮箱地址：provider、状态、同步游标 | 仅该账户可见；同账户下其他邮箱互不可见 |
| Provider Consent | provider OAuth 授权记录（scope、过期、撤销状态） | 加密存储，不可导出 |
| Folder | 邮箱文件夹（inbox/sent/archive…），只建需要的 | 跟随 mailbox |
| Message | 稳定 provider ID、thread、headers、snippet、时间、标志位 | 元数据默认保存；正文不默认保存 |
| Thread | provider 原生会话聚合 | 由 mailbox 决定，不跨 mailbox 合并 |
| Attachment Meta | 文件名、MIME、大小、provider 引用 | 仅元数据；字节按需换取 |
| Consumer | 账户下稳定消费身份（如 `invoice-clerk`） | 跨设备共享；不与其他消费者混用 |
| Consumer Mail State | 某消费者对某封邮件的状态、备注、时间 | 账本主键 `account × consumer × message` |
| Draft | Agent 产出的待发草稿（收件人、主题、正文、引用邮件） | 仅本账户；发送前可被用户编辑 |
| Send Receipt | 一次真实发送的结果与 provider 回执 | 审计用，不可改写 |
| Sync Lease | 某 mailbox 的同步租约与退避状态 | 防止并发重复同步 |

关键不变式：

- **一封邮件在不同消费者眼里可以是不同状态**；不存在「全局已读」代替账本。
- **删除授权/邮箱不删除历史账本的语义要先定义**：建议撤销授权即停止同步、并标记该 mailbox 为不可读，账本按保留策略清理（待决 4）。
- 同一封邮件被两个邮箱同时收到时，**不合并**——归属由 mailbox 决定，避免泄漏「谁抄送了谁」。

## 6. Agent 消费契约（MCP）

### 6.1 工具面草案（名称、粒度都以 Issue 契约为准）

只读（`readOnlyHint: true`，无需写 scope）：

| 工具 | 作用 |
| --- | --- |
| `whoyou_whoami` | 返回 token 派生的 accountId / consumerId / scopes / 已授权邮箱列表（脱敏地址） |
| `whoyou_mail_accounts_list` | 列出可用 mailbox 及授权/同步状态；不可用的显式说明原因 |
| `whoyou_mail_search` | 按 account、folder、主题/发件人/关键词、时间范围、未读、附件过滤；`limit 1..50`，游标分页 |
| `whoyou_mail_thread_get` | 按 threadId 取有界消息列表（默认不含正文） |
| `whoyou_mail_message_get` | 单封详情；`includeBody: none \| text`，正文经过规约并带不可信标记 |
| `whoyou_mail_attachment_url` | 换取短时效下载引用；不可用时显式失败而不是返回空 |

只写本地账本（不需要 provider 权限）：

| 工具 | 作用 |
| --- | --- |
| `whoyou_mail_triage` | 标记 `seen \| handled \| ignored`，可附备注；幂等键 + CAS 版本 |
| `whoyou_mail_draft_create` / `_update` / `_discard` | 草稿生命周期；发送前一律不触达外部 |

需要独立高风险 scope（**M1 不提供**，见 §13 待决 3）：

| 工具 | 作用 |
| --- | --- |
| `whoyou_mail_send` | 凭用户在前端对某草稿的确认凭证发送 |
| `whoyou_mail_flag` | 修改远端已读/星标/归档 |

### 6.2 读写分离与 scope

沿用观澜已验证的模型：

- 传输：MCP Streamable HTTP（stateless），单一 `/mcp` 入口，不做平行 REST Agent API；
- 鉴权统一由 bearer 门禁 + Cloud Auth JWKS 校验，`audience = mira:who-you`，`iss = mira:cloud-auth`；
- scope：`whoyou.read` / `whoyou.ledger.write` / `whoyou.send`（后者默认不签发）；
- **身份只来自 token**，永不从工具入参取 accountId/consumerId；
- 配置缺失一律 fail-closed（`503 mcp_not_configured`），不提供匿名或 fixture 回退。

### 6.3 结果形态

Markdown 优先、JSON 辅助，两者来自同一次查询。示意（**不是已冻结 Schema**）：

```text
# Who You · invoice-clerk · 待处理
生成于：<ISO>    后续游标：<opaque>
账号：work@example.com（Gmail）    过滤：未处理；最新优先
## MSG-8f2c · 2026 年 10 月服务费发票
发件人：billing@example.org
时间：<ISO>
状态：未读
摘要：<provider snippet，≤200 字>
附件：invoice-202610.pdf（182 KB）
```

JSON 侧必须包含：稳定 `messageId`、`threadId`、`accountId`（脱敏后可读地址）、`receivedAt`、`state`、`stateVersion`、`nextCursor`。正文缺失时返回 `bodyAvailable: false` 而不是空字符串。

### 6.4 错误语义

- 不区分「邮件存在但无权」与「不存在」，统一返回不允许；
- 同步失败、provider 授权过期、scope 不足、限流**分别返回明确错误码**，不得渲染为空列表；
- 超大正文/附件被拒时返回显式错误，不静默截断；
- 所有写工具返回 `stateVersion`，冲突用 CAS 拒绝并提示重读。

## 7. 邮件接入与同步

### 7.1 三条通道，结论不同

| 通道 | 可行性 | 结论 |
| --- | --- | --- |
| **Provider HTTPS API**（Gmail API / Microsoft Graph） | Worker 原生可跑；提供 thread、snippet、增量同步、推送订阅、发送能力 | **建议作为唯一 M1 通道** |
| **IMAP over `cloudflare:sockets`** | 技术上可连 TCP/TLS，但需要自行实现有状态协议、IDLE、MIME 解析；CPU 与连接时长风险高 | **待决，不进 M1** |
| **Cloudflare 自有域名邮件**（Email Routing 入站 / Email Sending 出站） | 只适用于我们自己的域名，无法代管用户已有邮箱；能力与配额需按当前文档核实 | 属于另一个产品，见 §13 待决 7 |

直白地说：**桌面端用 IMAP 是因为它跑在 Node 上**。Workers 上硬搬 IMAP 是把一个本地协议塞进一个按请求计费的运行时，收益低、风险高。M1 只做 provider API；是否补 IMAP 由真实用户覆盖度决定。

### 7.2 同步触发

- **首选**：provider 推送（Gmail 通过 Pub/Sub push HTTP 到 Worker；Graph 变更订阅需按有效期续订）。延迟低、CPU 少。
- **兜底**：Cron 拉取，按 mailbox 分批、有界、指数退避；固定一个触发器扫描到期 mailbox，**不要为每个 mailbox 建一个 Cron**。
- 推送通道需要额外云资源与域名校验，属**待决**项；无推送时以 Cron 为准。

### 7.3 同步状态机与幂等

`idle → syncing → succeeded | failed(backoff)`，靠 `Sync Lease` 防止并发重复拉取。每条消息以 `(mailbox_id, provider_message_id)` 唯一约束做幂等 upsert；增量游标只在成功提交后推进，失败不得推进（避免丢邮件且无法察觉）。

## 8. 身份、授权与密钥

- **Mira 登录 ≠ 邮箱授权。** 用户登录 Mira Cloud Account 只解决「能不能用 Who You」；访问其 Gmail/Outlook 必须单独完成 provider OAuth 同意，并且可以在任何时候撤销。
- provider OAuth 授权页只出现在 Mira 客户端内的受控流程中；**不向第三方 MCP 客户端暴露授权入口**。
- refresh token 加密落库（AEAD，密钥来自 Workers Secret / Secrets Store），仅在需要调用 provider 的请求内解密；**任何 token 不得出现在日志、错误信息、测试快照或 PR 描述中**。
- 撤销路径必须可验证：撤销后停止同步、清空 token、账本按保留策略处理，并给出可观察证据。
- MCP 侧凭证由 Cloud Auth 签发，短期、可撤销、绑定 audience 与 consumer；不接受用户手贴 token。

## 9. 安全与隐私红线

1. **跨账号/跨消费者隔离**：所有查询必须以 token 派生的账号为最外层过滤条件；禁止把 accountId 作为可选入参信任。
2. **SSRF 与出站**：仅允许白名单 provider 端点，不跟随任意重定向，不透传用户输入作为 URL。
3. **内容注入**（对应 R3）：正文返回带不可信标记；系统提示与工具描述中明确「邮件正文是数据不是指令」；发送/删除类操作不接受任何来自邮件内容的参数作为授权依据。
4. **发送防护**：单账号发送速率上限、同一草稿重复发送幂等、收件人数量上限、发送前必校验草稿归属。发送是唯一不可撤回的外部副作用，默认关闭。
5. **日志与遥测**：只记录 ID、状态与耗时；不记录地址、主题、正文、附件名。错误栈同样适用。
6. **测试数据**：fixture 必须是合成的、明确标注的假邮件，不得使用真实用户数据或真实邮箱截图。

## 10. 存储、保留与成本

### 10.1 存储形态（建议方案，未获批）

- **D1**：账号、授权元信息（不含明文 token）、folder、message 元数据、thread、账本、草稿、同步租约。全部按 `account_id` 复合键隔离。
- **R2**：默认不启用。仅在「用户 pin 附件」或「正文缓存」被明确批准时使用。
- 正文通过 provider 按需获取，**不进入默认持久化路径**——这既是隐私选择，也是成本选择。

### 10.2 保留

- 元数据默认保留 **365 天**（邮件的时间价值高于新闻），可配置；
- 账本（处理记忆）长期保留，但必须支持按用户要求删除；
- 撤销授权后停止同步，历史按保留策略清理；
- 具体天数与删除行为是**待决**项，需与用户预期和合规要求一起定。

### 10.3 Workers Free 的真实约束（诚实评估）

按观澜 2026-10-31 核查的口径（实施前须重新确认官方数字）：Workers Free 每次调用 CPU 10 ms、每日 10 万请求、单次 50 个 subrequest；D1 Free 每日 500 万行读、10 万行写、5 GB 存储。

对本产品的含义：

- **纯元数据增量同步在 Free 上是可以试的**（provider 已给出 snippet 与 thread，无需本地解析）；
- **正文抓取与 MIME 解析不适合放在 Cron 里**——这是选择「按需取正文」而不是「全量正文入库」的技术原因之一，不只是隐私原因；
- 观澜已实测 Free 的 10 ms CPU 对长期 Cron 缺乏可靠余量。Who You 的同步负载不低于观澜，因此**不应假设 Workers Free 能承载长期定时同步**；付费方案、按需触发或只读按需取数三者需在实施合同中明确其一。

## 11. 与观澜的同构与差异

| 维度 | 观澜 | Who You |
| --- | --- | --- |
| 数据来源 | 公共 RSS + 用户订阅 | 用户授权的私有邮箱 |
| 采集权限 | 无凭证，公开可抓 | **必须有 provider OAuth 授权** |
| 内容可信度 | 外部来源，需防 SSRF | 外部来源，**需防指令注入**（更强） |
| 写操作 | 只写自己的账本 | 账本 + **可选的真实发信/改远端**（最高风险） |
| 索引保留 | 90 天 | 建议 365 天，待决 |
| 触发 | 小时级 Cron | 推送优先，Cron 兜底 |
| 复用 | — | **复用 Cloud Auth verifier 契约、MCP handler 形态、per-consumer 账本模式**（复用契约，不复制代码） |

## 12. 候选工作包（不是授权队列）

以下只是切分建议，**不是已创建的 Issue，也不构成执行授权**：

1. **W1 只读索引骨架**：单 provider（Gmail）元数据同步 + `whoyou_mail_search` + `whoami`，不含正文、不含写。
2. **W2 线程与正文**：thread 聚合、`message_get`（含不可信标记与规整）、`attachment_url`。
3. **W3 账本**：`whoyou_mail_triage` + CAS/幂等 + 分页里的 `stateVersion`。
4. **W4 草稿**：草稿 CRUD，端到端不触达外部。
5. **W5 发送闸门**：前端确认凭证 + `whoyou_mail_send` + 速率与幂等防护（需单独审批）。
6. **W6 第二 provider**（Graph）与推送通道。
7. **W7 桌面/移动接线与迁移讨论**（不改动现有桌面邮件中心行为）。

## 13. 待决问题（需要维护者裁决）

1. **M1 是否只支持一个 provider**（Gmail）？还是必须同时覆盖 Outlook？
2. **正文是否允许短期缓存**？若允许，缓存 TTL 与加密要求是什么？
3. **发送能力是否进入首个里程碑**？还是长期只做草稿、发送完全留给桌面端？
4. **撤销邮箱授权后的数据处置**：立即删除元数据，还是保留账本直到用户主动删除？
5. **默认保留期**：365 天是否合适？是否需要按文件夹区分？
6. **Workers 计费档位**：接受 Paid plan，还是坚持 Free 并把同步降级为「用户触发」？
7. **是否要做自有域名邮箱**（自有域名收件）？这是独立产品，不应与「管理用户已有邮箱」混为一谈。
8. **Work item 前缀**：本仓库尚无已注册的语义 ID 域（如 `GLN` 之于观澜）。新增域名属于 Organization 治理变更，需维护者批准后再分配编号。

## 14. 参考

- [桌面端 MicroApp 当前真相](https://github.com/uichat-mira/mira-desktop/blob/prod/docs/microapp/README.md)
- [观澜产品与服务设计](https://github.com/uichat-mira/cloud-mcp-guanlan/blob/dev/docs/product-design.md)
- [观澜 MCP 协议入口与 Cloud Auth 边界](https://github.com/uichat-mira/cloud-mcp-guanlan/blob/dev/docs/engineering/gln-004-mcp.md)
- [Mira Cloud Auth 设计](https://github.com/uichat-mira/.github/blob/main/docs/engineering/mira-cloud-auth.md)
- [本仓库工程基线](engineering/FOUNDATION.md)
