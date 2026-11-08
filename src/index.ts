import { handleInboundEmail } from "./mail/inbound";
import type { WhoYouEnv } from "./mail/config";
import { MCP_METADATA_PATH, MCP_RESOURCE_PATH } from "./mcp/config";
import { createWhoYouRuntime } from "./mcp/runtime";

const notFound = (): Response => Response.json({ error: "not_found" }, { status: 404 });

export default {
	async fetch(request: Request, env: WhoYouEnv): Promise<Response> {
		const path = new URL(request.url).pathname;
		// There is deliberately one agent-facing surface: `/mcp` plus its RFC 9728
		// discovery document. No parallel REST Agent API exists in this slice.
		if (path !== MCP_RESOURCE_PATH && path !== MCP_METADATA_PATH) {
			return notFound();
		}

		const resolved = createWhoYouRuntime(env);
		if (!resolved.ok) {
			return Response.json(
				{ error: "mcp_not_configured", reason: resolved.reason },
				{ status: 503 },
			);
		}
		return resolved.runtime.fetch(request);
	},

	/**
	 * Cloudflare Email Routing entry. S1 only receives, validates, stores and
	 * quarantines; it never sends, copies or forwards.
	 */
	async email(message: ForwardableEmailMessage, env: WhoYouEnv): Promise<void> {
		await handleInboundEmail(message, env);
	},
} satisfies ExportedHandler<WhoYouEnv>;
