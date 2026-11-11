# Who You — 凭据与第三方 provider 安全契约 v1

状态：**草案 · 未经评审通过不得进入实现**

适用范围：`WHO-S7`（第三方邮箱接入，含 OAuth 与用户自填 IMAP/SMTP）

上位约束：`uichat-mira/.github@main/AGENTS.md`（Policy revision `2026-09-16.2`）、本仓库 `AGENTS.md`、[`FOUNDATION.md`](./FOUNDATION.md)

关联任务卡：`docs/task-cards/WHO-S6-own-domain-username-mailbox.md`、`docs/task-cards/WHO-S7-third-party-mailbox.md`（在 Draft PR #17，尚未合并）

本文只定义**安全边界与不可协商的实现约束**，不定义产品旅程、UI 文案、重试策略，也不声称任何能力已实现。文中出现的表名、`env` 名、错误码是实现契约，落地时必须一致。

## 1. 资产清单

| 资产 | 存放位置 | 泄漏后果 | 保护手段 |
|---|---|---|---|
| OAuth refresh token | D1 `provider_credentials.ciphertext` | 可长期代表用户读写其邮箱 | 信封加密 + AAD 绑定 + provider 侧撤销 |
| IMAP/SMTP 密码（用户自填） | 同上 | 可长期登录用户邮箱，**不可远端撤销** | 信封加密 + 仅 TLS 传输 + 强制删除路径 |
| DEK（每账号） | D1 `provider_credentials.wrapped_dek` | 配合 KEK 可解该账号全部凭据 | 用 KEK 包裹，AAD 绑定账号 |
| KEK | Worker secret `MAIL_CREDENTIAL_KEK` | 全库凭据可解 | 90 天轮换 + 事件响应 |
| 邮件正文/附件/地址 | R2 对象 + D1 元数据 | 隐私泄漏 | 沿用 S1–S5 的账号隔离与删除路径 |
| 审计记录 | D1 `mail_audit_log` | 暴露谁在何时绑定了什么 provider | 只存 id 与 reason，不存凭据与地址 |

## 2. 威胁模型

| 编号 | 威胁 | 缓解 |
|---|---|---|
| T1 | D1 备份或误导出泄漏 | 值均为 AES-256-GCM 密文，无 DEK+KEK 不可读 |
| T2 | 密文被平移到其他账号/身份行 | AAD 绑定 `account_id`、`provider`、`mailbox_id`、`key_version` |
| T3 | Worker 日志/错误/快照泄漏凭据 | 日志字段白名单（§7）；异常只映射固定码，不回显 provider 响应体 |
| T4 | KEK 泄漏 | 轮换 + 强制重新授权（§8.4） |
| T5 | 用户自填 host 被用作 SSRF | 目标校验 + 私网拒绝 + 端口白名单（§5.1） |
| T6 | 传输被降级为明文 | 仅隐式 TLS 或 STARTTLS；升级失败即失败（§5.2） |
| T7 | Worker 被当作开放中继 | SMTP 必须 AUTH，`MAIL FROM` 固定为该身份（§5.3） |
| T8 | 账号被盗后被用于群发 | `SendGate` / `AbuseMonitor` + 第三方身份约 100 封/天 + 暂停只作用于该身份 |
| T9 | provider 侧已撤销，本地仍尝试 | 失败即置 `reauth_required`，不重试（§4.3） |
| T10 | 连通性测试被当作端口扫描器 | 按账号与目标限流，仅白名单端口（§5.4） |

明确不在本契约范围：Cloudflare 平台逃逸、provider 自身被攻破、邮件端到端加密（本产品**不做** E2EE，内容在存储层由 Cloudflare 管理）。

## 3. 密钥层级与加密

- **KEK**：Worker secret `MAIL_CREDENTIAL_KEK`，32 字节随机值的 base64。只用于包裹/解包 DEK，不直接加密凭据。
- **DEK**：每账号 32 字节随机值。包裹时 AAD 为 `who-you/dek/v1|<account_id>|<key_version>`。
- **凭据密文**：AES-256-GCM，12 字节随机 nonce，AAD 为 `who-you/credential/v1|<account_id>|<provider>|<mailbox_id>|<key_version>|<credential_type>`。
- **`provider_credentials` 字段**（迁移 0006）：`account_id`、`mailbox_id`、`provider`、`credential_type`（`oauth_refresh` / `imap_password` / `smtp_password`）、`key_id`、`key_version`、`wrapped_dek`、`ciphertext`、`nonce`、`scope`、`status`（`active` / `reauth_required` / `revoked`）、`created_at`、`updated_at`、`last_used_at`。**不存**明文、可逆编码、口令提示或任何「解不开时回退」的值。
- **fail-closed**：
  - 未配置 KEK → 所有第三方身份操作返回 `503 provider_credentials_not_configured`，不使用明文兜底。
  - 解密失败（AAD 不匹配、GCM 校验失败、版本缺失）→ 该身份置 `reauth_required`，返回 `credential_unreadable`，不重试、不降级。
  - 同一 mailbox 出现多行 active 凭据视为数据损坏，按 `credential_unreadable` 处理。

