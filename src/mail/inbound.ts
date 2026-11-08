import { resolveRecipient } from "./address";
import { createMailServices, type WhoYouEnv } from "./config";
import { sha256Hex } from "./hash";
import type { MailLimits } from "./limits";
import {
	MailParseError,
	parseAuthVerdict,
	parseInboundMail,
	type ParsedMail,
	type ParseFailure,
} from "./mime";
import {
	mailObjectKeys,
	type AttachmentRecord,
	type MailAddressJson,
	type NewMessage,
	type NewThread,
} from "./store";

const REJECT_UNKNOWN_USER = "550 5.1.1 no such user";
const REJECT_TOO_LARGE = "552 5.3.4 message exceeds the receiving size limit";
const REJECT_QUOTA = "552 5.2.2 mailbox quota exceeded";

const MAX_HEADER_SCAN_BYTES = 16 * 1024;
const MAX_HEADER_VALUE = 998;
const SNIPPET_CHARS = 200;

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

const collapseWhitespace = (value: string): string =>
	value.replace(/\s+/g, " ").trim();

const normalizeSearchText = (value: string): string =>
	collapseWhitespace(value.normalize("NFC").toLowerCase());

const textFromHtml = (html: string): string =>
	collapseWhitespace(html.replace(/<[^>]*>/g, " "));

const snippetFor = (parsed: ParsedMail | null): string => {
	if (!parsed) return "";
	const source = parsed.text && parsed.text.trim()
		? parsed.text
		: parsed.html
			? textFromHtml(parsed.html)
			: "";
	return collapseWhitespace(source).slice(0, SNIPPET_CHARS);
};

const addressText = (addresses: MailAddressJson[]): string =>
	addresses
		.map((entry) => `${entry.name} ${entry.address}`.trim())
		.join(" ");

const searchTextFor = (
	fromText: string,
	parsed: ParsedMail | null,
	recipient: string,
	subject: string,
	snippet: string,
): string =>
	normalizeSearchText(
		[
			fromText,
			parsed ? addressText(parsed.to) : recipient,
			parsed ? addressText(parsed.cc) : "",
			subject,
			snippet,
		].join(" "),
	);

const readHeaderValue = (raw: Uint8Array, name: string): string | null => {
	const text = new TextDecoder().decode(
		raw.slice(0, Math.min(raw.byteLength, MAX_HEADER_SCAN_BYTES)),
	);
	const headerEnd = text.search(/\r?\n\r?\n/);
	const headers = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
	for (const line of headers.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		if (line.slice(0, colon).trim().toLowerCase() !== name) continue;
		const value = line.slice(colon + 1).trim();
		if (value) return value.slice(0, MAX_HEADER_VALUE);
	}
	return null;
};

const threadKeyFor = (parsed: ParsedMail | null, fallbackId: string): string => {
	const reference = parsed?.references?.match(/<[^>]+>/)?.[0] ?? parsed?.inReplyTo;
	const selected = reference?.trim() || fallbackId;
	return selected.slice(0, MAX_HEADER_VALUE);
};

type PreparedInbound = {
	parsed: ParsedMail | null;
	parseFailure: ParseFailure | null;
};

async function prepareInbound(
	raw: Uint8Array,
	limits: MailLimits,
): Promise<PreparedInbound> {
	try {
		return { parsed: await parseInboundMail(raw, limits), parseFailure: null };
	} catch (error) {
		if (error instanceof MailParseError && error.failure.kind === "malformed") {
			return { parsed: null, parseFailure: error.failure };
		}
		throw error;
	}
}

