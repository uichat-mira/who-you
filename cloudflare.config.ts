import { bindings, defineConfig, triggers } from "cf/config";

// The Worker is intentionally configured without MCP bindings. A deployment
// that has not supplied MCP_RESOURCE_URL / CLOUD_AUTH_ISSUER /
// CLOUD_AUTH_JWKS_URL / MCP_AUDIENCE is closed (503 mcp_not_configured).
// No hostname, Cloud Auth resource or mailbox authority is approved yet.
export default defineConfig({
	worker: {
		name: "who-you",
		compatibilityDate: "2026-08-06",
		entrypoint: "./src/index.ts",
		env: {
			// Storage bindings are required for any mail-serving path; their absence
			// closes `/mcp` with mail_storage_not_configured rather than opening it.
			DB: bindings.d1({ name: "who-you-dev" }),
			MAIL_BUCKET: bindings.r2({ name: "who-you-dev-attachments" }),
			// Declared domain only. No zone, MX record or Email Routing rule exists
			// for it yet, so nothing can reach the inbound handler.
			MAIL_DOMAIN: bindings.text("tomlab.cn"),
		},
		// Retention only deletes audit rows, delivery events and webhook nonces.
		// User mail has no TTL, so this schedule cannot expire a message.
		triggers: [triggers.scheduled({ schedule: "17 3 * * *" })],
	},
});
