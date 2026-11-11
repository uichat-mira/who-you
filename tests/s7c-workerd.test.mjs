import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
	encodeFixtureConfirmation,
	encodeFixtureIdentityConfirmation,
} from "../dist/fixtures.mjs";
import { connect, seedMailbox, withWorker } from "./workerd-harness.mjs";

const KEK = Buffer.alloc(32, 9).toString("base64");
const BINDINGS = {
	MAIL_CREDENTIAL_KEK: KEK,
	GMAIL_OAUTH_CLIENT_ID: "fixture-client-id",
	GMAIL_OAUTH_CLIENT_SECRET: "fixture-client-secret",
	GMAIL_OAUTH_REDIRECT_URI: "https://127.0.0.1/mail/oauth/gmail/callback",
	MAIL_SEND_MODE: "gmail",
};

const post = (mf, path, body) =>
	mf.dispatchFetch(`https://127.0.0.1${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const linkConfirmation = (overrides = {}) =>
	encodeFixtureIdentityConfirmation({
		accountId: "account-a",
		action: "link",
		provider: "gmail",
		mailboxId: null,
		nonce: `nonce-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		...overrides,
	});

const unlinkConfirmation = (mailboxId, overrides = {}) =>
	encodeFixtureIdentityConfirmation({
		accountId: "account-a",
		action: "unlink",
		provider: "gmail",
		mailboxId,
		nonce: `nonce-unlink-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		...overrides,
	});

test("S7c: Gmail link, send, sync and unlink stay inside one account", async () => {
	await withWorker(BINDINGS, async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});
		const client = await connect(mf, "fixture-mail-writer");
		const tools = await client.listTools();
		const names = tools.tools.map((tool) => tool.name);
		assert.ok(names.includes("whoyou_mailbox_list"));
		assert.ok(names.includes("whoyou_mailbox_link"));
		assert.ok(names.includes("whoyou_mailbox_unlink"));

		// A caller that has no identity confirmation cannot start a link.
		const denied = await client.callTool({
			name: "whoyou_mailbox_link",
			arguments: { provider: "gmail", confirmationCredential: "not-a-credential" },
		});
		assert.equal(denied.structuredContent.error, "confirmation_invalid");

		const confirmation = linkConfirmation();
		const started = await client.callTool({
			name: "whoyou_mailbox_link",
			arguments: { provider: "gmail", confirmationCredential: confirmation },
		});
		const authUrl = new URL(started.structuredContent.authorizationUrl);
		assert.equal(authUrl.hostname, "accounts.google.com");
		assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
		assert.equal(authUrl.searchParams.get("access_type"), "offline");
		assert.equal(
			authUrl.searchParams.get("scope"),
			"https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
		);
		const state = started.structuredContent.state;

		// The same confirmation nonce cannot authorize a second link.
		const replayed = await client.callTool({
			name: "whoyou_mailbox_link",
			arguments: { provider: "gmail", confirmationCredential: confirmation },
		});
		assert.equal(replayed.structuredContent.error, "confirmation_replayed");

		// The provider callback exchanges the code and learns the address itself.
		const callback = await post(mf, "/__gmail/callback", {
			code: "fixture-code",
			state,
		});
		const linked = await callback.json();
		assert.equal(callback.status, 200);
		assert.equal(linked.ok, true);
		assert.equal(linked.address, "linked@gmail.com");
		const mailboxId = linked.mailboxId;

		const reusedState = await post(mf, "/__gmail/callback", {
			code: "fixture-code",
			state,
		});
		const reusedBody = await reusedState.json();
		assert.equal(reusedBody.ok, false);
		assert.equal(reusedBody.code, "invalid_state");

		// The refresh token exists only as ciphertext; the state row is gone.
		const credential = await db
			.prepare(
				"SELECT ciphertext, nonce, status FROM provider_credentials WHERE mailbox_id = ?",
			)
			.bind(mailboxId)
			.first();
		assert.equal(credential.status, "active");
		assert.ok(credential.ciphertext);
		assert.ok(!credential.ciphertext.includes("fixture-refresh-token"));
		assert.ok(!JSON.stringify(credential).includes("fixture-refresh-token"));
		const states = await db
			.prepare("SELECT COUNT(*) AS total FROM oauth_link_states")
			.first();
		assert.equal(states.total, 0);

		const listed = await client.callTool({ name: "whoyou_mailbox_list", arguments: {} });
		const identities = listed.structuredContent.identities;
		assert.equal(identities.length, 2);
		const gmail = identities.find((entry) => entry.provider === "gmail");
		assert.equal(gmail.kind, "third_party");
		assert.equal(gmail.address, "linked@gmail.com");
		assert.equal(gmail.credentialStatus, "active");

		// A gmail-bound draft sends through the routed provider and stores it.
		const draft = await client.callTool({
			name: "whoyou_mail_draft_create",
			arguments: {
				mailboxId,
				to: [{ name: "Dest", address: "dest@example.net" }],
				subject: "Gmail outbound fixture",
				text: "Body",
			},
		});
		assert.equal(draft.isError, undefined);
		const created = draft.structuredContent.draft;
		const storedDraft = await db
			.prepare("SELECT mailbox_id FROM mail_drafts WHERE id = ?")
			.bind(created.draftId)
			.first();
		assert.equal(storedDraft.mailbox_id, mailboxId);
		const sent = await client.callTool({
			name: "whoyou_mail_send",
			arguments: {
				draftId: created.draftId,
				confirmationCredential: encodeFixtureConfirmation({
					accountId: "account-a",
					actor: "user",
					draftId: created.draftId,
					draftVersion: created.version,
					contentHash: created.contentHash,
					nonce: "nonce-send-gmail-000001",
				}),
				idempotencyKey: "s7c-gmail-send-1",
			},
		});
		assert.equal(sent.structuredContent.receipt.provider, "gmail");
		assert.equal(sent.structuredContent.receipt.providerMessageId, "gmail-sent-1");
		const receipt = await db
			.prepare("SELECT provider FROM send_receipts WHERE draft_id = ?")
			.bind(created.draftId)
			.first();
		assert.equal(receipt.provider, "gmail");

		// Backfill imports one message; history dedupes the same Message-ID.
		const backfill = await post(mf, "/__gmail/sync", {
			accountId: "account-a",
			mailboxId,
			script: "ok",
		}).then((response) => response.json());
		assert.equal(backfill.ok, true);
		assert.equal(backfill.mode, "backfill");
		assert.equal(backfill.imported, 1);
		let count = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(count.total, 1);

		const history = await post(mf, "/__gmail/sync", {
			accountId: "account-a",
			mailboxId,
			script: "ok",
		}).then((response) => response.json());
		assert.equal(history.mode, "history");
		assert.equal(history.imported, 0);
		assert.equal(history.duplicates, 1);
		count = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(count.total, 1);

		// An expired historyId falls back to backfill without duplicating rows.
		const expired = await post(mf, "/__gmail/sync", {
			accountId: "account-a",
			mailboxId,
			script: "history_expired",
		}).then((response) => response.json());
		assert.equal(expired.ok, true);
		assert.equal(expired.mode, "idle");
		const recovered = await post(mf, "/__gmail/sync", {
			accountId: "account-a",
			mailboxId,
			script: "ok",
		}).then((response) => response.json());
		assert.equal(recovered.mode, "backfill");
		assert.equal(recovered.duplicates, 1);
		count = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(count.total, 1);
		assert.equal(
			await db
				.prepare("SELECT COUNT(*) AS total FROM threads WHERE mailbox_id = ?")
				.bind(mailboxId)
				.first()
				.then((row) => row.total),
			1,
		);

		// invalid_grant flips the identity to reauth_required; send is refused.
		const reauth = await post(mf, "/__gmail/send", {
			accountId: "account-a",
			mailboxId,
			to: "dest@example.net",
			invalidGrant: true,
		});
		assert.equal(reauth.status, 409);
		assert.equal((await reauth.json()).error, "provider_reauth_required");
		const flipped = await db
			.prepare("SELECT status FROM provider_credentials WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(flipped.status, "reauth_required");

		// Unlink requires its own confirmation and removes every synced copy.
		const wrongAction = await client.callTool({
			name: "whoyou_mailbox_unlink",
			arguments: {
				mailboxId,
				confirmationCredential: linkConfirmation({ mailboxId }),
			},
		});
		assert.equal(wrongAction.structuredContent.error, "confirmation_action_mismatch");

		const unlinked = await client.callTool({
			name: "whoyou_mailbox_unlink",
			arguments: {
				mailboxId,
				confirmationCredential: unlinkConfirmation(mailboxId),
			},
		});
		assert.equal(unlinked.structuredContent.alreadyUnlinked, false);

		for (const table of [
			"messages",
			"threads",
			"attachments",
			"mail_drafts",
			"provider_credentials",
			"mailbox_sync_state",
		]) {
			const row = await db
				.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE mailbox_id = ?`)
				.bind(mailboxId)
				.first();
			assert.equal(row.total, 0, `${table} should be empty after unlink`);
		}
		const mailboxRow = await db
			.prepare("SELECT COUNT(*) AS total FROM mailboxes WHERE id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(mailboxRow.total, 0, "mailboxes should be empty after unlink");
		const bucket = await mf.getR2Bucket("MAIL_BUCKET");
		const objects = await bucket.list({ prefix: `accounts/account-a/mailboxes/${mailboxId}/` });
		assert.equal(objects.objects.length, 0);

		const afterUnlink = await client.callTool({ name: "whoyou_mailbox_list", arguments: {} });
		assert.equal(afterUnlink.structuredContent.identities.length, 1);

		const repeated = await client.callTool({
			name: "whoyou_mailbox_unlink",
			arguments: {
				mailboxId,
				confirmationCredential: unlinkConfirmation(mailboxId),
			},
		});
		assert.equal(repeated.structuredContent.alreadyUnlinked, true);

		// With the identity gone, sending resolves to a fixed credential code.
		const afterRemoval = await post(mf, "/__gmail/send", {
			accountId: "account-a",
			mailboxId,
			to: "dest@example.net",
		});
		assert.equal(afterRemoval.status, 404);
	});
});
