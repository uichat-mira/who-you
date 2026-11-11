# WHO-S6：自有域名邮箱按 Cloud Auth 用户名开通

状态：**待启动 · 依赖 Cloud Auth 可用**

负责人：待指派

执行仓库：`uichat-mira/who-you`

设计依据：[`docs/product-design.md`](../product-design.md) v1 §6、[`docs/engineering/FOUNDATION.md`](../engineering/FOUNDATION.md)。

## 背景

S1 的地址模块只定了语法与保留字，把「用户自选还是派生 local part」留成待决（见 `src/mail/address.ts` 顶部注释）。数据库当前是「一个 Cloud Account 一个地址」（`mailboxes.UNIQUE (account_id)`），收信链路已经打通，缺的是**开通**与**身份映射**：现在要人工往 D1 插入信箱才能收信。

本卡把模型定死为派生：`<Cloud Auth 用户名>@tzt2026.xyz`，并已裁决**懒开通**（首次授权调用时创建）与**派生失败时向用户索要自定义用户名**。不改收信/发信协议，只补开通路径与地址来源。

## Goal

1. Cloud Auth 用户首次进入即获得 `<用户名>@tzt2026.xyz`，可直接收信、可作为发信 `from`。
2. 用户名 → 地址的映射是确定性、幂等、可审计的：同一账号重复调用只产生一个信箱。
3. 派生出的用户名不可用时（中文、长度 <3、连续分隔符等），首次调用明确要求用户提供自定义 local part，而不是静默失败、自动加后缀或抢占他人地址。
4. 非法输入、保留字、地址冲突都有固定结果与错误码。

## In Scope

- 从 Cloud Auth 身份取稳定用户名（claim → username → local part），并复用现有 `normalizeLocalPart`：小写化、Unicode NFC、3–32 字符、`[a-z0-9]+([._-][a-z0-9]+)*`、保留字表。
- 开通时机与幂等（已裁决：懒开通）：首个已授权请求上创建；`UNIQUE (address)` 作为并发兜底，插入冲突即失败返回明确 reason，不做「加后缀重试」。
- 自定义用户名入口（已裁决）：开通工具接受可选 `localPart`；未提供且派生不可用时返回 `local_part_required`（附规则说明），由客户端提示用户输入后带 `localPart` 重试；提供后仍走同一套 `normalizeLocalPart` 与保留字校验，冲突返回 `address_taken`。
- 账号 ↔ 信箱的读取路径（列表、当前地址、状态），供 `whoyou_*` 工具与后续客户端使用。
- 审计：开通/失败写入 `mail_audit_log`，只记 id 与 reason，不写地址明文。
- 与现有 `mailboxes` 约束的兼容：本卡保持「一账号一自有域地址」。

## Out of Scope

- 第三方邮箱身份（见 WHO-S7）。
- 用户自选、修改 local part，别名，多自有域地址。
- 域名切换（仍是单一 `MAIL_DOMAIN`）。
- 客户端 UI 与地址展示。
- 历史手工信箱的迁移。

## 验收证据

1. 新账号首次调用得到 `<用户名>@tzt2026.xyz`；重复调用返回同一信箱，`mailboxes` 不新增行。
2. 派生用户名不可用且未带 `localPart` 时返回 `local_part_required`，库中无信箱行；带合法 `localPart` 重试后创建成功；带已被占用的名字返回 `address_taken`。
3. 非法（长度、字符）、保留字、大小写/点号变体冲突三类输入均返回固定错误码，且库中无半成品行。
4. 两个不同账号即使用户名仅大小写或点号不同，也不会落到同一地址。
5. 该地址能从外部真实收到一封邮件，并能经现有 Resend 适配器成功发出一封（端到端各一次）。
6. 日志、审计、错误消息中不含地址明文与正文。

## 依赖与阻塞

- **硬阻塞**：Cloud Auth 未部署，`/mcp` 仍返回 `503 mcp_not_configured`（缺 `MCP_RESOURCE_URL`、`CLOUD_AUTH_ISSUER`、`CLOUD_AUTH_JWKS_URL`、`MCP_AUDIENCE`）。没有可靠 username claim，本卡无法端到端验证。
- 用户名可变性由 Cloud Auth 决定，本卡依赖该结论。
- 「提示用户输入自定义用户名」需要在客户端（S5 合同）落地为可见交互；MCP 侧只能提供错误码与规则文案。
- 懒开通意味着开通前的窗口内，外部来信会按 `550 5.1.1 no such user` 退回，这是已接受的行为，不在本卡补救。
- S1–S5 的收信/发信契约不变，回归以现有 38 个 integration 用例为准。

## 待决

1. 用户名变更后的语义：地址不可变并把旧地址保留为收信别名 / 跟随改名（旧信仍在原 mailbox）/ 禁止改。
2. 用户自定义的 local part 是一次性锁定还是允许修改；若允许，旧地址如何处理。
3. 提示交互形态：仅返回 `local_part_required` + 规则文案，还是使用 MCP elicitation 直接向用户索取（取决于客户端支持）。
4. 每用户默认配额与发信限流的取值是否沿用当前 `DEFAULT_MAIL_LIMITS`。
