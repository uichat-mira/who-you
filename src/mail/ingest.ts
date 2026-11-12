import { sha256Hex } from "./hash";
import type { MailLimits } from "./limits";
import {
	MailParseError,
	parseInboundMail,
	type ParsedMail,
	type ParseFailure,
} from "./mime";
import {
	mailObjectKeys,
	type AttachmentRecord,
	type MailAddressJson,
	type MailboxRecord,
	type MailRepository,
	type NewMessage,
	type NewThread,
} from "./store";

/**
 * Shared storage pipeline for inbound mail. Cloudflare Email Routing (S1) and
 * provider sync (S7c) both land here, so dedupe, quarantine, quota and object
 * layout stay identical regardless of how a message arrived.
 */

const MAX_HEADER_SCAN_BYTES = 16 * 1024;
const MAX_HEADER_VALUE = 998;
const SNIPPET_CHARS = 200;

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

/** Reads one header from the raw bytes; callers must not log the result. */
export function readHeaderValue(raw: Uint8Array, name: string): string | null {
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
}

const threadKeyFor = (parsed: ParsedMail | null, fallbackId: string): string => {
	const reference = parsed?.references?.match(/<[^>]+>/)?.[0] ?? parsed?.inReplyTo;
	const selected = reference?.trim() || fallbackId;
	return selected.slice(0, MAX_HEADER_VALUE);
};

const prepareInbound = async (
	raw: Uint8Array,
	limits: MailLimits,
): Promise<{ parsed: ParsedMail | null; parseFailure: ParseFailure | null }> => {
	try {
		return { parsed: await parseInboundMail(raw, limits), parseFailure: null };
	} catch (error) {
		if (error instanceof MailParseError && error.failure.kind === "malformed") {
			return { parsed: null, parseFailure: error.failure };
		}
		throw error;
	}
};

export type IngestFailure = "raw_size_limit" | "mailbox_quota" | "storage_write_failed";

export type IngestResult =
	| {
			ok: true;
			messageId: string;
			duplicate: boolean;
			bytes: number;
			attachments: number;
			quarantined: boolean;
			quarantineReason: string | null;
	  }
	| { ok: false; reason: IngestFailure };

export type IngestInput = {
	repository: MailRepository;
	limits: MailLimits;
	mailbox: MailboxRecord;
	raw: Uint8Array;
	envelopeFrom: string | null;
	receivedAt: number;
	/** Provider sync may discover a message the identity itself sent. */
	direction?: "inbound" | "outbound";
};

/**
 * Stores one RFC822 message for an already-authorized mailbox. It never
 * resolves the recipient, never sends and never forwards; the caller owns the
 * ownership decision, while size, quota, dedupe and object layout live here.
 */
export async function ingestRawMail(input: IngestInput): Promise<IngestResult> {
	const { repository, limits, mailbox, raw } = input;
	if (raw.byteLength > limits.maxRawBytes) {
		return { ok: false, reason: "raw_size_limit" };
	}
	if (mailbox.bytesUsed + raw.byteLength > mailbox.quotaBytes) {
		return { ok: false, reason: "mailbox_quota" };
	}

	const prepared = await prepareInbound(raw, limits);
	const parsed = prepared.parsed;
	const fallbackId =
		readHeaderValue(raw, "message-id") ?? `sha256:${await sha256Hex(raw)}`;
	const internetMessageId = parsed?.internetMessageId ?? fallbackId;
	const messageId = `msg_${(await sha256Hex(`${mailbox.id}\n${internetMessageId}`)).slice(0, 32)}`;

	if (await repository.messageExists(mailbox.id, internetMessageId)) {
		return {
			ok: true,
			messageId,
			duplicate: true,
			bytes: raw.byteLength,
			attachments: 0,
			quarantined: false,
			quarantineReason: null,
		};
	}

	const dmarc = parsed?.auth.dmarc ?? "unknown";
	const quarantineReason = prepared.parseFailure
		? "parse_failure"
		: dmarc === "fail"
			? "dmarc_fail"
			: null;
	const state = quarantineReason ? "quarantined" : "visible";
	const authResults = parsed?.auth.summary ?? "spf=none;dkim=none;dmarc=unknown";

	const subject = parsed?.subject ?? "";
	const from: MailAddressJson[] = parsed?.from.length
		? parsed.from
		: [{ name: "", address: input.envelopeFrom ?? "" }];
	const to: MailAddressJson[] = parsed?.to.length
		? parsed.to
		: [{ name: "", address: mailbox.address }];
	const cc = parsed?.cc ?? [];
	const fromText = normalizeSearchText(addressText(from));
	const snippet = snippetFor(parsed);
	const searchText = searchTextFor(fromText, parsed, mailbox.address, subject, snippet);
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
		direction: input.direction ?? "inbound",
		internetMessageId,
		envelopeFrom: input.envelopeFrom || null,
		envelopeTo: mailbox.address,
		from,
		to,
		cc,
		subject,
		fromText,
		searchText,
		sentAt: parsed?.sentAt ?? null,
		receivedAt: input.receivedAt,
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
		lastMessageAt: input.receivedAt,
	};

	const writtenKeys: string[] = [rawKey];
	try {
		await repository.putObject(rawKey, raw, "message/rfc822");
		if (textKey && parsed?.text !== null && parsed?.text !== undefined) {
			writtenKeys.push(textKey);
			await repository.putObject(
				textKey,
				new TextEncoder().encode(parsed.text),
				"text/plain; charset=utf-8",
			);
		}
		if (htmlKey && parsed?.html) {
			writtenKeys.push(htmlKey);
			await repository.putObject(
				htmlKey,
				new TextEncoder().encode(parsed.html),
				"text/html; charset=utf-8",
			);
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
			input.receivedAt,
		);
		if (!inserted) {
			await repository.deleteObjects(writtenKeys);
			return {
				ok: true,
				messageId,
				duplicate: true,
				bytes: raw.byteLength,
				attachments: 0,
				quarantined: false,
				quarantineReason: null,
			};
		}
	} catch {
		await repository.deleteObjects(writtenKeys).catch(() => undefined);
		return { ok: false, reason: "storage_write_failed" };
	}

	return {
		ok: true,
		messageId,
		duplicate: false,
		bytes: raw.byteLength,
		attachments: attachments.length,
		quarantined: state === "quarantined",
		quarantineReason,
	};
}
