# WHO-S7：第三方邮箱接入（自带 Gmail 等身份）

状态：**待启动 · 依赖 WHO-S6 与安全契约**

负责人：待指派

执行仓库：`uichat-mira/who-you`

设计依据：[`docs/product-design.md`](../product-design.md) v1 §6、[`docs/engineering/FOUNDATION.md`](../engineering/FOUNDATION.md)、仓库 `AGENTS.md`（provider OAuth 与凭据必须先有安全契约）。

## 背景

当前只有一种身份：自有域地址，且 `mailboxes.UNIQUE (account_id)` 限定「一账号一地址」。发信只有 Resend / Cloudflare Email Service 两个适配器，收信只有 Cloudflare Email Routing 推送。仓库里没有任何 provider 凭据表，也没有 SMTP / IMAP / OAuth 客户端——`FOUNDATION.md` 明确写着未开通 provider OAuth 与 mailbox credential。

用户要求在同一产品里并存两种模型：自有域邮箱（WHO-S6）与第三方邮箱（用户自带 Gmail 等）。本卡只解决第三方身份的接入契约，不改自有域路径。

## Goal

1. 一个 Cloud 账号可持有 N 个邮箱身份：1 个自有域地址 + M 个第三方身份。
2. 第三方凭据加密托管，可撤销、可轮换，审计可查且不含明文。
3. 至少一个 provider 端到端可用（建议 Gmail OAuth），**发信与收信同步都在首期**。
4. 失败与滥用都有明确闸门，且不改变自有域路径的行为。

## In Scope

按可独立验收的顺序分片：

- **S7a 数据模型**：`mailboxes` 增加 `kind`（`own_domain` / `third_party`）与 provider 归属；`UNIQUE (account_id)` 放宽为 `UNIQUE (account_id, address)`，自有域地址仍由 S6 保证唯一；新增迁移 0006 与回填策略。
- **S7b 凭据托管**：每用户 DEK + Worker secret 作为 KEK（或外部 KMS）加密存储；只落密文与元数据（provider、scope、过期时间、状态）；撤销与删除路径；审计事件只记 id/reason。
- **S7c 首个 provider（Gmail）发信**：OAuth 授权码换 refresh token，发信走 Gmail HTTP API（不使用 SMTP 密码）；scope 最小化；token 失效、授权被撤的固定失败码。
- **S7d 统一出站端口**：`MailSender` 按邮箱身份选择 provider，现有 Resend / `send_email` 路径不变；`send_receipts` 记录实际 provider。
- **S7e 第三方收信同步（首期范围）**：Gmail API `users.messages.list/get` 增量拉取，游标用 `historyId` 并处理其过期回退；按 RFC `Message-ID` 去重，复用现有 thread/地址/正文/附件模型入库；与自有域收信共用配额、保留与审计；同步不得回写已读状态到 provider。

## Out of Scope

- 任意 SMTP/IMAP 服务器的手动配置（需单独威胁建模：明文密码、STARTTLS、被当开放中继）。
- 日历、联系人、规则引擎、邮件迁移。
- 把第三方邮箱的信「转发到自有域」作为兜底。
- 客户端 UI。

## 验收证据

1. 同一账号可同时持有自有域地址与一个 Gmail 身份，列表能区分且互不覆盖。
2. 凭据在 D1/R2 中为密文；日志、审计、错误消息、测试快照中无 token、密码、refresh token。
3. Gmail 发信端到端成功一次，并产生既有 `send_receipts` 行（含 provider 与 provider_message_id）。
4. 撤销授权后发信返回固定失败码，不重试、不落 receipt、不再调用 provider。
5. Gmail 收信同步：真实拉取至少一封邮件入库，正文/附件/线程与自有域邮件同构；重复同步不产生重复行。
6. `historyId` 过期回退到全量扫描时仍幂等，不重复入库、不丢已入库数据。
7. 自有域收信与发信回归不变（现有 integration 用例全绿）。

## 依赖与阻塞

- WHO-S6 完成账号 ↔ 地址映射，否则第三方身份没有可归属的所有者。
- 需要先有一份凭据托管与 provider OAuth 的安全契约（仓库 `AGENTS.md` 的硬要求），否则不得进入实现。
- Google OAuth 客户端注册、同意屏与最小 scope 评审。
- 现有 `SendGate` / `AbuseMonitor` 的阈值是否按 provider 区分。
- 现有 `triggers.scheduled` 只有每天一次（`17 3 * * *`）；首期收信同步需要更高频的触发（Cron / Queue / Gmail push），属于配置变更，需先定频率与成本。

## 待决

1. 第三方邮件正文是否进入 D1/R2：全量入库（统一搜索与保留）还是只缓存最近窗口；影响保留策略与隐私面。
2. 凭据加密方案：Worker secret 作 KEK + 每用户 DEK，还是外部 KMS；轮换时如何重加密。
3. provider 白名单：仅 Gmail / Microsoft，还是允许用户填任意 IMAP/SMTP。
4. 第三方发信的滥用阈值、暂停与用户可见提示如何复用现有 deliverability 机制。
5. 同步触发与回填：Cron 频率、首次回填范围（全部 / 最近 N 天 / 最近 N 封）、失败重试上限。
