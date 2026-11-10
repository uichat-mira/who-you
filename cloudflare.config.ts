import { defineConfig } from "cf/config";

// The Worker is intentionally configured without MCP bindings. A deployment
// that has not supplied MCP_RESOURCE_URL / CLOUD_AUTH_ISSUER /
// CLOUD_AUTH_JWKS_URL / MCP_AUDIENCE is closed (503 mcp_not_configured).
// No hostname, Cloud Auth resource or mailbox authority is approved yet.
export default defineConfig({
	worker: {
		name: "who-you",
		compatibilityDate: "2026-08-06",
		entrypoint: "./src/index.ts",
	},
});
