# 云 MCP 服务能力声明 v1（OPS-046）

本文定义 **Who You / 狐邮** 通过标准 MCP 暴露的可选、只读、版本化「服务 → 能力 → 工具」声明。它是机器可读的发现数据，不是第二套工具注册表，也不改变现有 MCP 工具协议、Schema、执行链、审批或作用域。

- 服务端实现：`src/mcp/service-capabilities.ts`，在 `src/mcp/server.ts` 以 MCP Resource 注册。
- 资源 URI：`mira://service/who-you/capabilities`
- 资源名称：`who-you-service-capabilities`
- MIME：`application/json`
- 读取方式：已认证的 `/mcp` 上执行标准 `resources/list` → `resources/read`
- 不提供：裸露公共 HTTP 目录、专有 `capabilities/list` RPC、实验性 MCP Groups 依赖

## 1. 边界与权威

| 事项 | 权威来源 |
| --- | --- |
| 工具名称、`inputSchema`、输出、注解 | 当前 `tools/list` 与已注册 MCP Tool |
| 能否执行、需要哪些 scope、是否需要确认凭据 | 现有 bearer gate、tool handler 与 Cloud Auth 凭据 |
| 服务/能力分组、稳定能力 ID、读写分类 | 本资源中的 v1 manifest |
| 账号、邮箱、邮件、同步进度、provider 是否可用 | 真实工具响应；**不在 manifest 中** |

`/mcp` 的 Bearer/OAuth 保护不变。读取本资源仍要求正常的 `whoyou.read` 级访问；manifest 不会授予或扩大任何 scope。没有凭据、伪造凭据、错误 scope 或跨账号身份都不能通过读取资源绕过工具权限。

## 2. JSON 结构

字段集合在 v1 中封闭（服务端用严格 schema 校验）。示例形状：

