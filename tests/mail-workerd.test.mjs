import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
	MCP_TEST_AUDIENCE,
	MCP_TEST_ISSUER,
	MCP_TEST_JWKS_URL,
	MCP_TEST_RESOURCE_URL,
	MCP_TEST_SCOPE,
} from "../dist/fixtures.mjs";

const MIGRATION = readFileSync("migrations/0001_mail.sql", "utf8")
	.split("\n")
	.filter((line) => !line.trimStart().startsWith("--"))
	.join("\n");

const MIGRATION_STATEMENTS = MIGRATION.split(";")
	.map((statement) => statement.trim())
	.filter(Boolean);

const BASE_BINDINGS = {
	MCP_RESOURCE_URL: MCP_TEST_RESOURCE_URL,
	CLOUD_AUTH_ISSUER: MCP_TEST_ISSUER,
	CLOUD_AUTH_JWKS_URL: MCP_TEST_JWKS_URL,
	MCP_AUDIENCE: MCP_TEST_AUDIENCE,
	MCP_REQUIRED_SCOPES: MCP_TEST_SCOPE,
	MAIL_DOMAIN: "tomlab.cn",
};

const simpleRaw = (messageId, subject, body) =>
	[
		"From: Alice <alice@example.com>",
		"To: alpha@tomlab.cn",
		`Subject: ${subject}`,
		`Message-ID: <${messageId}>`,
		"Date: Tue, 3 Nov 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		body,
	].join("\r\n");

