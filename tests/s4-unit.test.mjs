import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_ABUSE_POLICY,
	computeWebhookSignature,
	evaluateAbuse,
	normalizeRecipient,
	parseDeliveryReport,
	resolveAbusePolicy,
	verifyWebhookSignature,
} from "../dist/unit.mjs";
import {
	complaintReport,
	deliveredReport,
	hardBounceReport,
	malformedReport,
	notAReport,
	softBounceReport,
} from "./s4-fixtures.mjs";

const SECRET = "s4-test-webhook-secret-0123456789abcdef";

test("DSN reader classifies hard and soft bounces without leaking free text", () => {
	const hard = parseDeliveryReport(hardBounceReport("alice@example.com"));
	assert.equal(hard.ok, true);
	assert.equal(hard.report.reportType, "dsn");
	assert.equal(hard.report.events.length, 1);
	assert.equal(hard.report.events[0].type, "hard_bounce");
	assert.deepEqual(hard.report.events[0].recipients, ["alice@example.com"]);
	assert.equal(hard.report.events[0].status, "5.1.1");
	assert.equal(hard.report.events[0].diagnosticCode, "550 5.1.1");
	assert.equal(hard.report.events[0].originalMessageId, "synthetic-original@tomlab.cn");

	const soft = parseDeliveryReport(softBounceReport("slow@example.com"));
	assert.equal(soft.ok, true);
	assert.equal(soft.report.events[0].type, "soft_bounce");

	const delivered = parseDeliveryReport(deliveredReport("ok@example.com"));
	assert.equal(delivered.ok, true);
	assert.equal(delivered.report.events[0].type, "delivered");
});

test("ARF reader emits a complaint for a normal feedback report", () => {
	const parsed = parseDeliveryReport(complaintReport("complainant@example.com"));
	assert.equal(parsed.ok, true);
	assert.equal(parsed.report.reportType, "arf");
	assert.deepEqual(parsed.report.events, [
		{
			type: "complaint",
			recipients: ["complainant@example.com"],
			status: null,
			diagnosticCode: null,
			originalMessageId: "synthetic-complaint@tomlab.cn",
		},
	]);
});

test("reports that cannot be parsed are rejected instead of guessed", () => {
	assert.deepEqual(parseDeliveryReport(notAReport()), {
		ok: false,
		reason: "not_a_report",
	});
	assert.deepEqual(parseDeliveryReport(malformedReport()), {
		ok: false,
		reason: "report_malformed",
	});
});

test("recipient normalization rejects anything that is not one bare address", () => {
	assert.equal(normalizeRecipient("rfc822; Alice@Example.com"), "alice@example.com");
	assert.equal(normalizeRecipient("<alice@example.com>"), "alice@example.com");
	assert.equal(normalizeRecipient("  ALICE@EXAMPLE.COM  "), "alice@example.com");
	assert.equal(normalizeRecipient("alice@example.com, bob@example.com"), null);
	assert.equal(normalizeRecipient("not-an-address"), null);
	assert.equal(normalizeRecipient("a b@example.com"), null);
	assert.equal(normalizeRecipient(null), null);
});

test("abuse thresholds pause on complaint count, bounce rate or external volume", () => {
	const policy = DEFAULT_ABUSE_POLICY;
	assert.deepEqual(
		evaluateAbuse(
			{ sends: 10, hardBounces: 0, complaints: 2, externalRecipients: 10 },
			policy,
		),
		{ pause: true, kind: "complaint_rate", detail: "complaints=2;sends=10" },
	);
	assert.equal(
		evaluateAbuse(
			{ sends: 20, hardBounces: 3, complaints: 0, externalRecipients: 20 },
			policy,
		).kind,
		"hard_bounce_rate",
	);
	assert.equal(
		evaluateAbuse(
			{ sends: 100, hardBounces: 3, complaints: 0, externalRecipients: 100 },
			policy,
		).pause,
		false,
	);
	assert.equal(
		evaluateAbuse(
			{ sends: 1, hardBounces: 0, complaints: 0, externalRecipients: 200 },
			policy,
		).kind,
		"external_volume",
	);
	assert.deepEqual(
		evaluateAbuse({ sends: 5, hardBounces: 0, complaints: 0, externalRecipients: 5 }, policy),
		{ pause: false, kind: null, detail: "" },
	);
});

test("abuse policy honors valid bindings and ignores malformed ones", () => {
	const policy = resolveAbusePolicy({
		MAIL_ABUSE_WINDOW_MINUTES: "30",
		MAIL_ABUSE_HARD_BOUNCE_COUNT: "4",
		MAIL_ABUSE_HARD_BOUNCE_RATIO_PERCENT: "10",
		MAIL_ABUSE_COMPLAINT_COUNT: "1",
		MAIL_ABUSE_EXTERNAL_RECIPIENT_COUNT: "50",
	});
	assert.equal(policy.windowMs, 30 * 60 * 1000);
	assert.equal(policy.hardBounceCount, 4);
	assert.equal(policy.hardBounceRatio, 0.1);
	assert.equal(policy.complaintCount, 1);
	assert.equal(policy.externalRecipientCount, 50);

	const fallback = resolveAbusePolicy({
		MAIL_ABUSE_HARD_BOUNCE_RATIO_PERCENT: "0",
		MAIL_ABUSE_WINDOW_MINUTES: "-5",
	});
	assert.equal(fallback.hardBounceRatio, DEFAULT_ABUSE_POLICY.hardBounceRatio);
	assert.equal(fallback.windowMs, DEFAULT_ABUSE_POLICY.windowMs);
});

test("webhook signatures are deterministic and tamper-evident", async () => {
	const timestamp = "1795000000000";
	const nonce = "nonce-signature-test-01";
	const body = '{"report":"synthetic"}';

	const signature = await computeWebhookSignature(SECRET, timestamp, nonce, body);
	assert.match(signature, /^[a-f0-9]{64}$/);
	assert.equal(
		await verifyWebhookSignature(SECRET, timestamp, nonce, body, signature),
		true,
	);
	assert.equal(
		await verifyWebhookSignature(SECRET, timestamp, nonce, `${body} `, signature),
		false,
	);
	assert.equal(
		await verifyWebhookSignature(
			"another-secret-0123456789abcdef",
			timestamp,
			nonce,
			body,
			signature,
		),
		false,
	);
	assert.equal(
		await verifyWebhookSignature(SECRET, timestamp, nonce, body, "not-hex"),
		false,
	);
});
