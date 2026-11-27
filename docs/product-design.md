# Who You（狐邮）· 产品定位与接入 UI 边界

> **当前已裁决的产品责任边界** · 2026-11-21。本文只约定三个产品的职责、接入入口与可验证的现状；**不是**邮箱业务 PRD、S1–S8 任务合同、服务端 API 契约或上线声明。对应代码、部署、Issue 各自仍是所属事实的权威来源。

## 1. 产品定位（已裁决）

- **Who You / 狐邮是独立的邮件服务，作为 MCP Server 对外提供邮件工具。** 它可以提供面向人的轻量管理页面，但不会因此成为 Mira 的 MCP Client，也不以 Mira 进程作为自己的运行条件。
- **Cloud Auth 是云身份与服务凭证发行方。** 负责 Mira Cloud Account、设备绑定的 Cloud Session、第一方 OAuth 登录、JWT 签发和验证公钥。它不托管第三方邮箱密码、OAuth refresh token、邮件正文或邮件同步业务。
- **Mira Desktop / Mobile / OMM 是狐邮的 MCP 消费端。** 通过已授权能力使用狐邮；不再复制第三方邮箱凭据托管和邮箱同步的服务端职责。现有 Desktop 邮件中心是否退役、迁移和过渡仍按相应客户端任务合同处理，不因本定位自动删除。
- **普通人的邮箱接入、连接状态、重授权与解绑，应在狐邮界面完成。** 不把邮箱业务表单塞进 Cloud Auth，也不在各 Mira 客户端重复建设 Gmail / Microsoft / IMAP 配置。

这是维护者本轮确认的职责分工。未在此裁决的提供商细节、存储与保留规则、确认凭证、迁移方式仍交由既有 Issue/任务合同或后续显式裁决决定。

### 1.1 本地 Owner 与 Mira ID 用户身份（OPS-054）

- 每个狐邮部署实例最多拥有一个本地 Owner 账号：登录名固定为 `admin`，账号主体固定为 `local-owner:<应用 ID>`。它只属于该实例，不是 Mira ID 账号，也不与任何 Mira ID `subject` 建立 alias、合并或 impersonation；`local-owner:` 是 Owner 的保留账号前缀，Mira ID 用户主体保持自己的 subject。
- 本地 Owner 的初始登录固定为 `admin / 123456`；部署可用 `WHOYOU_OWNER_INITIAL_PASSWORD` 覆盖默认初始密码。初始密码只用于首次 bootstrap，首次成功登录后必须立即修改为至少 12 位的新密码；完成前只能访问「应用管理」中的改密入口，账户与邮箱业务页面不可用。数据库只保存摘要，不保存默认值或覆盖值的明文。
- 密码仅以加盐的 PBKDF2 摘要持久化。修改密码会提升该 Owner 的凭据版本，使此前签发的所有 Owner 会话立即失效。Owner 会话使用独立的 `__Host-who_you_owner_session` HttpOnly/Secure/SameSite cookie。
- Owner 与 Mira ID 用户复用同一套狐邮账户页、邮箱页和现有业务服务，但各自只能访问自己 `account_id` 下的邮箱、凭据和同步状态。Owner 唯一额外的 UI 入口是「应用管理」；该页提供 Owner 密码修改、实例只读摘要和 AppSecret 生命周期管理。
- APP_ID 在实例生命周期内稳定不变。AppSecret 只用于证明本实例的管理权，以便在 Mira ID 登记或再次验证 ownership；它不是 OAuth `client_secret`、MCP bearer、用户登录密码或 Owner 会话密钥。尚未轮换时，Owner 可再次输入当前 Owner 密码后查看部署初始 Secret；轮换后的新 Secret 只在成功响应中完整显示一次，D1 只保存加盐单向摘要、版本与轮换时间。遗失已轮换 Secret 只能再次轮换，不提供找回或明文保险箱。
- AppSecret 轮换与 Mira ID ownership、普通用户登录、邮箱连接及 MCP 服务授权解耦：轮换不会调用 Cloud Auth 删除/重建 ownership，也不会使既有用户会话或服务 grant 失效；它只影响未来再次提交的登记验证。`WHOYOU_APP_SECRET` 继续作为从未轮换实例的部署 bootstrap Secret 保留。
- 现有 Mira ID 登录、登出、Gmail 连接/解绑/同步和 MCP 认证合同保持不变。本卡新增的本地 Owner 能力不代表已部署到生产，也不代表已经轮换任何真实凭据。

