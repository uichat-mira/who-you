import { bindings, defineConfig, triggers } from "cf/config";

// The Worker is intentionally configured without MCP bindings. A deployment
// that has not supplied MCP_RESOURCE_URL / CLOUD_AUTH_ISSUER /
// CLOUD_AUTH_JWKS_URL / WHOYOU_APP_ID is closed (503 mcp_not_configured).
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
			// Mail domain for this deployment. The zone lives in the same account and
			// has Email Routing enabled (MX, SPF, DKIM); which addresses reach this
			// Worker is decided by the zone's Email Routing rules, not by this file.
			MAIL_DOMAIN: bindings.text("tzt2026.xyz"),
			// The default deployment must not start polling real providers.
			// An approved target can explicitly bind MAIL_SCHEDULE_SYNC_PROVIDERS
			// after separate real-mail acceptance and deployment authorization.
		},
		// Daily: retention expiry, deliverability report.
		// Every five minutes: provider sync runs only after a separate explicit allowlist opt-in.
		triggers: [
			triggers.scheduled({ schedule: "17 3 * * *" }),
			triggers.scheduled({ schedule: "*/5 * * * *" }),
		],
	},
});
