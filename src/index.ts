import { handleInboundEmail } from "./mail/inbound";
import { createMailServices, type WhoYouEnv } from "./mail/config";
import {
	createDownloadVerifier,
	handleSignedDownload,
	MAIL_DOWNLOAD_PATH,
} from "./mail/download";
import { runRetentionSweep } from "./mail/retention";
import { MCP_METADATA_PATH, MCP_RESOURCE_PATH } from "./mcp/config";
import { createWhoYouRuntime } from "./mcp/runtime";

const notFound = (): Response => Response.json({ error: "not_found" }, { status: 404 });

export default {
	async fetch(request: Request, env: WhoYouEnv): Promise<Response> {
		const path = new URL(request.url).pathname;
		// `/mcp` plus its RFC 9728 discovery document is the only agent-facing API.
		// `/mail/download` is not an API for agents to call freely: it serves one
		// signed, bearer-bound object per short-lived link issued by a mail tool.
		if (path === MAIL_DOWNLOAD_PATH) {
			const verifier = createDownloadVerifier(env);
			if (!verifier) {
				return Response.json({ error: "download_not_configured" }, { status: 503 });
			}
			return handleSignedDownload(request, env, verifier);
		}
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

	/**
	 * Retention sweep. User mail has no TTL; only audit rows expire. A Cron
	 * Trigger must point at this handler in deployment; until then it is inert
	 * by design rather than silently deleting data.
	 */
	async scheduled(_controller: ScheduledController, env: WhoYouEnv): Promise<void> {
		const services = createMailServices(env);
		if (!services.ok) {
			console.log(
				JSON.stringify({
					event: "whoyou_mail_retention_skipped",
					reason: services.reason,
				}),
			);
			return;
		}
		const result = await runRetentionSweep(
			services.services.repository,
			services.services.retention,
			Date.now(),
		);
		console.log(
			JSON.stringify({
				event: "whoyou_mail_retention_sweep",
				deletedAuditEntries: result.deletedAuditEntries,
			}),
		);
	},
} satisfies ExportedHandler<WhoYouEnv>;