## 2. UI 入口归属（已裁决的位置；不能当作已实现）

| 位置 | 所有者 | 期望入口及职责 | 当前状态 |
| --- | --- | --- | --- |
| `https://cloud-auth.tomzlab.cn/account/services` | Cloud Auth | 「关联服务」按实际授权动态投影关联应用服务；狐邮不是编译期静态特例 | 当前 dev 已有实例服务目录及撤销入口；上线状态另行验证 |
| `https://cloud-auth.tomzlab.cn/account/applications` | Cloud Auth | 「我的应用」管理登记、实例所有权；与普通用户服务授权分离 | 当前 dev 已有真实入口；V1 登记合同见 [应用实例 V1](engineering/mira-application-v1.md) |
| `https://who-you.tomz.io/account` | Who You | 通过 Mira ID 或本部署实例的本地 Owner 进入狐邮；显示已复核身份、应用访问、邮箱状态及二级公开实例信息 | V1 app-scoped session + OPS-054 本地 Owner 会话；「应用管理」另承载 OPS-055 的 APP_ID / AppSecret 查看与轮换；不将 manifest 声明权限当作当前服务授权 |
| `https://who-you.tomz.io/account/mailboxes` | Who You | 邮箱配置页：列出当前账号邮箱，承载第三方邮箱连接、重授权与解绑；具体操作必须由已实现的邮箱合同和真实部署能力支撑 | **已实现账号隔离的邮箱列表与状态页；OPS-041 接入 Gmail 连接 / 重授权 / 解绑源码链路。真实 Gmail 可用性仍取决于生产 provider bindings、KEK 与单账号 T4；Microsoft / IMAP-SMTP Web 入口未开放** |
| Mira 的 MCP 连接设置 | Mira 各客户端 | Mobile 按 Mira ID 实例授权目录动态呈现插件，使用通用实例级受限凭据；必要时跳至狐邮管理邮箱 | V1 纵切验收由 OPS-053 负责，不将目录模型等同于上线验收 |

**三层归属一句话**：Cloud Auth 管「谁在登录、能否签发服务凭证」；Who You 管「哪些邮箱及凭据归属当前账号、邮件工具如何工作」；Mira 管「用哪些授权的 MCP 工具完成用户任务」。

## 3. 历史实现和部署边界（2026-11-21 核对，不代表当前 dev）

当前 dev 的实例接入、OAuth、授权与 MCP 凭据合同已切换到 [V1](engineering/mira-application-v1.md)。以下保留历史部署证据，不作为现行源码接入方法。

