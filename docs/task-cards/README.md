# Who You · S1–S7 历史任务卡索引

> **档案索引，不是当前进度板或产品决定书。** 原始卡片诞生于早期 v1 设计阶段，其中“未开工”“未部署”“Cloud Auth 未接通”等原始状态及 `v1 §x` 已不代表 2026-11-21 现状。当前产品边界请只读 [docs/product-design.md](../product-design.md)；实际代码、运行配置、部署与 GitHub Issue 负责各自的事实。

| 历史卡片 | 当时分片的目标 | 如何判断现状 |
| --- | --- | --- |
| [S1](WHO-S1-inbound-read.md) | 自有域入站、D1/R2、MCP 读 | `src/mail/inbound.ts`、`src/mcp/mail.ts`、真实 Email Routing |
| [S2](WHO-S2-draft-confirm-send.md) | 草稿、逐封确认、外发回执 | `src/mcp/drafts.ts`、`src/mail/` 和真实发送凭据/回执 |
| [S3](WHO-S3-state-search-retention.md) | 邮件状态、附件、搜索、删除 | `src/mcp/mail.ts`、迁移、存储配置 |
| [S4](WHO-S4-deliverability-abuse.md) | 投递声誉、退信、反滥用 | `src/mail/deliverability.ts`、相关代码与真实 webhook |
| [S5](WHO-S5-client-integration.md) | Mira 客户端消费、确认 UI | 各 Mira 客户端源码与其独立 Issue/PR；不是 Who You 网页已实现的证据 |
| [S6](WHO-S6-own-domain-username-mailbox.md) | Cloud Auth 自有域地址身份映射 | 当前 Cloud Auth 与 `src/mcp/identities.ts`，并核对邮件域名运行环境 |
| [S7](WHO-S7-third-party-mailbox.md) | Gmail/Microsoft/IMAP-SMTP、安全托管 | `src/mail/`、[凭据安全契约](../engineering/CREDENTIAL-SECURITY-CONTRACT.md)、provider 配置及 T4/T5 |

S8 的当前工程合同位于 [GitHub Issue #27](https://github.com/uichat-mira/who-you/issues/27)，其 `mail.tzt2026.xyz` MCP-only 边界不等于 `who-you.tomz.io` Web 入口。

## 适用规则

1. 各卡原始目标、范围、依赖、验收条款保留作历史证据；它们**不代表当前开发状态**，未创建或未更新的 GitHub Issue 不可由此推定已经验收/关闭。
2. 旧卡引用的 `docs/product-design.md v1 §...` 原文不在当前 `dev/prod`；不要将新版同名的产品边界文档虚构成 v1 原始章节。原版本若需恢复必须从真实历史 PR/分支检索。
3. 若开始新的 UI 工作：Cloud Auth「关联服务」只有身份关联入口；邮箱连接、凭据状态与解绑属于狐邮；Mira 只消费 MCP。具体任务必须有被授权的 Issue/实现合同。
4. 真实收信、发信、邮箱服务商凭据、DNS、Email Routing、Cron 都需独立运行证据，不得以 `npm run check` 替代。
5. 按组织工作流推进；不要在仓库 docs 复制 GitHub Issue 的状态/优先级/结果台账。
