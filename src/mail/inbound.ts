import { resolveRecipient } from "./address";
import { createMailServices, type WhoYouEnv } from "./config";
import { ingestRawMail } from "./ingest";

const REJECT_UNKNOWN_USER = "550 5.1.1 no such user";
const REJECT_TOO_LARGE = "552 5.3.4 message exceeds the receiving size limit";
const REJECT_QUOTA = "552 5.2.2 mailbox quota exceeded";

type InboundLog = {
	event: "whoyou_mail_inbound";
	outcome:
		| "stored"
		| "duplicate"
		| "rejected_unknown_recipient"
		| "rejected_too_large"
		| "rejected_quota"
		| "failed";
	mailboxId?: string;
	messageId?: string;
	bytes?: number;
	attachments?: number;
	quarantined?: boolean;
	/// Bounded reason code only; never an address, subject, filename or body.
	reason?: string;
};

/**
 * Logs identifiers, byte counts and outcomes only. Inbound content, addresses,
 * subjects, snippets and attachment names must never appear here.
 */
const logInbound = (entry: InboundLog): void => {
	console.log(JSON.stringify(entry));
};

/**
 * S1 inbound pipeline: ownership check, explicit rejection, then the shared
 * ingestion path. It never sends, copies or forwards mail, and it never falls
 * through for an unknown recipient.
 */
export async function handleInboundEmail(
	message: ForwardableEmailMessage,
	env: WhoYouEnv,
): Promise<void> {
	const resolved = createMailServices(env);
	if (!resolved.ok) {
		logInbound({ event: "whoyou_mail_inbound", outcome: "failed", reason: resolved.reason });
		throw new Error(resolved.reason);
	}
	const { repository, limits, domain } = resolved.services;
	if (!domain) {
		logInbound({ event: "whoyou_mail_inbound", outcome: "failed", reason: "mail_domain_not_configured" });
		throw new Error("mail_domain_not_configured");
	}

	const recipient = resolveRecipient(message.to, domain);
	if (!recipient.ok) {
		message.setReject(REJECT_UNKNOWN_USER);
		logInbound({
			event: "whoyou_mail_inbound",
			outcome: "rejected_unknown_recipient",
			reason: recipient.reason,
		});
		return;
	}

	const mailbox = await repository.findMailboxByAddress(recipient.address);
	if (!mailbox || mailbox.status !== "active") {
		message.setReject(REJECT_UNKNOWN_USER);
		logInbound({
			event: "whoyou_mail_inbound",
			outcome: "rejected_unknown_recipient",
			reason: mailbox ? "mailbox_disabled" : "mailbox_not_provisioned",
		});
		return;
	}

	if (message.rawSize > limits.maxRawBytes) {
		message.setReject(REJECT_TOO_LARGE);
		logInbound({
			event: "whoyou_mail_inbound",
			outcome: "rejected_too_large",
			mailboxId: mailbox.id,
			bytes: message.rawSize,
			reason: "raw_size_limit",
		});
		return;
	}

	let raw: Uint8Array;
	try {
		raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
	} catch {
		logInbound({
			event: "whoyou_mail_inbound",
			outcome: "failed",
			mailboxId: mailbox.id,
			reason: "raw_read_failed",
		});
		throw new Error("raw_read_failed");
	}

	const result = await ingestRawMail({
		repository,
		limits,
		mailbox,
		raw,
		envelopeFrom: message.from || null,
		receivedAt: Date.now(),
	});

	if (!result.ok) {
		if (result.reason === "raw_size_limit") {
			message.setReject(REJECT_TOO_LARGE);
			logInbound({
				event: "whoyou_mail_inbound",
				outcome: "rejected_too_large",
				mailboxId: mailbox.id,
				bytes: raw.byteLength,
				reason: "raw_size_limit",
			});
			return;
		}
		if (result.reason === "mailbox_quota") {
			message.setReject(REJECT_QUOTA);
			logInbound({
				event: "whoyou_mail_inbound",
				outcome: "rejected_quota",
				mailboxId: mailbox.id,
				bytes: raw.byteLength,
				reason: "mailbox_quota",
			});
			return;
		}
		logInbound({
			event: "whoyou_mail_inbound",
			outcome: "failed",
			mailboxId: mailbox.id,
			bytes: raw.byteLength,
			reason: "storage_write_failed",
		});
		throw new Error("mail_storage_write_failed");
	}

	if (result.duplicate) {
		logInbound({
			event: "whoyou_mail_inbound",
			outcome: "duplicate",
			mailboxId: mailbox.id,
			messageId: result.messageId,
			bytes: raw.byteLength,
		});
		return;
	}

	logInbound({
		event: "whoyou_mail_inbound",
		outcome: "stored",
		mailboxId: mailbox.id,
		messageId: result.messageId,
		bytes: raw.byteLength,
		attachments: result.attachments,
		quarantined: result.quarantined,
		reason: result.quarantineReason ?? undefined,
	});
}
