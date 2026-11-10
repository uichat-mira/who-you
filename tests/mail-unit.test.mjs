import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_MAIL_LIMITS,
	MailParseError,
	mailObjectKeys,
	normalizeDomain,
	normalizeLocalPart,
	parseAuthVerdict,
	parseInboundMail,
	resolveMailLimits,
	resolveRecipient,
	sanitizeFilename,
	sanitizeHtml,
} from "../dist/unit.mjs";

const simpleMessage = [
	"From: Alice <alice@example.com>",
	"To: alpha@tomlab.cn",
	"Subject: Hello",
	"Message-ID: <m1@example.com>",
	"Date: Tue, 3 Nov 2026 10:00:00 +0000",
	"MIME-Version: 1.0",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Hello body",
].join("\r\n");

const htmlMessage = [
	"From: Bob <bob@example.com>",
	"To: alpha@tomlab.cn",
	"Subject: Html",
	"Message-ID: <m2@example.com>",
	"MIME-Version: 1.0",
	"Content-Type: text/html; charset=utf-8",
	"",
	'<p>Hi<script>bad()</script><a href="https://ok.example">ok</a></p>',
].join("\r\n");

const attachmentMessage = [
	"From: Carol <carol@example.com>",
	"To: alpha@tomlab.cn",
	"Subject: File",
	"Message-ID: <m3@example.com>",
	"MIME-Version: 1.0",
	'Content-Type: multipart/mixed; boundary="b1"',
	"",
	"--b1",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"see attached",
	"--b1",
	'Content-Type: application/pdf; name="report.pdf"',
	'Content-Disposition: attachment; filename="../../report.pdf"',
	"Content-Transfer-Encoding: base64",
	"",
	"JVBERi0xLjQ=",
	"--b1--",
	"",
].join("\r\n");

const nestedMessage = (depth) => {
	let body = "Content-Type: text/plain\r\n\r\nhello\r\n";
	for (let level = depth - 1; level >= 0; level -= 1) {
		body =
			`Content-Type: multipart/mixed; boundary="b${level}"\r\n\r\n` +
			`--b${level}\r\n${body}\r\n--b${level}--\r\n`;
	}
	return [
		"From: Dave <dave@example.com>",
		"To: alpha@tomlab.cn",
		"Subject: Nested",
		"Message-ID: <m4@example.com>",
		body,
	].join("\r\n");
};

test("address rules accept the canonical grammar and reject reserved or hostile forms", () => {
	// Normalization is lowercase and trimmed, not silently sanitized.
	assert.deepEqual(normalizeLocalPart("  Alpha_1  "), { ok: true, localPart: "alpha_1" });
	assert.equal(normalizeLocalPart("ab").ok, false);
	assert.equal(normalizeLocalPart("-alpha").ok, false);
	assert.equal(normalizeLocalPart("alpha..beta").ok, false);
	assert.equal(normalizeLocalPart("alpha+tag").ok, false);
	assert.equal(normalizeLocalPart("postmaster").ok, false);
	assert.equal(normalizeLocalPart("MIRA").ok, false);
	assert.equal(normalizeLocalPart("a".repeat(40)).ok, false);

	assert.equal(normalizeDomain(" TomLab.CN "), "tomlab.cn");
	assert.equal(normalizeDomain("tomlab"), null);

	const ok = resolveRecipient("Alpha@TomLab.CN", "tomlab.cn");
	assert.deepEqual(ok, { ok: true, localPart: "alpha", address: "alpha@tomlab.cn" });
	assert.equal(resolveRecipient("alpha@other.cn", "tomlab.cn").ok, false);
	assert.equal(resolveRecipient("alpha@tomlab.cn.evil", "tomlab.cn").ok, false);
	assert.equal(resolveRecipient("alpha+tag@tomlab.cn", "tomlab.cn").ok, false);
	assert.equal(resolveRecipient("no-at-sign", "tomlab.cn").ok, false);
});

test("mail limits fall back to safe defaults for invalid bindings", () => {
	assert.deepEqual(resolveMailLimits({}), DEFAULT_MAIL_LIMITS);
	const custom = resolveMailLimits({
		MAIL_MAX_RAW_BYTES: "2048",
		MAIL_MAILBOX_QUOTA_BYTES: "4096",
		MAIL_MAX_PART_COUNT: "0",
	});
	assert.equal(custom.maxRawBytes, 2048);
	assert.equal(custom.mailboxQuotaBytes, 4096);
	assert.equal(custom.maxPartCount, DEFAULT_MAIL_LIMITS.maxPartCount);
});

test("Authentication-Results parsing records dmarc fail but never invents a pass", () => {
	const fail = parseAuthVerdict([
		{
			key: "authentication-results",
			value: "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=fail",
		},
	]);
	assert.equal(fail.dmarc, "fail");
	assert.equal(fail.summary, "spf=pass;dkim=pass;dmarc=fail");

	const absent = parseAuthVerdict([]);
	assert.equal(absent.dmarc, "unknown");
	assert.equal(absent.summary, "spf=none;dkim=none;dmarc=unknown");

	const uppercase = parseAuthVerdict([
		{ key: "Authentication-Results", value: "MX.CLOUDFLARE.NET; DMARC=PASS; SPF=SOFTFAIL" },
	]);
	assert.equal(uppercase.dmarc, "pass");
	assert.equal(uppercase.spf, "softfail");

	// Auth results not stamped by the Cloudflare receiving hop are hostile.
	const foreign = parseAuthVerdict([
		{ key: "Authentication-Results", value: "attacker.test; dmarc=pass" },
	]);
	assert.equal(foreign.dmarc, "unknown");
	const forgedLater = parseAuthVerdict([
		{ key: "Authentication-Results", value: "mx.cloudflare.net; dmarc=fail, mx.cloudflare.net; dmarc=pass" },
	]);
	assert.equal(forgedLater.dmarc, "fail");
});

