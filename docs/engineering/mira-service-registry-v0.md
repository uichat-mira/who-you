> **历史 V0 档案，已退役。** 当前 dev 请使用 [应用实例 V1](mira-application-v1.md)。本文件中的脚本、固定 client、管理 token 和票据均不再是产品入口。

# Mira ID 通用服务注册与登录即授权（OPS-048）

本文定义 **Who You / 狐邮** 作为首个真实云 MCP 服务接入 Mira ID 服务注册表时的服务侧声明、可信注册操作、账号关联、授权与可用性语义，以及交给 Mobile（A2）做最终消费迁移的接口。

- 当前上游合同： [Cloud Auth OPS-049](https://github.com/uichat-mira/cloud-auth/blob/6c48415f4f5f7180e12ddbf8d643374eb43f3b55/docs/service-registry-v0.md)，生产提交 `6c48415f4f5f7180e12ddbf8d643374eb43f3b55`（#205/#206/#207）。
- A1 OPS-047 的逐账号 CLI 是未受管服务的历史维护入口，不再作为狐邮用户授权机制。
- 本卡复用现有 Web OAuth BFF、MCP 与邮箱权限；应用管理凭据和用户会话/服务凭据严格分离。

## 1. 服务身份与注册声明

应用登记 API 使用的唯一声明是：

[`config/mira-service-registry/who-you.json`](../../config/mira-service-registry/who-you.json)

```json
{
  "serviceId": "who-you",
  "projectId": "who-you",
  "displayName": "Who You",
  "protocol": {
    "name": "mcp",
    "version": "2025-11-25",
    "endpoint": "https://who-you.tomz.io/mcp"
  },
  "audience": "mira:who-you",
  "scopes": ["whoyou.read"]
}
```

| 字段 | 当前值 | 说明 |
| --- | --- | --- |
| `serviceId` / `projectId` | `who-you` | A1 对狐邮的固定保留身份 |
| `protocol.name` | `mcp` | A1 通用消费只解释标准 MCP；未知协议不得渲染 |
| `protocol.version` | `2025-11-25` | 本仓库有兼容性证据、且 A2 支持集合包含的稳定修订 |
| `protocol.endpoint` | `https://who-you.tomz.io/mcp` | 当前实际部署的只读 MCP 入口，HTTPS、无凭据/查询/片段 |
| `audience` | `mira:who-you` | 既有狐邮票据受众；注册不创建新受众 |
| `scopes` | `whoyou.read` | A1 只允许狐邮的既有只读 canonical grant |

声明由 `src/mcp/service-registration.ts` 生成并严格校验；单元测试要求 checked-in 文件与代码序列化结果逐字节一致，并验证它与当前 Worker 的 `/mcp` 配置、MCP manifest 协议版本一致。

声明注册**不是账号授权、不是模型开关、不是权限扩大**：只有用户主动完成狐邮 OAuth 登录后，Mira ID 才将既有 `mira:who-you` / `whoyou.read` 服务授权关联到该账号。`whoyou.mail.write`、`whoyou.mail.send`、草稿确认、邮箱链接确认等仍走原有独立授权链。

## 2. 应用级登记、声明同步与用户授权

一次性由 Cloud Auth 管理员登记可信应用 `who-you-web`，projectId 为 `who-you`，回调为 `https://who-you.tomz.io/auth/callback`，允许的 HTTPS origin 为 `https://who-you.tomz.io`。按 OPS-049 上游合同生成独立管理 bearer，仅由狐邮应用维护者的服务端秘密管理环境保管。**不向 Worker 的浏览器交互、MCP、OAuth 用户请求或 Git 注入此密钥。**

已实现应用侧维护入口 `npm run service:registry -- <action>`，由安全的服务端环境注入 `WHOYOU_APPLICATION_MANAGEMENT_TOKEN`，不放在命令参数、终端历史或 CI 日志中。固定目标 `https://cloud-auth.tomzlab.cn`；CLI 不接受任意目标地址、用户账号、scope 或声明文件参数。日常登录不调用管理接口。

| 动作 | 接口和语义 |
| --- | --- |
| status | GET /v1/application/services；仅显示状态、revision 和是否与本仓 manifest 一致 |
| sync | 先 GET 自身声明，缺失时 PUT revision 0，活动声明不同时带当前 revision 更新；完全一致则不写入 |
| retire | POST /v1/application/services/who-you/retire，带当前 revision；已下架则不重复写入 |
| reactivate | 显式恢复已下架声明，带当前 revision；不会恢复账号授权 |

同步只使用本仓 canonical manifest，不自动重试冲突、不跟随 HTTP 跳转、不回显 bearer 或上游错误正文。若超时/409，先读 status，再确认新的声明修订后重试。下架不会被普通 sync 自动复活。该命令不是发布 workflow 的自动步骤：首次生产登记/激活必须协调 MOB-105 切换、实际账号验收以及正式密钥配置。

现有狐邮 `/auth/start` → Mira ID 登录页 → `/auth/callback` → OAuth code+PKCE 换票不变；成功兑换时由 Cloud Auth 原子创建该账号的服务授权。其他账号、普通 Mobile/Desktop 登录、恢复会话和退出均不新增授权。现有设备的 GET /v1/services 直接发现，无需再登录手机端。无授权/已撤权的存量狐邮会话需要用户主动重新登录，不静默补授；账户页提供原有 OAuth 登录恢复入口。没有新增独立服务启用流程。

## 3. 运行时票据与狐邮校验

A2 按目录 revision 请求：

```http
POST /v1/services/who-you/credential
Authorization: Bearer <device-bound Cloud Session>
Content-Type: application/json

{"expectedRevision": 1}
```

狐邮 MCP 不接收 Cloud Session，也不参与签发。现有 Web BFF 经 OAuth 获取并密封 Cloud Session，继续以它向 Cloud Auth 请求独立业务凭据，不将会话或票据交给浏览器。对狐邮条目，Cloud Auth 复用既有 canonical 签发规则；票据应包含：

| claim | 期望 |
| --- | --- |
| `iss` | `mira:cloud-auth` |
| `aud` | `mira:who-you` |
| `sub` | 已授权账号 ID |
| `device_id` | 发起签发的设备 |
| `consumer_id` | 该账号（A1 canonical 由已验证会话派生） |
| `scope` | `["whoyou.read"]` |
| `exp` | 短期（A1 配置 TTL ≤ 600 秒） |

`/mcp` 继续使用现有的 Cloud Auth JWKS 验签、精确 issuer/audience、`EdDSA`、`exp`、非空 `sub` 与 `consumer_id` 校验；不新增本地信任、共享密钥或匿名回退。错误 audience（包括通用 `mira:service:who-you`、其他服务 audience、OAuth discovery URL 冒充 JWT issuer）、错误签名、过期或缺失 consumer 均返回不披露内容的 401；业务查询按签名 sub 隔离账号，客户端还必须核对 consumer_id 与当前账号一致；缺少 `whoyou.read` 返回 403。

`whoyou_whoami` 是目录/票据绑定后的身份核对点：`accountId` 与 `consumerId` 必须都等于目录所属账号，`scopes` 必须精确为 `["whoyou.read"]`。任何不一致都应在客户端停止执行，而不是继续调用工具。

## 4. 账号关联、当前授权与可用性

- **账号关联**：登录触发的授权以真实认证账号为边界。没有注册、跨账号、错误 revision 或已撤销条目不会产生票据；服务端不按工具参数选择账号。
- **当前授权**：`GET /v1/services` 的条目 revision + 短期票据共同构成一个授权绑定。账号/设备/会话撤销、登出或账号切换后不得复用旧绑定。
- **可用性**：目录可用性由 Cloud Auth 决定；`/mcp` 可用性由狐邮部署决定。二者不是同一个健康状态，目录返回条目不代表邮箱已接入、provider 可用、同步完成或发信已启用。
- **其他服务**：每个 `serviceId` 的注册、revision、撤销与票据彼此独立；狐邮目录项或 `/mcp` 故障不改变其他服务的注册。通用客户端应按服务隔离错误，不得用一个服务的失败关闭整个目录。
- **业务邮箱关联**：仍由既有邮箱身份生命周期决定。有狐邮票据但没有邮箱/身份时，只读工具返回 `mailbox_not_provisioned`、空 identity 列表或空搜索结果，不会借用其他账号邮件。

## 5. 撤销、离线票据与旧签发路径

OPS-049 语义必须由消费端正确理解：

- 撤销会移除目录条目并阻止**后续 registry 签发**；随后用旧 revision 或新 revision 请求该服务均得到 `404 SERVICE_REGISTRATION_NOT_FOUND`。
- 已经签发的离线 bearer 在 `exp` 前仍可能被资源端接受（加有限的验证时钟容差）；资源端没有在线撤销查询。客户端一旦观察到撤销、登出、账号/设备切换或未知 revision，必须立即丢弃缓存绑定。
- 狐邮声明受管后，旧 /v1/service-credentials 对 mira:who-you 的 read、write、confirmation 请求同样需要有效账号 grant。撤权阻止两条路径新签发；旧离线票据仍遵循 exp。Web BFF 保留原有独立业务 scope 和确认签发；Mobile 旧发现及取票入口由 MOB-105 退休。未激活声明时旧行为保持兼容。
- 旧 Mobile 专用 Who You adapter、`LEGACY_SERVICE_IDS` 与通用动态目录目前**同时存在**。旧入口的退休属于 A2 / 维持者最终消费迁移，不在本卡跨仓施工。

## 6. 交给 A2（Mobile #400 后续）的消费接口

A2 已实现通用目录与票据消费；当前仍通过 `LEGACY_SERVICE_IDS` 排除 `who-you` 与 `mira-desktop`，以避免重复发现。维持者执行最终迁移时应核对：

1. 通用目录返回 `serviceId === "who-you"`、`protocol.name === "mcp"`、受支持的 `protocol.version`、`endpoint === "https://who-you.tomz.io/mcp"`、`audience === "mira:who-you"`、`scopes === ["whoyou.read"]`。
2. 请求精确 revision 的票据，并验证 `sub`/`consumer_id` 与当前 Cloud 账号一致、scope 精确为 `whoyou.read`、`exp` 未过期。
3. 通过真实 `/mcp` 执行 `initialize`、`tools/list`、可选读取 `mira://service/who-you/capabilities` 与只读工具；工具与 Schema 始终以 `tools/list` 为准，不复制第二套工具名单。
4. 保留 Mobile 既有邮件披露边界：`whoyou_mail_search` / `whoyou_mail_message_get` 的正文读取审批、敏感结果标记、分页游标和只读工具集合不得因动态发现而放宽；不得因注册自动暴露 write/send/destructive。
5. 在撤销、登出、账号/设备切换或 revision 变化时丢弃目录+票据绑定；目录或狐邮故障只影响狐邮，不影响其他服务。
6. 只有在维持者用真实测试账号完成上述核对后，才移除 `who-you` 的 `LEGACY_SERVICE_IDS` 排除，并由 A2 负责旧专用入口退休验证。

本仓库只提供上述服务侧接口、声明和合同测试；不修改 Mobile 代码，也不声称旧入口已退休。

## 7. 可重复执行验证与证据边界

常规门禁 `bash scripts/check.sh` 包含 manifest 单元测试、应用管理命令的 revision/幂等/下架/冲突测试，以及真实 workerd MCP、分页、业务权限等回归。原 `tests/mcp-service-registry.test.mjs` 的目录/签发是测试替身；不将它冒充真实 Cloud Auth 联调。

新增 `tests/ops048-managed-real-issuer.mjs` 是独立运行的跨仓 T3 集成验证。使用精确 Cloud Auth prod 提交 `6c48415f4f5f7180e12ddbf8d643374eb43f3b55` 的干净 checkout，按其构建方式编译 contracts 与 API；再从本仓根目录执行：

```sh
npm ci
npm run build:tests
OPS048_AUTH_API_DIR=/path/to/cloud-auth/apps/api node tests/ops048-managed-real-issuer.mjs
```

验证脚本只启动 loopback issuer、临时 SQLite、生成一次性签名密钥和测试账号，调用真实管理员应用登记命令、应用管理 HTTP API 与实际 workerd BFF/MCP。测试网络将 canonical OAuth/JWKS 请求转发至本地真实 issuer，Miniflare MCP 使用其 loopback resource fixture（生产 manifest 及 OAuth callback 保持 canonical，未放宽 Host 校验）。覆盖：独立应用声明、普通设备登录不授权、真实 OAuth 表单/CSRF/PKCE 和 BFF 换票、跨账号、无邮箱、真实签发/JWKS/MCP、重复登录、退出、撤权、旧取票拒绝、主动重新登录及下架。所有测试数据都是合成的，不需要生产 token 或 provider 邮箱。

实际 Cloudflare 部署、生产应用管理密钥、生产声明激活、真实邮箱/设备 T4 归后续明确授权（Mobile #337/#258）。本轮未修改真实账号、邮箱、生产数据、发布环境或发送邮件；Mobile 旧入口退休仍由 MOB-105 负责。
