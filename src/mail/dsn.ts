import { DEFAULT_MAIL_LIMITS } from "./limits";
import { MailParseError, parseRawMime, type RawHeader, type RawMime } from "./raw-mime";

/**
 * Transport-agnostic DSN (RFC 3464) and ARF (RFC 5965) reader.
 *
 * The relay callback, a mailbox-backed fallback and a unit test all hand this
 * function the same raw RFC822 report; it never reads SMTP or a provider API.
 * Reports are hostile input: structure this reader does not understand returns
 * `report_malformed` instead of a guessed event, and diagnostic text is reduced
 * to SMTP status codes so an address cannot leak into stored evidence.
 */

export type DeliveryEventType =
	| "delivered"
	| "soft_bounce"
	| "hard_bounce"
	| "complaint"
	| "dsn";

export type ParsedDeliveryEvent = {
	type: DeliveryEventType;
	/** Normalized lowercase addresses; empty events are not emitted. */
	recipients: string[];
	status: string | null;
	/** SMTP/enhanced code only (e.g. `550 5.1.1`), never free text. */
	diagnosticCode: string | null;
	originalMessageId: string | null;
};

export type DeliveryReport = {
	reportType: "dsn" | "arf";
	events: ParsedDeliveryEvent[];
};

export type ParseReportResult =
	| { ok: true; report: DeliveryReport }
	| { ok: false; reason: "not_a_report" | "report_malformed" };

const MAX_RECIPIENT_CHARS = 320;
const MAX_MESSAGE_ID_CHARS = 200;
const MAX_STATUS_CHARS = 40;

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Rejects spaces and control characters without a control-character regex. */
const hasForbiddenChars = (value: string): boolean => {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f) return true;
	}
	return false;
};

/**
 * Accepts `rfc822; user@example.com`, `<user@example.com>` and a bare address.
 * Anything still containing whitespace or control characters is rejected
 * rather than coerced.
 */
export function normalizeRecipient(value: string | null | undefined): string | null {
	if (!value) return null;
	let candidate = value.trim();
	const semicolon = candidate.lastIndexOf(";");
	if (semicolon !== -1) candidate = candidate.slice(semicolon + 1);
	candidate = candidate.trim().replace(/^<+/, "").replace(/>+$/, "").toLowerCase();
	if (!candidate || candidate.length > MAX_RECIPIENT_CHARS) return null;
	if (hasForbiddenChars(candidate)) return null;
	const at = candidate.lastIndexOf("@");
	if (at <= 0 || at === candidate.length - 1) return null;
	return candidate;
}

const headerValue = (headers: RawHeader[], key: string): string | null => {
	const match = headers.find((header) => header.key.toLowerCase() === key);
	return match ? collapseWhitespace(match.value) : null;
};

const reportTypeFromHeader = (value: string | null): "dsn" | "arf" | null => {
	if (!value) return null;
	const match = /report-type\s*=\s*"?([^";\s]+)"?/i.exec(value);
	if (!match) return null;
	const type = match[1].toLowerCase();
	if (type === "delivery-status") return "dsn";
	if (type === "feedback-report") return "arf";
	return null;
};

const decode = (content: Uint8Array): string => new TextDecoder().decode(content);

/**
 * Parses one RFC822-style field block. Continuation lines are unfolded; the
 * first occurrence of a field wins, mirroring the strict reader used inbound.
 */
const parseFields = (block: string): Map<string, string> => {
	const fields = new Map<string, string>();
	let current: string | null = null;
	for (const line of block.split(/\r?\n/)) {
		if (/^[ \t]/.test(line) && current) {
			fields.set(current, collapseWhitespace(`${fields.get(current) ?? ""} ${line}`));
			continue;
		}
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		if (!fields.has(key)) fields.set(key, line.slice(separator + 1).trim());
		current = key;
	}
	return fields;
};

const sanitizeStatus = (value: string | null): string | null => {
	if (!value) return null;
	const token = value.trim().split(/\s+/)[0] ?? "";
	if (!/^[245]\.[0-9]{1,3}\.[0-9]{1,3}$/.test(token)) return null;
	return token.slice(0, MAX_STATUS_CHARS);
};

/** Keeps only `550 5.1.1`-style codes so diagnostic free text cannot leak. */
const sanitizeDiagnostic = (value: string | null): string | null => {
	if (!value) return null;
	const match = /(\d{3})\s+([245]\.[0-9]{1,3}\.[0-9]{1,3})/.exec(value);
	if (match) return `${match[1]} ${match[2]}`.slice(0, MAX_STATUS_CHARS);
	const enhanced = /([245]\.[0-9]{1,3}\.[0-9]{1,3})/.exec(value);
	return enhanced ? enhanced[1].slice(0, MAX_STATUS_CHARS) : null;
};

