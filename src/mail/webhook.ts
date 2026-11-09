import type { webcrypto } from "node:crypto";
import { createMailServices, type WhoYouEnv } from "./config";
import { recordDeliveryEvents } from "./deliverability";
import { parseDeliveryReport } from "./dsn";

/**
 * Authenticated relay callback.
 *
 * The relay is a separate process (Cloudflare Email Service delivery
 * notifications or a provider webhook adapter). It authenticates with an
 * independent HMAC secret instead of an agent MCP token: agents must never be
 * able to write delivery evidence, pause accounts or suppress recipients.
 *
 * Request signature:
 *   x-whoyou-timestamp: epoch milliseconds
 *   x-whoyou-nonce:     8-128 chars of [A-Za-z0-9._:-]
 *   x-whoyou-signature: hex HMAC-SHA256(secret, `${timestamp}\n${nonce}\n${body}`)
 *
 * Body: { report: "<raw DSN/ARF MIME>", accountId?: "...", providerMessageId?: "..." }
 *
 * Fail-closed: a missing secret disables the route with 503, a stale timestamp
 * or bad signature is 401, a reused nonce is 409, and an unroutable report is
 * 422. Nothing here echoes a address, subject or body.
 */

export const DELIVERY_WEBHOOK_PATH = "/internal/delivery";
export const DELIVERY_TIMESTAMP_HEADER = "x-whoyou-timestamp";
export const DELIVERY_NONCE_HEADER = "x-whoyou-nonce";
export const DELIVERY_SIGNATURE_HEADER = "x-whoyou-signature";
export const DELIVERY_MAX_SKEW_MS = 5 * 60 * 1000;
export const DELIVERY_MAX_BODY_BYTES = 1024 * 1024;
const NONCE_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REPORT_CHARS = 1024 * 1024;

const encoder = new TextEncoder();

const json = (body: unknown, status: number): Response => Response.json(body, { status });

const timingSafeEqualHex = (left: string, right: string): boolean => {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
};

export function webhookSigningPayload(
	timestamp: string,
	nonce: string,
	rawBody: string,
): string {
	return `${timestamp}\n${nonce}\n${rawBody}`;
}

const importHmacKey = async (secret: string): Promise<webcrypto.CryptoKey> =>
	crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");

export async function computeWebhookSignature(
	secret: string,
	timestamp: string,
	nonce: string,
	rawBody: string,
): Promise<string> {
	const key = await importHmacKey(secret);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(webhookSigningPayload(timestamp, nonce, rawBody)),
	);
	return hex(signature);
}

export async function verifyWebhookSignature(
	secret: string,
	timestamp: string,
	nonce: string,
	rawBody: string,
	provided: string,
): Promise<boolean> {
	if (!SIGNATURE_PATTERN.test(provided.toLowerCase())) return false;
	const expected = await computeWebhookSignature(secret, timestamp, nonce, rawBody);
	return timingSafeEqualHex(expected, provided.toLowerCase());
}

type DeliveryWebhookPayload = {
	report: string;
	accountId?: string;
	providerMessageId?: string;
};

const parsePayload = (raw: string): DeliveryWebhookPayload | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const report = record.report;
	if (typeof report !== "string" || !report.trim() || report.length > MAX_REPORT_CHARS) {
		return null;
	}
	const accountId =
		typeof record.accountId === "string" && record.accountId.trim()
			? record.accountId.trim()
			: undefined;
	const providerMessageId =
		typeof record.providerMessageId === "string" && record.providerMessageId.trim()
			? record.providerMessageId.trim()
			: undefined;
	if ((accountId?.length ?? 0) > 128 || (providerMessageId?.length ?? 0) > 256) {
		return null;
	}
	return { report, accountId, providerMessageId };
};

export async function handleDeliveryWebhook(
	request: Request,
	env: WhoYouEnv,
): Promise<Response> {
	if (request.method !== "POST") {
		return json({ error: "method_not_allowed" }, 405);
	}

	const secret = (env.MAIL_INTERNAL_WEBHOOK_SECRET ?? "").trim();
	if (secret.length < 32) {
		return json({ error: "delivery_webhook_not_configured" }, 503);
	}

	const timestamp = request.headers.get(DELIVERY_TIMESTAMP_HEADER) ?? "";
	const nonce = request.headers.get(DELIVERY_NONCE_HEADER) ?? "";
	const signature = request.headers.get(DELIVERY_SIGNATURE_HEADER) ?? "";
	if (!timestamp || !nonce || !signature) {
		return json({ error: "invalid_signature" }, 401);
	}
	if (!NONCE_PATTERN.test(nonce)) {
		return json({ error: "invalid_signature" }, 401);
	}

	const receivedAt = Number(timestamp);
	if (!Number.isInteger(receivedAt) || Math.abs(Date.now() - receivedAt) > DELIVERY_MAX_SKEW_MS) {
		return json({ error: "stale_timestamp" }, 401);
	}

	const rawBody = await request.text();
	if (rawBody.length > DELIVERY_MAX_BODY_BYTES) {
		return json({ error: "payload_too_large" }, 413);
	}
	if (!(await verifyWebhookSignature(secret, timestamp, nonce, rawBody, signature))) {
		return json({ error: "invalid_signature" }, 401);
	}

	const resolved = createMailServices(env);
	if (!resolved.ok) {
		return json({ error: "mail_storage_not_configured" }, 503);
	}
	const repository = resolved.services.repository;

	const payload = parsePayload(rawBody);
	if (!payload) {
		return json({ error: "invalid_payload" }, 400);
	}

	const receipt = payload.providerMessageId
		? await repository.findReceiptByProviderMessageId(payload.providerMessageId)
		: null;
	if (payload.accountId && receipt && receipt.accountId !== payload.accountId) {
		return json({ error: "account_mismatch" }, 400);
	}
	const accountId = receipt?.accountId ?? payload.accountId ?? null;
	if (!accountId) {
		return json({ error: "delivery_event_unroutable" }, 422);
	}

	const parsed = parseDeliveryReport(payload.report);
	if (!parsed.ok) {
		return json({ error: parsed.reason }, parsed.reason === "not_a_report" ? 415 : 400);
	}

	// Consume the nonce only once the request is known to be processable, so a
	// malformed retry does not burn the relay's replay slot. The unique insert
	// still makes a replayed valid request fail closed.
	if (!(await repository.insertWebhookNonce(nonce, receivedAt))) {
		return json({ error: "replay_rejected" }, 409);
	}

	const result = await recordDeliveryEvents(repository, resolved.services.abuse, {
		accountId,
		sendReceiptId: receipt?.id ?? null,
		providerMessageId: payload.providerMessageId ?? null,
		events: parsed.report.events,
		now: Date.now(),
	});

	return json(
		{
			ok: true,
			reportType: parsed.report.reportType,
			recorded: result.recorded,
			suppressed: result.suppressed,
			paused: result.paused,
		},
		200,
	);
}
