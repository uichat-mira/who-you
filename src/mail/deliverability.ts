import { evaluateAbuse, type AbusePolicy } from "./abuse";
import type { ParsedDeliveryEvent } from "./dsn";
import { normalizeRecipient } from "./dsn";
import { sha256Hex } from "./hash";
import type { MailRepository } from "./store";

/**
 * Send-side gate and post-delivery abuse brake.
 *
 * The gate runs inside the existing send pipeline, after the confirmation is
 * verified and before the single-use nonce is spent, so a paused account or a
 * suppressed recipient never reaches the relay and never burns a credential.
 */

export type SendGateResult =
	| { ok: true }
	| {
			ok: false;
			code: "send_paused" | "recipient_suppressed";
			/** PII-free explanation suitable for tool output and logs. */
			detail: string;
	  };

export interface SendGate {
	check(accountId: string, recipients: string[]): Promise<SendGateResult>;
}

export interface AbuseMonitor {
	afterSend(accountId: string, now: number): Promise<void>;
}

const normalizeAll = (recipients: string[]): string[] => {
	const normalized = recipients
		.map((recipient) => normalizeRecipient(recipient))
		.filter((recipient): recipient is string => recipient !== null);
	return [...new Set(normalized)];
};

export function createSendGate(repository: MailRepository): SendGate {
	return {
		async check(accountId, recipients) {
			const pause = await repository.findSendPause(accountId);
			if (pause) {
				return {
					ok: false,
					code: "send_paused",
					detail: `Outbound sending for this account is paused (${pause.reason ?? "policy"}). Sending requires a human to review and resume the account; there is no automatic resume in this slice.`,
				};
			}
			const normalized = normalizeAll(recipients);
			if (!normalized.length) return { ok: true };
			const suppressed = await repository.findSuppressedRecipients(accountId, normalized);
			if (suppressed.length) {
				return {
					ok: false,
					code: "recipient_suppressed",
					detail:
						"At least one recipient is suppressed after a previous hard bounce or spam complaint. Remove that recipient from the draft; a new confirmation will handle a resend.",
				};
			}
			return { ok: true };
		},
	};
}

const pauseIfNeeded = async (
	repository: MailRepository,
	policy: AbusePolicy,
	accountId: string,
	now: number,
): Promise<boolean> => {
	const window = await repository.abuseWindow(accountId, now - policy.windowMs);
	const verdict = evaluateAbuse(window, policy);
	if (!verdict.pause) return false;
	const paused = await repository.pauseSend(accountId, verdict.kind, now);
	if (paused) {
		await repository.insertDeliverabilityAlert({
			id: `alert_${(await sha256Hex(`${accountId}\n${verdict.kind}\n${now}`)).slice(0, 32)}`,
			accountId,
			kind: verdict.kind,
			detail: verdict.detail,
			createdAt: now,
		});
		// Structured, PII-free alarm trail: counters and machine reason only.
		console.log(
			JSON.stringify({
				event: "whoyou_deliverability_pause",
				accountId,
				kind: verdict.kind,
				detail: verdict.detail,
			}),
		);
	}
	return paused;
};

/**
 * Runs after a receipt is durable: the current message is already accepted, so
 * the brake applies to subsequent sends instead of pretending to recall it.
 */
export function createAbuseMonitor(
	repository: MailRepository,
	policy: AbusePolicy,
): AbuseMonitor {
	return {
		async afterSend(accountId, now) {
			await pauseIfNeeded(repository, policy, accountId, now);
		},
	};
}

export type RecordDeliveryResult = {
	recorded: number;
	suppressed: number;
	paused: boolean;
};

/**
 * Persists parsed reports. Event ids are derived from account, type, recipient
 * hash and time, so an HMAC-authenticated retry cannot double-count; suppression
 * is insert-only and permanent for this slice.
 */
export async function recordDeliveryEvents(
	repository: MailRepository,
	policy: AbusePolicy,
	input: {
		accountId: string;
		sendReceiptId: string | null;
		providerMessageId: string | null;
		events: ParsedDeliveryEvent[];
		now: number;
	},
): Promise<RecordDeliveryResult> {
	let recorded = 0;
	let suppressed = 0;
	for (const event of input.events) {
		for (const recipient of event.recipients) {
			const hash = await sha256Hex(recipient);
			const domain = recipient.slice(recipient.lastIndexOf("@") + 1);
			// Prefer the original message id so two relay retries carrying
			// different nonces still count once for the same bounce.
			const dedupeKey =
				event.originalMessageId ?? input.providerMessageId ?? String(input.now);
			const id = `devt_${(await sha256Hex(`${input.accountId}\n${event.type}\n${hash}\n${dedupeKey}`)).slice(0, 32)}`;
			const inserted = await repository.insertDeliveryEvent({
				id,
				accountId: input.accountId,
				sendReceiptId: input.sendReceiptId,
				providerMessageId: input.providerMessageId,
				type: event.type,
				recipientHash: hash,
				recipientDomain: domain,
				status: event.status,
				diagnosticCode: event.diagnosticCode,
				occurredAt: input.now,
				createdAt: input.now,
			});
			if (inserted) recorded += 1;
			if (event.type === "hard_bounce" || event.type === "complaint") {
				const created = await repository.insertSuppression({
					accountId: input.accountId,
					recipient,
					reason: event.type,
					sourceEventId: id,
					createdAt: input.now,
				});
				if (created) suppressed += 1;
			}
		}
	}
	return {
		recorded,
		suppressed,
		paused: await pauseIfNeeded(repository, policy, input.accountId, input.now),
	};
}

export type DeliverabilityReport = {
	since: number;
	sends: number;
	externalRecipients: number;
	delivered: number;
	softBounces: number;
	hardBounces: number;
	complaints: number;
	suppressedRecipients: number;
	pausedAccounts: number;
};

/**
 * Daily domain-reputation aggregate. It is a counter report over existing rows,
 * not a DMARC report-ingestion pipeline (that remains a documented gap).
 */
export async function runDeliverabilityReport(
	repository: MailRepository,
	now: number,
): Promise<DeliverabilityReport> {
	const since = now - 24 * 60 * 60 * 1000;
	const totals = await repository.deliverabilityTotals(since);
	return {
		since,
		...totals,
		suppressedRecipients: await repository.countSuppressions(),
		pausedAccounts: await repository.countPausedAccounts(),
	};
}
