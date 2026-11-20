import type { MailLimits } from "./limits";

/**
 * Strict, in-repo MIME reader for the S1 inbound slice.
 *
 * Supported surface: RFC 5322 header blocks, multipart boundaries,
 * base64/quoted-printable transfer encodings, RFC 2047 encoded words and the
 * charsets WHATWG `TextDecoder` can decode. Structure this reader does not
 * understand fails explicitly (`malformed`) instead of being guessed, and every
 * structural ceiling supplied by the caller is enforced rather than truncated.
 *
 * This is not a general-purpose MIME implementation. A vetted MIME library
 * remains a product decision; the S1 slice only needs a bounded, auditable
 * reader with hard limits.
 */

export type ParseFailure =
	| { kind: "limit"; code: string }
	| { kind: "malformed" };

export class MailParseError extends Error {
	readonly failure: ParseFailure;

	constructor(failure: ParseFailure) {
		super(`mail_parse_${failure.kind}`);
		this.name = "MailParseError";
		this.failure = failure;
	}
}

export type RawHeader = { key: string; value: string };

export type RawAddress = { name: string; address: string };

export type RawAttachment = {
	partPath: string;
	filename: string | null;
	mimeType: string;
	disposition: string;
	contentId: string | null;
	content: Uint8Array;
};

export type RawMime = {
	headers: RawHeader[];
	subject: string;
	date: string | null;
	messageId: string | null;
	references: string | null;
	inReplyTo: string | null;
	from: RawAddress[];
	to: RawAddress[];
	cc: RawAddress[];
	text: string | null;
	html: string | null;
	attachments: RawAttachment[];
};

type ContentType = { type: string; subtype: string; params: Record<string, string> };

type Parameterized = { value: string; params: Record<string, string> };

type ParseContext = {
	limits: MailLimits;
	parts: number;
	attachments: RawAttachment[];
	text: string | null;
	html: string | null;
};

const limitError = (code: string): MailParseError =>
	new MailParseError({ kind: "limit", code });

const malformed = (): MailParseError => new MailParseError({ kind: "malformed" });

const LINE_BREAK = /\r\n|\n/;

const collapseWhitespace = (value: string): string =>
	value.replace(/\s+/g, " ").trim();

const bytesToBinary = (raw: ArrayBuffer | Uint8Array): string => {
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	const chunks: string[] = [];
	const window = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += window) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + window)));
	}
	return chunks.join("");
};

const binaryToBytes = (binary: string): Uint8Array => {
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index) & 0xff;
	}
	return bytes;
};

const decodeBytes = (bytes: Uint8Array, charset: string | undefined): string => {
	const label = charset?.trim().toLowerCase() || "utf-8";
	try {
		return new TextDecoder(label).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
};

const base64ToBytes = (value: string): Uint8Array => {
	const normalized = value.replace(/[^A-Za-z0-9+/=]/g, "");
	try {
		return binaryToBytes(atob(normalized));
	} catch {
		throw malformed();
	}
};

const quotedPrintableToBinary = (value: string): string => {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const character = value.charAt(index);
		if (character !== "=") {
			output += character;
			continue;
		}
		const next = value.charAt(index + 1);
		if (next === "\r" || next === "\n") {
			index += next === "\r" && value.charAt(index + 2) === "\n" ? 2 : 1;
			continue;
		}
		const hex = value.slice(index + 1, index + 3);
		if (/^[0-9a-f]{2}$/i.test(hex)) {
			output += String.fromCharCode(parseInt(hex, 16));
			index += 2;
			continue;
		}
		output += character;
	}
	return output;
};

const decodeTransfer = (binary: string, encoding: string | undefined): Uint8Array => {
	const transfer = (encoding ?? "").trim().toLowerCase();
	if (transfer === "base64") return base64ToBytes(binary);
	if (transfer === "quoted-printable") return binaryToBytes(quotedPrintableToBinary(binary));
	return binaryToBytes(binary);
};

const decodeEncodedWord = (charset: string, encoding: string, payload: string): string => {
	if (encoding.toLowerCase() === "b") {
		return decodeBytes(base64ToBytes(payload), charset);
	}
	return decodeBytes(binaryToBytes(quotedPrintableToBinary(payload.replace(/_/g, " "))), charset);
};

const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
const ADJACENT_ENCODED_WORDS = /(\?=)\s+(=\?)/g;

