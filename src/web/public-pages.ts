// Static public disclosures. No account, provider, session or environment data is interpolated.
export const publicFooter = `<footer class="public-footer"><a href="/">首页</a><a href="/privacy">隐私政策</a><a href="/terms">服务条款</a></footer>`;

export const publicIntroduction = `<section class="public-intro" aria-label="关于狐邮">
<h2>狐邮是什么</h2>
<p>Who You（狐邮）是独立维护的邮件能力服务（MCP Server）。它集中管理邮箱身份与授权，为用户明确授权的 Mira 等客户端提供邮件查询、读取、草稿与发送能力。实际可用能力取决于邮箱服务商授权、部署配置及客户端权限。当前网页提供 Mira 云账号登录、邮箱连接管理、Gmail 授权与解绑入口；Microsoft 与 IMAP/SMTP 接入尚未开放。</p>
<h2>为什么需要 Gmail 权限</h2>
<p><code>gmail.readonly</code> 用于识别邮箱、读取和同步用户授权的邮件；<code>gmail.send</code> 用于用户确认后的发信。登录 Mira 不会自动授予这些权限。当前预览服务尚未开启定时同步，真实 Gmail 接入仍在验收。</p>
<p>连接前请阅读<a href="/privacy">隐私政策</a>与<a href="/terms">服务条款</a>。你可以在邮箱管理中撤销连接。</p>
</section>`;

export const privacyPolicy = `<article class="legal">
<h1>隐私政策</h1>
<p class="footnote">Who You（狐邮） · 更新日期：2026 年 11 月 22 日</p>
<p>本政策适用于 who-you.tomz.io，由 Who You 项目维护者提供的邮件能力服务。我们通过独立的 Mira Cloud Auth 验证身份，通过用户另行授权的邮箱服务商提供邮件能力。本政策适用于狐邮处理的数据，不代替 Google 或独立客户端的隐私政策。</p>
<h2>1. 访问的数据及用途</h2>
<p>狐邮处理 Mira 云账号标识、登录会话、邮箱地址、提供商、连接状态、授权范围和必要的操作审计信息，用于身份验证、账号隔离、连接管理及安全防护。账户主密码由 Cloud Auth 登录页处理，不由狐邮索取或保存。</p>
<p>连接 Gmail 时，狐邮通过 Google OAuth 请求以下权限：</p>
<ul><li><code>https://www.googleapis.com/auth/gmail.readonly</code>：获取邮箱身份，以及在获准的邮件读取、查询和同步功能中读取邮件地址、主题、时间、正文、附件与同步游标。</li><li><code>https://www.googleapis.com/auth/gmail.send</code>：在用户确认后通过 Gmail 发送邮件，包括收件人、主题、正文及附件。该权限不代表狐邮可以自主发送邮件。</li></ul>
<p>狐邮不申请 Google 联系人、日历或 Drive 权限。当前网页用于连接管理，邮箱定时同步尚未启用；尚未开放的客户端能力不得被视为已可用。</p>
<h2>2. 存储与保护</h2>
<p>狐邮运行在 Cloudflare Workers，使用 D1 存储账号关联、授权状态、必要的邮件元数据及审计记录，并使用 R2 保存实际同步的邮件内容与附件。OAuth refresh token 按账号进行 AES-256-GCM 信封加密，密钥由服务端管理；Google access token 仅在执行授权操作时使用，不持久化。浏览器使用受保护的会话 Cookie；授权过程使用一次性状态及 PKCE。服务通过 HTTPS 传输，不提供邮件端到端加密。邮件内容依赖存储平台和服务访问控制保护。</p>
<h2>3. 数据共享与 AI 使用限制</h2>
<p>为提供邮件功能，数据会在 Google Gmail API、狐邮的 Cloudflare 托管基础设施和用户明确授权的 MCP 客户端之间按必要范围处理。Cloud Auth 负责身份与服务凭证，不接收 Gmail refresh token 或邮件正文。邮件发送时，内容由邮件服务商交付给用户指定的收件人。</p>
<p>如果用户选择通过 Mira 或其他获准客户端调用邮件工具，必要的邮件结果可返回该客户端，用于用户要求的查询、摘要或邮件处理；客户端后续将内容交给外部 AI 服务前，须明确告知用户处理目的和接收方并取得许可。狐邮不把邮件数据用于广告、出售、画像交易、信用评估、监控或通用 AI/机器学习模型训练，也不允许接入方将 Google 用户数据用于这些目的。狐邮自身不运行邮件内容的模型训练。</p>
<p>除提供用户明确授权的功能、处理安全事件或履行法律义务外，不向其他方转移 Google 用户数据。人工访问邮件内容仅限 Google 政策允许的情形，例如用户明确同意查看特定内容、必要安全调查或法律要求。</p>
<h2>4. 保留、撤销与删除</h2>
<p>连接期间，狐邮保留提供邮件功能所需的授权凭据和已同步副本。用户可在<a href="/account/mailboxes">邮箱管理</a>中解绑 Gmail；狐邮会尝试撤销 Google 授权并删除本地凭据、该邮箱的同步邮件、附件和对象。若 Google 撤销未确认，仍执行本地删除，用户也可在<a href="https://myaccount.google.com/connections">Google 账号连接管理</a>取消授权。解绑不删除 Google 原始邮箱内的邮件，也不能收回已发送给收件人的邮件或已导出到独立客户端的副本。</p>
<p>定时清理尚未启用，必要的安全审计记录可能在解绑后保留；如需删除账号关联数据、咨询保留情况或行使数据相关权利，请通过下方联系邮箱提出请求。我们核实身份后处理。已被其他服务依法保留的数据由其各自政策约束。</p>
<h2>5. Google Limited Use 声明</h2>
<p>狐邮对从 Google API 获得的信息的使用与传输遵守 <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>，包括 Limited Use（有限使用）要求，以及适用的 <a href="https://developers.google.com/workspace/workspace-api-user-data-developer-policy">Google Workspace 用户数据与开发者政策</a>。如需改变数据使用目的，将先更新告知并按要求取得新的授权或同意。</p>
<h2>6. 联系</h2>
<p>数据访问、删除、授权或隐私问题：<a href="mailto:dangjingtao@gmail.com">dangjingtao@gmail.com</a>。请勿通过邮件发送密码、OAuth 凭据或不必要的邮件正文。</p>
</article>`;

