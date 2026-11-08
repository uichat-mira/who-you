import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_RETENTION,
	SIGNED_DOWNLOAD_TTL_MS,
	ZipArchive,
	buildDownloadUrl,
	createDownloadSigner,
	normalizeSearchQuery,
	resolveRetention,
	runRetentionSweep,
} from "../dist/unit.mjs";

test("search normalization shares one case-fold and whitespace rule", () => {
	assert.equal(normalizeSearchQuery("  Quarterly   NUMBERS "), "quarterly numbers");
	assert.equal(normalizeSearchQuery("Cafe\u0301"), "café".normalize("NFC"));
	assert.equal(normalizeSearchQuery("x".repeat(400)).length, 200);
});

test("signed download links are tamper-evident and carry no storage key", async () => {
	const signer = createDownloadSigner("k".repeat(40));
	assert.ok(signer);
	const target = {
		kind: "attachment",
		accountId: "account-a",
		id: "att-1",
		messageId: "msg-1",
		expiresAt: 1_795_000_000_000 + SIGNED_DOWNLOAD_TTL_MS,
	};
	const signature = await signer.sign(target);
	assert.equal(await signer.verify(target, signature), true);
	assert.equal(await signer.verify({ ...target, accountId: "account-b" }, signature), false);
	assert.equal(await signer.verify({ ...target, id: "att-2" }, signature), false);
	assert.equal(await signer.verify(target, `${signature}x`), false);

	const url = buildDownloadUrl(new URL("https://who.example.com/mcp"), target, signature);
	const parsed = new URL(url);
	assert.equal(parsed.origin, "https://who.example.com");
	assert.equal(parsed.pathname, "/mail/download");
	assert.equal(parsed.searchParams.get("exp"), String(target.expiresAt));
	assert.match(url, /sig=/);
	assert.doesNotMatch(url, /accounts%2F|accounts\/|raw\.eml|exports/);
});

test("a missing or short signing key closes signed downloads", () => {
	assert.equal(createDownloadSigner(null), null);
	assert.equal(createDownloadSigner(""), null);
	assert.equal(createDownloadSigner("short-key"), null);
	assert.ok(createDownloadSigner("k".repeat(32)));
});

test("zip archives are deterministic, store-only PKWARE archives", () => {
	const build = () => {
		const archive = new ZipArchive();
		archive.add("messages/msg-1.eml", new TextEncoder().encode("Subject: hi\r\n\r\nbody"));
		archive.add("manifest.json", new TextEncoder().encode('{"schema":"who-you-export/1"}'));
		archive.addParentDirectories();
		return archive.build();
	};
	const bytes = build();
	const again = build();
	assert.deepEqual([...bytes], [...again]);
	assert.equal(le32(bytes, 0), 0x04034b50);
	// End of central directory signature sits at the tail of a comment-free zip.
	assert.equal(le32(bytes, bytes.length - 22), 0x06054b50);
	assert.equal(le16(bytes, bytes.length - 14), 3);
	const text = new TextDecoder().decode(bytes);
	assert.match(text, /messages\/msg-1\.eml/);
	assert.match(text, /manifest\.json/);
});

test("retention resolves documented defaults and never disables itself", () => {
	assert.deepEqual(resolveRetention({}), DEFAULT_RETENTION);
	assert.deepEqual(resolveRetention({ MAIL_RETENTION_AUDIT_DAYS: "200" }).auditDays, 200);
	assert.equal(resolveRetention({ MAIL_RETENTION_AUDIT_DAYS: "nope" }).auditDays, 180);
	assert.equal(resolveRetention({ MAIL_RETENTION_AUDIT_DAYS: "0" }).auditDays, 180);
	assert.equal(resolveRetention({}).bounceDays, 90);
});

test("retention sweep delegates one cutoff to the repository", async () => {
	const seen = [];
	const repository = {
		async deleteAuditBefore(cutoff) {
			seen.push(cutoff);
			return 4;
		},
	};
	const now = 1_795_000_000_000;
	const result = await runRetentionSweep(repository, DEFAULT_RETENTION, now);
	assert.equal(result.deletedAuditEntries, 4);
	assert.equal(seen[0], now - 180 * 24 * 60 * 60 * 1000);
});

function le16(bytes, offset) {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function le32(bytes, offset) {
	return (
		(bytes[offset] |
			(bytes[offset + 1] << 8) |
			(bytes[offset + 2] << 16) |
			(bytes[offset + 3] << 24)) >>>
		0
	);
}
