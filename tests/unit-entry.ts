export {
	normalizeDomain,
	normalizeLocalPart,
	resolveRecipient,
	RESERVED_LOCAL_PARTS,
} from "../src/mail/address";
export {
	DEFAULT_MAIL_LIMITS,
	resolveMailLimits,
} from "../src/mail/limits";
export {
	MailParseError,
	parseAuthVerdict,
	parseInboundMail,
	sanitizeFilename,
} from "../src/mail/mime";
export { normalizeSearchQuery } from "../src/mail/search";
export { LOCAL_PART_RULES, decideLocalPart } from "../src/mail/provision";
export { createResendMailSender } from "../src/mail/send";
export {
	SIGNED_DOWNLOAD_TTL_MS,
	buildDownloadUrl,
	createDownloadSigner,
} from "../src/mail/download";
export { ZipArchive } from "../src/mail/zip";
export { DEFAULT_RETENTION, resolveRetention, runRetentionSweep } from "../src/mail/retention";
export { sanitizeHtml } from "../src/mail/sanitize";
export {
	buildDraftContent,
	canonicalDraftPayload,
	draftContentHash,
} from "../src/mail/draft";
export { createCloudAuthConfirmationVerifier } from "../src/mcp/confirmation";
export {
	CredentialCryptoError,
	base64Bytes,
	bytesBase64,
	credentialAad,
	dekWrapAad,
	openSecret,
	parseKek,
	rewrapDek,
	sealSecret,
} from "../src/mail/credential-crypto";
export { resolveCredentialKeys } from "../src/mail/config";
export { mailObjectKeys } from "../src/mail/store";
export {
	DEFAULT_ABUSE_POLICY,
	evaluateAbuse,
	resolveAbusePolicy,
} from "../src/mail/abuse";
export { normalizeRecipient, parseDeliveryReport } from "../src/mail/dsn";
export {
	computeWebhookSignature,
	verifyWebhookSignature,
	webhookSigningPayload,
} from "../src/mail/webhook";
export {
	authInfoFromPrincipal,
	createCloudAuthVerifier,
	principalFromAuthInfo,
} from "../src/mcp/auth";
export {
	CLOUD_AUTH_TOKEN_ISSUER,
	MCP_METADATA_PATH,
	MCP_RESOURCE_PATH,
	WHOYOU_MAIL_SEND_SCOPE,
	WHOYOU_MAIL_WRITE_SCOPE,
	WHOYOU_REQUIRED_SCOPE,
	WHOYOU_SERVICE_AUDIENCE,
	resolveMcpConfig,
} from "../src/mcp/config";
export {
	GMAIL_READONLY_SCOPE,
	GMAIL_SCOPES,
	GMAIL_SEND_SCOPE,
	GOOGLE_AUTHORIZATION_ENDPOINT,
	GOOGLE_REVOCATION_ENDPOINT,
	GOOGLE_TOKEN_ENDPOINT,
	OAuthProviderError,
	createGoogleOAuthClient,
	createOAuthState,
	createPkcePair,
	hasRequiredGmailScope,
} from "../src/mail/oauth-client";
export { GmailApiError, createGmailClient } from "../src/mail/gmail-client";
export { buildRfc822Message, encodeRawMessage } from "../src/mail/rfc822";
export { resolveGmailOAuthConfig } from "../src/mail/gmail-link";
export { decodeBase64Url, encodeBase64Url } from "../src/mail/base64url";
