import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_TEST_RESOURCE_URL } from "../dist/fixtures.mjs";
import { buildDownloadUrl, createDownloadSigner, SIGNED_DOWNLOAD_TTL_MS } from "../dist/unit.mjs";
import { DAY_MS, NOW, connect, seedTwoAccounts, withWorker } from "./node-harness.mjs";

const SIGNING_KEY = "s3-test-signing-key-0123456789abcdef";

const rawKey = (accountId, mailboxId, messageId) =>
	`accounts/${accountId}/mailboxes/${mailboxId}/messages/${messageId}/raw.eml`;

async function seedMessage(db, options) {
	const threadId = options.threadId ?? `thr_${options.id}`;
	const state = options.state ?? "visible";
	const sizeBytes = options.sizeBytes ?? 100;
	await db
		.prepare(
			`INSERT INTO threads (id, mailbox_id, thread_key, root_message_id, last_message_at, message_count)
			 VALUES (?,?,?,NULL,?,1)`,
		)
		.bind(threadId, options.mailboxId ?? "mbx_a", threadId, options.receivedAt ?? NOW)
		.run();
	await db
		.prepare(
			`INSERT INTO messages (
			 id, mailbox_id, thread_id, direction, internet_message_id, envelope_from, envelope_to,
			 from_json, to_json, cc_json, subject, from_text, search_text, sent_at, received_at,
			 size_bytes, snippet, attachment_count, auth_results, dmarc, state, quarantine_reason,
			 raw_key, text_key, html_key
			 ) VALUES (?,?,?, 'inbound', ?, ?, ?, '[{"name":"Alice","address":"alice@example.com"}]',
			 '[{"name":"","address":"alpha@tomlab.cn"}]', '[]', ?, ?, ?, NULL, ?, ?, ?, ?, 'spf=pass',
			 'pass', ?, NULL, ?, NULL, NULL)`,
		)
		.bind(
			options.id,
			options.mailboxId ?? "mbx_a",
			threadId,
			`${options.id}@example.com`,
			"alice@example.com",
			"alpha@tomlab.cn",
			options.subject ?? "Hello",
			(options.subject ?? "Hello").toLowerCase(),
			`${(options.subject ?? "Hello").toLowerCase()} body`,
			options.receivedAt ?? NOW,
			sizeBytes,
			options.snippet ?? "snippet",
			options.attachmentCount ?? 0,
			state,
			rawKey(options.accountId ?? "account-a", options.mailboxId ?? "mbx_a", options.id),
		)
		.run();
	await db
		.prepare(
			`UPDATE mailboxes SET message_count = message_count + 1, bytes_used = bytes_used + ?,
			 quarantine_count = quarantine_count + ? WHERE id = ?`,
		)
		.bind(sizeBytes, state === "quarantined" ? 1 : 0, options.mailboxId ?? "mbx_a")
		.run();
}

async function seedAttachment(db, options) {
	await db
		.prepare(
			`INSERT INTO attachments (
			 id, message_id, mailbox_id, part_path, filename, mime_type, size_bytes,
			 disposition, content_id, r2_key
			 ) VALUES (?,?,?,?,?,?,?, 'attachment', NULL, ?)`,
		)
		.bind(
			options.id,
			options.messageId,
			options.mailboxId ?? "mbx_a",
			"2",
			options.filename ?? "report.pdf",
			options.mimeType ?? "application/pdf",
			options.sizeBytes ?? 8,
			`accounts/account-a/mailboxes/${options.mailboxId ?? "mbx_a"}/messages/${options.messageId}/attachments/${options.id}`,
		)
		.run();
}

