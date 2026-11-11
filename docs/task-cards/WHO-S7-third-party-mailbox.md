# WHO-S7：第三方邮箱接入（OAuth 与自填 IMAP/SMTP）

状态：**待启动 · 依赖 WHO-S6 与安全契约**

负责人：待指派

执行仓库：`uichat-mira/who-you`

设计依据：[`docs/product-design.md`](../product-design.md) v1 §6、[`docs/engineering/FOUNDATION.md`](../engineering/FOUNDATION.md)、仓库 `AGENTS.md`（provider OAuth 与 mailbox credential 必须先有安全契约）。

## 背景

当前只有一种身份：自有域地址，且 `mailboxes.UNIQUE (account_id)` 限定「一账号一地址」。发信只有 Resend / Cloudflare Email Service 两个适配器，收信只有 Cloudflare Email Routing 推送。仓库里没有任何 provider 凭据表，也没有 SMTP / IMAP / OAuth 客户端——`FOUNDATION.md` 明确写着未开通 provider OAuth 与 mailbox credential。

用户要求在同一产品里并存两种模型：自有域邮箱（WHO-S6）与第三方邮箱。第三方分两类：**OAuth 型**（Gmail / Microsoft，走 HTTP API）与**自填服务器型**（用户自己填 IMAP/SMTP 主机、端口与密码）。本卡只解决第三方身份的接入契约，不改自有域路径。

自填 IMAP/SMTP 是攻击面最大的一类：它让用户决定 Worker 的出站连接目标与端口，因此本卡在 S7b 之外单独给出 SSRF / 开放中继的威胁模型（S7f），该部分未评审通过前不得实现。

## 已裁决

1. 正文入库：**全量入库**，与自有域同构（R2 存 raw/text/html/附件，D1 存元数据），用 `quota_bytes` 硬限 + 到 90% 暂停回填。
2. provider 范围：**Gmail、Microsoft Graph，以及用户自填的任意 IMAP/SMTP 服务器**。
3. 滥用阈值：复用 `SendGate` / `AbuseMonitor`，但**按 kind 区分**——自有域沿用现值，第三方按身份约 100 封/天。
4. 同步频率与回填：Cron **每 5 分钟**增量；回填最近 30 天或 500 封；每轮每身份最多 20 封；失败重试 3 次。
5. KEK 轮换：**90 天一轮，旧版本并存 30 天**；泄漏事件走强制轮换 runbook。
6. 凭据加密：AES-256-GCM 信封加密，每账号 DEK + Worker secret `MAIL_CREDENTIAL_KEK`；只持久化长期凭据；AAD 绑定 `account_id|provider|mailbox_id|key_version`；撤销用 crypto-shredding。

## Goal

1. 一个 Cloud 账号可持有 N 个邮箱身份：1 个自有域地址 + M 个第三方身份（OAuth 或自填服务器）。
2. 第三方凭据加密托管，可撤销、可轮换，审计可查且不含明文。
3. 三类 provider 端到端可用（Gmail、Microsoft、自填 IMAP/SMTP），**发信与收信同步都在首期**。
4. 失败与滥用都有明确闸门；自填服务器不得让 Worker 变成 SSRF 跳板或开放中继。
5. 不改变自有域路径的行为。

## In Scope

按可独立验收的顺序分片：

- **S7a 数据模型**：`mailboxes` 增加 `kind`（`own_domain` / `third_party`）与 `provider`（`gmail` / `microsoft` / `imap_smtp`）；`UNIQUE (account_id)` 放宽为 `UNIQUE (account_id, address)`，自有域地址仍由 S6 保证唯一；新增迁移 0006 与回填策略。
- **S7b 凭据托管（已裁决：信封加密，不引入外部 KMS）**：
  - AES-256-GCM + WebCrypto；每账号随机 DEK（32 字节），用 Worker secret `MAIL_CREDENTIAL_KEK`（32 字节，base64）包裹后存 D1。
  - OAuth 型只持久化 refresh token；access token 每次按需换取、仅驻内存，不落库、不缓存到 R2/KV。自填型持久化用户密码（明文密码不可撤销，只能由用户在 provider 侧改密，此风险见 S7f）。
  - 密文 AAD 绑定 `account_id|provider|mailbox_id|key_version`，防止密文被平移到其他账号或身份上解密。
  - `provider_credentials` 存 `key_id`、`wrapped_dek`、`ciphertext`、`nonce`、`key_version`、`provider`、`scope`、`status` 与时间戳；不存任何明文或「先加密再解不开」的兜底值。
  - 撤销 = 删除 wrapped DEK 与密文（crypto-shredding）；轮换 = 新 KEK 版本与旧版并存，Cron 惰性重包裹，30 天后下线旧版本。
  - 解密失败一律 fail-closed：返回固定码、停用该身份，不重试、不降级、不回退明文。
  - 不选 Cloudflare Secrets Store（账户级、非按用户）；不选外部 KMS（首期引入跨云依赖与每次解密的额外延迟，收益不足以抵消复杂度）。