const sanitizeMessageId = (value: string | null): string | null => {
	if (!value) return null;
	const cleaned = collapseWhitespace(value.replace(/[<>]/g, ""));
	return cleaned ? cleaned.slice(0, MAX_MESSAGE_ID_CHARS) : null;
};

const classify = (action: string, status: string | null): DeliveryEventType => {
	if (action === "delivered") return "delivered";
	if (action === "delayed") return "soft_bounce";
	if (status?.startsWith("4.")) return "soft_bounce";
	if (status?.startsWith("5.")) return "hard_bounce";
	// A failed report without a usable status is recorded but never suppresses:
	// suppression needs positive evidence, not an inference.
	return "dsn";
};

const parseDeliveryStatus = (raw: string, originalMessageId: string | null): ParsedDeliveryEvent[] => {
	const groups = raw
		.split(/\r?\n\r?\n/)
		.map((group) => group.trim())
		.filter(Boolean);
	// The first block is per-message (Reporting-MTA, Original-Message-ID); every
	// following block describes one recipient.
	const messageFields = groups.length ? parseFields(groups[0]) : new Map<string, string>();
	const messageId =
		sanitizeMessageId(messageFields.get("original-message-id") ?? null) ?? originalMessageId;
	const events: ParsedDeliveryEvent[] = [];
	for (const group of groups.slice(1)) {
		const fields = parseFields(group);
		const recipient = normalizeRecipient(fields.get("final-recipient"));
		if (!recipient) continue;
		const action = (fields.get("action") ?? "").trim().toLowerCase();
		const status = sanitizeStatus(fields.get("status") ?? null);
		events.push({
			type: classify(action, status),
			recipients: [recipient],
			status,
			diagnosticCode: sanitizeDiagnostic(fields.get("diagnostic-code") ?? null),
			originalMessageId: messageId,
		});
	}
	return events;
};

const splitRecipientList = (value: string | null): string[] => {
	if (!value) return [];
	return value
		.split(",")
		.map((entry) => normalizeRecipient(entry))
		.filter((entry): entry is string => entry !== null);
};

const parseFeedbackReport = (
	raw: string,
	fallbackMessageId: string | null,
): ParsedDeliveryEvent[] => {
	const fields = parseFields(raw);
	const recipients = [
		...splitRecipientList(fields.get("original-rcpt-to") ?? null),
		...splitRecipientList(fields.get("removal-recipient") ?? null),
	];
	const unique = [...new Set(recipients)];
	if (!unique.length) return [];
	return [
		{
			type: "complaint",
			recipients: unique,
			status: null,
			diagnosticCode: null,
			originalMessageId:
				sanitizeMessageId(fields.get("original-message-id") ?? null) ??
				fallbackMessageId,
		},
	];
};

const originalMessageIdFromBody = (parsed: RawMime): string | null => {
	const wrapper = parsed.attachments.find(
		(attachment) => attachment.mimeType === "message/rfc822",
	);
	if (!wrapper) return null;
	const lines = decode(wrapper.content).split(/\r?\n/);
	for (const line of lines) {
		if (!line.trim()) break;
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		if (key === "message-id" || key === "original-message-id") {
			return sanitizeMessageId(line.slice(separator + 1));
		}
	}
	return null;
};

export function parseDeliveryReport(raw: string | Uint8Array): ParseReportResult {
	let parsed: RawMime;
	try {
		const bytes =
			typeof raw === "string"
				? new TextEncoder().encode(raw)
				: raw;
		parsed = parseRawMime(bytes, DEFAULT_MAIL_LIMITS);
	} catch (error) {
		if (error instanceof MailParseError) return { ok: false, reason: "report_malformed" };
		throw error;
	}

	const declared =
		reportTypeFromHeader(headerValue(parsed.headers, "content-type")) ??
		(parsed.attachments.some((attachment) => attachment.mimeType === "message/delivery-status")
			? "dsn"
			: parsed.attachments.some(
					(attachment) => attachment.mimeType === "message/feedback-report",
				)
				? "arf"
				: null);
	if (!declared) return { ok: false, reason: "not_a_report" };

	const originalMessageId = originalMessageIdFromBody(parsed);
	const events: ParsedDeliveryEvent[] = [];
	if (declared === "dsn") {
		for (const attachment of parsed.attachments) {
			if (attachment.mimeType !== "message/delivery-status") continue;
			events.push(...parseDeliveryStatus(decode(attachment.content), originalMessageId));
		}
	} else {
		for (const attachment of parsed.attachments) {
			if (attachment.mimeType !== "message/feedback-report") continue;
			events.push(...parseFeedbackReport(decode(attachment.content), originalMessageId));
		}
	}

	if (!events.length) return { ok: false, reason: "report_malformed" };
	return { ok: true, report: { reportType: declared, events } };
}
