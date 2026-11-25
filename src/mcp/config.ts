import {
	buildOAuthProtectedResourceMetadata,
	getOAuthProtectedResourceMetadataUrl,
	type OAuthMetadata,
	type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

export const MCP_RESOURCE_PATH = "/mcp";
/** RFC 9728 discovery location for the single `/mcp` resource. */
export const MCP_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
/** Read-only scope required by the global `/mcp` bearer gate. */
export const WHOYOU_REQUIRED_SCOPE = "whoyou.read";
/** Draft lifecycle write authority; never implied by read. */
export const WHOYOU_MAIL_WRITE_SCOPE = "whoyou.mail.write";
/** Send authority carried only by a draft-bound confirmation credential. */
export const WHOYOU_MAIL_SEND_SCOPE = "whoyou.mail.send";
/**
 * Planned local-ledger write scope. It is not issued or enforced by this slice;
 * M1 has no ledger tool yet (see docs/product-design.md §6.2).
 */
export const WHOYOU_LEDGER_WRITE_SCOPE = "whoyou.ledger.write";
/** Cloud Auth service credentials carry a deployment-neutral JWT issuer. */
export const CLOUD_AUTH_TOKEN_ISSUER = "mira:cloud-auth";
/** Dedicated Who You audience; other Mira service audiences must be rejected. */
export const WHOYOU_SERVICE_AUDIENCE = "mira:who-you";
export const WHOYOU_MCP_SERVER_NAME = "who-you";
export const WHOYOU_MCP_SERVER_VERSION = "0.1.0-who-002";

export type McpEnv = {
	MCP_RESOURCE_URL?: string;
	CLOUD_AUTH_ISSUER?: string;
	CLOUD_AUTH_JWKS_URL?: string;
	WHOYOU_APP_ID?: string;
};

export type McpConfig = {
	resourceUrl: URL;
	metadataUrl: string;
	/** OAuth authorization-server URL advertised in RFC 9728 discovery. */
	issuer: string;
	/** JWT issuer of Cloud Auth credentials, distinct from its OAuth URL. */
	tokenIssuer: string;
	jwksUrl: URL;
	audience: string;
	requiredScopes: string[];
	appId: string;
};

export type McpConfigResult =
	| { ok: true; config: McpConfig }
	| { ok: false; reason: string };

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const secureUrl = (value: string): URL | null => {
	try {
		const url = new URL(value);
		if (url.username || url.password || url.hash) return null;
		if (url.protocol === "https:") return url;
		if (url.protocol === "http:" && localHostnames.has(url.hostname)) return url;
		return null;
	} catch {
		return null;
	}
};

/**
 * Resolves the fail-closed resource-server boundary from deployment bindings.
 * Missing or malformed configuration leaves `/mcp` unconfigured rather than
 * open; there is no anonymous or fixture fallback in the deployed module.
 */
export function resolveMcpConfig(env: McpEnv): McpConfigResult {
	const resourceUrl = secureUrl(env.MCP_RESOURCE_URL?.trim() ?? "");
	if (!resourceUrl) return { ok: false, reason: "mcp_resource_url" };
	if (resourceUrl.pathname !== MCP_RESOURCE_PATH) {
		return { ok: false, reason: "mcp_resource_path" };
	}

	// This URL is for OAuth discovery, never for JWT `iss` comparison.
	const issuer = env.CLOUD_AUTH_ISSUER?.trim() ?? "";
	if (!secureUrl(issuer)) return { ok: false, reason: "cloud_auth_issuer" };

	const jwksUrl = secureUrl(env.CLOUD_AUTH_JWKS_URL?.trim() ?? "");
	if (!jwksUrl) return { ok: false, reason: "cloud_auth_jwks_url" };

	const appId = env.WHOYOU_APP_ID;
	if (!appId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(appId)) {
		return { ok: false, reason: "application_id" };
	}
	if (resourceUrl.protocol !== "https:" || resourceUrl.search ||
		resourceUrl.href !== env.MCP_RESOURCE_URL) {
		return { ok: false, reason: "mcp_resource_url" };
	}

	return {
		ok: true,
		config: {
			resourceUrl,
			metadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
			issuer,
			tokenIssuer: CLOUD_AUTH_TOKEN_ISSUER,
			jwksUrl,
			audience: resourceUrl.href,
			requiredScopes: [WHOYOU_REQUIRED_SCOPE],
			appId,
		},
	};
}

export function buildMcpProtectedResourceMetadata(
	config: McpConfig,
): OAuthProtectedResourceMetadata {
	const metadata = buildOAuthProtectedResourceMetadata({
		oauthMetadata: { issuer: config.issuer } as OAuthMetadata,
		resourceServerUrl: config.resourceUrl,
		scopesSupported: config.requiredScopes,
		resourceName: "Who You",
		serviceDocumentationUrl: new URL("https://github.com/uichat-mira/who-you"),
	});
	return {
		...metadata,
		bearer_methods_supported: ["header"],
	};
}
