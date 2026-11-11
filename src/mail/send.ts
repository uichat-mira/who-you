import type { VerifiedConfirmation, WhoYouConfirmationVerifier } from "./confirmation";
import { ConfirmationCredentialError } from "./confirmation";
import type { AbuseMonitor, SendGate } from "./deliverability";
import { draftContentHash, type DraftAddress } from "./draft";
import type { DraftRepository, SendReceipt } from "./draft-store";
import { sha256Hex } from "./hash";

/**
 * Outbound port. The deployed adapters are Resend (preferred) and the
 * Cloudflare Email Service `send_email` binding; tests inject a deterministic
 * fake. Who You never speaks SMTP or any other provider protocol directly.
 */
export type OutboundMail = {
	from: string;
	to: DraftAddress[];
	cc: DraftAddress[];
	bcc: DraftAddress[];
	subject: string;
	text: string;
	html: string | null;
};

export interface MailSender {
	send(message: OutboundMail): Promise<{ providerMessageId: string }>;
}

const toPlatformAddress = (entry: DraftAddress): { name: string; email: string } => ({
	name: entry.name,
	email: entry.address,
});

/**
 * Returns `null` when the binding is absent so the send path reports
 * `relay_unavailable` instead of pretending a message left the Worker.
 */
export function createCloudflareMailSender(
	binding: SendEmail | undefined,
): MailSender | null {
	if (!binding) return null;
	return {
		async send(message: OutboundMail): Promise<{ providerMessageId: string }> {
			const result = await binding.send({
				from: message.from,
				to: message.to.map(toPlatformAddress),
				cc: message.cc.map(toPlatformAddress),
				bcc: message.bcc.map(toPlatformAddress),
				subject: message.subject,
				text: message.text,
				...(message.html === null ? {} : { html: message.html }),
			});
			return { providerMessageId: result.messageId };
		},
	};
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const formatAddress = (entry: DraftAddress): string =>
	entry.name ? `${entry.name} <${entry.address}>` : entry.address;

/**
 * Resend adapter. Resend authenticates the sending domain with SPF/DKIM and
 * does not claim the domain's MX records, so the same domain can keep receiving
 * through Cloudflare Email Routing while sending through Resend.
 *
 * Returns `null` when no key is configured so the send path reports
 * `relay_unavailable` instead of pretending a message left the Worker.
 */
export function createResendMailSender(
	apiKey: string | undefined,
): MailSender | null {
	const key = (apiKey ?? "").trim();
	if (!key) return null;
	return {
		async send(message: OutboundMail): Promise<{ providerMessageId: string }> {
			const response = await fetch(RESEND_ENDPOINT, {
				method: "POST",
				headers: {
					authorization: `Bearer ${key}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					from: message.from,
					to: message.to.map(formatAddress),
					...(message.cc.length ? { cc: message.cc.map(formatAddress) } : {}),
					...(message.bcc.length ? { bcc: message.bcc.map(formatAddress) } : {}),
					subject: message.subject,
					text: message.text,
					...(message.html === null ? {} : { html: message.html }),
				}),
			});
			if (!response.ok) {
				// Status only: a provider error body can echo recipients or content.
				throw new Error(`resend_send_failed:${response.status}`);
			}
			const payload = (await response.json()) as { id?: unknown };
			if (typeof payload.id !== "string" || payload.id.length === 0) {
				throw new Error("resend_send_missing_id");
			}
			return { providerMessageId: payload.id };
		},
	};
}

export type SendFailureCode =
	| "draft_not_found"
	| "confirmation_invalid"
	| "confirmation_draft_mismatch"
	| "draft_version_mismatch"
	| "draft_content_changed"
	| "confirmation_replayed"
	| "relay_unavailable"
	| "idempotency_key_reused"
	| "recipient_suppressed"
	| "send_paused";

export type SendDraftResult =
	| { ok: true; receipt: SendReceipt; alreadySent: boolean }
	| { ok: false; code: SendFailureCode; detail: string };

export type SendDraftDependencies = {
	drafts: DraftRepository;
	confirmations: WhoYouConfirmationVerifier;
	sender: MailSender | null;
	/** Sender address of the caller's own provisioned mailbox. */
	from: string | null;
	/** Suppression / pause gate; consulted before the nonce is spent. */
	gate: SendGate;
	/** Post-receipt abuse brake; never runs before a message is durable. */
	monitor: AbuseMonitor;
	now: () => number;
};

const receiptId = async (accountId: string, idempotencyKey: string): Promise<string> =>
	`rcpt_${(await sha256Hex(`${accountId}\n${idempotencyKey}`)).slice(0, 32)}`;

/**
 * S2 send pipeline: idempotency receipt first, then credential, then the
 * draft revision, then the single-use nonce, and only then the provider call.
 *
 * A failed provider call still spends the nonce. That is deliberate: the
 * outcome is unknown, so the same credential must never be able to send twice.
 * A failed attempt leaves no receipt, which keeps the idempotency key retryable
 * with a fresh confirmation.
 */
export async function sendDraft(
	deps: SendDraftDependencies,
	request: {
		accountId: string;
		draftId: string;
		confirmationCredential: string;
		idempotencyKey: string;
	},
): Promise<SendDraftResult> {
	const existing = await deps.drafts.findReceipt(request.accountId, request.idempotencyKey);
	if (existing) {
		if (existing.draftId !== request.draftId) {
			return {
				ok: false,
				code: "idempotency_key_reused",
				detail: "This idempotency key was already used for a different draft.",
			};
		}
		return { ok: true, receipt: existing, alreadySent: true };
	}

	const draft = await deps.drafts.getDraft(request.accountId, request.draftId);
	if (!draft || draft.status !== "draft") {
		return { ok: false, code: "draft_not_found", detail: "No editable draft exists for that id." };
	}

	let verified: VerifiedConfirmation;
	try {
		verified = await deps.confirmations.verifyConfirmation(request.confirmationCredential);
	} catch (error) {
		if (error instanceof ConfirmationCredentialError) {
			return {
				ok: false,
				code: "confirmation_invalid",
				detail: "The confirmation credential is missing, malformed or not issued for this account.",
			};
		}
		throw error;
	}

	if (verified.accountId !== request.accountId) {
		return {
			ok: false,
			code: "confirmation_invalid",
			detail: "The confirmation credential is missing, malformed or not issued for this account.",
		};
	}

	const confirmation = verified.confirmation;
	if (confirmation.draftId !== draft.id) {
		return {
			ok: false,
			code: "confirmation_draft_mismatch",
			detail: "The confirmation credential was issued for a different draft.",
		};
	}
	if (confirmation.draftVersion !== draft.version) {
		return {
			ok: false,
			code: "draft_version_mismatch",
			detail: `The confirmation was issued for version ${confirmation.draftVersion}, but the draft is now version ${draft.version}.`,
		};
	}

	// Recompute from stored content instead of trusting the stored column: this
	// catches both a stale credential and a tampered row.
	const recomputed = await draftContentHash(draft.content);
	if (recomputed !== confirmation.contentHash || recomputed !== draft.contentHash) {
		return {
			ok: false,
			code: "draft_content_changed",
			detail: "The confirmed content no longer matches the stored draft.",
		};
	}

	// Gate before the nonce: a paused account or a suppressed recipient must
	// never spend the credential or reach the relay.
	const recipients = [...draft.content.to, ...draft.content.cc, ...draft.content.bcc].map(
		(entry) => entry.address,
	);
	const gate = await deps.gate.check(request.accountId, recipients);
	if (!gate.ok) {
		return { ok: false, code: gate.code, detail: gate.detail };
	}

	if (!deps.sender || !deps.from) {
		return {
			ok: false,
			code: "relay_unavailable",
			detail: "No outbound mail binding or provisioned sender address is configured; nothing was sent.",
		};
	}

	const consumed = await deps.drafts.consumeNonce({
		nonce: confirmation.nonce,
		accountId: request.accountId,
		draftId: draft.id,
		now: deps.now(),
	});
	if (!consumed) {
		return {
			ok: false,
			code: "confirmation_replayed",
			detail: "This confirmation credential was already used; no second message was sent.",
		};
	}

	let providerMessageId: string;
	try {
		const sent = await deps.sender.send({
			from: deps.from,
			to: draft.content.to,
			cc: draft.content.cc,
			bcc: draft.content.bcc,
			subject: draft.content.subject,
			text: draft.content.text,
			html: draft.content.html,
		});
		providerMessageId = sent.providerMessageId;
	} catch {
		return {
			ok: false,
			code: "relay_unavailable",
			detail: "The outbound provider rejected or failed the message; delivery is unknown and the confirmation is spent.",
		};
	}

	const ownDomain = deps.from.slice(deps.from.lastIndexOf("@") + 1).toLowerCase();

	const receipt: SendReceipt = {
		id: await receiptId(request.accountId, request.idempotencyKey),
		accountId: request.accountId,
		draftId: draft.id,
		draftVersion: draft.version,
		contentHash: draft.contentHash,
		idempotencyKey: request.idempotencyKey,
		status: "sent",
		errorCode: null,
		providerMessageId,
		recipientCount: recipients.length,
		externalRecipientCount: recipients.filter((address) => {
			const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
			return domain !== ownDomain;
		}).length,
		createdAt: deps.now(),
	};

	if (!(await deps.drafts.insertReceipt(receipt))) {
		const raced = await deps.drafts.findReceipt(request.accountId, request.idempotencyKey);
		if (raced && raced.draftId === draft.id) {
			return { ok: true, receipt: raced, alreadySent: true };
		}
		return {
			ok: false,
			code: "idempotency_key_reused",
			detail: "This idempotency key was concurrently recorded for a different draft.",
		};
	}

	// The message is already accepted; a trip wire here can only stop future
	// sends, never revoke this receipt.
	await deps.monitor.afterSend(request.accountId, deps.now());

	return { ok: true, receipt, alreadySent: false };
}
