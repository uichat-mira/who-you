import {
	CLOUD_AUTH_TOKEN_ISSUER,
	MCP_METADATA_PATH,
	MCP_RESOURCE_PATH,
	type McpEnv,
} from "../src/mcp/config";
import { createWhoYouRuntime } from "../src/mcp/runtime";
import { createFixtureVerifier } from "./fixtures";

/** Test-only Worker entry: deterministic verifier, never selected by deployed env. */
export default {
	async fetch(request: Request, env: McpEnv): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path !== MCP_RESOURCE_PATH && path !== MCP_METADATA_PATH) {
			return Response.json({ error: "not_found" }, { status: 404 });
		}
		const resolved = createWhoYouRuntime(env, {
			verifier: createFixtureVerifier({
				issuer: CLOUD_AUTH_TOKEN_ISSUER,
				audience: env.MCP_AUDIENCE ?? "",
			}),
		});
		if (!resolved.ok) {
			return Response.json(
				{ error: "mcp_not_configured", reason: resolved.reason },
				{ status: 503 },
			);
		}
		return resolved.runtime.fetch(request);
	},
} satisfies ExportedHandler<McpEnv>;
