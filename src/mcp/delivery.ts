import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MailServices } from "../mail/config";
import type { DeliveryEventType, DeliveryEventView, SendReceiptView } from "../mail/store";
import type { WhoYouPrincipal } from "./auth";
import { MAIL_DELIVERY_STATUS_TOOL_NAME, READ_ONLY_ANNOTATIONS } from "./capabilities";
import { failure, success, type ToolResult } from "./mail";

/** Receipt ids are opaque server-issued strings, never free text. */
const RECEIPT_ID = z.string().trim().min(1).max(80);

/** Current status derived from the strongest event ever recorded. */
export type DerivedDeliveryStatus =
	| "sent"
	| "dsn"
	| "delivered"
	| "soft_bounce"
	| "hard_bounce"
	| "complaint";

/**
 * Strictest-wins order: a complaint outranks a hard bounce, a hard bounce
 * outranks a soft bounce, a delivery notice outranks a plain DSN, and a receipt
 * with no events is still `sent`. Exported for unit tests.
 */
const STATUS_PRIORITY: Exclude<DerivedDeliveryStatus, "sent">[] = [
	"complaint",
	"hard_bounce",
	"soft_bounce",
	"delivered",
	"dsn",
];

export function deriveDeliveryStatus(types: DeliveryEventType[]): DerivedDeliveryStatus {
	for (const status of STATUS_PRIORITY) {
		if (types.includes(status)) return status;
	}
	return "sent";
}

const formatDate = (value: number): string => new Date(value).toISOString();

const renderReceipt = (receipt: SendReceiptView): string[] => [
	`- receipt: \`${receipt.id}\``,
	`- draft: \`${receipt.draftId}\` v${receipt.draftVersion}`,
	`- provider message: \`${receipt.providerMessageId ?? "none"}\``,
	`- sent at: ${formatDate(receipt.createdAt)}`,
];

const renderEventLine = (event: DeliveryEventView): string =>
	[
		`- ${formatDate(event.occurredAt)}`,
		event.type,
		`status=${event.status ?? "none"}`,
		`diagnostic=${event.diagnosticCode ?? "none"}`,
		`domain=${event.recipientDomain || "unknown"}`,
		`recipient=${event.recipientHash}`,
	].join(" · ");

const eventJson = (event: DeliveryEventView): Record<string, unknown> => ({
	type: event.type,
	status: event.status,
	diagnosticCode: event.diagnosticCode,
	recipientHash: event.recipientHash,
	recipientDomain: event.recipientDomain,
	occurredAt: event.occurredAt,
});

/**
 * Read-only delivery visibility for one send receipt. Events are written only by
 * the HMAC-authenticated internal relay callback; an agent can read them but can
 * never forge or dismiss one. The response carries recipient hashes and domains
 * only, never a recipient address.
 */
export function registerDeliveryTools(
	server: McpServer,
	principal: WhoYouPrincipal,
	services: MailServices,
): void {
	const { repository } = services;
	const accountId = principal.accountId;

	server.registerTool(
		MAIL_DELIVERY_STATUS_TOOL_NAME,
		{
			title: "Who You delivery status",
			description:
				"Reads the delivery timeline of one send receipt: delivered, DSN, soft bounce, hard bounce or complaint events. " +
				"Events are written only by the HMAC-authenticated internal relay callback; an agent cannot forge them. " +
				"Results contain recipient hashes and domains, never plaintext recipients. " +
				"Status is derived strictest-wins: complaint > hard_bounce > soft_bounce > delivered > dsn > sent.",
			inputSchema: z.object({
				receiptId: RECEIPT_ID,
				limit: z.number().int().min(1).max(200).default(50),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args): Promise<ToolResult> => {
			// A receipt of another account is indistinguishable from a missing one.
			const receipt = await repository.findSendReceipt(accountId, args.receiptId);
			if (!receipt) {
				return failure("receipt_not_found", "No such send receipt exists for this account.");
			}
			// Fetch one extra row only; status is derived from every event, so a
			// truncated timeline can never report a stale status.
			const page = await repository.listDeliveryEvents(accountId, receipt.id, args.limit + 1);
			const truncated = page.length > args.limit;
			const events = truncated ? page.slice(0, args.limit) : page;
			const status = deriveDeliveryStatus(
				await repository.listDeliveryEventTypes(accountId, receipt.id),
			);

			const markdown = [
				"# Who You · delivery status",
				`- status: ${status}`,
				...renderReceipt(receipt),
				`- events: ${events.length}${truncated ? " (truncated)" : ""}`,
				"",
				"## Timeline",
				events.length ? events.map(renderEventLine).join("\n") : "_No delivery events yet._",
			].join("\n");

			return success(markdown, {
				receipt: {
					receiptId: receipt.id,
					draftId: receipt.draftId,
					draftVersion: receipt.draftVersion,
					receiptStatus: receipt.status,
					providerMessageId: receipt.providerMessageId,
					createdAt: receipt.createdAt,
				},
				status,
				events: events.map(eventJson),
				truncated,
			});
		},
	);
}
