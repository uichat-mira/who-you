# Who You — 凭据与第三方 provider 安全契约 v1.2

状态：**草案 v1.2 · 人工评审环节已由维护者移除 · 实现前门禁以 §12 的可执行检查为准**

适用范围：`WHO-S7`（第三方邮箱接入，含 OAuth 与用户自填 IMAP/SMTP）

上位约束：`uichat-mira/.github@main/AGENTS.md`（Policy revision `2026-09-16.2`）、本仓库 `AGENTS.md`、[`FOUNDATION.md`](./FOUNDATION.md)

关联任务卡：`docs/task-cards/WHO-S6-own-domain-username-mailbox.md`、`docs/task-cards/WHO-S7-third-party-mailbox.md`

本文只定义**安全边界与不可协商的实现约束**，不定义产品旅程、UI 文案、重试策略，也不声称任何能力已实现。文中出现的表名、`env` 名、错误码是实现契约，落地时必须一致。

## 0. 修订记录

v1.1 → v1.2（维护者决定）：

1. **移除人工评审门禁**：实现不再等待评审会议或签字，改为以 §12 的可执行检查（测试、断言、runbook）作为进入实现的条件。
2. 补入 Cloudflare Workers 出站 socket 的实测结论（§5.2、§11.3），把「未实测」的假设替换为证据。
3. 修正 §5.1 对 `remoteAddress` 的表述：平台确实提供该字段，但实测返回 `<hostname>:<port>` 而非 IP，无法用于 CIDR 校验。

v1.0 → v1.1 修正了评审发现的阻断级矛盾，并补齐缺失威胁：

1. 撤销顺序改为「解密 → provider revoke → 无条件删除本地」；v1.0 的「先删后撤销」不可实现。
2. 凭据密文 AAD 改用稳定的 `dek_id`，与 KEK 版本解耦；轮换只重包裹 DEK，不重加密密文。
3. 活跃凭据唯一性改为 `(mailbox_id, credential_type)`，允许自填型同时存在 IMAP 与 SMTP 两条。
4. SSRF 章节改为可实现的约束，并把 DNS rebinding 明确列为已接受残余风险与升级条件。
5. 新增：绑定/解绑需要 S4 确认凭证、解绑删除已同步副本、IMAP 协议层输入约束、凭据有效性预言机限流、KEK 泄漏时的 provider 侧动作。

## 1. 资产清单

| 资产 | 存放位置 | 泄漏后果 | 保护手段 |
|---|---|---|---|
| OAuth refresh token | D1 `provider_credentials.ciphertext` | 可长期代表用户读写其邮箱 | 信封加密 + AAD 绑定 + provider 侧撤销 |
| IMAP/SMTP 密码（用户自填） | 同上 | 可长期登录用户邮箱，**不可远端撤销** | 信封加密 + 仅 TLS 传输 + 强制删除路径 |
| DEK（每账号） | D1 `provider_credentials.wrapped_dek` | 配合 KEK 可解该账号全部凭据 | 用 KEK 包裹，AAD 绑定账号与 `dek_id` |
| KEK | Worker secret `MAIL_CREDENTIAL_KEK` | 全库凭据可解 | 90 天轮换 + 事件响应 |
| 邮件正文/附件/地址 | R2 对象 + D1 元数据 | 隐私泄漏 | 沿用 S1–S5 的账号隔离与删除路径 |
| 审计记录 | D1 `mail_audit_log` | 暴露谁在何时绑定了什么 provider | 只存 id 与 reason，不存凭据与地址 |

## 2. 威胁模型

