import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MailServices } from "../mail/config";
import {
	MAX_BODY_CHARS,
	MAX_RECIPIENTS_PER_FIELD,
	MAX_SUBJECT_CHARS,
	MAX_TOTAL_RECIPIENTS,
	buildDraftContent,
	draftContentHash,
	type DraftErrorCode,
	type DraftContentInput,
} from "../mail/draft";
import type { DraftCursor, DraftRecord, SendReceipt } from "../mail/draft-store";
import type { WhoYouConfirmationVerifier } from "../mail/confirmation";
import { createAbuseMonitor, createSendGate } from "../mail/deliverability";
import { sendDraft, type MailSender } from "../mail/send";
import type { WhoYouPrincipal } from "./auth";
import { WHOYOU_MAIL_WRITE_SCOPE } from "./config";
import { failure, success, type ToolResult } from "./mail";

export const DRAFT_CREATE_TOOL = "whoyou_mail_draft_create";
export const DRAFT_UPDATE_TOOL = "whoyou_mail_draft_update";
export const DRAFT_DISCARD_TOOL = "whoyou_mail_draft_discard";
export const DRAFT_GET_TOOL = "whoyou_mail_draft_get";
export const DRAFT_LIST_TOOL = "whoyou_mail_draft_list";
export const DRAFT_SEND_TOOL = "whoyou_mail_send";

export type DraftToolDependencies = {
	confirmations: WhoYouConfirmationVerifier;
	sender: MailSender | null;
};

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const WRITE_CREATE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const WRITE_UPDATE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const WRITE_DISCARD = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const SEND = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: true,
} as const;

const SAFE_ID = z.string().trim().min(1).max(80);

const ADDRESS = z.strictObject({
	name: z.string().max(128).default(""),
	address: z.string().trim().min(3).max(320),
});

const RECIPIENT_LIST = z.array(ADDRESS).max(MAX_RECIPIENTS_PER_FIELD);

const SUBJECT = z.string().max(MAX_SUBJECT_CHARS);
const BODY = z.string().max(MAX_BODY_CHARS);

const DRAFT_ERROR_DETAIL: Record<DraftErrorCode, string> = {
	no_recipients: "A draft needs at least one recipient in to, cc or bcc.",
	invalid_recipient:
		"At least one address is not accepted. Use a plain ASCII address, without display-name syntax.",
	too_many_recipients: `At most ${MAX_TOTAL_RECIPIENTS} recipients are accepted in this slice.`,
	invalid_subject: `The subject must be plain text of at most ${MAX_SUBJECT_CHARS} characters.`,
	invalid_body: `Each body must be at most ${MAX_BODY_CHARS} characters with no control characters.`,
	empty_body: "A draft needs a non-empty text or HTML body.",
};

const requireWriteScope = (principal: WhoYouPrincipal): ToolResult | null =>
	principal.scopes.includes(WHOYOU_MAIL_WRITE_SCOPE)
		? null
		: failure(
			"insufficient_scope",
			`This tool requires the ${WHOYOU_MAIL_WRITE_SCOPE} scope; the bearer token carries ${principal.scopes.join(", ") || "no scopes"}.`,
		);

const formatAddress = (entry: { name: string; address: string }): string =>
	entry.name ? `${entry.name} <${entry.address}>` : entry.address;

const formatAddresses = (entries: { name: string; address: string }[]): string =>
	entries.map(formatAddress).join(", ");

const renderDraft = (draft: DraftRecord): string =>
	[
		"# Who You · draft",
		`- draft: \`${draft.id}\``,
		`- version: ${draft.version}`,
		`- status: ${draft.status}`,
		`- content hash: \`${draft.contentHash}\``,
		`- to: ${formatAddresses(draft.content.to) || "(none)"}`,
		draft.content.cc.length ? `- cc: ${formatAddresses(draft.content.cc)}` : "",
		draft.content.bcc.length ? `- bcc: ${formatAddresses(draft.content.bcc)}` : "",
		`- subject: ${draft.content.subject || "(no subject)"}`,
		`- text: ${draft.content.text.length} characters`,
		`- html: ${draft.content.html === null ? "none" : `${draft.content.html.length} characters`}`,
		`- updated: ${new Date(draft.updatedAt).toISOString()}`,
		"",
		"To send, the user must confirm this exact version and content hash through Cloud Auth; the resulting confirmation credential is single-use.",
	]
		.filter(Boolean)
		.join("\n");