/**
 * S1 inbound pipeline: ownership check, explicit rejection, structural limits,
 * dedupe, quarantine, D1 metadata and R2 objects. It never sends, copies or
 * forwards mail, and it never falls through for an unknown recipient.
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
	if (mailbox.bytesUsed + message.rawSize > mailbox.quotaBytes) {
		message.setReject(REJECT_QUOTA);
		logInbound({
			event: "whoyou_mail_inbound",
			outcome: "rejected_quota",
			mailboxId: mailbox.id,
			bytes: message.rawSize,
			reason: "mailbox_quota",
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
	if (raw.byteLength > limits.maxRawBytes) {
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

	let prepared: PreparedInbound;
	try {
		prepared = await prepareInbound(raw, limits);
	} catch (error) {
		if (error instanceof MailParseError && error.failure.kind === "limit") {
			message.setReject(REJECT_TOO_LARGE);
			logInbound({
				event: "whoyou_mail_inbound",
				outcome: "rejected_too_large",
				mailboxId: mailbox.id,
				bytes: raw.byteLength,
				reason: "mime_structure_limit",
			});
			return;
		}
		throw error;
	}
	const parsed = prepared.parsed;
	const fallbackId =
		readHeaderValue(raw, "message-id") ?? `sha256:${await sha256Hex(raw)}`;
	const internetMessageId = parsed?.internetMessageId ?? fallbackId;
	// A unique ID per *attempt* also isolates R2 keys: a losing concurrent
	// duplicate must never delete the winning message's objects.
	const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;

	if (await repository.messageExists(mailbox.id, internetMessageId)) {
		logInbound({
			event: "whoyou_mail_inbound",
			outcome: "duplicate",
			mailboxId: mailbox.id,
			messageId,
			bytes: raw.byteLength,
		});
		return;
	}

	// Only Cloudflare's authenticated transport header may inform quarantine.
	// Authentication-Results embedded in the MIME body are untrusted.
	const platformAuth = parseAuthVerdict(
		message.headers.get("authentication-results")
			? [{ key: "authentication-results", value: message.headers.get("authentication-results") ?? "" }]
			: [],
	);
	const dmarc = platformAuth.dmarc;
	const quarantineReason = prepared.parseFailure
		? "parse_failure"
		: dmarc === "fail"
			? "dmarc_fail"
			: null;
	const state = quarantineReason ? "quarantined" : "visible";
	const authResults = platformAuth.summary;

	const receivedAt = Date.now();
	const subject = parsed?.subject ?? "";
	const from: MailAddressJson[] =
		parsed?.from.length
			? parsed.from
			: [{ name: "", address: message.from }];
	const to: MailAddressJson[] = parsed?.to.length
		? parsed.to
		: [{ name: "", address: recipient.address }];
	const cc = parsed?.cc ?? [];
	const fromText = normalizeSearchText(addressText(from));
	const snippet = snippetFor(parsed);
	const searchText = searchTextFor(fromText, parsed, recipient.address, subject, snippet);
	const threadKey = threadKeyFor(parsed, internetMessageId);
	const threadId = `th_${(await sha256Hex(`${mailbox.id}\n${threadKey}`)).slice(0, 32)}`;

	const rawKey = mailObjectKeys.raw(mailbox.accountId, mailbox.id, messageId);
	const textKey =
		parsed?.text !== undefined && parsed?.text !== null
			? mailObjectKeys.text(mailbox.accountId, mailbox.id, messageId)
			: null;
	const htmlKey = parsed?.html
		? mailObjectKeys.html(mailbox.accountId, mailbox.id, messageId)
		: null;

	const attachments: AttachmentRecord[] = [];
	for (const attachment of parsed?.attachments ?? []) {
		const attachmentId = `att_${(await sha256Hex(`${messageId}\n${attachment.partPath}`)).slice(0, 24)}`;
		attachments.push({
			id: attachmentId,
			messageId,
			mailboxId: mailbox.id,
			partPath: attachment.partPath,
			filename: attachment.filename,
			mimeType: attachment.mimeType,
			sizeBytes: attachment.sizeBytes,
			disposition: attachment.disposition,
			contentId: attachment.contentId,
			r2Key: mailObjectKeys.attachment(
				mailbox.accountId,
				mailbox.id,
				messageId,
				attachmentId,
			),
		});
	}

	const newMessage: NewMessage = {
		id: messageId,
		mailboxId: mailbox.id,
		threadId,
		direction: "inbound",
		internetMessageId,
		envelopeFrom: message.from || null,
		envelopeTo: recipient.address,
		from,
		to,
		cc,
		subject,
		fromText,
		searchText,
		sentAt: parsed?.sentAt ?? null,
		receivedAt,
		sizeBytes: raw.byteLength,
		snippet,
		attachmentCount: attachments.length,
		authResults,
		dmarc,
		state,
		quarantineReason,
		rawKey,
		textKey,
		htmlKey,
	};
	const thread: NewThread = {
		id: threadId,
		mailboxId: mailbox.id,
		threadKey,
		rootMessageId: threadKey || null,
		lastMessageAt: receivedAt,
	};

	const writtenKeys: string[] = [rawKey];
	try {
		await repository.putObject(rawKey, raw, "message/rfc822");
		if (textKey && parsed?.text !== null && parsed?.text !== undefined) {
			writtenKeys.push(textKey);
			await repository.putObject(textKey, new TextEncoder().encode(parsed.text), "text/plain; charset=utf-8");
		}
		if (htmlKey && parsed?.html) {
			writtenKeys.push(htmlKey);
			await repository.putObject(htmlKey, new TextEncoder().encode(parsed.html), "text/html; charset=utf-8");
		}
		for (const [index, attachment] of attachments.entries()) {
			writtenKeys.push(attachment.r2Key);
			await repository.putObject(
				attachment.r2Key,
				parsed?.attachments[index]?.content ?? new Uint8Array(),
				attachment.mimeType,
			);
		}

		const inserted = await repository.insertMessage(
			newMessage,
			thread,
			attachments,
			receivedAt,
		);
		if (!inserted) {
			await repository.deleteObjects(writtenKeys);
			logInbound({
				event: "whoyou_mail_inbound",
				outcome: "duplicate",
				mailboxId: mailbox.id,
				messageId,
				bytes: raw.byteLength,
			});
			return;
		}
	} catch {
		await repository.deleteObjects(writtenKeys).catch(() => undefined);
		logInbound({
			event: "whoyou_mail_inbound",
			outcome: "failed",
			mailboxId: mailbox.id,
			messageId,
			bytes: raw.byteLength,
			reason: "storage_write_failed",
		});
		throw new Error("mail_storage_write_failed");
	}

	logInbound({
		event: "whoyou_mail_inbound",
		outcome: "stored",
		mailboxId: mailbox.id,
		messageId,
		bytes: raw.byteLength,
		attachments: attachments.length,
		quarantined: state === "quarantined",
		reason: quarantineReason ?? undefined,
	});
}