| 编号 | 威胁 | 缓解 |
|---|---|---|
| T1 | D1 备份或误导出泄漏 | 值均为 AES-256-GCM 密文，无 DEK+KEK 不可读 |
| T2 | 密文被平移到其他账号/身份行 | AAD 绑定 `account_id`、`provider`、`mailbox_id`、`dek_id` |
| T3 | Worker 日志/错误/快照泄漏凭据 | 日志字段白名单（§7）；异常只映射固定码，不回显 provider 响应体 |
| T4 | KEK 泄漏 | 轮换 + provider 侧撤销 + 强制改密（§8.4、§10） |
| T5 | 用户自填 host 被用作 SSRF | 语法级拒绝 + 端口白名单 + 强制 TLS（§5.1） |
| T6 | 传输被降级为明文 | 仅隐式 TLS 或 STARTTLS；升级失败即失败（§5.2） |
| T7 | Worker 被当作开放中继 | SMTP 必须 AUTH，`From` 固定为可验证身份（§5.3） |
| T8 | 账号被盗后被用于群发 | `SendGate` / `AbuseMonitor` + 第三方身份约 100 封/天 + 暂停只作用于该身份 |
| T9 | provider 侧已撤销，本地仍尝试 | 失败即置 `reauth_required`，不重试（§4.4） |
| T10 | 连通性测试被当作端口扫描器或密码预言机 | 按账号与目标限流，失败码最小化（§5.4） |
| T11 | 注入的 MCP 调用偷偷绑定攻击者邮箱 | 绑定/解绑必须携带 S4 确认凭证（§6） |
| T12 | 解除身份后已同步邮件仍留在本地 | 解绑即删除该身份的邮件、附件与对象（§8.3） |
| T13 | IMAP 命令注入或响应炸弹 | 参数引号化、CR/LF 拒绝、大小与行数上限（§5.5） |

明确不在本契约范围：Cloudflare 平台逃逸、provider 自身被攻破、邮件端到端加密（本产品**不做** E2EE，内容在存储层由 Cloudflare 管理）。

## 3. 密钥层级与加密

- **KEK**：Worker secret `MAIL_CREDENTIAL_KEK`，32 字节随机值的 base64。只用于包裹/解包 DEK，不直接加密凭据。
- **DEK**：每账号 32 字节随机值，配一个不可变的 `dek_id`。包裹时 AAD 为 `who-you/dek/v1|<account_id>|<dek_id>|<key_version>`。
- **凭据密文**：AES-256-GCM，12 字节随机 nonce，AAD 为 `who-you/credential/v1|<account_id>|<provider>|<mailbox_id>|<dek_id>|<credential_type>`。
  **AAD 不得包含 `key_version` 或任何随轮换变化的值**：轮换只重包裹 DEK，不重新加密凭据密文；若 AAD 绑定 KEK 版本，轮换会让全部旧密文立刻不可解。
- **`provider_credentials` 字段**（迁移 0006）：`account_id`、`mailbox_id`、`provider`、`credential_type`（`oauth_refresh` / `imap_password` / `smtp_password`）、`dek_id`、`key_version`、`wrapped_dek`、`ciphertext`、`nonce`、`scope`、`status`（`active` / `reauth_required` / `revoked`）、`created_at`、`updated_at`、`last_used_at`。**不存**明文、可逆编码、口令提示或任何「解不开时回退」的值。
- **唯一性**：`(mailbox_id, credential_type)` 上建**部分唯一索引**，条件 `status = 'active'`。一个自填身份因此可以同时拥有 `imap_password` 与 `smtp_password` 两条活跃凭据；同类型两条活跃才算数据损坏。
- **nonce**：每次加密随机 12 字节，不与相同 DEK 下的历史 nonce 重复使用；不做确定性 nonce。
- **fail-closed**：
  - 未配置 KEK → 所有第三方身份操作返回 `503 provider_credentials_not_configured`，不使用明文兜底。
  - 解密失败（AAD 不匹配、GCM 校验失败、版本缺失）→ 该身份置 `reauth_required`，返回 `credential_unreadable`，不重试、不降级。
  - 同一 `(mailbox_id, credential_type)` 出现多行 active → 按 `credential_unreadable` 处理，不猜测哪条有效。

## 4. OAuth 类（Gmail / Microsoft Graph）