export const serviceTerms = `<article class="legal">
<h1>服务条款</h1>
<p class="footnote">Who You（狐邮） · 更新日期：2026 年 11 月 22 日</p>
<p>本条款适用于 who-you.tomz.io 提供的邮件能力服务。使用狐邮前请阅读本条款及<a href="/privacy">隐私政策</a>。</p>
<h2>1. 服务范围</h2>
<p>狐邮是由项目维护者独立提供的邮件 MCP 服务，当前处于接入验收阶段。Mira Cloud Auth 提供账号身份验证；邮箱服务商负责邮箱及其授权。网页主要提供邮箱连接配置，尚未开通的提供商或客户端能力不构成可用性承诺。</p>
<h2>2. 账号与授权</h2>
<p>你只能连接自己有权管理的邮箱，并负责保护账号和授权。连接、重授权、解绑与发信应由用户明确授权；发送邮件须经过逐封确认。你可以随时断开狐邮连接或在邮箱服务商处撤销授权。</p>
<h2>3. 合理使用</h2>
<p>不得利用狐邮进行垃圾邮件、欺诈、未经授权的邮箱访问、监控、恶意自动化、身份冒用或违反 Google 等提供商政策的活动。接入的客户端必须尊重用户许可及数据使用限制，不得将 Google 邮件数据用于通用模型训练或未获许可的第三方用途。</p>
<h2>4. 可用性与终止</h2>
<p>服务可能因维护、外部提供商限制、授权失效或安全事件而暂停。我们不会保证尚在验收的功能持续可用；出现问题时请联系维护者。你可以停止使用或解绑邮箱，数据处理见隐私政策；服务方也可为安全或合规原因限制滥用。上述说明不排除适用法律规定的用户权利。</p>
<h2>5. 联系与变更</h2>
<p>服务与授权问题请联系 <a href="mailto:dangjingtao@gmail.com">dangjingtao@gmail.com</a>。重大服务或数据用途变更将通过适当方式告知，必要时重新取得同意。</p>
</article>`;