test("HTML sanitizer drops executable surface and keeps inert structure", () => {
	const sanitized = sanitizeHtml(
		'<p onclick="steal()">hi</p><script>alert(1)</script>' +
			'<style>body{background:url(https://track)}</style>' +
			'<a href="javascript:alert(1)">bad</a>' +
			'<a href="https://ok.example" onclick="x">good</a>' +
			'<iframe src="https://evil"></iframe><img src="https://track">' +
			'<form action="https://evil"><input name="q"></form>',
	);
	assert.equal(sanitized.includes("<script"), false);
	assert.equal(sanitized.includes("alert(1)"), false);
	assert.equal(sanitized.includes("body{background"), false);
	assert.equal(sanitized.includes("javascript:"), false);
	assert.equal(sanitized.includes("onclick"), false);
	assert.equal(sanitized.includes("<iframe"), false);
	assert.equal(sanitized.includes("<img"), false);
	assert.equal(sanitized.includes("<form"), false);
	assert.equal(sanitized.includes("<input"), false);
	assert.match(sanitized, /<a href="https:\/\/ok\.example"/);
	assert.match(sanitized, /rel="noopener noreferrer nofollow"/);
});

test("attachment names never keep path components or control characters", () => {
	assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
	assert.equal(sanitizeFilename("C:\\temp\\evil.exe"), "evil.exe");
	assert.equal(sanitizeFilename(null), "attachment");
	assert.equal(sanitizeFilename("   "), "attachment");
});

test("MIME parsing extracts metadata, body and sanitized HTML", async () => {
	const plain = await parseInboundMail(new TextEncoder().encode(simpleMessage), DEFAULT_MAIL_LIMITS);
	assert.equal(plain.internetMessageId, "<m1@example.com>");
	assert.equal(plain.subject, "Hello");
	assert.match(plain.text ?? "", /Hello body/);
	assert.deepEqual(plain.from, [{ name: "Alice", address: "alice@example.com" }]);
	assert.equal(plain.auth.dmarc, "unknown");

	const html = await parseInboundMail(new TextEncoder().encode(htmlMessage), DEFAULT_MAIL_LIMITS);
	assert.equal(html.html?.includes("<script"), false);
	assert.match(html.html ?? "", /<a href="https:\/\/ok\.example"/);

	const withAttachment = await parseInboundMail(
		new TextEncoder().encode(attachmentMessage),
		DEFAULT_MAIL_LIMITS,
	);
	assert.equal(withAttachment.attachments.length, 1);
	assert.equal(withAttachment.attachments[0].filename, "report.pdf");
	assert.ok(withAttachment.attachments[0].content.byteLength > 0);
});

test("structural limits fail as explicit limit errors, not silent truncation", async () => {
	await assert.rejects(
		parseInboundMail(new TextEncoder().encode(nestedMessage(20)), {
			...DEFAULT_MAIL_LIMITS,
			maxNestingDepth: 2,
		}),
		(error) => error instanceof MailParseError && error.failure.kind === "limit",
	);
	await assert.rejects(
		parseInboundMail(new TextEncoder().encode(simpleMessage), {
			...DEFAULT_MAIL_LIMITS,
			maxHeaderBytes: 120,
		}),
		(error) => error instanceof MailParseError && error.failure.kind === "limit",
	);
});

test("folded headers and RFC 2047 words decode to text instead of raw bytes", async () => {
	const raw = [
		"From: =?utf-8?B?QWxpY2U=?= <alice@example.com>",
		"To: alpha@tomlab.cn",
		"Subject: =?utf-8?B?5L2g5aW9?=",
		"\t=?utf-8?Q?folded?=",
		"Message-ID: <m5@example.com>",
		"MIME-Version: 1.0",
		'Content-Type: multipart/alternative; boundary="alt"',
		"",
		"--alt",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"plain part",
		"--alt",
		"Content-Type: text/html; charset=utf-8",
		"",
		"<p>html part</p>",
		"--alt--",
		"",
	].join("\r\n");
	const parsed = await parseInboundMail(new TextEncoder().encode(raw), DEFAULT_MAIL_LIMITS);
	assert.equal(parsed.subject, "你好folded");
	assert.deepEqual(parsed.from, [{ name: "Alice", address: "alice@example.com" }]);
	assert.match(parsed.text ?? "", /plain part/);
	assert.match(parsed.html ?? "", /html part/);
});

test("object keys are scoped and escape account ids", () => {
	const key = mailObjectKeys.raw("acct/a b", "mbx_1", "msg_1");
	assert.equal(key, "accounts/acct%2Fa%20b/mailboxes/mbx_1/messages/msg_1/raw.eml");
});