test("flag writes are idempotent, versioned and conflict-safe", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedTwoAccounts(db);
		await seedMessage(db, { id: "msg_1", accountId: "account-a" });
		await seedMessage(db, {
			id: "msg_q",
			accountId: "account-a",
			state: "quarantined",
		});

		const reader = await connect(mf, "fixture-consumer-1");
		try {
			const denied = await reader.callTool({
				name: "whoyou_mail_flag_set",
				arguments: { messageId: "msg_1", read: true },
			});
			assert.equal(denied.isError, true);
			assert.equal(denied.structuredContent.error, "insufficient_scope");
		} finally {
			await reader.close();
		}

		await seedMessage(db, { id: "msg_2", accountId: "account-a", threadId: "thr_x" });

		const client = await connect(mf, "fixture-mail-writer");
		try {
			const first = await client.callTool({
				name: "whoyou_mail_flag_set",
				arguments: { messageId: "msg_1", read: true },
			});
			assert.equal(first.isError, undefined);
			assert.equal(first.structuredContent.changed, true);
			assert.equal(first.structuredContent.flagVersion, 1);

			const replay = await client.callTool({
				name: "whoyou_mail_flag_set",
				arguments: { messageId: "msg_1", read: true },
			});
			assert.equal(replay.structuredContent.changed, false);
			assert.equal(replay.structuredContent.flagVersion, 1);

			const stale = await client.callTool({
				name: "whoyou_mail_flag_set",
				arguments: { messageId: "msg_1", starred: true, expectedVersion: 0 },
			});
			assert.equal(stale.isError, true);
			assert.equal(stale.structuredContent.error, "flag_version_conflict");

			const [left, right] = await Promise.all([
				client.callTool({
					name: "whoyou_mail_flag_set",
					arguments: { messageId: "msg_1", starred: true, expectedVersion: 1 },
				}),
				client.callTool({
					name: "whoyou_mail_flag_set",
					arguments: { messageId: "msg_1", starred: true, expectedVersion: 1 },
				}),
			]);
			assert.equal(left.isError, undefined);
			assert.equal(right.isError, undefined);
			assert.equal(left.structuredContent.flagVersion, 2);
			assert.equal(right.structuredContent.flagVersion, 2);
			assert.equal(left.structuredContent.flags.starred, true);

			const quarantined = await client.callTool({
				name: "whoyou_mail_flag_set",
				arguments: { messageId: "msg_q", read: true },
				});
			assert.equal(quarantined.isError, true);
			assert.equal(quarantined.structuredContent.error, "message_quarantined");

			const missing = await client.callTool({
				name: "whoyou_mail_flag_set",
				arguments: { messageId: "msg_missing", read: true },
			});
			assert.equal(missing.isError, true);
			assert.equal(missing.structuredContent.error, "message_not_found");

			await client.callTool({
				name: "whoyou_mail_flag_set",
				arguments: { messageId: "msg_1", trashed: true },
			});

			const inbox = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { folder: "inbox" },
			});
			assert.deepEqual(
				inbox.structuredContent.messages.map((message) => message.id),
				["msg_2"],
			);
			const trash = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { folder: "trash" },
			});
			assert.deepEqual(
				trash.structuredContent.messages.map((message) => message.id),
				["msg_1"],
			);
			const unread = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { unreadOnly: true },
			});
			assert.deepEqual(
				unread.structuredContent.messages.map((message) => message.id),
				["msg_2"],
			);
		} finally {
			await client.close();
		}
	});
});