const dmarcFailRaw = (messageId) =>
	[
		"Authentication-Results: mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail",
		"From: Spoof <spoof@example.com>",
		"To: alpha@tomlab.cn",
		"Subject: Suspicious",
		`Message-ID: <${messageId}>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"quarantined body",
	].join("\r\n");

const attachmentRaw = [
	"From: Carol <carol@example.com>",
	"To: alpha@tomlab.cn",
	"Subject: File",
	"Message-ID: <att-1@example.com>",
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

async function withWorker(extraBindings, run) {
	const mf = new Miniflare({
		modules: true,
		scriptPath: "dist/test-worker.mjs",
		compatibilityDate: "2026-08-06",
		cf: false,
		bindings: { ...BASE_BINDINGS, ...extraBindings },
		d1Databases: ["DB"],
		r2Buckets: ["MAIL_BUCKET"],
	});
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATION_STATEMENTS.map((statement) => db.prepare(statement)));
		await run({ mf, db });
	} finally {
		await mf.dispose();
	}
}

async function seedMailbox(db, options) {
	await db
		.prepare(
			`INSERT INTO mailboxes (
			 id, account_id, address, local_part, status, quota_bytes,
			 bytes_used, message_count, quarantine_count, created_at, updated_at
			 ) VALUES (?,?,?,?,?,?,0,0,0,?,?)`,
		)
		.bind(
			options.id,
			options.accountId,
			options.address,
			options.localPart,
			options.status ?? "active",
			options.quotaBytes ?? 1024 * 1024,
			1_795_000_000_000,
			1_795_000_000_000,
		)
		.run();
}

async function postInbound(mf, payload) {
	const response = await mf.dispatchFetch("https://127.0.0.1/__inbound", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	assert.equal(response.status, 200);
	return response.json();
}

async function connect(mf, token) {
	const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_RESOURCE_URL), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
		fetch: async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			return mf.dispatchFetch(url, init);
		},
	});
	const client = new Client(
		{ name: "who-s1-test", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(transport);
	return client;
}

const seedTwoAccounts = async (db) => {
	await seedMailbox(db, {
		id: "mbx_a",
		accountId: "account-a",
		address: "alpha@tomlab.cn",
		localPart: "alpha",
	});
	await seedMailbox(db, {
		id: "mbx_b",
		accountId: "account-b",
		address: "beta@tomlab.cn",
		localPart: "beta",
	});
};

test("inbound mail is stored once and readable through scoped MCP tools with untrusted markers", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		const inbound = await postInbound(mf, {
			to: "alpha@tomlab.cn",
			from: "alice@example.com",
			raw: simpleRaw("in-1@example.com", "Quarterly numbers", "Hello from the outside."),
		});
		assert.equal(inbound.rejected, null);

		const client = await connect(mf, "fixture-consumer-1");
		try {
			const mailbox = await client.callTool({ name: "whoyou_mailbox_get", arguments: {} });
			assert.equal(mailbox.structuredContent.address, "alpha@tomlab.cn");
			assert.equal(mailbox.structuredContent.messageCount, 1);
			assert.equal(mailbox.structuredContent.quarantineCount, 0);

			const found = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { query: "quarterly" },
			});
			assert.equal(found.structuredContent.nextCursor, null);
			assert.equal(found.structuredContent.messages.length, 1);
			assert.equal(found.structuredContent.messages[0].subject, "Quarterly numbers");
			assert.match(found.content[0].text, /UNTRUSTED_EMAIL_CONTENT/);

			const messageId = found.structuredContent.messages[0].id;
			const threadId = found.structuredContent.messages[0].threadId;
			const thread = await client.callTool({
				name: "whoyou_mail_thread_get",
				arguments: { threadId },
			});
			assert.equal(thread.structuredContent.messages.length, 1);

			const message = await client.callTool({
				name: "whoyou_mail_message_get",
				arguments: { messageId, include: "text" },
			});
			assert.equal(message.isError, undefined);
			assert.equal(message.structuredContent.untrusted, true);
			assert.match(message.structuredContent.body, /Hello from the outside\./);
			assert.equal(message.structuredContent.truncated, false);
			assert.match(message.content[0].text, /UNTRUSTED_EMAIL_CONTENT/);

			const missingBody = await client.callTool({
				name: "whoyou_mail_message_get",
				arguments: { messageId, include: "html" },
			});
			assert.equal(missingBody.isError, true);
			assert.equal(missingBody.structuredContent.error, "message_body_unavailable");
		} finally {
			await client.close();
		}

		const rows = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = 'mbx_a'")
			.first();
		assert.equal(rows.total, 1);
		const bucket = await mf.getR2Bucket("MAIL_BUCKET");
		const stored = await bucket.list({ prefix: "accounts/account-a/mailboxes/mbx_a/" });
		assert.equal(stored.objects.length, 2); // raw.eml + body.txt
	});
});

test("unknown, disabled and foreign-domain recipients are rejected and never stored", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		await seedMailbox(db, {
			id: "mbx_c",
			accountId: "account-c",
			address: "gamma@tomlab.cn",
			localPart: "gamma",
			status: "disabled",
		});

		const unknown = await postInbound(mf, {
			to: "nobody@tomlab.cn",
			raw: simpleRaw("unknown@example.com", "x", "y"),
		});
		assert.match(unknown.rejected, /^550 5\.1\.1/);

		const disabled = await postInbound(mf, {
			to: "gamma@tomlab.cn",
			raw: simpleRaw("disabled@example.com", "x", "y"),
		});
		assert.match(disabled.rejected, /^550 5\.1\.1/);

		const foreign = await postInbound(mf, {
			to: "alpha@other.cn",
			raw: simpleRaw("foreign@example.com", "x", "y"),
		});
		assert.match(foreign.rejected, /^550 5\.1\.1/);

		const rows = await db.prepare("SELECT COUNT(*) AS total FROM messages").first();
		assert.equal(rows.total, 0);
	});
});

test("duplicate Message-ID delivery is idempotent and retains a single object set", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		const raw = simpleRaw("dup@example.com", "Duplicate", "same bytes");
		const first = await postInbound(mf, { to: "alpha@tomlab.cn", raw });
		const second = await postInbound(mf, { to: "alpha@tomlab.cn", raw });
		assert.equal(first.rejected, null);
		assert.equal(second.rejected, null);
		const rows = await db.prepare("SELECT COUNT(*) AS total FROM messages").first();
		assert.equal(rows.total, 1);
		const bucket = await mf.getR2Bucket("MAIL_BUCKET");
		const objects = await bucket.list();
		assert.equal(objects.objects.length, 2);
	});
});

test("DMARC failure is quarantined: not searchable and explicitly unreadable", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		const inbound = await postInbound(mf, {
			to: "alpha@tomlab.cn",
			raw: dmarcFailRaw("spoof@example.com"),
		});
		assert.equal(inbound.rejected, null);

		const row = await db
			.prepare("SELECT id, state, quarantine_reason FROM messages WHERE mailbox_id = 'mbx_a'")
			.first();
		assert.equal(row.state, "quarantined");
		assert.equal(row.quarantine_reason, "dmarc_fail");

		const client = await connect(mf, "fixture-consumer-1");
		try {
			const mailbox = await client.callTool({ name: "whoyou_mailbox_get", arguments: {} });
			assert.equal(mailbox.structuredContent.quarantineCount, 1);
			assert.equal(mailbox.structuredContent.messageCount, 1);

			const search = await client.callTool({
				name: "whoyou_mail_search",
				arguments: {},
			});
			assert.deepEqual(search.structuredContent.messages, []);

			const message = await client.callTool({
				name: "whoyou_mail_message_get",
				arguments: { messageId: row.id, include: "text" },
			});
			assert.equal(message.isError, true);
			assert.equal(message.structuredContent.error, "message_quarantined");
		} finally {
			await client.close();
		}
	});
});

test("mail from another account is invisible and indistinguishable from absence", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		await postInbound(mf, {
			to: "alpha@tomlab.cn",
			raw: simpleRaw("private@example.com", "Private", "only for account-a"),
		});
		const row = await db.prepare("SELECT id FROM messages WHERE mailbox_id = 'mbx_a'").first();

		const client = await connect(mf, "fixture-account-b");
		try {
			const whoami = await client.callTool({ name: "whoyou_whoami", arguments: {} });
			assert.equal(whoami.structuredContent.accountId, "account-b");

			const search = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { query: "private" },
			});
			assert.deepEqual(search.structuredContent.messages, []);

			const message = await client.callTool({
				name: "whoyou_mail_message_get",
				arguments: { messageId: row.id },
			});
			assert.equal(message.isError, true);
			assert.equal(message.structuredContent.error, "message_not_found");
		} finally {
			await client.close();
		}
	});
});

test("attachments are listed and inlined only below the configured ceiling", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		await postInbound(mf, { to: "alpha@tomlab.cn", raw: attachmentRaw });
		const row = await db
			.prepare("SELECT id FROM messages WHERE mailbox_id = 'mbx_a'")
			.first();

		const client = await connect(mf, "fixture-consumer-1");
		try {
			const message = await client.callTool({
				name: "whoyou_mail_message_get",
				arguments: { messageId: row.id },
			});
			assert.equal(message.structuredContent.attachments.length, 1);
			const attachment = message.structuredContent.attachments[0];
			assert.equal(attachment.filename, "report.pdf");

			const content = await client.callTool({
				name: "whoyou_mail_attachment_get",
				arguments: { messageId: row.id, attachmentId: attachment.attachmentId },
			});
			assert.equal(content.isError, undefined);
			assert.equal(content.structuredContent.untrusted, true);
			assert.ok(content.structuredContent.contentBase64.length > 0);
			assert.match(content.content[0].text, /UNTRUSTED_EMAIL_CONTENT/);
		} finally {
			await client.close();
		}
	});
});

test("oversized mail is explicitly rejected with a size code and nothing is written", async () => {
	await withWorker({ MAIL_MAX_RAW_BYTES: "512" }, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		const big = simpleRaw("big@example.com", "Big", "x".repeat(700));
		const result = await postInbound(mf, { to: "alpha@tomlab.cn", raw: big });
		assert.match(result.rejected, /^552 5\.3\.4/);
		const rows = await db.prepare("SELECT COUNT(*) AS total FROM messages").first();
		assert.equal(rows.total, 0);
	});
});

test("mailbox quota overflow is an explicit rejection, not silent truncation", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
			quotaBytes: 0,
		});
		const result = await postInbound(mf, {
			to: "alpha@tomlab.cn",
			raw: simpleRaw("quota@example.com", "Quota", "body"),
		});
		assert.match(result.rejected, /^552 5\.2\.2/);
		const rows = await db.prepare("SELECT COUNT(*) AS total FROM messages").first();
		assert.equal(rows.total, 0);
	});
});

test("provisioning is idempotent, reserved-word safe and address-collision aware", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});

		const first = await mf.dispatchFetch("https://127.0.0.1/__provision", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ accountId: "account-d", localPart: "delta" }),
		});
		const firstBody = await first.json();
		assert.equal(firstBody.ok, true);
		assert.equal(firstBody.created, true);

		const again = await mf.dispatchFetch("https://127.0.0.1/__provision", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ accountId: "account-d", localPart: "delta" }),
		});
		const againBody = await again.json();
		assert.equal(againBody.ok, true);
		assert.equal(againBody.created, false);
		assert.equal(againBody.mailbox.id, firstBody.mailbox.id);

		const reserved = await mf.dispatchFetch("https://127.0.0.1/__provision", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ accountId: "account-e", localPart: "postmaster" }),
		});
		const reservedBody = await reserved.json();
		assert.equal(reservedBody.ok, false);
		assert.equal(reservedBody.reason, "reserved_local_part");

		const collision = await mf.dispatchFetch("https://127.0.0.1/__provision", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ accountId: "account-f", localPart: "alpha" }),
		});
		const collisionBody = await collision.json();
		assert.equal(collisionBody.ok, true);
		assert.match(collisionBody.mailbox.address, /^alpha-[a-f0-9]{4}@tomlab\.cn$/);
	});
});