```json
{
  "schema": "mira.service-capabilities/v1",
  "version": "1.0.0",
  "service": {
    "id": "who-you",
    "name": "Who You",
    "description": "Versioned, read-only semantic capability declaration ...",
    "documentation": "https://github.com/uichat-mira/who-you/blob/dev/docs/engineering/cloud-mcp-service-capabilities-v1.md",
    "mcp": {
      "serverName": "who-you",
      "serverVersion": "0.1.0-who-002",
      "sdk": "@modelcontextprotocol/server@2.4.0",
      "protocolVersions": ["2026-07-28"]
    }
  },
  "capabilities": [
    {
      "id": "who-you.identity",
      "title": "Caller identity",
      "description": "Reports the verified Cloud Auth account ...",
      "access": "read",
      "requiredScopes": ["whoyou.read"],
      "confirmation": "none",
      "tools": ["whoyou_whoami"]
    }
  ],
  "fallback": {
    "unknownSchema": "Consumers that do not understand this schema or version must ignore this resource ...",
    "unclassifiedTools": "Consumers must keep every tools/list entry visible ..."
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `schema` | 结构契约 ID；当前固定 `mira.service-capabilities/v1` |
| `version` | manifest 内容版本，语义化版本 |
| `service.id` | 稳定服务 ID，当前 `who-you` |
| `service.name` | 人类可读服务名 |
| `service.description` | 服务用途；不含账号状态或“provider ready”声明 |
| `service.documentation` | 本文链接 |
| `service.mcp.serverName` / `serverVersion` | 与 MCP `initialize` 的 server identity 一致 |
| `service.mcp.sdk` | 当前服务端 SDK 依赖版本 |
| `service.mcp.protocolVersions` | 仓库内有兼容性证据的 MCP 协议修订 |
| `capabilities[].id` | 稳定能力 ID，前缀 `who-you.` |
| `capabilities[].title` / `description` | 供通用消费端披露的短描述 |
| `capabilities[].access` | `read` / `write` / `send` / `destructive`，一个能力只属于一类 |
| `capabilities[].requiredScopes` | 调用该能力仍至少需要的 bearer scope；不是已授予状态 |
| `capabilities[].confirmation` | `none` / `confirm-argument` / `identity-credential` / `draft-credential`；`confirm-argument` 仅表示 Tool 要求显式确认参数，**不证明已经得到真人批准** |
| `capabilities[].tools` | 当前真实注册的工具名称；不复制工具 Schema |
| `fallback.unknownSchema` | 消费端遇到未知结构时的降级行为 |
| `fallback.unclassifiedTools` | 对未列入能力的真实工具的兜底行为 |

## 3. 当前能力与工具映射

`who-you` 当前发布 17 个能力，覆盖 30 个已注册工具。工具名来自代码中的既有常量；服务端启动时验证分组中不存在重复工具或重复能力 ID；**真实注册项完整性**由 workerd 契约测试与实际 `tools/list` 双向比较，不靠手抄一份工具全集。

| 能力 ID | access | confirmation | 工具 |
| --- | --- | --- | --- |
| `who-you.identity` | read | none | `whoyou_whoami` |
| `who-you.mailbox.read` | read | none | `whoyou_mailbox_get`, `whoyou_mailbox_list` |
| `who-you.mailbox.provision` | write | none | `whoyou_mailbox_provision` |
| `who-you.mailbox.link` | write | identity-credential | `whoyou_mailbox_link` |
| `who-you.mailbox.unlink` | destructive | identity-credential | `whoyou_mailbox_unlink` |
| `who-you.mailbox.sync` | write | none | `whoyou_mailbox_sync` |
| `who-you.mail.read` | read | none | `whoyou_mail_search`, `whoyou_mail_thread_get`, `whoyou_mail_message_get`, `whoyou_mail_attachment_get` |
| `who-you.mail.flags` | write | none | `whoyou_mail_flag_set` |
| `who-you.draft.read` | read | none | `whoyou_mail_draft_get`, `whoyou_mail_draft_list` |
| `who-you.draft.write` | write | none | `whoyou_mail_draft_create`, `whoyou_mail_draft_update` |
| `who-you.draft.discard` | destructive | none | `whoyou_mail_draft_discard` |
| `who-you.mail.send` | send | draft-credential | `whoyou_mail_send` |
| `who-you.job.read` | read | none | `whoyou_job_list`, `whoyou_job_get` |
| `who-you.job.workflow` | write | none | `whoyou_job_create`, `whoyou_job_stage_update`, `whoyou_job_annotate`, `whoyou_job_annotation_resolve`, `whoyou_job_stage_accept`, `whoyou_job_pause`, `whoyou_job_resume` |
| `who-you.mail.export` | write | none | `whoyou_mail_export` |
| `who-you.mail.message-delete` | destructive | none | `whoyou_mail_message_delete` |
| `who-you.mailbox.delete` | destructive | confirm-argument | `whoyou_mail_mailbox_delete` |

说明：

- `read` 能力只包含 `readOnlyHint: true` 的工具；查询本身不会因为出现在能力清单中而获得写权限。
- `write` 仍由原工具 handler 校验 `whoyou.mail.write`；`who-you.mail.export` 只读账号数据但会创建导出记录与签名链接，因此归类为 `write`，其实际 bearer 要求以工具 handler 为准。
- `send` 必须使用 Cloud Auth 签发的、绑定 draft 版本与 `contentHash` 的一次性确认凭据；manifest 不构成发送授权。
- `destructive` 包括清理/删除操作。`who-you.mailbox.delete` 要求传入 `confirm: true` 参数；参数本身不能代替消费端所需的真实用户批准；永久删除单封邮件只接受已进入 trash 的邮件。工具 Schema 仍是权威。
- manifest 不声明 provider 已连接、数据库已就绪、同步已完成或权限已获批。这些只能从真实工具响应与运行证据得知。

## 4. 消费与降级

**三级只描述信息组织关系，绝非强制的三阶段状态机或固定的发现/模型调用次数。** 已知工具、Schema 与授权仍有效时可直接调用；需要探索时可按任务决定发现顺序、跳过层级、继续同能力内调用、跨能力/跨服务工作。缓存失效与授权撤销须在真实执行入口重验。下面仅演示**其中一种**完整发现与核对方式，不应被 Mobile/OMM 复制为每次请求的硬编码循环。

一次可行的消费流程：

```ts
const { resources } = await client.listResources();
const resource = resources.find(
  (entry) => entry.uri === "mira://service/who-you/capabilities",
);
if (!resource) return useToolsListOnly();