test("signed attachment links are short-lived, account-bound and explicit on failure", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedTwoAccounts(db);
		await seedMessage(db, { id: "msg_att", accountId: "account-a", attachmentCount: 1 });
		await seedAttachment(db, { id: "att_1", messageId: "msg_att" });
		await seedMessage(db, {
			id: "msg_q",
			accountId: "account-a",
			state: "quarantined",
			attachmentCount: 1,
		});
		await seedAttachment(db, { id: "att_q", messageId: "msg_q" });

		const bucket = await mf.getR2Bucket("MAIL_BUCKET");
		await bucket.put(
			"accounts/account-a/mailboxes/mbx_a/messages/msg_att/attachments/att_1",
			new TextEncoder().encode("PDF-DATA"),
		);
		await bucket.put(
			"accounts/account-a/mailboxes/mbx_a/messages/msg_q/attachments/att_q",
			new TextEncoder().encode("QUARANTINED"),
		);

		const client = await connect(mf, "fixture-consumer-1");
		let downloadUrl;
		try {
			const link = await client.callTool({
				name: "whoyou_mail_attachment_get",
				arguments: { messageId: "msg_att", attachmentId: "att_1", mode: "download" },
			});
			assert.equal(link.isError, undefined);
			downloadUrl = link.structuredContent.downloadUrl;
			assert.ok(downloadUrl.startsWith(`${MCP_TEST_RESOURCE_URL.replace("/mcp", "")}/mail/download?`));
			assert.equal(
				link.structuredContent.expiresAt - Date.now() <= SIGNED_DOWNLOAD_TTL_MS + 5000,
				true,
			);
		} finally {
			await client.close();
		}

		const authorized = await mf.dispatchFetch(downloadUrl, {
			headers: { authorization: "Bearer fixture-consumer-1" },
		});
		assert.equal(authorized.status, 200);
		assert.equal(authorized.headers.get("cache-control"), "private, no-store");
		assert.equal(await authorized.text(), "PDF-DATA");

		const anonymous = await mf.dispatchFetch(downloadUrl);
		assert.equal(anonymous.status, 401);

		const tampered = await mf.dispatchFetch(`${downloadUrl}x`, {
			headers: { authorization: "Bearer fixture-consumer-1" },
		});
		assert.equal(tampered.status, 403);

		const foreign = await mf.dispatchFetch(downloadUrl, {
			headers: { authorization: "Bearer fixture-account-b" },
		});
		assert.equal(foreign.status, 403);
		assert.equal((await foreign.json()).error, "invalid_signature");

		const signer = createDownloadSigner(SIGNING_KEY);
		const foreignTarget = {
			kind: "attachment",
			accountId: "account-b",
			id: "att_1",
			messageId: "msg_att",
			expiresAt: Date.now() + 60_000,
		};
		const foreignUrl = buildDownloadUrl(
			new URL(MCP_TEST_RESOURCE_URL),
			foreignTarget,
			await signer.sign(foreignTarget),
		);
		const notOwned = await mf.dispatchFetch(foreignUrl, {
			headers: { authorization: "Bearer fixture-account-b" },
		});
		assert.equal(notOwned.status, 404);
		assert.equal((await notOwned.json()).error, "attachment_not_found");
		const quarantinedTarget = {
			kind: "attachment",
			accountId: "account-a",
			id: "att_q",
			messageId: "msg_q",
			expiresAt: Date.now() + 60_000,
		};
		const quarantinedUrl = buildDownloadUrl(
			new URL(MCP_TEST_RESOURCE_URL),
			quarantinedTarget,
			await signer.sign(quarantinedTarget),
		);
		const quarantined = await mf.dispatchFetch(quarantinedUrl, {
			headers: { authorization: "Bearer fixture-consumer-1" },
		});
		assert.equal(quarantined.status, 409);
		assert.equal((await quarantined.json()).error, "message_quarantined");
	});
});

