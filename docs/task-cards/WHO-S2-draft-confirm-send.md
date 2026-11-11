# WHO-S2：草稿 + 用户确认 + relay 发送 + 回执

状态：**阻塞 · 待 S1 完成 + 确认契约裁决**

负责人：待指派

执行仓库：`uichat-mira/who-you`

设计依据：[`docs/product-design.md`](../product-design.md) v1 §2、§4.2、§6、§7.3、§8.2、§10。

## 背景

Who You 的唯一外部写副作用是发信。发送必须由用户在 Mira 客户端对**具体草稿版本**显式确认；Agent 只能产出草稿。S2 把这条链路做成可验证的闸门，而不是一个「有 send scope 就能发」的工具。

## Goal

1. Agent 可创建、修改、丢弃、读取草稿；草稿不触达外部。
2. 用户在 Mira 客户端看到草稿最终形态并确认，客户端产生一次性确认凭证。
3. `whoyou_mail_send` 只凭该凭证发送，重算哈希，拒绝版本漂移、过期、重复使用。
4. 通过 relay 投递，写入不可变发送回执；失败可观测、可重试、不重复发信。

## In Scope

- **草稿**：`whoyou_mail_draft_create / _update / _discard / _get / _list`；`version` + `contentHash`；附件集合参与哈希。
- **确认凭证**：绑定 `draftId + draftVersion + contentHash + accountId + nonce`，短时效、单次使用。来源在 A / B 方案中裁决。
- **发送**：`whoyou_mail_send` 仅接受三个参数；不接受收件人 / 主题 / 正文 / 附件覆盖。
- **relay 契约**：Worker → relay 请求格式、鉴权（mTLS 或 HMAC）、超时、错误码、幂等键。
- **relay 侧**：DKIM 签名、SPF 对齐、队列、重试与退避、TLS。私钥不进入 Worker 或仓库。
- **回执**：`SendReceipt` 不可改写；草稿删除不影响回执。
- **防护**：单账户速率、收件人数上限、重复发送幂等、新账户冷启动限额。
- **scope**：`whoyou.mail.write`（草稿与本地状态）、`whoyou.mail.send`（默认不签发）。

## Out of Scope

- 退信 / 投诉闭环与抑制表（S4）。
- 批量群发、营销邮件、订阅退订自动化。
- 第三方邮件客户端接入。
- 除本域地址外的任意 From。

## 确认契约（必须先定稿）

禁止把「确认」做成 MCP 工具；Agent 能自行调用的确认没有意义。

- **方案 A**：Cloud Auth 签发短时断言，含 `aud=mira:who-you`、`draftId`、`draftVersion`、`contentHash`、`actor=user`、单次 `nonce`。需核实 Cloud Auth 是否支持自定义断言与 nonce 消费。
- **方案 B**：Mira 客户端后端写入确认记录，`send` 只消费该记录。需确认后端归属、鉴权与重放防护。

两种方案都必须满足：用户未在客户端看到该版本草稿 → 不可能产生有效凭证。

## 验收证据

1. 无确认凭证调用 `send`：拒绝，且无任何外发尝试。
2. 确认后修改草稿（任一字段 / 附件）再 `send`：`draft_version_conflict` 或哈希不一致，拒绝。
3. 同一凭证重复调用：只发一封，第二次返回既有回执。
4. 过期 / 已消费凭证：显式拒绝，错误码可区分。
5. 外部真实收件箱收到邮件；邮件头通过 SPF、DKIM、DMARC 校验。
6. `send` 入参无法覆盖收件人 / 正文 / 附件（测试构造多余字段被拒或忽略均需明确契约）。
7. 日志无地址、主题、正文、附件名；回执含 ID 与状态，不含 PII。
8. relay 不可用时返回 `relay_unavailable`，邮件不伪装为已发送。

## 依赖与阻塞

- S1 已合入：mailbox、message、thread、存储与读工具可用。
- v1 §10 P0 #8–#11 必须闭环：relay 部署形态、25 端口、鉴权、Cloud Auth 断言 / 客户端会话边界。
- 需要独立安全审批后才能签发 `whoyou.mail.send` 并启用真实发送。

## 待决

1. 确认凭证走 A 还是 B。
2. relay 走 HTTPS API 还是 Worker `cloudflare:sockets` 直连 587/465。
3. relay 自建还是托管 SMTP 服务。
4. 确认凭证 TTL（提案 ≤10 分钟）与附件是否参与确认展示。
5. 首版每日发送配额与单封收件人数上限。
