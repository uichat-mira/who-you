# Who You 任务卡索引（v1 / S1–S5）

状态：**设计提案配套任务卡，未开工、未创建 GitHub Issue。**

产品边界的唯一来源是 [`docs/product-design.md`](../product-design.md) v1（当前在分支 `docs/who-you-product-design`，PR 待提交）。本目录只做任务拆分与验收契约，不复制产品决策。

## 现状

- **阶段 0 已完成**：WHO-001 / WHO-002 地基（Workers + TypeScript、单一 `/mcp`、Cloud Auth JWKS、`whoyou_whoami`），已合入 `dev`（`c99a4a7`）。
- 阶段 0 不作为任务卡重新打开；S1–S5 全部建立在它之上。
- 仓库当前没有任何 WHO 任务卡文件，也没有对应 GitHub Issue；本目录是 v1 的第一套卡。
- `WHO` 语义前缀尚未在 Organization 注册。在注册前，`WHO-S1…WHO-S5` 只是仓库内文档编号，不等于已批准的 work-item 编号。

## 卡片

| ID | 任务 | 状态 | 依赖 |
|---|---|---|---|
| [WHO-S1](WHO-S1-inbound-read.md) | 只收：域名接入、地址分配、入站落库、MCP 读工具 | 待核实 P0 后开工 | 阶段 0 |
| [WHO-S2](WHO-S2-draft-confirm-send.md) | 草稿 + 用户确认 + relay 发送 + 回执 | 待 S1、P0、确认契约裁决 | S1 |
| [WHO-S3](WHO-S3-state-search-retention.md) | 状态、附件、检索质量、保留与导出/删除 | 待 S1 | S1 |
| [WHO-S4](WHO-S4-deliverability-abuse.md) | 退信 / 投诉闭环、抑制、反滥用、域声誉 | 待 S2 | S2 |
| [WHO-S5](WHO-S5-client-integration.md) | Desktop / Mobile 接线与确认 UI、与现有邮件中心关系 | 待 S2–S4 | S2–S4 |

## 旧阶段到新卡的映射

| 旧阶段 | 内容 | 新卡 |
|---|---|---|
| 阶段 0 | 运行时骨架、MCP 门禁、whoami | 已完成，不再分卡 |
| 阶段 1 | 域名与地址模型 | S1 |
| 阶段 2 | 入站、解析、D1/R2 | S1 |
| 阶段 3 | 读工具 | S1 |
| 阶段 4 | 草稿与确认发送 | S2 |
| 阶段 5 | 运维治理 | S3 + S4 + S5 |

## 共同规则

1. 先读 `uichat-mira/.github@main/AGENTS.md`、本仓库 `AGENTS.md`、`docs/product-design.md` v1 与对应卡，再动手。
2. 一张卡一个 PR，目标 `dev`；不把多阶段合并成一个大 PR。
3. 所有验收证据必须绑定 commit SHA；没有执行过的检查不得写成通过。
4. 真实 DNS、Email Routing、D1/R2、relay、发送测试都需要独立授权；构建通过不等于可以动生产资源。
5. 邮件地址、主题、正文、附件、认证结果不得进入日志、PR 描述、AI prompt、测试快照或 fixture。
6. P0 核实项（v1 §10）未闭环时，相关卡保持阻塞，不以「按经验应该是」推进。