- **S7c OAuth provider（Gmail / Microsoft）**：授权码换 refresh token，发信走 HTTP API；scope 最小化；token 失效、授权被撤的固定失败码。
- **S7d 统一出站端口**：`MailSender` 按邮箱身份选择 provider，现有 Resend / `send_email` 路径不变；`send_receipts` 记录实际 provider。
- **S7e 收信同步**：
  - OAuth 型：Gmail 用 `users.messages.list/get` + `historyId` 游标；Microsoft 用 Graph delta 查询。
  - 自填型：IMAP `FETCH`，游标用 `UIDVALIDITY` + 最大 `UID`；`UIDVALIDITY` 变化即全量重扫。
  - 通用：按 RFC `Message-ID` 去重，复用现有 thread/地址/正文/附件模型入库；与自有域收信共用配额、保留与审计；不得回写已读状态到 provider。
  - IMAP 无 IDLE（Workers 无法维持长连接），一律轮询。
- **S7f 自填服务器的威胁模型（本卡前置门禁）**：
  - **SSRF 防护**：只接受主机名，拒绝 IP 字面量；解析后拒绝私网（RFC1918）、回环、链路本地、CGNAT、云元数据地址与 Cloudflare 自有 IP；连接时用已解析并校验过的 IP，防止 DNS rebinding；端口白名单 IMAP 993/143、SMTP 465/587。
  - **禁止明文**：SMTP 仅 465（隐式 TLS）或 587（STARTTLS），IMAP 仅 993（隐式 TLS）或 143（STARTTLS）；证书校验失败或 STARTTLS 不可用即失败，**绝不降级为明文**（否则密码泄漏）。Cloudflare Workers 出站 **25 端口被封禁**，实现前须实测确认端口可达性。
  - **开放中继**：SMTP 必须 `AUTH`，不实现无认证投递；不实现「用本服务凭据代发他人域名」的中继语义。
  - **扫描防护**：连通性测试按账号限流，避免被当作端口扫描器；失败码不区分「拒绝连接」与「连上但握手失败」以外的细节。
  - **凭据弱点**：自填密码不可撤销，撤销路径必须同时提供「删除凭据 + 停用身份」，并在 UI 层提示用户去 provider 侧改密。

## Out of Scope

- POP3、Exchange/EWS、ActiveSync。
- 日历、联系人、规则引擎、邮件迁移。
- 把第三方邮箱的信「转发到自有域」作为兜底。
- 客户端 UI（含凭据录入与连通性测试交互）。
- 自建 SMTP 中继或代发他人域名。

## 验收证据

1. 同一账号可同时持有自有域地址、一个 Gmail 身份与一个自填 IMAP/SMTP 身份，列表能区分且互不覆盖。
2. 凭据在 D1/R2 中为密文；日志、审计、错误消息、测试快照中无 token、密码、refresh token。
3. Gmail 发信端到端成功一次，并产生既有 `send_receipts` 行（含 provider 与 provider_message_id）。
4. 撤销授权后发信返回固定失败码，不重试、不落 receipt、不再调用 provider。
5. 收信同步：三类 provider 各真实拉取至少一封入库，正文/附件/线程与自有域邮件同构；重复同步不产生重复行。
6. 游标失效回退（Gmail `historyId` 过期、IMAP `UIDVALIDITY` 变化）时仍幂等，不重复入库、不丢已入库数据。
7. **SSRF 负例**：指向私网、回环、云元数据地址与 Cloudflare IP 的配置被拒绝，且未发起任何连接。
8. **明文负例**：仅提供明文端口或 STARTTLS 不可用的服务器被拒绝，凭据不外发。
9. 单轮同步在 CPU 与子请求上限内完成；超限时留下可续跑的游标，不产生重复或半成品行。
10. 自有域收信与发信回归不变（现有 integration 用例全绿）。

## 依赖与阻塞

- WHO-S6 完成账号 ↔ 地址映射，否则第三方身份没有可归属的所有者。
- 需要先有一份凭据托管与 provider OAuth/IMAP 的安全契约（仓库 `AGENTS.md` 的硬要求），否则不得进入实现。加密方案已在 S7b 裁决，契约仍需覆盖 S7f 威胁模型、轮换 runbook 与丢失 KEK 的处置。
- 需要新增 Worker secret `MAIL_CREDENTIAL_KEK`（32 字节）；丢失 KEK 意味着所有第三方身份必须重新授权，这是已接受的取舍。
- Google OAuth 客户端与 Microsoft 应用注册、同意屏与最小 scope 评审。
- 现有 `triggers.scheduled` 只有每天一次（`17 3 * * *`）；5 分钟同步需要改 Cron（共 288 次/天），属配置与成本变更。
- 对用户自填服务器的真实连接测试属于 `AGENTS.md` 意义上的「live 凭据使用」，需要显式任务授权与对应真实证据，不能仅凭构建通过发起。
- Cloudflare Workers 出站 TCP 能力（`cloudflare:sockets`）的端口与目标限制需实测确认后再写实现。

## 待决

1. Workers 出站 socket 的实测边界：25 是否确实封禁、是否存在其他端口/IP 段限制。
2. 同步超出单次调用 CPU / 子请求预算时的降级策略（跳轮 + 游标续跑 vs 改 Queue）。
3. 自填服务器连通性测试的交互形态与失败码粒度（避免成为探测工具）。
4. 第三方身份的保留与删除是否与自有域完全一致（含 `quota_bytes` 取值）。
5. 自填密码的轮换提醒策略（不可撤销凭据的定期引导改密）。
