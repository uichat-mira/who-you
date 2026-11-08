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
export { sanitizeHtml } from "../src/mail/sanitize";
export { mailObjectKeys } from "../src/mail/store";
export {
	authInfoFromPrincipal,
	createCloudAuthVerifier,
	principalFromAuthInfo,
} from "../src/mcp/auth";
export {
	CLOUD_AUTH_TOKEN_ISSUER,
	MCP_METADATA_PATH,
	MCP_RESOURCE_PATH,
	WHOYOU_REQUIRED_SCOPE,
	WHOYOU_SERVICE_AUDIENCE,
	resolveMcpConfig,
} from "../src/mcp/config";