1. 授权使用 PKCE + 一次性 `state`。`state` 与 PKCE verifier 存 D1（不存 KV/Cache），TTL 10 分钟，通过条件删除实现单次使用；`state` 与 `account_id`、`redirect_uri` 严格绑定，回调时 `redirect_uri` 必须逐字匹配。回调不得把 code 写入日志。
2. Scope 最小化：发信与收信各取其必需 scope（Gmail `gmail.send` + `gmail.readonly`；Graph `Mail.Send` + `Mail.Read`）。不申请联系人、日历、Drive。**provider 实际授予的 scope 少于申请值时必须置 `reauth_required`**，不得带着缺失能力继续同步。
3. 只持久化 **refresh token**（密文）。access token 仅在单次执行内换取并持有，**不落库、不写 KV/Cache、不写 R2**。
4. **撤销顺序**（v1.0 的顺序不可实现，已修正）：
   1. 在内存中解密取得 refresh token；
   2. 调用 provider 的 revoke 端点；失败不阻断后续步骤，只记 `credential_revoke_unconfirmed` 审计；
   3. **无条件**删除 `ciphertext`、`nonce`、`wrapped_dek`，置 `status = 'revoked'`；
   4. 写审计 `revoked`。
   任何情况下都不得因为「先删了本地」而无法撤销，也不得因为撤销失败而保留密文。
5. `invalid_grant` → 身份置 `reauth_required`，停止发信与该身份的同步，返回 `provider_reauth_required`。
   `invalid_client` 是**我方 OAuth 客户端配置错误**，不映射为用户需要重新授权：返回 `provider_misconfigured`，仅内部告警，不向用户暴露原因。
6. 不存、不索要用户主密码。
7. `client_secret` 只存 Worker secret，按环境（dev/test/prod）使用独立 OAuth 客户端，不写入 D1、不进入任何工具输出。

## 5. 自填 IMAP/SMTP

### 5.1 目标校验（SSRF）

平台事实（实现前必须按此设计，不得声称已做解析校验）：

- `cloudflare:sockets` 只接受**主机名**，不接受 IP 目标；`socket.opened` 返回的 `SocketInfo.remoteAddress` 实测形如 `imap.gmail.com:993`（`<hostname>:<port>`），**不是对端 IP**，无法用于 CIDR 校验；
- 本 Worker 没有私有网络绑定（无 VPC / Tunnel 到内网），私网目标在平台层不可达。

因此本契约把约束拆成「可强制」与「已接受残余风险」两部分。

**语法级强制（必须实现，可写纯函数）**

- 只接受主机名（RFC 1123，长度 ≤253，标签 ≤63）。拒绝 IP 字面量及其十进制/八进制/十六进制/括号等 IPv4 变体、IPv6、`userinfo@host`、带路径/查询/端口内嵌的输入。
- 拒绝 `localhost`、`*.localhost`、`*.local`、`*.internal`、云元数据域名（`metadata.google.internal` 等）。
- 拒绝空标签、连字符开头/结尾标签、下划线、以及非 ASCII 字符（IDN 必须由调用方先转 punycode）。
- 端口白名单：IMAP `993`（隐式 TLS）或 `143`（STARTTLS）；SMTP `465`（隐式 TLS）或 `587`（STARTTLS）。**25 不在白名单**：Cloudflare Workers 不支持出站 25，且不提供直投能力。

**补偿控制（必须实现）**

- 仅白名单端口，逐端口尝试，绝不递增扫描。
- 强制 TLS：隐式 TLS 或 STARTTLS 升级成功后才发送任何认证信息；证书主机名校验由平台 TLS 完成，代码不得有「忽略证书错误」的开关。
- 连接 10 秒、单次读写 30 秒超时；失败即断开，不重试同一目标。

**已接受残余风险 R1（DNS rebinding TOCTOU）**

校验通过后平台仍按自己的解析结果建连，理论上可解析到私网地址。接受该风险的理由：Worker 无私有网络绑定，私网目标不可达；且强制 TLS + 证书主机名校验 + 端口白名单把可利用面限制在「公网上持有合法证书的服务」。

**升级条件**：平台一旦提供对端 IP 或私有网络绑定（VPC/Tunnel），必须启用下列 CIDR 校验，且「任一解析地址命中即整体拒绝」：
`0.0.0.0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.0.0/24`、`192.88.99.0/24`、`192.168/16`、`198.18/15`、`224/4`、`240/4`、`::1`、`::/128`、`fc00::/7`、`fe80::/10`、`::ffff:0:0/96`、`64:ff9b::/96`、`2001::/32`、`2002::/16`、`ff00::/8`。
「Cloudflare 自有网段」不做手写清单：以 Cloudflare 官方公布的 IP 列表为唯一来源，并在平台能力升级时按该来源拉取。

