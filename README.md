# Who You · 狐邮 / 忽悠

Who You 是独立的云端邮件服务和 **MCP Server**。Mira Desktop / Mobile / OMM 是其 MCP 消费端；Cloud Auth 是云身份、设备会话和服务凭证提供者。

**唯一当前产品定位与接入 UI 所属位置**：[docs/product-design.md](docs/product-design.md)。工程代码及线上部署拥有各自的事实权威，历史任务卡不能代替现状。

## 历史部署事实（2026-11-21 核对；不是当前 dev 合同）

- **已部署的只读认证预览**：`https://who-you.tomz.io/`，使用 Cloud Auth `who-you-web` 登录，登录后 `/account` 展示账号与 `whoyou.read` 的 MCP 身份验证。旧 `workers.dev` 网页登录入口被拒绝。
- **服务端 MCP**：`/mcp`（需要 Cloud Auth `mira:who-you` 票据）及 `/.well-known/oauth-protected-resource/mcp`。Web 登录界面不改变 MCP Server 定位。
- **预览部署约束**：使用专门的 Worker `who-you-tomz-preview`、隔离 D1/R2 和加密 Web 会话 Secret；未启用邮件域名、真实提供商密钥、收发信或定时 Cron。这个部署不是完整邮件产品上线。
- **代码已包含但不等于预览环境启用**：自有域收信、草稿/发信确认、邮件状态、Gmail / Microsoft / IMAP-SMTP 集成及定时同步路径。必须核对各业务部署的凭据、路由、密钥、Cron 与真实端到端证据，不能只看源码就报上线。
- **尚未提供的人类 UI**：`/account/mailboxes` 邮箱接入管理页，Cloud Auth「关联服务」里的狐邮入口和 Mira 各客户端的完整消费 UI。参见 [产品边界](docs/product-design.md#2-ui-入口归属已裁决的位置不能当作已实现)。

当前生产来源仍遵守 `feat/* → dev → test → prod`；`prod` 源码、业务环境和 `who-you-tomz-preview` 的独立部署不是一回事。当前代码具有 `cloudflare.config.ts` 里的开发/另一环境绑定（包括可能的 MAIL_DOMAIN/Cron），**不能把它们误写成预览 Worker 的现时配置**。

## 当前 dev 接入合同

仅接受 V1 应用实例登记、应用专属 OAuth 会话及实例级 MCP 短票；旧 trusted-app、management token 与 V0 取票路径已移除。MCP 仅支持 2026-07-28，声明只读邮件 scope。网页邮箱管理不经 MCP 代理；现有业务服务及账号隔离不变。该源码变化不是部署声明。

## 工程入口

- [组织规则](https://github.com/uichat-mira/.github/blob/main/AGENTS.md) 与本仓库 [AGENTS.md](AGENTS.md)
- [工程历史基线 / 代码分片说明](docs/engineering/FOUNDATION.md)（含早期时间截面，不作为现时部署清单）
- [生产发布与回滚](docs/engineering/production-deployment.md)
- [现有凭据安全契约](docs/engineering/CREDENTIAL-SECURITY-CONTRACT.md)
- [Mira ID 应用实例接入 V1（OPS-048）](docs/engineering/mira-application-v1.md)
- [Gmail 服务端定时增量同步与回滚](docs/engineering/gmail-scheduled-sync.md)
- [S1–S7 历史任务卡](docs/task-cards/README.md) / [WHO-S8 Issue](https://github.com/uichat-mira/who-you/issues/27)
- [Mira ID 应用 OAuth V1](https://github.com/uichat-mira/cloud-auth/blob/dev/docs/application-oauth-v1.md)

运行：Node.js 24，锁文件确定性安装，`bash scripts/check.sh` 或 `npm run check`。测试用 Miniflare/workerd 验证 Worker 行为，**不能代替**真实用户邮箱接入、收发信或生产验收。

## 实现定位

- `src/index.ts`：HTTP、邮件事件与定时器入口。
- `src/web/cloud-auth.ts`：人类 Web 登录、应用 OAuth 回调、加密应用会话及独立邮箱业务操作。
- `src/mcp/`：MCP 服务、认证和工具注册。
- `src/mail/`、`migrations/`：邮箱业务实现与数据模型。
- `cloudflare.config.ts`：仓库默认部署配置；核对实际 Worker API 绑定才能判断某一运行环境的能力。
