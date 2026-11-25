# Mira ID 通用服务注册 v0（OPS-048）

本文定义 **Who You / 狐邮** 作为首个真实云 MCP 服务接入 Mira ID 服务注册表时的服务侧声明、可信注册操作、账号关联、授权与可用性语义，以及交给 Mobile（A2）做最终消费迁移的接口。

- A1 合同：[`cloud-auth/docs/service-registry-v0.md`](https://github.com/uichat-mira/cloud-auth/blob/f131277edf0552b541f6e6d7527f225d8b1af2de/docs/service-registry-v0.md)
- A1 实现：cloud-auth #198（提交 `f131277`）
- 本卡不新增注册 HTTP API、共享密钥、设备/账号体系、第二套登录、工具列表或存储模型。

## 1. 服务身份与注册声明

唯一可交给 Cloud Auth 可信管理员 CLI 的声明是：

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

注册**不是服务启用、不是模型开关、不是权限扩大**：它只把狐邮的既有 `mira:who-you` / `whoyou.read` 授权关联到明确账号。`whoyou.mail.write`、`whoyou.mail.send`、草稿确认、邮箱链接确认等仍走原有独立授权链。

## 2. 可信注册与撤销操作

只使用 Cloud Auth 的可信管理员 CLI。操作者在 cloud-auth 仓库中执行，实际账号由操作者显式给出；本仓库不记录账号、不调用生产数据库、不保存任何令牌。

```bash
# 在 cloud-auth checkout（A1 合同提交）中执行
cd /path/to/cloud-auth

# 首次注册：expectedRevision 省略/0；输入为上面的声明文件
pnpm run admin service-register <accountId> \
  < /path/to/who-you/config/mira-service-registry/who-you.json

# 修改端点/协议等声明时，必须带当前 revision
pnpm run admin service-register <accountId> <currentRevision> \
  < /path/to/who-you/config/mira-service-registry/who-you.json

# 撤销：停止该账号后续的 registry 签发，revision 递增并保留 tombstone
pnpm run admin service-revoke <accountId> who-you <currentRevision>
```

约束（来自 A1）：

- 账号必须已允许且未被禁用；显式账号 ID 不能被请求体或客户端替换。
- 完全相同的活动注册是幂等；变更或重新授权需要当前 revision；陈旧 revision 失败。
- 撤销后同一 `serviceId` 不能改成其他 project/audience 复用。
- 端点所有权由可信操作者验证；端点或显示名中不得嵌入秘密。
- 不存在公开自助注册 API；账号会话不能修改注册账本。

操作后可用已认证 Cloud Session 读取通用目录核对：

```http
GET /v1/services
Authorization: Bearer <Cloud Session>
```

狐邮条目应返回上述 declaration 与 revision。目录只返回活动注册，不返回 JWT、账号秘密或业务数据。

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

`/mcp` 继续使用现有的 Cloud Auth JWKS 验签、精确 issuer/audience、`EdDSA`、`exp`、非空 `sub` 与 `consumer_id` 校验；不新增本地信任、共享密钥或匿名回退。错误 audience（包括通用 `mira:service:who-you`、其他服务 audience、OAuth discovery URL 冒充 JWT issuer）、错误签名、过期、缺失 consumer 或跨账号身份均返回不披露内容的 401；缺少 `whoyou.read` 返回 403。

`whoyou_whoami` 是目录/票据绑定后的身份核对点：`accountId` 与 `consumerId` 必须都等于目录所属账号，`scopes` 必须精确为 `["whoyou.read"]`。任何不一致都应在客户端停止执行，而不是继续调用工具。

## 4. 账号关联、当前授权与可用性

- **账号关联**：注册以明确账号为边界。没有注册、跨账号、错误 revision 或已撤销条目不会产生票据；服务端不按工具参数选择账号。
- **当前授权**：`GET /v1/services` 的条目 revision + 短期票据共同构成一个授权绑定。账号/设备/会话撤销、登出或账号切换后不得复用旧绑定。
- **可用性**：目录可用性由 Cloud Auth 决定；`/mcp` 可用性由狐邮部署决定。二者不是同一个健康状态，目录返回条目不代表邮箱已接入、provider 可用、同步完成或发信已启用。
- **其他服务**：每个 `serviceId` 的注册、revision、撤销与票据彼此独立；狐邮目录项或 `/mcp` 故障不改变其他服务的注册。通用客户端应按服务隔离错误，不得用一个服务的失败关闭整个目录。
- **业务邮箱关联**：仍由既有邮箱身份生命周期决定。有狐邮票据但没有邮箱/身份时，只读工具返回 `mailbox_not_provisioned`、空 identity 列表或空搜索结果，不会借用其他账号邮件。

## 5. 撤销、离线票据与旧签发路径

A1 语义必须由消费端正确理解：

- 撤销会移除目录条目并阻止**后续 registry 签发**；随后用旧 revision 或新 revision 请求该服务均得到 `404 SERVICE_REGISTRATION_NOT_FOUND`。
- 已经签发的离线 bearer 在 `exp` 前仍可能被资源端接受（加有限的验证时钟容差）；资源端没有在线撤销查询。客户端一旦观察到撤销、登出、账号/设备切换或未知 revision，必须立即丢弃缓存绑定。
- 旧的独立 canonical 签发路径不由 registry 撤销；本卡的注册/撤销只作用于 registry-mediated issuance。不得把 registry 撤销描述成即时吊销已持有票据，也不得据此宣称旧路径已经退休。
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

## 7. 验证与证据边界

已执行：

- `bash scripts/check.sh`：真实 frozen-lockfile 安装、typecheck、lint、单元测试与 workerd 集成测试。
- `tests/service-registration.test.mjs`：声明文件与代码一致；A1 字段/端点/audience/scope 约束；错误端点、额外权限、错误 audience 被拒绝；声明的协议版本与 Worker manifest 有兼容证据。
- `tests/mcp-service-registry.test.mjs`：部署入口 `dist/worker.mjs` 通过远程 JWKS 验证真实 EdDSA 签名票据；注册账号执行真实只读 MCP、能力 Resource、邮箱读取与分页；跨账号隔离；无业务邮箱关联；错误 audience、其他服务票据、错误/欺骗账号、伪造签名、过期与缺失 consumer 拒绝；撤销后停止续签、已签发离线票据在 `exp` 前仍可用，其他服务注册不受影响。
- 既有 `mcp-auth` / `mcp-manifest` / `mcp-workerd` / `mcp-remote-jwks` 继续覆盖 issuer/audience/exp/scope 门禁、只读/写/发/删分类和旧协议客户端。

明确未执行、也不由本卡宣称：

- 未在真实 Cloud Auth 实例执行管理员注册/撤销，未修改任何真实账号、生产数据库、配置、密钥或邮箱。
- `tests/mcp-service-registry.test.mjs` 中的目录/签发是一个实现 A1 语义的**测试替身**；JWT 签名与 Worker/JWKS 验证是真实的，但它不是 Cloud Auth 联调证据。
- 真实测试账号的注册/撤权/重绑、真实 Gmail/Microsoft/IMAP 邮箱、Mobile 端到端消费与旧入口退休属于维持者、Mobile #337/#258 / A2 的 T4 工作。
- 未部署生产、未晋级环境、未发送邮件。
