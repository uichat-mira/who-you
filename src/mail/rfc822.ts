import { encodeBase64Url } from "./base64url";
import type { DraftAddress } from "./draft";
import type { OutboundMail } from "./send";

/**
 * Minimal RFC 5322 builder for Gmail `users.messages.send`. Gmail accepts a
 * base64url-encoded raw message; it does not need (and must not receive) a
 * sender envelope controlled by the caller, so `From` is always the identity
 * address already authorized for this mailbox.
 */

const CRLF = "\r\n";

const sanitize = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

const bytesToBinary = (bytes: Uint8Array): string => {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 8192) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
	}
	return binary;
};

const encodeHeaderValue = (value: string): string => {
	const clean = sanitize(value);
	if (!/[^\x20-\x7E]/.test(clean)) return clean;
	return `=?UTF-8?B?${btoa(bytesToBinary(new TextEncoder().encode(clean)))}?=`;
};

const formatAddress = (entry: DraftAddress): string =>
	entry.name
		? `${encodeHeaderValue(entry.name)} <${sanitize(entry.address)}>`
		: sanitize(entry.address);

const base64Body = (value: string): string =>
	btoa(bytesToBinary(new TextEncoder().encode(value)))
		.replace(/(.{76})/g, `$1${CRLF}`)
		.replace(new RegExp(`${CRLF}$`), "");

const domainOf = (address: string): string => {
	const at = address.lastIndexOf("@");
	return at >= 0 ? sanitize(address.slice(at + 1)) : "who-you.invalid";
};

export type Rfc822Options = {
	now?: number;
	/** Test seam; production always generates a random Message-ID. */
	messageId?: string;
};

export function buildRfc822Message(
	message: OutboundMail,
	options: Rfc822Options = {},
): string {
	const domain = domainOf(message.from);
	const messageId =
		options.messageId ??
		`<${encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))}@${domain}>`;
	const date = new Date(options.now ?? Date.now()).toUTCString();

	const headers = [
		`Date: ${date}`,
		`Message-ID: ${messageId}`,
		`From: ${sanitize(message.from)}`,
		`To: ${message.to.map(formatAddress).join(", ")}`,
		message.cc.length ? `Cc: ${message.cc.map(formatAddress).join(", ")}` : "",
		message.bcc.length ? `Bcc: ${message.bcc.map(formatAddress).join(", ")}` : "",
		`Subject: ${encodeHeaderValue(message.subject)}`,
		"MIME-Version: 1.0",
	].filter(Boolean);

	if (!message.html) {
		return [
			...headers,
			'Content-Type: text/plain; charset="utf-8"',
			"Content-Transfer-Encoding: base64",
			"",
			base64Body(message.text),
		].join(CRLF);
	}

	const boundary = `who-you-${encodeBase64Url(crypto.getRandomValues(new Uint8Array(12)))}`;
	return [
		...headers,
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		'Content-Type: text/plain; charset="utf-8"',
		"Content-Transfer-Encoding: base64",
		"",
		base64Body(message.text),
		`--${boundary}`,
		'Content-Type: text/html; charset="utf-8"',
		"Content-Transfer-Encoding: base64",
		"",
		base64Body(message.html),
		`--${boundary}--`,
		"",
	].join(CRLF);
}

/** Gmail wants unpadded base64url over the UTF-8 bytes of the raw message. */
export const encodeRawMessage = (raw: string): string => encodeBase64Url(raw);
