import {
	MCP_METADATA_PATH,
	MCP_RESOURCE_PATH,
	type McpEnv,
} from "./mcp/config";
import { createWhoYouRuntime } from "./mcp/runtime";

const notFound = (): Response => Response.json({ error: "not_found" }, { status: 404 });

export default {
	async fetch(request: Request, env: McpEnv): Promise<Response> {
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
} satisfies ExportedHandler<McpEnv>;
