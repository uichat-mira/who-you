import type { MailLimits } from "./limits";
import {
	MailParseError,
	parseRawMime,
	type ParseFailure,
	type RawMime,
} from "./raw-mime";
import { sanitizeHtml } from "./sanitize";

export { MailParseError };
export type { ParseFailure };

export type MailAddress = { name: string; address: string };

export type ParsedAttachment = {
	partPath: string;
	filename: string;
	mimeType: string;
	disposition: string;
	sizeBytes: number;
	contentId: string | null;
	content: Uint8Array;
};

export type AuthVerdict = {
	spf: string;
	dkim: string;
	dmarc: "pass" | "fail" | "none" | "unknown";
	/** Compact `spf=pass;dkim=pass;dmarc=pass` form stored in D1. */
	summary: string;
};

export type ParsedMail = {
	internetMessageId: string | null;
	references: string | null;
	inReplyTo: string | null;
	from: MailAddress[];
	to: MailAddress[];
	cc: MailAddress[];
	subject: string;
	sentAt: number | null;
	text: string | null;
	html: string | null;
	attachments: ParsedAttachment[];
	auth: AuthVerdict;
};

const MAX_FILENAME_LENGTH = 120;
const MAX_SUBJECT_LENGTH = 998;
const MAX_MESSAGE_ID_LENGTH = 998;

const isControlCharacter = (code: number): boolean =>
	code < 32 || code === 127;

const stripControlCharacters = (value: string): string =>
	[...value]
		.filter((character) => !isControlCharacter(character.charCodeAt(0)))
		.join("");

const collapseWhitespace = (value: string): string =>
	value.replace(/\s+/g, " ").trim();

/**
 * Attachment names are hostile input: strip path components, control
 * characters and length, and never fall back to a path-derived name.
 */
export function sanitizeFilename(value: string | null): string {
	if (!value) return "attachment";
	const cleaned = stripControlCharacters(value)
		.replace(/\\/g, "/")
		.split("/")
		.filter(Boolean)
		.pop() ?? "";
	const normalized = collapseWhitespace(cleaned).slice(0, MAX_FILENAME_LENGTH);
	return normalized || "attachment";
}

const AUTH_METHOD = /(spf|dkim|dmarc)\s*=\s*([a-z0-9_-]+)/gi;
const LAST_TOKEN = /[^a-z0-9_-]+$/i;

const normalizeVerdict = (value: string | undefined): string => {
	if (!value) return "none";
	return value.toLowerCase().replace(LAST_TOKEN, "") || "none";
};

/**
 * Only the first Cloudflare-inserted Authentication-Results header exposed by
 * ForwardableEmailMessage.headers is eligible for an authentication verdict.
 * Never pass raw MIME headers here: the sender can forge those. Cloudflare
 * documents the first header as its own, with authserv-id mx.cloudflare.net.
 * A missing, foreign or malformed first header remains unknown, not pass.
 */
export function parseAuthVerdict(headers: { key: string; value: string }[]): AuthVerdict {
	const verdicts = new Map<string, string>();
	const firstHeader = headers.find(
		(header) => header.key.toLowerCase() === "authentication-results",
	);
	// Fetch Headers may combine repeated Authentication-Results values with
	// commas; never read later, sender-controlled headers.
	const firstValue = firstHeader?.value.split(",")[0]?.trim() ?? "";
	if (/^mx\.cloudflare\.net\s*;/i.test(firstValue)) {
		AUTH_METHOD.lastIndex = 0;
		let match = AUTH_METHOD.exec(firstValue);
		while (match) {
			const method = match[1].toLowerCase();
			verdicts.set(method, normalizeVerdict(match[2]));
			match = AUTH_METHOD.exec(firstValue);
		}
	}
	const spf = verdicts.get("spf") ?? "none";
	const dkim = verdicts.get("dkim") ?? "none";
	const dmarcValue = verdicts.get("dmarc");
	const dmarc: AuthVerdict["dmarc"] =
		dmarcValue === "pass" || dmarcValue === "fail"
			? dmarcValue
			: dmarcValue === "none"
				? "none"
				: "unknown";
	return {
		spf,
		dkim,
		dmarc,
		summary: `spf=${spf};dkim=${dkim};dmarc=${dmarcValue ?? "unknown"}`,
	};
}

const parseDate = (value: string | null): number | null => {
	if (!value) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
};

const toParsedMail = (parsed: RawMime, limits: MailLimits): ParsedMail => {
	if (parsed.attachments.length > limits.maxAttachments) {
		throw new MailParseError({ kind: "limit", code: "EMAXATTACHMENTS" });
	}
	const attachments: ParsedAttachment[] = parsed.attachments.map((attachment) => ({
		partPath: attachment.partPath,
		filename: sanitizeFilename(attachment.filename),
		mimeType: attachment.mimeType || "application/octet-stream",
		disposition: attachment.disposition || "attachment",
		sizeBytes: attachment.content.byteLength,
		contentId: attachment.contentId,
		content: attachment.content,
	}));

	return {
		internetMessageId: parsed.messageId
			? parsed.messageId.slice(0, MAX_MESSAGE_ID_LENGTH)
			: null,
		references: parsed.references,
		inReplyTo: parsed.inReplyTo,
		from: parsed.from,
		to: parsed.to,
		cc: parsed.cc,
		subject: collapseWhitespace(parsed.subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
		sentAt: parseDate(parsed.date),
		text: parsed.text,
		html: parsed.html ? sanitizeHtml(parsed.html) : null,
		attachments,
		// MIME-supplied Authentication-Results are sender-controlled.
		auth: parseAuthVerdict([]),
	};
};

/**
 * Parses raw MIME with hard structural limits supplied by the caller. Limit
 * violations are distinguished from malformed input so the inbound handler can
 * reject explicitly instead of quarantining something it never understood.
 */
export async function parseInboundMail(
	raw: ArrayBuffer | Uint8Array,
	limits: MailLimits,
): Promise<ParsedMail> {
	try {
		return toParsedMail(parseRawMime(raw, limits), limits);
	} catch (error) {
		if (error instanceof MailParseError) throw error;
		throw new MailParseError({ kind: "malformed" });
	}
}
