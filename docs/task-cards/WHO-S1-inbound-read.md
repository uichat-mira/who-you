# WHO-S1：只收 — 域名接入、地址分配、入站落库、MCP 读工具

状态：**阻塞 · 待 v1 §10 的 P0 核实项闭环**

负责人：待指派

执行仓库：`uichat-mira/who-you`

施工基线：从施工时最新 `dev` 创建独立分支；阶段 0 已在 `dev`（`c99a4a7`）。

设计依据：[`docs/product-design.md`](../product-design.md) v1 §4.1、§5、§6、§7.2、§8.1、§10。

## 背景

阶段 0 只有 MCP 门禁与 `whoyou_whoami`，没有任何邮件模型。S1 建立「能收到、能查到」的最小闭环：`@tomlab.cn` 地址存在、外部邮件能进来、元数据与原始内容能落库、Agent 能通过 MCP 检索。

S1 不发送、不建草稿。发送能力在 S2，且必须先有用户确认契约。

## Goal

1. 一个 Mira Cloud Account 拥有一个 `localpart@tomlab.cn` 地址，开通幂等。
2. 外部 SMTP 邮件经 Cloudflare Email Routing 进入 Email Worker，完成校验、解析、去重、落库。
3. 不存在/已停用地址被明确拒收；高风险邮件进入隔离区。
4. Mira 客户端可通过 MCP 检索、读取线程、读取单封元数据与正文、获取附件短时引用。

## In Scope

- **域名**：确认 `tomlab.cn` 归属与 DNS 控制；在测试子域启用 Email Routing，配置到 Email Worker 的投递规则。
- **地址**：地址分配与保留字校验；账户创建时幂等开通；状态 `active / disabled / quarantined`。
- **入站**：`email()` handler；envelope 与原始 MIME 读取；收件地址归属校验；大小/部件/嵌套/附件上限；`(mailbox_id, internet_message_id)` 去重；SPF/DKIM/DMARC 结果落库。
- **存储**：D1 元数据（mailbox / message / thread / attachment 元信息 / quota counter）；R2 原始 RFC822、正文文本、净化 HTML、附件对象。
- **隔离区**：DMARC fail、伪造高风险、解析失败进入隔离，默认不进可检索箱。
- **MCP 读工具**：`whoyou_mailbox_get`、`whoyou_mail_search`、`whoyou_mail_thread_get`、`whoyou_mail_message_get`、`whoyou_mail_attachment_get`。
- **可观测性**：入站量、拒收量、隔离量、存储增长；日志不含地址/主题/正文/附件名。

## Out of Scope

- 草稿、确认、发送、relay、退信处理（S2/S4）。
- 邮箱 flags、批量导出/删除、消费者账本（S3）。
- Desktop / Mobile 邮件界面（S5）。
- 任何第三方邮箱接入（Gmail / Outlook / Foxmail / IMAP / JMAP）。
- 生产域 MX 切换与生产发布。

## 交付物

1. D1 migrations 与表结构（含唯一约束、索引、保留字段）。
2. `email()` handler 与入站解析模块，附合成 fixture 的 T1/T2 测试。
3. R2 key 规则与写入/读取封装。
4. MCP 读工具与 Markdown / `structuredContent` 输出；正文带 `UNTRUSTED_EMAIL_CONTENT`。
5. 隔离区查询路径（管理侧或受限工具，具体形态待决）。
6. 更新 `docs/engineering/FOUNDATION.md`：真实已创建资源与未创建资源的边界。

## 验收证据

1. 从真实外部邮箱向测试地址投递一封合成邮件，D1 有元数据、R2 有原始 MIME，MCP `search → thread → message` 可读。
2. 向不存在地址投递，SMTP 侧得到明确拒收（不是静默丢弃）。
3. 同一 `Message-ID` 重复投递两次，只产生一条 message。
4. 构造 DMARC fail 邮件，进入隔离区且不出现在默认可检索结果。
5. 超过大小/部件上限的邮件得到显式拒收或隔离，不静默截断。
6. 日志与指标抽样检查：无地址、主题、正文、附件名。
7. 测试只存在于 dev/test 环境；生产 DNS/MX 未变更。

每条证据必须绑定 commit SHA 与环境标识。

## 依赖与阻塞

- v1 §10 的 P0 #1–#7 必须先闭环：域名归属、Email Routing 能力与限制、SPF/DKIM/DMARC 结果传递方式、D1 FTS5、R2 能力。
- `tomlab.cn` 未确认前不得改 DNS；可以先用 `who-you-dev` + 测试子域做本地/预发验证。
- 需要独立资源创建授权：D1、R2、Email Routing 规则、Worker 环境。

## 待决

1. 地址由系统派生还是用户自选；保留字最终清单。
2. 附件单封上限与总存储配额默认值。
3. 隔离区是否对 Agent 可见（建议默认不可见，只提供「存在隔离邮件」计数）。
4. 检索在 FTS5 不可用时的降级字段与分词策略。
5. 删除 R2 与 D1 的保留/清理节奏。