const decodeWords = (value: string): string => {
	ENCODED_WORD.lastIndex = 0;
	// RFC 2047: whitespace between adjacent encoded words is not part of the text.
	const joined = value.replace(ADJACENT_ENCODED_WORDS, "$1$2");
	return joined.replace(ENCODED_WORD, (_match, charset: string, encoding: string, payload: string) =>
		decodeEncodedWord(charset, encoding, payload),
	);
};

const splitTopLevel = (text: string): { headerText: string; body: string } => {
	let index = text.indexOf("\r\n\r\n");
	let size = 4;
	const bare = text.indexOf("\n\n");
	if (bare !== -1 && (index === -1 || bare < index)) {
		index = bare;
		size = 2;
	}
	if (index === -1) return { headerText: text, body: "" };
	return { headerText: text.slice(0, index), body: text.slice(index + size) };
};

const parseHeaders = (headerText: string): RawHeader[] => {
	const entries: RawHeader[] = [];
	let current: RawHeader | null = null;
	for (const line of headerText.split(LINE_BREAK)) {
		if (!line) continue;
		if (line.startsWith(" ") || line.startsWith("\t")) {
			if (current) current.value = collapseWhitespace(`${current.value} ${line}`);
			continue;
		}
		const colon = line.indexOf(":");
		if (colon <= 0) {
			current = null;
			continue;
		}
		current = {
			key: line.slice(0, colon).trim().toLowerCase(),
			value: line.slice(colon + 1).trim(),
		};
		entries.push(current);
	}
	return entries;
};

const firstHeader = (headers: RawHeader[], key: string): string | undefined =>
	headers.find((header) => header.key === key)?.value;