## 4. OAuth 类（Gmail / Microsoft Graph）

1. 授权使用 PKCE + 一次性 `state`（绑定账号、短 TTL、单次使用）。回调不得把 code 写入日志。
2. Scope 最小化：发信与收信各取其必需 scope（Gmail `gmail.send` + `gmail.readonly`；Graph `Mail.Send` + `Mail.Read`）。不申请联系人、日历、Drive。
3. 只持久化 **refresh token**（密文）。access token 仅在单次执行内换取并持有，**不落库、不写 KV/Cache、不写 R2**。
4. 撤销顺序：先删除本地密文与 wrapped DEK，再调用 provider 的 revoke 端点。provider 撤销失败不阻断本地删除，但记 `credential_revoke_unconfirmed` 审计。
5. `invalid_grant` / `invalid_client` → 身份置 `reauth_required`，停止发信与该身份的同步，返回 `provider_reauth_required`。
6. 不存、不索要用户主密码。

## 5. 自填 IMAP/SMTP

### 5.1 目标校验（SSRF）

- 只接受**主机名**（RFC 1123，长度 ≤253，标签 ≤63）。拒绝 IP 字面量，以及十进制/八进制/十六进制/括号等 IPv4 变体、IPv6、`userinfo@host`、带路径/查询的输入。
- 建连前解析全部 A/AAAA 记录；**任一**地址落入以下区间即整体拒绝：
  `0.0.0.0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.0.0/24`、`192.168/16`、`198.18/15`、`224/4`、`240/4`、`::1`、`::/128`、`fc00::/7`、`fe80::/10`、`::ffff:0:0/96`、`64:ff9b::/96`。
- 额外拒绝：云元数据域名与地址（`169.254.169.254`、`metadata.google.internal` 等）、`localhost` 及 `.localhost`、`.internal`、`.local`、以及 Cloudflare 自有网段。
- **残余风险（已知且未消除）**：Workers 的 socket API 只接受主机名，且未暴露对端 IP，因此「校验通过后再解析到私网」的 DNS rebinding（TOCTOU）无法在 Worker 内完全阻断。缓解措施：建连前校验 + TLS 必须校验证书主机名 + 仅白名单端口 + 失败即断开。该残余风险必须在实现前的安全评审中显式接受并记录。
- 端口白名单：IMAP `993`（隐式 TLS）或 `143`（STARTTLS）；SMTP `465`（隐式 TLS）或 `587`（STARTTLS）。**25 不在白名单**：Cloudflare Workers 不支持出站 25，且不提供直投能力。

### 5.2 传输

- 隐式 TLS（993/465）直接握手；STARTTLS（143/587）必须升级成功才发送任何认证信息。
- 证书校验由平台 TLS 完成，代码中**不得**存在「忽略证书错误」的开关（平台也未提供）。
- 超时：连接 10 秒，单次读写 30 秒。超时计入失败，不无限重试。
- 明文端口（如 110/143 未升级、25）一律拒绝，不存在配置项可以打开。

### 5.3 认证与反中继

- SMTP 必须完成 `AUTH`（PLAIN 或 LOGIN，均在 TLS 内）。禁止匿名投递、禁止 `VRFY`/`EXPN`。
- `MAIL FROM` 固定为该身份地址，不由调用方指定；`From` 头与之一致。
- 不实现中继语义：不接受「用本服务凭据代发他人域名」的请求。
- 对自有域地址的投递走正常链路（本服务自有域仍由 Cloudflare Email Routing 收信），不做手工直投。

### 5.4 连通性测试与反扫描

- 每个账号每小时最多 10 次、每个目标每小时最多 3 次连通性测试，超出返回 `provider_test_rate_limited`。
- 只连接白名单端口，绝不按端口递增扫描。
- 对外只暴露三类失败码：`provider_unreachable`、`provider_auth_failed`、`provider_tls_required`；不返回内部 DNS 解析结果、对端地址或原始异常文本。

## 6. 运行时使用面

- 解密只发生在发信与该身份的同步路径内，密钥材料不得跨请求缓存。
- 明文凭据不得进入 D1/R2/KV/Cache/Queue、不得进入 `mail_audit_log`、不得进入 MCP 工具输出。
- 捕获 provider 异常时只映射固定码；**禁止**把响应体写入日志或错误消息（可能含 token 片段）。
- 第三方发信仍走 S2 的 `sendDraft` 管线：确认凭证、幂等键、抑制名单、暂停闸门保持不变。