const draftJson = (draft: DraftRecord): Record<string, unknown> => ({
	draftId: draft.id,
	version: draft.version,
	contentHash: draft.contentHash,
	status: draft.status,
	to: draft.content.to,
	cc: draft.content.cc,
	bcc: draft.content.bcc,
	subject: draft.content.subject,
	text: draft.content.text,
	html: draft.content.html,
	createdAt: draft.createdAt,
	updatedAt: draft.updatedAt,
});

const receiptJson = (receipt: SendReceipt): Record<string, unknown> => ({
	receiptId: receipt.id,
	draftId: receipt.draftId,
	draftVersion: receipt.draftVersion,
	contentHash: receipt.contentHash,
	idempotencyKey: receipt.idempotencyKey,
	status: receipt.status,
	providerMessageId: receipt.providerMessageId,
	sentAt: receipt.createdAt,
});

const encodeCursor = (draft: DraftRecord): string => {
	const raw = JSON.stringify({ u: draft.updatedAt, i: draft.id });
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const decodeCursor = (value: string): DraftCursor | null => {
	try {
		const padded = value.replace(/-/g, "+").replace(/_/g, "/");
		const raw = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
		const parsed = JSON.parse(raw) as { u?: unknown; i?: unknown };
		if (typeof parsed.u !== "number" || !Number.isInteger(parsed.u)) return null;
		if (typeof parsed.i !== "string" || !parsed.i) return null;
		return { updatedAt: parsed.u, id: parsed.i.slice(0, 80) };
	} catch {
		return null;
	}
};

/**
 * Registers the S2 draft surface. Every tool derives identity from the verified
 * bearer; no account id, sender address or recipient override is accepted from
 * arguments. Attachments are not part of this slice, so an `attachments`
 * argument fails schema validation instead of being silently ignored.
 */
export function registerDraftTools(
	server: McpServer,
	principal: WhoYouPrincipal,
	services: MailServices,
	dependencies: DraftToolDependencies,
): void {
	const { repository, drafts, abuse } = services;
	const accountId = principal.accountId;
	const sendGate = createSendGate(repository);
	const abuseMonitor = createAbuseMonitor(repository, abuse);

	server.registerTool(
		DRAFT_CREATE_TOOL,
		{
			title: "Who You draft create",
			description:
				"Creates an editable outbound draft in the caller's own mailbox. Drafts are not sent. Attachments are not supported in this slice. The response carries the version and contentHash that a Cloud Auth confirmation must bind to.",
			inputSchema: z.strictObject({
				to: RECIPIENT_LIST.optional(),
				cc: RECIPIENT_LIST.optional(),
				bcc: RECIPIENT_LIST.optional(),
				subject: SUBJECT.optional(),
				text: BODY.optional(),
				html: BODY.optional(),
			}),
			annotations: WRITE_CREATE,
		},
		async (args): Promise<ToolResult> => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const mailbox = await repository.findMailboxByAccount(accountId);
			if (!mailbox) {
				return failure("mailbox_not_provisioned", "No mailbox exists for this account yet.");
			}
			const built = buildDraftContent(args);
			if (!built.ok) return failure(built.reason, DRAFT_ERROR_DETAIL[built.reason]);

			const contentHash = await draftContentHash(built.content);
			const now = Date.now();
			const draft: DraftRecord = {
				id: `drf_${crypto.randomUUID().replace(/-/g, "")}`,
				accountId,
				mailboxId: mailbox.id,
				version: 1,
				contentHash,
				content: built.content,
				status: "draft",
				createdAt: now,
				updatedAt: now,
			};
			await drafts.createDraft({
				id: draft.id,
				accountId,
				mailboxId: draft.mailboxId,
				version: draft.version,
				contentHash,
				content: built.content,
				now,
			});
			return success(renderDraft(draft), { draft: draftJson(draft) });
		},
	);

	server.registerTool(
		DRAFT_UPDATE_TOOL,
		{
			title: "Who You draft update",
			description:
				"Replaces the supplied content fields of one editable draft and returns a new version with a new contentHash. `expectedVersion` must match the current version; a stale version is rejected instead of overwriting. Omitted fields keep their current value.",
			inputSchema: z.strictObject({
				draftId: SAFE_ID,
				expectedVersion: z.number().int().positive().max(2_147_483_647),
				to: RECIPIENT_LIST.optional(),
				cc: RECIPIENT_LIST.optional(),
				bcc: RECIPIENT_LIST.optional(),
				subject: SUBJECT.optional(),
				text: BODY.optional(),
				html: BODY.optional(),
			}),
			annotations: WRITE_UPDATE,
		},
		async (args): Promise<ToolResult> => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const existing = await drafts.getDraft(accountId, args.draftId);
			if (!existing) {
				return failure("draft_not_found", "No such draft exists in your mailbox.");
			}
			if (existing.status !== "draft") {
				return failure("draft_discarded", "This draft was discarded and can no longer be edited.");
			}
			if (existing.version !== args.expectedVersion) {
				return failure(
					"draft_version_conflict",
					`The draft is at version ${existing.version}; re-read it and retry with that version.`,
				);
			}

			const overlay: DraftContentInput = {
				to: args.to ?? existing.content.to,
				cc: args.cc ?? existing.content.cc,
				bcc: args.bcc ?? existing.content.bcc,
				subject: args.subject ?? existing.content.subject,
				text: args.text ?? existing.content.text,
				html: args.html ?? existing.content.html,
			};
			const built = buildDraftContent(overlay);
			if (!built.ok) return failure(built.reason, DRAFT_ERROR_DETAIL[built.reason]);

			const contentHash = await draftContentHash(built.content);
			const now = Date.now();
			const updated = await drafts.updateDraft({
				accountId,
				draftId: existing.id,
				expectedVersion: existing.version,
				contentHash,
				content: built.content,
				now,
			});
			if (!updated) {
				const current = await drafts.getDraft(accountId, existing.id);
				if (!current) {
					return failure("draft_not_found", "No such draft exists in your mailbox.");
				}
				if (current.status !== "draft") {
					return failure("draft_discarded", "This draft was discarded and can no longer be edited.");
				}
				return failure(
					"draft_version_conflict",
					`The draft is now at version ${current.version}; re-read it and retry with that version.`,
				);
			}

			const next: DraftRecord = {
				...existing,
				version: existing.version + 1,
				contentHash,
				content: built.content,
				updatedAt: now,
			};
			return success(renderDraft(next), { draft: draftJson(next) });
		},
	);

	server.registerTool(
		DRAFT_DISCARD_TOOL,
		{
			title: "Who You draft discard",
			description:
				"Soft-deletes one editable draft owned by the caller. The row is kept for evidence but can never be updated or sent. Discarding an already discarded draft is a no-op success.",
			inputSchema: z.strictObject({ draftId: SAFE_ID }),
			annotations: WRITE_DISCARD,
		},
		async (args): Promise<ToolResult> => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const existing = await drafts.getDraft(accountId, args.draftId);
			if (!existing) {
				return failure("draft_not_found", "No such draft exists in your mailbox.");
			}
			if (existing.status === "discarded") {
				return success(renderDraft(existing), { draft: draftJson(existing) });
			}
			const now = Date.now();
			const discarded = await drafts.discardDraft(accountId, existing.id, now);
			if (!discarded) {
				const current = await drafts.getDraft(accountId, existing.id);
				if (!current) {
					return failure("draft_not_found", "No such draft exists in your mailbox.");
				}
				return success(renderDraft(current), { draft: draftJson(current) });
			}
			const next: DraftRecord = { ...existing, status: "discarded", updatedAt: now };
			return success(renderDraft(next), { draft: draftJson(next) });
		},
	);

	server.registerTool(
		DRAFT_GET_TOOL,
		{
			title: "Who You draft get",
			description:
				"Returns one draft owned by the caller, including its version and contentHash. Discarded drafts are returned with their status so the agent can explain why they cannot be sent.",
			inputSchema: z.strictObject({ draftId: SAFE_ID }),
			annotations: READ_ONLY,
		},
		async (args): Promise<ToolResult> => {
			const draft = await drafts.getDraft(accountId, args.draftId);
			if (!draft) {
				return failure("draft_not_found", "No such draft exists in your mailbox.");
			}
			return success(renderDraft(draft), { draft: draftJson(draft) });
		},
	);

	server.registerTool(
		DRAFT_LIST_TOOL,
		{
			title: "Who You draft list",
			description:
				"Lists the caller's editable drafts, newest update first. Discarded drafts are excluded. Use the returned cursor for the next page.",
			inputSchema: z.strictObject({
				limit: z.number().int().min(1).max(50).default(20),
				cursor: z.string().trim().min(1).max(200).optional(),
			}),
			annotations: READ_ONLY,
		},
		async (args): Promise<ToolResult> => {
			const cursor = args.cursor ? decodeCursor(args.cursor) : null;
			if (args.cursor && !cursor) {
				return failure("invalid_cursor", "The cursor is malformed.");
			}
			const rows = await drafts.listDrafts(accountId, args.limit, cursor ?? undefined);
			const page = rows.slice(0, args.limit);
			const nextCursor =
				rows.length > args.limit && page.length ? encodeCursor(page[page.length - 1]) : null;
			const lines = [
				"# Who You · drafts",
				`- editable drafts: ${page.length}${nextCursor ? " (more available)" : ""}`,
				...page.map(
					(draft) =>
						`- \`${draft.id}\` · v${draft.version} · ${draft.content.subject || "(no subject)"} · to ${formatAddresses(draft.content.to) || "(none)"}`,
				),
			];
			if (!page.length) lines.push("_No editable drafts._");
			return success(lines.join("\n"), {
				drafts: page.map(draftJson),
				nextCursor,
			});
		},
	);

	server.registerTool(
		DRAFT_SEND_TOOL,
		{
			title: "Who You draft send",
			description:
				"Sends one draft revision through the configured Cloudflare Email Service binding. It accepts exactly three arguments: the draft id, a Cloud Auth draft-bound confirmation credential, and an idempotency key. Sender, recipients, subject and body come only from the stored draft revision; they cannot be overridden here. The credential is single-use and must bind this draft's current version and contentHash.",
			inputSchema: z.strictObject({
				draftId: SAFE_ID,
				confirmationCredential: z.string().trim().min(1).max(4096),
				idempotencyKey: z
					.string()
					.trim()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9._:-]+$/),
			}),
			annotations: SEND,
		},
		async (args): Promise<ToolResult> => {
			const mailbox = await repository.findMailboxByAccount(accountId);
			const result = await sendDraft(
				{
					drafts,
					confirmations: dependencies.confirmations,
					sender: dependencies.sender,
					from: mailbox?.address ?? null,
					gate: sendGate,
					monitor: abuseMonitor,
					now: () => Date.now(),
				},
				{
					accountId,
					draftId: args.draftId,
					confirmationCredential: args.confirmationCredential,
					idempotencyKey: args.idempotencyKey,
				},
			);
			if (!result.ok) return failure(result.code, result.detail);

			const receipt = result.receipt;
			return success(
				[
					"# Who You · send receipt",
					`- receipt: \`${receipt.id}\``,
					`- draft: \`${receipt.draftId}\` v${receipt.draftVersion}`,
					`- status: ${receipt.status}`,
					receipt.providerMessageId ? `- provider message id: \`${receipt.providerMessageId}\`` : "",
					`- recorded: ${new Date(receipt.createdAt).toISOString()}`,
					`- replayed: ${result.alreadySent ? "yes (no second message was sent)" : "no"}`,
				]
					.filter(Boolean)
					.join("\n"),
				{ receipt: receiptJson(receipt), alreadySent: result.alreadySent },
			);
		},
	);
}
