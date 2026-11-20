/**
 * Address rules for the single owned S1 domain. These are proposals from
 * product design §5.2 and remain replaceable; nothing here claims a final
 * product decision on user-selected vs derived local parts.
 */

const LOCAL_PART_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DOMAIN_PATTERN =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const MAX_LOCAL_PART = 32;
const MIN_LOCAL_PART = 3;

/** Case-insensitive reserved local parts that must never be assigned to a user. */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
	"postmaster",
	"abuse",
	"admin",
	"administrator",
	"root",
	"hostmaster",
	"webmaster",
	"security",
	"mailer-daemon",
	"noreply",
	"no-reply",
	"bounce",
	"dmarc",
	"spf",
	"dkim",
	"who-you",
	"whoyou",
	"mira",
	"support",
	"billing",
	"legal",
	"privacy",
	"api",
	"mcp",
	"system",
	"daemon",
	"www",
	"mail",
	"hello",
	"info",
]);

export type LocalPartResult =
	| { ok: true; localPart: string }
	| { ok: false; reason: "invalid_local_part" | "reserved_local_part" };

export const isReservedLocalPart = (localPart: string): boolean =>
	RESERVED_LOCAL_PARTS.has(localPart.toLowerCase());

/**
 * Canonical local part: Unicode-normalized, lowercased, ASCII-only grammar,
 * 3–32 characters, single separators, no leading/trailing separator.
 */
export function normalizeLocalPart(input: string): LocalPartResult {
	const localPart = input.normalize("NFC").trim().toLowerCase();
	if (!localPart || localPart.length < MIN_LOCAL_PART || localPart.length > MAX_LOCAL_PART) {
		return { ok: false, reason: "invalid_local_part" };
	}
	if (!LOCAL_PART_PATTERN.test(localPart)) {
		return { ok: false, reason: "invalid_local_part" };
	}
	if (isReservedLocalPart(localPart)) {
		return { ok: false, reason: "reserved_local_part" };
	}
	return { ok: true, localPart };
}

export function normalizeDomain(input: string): string | null {
	const domain = input.trim().toLowerCase().replace(/^@+/, "");
	if (!domain || domain.length > 253 || !DOMAIN_PATTERN.test(domain)) return null;
	return domain;
}

export const mailboxAddress = (localPart: string, domain: string): string =>
	`${localPart}@${domain}`;

export type RecipientResult =
	| { ok: true; localPart: string; address: string }
	| { ok: false; reason: "invalid_recipient" | "wrong_domain" };

/**
 * Resolves an envelope recipient against the owned domain. Sub-addressing
 * (`user+tag@`) and display-name forms are not accepted, so an inbound delivery
 * can never be routed to an address that was never provisioned.
 */
export function resolveRecipient(value: string, domain: string): RecipientResult {
	const address = value.normalize("NFC").trim().toLowerCase();
	const at = address.lastIndexOf("@");
	if (at <= 0 || at === address.length - 1) {
		return { ok: false, reason: "invalid_recipient" };
	}
	const localPart = address.slice(0, at);
	const recipientDomain = address.slice(at + 1);
	if (recipientDomain !== domain) {
		return { ok: false, reason: "wrong_domain" };
	}
	if (localPart.length < MIN_LOCAL_PART || localPart.length > MAX_LOCAL_PART) {
		return { ok: false, reason: "invalid_recipient" };
	}
	if (!LOCAL_PART_PATTERN.test(localPart)) {
		return { ok: false, reason: "invalid_recipient" };
	}
	return { ok: true, localPart, address: mailboxAddress(localPart, domain) };
}