const { contents } = await client.readResource({
  uri: "mira://service/who-you/capabilities",
});
const manifest = JSON.parse(contents[0].text);
if (manifest.schema !== "mira.service-capabilities/v1") {
  // 结构不认识：忽略 manifest，退回 tools/list。
  return useToolsListOnly();
}

const { tools } = await client.listTools();
const registered = new Set(tools.map((tool) => tool.name));
for (const capability of manifest.capabilities) {
  for (const name of capability.tools) {
    if (!registered.has(name)) {
      // 清单过期或不可信：该工具不按此能力披露。
      continue;
    }
  }
}
// access=read 的能力可用于发现/选择；write/send/destructive 仍须
// 走真实工具的 scope、确认与用户批准流程。
```

消费端必须遵守：

1. **没有 manifest**（旧客户端或第三方 MCP）：直接使用每个工具的 `description`、`annotations`、`inputSchema`。
2. **schema/version 不认识**：忽略整个资源，不猜测、不伪造能力分组。
3. **工具不在清单中**：保留该工具并按其真实元数据展示；不能让它“消失”。
4. **清单中的工具在 `tools/list` 中不存在**：视为清单过期/不一致，忽略该引用；不得调用或凭空创建工具。
5. **披露不等于授权**：`access`、`requiredScopes`、`confirmation` 是提示；真实 scope、审批、确认凭据与工具 handler 才是执行依据。
6. **不硬编码 Who You 工具名单**：通用消费端以 `tools/list` 为准，以 manifest 做可选分组。

## 5. 版本、缓存与失效

- `schema` 是结构契约。v1 字段集合封闭；新增/删除/重命名字段需要新的 schema 版本（例如 `.../v2`）。
- `version` 是内容版本：
  - 在相同结构内新增能力或工具、补充描述：提升 minor；
  - 删除/重命名能力或工具、改变 `access`/`confirmation` 语义：提升 major；
  - 服务端保持旧客户端可用的 `tools/list` / `tools/call` 不变。
- 资源是**静态服务描述**，对所有账号返回同一份 JSON，不包含账号、邮箱、邮件或凭据，因此不存在跨账号缓存泄露面。客户端可自行缓存；读取时仍必须先通过 `/mcp` 认证。
- 若声明与实际注册项不一致，服务端启动会拒绝分组内部重复映射；真实注册项缺失/新增通过 workerd `tools/list` 对照测试失败，消费端运行时也必须验证映射并在不一致时降级；不能凭过期清单调用工具。
- 本卡不使用实验性 MCP Groups，也不要求消费端或上游实现它。

## 6. 当前 MCP SDK / 协议兼容性

- 服务端 SDK：`@modelcontextprotocol/server@2.4.0`（与 `package.json` 对齐，单元测试校验）。
- 当前唯一协议修订：`2026-07-28`（modern stateless）；旧 initialize 协议拒绝。
- `resources/list` / `resources/read` 与 `tools/list` / `tools/call` 均走同一个 `/mcp` Streamable HTTP 入口；不新增 HTTP 能力目录。
- SDK 可能还兼容更老的 legacy 修订，但仓库没有为它们单独承诺证据；消费端按 MCP 协商结果使用标准 `resources/*` 即可。

## 7. 验证边界

已覆盖（T1/T2/T3）：

- manifest 严格 schema、固定 URI/MIME、版本和 SDK 版本对齐；
- 全部注册工具恰好分类一次，清单与真实 `tools/list` 双向一致；
- 只读与写入/发信/清理分类隔离，确认方式与 scope 提示准确；
- 真实 `@modelcontextprotocol/client` + Miniflare/workerd：`resources/list` → `resources/read` → 选择 Tool → `tools/list` / `tools/call`；
- 匿名、伪造 JWT、错误 issuer、错误 scope 的负例，以及第二个账号读取同一静态文档；
- 旧 legacy 客户端不读 manifest 时 `tools/list` / `tools/call` 行为不变。

未覆盖、也不在本卡宣称：

- 真实 Gmail/Microsoft/IMAP 账号、真实邮件内容或 provider 可用性；
- 真实生产 Cloudflare 部署、Cron、环境晋级；
- Mobile/Desktop 的 manifest 消费、Pi Core 注入或跨服务验证（由 MOB-091 B2/B3 与 Desktop B1 后续承担）。