## 7. 日志字段白名单

允许：`event`、`outcome`、`provider`、`mailbox_id`、`key_version`、`reason_code`、`latency_ms`、`message_count`、`byte_count`。

禁止：地址、主题、正文、附件名、token、密码、client_secret、授权码、密文、host（自填 host 视为用户数据，只在库里，不进日志）。

事件命名沿用现有风格：`whoyou_mail_inbound`、`whoyou_deliverability_pause`；新增 `whoyou_credential_event`，其 `outcome` 仅取 `linked` / `revoked` / `unreadable` / `rotated` / `reauth_required`。

## 8. 轮换、撤销与删除

### 8.1 KEK 轮换

- 周期 90 天；新 KEK 写入 `MAIL_CREDENTIAL_KEK`，旧值暂存 `MAIL_CREDENTIAL_KEK_PREVIOUS`，`key_version` 递增。
- Cron 惰性重包裹：每次同步/发信命中旧版本时，用当前 KEK 重新包裹该行 DEK 并更新 `key_version`。
- 旧版本保留 **30 天**，窗口结束后移除 `MAIL_CREDENTIAL_KEK_PREVIOUS`；到期仍未重包裹的行在读取时返回 `credential_unreadable`。

### 8.2 用户撤销

1. `status = revoked`，删除 `wrapped_dek` 与 `ciphertext`（crypto-shredding）。
2. 调用 provider revoke（仅 OAuth）。
3. 写审计 `revoked`；不发信、不再同步。

### 8.3 账号删除

删除账号时一并删除该账号全部 `provider_credentials` 行（含 wrapped DEK），无需逐条撤销也能使历史备份中的密文不可解。

### 8.4 丢失 KEK

- 影响：全部第三方身份不可解，必须重新授权；自有域收发不受影响。
- 处置：写入新 KEK，把所有身份置 `reauth_required`，写审计 `rotated`，通知受影响账号重新授权。**不提供**任何绕过解密的恢复手段。

## 9. 测试与证据（T1–T5）

- **T1 unit**：加解密往返；AAD 任一字段改动必须解密失败；旧 `key_version` 走重包裹；SSRF 校验表（IPv4 变体、IPv6、私网、元数据域名、`.local`、带 userinfo）正负例；端口白名单；日志字段白名单。
- **T3 workerd**：D1 落库断言——对 `provider_credentials` 全表做子串扫描，**不得**出现任何测试凭据明文；撤销后不产生新连接；解密失败置 `reauth_required` 且不再重试；配额 90% 停止回填。
- **T4/T5（真实链路）**：连接真实 provider 属于 `AGENTS.md` 意义上的 live 凭据使用，必须由独立任务显式授权、使用专用测试账号、单独执行并给出 SHA 绑定的证据；不得在 CI 中跑真实凭据，不得把真实 token 放进 fixture。
- 负例优先：SSRF、明文降级、端口越界、AAD 平移、KEK 缺失，每项都必须有失败用例，而不是只测成功路径。

## 10. 事件响应

| 事件 | 处置 |
|---|---|
| 疑似 KEK 泄漏 | 立即换 KEK → 全量置 `reauth_required` → 导出审计 → 通知账号 |
| 单个凭据泄漏 | provider 侧撤销 → 删除本地密文 → 通知该账号 |
| 自填密码泄漏 | 无法远端撤销：删除本地 → 强制停用身份 → 要求用户改密后重绑 |
| 滥用/被当跳板 | 暂停该身份（`send_paused`）→ 保留不含内容的证据 → 人工复核 |

## 11. 残余风险（显式接受或待评审）

1. DNS rebinding TOCTOU：Workers 无法读取对端 IP，只能依赖 TLS 证书主机名校验。
2. 自填密码不可撤销，只能删除或由用户改密。
3. Workers socket 的端口与目标限制（含 25 是否完全不可用）需实测确认。
4. provider 侧撤销不保证即时生效，本地已删除但对方仍可能短时有效。
5. 不做 E2EE；内容安全依赖 Cloudflare 存储层与访问控制。
6. 第三方内容的保留策略与配额取值仍待产品裁决。

## 12. 实现前门禁

- [ ] 本文经人工评审通过（安全 + 产品各一）。
- [ ] `MAIL_CREDENTIAL_KEK` 的生成、存放、轮换 runbook 已写入部署文档。
- [ ] §5.1 的主机/私网/端口校验实现为**纯函数**并有完整负例测试。
- [ ] §9 的「全表无明文」断言已加入 CI。
- [ ] SSRF 与 DNS rebinding 残余风险已由评审显式接受。
- [ ] 真实连接测试已获得独立任务授权，且有对应证据计划。