test("export is daily-limited, audited and scoped to the caller's own mail", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedTwoAccounts(db);
		await seedMessage(db, { id: "msg_a1", accountId: "account-a", subject: "Own data" });
		await seedMessage(db, {
			id: "msg_b1",
			accountId: "account-b",
			mailboxId: "mbx_b",
			subject: "Other account",
		});
		const bucket = await mf.getR2Bucket("MAIL_BUCKET");
		await bucket.put(rawKey("account-a", "mbx_a", "msg_a1"), new TextEncoder().encode("Subject: Own data\r\n\r\nbody"));
		await bucket.put(rawKey("account-b", "mbx_b", "msg_b1"), new TextEncoder().encode("Subject: Other account\r\n\r\nsecret"));

		const client = await connect(mf, "fixture-mail-writer");
		try {
			const first = await client.callTool({ name: "whoyou_mail_export", arguments: {} });
			assert.equal(first.isError, undefined);
			assert.equal(first.structuredContent.messageCount, 1);
			assert.equal(first.structuredContent.exportDay, new Date().toISOString().slice(0, 10));

			const downloaded = await mf.dispatchFetch(first.structuredContent.downloadUrl, {
				headers: { authorization: "Bearer fixture-mail-writer" },
			});
			assert.equal(downloaded.status, 200);
			assert.match(downloaded.headers.get("content-disposition"), /\.zip/);
			const archive = new TextDecoder().decode(await downloaded.arrayBuffer());
			assert.match(archive, /manifest\.json/);
			assert.match(archive, /msg_a1\.eml/);
			assert.match(archive, /Own data/);
			assert.doesNotMatch(archive, /msg_b1|Other account|secret/);

			const second = await client.callTool({ name: "whoyou_mail_export", arguments: {} });
			assert.equal(second.isError, true);
			assert.equal(second.structuredContent.error, "export_rate_limited");

			const audit = await db
				.prepare("SELECT action, target_id FROM mail_audit_log WHERE account_id = 'account-a'")
				.all();
			assert.equal(audit.results.length, 1);
			assert.equal(audit.results[0].action, "export");
			assert.equal(audit.results[0].target_id, first.structuredContent.exportId);
		} finally {
			await client.close();
		}
	});
});

test("permanent delete requires trash, removes objects before rows and is retry-safe", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedTwoAccounts(db);
		await seedMessage(db, { id: "msg_del", accountId: "account-a", sizeBytes: 42 });
		await seedAttachment(db, { id: "att_del", messageId: "msg_del" });
		const bucket = await mf.getR2Bucket("MAIL_BUCKET");
		await bucket.put(rawKey("account-a", "mbx_a", "msg_del"), new TextEncoder().encode("raw"));
		await bucket.put(
			"accounts/account-a/mailboxes/mbx_a/messages/msg_del/attachments/att_del",
			new TextEncoder().encode("att"),
		);

		const client = await connect(mf, "fixture-mail-writer");
		try {
			const refused = await client.callTool({
				name: "whoyou_mail_message_delete",
				arguments: { messageId: "msg_del" },
			});
			assert.equal(refused.isError, true);
			assert.equal(refused.structuredContent.error, "message_not_trashed");

			await client.callTool({
				name: "whoyou_mail_flag_set",
				arguments: { messageId: "msg_del", trashed: true },
			});
			const deleted = await client.callTool({
				name: "whoyou_mail_message_delete",
				arguments: { messageId: "msg_del" },
			});
			assert.equal(deleted.isError, undefined);
			assert.equal(deleted.structuredContent.deletedObjects, 2);
			assert.equal(deleted.structuredContent.deletedRows, 1);
			assert.equal(deleted.structuredContent.alreadyDeleted, false);

			const retried = await client.callTool({
				name: "whoyou_mail_message_delete",
				arguments: { messageId: "msg_del" },
			});
			assert.equal(retried.isError, undefined);
			assert.equal(retried.structuredContent.alreadyDeleted, true);

			const rows = await db
				.prepare("SELECT COUNT(*) AS total FROM messages WHERE id = 'msg_del'")
				.first();
			assert.equal(rows.total, 0);
			assert.equal((await bucket.list({ prefix: "accounts/account-a/mailboxes/mbx_a/messages/msg_del/" })).objects.length, 0);
			const mailbox = await db
				.prepare("SELECT bytes_used, message_count FROM mailboxes WHERE id = 'mbx_a'")
				.first();
			assert.equal(mailbox.bytes_used, 0);
			assert.equal(mailbox.message_count, 0);
		} finally {
			await client.close();
		}
	});
});

