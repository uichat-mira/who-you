import { handleInboundEmail } from "./mail/inbound";
import { createMailServices, type WhoYouEnv } from "./mail/config";
import { runDeliverabilityReport } from "./mail/deliverability";
import {
	createDownloadVerifier,
	handleSignedDownload,
	MAIL_DOWNLOAD_PATH,
} from "./mail/download";
import { handleGmailCallback, GMAIL_SYNC_CRON, runGmailSyncSweep } from "./mail/gmail-http";
import { GMAIL_CALLBACK_PATH } from "./mail/gmail-link";
import { runImapSyncSweep } from "./mail/imap-http";
import { handleMicrosoftCallback, runMicrosoftSyncSweep } from "./mail/microsoft-http";
import { MICROSOFT_CALLBACK_PATH } from "./mail/microsoft-link";
import { runRetentionSweep } from "./mail/retention";
import { DELIVERY_WEBHOOK_PATH, handleDeliveryWebhook } from "./mail/webhook";
import { MCP_METADATA_PATH, MCP_RESOURCE_PATH } from "./mcp/config";
import { createWhoYouRuntime } from "./mcp/runtime";

const notFound = (): Response => Response.json({ error: "not_found" }, { status: 404 });

export default {
	async fetch(request: Request, env: WhoYouEnv): Promise<Response> {
		const path = new URL(request.url).pathname;
		// The relay callback is machine-to-machine only: it authenticates with an
		// independent HMAC secret and never with an agent's MCP credential.
		if (path === DELIVERY_WEBHOOK_PATH) {
			return handleDeliveryWebhook(request, env);
		}
		// The OAuth callback is browser-facing and authenticated by the one-time
		// `state` plus PKCE verifier, never by an MCP bearer.
		if (path === GMAIL_CALLBACK_PATH) {
			return handleGmailCallback(request, env);
		}
		if (path === MICROSOFT_CALLBACK_PATH) {
			return handleMicrosoftCallback(request, env);
		}
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
	 * Two schedules share this handler. The five-minute tick only advances
	 * third-party sync cursors; the daily tick keeps audit expiry and the
	 * deliverability report on their existing cadence.
	 */
	async scheduled(controller: ScheduledController, env: WhoYouEnv): Promise<void> {
		if (controller.cron === GMAIL_SYNC_CRON) {
			await runGmailSyncSweep(env);
			await runMicrosoftSyncSweep(env);
			await runImapSyncSweep(env);
			return;
		}
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
				deletedDeliveryEvents: result.deletedDeliveryEvents,
				deletedWebhookNonces: result.deletedWebhookNonces,
			}),
		);
		const report = await runDeliverabilityReport(
			services.services.repository,
			Date.now(),
		);
		// Counters only: the daily reputation metric never names an address.
		console.log(JSON.stringify({ event: "whoyou_delivery_reputation", ...report }));
	},
} satisfies ExportedHandler<WhoYouEnv>;
