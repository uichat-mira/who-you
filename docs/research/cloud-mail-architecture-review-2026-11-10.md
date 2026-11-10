# Cloud Mail 深度调研与狐邮（Who You／忽悠）免费服务架构建议

> 日期：2026-11-10（北京时间）｜面向：@tzt2026 与 Mira 维护者  
> 研究性工程建议，不构成产品新功能、供应商合规、云资源变更或生产部署授权。  
> **不可变产品约束：狐邮对最终用户免费，无订阅、发送付费与隐藏收费；运营方成本必须明确受控。**

## 1. 执行结论

1. **建议巩固 Cloudflare Workers + D1 + R2 + Email Routing 作为狐邮运行架构。** 初期仅 2 名用户，重点风险并非请求吞吐，而是收件正确性、真实外发可用性、免费配额及安全。
2. **这一步实际上已经发生。** [Who You PR #11](https://github.com/uichat-mira/who-you/pull/11) 2026-11-10 已撤销 [PR #9](https://github.com/uichat-mira/who-you/pull/9) 的 Node VPS 迁移；核查时 \`dev@623942d1dc663702ed6ac4d64109cdd98ba31aff\` 是 Workers 代码。**不要再布置重复的 VPS → CF 回迁施工。**
3. [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 是技术参考，不是替换品。它证明了 Cloudflare 上构建 Web 邮箱的可行性，却不自带 Who You 的 Mira Cloud Auth、远程 MCP 和用户逐草稿确认发送安全契约。
4. **Cloudflare Email Sending Beta 官方定位为事务邮件。** 不能仅凭每月包含发信额度便声称支持自由个人邮件往来。可考虑 Resend 等方案，但必须先确认对具体用途的许可/合规与免费额度。
5. 上线前先修复 Who You 当前 [PR #4](https://github.com/uichat-mira/who-you/pull/4) 所涉及的并发重复收信数据完整性、伪造认证头等 P1；随后在隔离环境实测实际 Cloudflare 的接收、读取、发送资格和回执。

## 2. 源码与证据范围

| 对象 | 检查快照及证据 |
| --- | --- |
| Cloud Mail | \`main@d115f4ccc5cb5fb9c602b3ba364acbca6d19f274\`，2026-10-25 的最新可见提交；[README](https://github.com/maillab/cloud-mail/blob/main/README.md) |
| Who You | \`dev@623942d1\`，2026-11-10 回归 Workers 后；[PR #11](https://github.com/uichat-mira/who-you/pull/11) |
| Cloud Mail 入站 | [mail-worker/src/email/email.js](https://github.com/maillab/cloud-mail/blob/main/mail-worker/src/email/email.js) |
| Cloud Mail 出站 | [mail-worker/src/service/email-service.js](https://github.com/maillab/cloud-mail/blob/main/mail-worker/src/service/email-service.js) |
| Cloud Mail 部署 | [.github/workflows/deploy-cloudflare.yml](https://github.com/maillab/cloud-mail/blob/main/.github/workflows/deploy-cloudflare.yml) |
| Cloud Mail 测试 | [mail-worker/test/index.spec.js](https://github.com/maillab/cloud-mail/blob/main/mail-worker/test/index.spec.js) |
| Who You 设计 | [产品设计 v1 独立分支](https://github.com/uichat-mira/who-you/blob/docs/who-you-product-design/docs/product-design.md)，部分事实需按当前代码更新 |
| Who You 增量 | [S5 PR #12](https://github.com/uichat-mira/who-you/pull/12)，尚未合并 |

以下是**代码/公开文档静态调研**：没有执行 Cloud Mail 真实部署、渗透测试、生产发信或 Who You 实际云资源操作。Issue 的实际受害经历应归因于报告人自述，而不是本报告独立复现。

## 3. Cloud Mail 架构与功能分析

Cloud Mail 的服务器端是 **Cloudflare Worker + Hono + Drizzle + D1 + KV + R2**，前端是 **Vue 3 + Element Plus**；\`postal-mime\` 处理入站 MIME，R2 保存附件，D1 管理邮件与账户元数据。Worker 同时有 HTTP 和 \`email()\` 入口，定时任务清理缓存/状态。它可配置 Cloudflare Email binding 和 Resend 对外发信，另有站内投递；见 [Worker 入口](https://github.com/maillab/cloud-mail/blob/main/mail-worker/src/index.js)、[依赖](https://github.com/maillab/cloud-mail/blob/main/mail-worker/package.json)、[发送选择](https://github.com/maillab/cloud-mail/blob/main/mail-worker/src/service/email-service.js)。

| 能力 | Cloud Mail 当前证据 | Who You 应用判断 |
| --- | --- | --- |
| 自有域收件 | \`email()\` + \`postal-mime\` + DB | 架构范式可借鉴 |
| 账户/角色、管理后台 | Web 用户及 RBAC | 2 个 Mira 账户无需复制完整用户体系 |
| 邮件发送 | CF binding 优先 / Resend 备选 | 借鉴 Provider Adapter，不能绕过发送确认 |
| 附件处理 | R2 存取 | 学习对象存储和下载实践，必须保留账户隔离 |
| Web UI、通知和验证码 | Vue/Element Plus、TG/Webhook、Workers AI | 非当前必要 MVP，不引入额外维护面 |
| MCP | 当前无原生 MCP；[需求 #641](https://github.com/maillab/cloud-mail/issues/641) 尚以功能请求存在 | 必须保留 Who You 已完成的 MCP |
| 自动部署 | 有 main → Workers 的 GitHub Action | 不满足 Mira dev/test/prod 环境纪律 |

**产品范式差异**：Cloud Mail 是供人直接登录的 Web 邮箱；Who You 是由 Mira Desktop/Mobile 经 Cloud Auth 使用的 Agent 邮件服务。Mira 客户端必须先向用户展示**具体草稿的最终收件人、主题、正文和附件**，用户显式确认后才签发一次性发送凭证；仅有代理模型的 MCP scope 不等于发送授权。

## 4. 源码级发现与安全风险

### 4.1 收件身份认证（重大）

[Cloud Mail 安全 Issue #642](https://github.com/maillab/cloud-mail/issues/642) 2026-11-10 报告，伪造“系统通知”能够进入邮箱，并指出收信入口没有使用可信 SPF/DKIM/DMARC 判定。阅读其 [email.js](https://github.com/maillab/cloud-mail/blob/main/mail-worker/src/email/email.js) 可确认：可见入口主要使用解析出的 MIME 字段、字符串黑名单和账户匹配，没有按可信认证结果决定隔离/拒收。实际攻击过程属于 Issue 提交人的自述，未经本报告复现。

[Cloudflare 官方 Email Worker 文档](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) 明确：Email Routing 会前置认证结果，应从 **message.headers 的第一个 Authentication-Results** 读取，并校验 authserv-id 是 \`mx.cloudflare.net\`；原始 MIME 内的同名头可能由攻击者插入，不能充当平台可信结果。不能简单地把认证信息未知当成 pass，也不应一律误杀所有合法转发邮件。应提供可靠的隔离/拒收策略及审计。

Who You [PR #4](https://github.com/uichat-mira/who-you/pull/4) 同样涉及该问题，目前仍未合并，**这是正式收件前的 P1 Gate**。

### 4.2 MIME 边界

Cloud Mail 借助 \`postal-mime\` 减少 MIME 实现维护成本，但其入口按块 \`TextDecoder().decode(value)\` 后拼接字符串，理论上有 UTF-8 多字节字符跨块被错误解码的风险；这是静态推断，应通过人工构造分块测试确认，而不是已证实线上故障。Who You 现有 MIME 解析器虽严格限制部件、层级和大小，却承担自维护兼容性的风险。建议先建立**同一批真实格式/恶意边界 fixture**，再决定是否引入成熟解析库；不是因为开源项目用了就立刻重写。

### 4.3 代码测试与可用性证据不足

Cloud Mail 可见的 [测试文件](https://github.com/maillab/cloud-mail/blob/main/mail-worker/test/index.spec.js) 主要还是 Hello World 示例。仓库 Star、完整 UI、README 功能表都不等于证明跨账户安全、真实邮件投递、反滥用与备份恢复已通过验收。把它当作参考系统，比整体复制更可控。

### 4.4 GitHub Action 不可照搬

[Cloud Mail 自动部署工作流](https://github.com/maillab/cloud-mail/blob/main/.github/workflows/deploy-cloudflare.yml) 从 \`main\` 直接部署，还在 CI 中查找/创建 KV、D1 并按模板替换环境。其初始化访问采用含 **JWT_SECRET 的 URL 路径**；密钥可能因代理访问日志、监控等残留，属于应避免的设计风险（不声称已发生真实泄漏）。Who You 必须保留 \`feat/* → dev → test → prod\`、独立密钥/数据库、生产仅由 prod 发布、可回滚和有限权限。现有项目使用 Cloudflare \`cf\` CLI，不应因为参考项目用了 Wrangler 就双重引入。

### 4.5 许可和范围

[MIT 许可证](https://github.com/maillab/cloud-mail/blob/main/LICENSE) 允许按条件复制，但需保留原许可和版权声明。推荐对实现思路做独立设计与回归验证，而不是整包移植账户管理、群发和开放 API：这会增加安全面并削弱 Agent 的最终用户授权边界。

## 5. 官方资源、免费承诺与成本真实性（截至 2026-11-10）

| 能力 | 官方公开约束 | 对 2 用户的影响 |
| --- | --- | --- |
| [Workers Free](https://developers.cloudflare.com/workers/platform/limits/) | 每日 100,000 次请求、每次 CPU 10ms、128MB 内存 | 轻量 HTTP 够，**大 MIME/多附件解析可能超 CPU**，须真实测量 |
| [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) | 更高 CPU 预算，账户级基本费用一般至少约 **$5/月**，外加可能的超额计费 | 如必须升档，由运营者另行批准，不收费给用户 |
| [Email Routing](https://developers.cloudflare.com/email-service/platform/pricing/) | Free/Paid 均有收件；[限制](https://developers.cloudflare.com/email-service/platform/limits/)单封 25MiB | 免费收件≠任意大小、任意 MIME 都可成功解析 |
| [D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) | 账户共 5GB，单库 [500MB](https://developers.cloudflare.com/d1/platform/limits/)，500 万行读/日、10 万行写/日 | 用于**元数据**即可，正文/附件应去 R2 |
| [R2 Standard](https://developers.cloudflare.com/r2/pricing/) | 每月 10GB-month、100 万 Class A 和 1000 万 Class B 免费，超额按量计费 | 两账户可控，但必须有单箱及总量配额 |
| [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/platform/pricing/) | 向任意外部收件人发信需 Workers Paid；含 3,000 封/月，再按量；[官方描述](https://developers.cloudflare.com/email-service/)为**事务邮件** | **不能由额度推断个人一对一自由发信合规** |
| [Resend Free](https://resend.com/pricing) | 3,000 封/月，100 封/日，3 个域名；另有 [AUP](https://resend.com/legal/acceptable-use) | 作为候选，需核实个人免费邮箱用途和政策，不能默认可用 |

**两种“免费”必须区分**：

- 产品对用户免费（本次明确约束）：用户不交钱，不隐藏发信费用，不靠强迫升级获得其基础邮箱功能。
- 基础设施是否零成本：Cloudflare Workers Paid、D1/R2 超额、外发通道等都可能产生运营费；**不得宣称永久 $0 运营成本**，必须核定账户额度、监控与硬停机/限额策略。

若个人日常通信没有找到允许且可承受的发信服务商，**先交付“收件 + 阅读 + 草稿”的明确受限测试版**，而不是绕开外发政策或将其宣传为完整免费双向邮箱。

## 6. Who You 现存能力与缺口

- 当前 [Worker 入口](https://github.com/uichat-mira/who-you/blob/dev/src/index.ts) 已恢复 \`fetch / email / scheduled\`；[\`cloudflare.config.ts\`](https://github.com/uichat-mira/who-you/blob/dev/cloudflare.config.ts) 仍无正式生产服务绑定，不能据此宣称已实际部署。
- S1–S4 代码累积具备：邮箱、线程、搜索、附件、草稿、一次性确认、用户侧邮件状态、审计、退信/投诉抑制。然而**本地/workerd 测试不证明生产端到端真实邮件收发**。
- [#4 P1](https://github.com/uichat-mira/who-you/pull/4) 尚未合并：并发重复收件可能写入或清理相同 R2 对象；未经可信认证的 DMARC 影响隔离判断。修复应兼顾 D1 唯一约束、只有获胜写入才能更新计数与线程、失败对象安全回滚。
- [S5 PR #12](https://github.com/uichat-mira/who-you/pull/12) 正在增加投递状态、附件去重、CID 图片显示等；尚未合并，也不等于客户端已完成。
- 设计分支提出邮箱域名 \`tomlab.cn\`，但**没有看到经批准的 MX、Cloudflare Zone 归属和 DNS 操作授权**。拼写与真实域名必须逐字核对，不可据相似名字推定。

## 7. 推荐目标架构（保留已有业务语义）

\`\`\`mermaid
flowchart TB
  C[Mira Desktop / Mobile] -->|Cloud Auth bearer / MCP| W[Who You Workers]
  U[用户查看最终草稿并确认] -->|绑定 hash/version 的一次性凭证| W
  E[互联网邮件] --> MX[CF Email Routing]
  MX -->|可信 auth result + raw MIME| W
  W --> D[(D1 元数据、草稿、回执)]
  W --> R[(R2 raw、正文、附件)]
  W -->|仅获准的适用发信场景| P[合规发信服务商]
  P -->|签名回执、退信、投诉| W
\`\`\`

**保留** Cloud Auth 发行的 \`mira:who-you\` audience、分离的 \`whoyou.read / whoyou.mail.write / whoyou.mail.send\` scope、token 派生账户、逐草稿版本/哈希校验、单次 nonce、隐私日志、不可信邮件正文标记以及 MCP API/错误码。不要引入 Cloud Mail 的第二套登录、公开管理 API、群发或自动发送控制面。

### 备选方案比较

| 方案 | 工程投入 | 运营负担 | 与产品边界匹配 | 建议 |
| --- | --- | --- | --- | --- |
| **A. 原生 Who You Workers + D1/R2 + Routing + 合规外发适配** | 已有 S1–S4 可重用 | 低至中，按量与账号配额 | 高 | **首选** |
| B. Node VPS + SQLite + 自建 SMTP | 已有历史 PR #9，但已撤销 | 高：25 端口、IP 声誉、TLS、DKIM、备份、故障值守 | 可实现但过重 | 不重启 |
| C. 完整 Fork Cloud Mail | 前端功能多，重新接入 MCP/Cloud Auth 开销大 | 中到高 | 身份和发送授权不一致 | 不推荐 |
| D. Cloud Mail 负责邮件，Mira 再包 MCP | 需要双账户/双鉴权及两套副作用路径 | 高 | 低 | 不选 |

## 8. 建议的改造顺序：可验证的小步，而非再造邮箱

**阶段 A — 架构与免费政策定版（应先于部署）**

- 将 PR #11 的当前 Workers 实况回写基础架构说明，避免 README/产品设计/代码叙述不一致；保留历史 ADR 而非抹除 PR #9。
- 验证邮箱域名及 Cloudflare 账户归属与 MX 改动边界；DNS/MX 变更需单独授权。
- 暂定 MVP：只允许 2 个 Mira Cloud 账户、每账户 1 个邮箱；作为设计候选，单箱 **1GiB**、单封原始邮件先限 **10MiB**、外发 **20 封/日/账号**。以上并非现存配置、最终承诺或平台统一限额；应按真实测量裁决。
- 明确用户 $0 与运营方费用上限；配置硬限额、超限拒绝并告知，不静默丢信；邮件保留是否有期限需另行产品决策，不因“免费”自动删除旧信。

**阶段 B — 先修 P1**

- 在 PR #11 后的 Workers 代码上重新评估并修复 [PR #4](https://github.com/uichat-mira/who-you/pull/4) 的并发对象冲突、计数原子性、可信 auth result 和 MIME 结构限制；
- T1/T3 回归证明并发重复收件、恶意 MIME 头、DMARC unknown、跨账户隔离、对象失败清理、quota 扣减与错误码；
- 不弱化测试，也不把无法使用浏览器的施工 Agent 的“浏览器验收”作为收卡硬门槛。

**阶段 C — Cloudflare 实测与发信选择**

- 使用独立 test 资源、最小权限 secret 和现有 \`cf\` CLI；在授权后实测 1/5/10/20MiB 不同 MIME，记录 Workers CPU、D1/R2 行为、\`EXCEEDED_CPU\`，决定是否必须使用 Workers Paid（费用由运营方决策）。
- 真正用受控测试域收信，确认 MX、可信认证头、配额和对象存储可恢复；用真实适用的 Provider 验证“确认凭证→发送→回执→退信”，不可用时保持发送关闭。
- 测试版先不碰既有 Mira Desktop 邮件中心；S5 单独明确共存/迁移选择。

**阶段 D — 发布与产品闭环**

- 只有 \`prod\` 经审批能触发生产部署；\`test\`/生产 D1、R2、路由、密钥必须隔离；记录固定 SHA、可回滚版本与数据恢复路径。
- 客户端完成：看信 → 草稿 → 最终内容展示 → 人工确认 → 发送 → 送达/退信状态（若供应商允许）。草稿修改立即使旧授权作废。
- Go/No-go 依据是**实际代码与环境证据**，不是 PR 合并或 CI 绿本身。

## 9. 上线拦截标准

**No-go**：#4 等价 P1 未解决；任意用户可伪造认证结果影响信任；并发重复投递可能毁信；未确定合法可用的外发渠道却声称自由发信；无产测隔离/回滚；成本无上限；只有模拟测试、没有真实收件证据。

**可进入下一环境**：安全 P1 有绑定 exact SHA 的回归；邮箱域名/Cloudflare 资源归属明确；免费用户合同、运营费用预算和硬限额明确；入站实际证据可复验；发送要么经供应商规则核实并通过实测，要么明确关闭；部署不触碰未经授权的生产环境。

## 10. 最终技术判断

对 @tzt2026：**支持已经完成的 CF 回归，肯定 S1–S4 实现，保留具有 Mira 身份与 Agent 安全价值的代码。** 不再投资 VPS 自建 SMTP，也不整体 Fork Cloud Mail。把 Cloud Mail 当作对照系统：借鉴它的 Cloudflare 栈和 provider adapter，同时吸取其发件人认证、测试覆盖和部署密钥纪律上的教训。

接下来衡量交付的不是文件数、PR 数，而是：**两个用户能否在约束清楚、成本可控、身份不被伪造、邮件不丢失的前提下，真正安全地收信、看信和（在合法可用时）发信。**

---

### 主要一手资料

- [Cloud Mail 仓库](https://github.com/maillab/cloud-mail) · [MIT](https://github.com/maillab/cloud-mail/blob/main/LICENSE) · [收信](https://github.com/maillab/cloud-mail/blob/main/mail-worker/src/email/email.js) · [发信](https://github.com/maillab/cloud-mail/blob/main/mail-worker/src/service/email-service.js) · [部署](https://github.com/maillab/cloud-mail/blob/main/.github/workflows/deploy-cloudflare.yml) · [测试](https://github.com/maillab/cloud-mail/blob/main/mail-worker/test/index.spec.js) · [安全 Issue #642](https://github.com/maillab/cloud-mail/issues/642)
- [Who You #11 回归 Workers](https://github.com/uichat-mira/who-you/pull/11) · [#4 收件 P1](https://github.com/uichat-mira/who-you/pull/4) · [#12 S5](https://github.com/uichat-mira/who-you/pull/12)
- [官方可信收件认证](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) · [Email Service 的事务邮件定位](https://developers.cloudflare.com/email-service/) · [Email 定价](https://developers.cloudflare.com/email-service/platform/pricing/) · [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/) · [D1 限额](https://developers.cloudflare.com/d1/platform/limits/) · [R2 定价](https://developers.cloudflare.com/r2/pricing/) · [Resend 定价](https://resend.com/pricing) · [Resend 使用规范](https://resend.com/legal/acceptable-use)