### 5.2 传输

实测环境：Workers runtime，compatibility date `2026-08-06`，出口为准入侧 Cloudflare egress。测试时间 2026-11-11。

| 端口 | 形态 | 实测结果 |
|---|---|---|
| 993 | 隐式 TLS | 可用：`imap.gmail.com`、`imap.qq.com` 均返回 IMAP banner |
| 465 | 隐式 TLS | 可用：`smtp.gmail.com`、`smtp.qq.com` 均返回 `220` |
| 587 | STARTTLS | 可用：两端在 `EHLO` 后广播 `250-STARTTLS` |
| 143 | STARTTLS | 依赖 provider：`imap.qq.com` 可连接但未广播 `STARTTLS`（`a1 STARTTLS` 返回 `* BAD`）；`imap.gmail.com:143` 连接超时（20s 未建立） |
| 25 | 明文 | **不可用**：平台直接返回 `Connections to port 25 are prohibited` |

实现约束（由实测反推）：

- 隐式 TLS 必须写作 `connect({ hostname, port }, { secureTransport: "starttls" })` + `socket.startTls({ expectedServerHostname: host })`。把 `secureTransport` 放进第一个参数会被静默忽略（表现为 TCP 已连接但读取超时）；`startTls()` 在 `secureTransport !== "starttls"` 时直接抛错。
- STARTTLS 必须解析 `EHLO`/`CAPABILITY` 响应中是否真的出现 `STARTTLS`，出现才发认证信息；仅「TCP 能连上」不等于可安全认证。
- 143 只在 provider 明确广播 `STARTTLS` 且升级成功时可用；默认关闭，不是通用回退路径。
- 证书校验由平台 TLS 完成，代码中**不得**存在「忽略证书错误」的开关（平台也未提供）。
- 超时：连接 10 秒，单次读写 30 秒。超时计入失败，不无限重试。
- 明文端口（如 110、未升级的 143、25）一律拒绝，不存在配置项可以打开。

### 5.3 认证与反中继

- SMTP 必须完成 `AUTH`（PLAIN 或 LOGIN，均在 TLS 内）。禁止匿名投递、禁止 `VRFY`/`EXPN`。
- `MAIL FROM` 与该身份地址一致，且该地址必须与 SMTP `AUTH` 后可验证的账号一致；用户填写的展示地址与 AUTH 账号域名不一致时拒绝绑定（`provider_identity_mismatch`），避免把本服务变成任意发件人伪造通道。
- 不实现中继语义：不接受「用本服务凭据代发他人域名」的请求。
- 对自有域地址的投递走正常链路（本服务自有域仍由 Cloudflare Email Routing 收信），不做手工直投。

### 5.4 连通性测试与反扫描、反预言机

- 每个账号每小时最多 10 次、每个目标每小时最多 3 次连通性测试；**另加同一目标全局限流 10 次/小时**，防止换账号绕过。
- 只连接白名单端口，绝不按端口递增扫描。
- **连通性测试**对外只返回 `provider_unreachable` 与 `provider_tls_required`，不区分「拒绝连接」「认证失败」「主机不存在」。
- **绑定提交**（用户已明确录入凭据）可返回 `provider_auth_failed`，但同一目标全局限流与固定响应延迟仍然生效，避免被当作密码有效性预言机。
- 不返回内部 DNS 解析结果、对端地址或原始异常文本。

### 5.5 IMAP 协议层输入约束

- 所有命令参数（邮箱名、搜索串、flag）必须按 IMAP 引号规则编码，并拒绝包含 CR/LF 的输入。
- 邮箱名与搜索串长度上限 1024 字节；单次 `FETCH` 的字节上限沿用 raw size limit；单轮响应行数与嵌套深度设上限。
- `UIDVALIDITY`、`UID`、`INTERNALDATE` 等字段必须按整数/日期严格解析，解析失败即断连并返回固定码。
- IMAP 原始响应、命令文本、邮箱名不得写入日志；只记录 `message_count`、`byte_count` 与固定 `reason_code`。

## 6. 运行时使用面

