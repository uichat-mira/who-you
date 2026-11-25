# 狐邮 · Mira ID 应用实例 V1

OPS-048 实现合同；部署验收另行记录。每个部署独立配置稳定 APP_ID、HTTPS origin 与登记 AppSecret，不再使用管理员预注册或管理 token。

## 部署绑定
- WHOYOU_APP_ID：部署时生成的稳定随机标识（例如 UUID），不能随 Worker 重启生成。迁移已有实例时保持不变。
- WHOYOU_APP_SECRET：部署时用安全随机数生成至少 32 字节并通过秘密管理系统存放；仅用于登记验证，不是 OAuth client_secret。不要输出到日志、源码或公开页面。
- WHOYOU_MANIFEST_REVISION：正整数，声明变更时递增；变更后用户需重新授权。
- MCP_RESOURCE_URL：部署自身精确 HTTPS /mcp URI。网页、回调、OAuth clientId、manifest 和 resource 均从同一 origin 派生。
- CLOUD_AUTH_ISSUER / CLOUD_AUTH_JWKS_URL：可信 Mira ID HTTPS 授权服务器及公钥。
- WHOYOU_WEB_SESSION_KEY：部署独立的 32 字节 AES-GCM cookie 密钥。已有旧格式会话不能迁移；重新登录。
- 原有 D1/R2、提供商凭据、同步配置不变。

## 登记与登录
在 Mira ID 我的应用中输入 HTTPS Origin、APP_ID、AppSecret。公开 GET /.well-known/mira-application 自动声明回调和只读 mail 服务；POST /mira/verify-registration 只接受精确 appId/appSecret，并仅返回 ok/appId。部署验证使用 Cloud Auth 当前合同，不能把 AppSecret 传给 OAuth。

网页采用授权码 + PKCE S256，校验 state、appId、issuer、subject、clientId、expiry；凭据封装于 HttpOnly/Secure/SameSite=Lax 加密 cookie，所有受保护业务操作查询 /v1/oauth/application-session 复核。退出使用 application-session/logout。账号会话不等于 Agent MCP grant；Web 不请求设备短票。

## 邮箱业务与 MCP
Web 邮箱列表、Gmail 连接、解绑及同步复用内部业务服务及真实账号主体。现有同源 POST、provider state/PKCE 单次消费、邮箱所有权、同步 lease 继续生效；Gmail 回调必须持有有效应用会话和密封 flow cookie，不允许裸回调绕过。应用登录不授权 Google，也不提供智能体写/发权限。MCP 的独立业务确认逻辑保留，不以浏览器会话替代。

MCP 2026-07-28 官方 SDK strict handler，拒绝旧 initialize；JWT 校验 EdDSA/JWKS、issuer、app_id、service_id=mail、resource/aud、sub、device_id、iat/nbf/exp、精确声明 whoyou.read。账号以 sub 隔离。旧 named audience、consumer_id、username claim 不再接受。MCP 与下载路由使用同一 verifier；未授权的写/发送不得运行，已签离线票至 exp 自然失效。

真实 T3/T4 验证须注明使用的 Cloud Auth/狐邮 SHA 和隔离环境。仅 fixture 验证不能证明跨仓部署。生产未获本卡授权。

## 本地真实纵切（非公网 T4）
在狐邮执行 npm ci 和 npm run build:tests。在已安装依赖并构建 contracts 的 Cloud Auth 独立 checkout 的 apps/api 目录执行：

    pnpm exec tsx /absolute/who-you/tests/ops048-v1-real-issuer.mjs /absolute/cloud-auth

脚本使用真实 Cloud Auth Fastify/SQLite、真实 Worker、真实签名/JWKS 和合成邮箱，传输边界用注入适配器桥接；不替代 Cloud Auth HTTPS DNS/IP 安全传输、公网部署或 Mobile 真机验收。所有密钥运行时生成。