- **Cloud Auth 代码**：`packages/contracts/src/oauth.ts` 注册 `who-you-web` / `web`，精确回调 `https://who-you.tomz.io/auth/callback`；原 Desktop、Mobile 客户端仍在。OAuth 是 PKCE S256 授权码登录；`/v1/service-credentials` 对已验证且绑定设备的 Cloud Session 签发 `mira:who-you` 受众的短期票据，默认 `whoyou.read`。
- **Who You 代码**：`src/web/cloud-auth.ts` 处理首页、Cloud Auth 登录/退出、`/account`、`/account/mailboxes`、邮箱列表 BFF，以及 Gmail 连接/重授权/解绑的 Web 接线；真实 Gmail OAuth/PKCE、凭据密封与删除仍复用 `src/mail/` / `src/mcp/` 的现有合同。浏览器不接触 Cloud Session 原文、服务 JWT 或 identity-confirmation JWT。`src/index.ts` 同时承载 `/mcp`、认证元数据和既有邮件接口。
- **部署**：已验证的用户入口是 `who-you.tomz.io`，指向独立 Worker `who-you-tomz-preview`；Cloud Auth 仍运行在其自管服务器。Worker 当前使用隔离 D1/R2，浏览器会话有 Secret，**无定时 Cron**。此处运行的是受限的身份/MCP 预览，不能与 `cloudflare.config.ts` 所描述的另一套可能包含 `MAIL_DOMAIN`、邮件路由和 Cron 的部署相混淆。
- **真实验收范围**：用户已在浏览器看到登录后 `/account` 显示 Cloud Auth 身份、MCP 连接成功与 `whoyou.read`；独立公网检查涵盖 TLS、OAuth 跳转、未认证 401、旧域名回调被拒绝。此证据**不能证明**登录退出已完整验收、邮箱服务商凭据已配置、第三方邮箱已真实同步或真实邮件已发送。
- **已有代码不等于线上功能**：`src/mail/` 中有自有域邮件、Gmail、Microsoft、IMAP/SMTP 等业务代码及测试；在上述独立 Worker 未配置对应提供商凭据、邮件域名与定时器时，不能把这些代码描述成已开通的邮箱服务。
- `mail.tzt2026.xyz` 出现在 [WHO-S8 #27](https://github.com/uichat-mira/who-you/issues/27) 的 **MCP-only** 合同中；它不是 `who-you.tomz.io` 的 Web 登录入口。两个上下文的业务合同、部署身份与验收证据不得混写。

## 4. 安全与权限边界

1. 用户**登录 Cloud Auth ≠ 已经授权 Mira 阅读任意第三方邮箱**。需区分云账号身份、狐邮服务票据（`whoyou.read` / 进一步写入权限）和邮箱服务商 OAuth / IMAP 授权。页面上的“已连接”必须说明是哪一种连接。
2. Gmail / Microsoft 的授权凭据及 IMAP/SMTP 应用密码只归狐邮的业务存储/加密契约负责；Cloud Auth 不接触它们。具体托管、同步、撤销后数据删除及 KEK 轮换以 [WHO-S7](task-cards/WHO-S7-third-party-mailbox.md) 和 [凭据安全契约](engineering/CREDENTIAL-SECURITY-CONTRACT.md) 为准。
3. 发信必须遵守现有草稿版本、内容哈希、单次确认凭证及防重放规则；**接入 UI 不得自行创造绕过人工确认的发送按钮**。
4. 「解绑邮箱」和「断开 Mira 对狐邮的访问」是不同动作，应分开展示对应后果；在没有持久授权状态或撤销接口前，不应提供看似有效的假按钮。
5. 未经明确任务授权，不开通真实邮件服务商凭据、Email Routing、MX/SPF/DKIM、更改 DNS、Cron、批量导入或真实发信。

## 5. 单一真相源与历史材料的使用方式

- **本文**只拥有跨产品定位和接入 UI 所属位置，不重复实现级路由定义、参数枚举或各业务卡验收条款。
- **Cloud Auth 认证技术事实**：`uichat-mira/cloud-auth` 的当前 V1 application OAuth / open platform contracts、`apps/api/src/`、`docs/application-oauth-v1.md`、`docs/open-platform-protocol-v1.md` 和 `docs/open-platform-service-credentials-v1.md`。用户界面现状以 `apps/web/src/` 为准。
- **狐邮技术事实**：本仓库的 `src/`、`migrations/`、`cloudflare.config.ts` 与真实 Worker 绑定、域名、部署版本；本地 config 并不代表所有线上环境。
- **任务范围与结果**：现行 GitHub Issue 为准；[S1–S7 历史任务卡](task-cards/README.md) 只是设计/施工档案，不得用旧卡内的「未部署」「待开工」「v1 §x」覆盖当前代码和发布证据。
- 原 `docs/product-design.md v1` 被旧卡引用，但其原始内容**未在当前 `dev/prod` 分支找到**。本文不是对原 v1 的恢复或补写，不宣称保留原章节号。旧卡中的 `v1 §` 只作为历史备注；如需恢复原文，应从真实历史分支/PR 取证，不得猜测。
