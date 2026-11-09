import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFixtureConfirmation } from "../dist/fixtures.mjs";
import { computeWebhookSignature } from "../dist/unit.mjs";
import { connect, seedTwoAccounts, withWorker } from "./node-harness.mjs";
import {
	complaintReport,
	deliveredReport,
	hardBounceReport,
} from "./s4-fixtures.mjs";

const SECRET = "s4-test-webhook-secret-0123456789abcdef";
const WEBHOOK_URL = "https://127.0.0.1/internal/delivery";

async function postReport(
	mf,
	{ report, accountId, providerMessageId, nonce, timestamp, secret = SECRET, signature },
) {
	const body = JSON.stringify({
		report,
		...(accountId ? { accountId } : {}),
		...(providerMessageId ? { providerMessageId } : {}),
	});
	const time = String(timestamp ?? Date.now());
	const signed =
		signature ?? (await computeWebhookSignature(secret, time, nonce, body));
	return mf.dispatchFetch(WEBHOOK_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-whoyou-timestamp": time,
			"x-whoyou-nonce": nonce,
			"x-whoyou-signature": signed,
		},
		body,
	});
}

async function sentMessages(mf) {
	const response = await mf.dispatchFetch("https://127.0.0.1/__sent");
	assert.equal(response.status, 200);
	return (await response.json()).sent;
}

async function sendTo(client, address, nonce, idempotencyKey) {
	const created = await client.callTool({
		name: "whoyou_mail_draft_create",
		arguments: {
			to: [{ name: "Recipient", address }],
			subject: "S4 deliverability fixture",
			text: "Synthetic body.",
		},
	});
	const draft = created.structuredContent.draft;
	const result = await client.callTool({
		name: "whoyou_mail_send",
		arguments: {
			draftId: draft.draftId,
			confirmationCredential: encodeFixtureConfirmation({
				accountId: "account-a",
				actor: "user",
				draftId: draft.draftId,
				draftVersion: draft.version,
				contentHash: draft.contentHash,
				nonce,
			}),
			idempotencyKey,
		},
	});
	return { draft, result };
}

test("a hard bounce suppresses the recipient and blocks the next send", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);

		const response = await postReport(mf, {
			report: hardBounceReport("alice@example.com"),
			accountId: "account-a",
			nonce: "s4-hard-bounce-nonce-01",
		});
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.reportType, "dsn");
		assert.equal(body.recorded, 1);
		assert.equal(body.suppressed, 1);
		assert.equal(body.paused, false);

		const event = await db
			.prepare("SELECT type, status, diagnostic_code, recipient_domain FROM delivery_events")
			.first();
		assert.equal(event.type, "hard_bounce");
		assert.equal(event.status, "5.1.1");
		assert.equal(event.diagnostic_code, "550 5.1.1");
		assert.equal(event.recipient_domain, "example.com");

		const suppression = await db
			.prepare("SELECT recipient, reason FROM suppressions")
			.first();
		assert.equal(suppression.recipient, "alice@example.com");
		assert.equal(suppression.reason, "hard_bounce");

		const client = await connect(mf, "fixture-mail-writer");
		try {
			const { result } = await sendTo(
				client,
				"alice@example.com",
				"nonce-s4-suppressed-01",
				"key-s4-suppressed-1",
			);
			assert.equal(result.isError, true);
			assert.equal(result.structuredContent.error, "recipient_suppressed");
		} finally {
			await client.close();
		}

		assert.deepEqual(await sentMessages(mf), []);
		const nonces = await db
			.prepare("SELECT COUNT(*) AS total FROM confirmation_nonces")
			.first();
		assert.equal(nonces.total, 0);
	});
});