const splitParameters = (value: string): string[] => {
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	for (const character of value) {
		if (character === "\"") {
			quoted = !quoted;
			current += character;
			continue;
		}
		if (character === ";" && !quoted) {
			parts.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	parts.push(current);
	return parts;
};

const unquote = (value: string): string => {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
		return trimmed.slice(1, -1).replace(/\\"/g, "\"");
	}
	return trimmed;
};

const parseParameterized = (input: string | undefined): Parameterized => {
	const result: Parameterized = { value: "", params: {} };
	if (!input) return result;
	const [head, ...rest] = splitParameters(input);
	result.value = (head ?? "").trim().toLowerCase();
	for (const entry of rest) {
		const equals = entry.indexOf("=");
		if (equals === -1) continue;
		const name = entry.slice(0, equals).trim().toLowerCase();
		if (!name) continue;
		result.params[name] = unquote(entry.slice(equals + 1));
	}
	return result;
};

const parseContentType = (input: string | undefined): ContentType => {
	const { value, params } = parseParameterized(input);
	if (!value) return { type: "text", subtype: "plain", params };
	const slash = value.indexOf("/");
	if (slash === -1) return { type: value, subtype: "plain", params };
	return {
		type: value.slice(0, slash) || "text",
		subtype: value.slice(slash + 1) || "plain",
		params,
	};
};

const splitMultipart = (body: string, boundary: string): string[] => {
	const delimiter = `--${boundary}`;
	const parts: string[] = [];
	let current: string[] | null = null;
	for (const line of body.split(LINE_BREAK)) {
		const trimmed = line.replace(/[ \t]+$/, "");
		if (trimmed === `${delimiter}--`) {
			if (current) parts.push(current.join("\n"));
			current = null;
			break;
		}
		if (trimmed === delimiter) {
			if (current) parts.push(current.join("\n"));
			current = [];
			continue;
		}
		if (current) current.push(line);
	}
	if (current) parts.push(current.join("\n"));
	return parts.filter((part) => part.trim().length > 0);
};

const splitAddressTokens = (value: string): string[] => {
	const tokens: string[] = [];
	let current = "";
	let quoted = false;
	let angled = false;
	for (const character of value) {
		if (character === "\"") {
			quoted = !quoted;
			current += character;
			continue;
		}
		if (character === "<" && !quoted) {
			angled = true;
			current += character;
			continue;
		}
		if (character === ">" && !quoted) {
			angled = false;
			current += character;
			continue;
		}
		if (character === "," && !quoted && !angled) {
			tokens.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	tokens.push(current);
	return tokens;
};

const ANGLE_ADDRESS = /<([^<>]*)>/;

const parseAddressList = (value: string | undefined): RawAddress[] => {
	if (!value) return [];
	const addresses: RawAddress[] = [];
	for (const token of splitAddressTokens(value)) {
		const trimmed = token.trim();
		if (!trimmed) continue;
		const angle = ANGLE_ADDRESS.exec(trimmed);
		if (angle) {
			const address = angle[1].trim();
			if (!address) continue;
			const name = collapseWhitespace(
				decodeWords(unquote(trimmed.slice(0, angle.index))),
			);
			addresses.push({ name, address });
			continue;
		}
		const bare = unquote(trimmed).replace(/[;]+$/, "").trim();
		if (!bare) continue;
		// A group label such as `team:` carries no deliverable address.
		if (!bare.includes("@")) continue;
		addresses.push({ name: "", address: bare });
	}
	return addresses;
};

const attachmentName = (
	contentType: ContentType,
	disposition: Parameterized,
): string | null => {
	const candidate = disposition.params.filename ?? contentType.params.name;
	if (!candidate) return null;
	const decoded = collapseWhitespace(decodeWords(unquote(candidate)));
	return decoded || null;
};

const addAttachment = (
	headers: RawHeader[],
	contentType: ContentType,
	disposition: Parameterized,
	encoding: string | undefined,
	body: string,
	context: ParseContext,
): void => {
	const content = decodeTransfer(body, encoding);
	if (content.byteLength > context.limits.maxAttachmentBytes) {
		throw limitError("EMAXATTACHMENTSIZE");
	}
	if (context.attachments.length + 1 > context.limits.maxAttachments) {
		throw limitError("EMAXATTACHMENTS");
	}
	context.attachments.push({
		partPath: `part-${context.attachments.length + 1}`,
		filename: attachmentName(contentType, disposition),
		mimeType: `${contentType.type}/${contentType.subtype}`,
		disposition: disposition.value || "attachment",
		contentId: firstHeader(headers, "content-id")?.trim() || null,
		content,
	});
};

const walk = (partText: string, depth: number, context: ParseContext): void => {
	if (depth > context.limits.maxNestingDepth) throw limitError("EMAXNESTINGDEPTH");
	context.parts += 1;
	if (context.parts > context.limits.maxPartCount) throw limitError("EMAXPARTCOUNT");

	const { headerText, body } = splitTopLevel(partText);
	if (headerText.length > context.limits.maxHeaderBytes) throw limitError("EMAXHEADERSIZE");
	const headers = parseHeaders(headerText);
	const contentType = parseContentType(firstHeader(headers, "content-type"));
	const disposition = parseParameterized(firstHeader(headers, "content-disposition"));
	const encoding = firstHeader(headers, "content-transfer-encoding");

	if (contentType.type === "multipart") {
		const boundary = contentType.params.boundary;
		if (!boundary) throw malformed();
		for (const slice of splitMultipart(body, boundary)) {
			walk(slice, depth + 1, context);
		}
		return;
	}

	if (contentType.type === "message") {
		addAttachment(headers, contentType, disposition, encoding, body, context);
		return;
	}

	const filename = attachmentName(contentType, disposition);
	if (disposition.value === "attachment" || filename !== null) {
		addAttachment(headers, contentType, disposition, encoding, body, context);
		return;
	}

	if (contentType.type === "text" && contentType.subtype === "plain") {
		if (context.text === null) {
			context.text = decodeBytes(
				decodeTransfer(body, encoding),
				contentType.params.charset,
			);
		}
		return;
	}

	if (contentType.type === "text" && contentType.subtype === "html") {
		if (context.html === null) {
			context.html = decodeBytes(
				decodeTransfer(body, encoding),
				contentType.params.charset,
			);
		}
		return;
	}

	// Any other leaf without a name is still opaque content, not a body.
	addAttachment(headers, contentType, disposition, encoding, body, context);
};

export function parseRawMime(raw: ArrayBuffer | Uint8Array, limits: MailLimits): RawMime {
	const binary = bytesToBinary(raw);
	const split = splitTopLevel(binary);
	if (split.headerText.length > limits.maxHeaderBytes) throw limitError("EMAXHEADERSIZE");
	const headers = parseHeaders(split.headerText);

	const context: ParseContext = {
		limits,
		parts: 0,
		attachments: [],
		text: null,
		html: null,
	};
	walk(binary, 0, context);

	return {
		headers,
		subject: decodeWords(collapseWhitespace(firstHeader(headers, "subject") ?? "")),
		date: firstHeader(headers, "date")?.trim() || null,
		messageId: firstHeader(headers, "message-id")?.trim() || null,
		references: firstHeader(headers, "references")?.trim() || null,
		inReplyTo: firstHeader(headers, "in-reply-to")?.trim() || null,
		from: parseAddressList(firstHeader(headers, "from")),
		to: parseAddressList(firstHeader(headers, "to")),
		cc: parseAddressList(firstHeader(headers, "cc")),
		text: context.text,
		html: context.html,
		attachments: context.attachments,
	};
}
