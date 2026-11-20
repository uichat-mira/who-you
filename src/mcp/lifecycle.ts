import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MailServices } from "../mail/config";
import {
	buildDownloadUrl,
	createDownloadSigner,
	SIGNED_DOWNLOAD_TTL_MS,
} from "../mail/download";
import { createExport, deleteMailbox, deleteMessage } from "../mail/lifecycle";
import type { WhoYouPrincipal } from "./auth";
import {
	failure,
	requireWriteScope,
	success,
	UNTRUSTED_EMAIL_CONTENT,
	type ToolResult,
} from "./mail";

export const MAIL_EXPORT_TOOL = "whoyou_mail_export";
export const MAIL_MESSAGE_DELETE_TOOL = "whoyou_mail_message_delete";
export const MAIL_MAILBOX_DELETE_TOOL = "whoyou_mail_mailbox_delete";

const EXPORT_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const DESTRUCTIVE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const SAFE_ID = z.string().trim().min(1).max(80);

const EXPORT_DETAILS: Record<string, string> = {
	mailbox_not_provisioned:
		"No mailbox is provisioned for this account, so there is nothing to export.",
	export_rate_limited:
		"An export was already created for this account today. The limit is one export per UTC day; retry tomorrow.",
	export_too_large:
		"The mailbox is larger than this slice's export ceiling. Narrow it by deleting unneeded mail first; the ceiling is configurable per deployment.",
	export_download_unavailable:
		"Signed downloads are not configured for this deployment, so no export link can be issued.",
};

/**
 * Export and deletion tools. Every one is account-scoped by the bearer token and
 * touches no caller-supplied account id.
 */
export function registerLifecycleTools(
	server: McpServer,
	principal: WhoYouPrincipal,
	services: MailServices,
): void {
	const { repository, limits } = services;
	const accountId = principal.accountId;

	server.registerTool(
		MAIL_EXPORT_TOOL,
		{
			title: "Who You mail export",
			description:
				"Creates one ZIP for the caller's whole mailbox: every message as raw EML plus a JSON manifest, then returns a 5-minute signed link bound to your bearer token. Limited to one export per account per UTC day and every export is audited. The link is not public and must not be shared.",
			inputSchema: z.object({}),
			annotations: EXPORT_ANNOTATIONS,
		},
		async () => {
			const signer = createDownloadSigner(services.signingKey);
			if (!signer || !services.resourceUrl) {
				return failure(
					"export_download_unavailable",
					EXPORT_DETAILS.export_download_unavailable,
				);
			}
			const now = Date.now();
			const result = await createExport(repository, {
				accountId,
				now,
				maxMessages: limits.exportMaxMessages,
				maxBytes: limits.exportMaxBytes,
			});
			if (!result.ok) return failure(result.code, EXPORT_DETAILS[result.code]);

			const target = {
				kind: "export" as const,
				accountId,
				id: result.record.id,
				messageId: "",
				expiresAt: now + SIGNED_DOWNLOAD_TTL_MS,
			};
			const signature = await signer.sign(target);
			const downloadUrl = buildDownloadUrl(services.resourceUrl, target, signature);
			return success(
				[
					"# Who You · export",
					`> ${UNTRUSTED_EMAIL_CONTENT}: the archive contains untrusted mail data.`,
					`- export: \`${result.record.id}\``,
					`- messages: ${result.record.messageCount} (${result.skipped} raw object(s) missing)`,
					`- size: ${result.record.byteSize} bytes`,
					`- expires: ${new Date(target.expiresAt).toISOString()}`,
					`- link: ${downloadUrl}`,
					"",
					"Fetch this link with the same bearer token you used for this tool. One export per UTC day; the action is recorded in the account audit log.",
				].join("\n"),
				{
					untrusted: true,
					exportId: result.record.id,
					messageCount: result.record.messageCount,
					skippedCount: result.skipped,
					byteSize: result.record.byteSize,
					exportDay: result.record.exportDay,
					downloadUrl,
					expiresAt: target.expiresAt,
				},
			);
		},
	);

	server.registerTool(
		MAIL_MESSAGE_DELETE_TOOL,
		{
			title: "Who You delete message",
			description:
				"Permanently deletes one trashed message: R2 objects first, then the D1 rows. Re-running is safe and idempotent. Trash the message with whoyou_mail_flag_set first; a non-trashed message fails explicitly. Requires the whoyou.mail.write scope.",
			inputSchema: z.object({ messageId: SAFE_ID }),
			annotations: DESTRUCTIVE,
		},
		async (args) => {
			const denied: ToolResult | null = requireWriteScope(principal);
			if (denied) return denied;
			const result = await deleteMessage(repository, {
				accountId,
				messageId: args.messageId,
				now: Date.now(),
			});
			if (!result.ok) {
				return failure(
					"message_not_trashed",
					"Move the message to trash first (whoyou_mail_flag_set with trashed: true); permanent delete only applies to trashed mail.",
				);
			}
			return success(
				[
					"# Who You · delete message",
					`- message: \`${args.messageId}\``,
					`- deleted objects: ${result.deletedObjects}`,
					`- deleted rows: ${result.deletedRows}`,
					`- already deleted: ${result.alreadyDeleted}`,
				].join("\n"),
				{
					messageId: args.messageId,
					deletedObjects: result.deletedObjects,
					deletedRows: result.deletedRows,
					alreadyDeleted: result.alreadyDeleted,
				},
			);
		},
	);

	server.registerTool(
		MAIL_MAILBOX_DELETE_TOOL,
		{
			title: "Who You delete mailbox",
			description:
				"Erases the caller's entire mailbox: every R2 object first, then all D1 rows (messages, threads, drafts, nonces, receipts, exports, audit). Re-running is safe and idempotent. This is user-initiated erasure and cannot be undone; pass confirm: true. Requires the whoyou.mail.write scope.",
			inputSchema: z.object({ confirm: z.boolean() }),
			annotations: DESTRUCTIVE,
		},
		async (args) => {
			const denied: ToolResult | null = requireWriteScope(principal);
			if (denied) return denied;
			if (args.confirm !== true) {
				return failure(
					"confirmation_required",
					"This permanently erases the whole mailbox. Re-run with confirm: true.",
				);
			}
			const result = await deleteMailbox(repository, { accountId, now: Date.now() });
			return success(
				[
					"# Who You · delete mailbox",
					`- deleted objects: ${result.deletedObjects}`,
					`- already deleted: ${result.alreadyDeleted}`,
					"",
					"All mailbox rows and storage objects are gone. Provisioning a new mailbox is not available through this tool.",
				].join("\n"),
				{ deletedObjects: result.deletedObjects, alreadyDeleted: result.alreadyDeleted },
			);
		},
	);
}