- **绑定 / 解绑必须携带 S4 确认凭证**，凭证绑定 `account_id`、`mailbox_id`、`provider` 与操作类型，单次使用。理由：第三方身份绑定是高风险写操作，被注入的 MCP 调用不得在用户不知情时把攻击者邮箱接入受害者账号。
- 解密只发生在发信与该身份的同步路径内，密钥材料不得跨请求缓存。
- 明文凭据不得进入 D1/R2/KV/Cache/Queue、不得进入 `mail_audit_log`、不得进入 MCP 工具输出。
- 捕获 provider 异常时只映射固定码；**禁止**把响应体写入日志或错误消息（可能含 token 片段）。
- 第三方发信仍走 S2 的 `sendDraft` 管线：确认凭证、幂等键、抑制名单、暂停闸门保持不变。

## 7. 日志字段白名单

允许（使用代码中的真实字段名）：`event`、`outcome`、`provider`、`accountId`、`mailboxId`、`key_version`、`reason_code`、`latency_ms`、`message_count`、`byte_count`。

禁止：地址、主题、正文、附件名、token、密码、client_secret、授权码、密文、host（自填 host 视为用户数据，只在库里，不进日志）。

事件命名沿用现有风格：`whoyou_mail_inbound`、`whoyou_deliverability_pause`；新增 `whoyou_credential_event`，其 `outcome` 仅取 `linked` / `link_rejected` / `revoked` / `unreadable` / `rotated` / `reauth_required` / `credential_revoke_unconfirmed`。

## 8. 轮换、撤销与删除

### 8.1 KEK 轮换

- 周期 90 天；新 KEK 写入 `MAIL_CREDENTIAL_KEK`，旧值暂存 `MAIL_CREDENTIAL_KEK_PREVIOUS`，`key_version` 递增。
- 重包裹只更新 `wrapped_dek` 与 `key_version`，不改 `ciphertext`、`nonce`、`dek_id`（见 §3）。
- 两条重包裹路径缺一不可：
  1. 惰性：每次同步/发信命中旧版本时重包裹该行；
  2. 批量清扫：每日 Cron 以固定预算（如 200 行/天）扫描旧版本行并重包裹，输出 `credential_rewrap_backlog` 指标。
- 旧版本保留 **30 天**；剩余 7 天仍有旧版本行时告警。窗口结束后移除 `MAIL_CREDENTIAL_KEK_PREVIOUS`，到期仍未重包裹的行在读取时返回 `credential_unreadable`。

### 8.2 用户撤销

1. 在内存中解密取得凭据（OAuth 需要 refresh token 才能调 revoke）。
2. 调用 provider revoke（仅 OAuth），失败只记审计。
3. 无条件删除 `wrapped_dek`、`ciphertext`、`nonce`，置 `status = 'revoked'`（crypto-shredding）。
4. 写审计 `revoked`；此后不发信、不再同步。

### 8.3 解除身份与账号删除

- **解除第三方身份**（unlink）：删除该 `mailbox_id` 的全部邮件行、附件行与 R2 对象，再删除凭据与 mailbox 行。顺序是 R2 先行、D1 后行，保证不留下无主对象；重复调用必须幂等。
- **账号删除**：一并删除该账号全部 `provider_credentials` 行（含 wrapped DEK），无需逐条撤销也能使历史备份中的密文不可解；同步副本按 §8.3 第一条同样清空。

### 8.4 丢失 KEK

- 影响：全部第三方身份不可解，必须重新授权；自有域收发不受影响。
- 处置：写入新 KEK，把所有身份置 `reauth_required`，写审计 `rotated`，通知受影响账号重新授权。**不提供**任何绕过解密的恢复手段。
- **KEK 泄漏时换 KEK 本身不等于止损**：已泄漏的 wrapped DEK 仍可被解开。必须同时执行 §10 的 provider 侧全量撤销与自填型强制改密，否则轮换只是表面动作。

## 9. 测试与证据

测试层用 `unit` / `workerd` / `live` 命名，避免与 §2 的威胁编号 T1–T13 混淆。