test("mailbox erasure requires confirmation, empties storage and stays idempotent", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedTwoAccounts(db);
		await seedMessage(db, { id: "msg_gone", accountId: "account-a" });
		await seedMessage(db, {
			id: "msg_keep",
			accountId: "account-b",
			mailboxId: "mbx_b",
		});
		const bucket = await mf.getR2Bucket("MAIL_BUCKET");
		await bucket.put(rawKey("account-a", "mbx_a", "msg_gone"), new TextEncoder().encode("raw"));
		await bucket.put(rawKey("account-b", "mbx_b", "msg_keep"), new TextEncoder().encode("raw"));

		const client = await connect(mf, "fixture-mail-writer");
		try {
			const unconfirmed = await client.callTool({
				name: "whoyou_mail_mailbox_delete",
				arguments: { confirm: false },
			});
			assert.equal(unconfirmed.structuredContent.error, "confirmation_required");

			const erased = await client.callTool({
				name: "whoyou_mail_mailbox_delete",
				arguments: { confirm: true },
			});
			assert.equal(erased.isError, undefined);
			assert.equal(erased.structuredContent.deletedObjects, 1);

			const again = await client.callTool({
				name: "whoyou_mail_mailbox_delete",
				arguments: { confirm: true },
			});
			assert.equal(again.structuredContent.alreadyDeleted, true);
		} finally {
			await client.close();
		}

		const owned = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = 'mbx_a'")
			.first();
		assert.equal(owned.total, 0);
		const mailbox = await db
			.prepare("SELECT COUNT(*) AS total FROM mailboxes WHERE id = 'mbx_a'")
			.first();
		assert.equal(mailbox.total, 0);
		assert.equal((await bucket.list({ prefix: "accounts/account-a/" })).objects.length, 0);
		assert.equal((await bucket.list({ prefix: "accounts/account-b/" })).objects.length, 1);
	});
});

test("cursor paging over repeated timestamps never duplicates or skips", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedTwoAccounts(db);
		for (let index = 0; index < 60; index += 1) {
			await seedMessage(db, {
				id: `msg_p${String(index).padStart(3, "0")}`,
				accountId: "account-a",
				// Six messages share each timestamp to force tie-breaking on id.
				receivedAt: NOW + Math.floor(index / 6) * 1000,
			});
		}

		const client = await connect(mf, "fixture-consumer-1");
		try {
			const seen = [];
			let cursor;
			for (let page = 0; page < 20; page += 1) {
				const result = await client.callTool({
					name: "whoyou_mail_search",
					arguments: { limit: 10, ...(cursor ? { cursor } : {}) },
				});
				assert.equal(result.isError, undefined);
				seen.push(...result.structuredContent.messages.map((message) => message.id));
				cursor = result.structuredContent.nextCursor;
				if (!cursor) break;
			}
			assert.equal(seen.length, 60);
			assert.equal(new Set(seen).size, 60);
		} finally {
			await client.close();
		}
	});
});

test("retention sweep expires only audit rows, never user mail", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedTwoAccounts(db);
		await seedMessage(db, { id: "msg_keep_forever", accountId: "account-a" });
		await db
			.prepare(
				`INSERT INTO mail_audit_log (id, account_id, action, target_id, detail, created_at)
				 VALUES ('old', 'account-a', 'export', NULL, '', ?), ('new', 'account-a', 'export', NULL, '', ?)`,
			)
			.bind(NOW - 200 * DAY_MS, NOW - 10 * DAY_MS)
			.run();

		const response = await mf.dispatchFetch("https://127.0.0.1/__retention", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ now: NOW }),
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json()).deletedAuditEntries, 1);

		const audit = await db.prepare("SELECT id FROM mail_audit_log ORDER BY id").all();
		assert.deepEqual(audit.results.map((row) => row.id), ["new"]);
		const message = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE id = 'msg_keep_forever'")
			.first();
		assert.equal(message.total, 1);
	});
});