test("complaints pause the account and the pause blocks sending", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);

		const first = await postReport(mf, {
			report: complaintReport("complainant-one@example.com"),
			accountId: "account-a",
			nonce: "s4-complaint-nonce-0001",
		});
		assert.equal(first.status, 200);
		assert.equal((await first.json()).paused, false);

		const second = await postReport(mf, {
			report: complaintReport("complainant-two@example.com"),
			accountId: "account-a",
			nonce: "s4-complaint-nonce-0002",
		});
		assert.equal(second.status, 200);
		assert.equal((await second.json()).paused, true);

		const pause = await db
			.prepare(
				"SELECT send_paused_at, send_paused_reason FROM mailboxes WHERE account_id = ?",
			)
			.bind("account-a")
			.first();
		assert.notEqual(pause.send_paused_at, null);
		assert.equal(pause.send_paused_reason, "complaint_rate");

		const alerts = await db
			.prepare("SELECT kind, detail FROM deliverability_alerts")
			.all();
		assert.equal(alerts.results.length, 1);
		assert.equal(alerts.results[0].kind, "complaint_rate");
		assert.equal(alerts.results[0].detail.includes("@"), false);

		const client = await connect(mf, "fixture-mail-writer");
		try {
			const { result } = await sendTo(
				client,
				"bob@example.com",
				"nonce-s4-paused-000001",
				"key-s4-paused-1",
			);
			assert.equal(result.isError, true);
			assert.equal(result.structuredContent.error, "send_paused");
		} finally {
			await client.close();
		}

		assert.deepEqual(await sentMessages(mf), []);
	});
});

test("the relay callback fails closed on configuration, signature and replay", async () => {
	await withWorker({ MAIL_INTERNAL_WEBHOOK_SECRET: "" }, async ({ mf }) => {
		const response = await postReport(mf, {
			report: deliveredReport("unused@example.com"),
			accountId: "account-a",
			nonce: "s4-no-secret-nonce-001",
			// The route must reject before touching the key, so any signature works.
			signature: "0".repeat(64),
		});
		assert.equal(response.status, 503);
		assert.equal((await response.json()).error, "delivery_webhook_not_configured");
	});

	await withWorker({}, async ({ mf }) => {
		const badSignature = await postReport(mf, {
			report: deliveredReport("unused@example.com"),
			accountId: "account-a",
			nonce: "s4-bad-signature-0001",
			signature: "0".repeat(64),
		});
		assert.equal(badSignature.status, 401);
		assert.equal((await badSignature.json()).error, "invalid_signature");

		const stale = await postReport(mf, {
			report: deliveredReport("unused@example.com"),
			accountId: "account-a",
			nonce: "s4-stale-nonce-000001",
			timestamp: Date.now() - 10 * 60 * 1000,
		});
		assert.equal(stale.status, 401);
		assert.equal((await stale.json()).error, "stale_timestamp");

		const options = {
			report: complaintReport("replay@example.com"),
			accountId: "account-a",
			nonce: "s4-replay-nonce-00001",
		};
		const accepted = await postReport(mf, options);
		assert.equal(accepted.status, 200);
		const replayed = await postReport(mf, options);
		assert.equal(replayed.status, 409);
		assert.equal((await replayed.json()).error, "replay_rejected");
	});
});

test("external recipient volume pauses an account and routes through a receipt", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);

		// Two receipts inside the window total 220 external recipients, above the
		// slice threshold of 200. Routing uses providerMessageId only, proving the
		// callback can attach the event to a known send without an account hint.
		for (const [index, count] of [
			[1, 120],
			[2, 100],
		]) {
			await db
				.prepare(
					`INSERT INTO send_receipts (
					 id, account_id, draft_id, draft_version, content_hash,
					 idempotency_key, status, error_code, provider_message_id,
					 recipient_count, external_recipient_count, created_at
					 ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.bind(
					`rcpt_s4_seed_${index}`,
					"account-a",
					`draft_s4_seed_${index}`,
					1,
					"a".repeat(64),
					`key-s4-seed-${index}`,
					"sent",
					null,
					`s4-provider-seed-${index}`,
					count,
					count,
					Date.now(),
				)
				.run();
		}

		const response = await postReport(mf, {
			report: deliveredReport("volume@example.com"),
			providerMessageId: "s4-provider-seed-1",
			nonce: "s4-volume-nonce-000001",
		});
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.paused, true);

		const event = await db
			.prepare("SELECT send_receipt_id, provider_message_id FROM delivery_events")
			.first();
		assert.equal(event.send_receipt_id, "rcpt_s4_seed_1");
		assert.equal(event.provider_message_id, "s4-provider-seed-1");

		const pause = await db
			.prepare(
				"SELECT send_paused_reason FROM mailboxes WHERE account_id = ?",
			)
			.bind("account-a")
			.first();
		assert.equal(pause.send_paused_reason, "external_volume");
	});
});
