import { normalizeDomain } from "./address";
import { sha256Hex } from "./hash";

/**
 * Draft content rules for S2. Address acceptance is deliberately narrower than
 * RFC 5322: ASCII local parts, an ASCII domain with a dotted label, no display
 * name syntax, no quoting and no header folding. Anything outside that set is
 * rejected instead of guessed, which also removes header-injection surface.
 */

export type DraftAddress = { name: string; address: string };

export type DraftContent = {
	to: DraftAddress[];
	cc: DraftAddress[];
	bcc: DraftAddress[];
	subject: string;
	text: string;
	html: string | null;
};

/** Partial content used by create and by the field-overlay update path. */
export type DraftContentInput = {
	to?: DraftAddress[];
	cc?: DraftAddress[];
	bcc?: DraftAddress[];
	subject?: string;
	text?: string;
	html?: string | null;
};

export type DraftErrorCode =
	| "no_recipients"
	| "invalid_recipient"
	| "too_many_recipients"
	| "invalid_subject"
	| "invalid_body"
	| "empty_body";

export type DraftBuildResult =
	| { ok: true; content: DraftContent }
	| { ok: false; reason: DraftErrorCode };

export const MAX_SUBJECT_CHARS = 998;
export const MAX_BODY_CHARS = 200_000;
export const MAX_RECIPIENTS_PER_FIELD = 20;
export const MAX_TOTAL_RECIPIENTS = 20;
const MAX_ADDRESS_CHARS = 320;
const MAX_LOCAL_PART_CHARS = 64;
const MAX_NAME_CHARS = 128;
// Dot-atom local part, ASCII only. Quoted local parts are intentionally out.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

const stripControls = (value: string): string =>
	[...value]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
		.join("");

const normalizeName = (value: string): string =>
	stripControls(value)
		.replace(/[<>]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_NAME_CHARS);

const normalizeAddress = (value: string): string | null => {
	const address = stripControls(value).trim().toLowerCase();
	if (address.length > MAX_ADDRESS_CHARS) return null;
	const at = address.lastIndexOf("@");
	if (at <= 0 || at === address.length - 1) return null;
	const localPart = address.slice(0, at);
	const domain = address.slice(at + 1);
	if (localPart.length > MAX_LOCAL_PART_CHARS || !LOCAL_PART.test(localPart)) {
		return null;
	}
	// normalizeDomain returns the canonical form only for a dotted ASCII domain,
	// so an equality check is the validity check.
	if (normalizeDomain(domain) !== domain) return null;
	return address;
};

type RecipientResult = { ok: true; addresses: DraftAddress[] } | { ok: false; reason: DraftErrorCode };

const normalizeRecipient = (value: DraftAddress): DraftAddress | null => {
	const address = normalizeAddress(value.address ?? "");
	if (!address) return null;
	return { name: normalizeName(value.name ?? ""), address };
};

function buildRecipientField(input: DraftAddress[] | undefined): RecipientResult {
	if (!input) return { ok: true, addresses: [] };
	if (input.length > MAX_RECIPIENTS_PER_FIELD) {
		return { ok: false, reason: "too_many_recipients" };
	}
	const seen = new Set<string>();
	const addresses: DraftAddress[] = [];
	for (const entry of input) {
		const normalized = normalizeRecipient(entry);
		if (!normalized) return { ok: false, reason: "invalid_recipient" };
		if (seen.has(normalized.address)) continue;
		seen.add(normalized.address);
		addresses.push(normalized);
	}
	return { ok: true, addresses };
}

const normalizeSubject = (value: string | undefined): string | null => {
	const subject = stripControls(value ?? "").replace(/\s+/g, " ").trim();
	if (subject.length > MAX_SUBJECT_CHARS) return null;
	return subject;
};

/**
 * Bodies keep line structure (normalized to LF) because formatting is content,
 * and reject every other ASCII control character. Header fields use
 * `stripControls` instead, where folding is never acceptable.
 */
const normalizeBody = (value: string | undefined): string | null => {
	const body = (value ?? "").replace(/\r\n?/g, "\n");
	for (const character of body) {
		const code = character.charCodeAt(0);
		if ((code < 32 && code !== 10 && code !== 9) || code === 127) return null;
	}
	if (body.length > MAX_BODY_CHARS) return null;
	return body;
};

/**
 * Builds the canonical content of one draft revision. Omitted fields default to
 * empty; a draft must have at least one recipient and a non-empty body so that
 * send cannot emit an accidental blank message.
 */
export function buildDraftContent(input: DraftContentInput): DraftBuildResult {
	const to = buildRecipientField(input.to);
	if (!to.ok) return to;
	const cc = buildRecipientField(input.cc);
	if (!cc.ok) return cc;
	const bcc = buildRecipientField(input.bcc);
	if (!bcc.ok) return bcc;

	const total = to.addresses.length + cc.addresses.length + bcc.addresses.length;
	if (total === 0) return { ok: false, reason: "no_recipients" };
	if (total > MAX_TOTAL_RECIPIENTS) return { ok: false, reason: "too_many_recipients" };

	const subject = normalizeSubject(input.subject);
	if (subject === null) return { ok: false, reason: "invalid_subject" };

	const text = normalizeBody(input.text);
	const html = input.html === undefined || input.html === null ? null : normalizeBody(input.html);
	if (text === null || (input.html !== undefined && input.html !== null && html === null)) {
		return { ok: false, reason: "invalid_body" };
	}
	if (!text && !html) return { ok: false, reason: "empty_body" };

	return { ok: true, content: { to: to.addresses, cc: cc.addresses, bcc: bcc.addresses, subject, text, html } };
}

const addressJson = (entry: DraftAddress): { name: string; address: string } => ({
	name: entry.name,
	address: entry.address,
});

/**
 * Fixed-order canonical payload. The confirmation credential binds this digest
 * to one draft revision, so the order of keys and of each field must never
 * change without a new credential contract.
 *
 * Attachment descriptors are always part of the payload even though this slice
 * rejects attachment input: the placeholder keeps the hash domain stable once
 * the upload protocol is approved.
 */
export function canonicalDraftPayload(content: DraftContent): string {
	return JSON.stringify({
		to: content.to.map(addressJson),
		cc: content.cc.map(addressJson),
		bcc: content.bcc.map(addressJson),
		subject: content.subject,
		text: content.text,
		html: content.html,
		attachments: [],
	});
}

export async function draftContentHash(content: DraftContent): Promise<string> {
	return sha256Hex(canonicalDraftPayload(content));
}