- **unit**：加解密往返；AAD 任一字段改动必须解密失败；**重包裹 DEK 后旧密文仍可解**（防止 AAD 绑定 `key_version` 回归）；SSRF 语法校验表（IPv4 变体、IPv6、IP 字面量、私网域名、`.local`、`internal`、带 userinfo、超长标签）正负例；端口白名单；IMAP 参数注入负例（CR/LF、超长 mailbox 名）；日志字段白名单。
- **workerd**：D1 落库断言——对 `provider_credentials` 全表做子串扫描，**不得**出现任何测试凭据明文；部分唯一索引确实阻止同 `(mailbox_id, credential_type)` 双 active，同时允许 IMAP+SMTP 各一条；**撤销顺序**——revoke 调用时仍能解密，删除后不再可解；解密失败置 `reauth_required` 且不再重试；unlink 后邮件行、附件行与 R2 对象均为空且重复调用幂等；连通性测试同一目标限流计数生效；配额 90% 停止回填。
- **live**：连接真实 provider 属于 `AGENTS.md` 意义上的 live 凭据使用，必须由独立任务显式授权、使用专用测试账号、单独执行并给出 SHA 绑定的证据；不得在 CI 中跑真实凭据，不得把真实 token 放进 fixture。
- 负例优先：SSRF、明文降级、端口越界、AAD 平移、KEK 缺失、绑定无确认凭证、解绑残留副本，每项都必须有失败用例，而不是只测成功路径。

## 10. 事件响应

| 事件 | 处置 |
|---|---|
| 疑似 KEK 泄漏 | 换 KEK → 全量置 `reauth_required` → **OAuth 身份逐个调 provider revoke** → 自填型强制用户改密后重绑 → 导出审计 → 通知账号 |
| 单个凭据泄漏 | provider 侧撤销 → 删除本地密文 → 通知该账号 |
| 自填密码泄漏 | 无法远端撤销：删除本地 → 强制停用身份 → 要求用户改密后重绑 |
| 滥用/被当跳板 | 暂停该身份（`send_paused`）→ 保留不含内容的证据 → 人工复核 |

## 11. 残余风险（显式接受）

1. **R1 DNS rebinding TOCTOU**：接受。依据与升级条件见 §5.1；不声称已在 Worker 内阻断。
2. 自填密码不可撤销，只能删除或由用户改密。
3. Workers socket 的端口限制已实测（见 §5.2）：993/465/587 可用，25 被拒绝，143 依赖 provider。143 的默认关闭是产品取舍，不是平台限制。
4. provider 侧撤销不保证即时生效，本地已删除但对方仍可能短时有效。
5. 不做 E2EE；内容安全依赖 Cloudflare 存储层与访问控制。
6. 第三方内容的保留策略与配额取值仍待产品裁决。
7. 绑定提交仍会向目标服务器透露「该密码是否正确」，只能靠全局限流与延迟压低速率，不能消除。

## 12. 实现前门禁

人工评审环节已由维护者移除（见 §0）。以下检查是进入实现的唯一条件，逐项以可执行证据为准。

- [ ] `MAIL_CREDENTIAL_KEK` 的生成、存放、轮换、泄漏处置 runbook 已写入部署文档。
- [ ] §5.1 的语法校验与 §5.5 的 IMAP 参数校验实现为**纯函数**，DNS/连接部分按「不可在 Worker 内校验」实现，并有完整负例测试。
- [ ] §3 的 AAD 使用 `dek_id`，并有「重包裹后旧密文仍可解」的回归测试。
- [ ] §4.4 / §8.2 的撤销顺序有 workerd 用例（revoke 时仍可解密、删除后不可解）。
- [ ] §9 的「全表无明文」断言与部分唯一索引断言已加入 CI。
- [ ] §6 的绑定/解绑确认凭证已实现并有「无凭证即拒绝」用例。
- [ ] §8.3 的 unlink 删除同步副本有幂等用例。
- [ ] §11 的 R1 与 §5.2 的端口结论已在本文记录（已完成，v1.2）。
- [ ] §5.2 的隐式 TLS 写法（两参数 `connect` + `startTls`）已固化为实现，并有「错误写法会失败」的用例。
- [ ] 实际部署与真实 provider 连接仍需独立任务授权与证据计划（不属于评审门禁）。
