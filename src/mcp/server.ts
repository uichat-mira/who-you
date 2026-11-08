import {
	createMcpHandler,
	hostHeaderValidationResponse,
	McpServer,
	originValidationResponse,
	requireBearerAuth,
	type AuthInfo,
	type OAuthProtectedResourceMetadata,
	type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
	authInfoFromPrincipal,
	principalFromAuthInfo,
	type WhoYouTokenVerifier,
} from "./auth";
import {
	WHOYOU_MCP_SERVER_NAME,
	WHOYOU_MCP_SERVER_VERSION,
	buildMcpProtectedResourceMetadata,
	type McpConfig,
} from "./config";
import {
	READ_ONLY_ANNOTATIONS,
	WHOAMI_OUTPUT_SCHEMA,
	WHOAMI_TOOL_DESCRIPTION,
	WHOAMI_TOOL_NAME,
	renderWhoamiMarkdown,
	type WhoamiResult,
} from "./capabilities";
import { registerMailTools } from "./mail";
import { registerDraftTools, type DraftToolDependencies } from "./drafts";
import type { MailServices } from "../mail/config";

const MAX_REQUEST_BODY_BYTES = 256 * 1024;

function buildMcpServer(
	authInfo: AuthInfo | undefined,
	services: MailServices,
	tools: DraftToolDependencies,
): McpServer {
	const principal = principalFromAuthInfo(authInfo);
	const server = new McpServer(
		{ name: WHOYOU_MCP_SERVER_NAME, version: WHOYOU_MCP_SERVER_VERSION },
		{ capabilities: { tools: {} }, maxToolInputElements: 100 },
	);

	server.registerTool(
		WHOAMI_TOOL_NAME,
		{
			title: "Who You caller identity",
			description: WHOAMI_TOOL_DESCRIPTION,
			outputSchema: WHOAMI_OUTPUT_SCHEMA,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async () => {
			const identity: WhoamiResult = {
				accountId: principal.accountId,
				consumerId: principal.consumerId,
				scopes: [...principal.scopes],
			};
			return {
				content: [{ type: "text", text: renderWhoamiMarkdown(identity) }],
				structuredContent: identity,
			};
		},
	);

	registerMailTools(server, principal, services);
	registerDraftTools(server, principal, services, tools);

	return server;
}

export type WhoYouMcpRuntime = {
	metadata: OAuthProtectedResourceMetadata;
	fetch(request: Request): Promise<Response>;
	close(): Promise<void>;
};

const metadataResponse = (
	request: Request,
	metadata: OAuthProtectedResourceMetadata,
): Response => {
	if (request.method === "OPTIONS") {
		const requested = request.headers.get("access-control-request-headers");
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
				...(requested ? { "Access-Control-Allow-Headers": requested } : {}),
			},
		});
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return Response.json(
			{ error: "method_not_allowed" },
			{
				status: 405,
				headers: {
					Allow: "GET, HEAD, OPTIONS",
					"Access-Control-Allow-Origin": "*",
				},
			},
		);
	}
	const body = request.method === "HEAD" ? null : JSON.stringify(metadata);
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=300",
			"Access-Control-Allow-Origin": "*",
		},
	});
};

/**
 * Builds the isolated Streamable HTTP `/mcp` surface. The SDK handler owns MCP
 * protocol semantics; this wrapper owns Host/Origin validation, bearer
 * verification, protected-resource discovery and the fail-closed path routing.
 */
export function createWhoYouMcp(
	config: McpConfig,
	verifier: WhoYouTokenVerifier,
	services: MailServices,
	tools: DraftToolDependencies,
): WhoYouMcpRuntime {
	const tokenVerifier: OAuthTokenVerifier = {
		async verifyAccessToken(token: string): Promise<AuthInfo> {
			return authInfoFromPrincipal(
				token,
				await verifier.verifyAccessToken(token),
				config.resourceUrl,
			);
		},
	};
	const gate = requireBearerAuth({
		verifier: tokenVerifier,
		requiredScopes: config.requiredScopes,
		expectedResource: config.resourceUrl,
		resourceMetadataUrl: config.metadataUrl,
	});
	const handler = createMcpHandler(
		({ authInfo }) => buildMcpServer(authInfo, services, tools),
		{ legacy: "stateless", maxRequestBodySize: MAX_REQUEST_BODY_BYTES },
	);
	const metadata = buildMcpProtectedResourceMetadata(config);
	const metadataPath = new URL(config.metadataUrl).pathname;

	return {
		metadata,
		async fetch(request: Request): Promise<Response> {
			const path = new URL(request.url).pathname;
			if (path !== metadataPath && path !== config.resourceUrl.pathname) {
				return Response.json({ error: "not_found" }, { status: 404 });
			}

			const hostRejected = hostHeaderValidationResponse(request, [
				config.resourceUrl.hostname,
			]);
			if (hostRejected) return hostRejected;

			// RFC 9728 discovery is public metadata that browser clients fetch
			// cross-origin. Host validation still blocks DNS rebinding, but the
			// same-origin gate below applies only to the agent-facing `/mcp` surface.
			if (path === metadataPath) return metadataResponse(request, metadata);

			const originRejected = originValidationResponse(request, [
				config.resourceUrl.hostname,
			]);
			if (originRejected) return originRejected;

			const auth = await gate(request);
			if (auth instanceof Response) return auth;
			return handler.fetch(request, { authInfo: auth });
		},
		close: () => handler.close(),
	};
}
