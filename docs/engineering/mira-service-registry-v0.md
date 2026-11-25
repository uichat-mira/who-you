# Mira ID 通用服务注册 v0（OPS-048）

本文定义 **Who You / 狐邮** 作为首个真实云 MCP 服务接入 Mira ID 服务注册表时的服务侧声明、可信注册操作、账号关联、授权与可用性语义，以及交给 Mobile（A2）做最终消费迁移的接口。

- A1 合同：[`cloud-auth/docs/service-registry-v0.md`](https://github.com/uichat-mira/cloud-auth/blob/6c48415f4f5f7180e12ddbf8d643374eb43f3b55/docs/service-registry-v0.md)
- A1 实现：cloud-auth #198；OPS-049 #205 / #207，生产代码基线 `6c48415f`，管理 API 合同。
- 本卡消费 Cloud Auth 的应用管理 API，不新增狐邮公开管理接口、设备/账号体系、第二套登录、工具列表或存储模型。

## 1. 服务身份与注册声明

唯一由狐邮发布脚本使用的服务声明是：

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

声明注册**不是用户授权、不是模型开关、不是权限扩大**：用户主动完成既有 OAuth 登录后，由 Cloud Auth 在兑换会话的事务中建立账号的 `mira:who-you` / `whoyou.read` 授权。`whoyou.mail.write`、`whoyou.mail.send`、草稿确认、邮箱链接确认等仍走原有独立授权链。

## 2. 可信注册与撤销操作

应用级登记由 Cloud Auth 管理员一次完成（不是每账号执行）。使用 OPS-049 上游的精确 `who-you-web`、`projectId=who-you`、`https://who-you.tomz.io/auth/callback` 和允许的 origin `https://who-you.tomz.io`。管理员在确认真实部署与启用计划后才可签发管理凭据。当前代码不触发生产登记。

狐邮使用独立服务侧发布脚本，管理凭据由受控运维环境的 Secret 注入 `WHOYOU_APPLICATION_MANAGEMENT_TOKEN`。它不会进入 Worker/browser、用户 OAuth、Git、日志或 MCP 配置；不要在终端历史或命令参数中输入原文。脚本固定正式 Cloud Auth HTTPS origin，拒绝重定向。以下是**授权后的运维入口**，不是自动运行步骤：

```sh
npm run registry:manage -- status
npm run registry:manage -- publish
npm run registry:manage -- retire
npm run registry:manage -- reactivate
```

脚本调用 GET /v1/application/services、PUT /v1/application/services/who-you、POST /v1/application/services/who-you/retire；由 Cloud Auth 验证归属和 origin。读取当前 revision 后执行显式操作；首次发布为 0，现有相同声明不重复写；冲突停止，不自动覆盖或恢复已下架声明。reactivate 明确恢复服务声明但不恢复用户授权。管理凭据可由 Cloud Auth 独立轮换/停用。build、CI、Worker 启动和用户登录均不执行声明发布。

普通用户沿用现有 `/auth/start` → Cloud Auth PKCE → `/auth/callback`，无额外授权按钮。登录成功后，已有设备会话使用 GET /v1/services 获得条目，不需要逐账号 CLI、重新登录 Mobile 或绑定客户端专用入口。未登录狐邮的账号不会自动获得授权；激活时已登录但无授权的存量用户需主动登录狐邮一次，禁止后台补授。

## 3. 运行时票据与狐邮校验

A2 按目录 revision 请求：

```http
POST /v1/services/who-you/credential
Authorization: Bearer <device-bound Cloud Session>
Content-Type: application/json

{"expectedRevision": 1}
```

狐邮不接收 Cloud Session，也不参与签发。对狐邮条目，Cloud Auth 复用既有 canonical 签发规则；票据应包含：

| claim | 期望 |
| --- | --- |
| `iss` | `mira:cloud-auth` |
| `aud` | `mira:who-you` |
| `sub` | 已授权账号 ID |
| `device_id` | 发起签发的设备 |
| `consumer_id` | 该账号（A1 canonical 由已验证会话派生） |
| `scope` | `["whoyou.read"]` |
| `exp` | 短期（A1 配置 TTL ≤ 600 秒） |

`/mcp` 继续使用现有的 Cloud Auth JWKS 验签、精确 issuer/audience、`EdDSA`、`exp`、非空 `sub` 与 `consumer_id` 校验；不新增本地信任、共享密钥或匿名回退。错误 audience（包括通用 `mira:service:who-you`、其他服务 audience、OAuth discovery URL 冒充 JWT issuer）、错误签名、过期、缺失 consumer 返回不披露内容的 401；缺少 `whoyou.read` 返回 403。资源侧按签名 subject 隔离邮箱数据，跨账号消息 ID 返回不可见；客户端另行核对 consumer/account 绑定。

`whoyou_whoami` 是目录/票据绑定后的身份核对点：`accountId` 与 `consumerId` 必须都等于目录所属账号，`scopes` 必须精确为 `["whoyou.read"]`。任何不一致都应在客户端停止执行，而不是继续调用工具。

## 4. 账号关联、当前授权与可用性

- **账号关联**：授权由已认证账号主动登录建立。没有注册、跨账号、错误 revision 或已撤销条目不会产生票据；服务端不按工具参数选择账号。
- **当前授权**：`GET /v1/services` 的条目 revision + 短期票据共同构成一个授权绑定。账号/设备/会话撤销、登出或账号切换后不得复用旧绑定。
- **可用性**：目录可用性由 Cloud Auth 决定；`/mcp` 可用性由狐邮部署决定。二者不是同一个健康状态，目录返回条目不代表邮箱已接入、provider 可用、同步完成或发信已启用。
- **其他服务**：每个 `serviceId` 的注册、revision、撤销与票据彼此独立；狐邮目录项或 `/mcp` 故障不改变其他服务的注册。通用客户端应按服务隔离错误，不得用一个服务的失败关闭整个目录。
- **业务邮箱关联**：仍由既有邮箱身份生命周期决定。有狐邮票据但没有邮箱/身份时，只读工具返回 `mailbox_not_provisioned`、空 identity 列表或空搜索结果，不会借用其他账号邮件。

## 5. 撤销、离线票据与旧签发路径

A1 语义必须由消费端正确理解：

- 撤销会移除目录条目并阻止**后续 registry 签发**；随后用旧 revision 或新 revision 请求该服务均得到 `404 SERVICE_REGISTRATION_NOT_FOUND`。
- 已经签发的离线 bearer 在 `exp` 前仍可能被资源端接受（加有限的验证时钟容差）；资源端没有在线撤销查询。客户端一旦观察到撤销、登出、账号/设备切换或未知 revision，必须立即丢弃缓存绑定。
- 受管声明启用后，Cloud Auth 对旧 `/v1/service-credentials` 的狐邮受众同样要求活动授权；撤销后旧 Mobile 路径不得取得新票据。Web BFF 的显式读/写/身份/发送确认签发保留，仍由原有业务规则决定；不直接删除此端点。未激活时保留兼容行为。已签发离线票据仍受既有 expiry 边界限制。
- 旧 Mobile 专用 Who You adapter、`LEGACY_SERVICE_IDS` 与通用动态目录目前**同时存在**。旧入口的退休属于 A2 / 维持者最终消费迁移，不在本卡跨仓施工。

## 6. 交给 A2（Mobile #400 后续）的消费接口

A2 已实现通用目录与票据消费；当前仍通过 `LEGACY_SERVICE_IDS` 排除 `who-you` 与 `mira-desktop`，以避免重复发现。维持者执行最终迁移时应核对：

1. 通用目录返回 `serviceId === "who-you"`、`protocol.name === "mcp"`、受支持的 `protocol.version`、`endpoint === "https://who-you.tomz.io/mcp"`、`audience === "mira:who-you"`、`scopes === ["whoyou.read"]`。
2. 请求精确 revision 的票据，并验证 `sub`/`consumer_id` 与当前 Cloud 账号一致、scope 精确为 `whoyou.read`、`exp` 未过期。
3. 通过真实 `/mcp` 执行 `initialize`、`tools/list`、可选读取 `mira://service/who-you/capabilities` 与只读工具；工具与 Schema 始终以 `tools/list` 为准，不复制第二套工具名单。
4. 保留 Mobile 既有邮件披露边界：`whoyou_mail_search` / `whoyou_mail_message_get` 的正文读取审批、敏感结果标记、分页游标和只读工具集合不得因动态发现而放宽；不得因注册自动暴露 write/send/destructive。
5. 在撤销、登出、账号/设备切换或 revision 变化时丢弃目录+票据绑定；目录或狐邮故障只影响狐邮，不影响其他服务。
6. 使用隔离联验与真机验证逐步移除 `who-you` 的 `LEGACY_SERVICE_IDS` 排除，并由 A2 负责旧专用入口退休验证。

本仓库只提供上述服务侧接口、声明和合同测试；不修改 Mobile 代码，也不声称旧入口已退休。

## 7. 验证与证据边界

已执行：

- `bash scripts/check.sh`：真实 frozen-lockfile 安装、typecheck、lint、单元测试与 workerd 集成测试。
- `tests/service-registration.test.mjs`：声明文件与代码一致；A1 字段/端点/audience/scope 约束；错误端点、额外权限、错误 audience 被拒绝；声明的协议版本与 Worker manifest 有兼容证据。
- `tests/mcp-service-registry.test.mjs`：部署入口 `dist/worker.mjs` 通过远程 JWKS 验证真实 EdDSA 签名票据；注册账号执行真实只读 MCP、能力 Resource、邮箱读取与分页；跨账号隔离；无业务邮箱关联；错误 audience、其他服务票据、错误/欺骗账号、伪造签名、过期与缺失 consumer 拒绝；撤销后停止续签、已签发离线票据在 `exp` 前仍可用，其他服务注册不受影响。
- 既有 `mcp-auth` / `mcp-manifest` / `mcp-workerd` / `mcp-remote-jwks` 继续覆盖 issuer/audience/exp/scope 门禁、只读/写/发/删分类和旧协议客户端。

### OPS-049 真实隔离联验（可复现）

`tests/ops048-real-login.mjs` 不依赖线上账户或密钥。使用实际编译的 Cloud Auth checkout、临时 SQLite、临时签名密钥和真实本地 workerd Worker。声明使用本仓发布脚本真实调用管理 HTTP；Worker 的外部请求只桥接到隔离 issuer，MCP Host 使用 Miniflare loopback fixture，BFF 仍生成正式精确 OAuth callback。使用已构建、干净且 SHA 匹配的 Cloud Auth checkout：

```sh
# 先在隔离 cloud-auth checkout 执行 pnpm install --frozen-lockfile && pnpm run build
OPS048_CLOUD_AUTH_API_DIR=/path/to/cloud-auth/apps/api \
OPS048_CLOUD_AUTH_SHA=<full-verified-commit-sha> \
OPS048_CLOUD_AUTH_NODE=/path/to/node24 \
npm run test:ops048
```

本次实际验证 Cloud Auth `513713e4a0e69d6ff98e6390e56770f8cefcb2ed`（#205，已晋级 prod 同代码树），真实 enrollment、声明发布/幂等、设备目录、workerd 登录 OAuth/PKCE、真实签名/JWKS、无邮箱空结果、跨账号隔离、写入拒绝、退出不撤权、撤权后 registry 与 legacy 新签发拒绝、BFF 旧会话拒绝、重登恢复、下架/显式恢复及离线票据边界均通过。标准单元测试另覆盖脚本错误身份、revision 冲突和显式恢复；原有测试替身继续作为隔离回归，不代替本联验。

仍待单独授权：实际 production Worker 的密钥注入、发布/激活，以及 Mobile 真机与真实账号验收（#337/#258、#392）。禁止仅凭生产 Cloud Auth 已部署就激活狐邮，必须先验证下游切换准备。未进行真实 Gmail/Microsoft/IMAP 连接、邮件发送、部署或生产数据变更。
