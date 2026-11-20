import { mailboxAddress, normalizeLocalPart } from "./address";
import { sha256Hex } from "./hash";
import type { MailRepository, MailboxRecord } from "./store";

/**
 * Rules echoed to the caller when a mailbox prefix has to be supplied by hand.
 * Kept next to `normalizeLocalPart` so the copy cannot drift from the validator.
 */
export const LOCAL_PART_RULES =
	"3–32 characters; lowercase letters and digits, with single '.', '_' or '-' separators between them; no leading, trailing or doubled separator; not a reserved name.";

export type LocalPartDecision =
	| { ok: true; localPart: string; source: "derived" | "requested" }
	| {
			ok: false;
			code: "local_part_required" | "invalid_local_part" | "reserved_local_part";
	  };

/**
 * Resolves the local part for a lazy provision. An explicit request always wins
 * over derivation. A Cloud Auth username that cannot be normalized never falls
 * back to a generated address: the caller must ask the user for a prefix, so two
 * accounts can never be handed an address nobody chose.
 */
export function decideLocalPart(input: {
	localPart?: string | null;
	username?: string | null;
}): LocalPartDecision {
	const requested = input.localPart?.trim();
	if (requested) {
		const normalized = normalizeLocalPart(requested);
		return normalized.ok
			? { ok: true, localPart: normalized.localPart, source: "requested" }
			: { ok: false, code: normalized.reason };
	}

	const username = input.username?.trim();
	if (!username) return { ok: false, code: "local_part_required" };
	const derived = normalizeLocalPart(username);
	// An unusable username is a prompt, not a rejection: the user still gets to
	// choose the prefix instead of being told which characters were wrong.
	return derived.ok
		? { ok: true, localPart: derived.localPart, source: "derived" }
		: { ok: false, code: "local_part_required" };
}

export type ProvisionFailureCode =
	| "local_part_required"
	| "invalid_local_part"
	| "reserved_local_part"
	| "address_taken";

export type ProvisionOwnMailboxResult =
	| { ok: true; mailbox: MailboxRecord; created: boolean }
	| { ok: false; code: ProvisionFailureCode; detail: string };

const auditId = async (accountId: string, detail: string, now: number): Promise<string> =>
	`aud_${(await sha256Hex(`${accountId}\nprovision\n${detail}\n${now}`)).slice(0, 32)}`;

/**
 * S6 lazy provisioning: one owned address per Cloud Account, created on first
 * use. The address is exactly the normalized local part, never a suffixed
 * variant — a collision is reported so the user can pick another prefix.
 *
 * Rejections and creations are audited with the account id and a reason code
 * only; the address itself is already the mailbox's own key and is not repeated
 * into the audit detail.
 */
export async function provisionOwnMailbox(
	repository: MailRepository,
	options: {
		accountId: string;
		username?: string | null;
		localPart?: string | null;
		domain: string;
		quotaBytes: number;
		now: number;
	},
): Promise<ProvisionOwnMailboxResult> {
	const existing = await repository.findMailboxByAccount(options.accountId);
	if (existing) return { ok: true, mailbox: existing, created: false };

	const decision = decideLocalPart(options);
	if (!decision.ok) {
		// `local_part_required` is an instruction to ask the user, not a rejected
		// grant attempt, so it does not produce an audit row.
		if (decision.code !== "local_part_required") {
			await repository.insertAudit({
				id: await auditId(options.accountId, decision.code, options.now),
				accountId: options.accountId,
				action: "provision_mailbox",
				targetId: null,
				detail: decision.code,
				createdAt: options.now,
			});
		}
		return {
			ok: false,
			code: decision.code,
			detail:
				decision.code === "local_part_required"
					? "This Cloud Account has no usable username for an address; ask the user for the mailbox prefix they want and retry with `localPart`."
					: `That mailbox prefix is not allowed. ${LOCAL_PART_RULES}`,
		};
	}

	const { localPart } = decision;
	const id = `mbx_${(await sha256Hex(`${options.accountId}\n${localPart}`)).slice(0, 32)}`;
	const address = mailboxAddress(localPart, options.domain);

	let inserted: boolean;
	try {
		inserted = await repository.insertMailbox({
			id,
			accountId: options.accountId,
			address,
			localPart,
			kind: "own_domain",
			provider: null,
			quotaBytes: options.quotaBytes,
			now: options.now,
		});
	} catch {
		// A concurrent provision for the same account can win the account_id
		// uniqueness before this insert; that is success, not a failure.
		const raced = await repository.findMailboxByAccount(options.accountId);
		if (!raced) throw new Error("mailbox_provision_failed");
		return { ok: true, mailbox: raced, created: false };
	}

	if (!inserted) {
		const raced = await repository.findMailboxByAccount(options.accountId);
		if (raced) return { ok: true, mailbox: raced, created: false };
		await repository.insertAudit({
			id: await auditId(options.accountId, "address_taken", options.now),
			accountId: options.accountId,
			action: "provision_mailbox",
			targetId: null,
			detail: "address_taken",
			createdAt: options.now,
		});
		return {
			ok: false,
			code: "address_taken",
			detail: `The address ${address} is already assigned to another account; ask the user for a different mailbox prefix.`,
		};
	}

	const mailbox: MailboxRecord = {
		id,
		accountId: options.accountId,
		address,
		localPart,
		kind: "own_domain",
		provider: null,
		status: "active",
		quotaBytes: options.quotaBytes,
		bytesUsed: 0,
		messageCount: 0,
		quarantineCount: 0,
		sendPausedAt: null,
		sendPausedReason: null,
		createdAt: options.now,
	};
	await repository.insertAudit({
		id: await auditId(options.accountId, "created", options.now),
		accountId: options.accountId,
		action: "provision_mailbox",
		targetId: id,
		detail: decision.source,
		createdAt: options.now,
	});
	return { ok: true, mailbox, created: true };
}
