import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { encodeFixtureIdentityConfirmation } from "../dist/fixtures.mjs";
import { FIXTURE_KEK } from "./s7-helpers.mjs";
import { connect, seedMailbox, withWorker } from "./workerd-harness.mjs";

const post = (mf, path, body) =>
	mf.dispatchFetch(`https://127.0.0.1${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const confirmation = (action, mailboxId = null) =>
	encodeFixtureIdentityConfirmation({
		accountId: "account-a",
		action,
		provider: "imap_smtp",
		mailboxId,
		nonce: `nonce-${action}-${randomUUID()}`,
	});

const linkRequest = (overrides = {}) => ({
	accountId: "account-a",
	address: "linked@example.net",
	username: "linked@example.net",
	imapHost: "imap.example.com",
	imapPort: 993,
	smtpHost: "smtp.example.com",
	smtpPort: 465,
	appPassword: "fixture-app-password",
	...overrides,
});

test("S7e: IMAP/SMTP link, sync, send and unlink keep secrets and hosts private", async () => {
	await withWorker({ MAIL_CREDENTIAL_KEK: FIXTURE_KEK }, async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});
		const client = await connect(mf, "fixture-mail-writer");
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		assert.ok(names.includes("whoyou_mailbox_link"));
		assert.ok(names.includes("whoyou_mailbox_unlink"));

		// No identity confirmation: the link is refused before any socket opens.
		const denied = await client.callTool({
			name: "whoyou_mailbox_link",
			arguments: {
				provider: "imap_smtp",
				address: "linked@example.net",
				username: "linked@example.net",
				imapHost: "imap.example.com",
				imapPort: 993,
				smtpHost: "smtp.example.com",
				smtpPort: 465,
				appPassword: "fixture-app-password",
				confirmationCredential: "not-a-credential",
			},
		});
		assert.equal(denied.structuredContent.error, "confirmation_invalid");

		// A hostname literal is rejected before the transport is called.
		const literal = await post(mf, "/__imap/link", linkRequest({ imapHost: "127.0.0.1" }));
		const literalBody = await literal.json();
		assert.equal(literalBody.ok, false);
		assert.equal(literalBody.code, "invalid_target_host");
		assert.equal(literalBody.connectCalls, 0);

		// Port 25 is never accepted.
		const port25 = await post(mf, "/__imap/link", linkRequest({ smtpPort: 25 }));
		const port25Body = await port25.json();
		assert.equal(port25Body.ok, false);
		assert.equal(port25Body.code, "invalid_target_port");
		assert.equal(port25Body.connectCalls, 0);

		// The own-domain address cannot be taken over by a self-filled identity.
		const conflict = await post(mf, "/__imap/link", linkRequest({
			address: "alpha@tomlab.cn",
			username: "alpha@tomlab.cn",
		}));
		const conflictBody = await conflict.json();
		assert.equal(conflictBody.ok, false);
		assert.equal(conflictBody.code, "address_already_linked");
		assert.equal(conflictBody.connectCalls, 0);

		// A rejected IMAP login maps to a fixed code and stores nothing.
		const badLogin = await post(mf, "/__imap/link", linkRequest({ imapScript: "imap_auth_fail" }));
		const badLoginBody = await badLogin.json();
		assert.equal(badLoginBody.ok, false);
		assert.equal(badLoginBody.code, "provider_auth_failed");
		assert.equal(
			await db
				.prepare("SELECT COUNT(*) AS total FROM mailbox_remote_targets")
				.first()
				.then((row) => row.total),
			0,
		);

		const created = await post(mf, "/__imap/link", linkRequest());
		const linkBody = await created.json();
		assert.equal(linkBody.ok, true);
		assert.equal(linkBody.address, "linked@example.net");
		assert.equal(linkBody.connectCalls, 1);
		const mailboxId = linkBody.mailboxId;

		// The password exists twice, sealed, and the endpoint row is scoped.
		const credentials = await db
			.prepare(
				"SELECT credential_type, status, ciphertext FROM provider_credentials WHERE mailbox_id = ? ORDER BY credential_type",
			)
			.bind(mailboxId)
			.all();
		assert.deepEqual(
			credentials.results.map((row) => row.credential_type),
			["imap_password", "smtp_password"],
		);
		for (const row of credentials.results) {
			assert.equal(row.status, "active");
			assert.ok(!JSON.stringify(row).includes("fixture-app-password"));
		}
		const target = await db
			.prepare(
				"SELECT imap_host, imap_port, smtp_host, smtp_port, username FROM mailbox_remote_targets WHERE mailbox_id = ?",
			)
			.bind(mailboxId)
			.first();
		assert.equal(target.imap_host, "imap.example.com");
		assert.equal(target.smtp_port, 465);
		assert.equal(target.username, "linked@example.net");

		const listed = await client.callTool({ name: "whoyou_mailbox_list", arguments: {} });
		const linkedIdentity = listed.structuredContent.identities.find(
			(entry) => entry.mailboxId === mailboxId,
		);
		assert.equal(linkedIdentity.provider, "imap_smtp");
		assert.equal(linkedIdentity.credentialStatus, "active");
		// No password or host is echoed by the identity surface.
		assert.equal(JSON.stringify(linkedIdentity).includes("fixture-app-password"), false);
		assert.equal(JSON.stringify(linkedIdentity).includes("imap.example.com"), false);

		// Backfill imports the bounded window once; the cursor dedupes the rest.
		const backfill = await post(mf, "/__imap/sync", {
			accountId: "account-a",
			mailboxId,
			script: "ok",
		}).then((response) => response.json());
		assert.equal(backfill.ok, true);
		assert.equal(backfill.mode, "backfill");
		assert.equal(backfill.imported, 1);
		assert.equal(backfill.duplicates, 1);
		assert.equal(
			await db
				.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
				.bind(mailboxId)
				.first()
				.then((row) => row.total),
			1,
		);
		const state = await db
			.prepare(
				"SELECT cursor, backfill_before, backfill_page FROM mailbox_sync_state WHERE mailbox_id = ?",
			)
			.bind(mailboxId)
			.first();
		assert.deepEqual(JSON.parse(state.cursor), { uidValidity: 42, lastUid: 2 });
		assert.equal(state.backfill_before, null);
		assert.equal(state.backfill_page, null);

		const incremental = await post(mf, "/__imap/sync", {
			accountId: "account-a",
			mailboxId,
			script: "ok",
		}).then((response) => response.json());
		assert.equal(incremental.mode, "incremental");
		assert.equal(incremental.imported, 0);
		assert.equal(incremental.duplicates, 0);

		// A new UIDVALIDITY invalidates the cursor; the rescan stays idempotent.
		await db
			.prepare("UPDATE mailbox_sync_state SET cursor = ? WHERE mailbox_id = ?")
			.bind(JSON.stringify({ uidValidity: 7, lastUid: 2 }), mailboxId)
			.run();
		const rescanned = await post(mf, "/__imap/sync", {
			accountId: "account-a",
			mailboxId,
			script: "uidvalidity_changed",
		}).then((response) => response.json());
		assert.equal(rescanned.ok, true);
		assert.equal(rescanned.mode, "backfill");
		assert.equal(rescanned.duplicates, 2);
		const rescannedState = await db
			.prepare("SELECT cursor, last_error FROM mailbox_sync_state WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.deepEqual(JSON.parse(rescannedState.cursor), { uidValidity: 43, lastUid: 2 });
		assert.equal(rescannedState.last_error, null);
		assert.equal(
			await db
				.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
				.bind(mailboxId)
				.first()
				.then((row) => row.total),
			1,
		);

		// SMTP submission returns the provider and the Message-ID of the raw message.
		const sent = await post(mf, "/__imap/send", {
			accountId: "account-a",
			mailboxId,
			to: "dest@example.net",
			script: "ok",
		});
		const sentBody = await sent.json();
		assert.equal(sent.status, 200);
		assert.equal(sentBody.provider, "imap_smtp");
		assert.match(sentBody.providerMessageId, /^<[^<>@]+@example\.net>$/);

		// Plaintext-only submission on 587 is refused before AUTH.
		const created587 = await post(
			mf,
			"/__imap/link",
			linkRequest({
				address: "linked587@example.net",
				username: "linked587@example.net",
				smtpPort: 587,
			}),
		).then((response) => response.json());
		assert.equal(created587.ok, true);
		const plaintext = await post(mf, "/__imap/send", {
			accountId: "account-a",
			mailboxId: created587.mailboxId,
			to: "dest@example.net",
			script: "no_starttls",
		});
		assert.equal(plaintext.status, 502);
		assert.equal((await plaintext.json()).error, "relay_unavailable");
		const kept = await db
			.prepare(
				"SELECT status FROM provider_credentials WHERE mailbox_id = ? AND credential_type = 'smtp_password'",
			)
			.bind(created587.mailboxId)
			.first();
		assert.equal(kept.status, "active");
		await client.callTool({
			name: "whoyou_mailbox_unlink",
			arguments: {
				mailboxId: created587.mailboxId,
				confirmationCredential: confirmation("unlink", created587.mailboxId),
			},
		});

		// A rejected password flips the stored credential to reauth_required.
		const rejected = await post(mf, "/__imap/send", {
			accountId: "account-a",
			mailboxId,
			to: "dest@example.net",
			script: "auth_fail",
		});
		assert.equal(rejected.status, 409);
		assert.equal((await rejected.json()).error, "provider_reauth_required");
		const flipped = await db
			.prepare(
				"SELECT status FROM provider_credentials WHERE mailbox_id = ? AND credential_type = 'smtp_password'",
			)
			.bind(mailboxId)
			.first();
		assert.equal(flipped.status, "reauth_required");

		// Unlink uses its own confirmation and shreds both rows, the endpoint and mail.
		const wrongAction = await client.callTool({
			name: "whoyou_mailbox_unlink",
			arguments: { mailboxId, confirmationCredential: confirmation("link", mailboxId) },
		});
		assert.equal(wrongAction.structuredContent.error, "confirmation_action_mismatch");

		const unlinked = await client.callTool({
			name: "whoyou_mailbox_unlink",
			arguments: { mailboxId, confirmationCredential: confirmation("unlink", mailboxId) },
		});
		assert.equal(unlinked.structuredContent.alreadyUnlinked, false);

		for (const table of [
			"messages",
			"threads",
			"attachments",
			"mail_drafts",
			"provider_credentials",
			"mailbox_sync_state",
			"mailbox_remote_targets",
		]) {
			const row = await db
				.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE mailbox_id = ?`)
				.bind(mailboxId)
				.first();
			assert.equal(row.total, 0, `${table} should be empty after unlink`);
		}
		const bucket = await mf.getR2Bucket("MAIL_BUCKET");
		const objects = await bucket.list({ prefix: `accounts/account-a/mailboxes/${mailboxId}/` });
		assert.equal(objects.objects.length, 0);

		const repeated = await client.callTool({
			name: "whoyou_mailbox_unlink",
			arguments: { mailboxId, confirmationCredential: confirmation("unlink", mailboxId) },
		});
		assert.equal(repeated.structuredContent.alreadyUnlinked, true);

		const afterUnlink = await client.callTool({ name: "whoyou_mailbox_list", arguments: {} });
		assert.equal(afterUnlink.structuredContent.identities.length, 1);
	});
});
