import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
	encodeFixtureConfirmation,
	encodeFixtureIdentityConfirmation,
} from "../dist/fixtures.mjs";
import { connect, seedMailbox, withWorker } from "./workerd-harness.mjs";

/**
 * Shared end-to-end scenario for third-party identities (S7c/S7d).
 *
 * Gmail and Microsoft differ only in the provider name, the callback path, the
 * authorization URL and the cursor mode, so the whole link → send → sync →
 * unlink flow lives here and each provider test supplies its fixtures.
 */

export const FIXTURE_KEK = Buffer.alloc(32, 9).toString("base64");

const post = (mf, path, body) =>
	mf.dispatchFetch(`https://127.0.0.1${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const makeConfirmation = (provider) => (action) => (mailboxId, overrides = {}) =>
	encodeFixtureIdentityConfirmation({
		accountId: "account-a",
		action,
		provider,
		mailboxId: action === "link" ? null : mailboxId,
		nonce: `nonce-${action}-${randomUUID()}`,
		...overrides,
	});

export async function runThirdPartyMailboxScenario(options) {
	const {
		provider,
		otherProvider,
		bindings,
		callbackPath,
		syncPath,
		sendPath,
		expectedAddress,
		expectedProviderMessageId,
		plaintextTokenMarker,
		expiredScript,
		syncModeAfterBackfill,
		sendSubject,
		expectedScopes,
		expectedScopeString,
		assertAuthorizationUrl,
		checkAfterDelta,
		checkAfterExpiry,
	} = options;

	const linkConfirmation = makeConfirmation(provider)("link");
	const unlinkConfirmation = makeConfirmation(provider)("unlink");

	await withWorker(bindings, async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});
		const client = await connect(mf, "fixture-mail-writer");
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		for (const tool of [
			"whoyou_mailbox_list",
			"whoyou_mailbox_link",
			"whoyou_mailbox_unlink",
		]) {
			assert.ok(names.includes(tool), `${tool} should be exposed`);
		}

		// A caller with no identity confirmation cannot start a link.
		const denied = await client.callTool({
			name: "whoyou_mailbox_link",
			arguments: { provider, confirmationCredential: "not-a-credential" },
		});
		assert.equal(denied.structuredContent.error, "confirmation_invalid");

		// A confirmation minted for another provider cannot open this link.
		const wrongProvider = await client.callTool({
			name: "whoyou_mailbox_link",
			arguments: {
				provider,
				confirmationCredential: linkConfirmation(undefined, { provider: otherProvider }),
			},
		});
		assert.equal(wrongProvider.structuredContent.error, "confirmation_provider_mismatch");

		const confirmation = linkConfirmation();
		const started = await client.callTool({
			name: "whoyou_mailbox_link",
			arguments: { provider, confirmationCredential: confirmation },
		});
		const authUrl = new URL(started.structuredContent.authorizationUrl);
		assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
		assertAuthorizationUrl(authUrl);
		if (expectedScopeString) {
			assert.equal(authUrl.searchParams.get("scope"), expectedScopeString);
		}
		if (expectedScopes) {
			const granted = authUrl.searchParams.get("scope").split(" ");
			for (const scope of expectedScopes) assert.ok(granted.includes(scope));
		}
		const state = started.structuredContent.state;

		// The same confirmation nonce cannot authorize a second link.
		const replayed = await client.callTool({
			name: "whoyou_mailbox_link",
			arguments: { provider, confirmationCredential: confirmation },
		});
		assert.equal(replayed.structuredContent.error, "confirmation_replayed");

		// The provider callback exchanges the code and learns the address itself.
		const callback = await post(mf, callbackPath, { code: "fixture-code", state });
		const linked = await callback.json();
		assert.equal(callback.status, 200);
		assert.equal(linked.ok, true);
		assert.equal(linked.address, expectedAddress);
		const mailboxId = linked.mailboxId;

		const reused = await post(mf, callbackPath, { code: "fixture-code", state });
		const reusedBody = await reused.json();
		assert.equal(reusedBody.ok, false);
		assert.equal(reusedBody.code, "invalid_state");

		// The refresh token exists only as ciphertext; the state row is gone.
		const credential = await db
			.prepare("SELECT ciphertext, nonce, status FROM provider_credentials WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(credential.status, "active");
		assert.ok(credential.ciphertext);
		assert.ok(!JSON.stringify(credential).includes(plaintextTokenMarker));
		const states = await db
			.prepare("SELECT COUNT(*) AS total FROM oauth_link_states")
			.first();
		assert.equal(states.total, 0);

		const listed = await client.callTool({ name: "whoyou_mailbox_list", arguments: {} });
		const identities = listed.structuredContent.identities;
		assert.equal(identities.length, 2);
		const linkedIdentity = identities.find((entry) => entry.provider === provider);
		assert.equal(linkedIdentity.kind, "third_party");
		assert.equal(linkedIdentity.address, expectedAddress);
		assert.equal(linkedIdentity.credentialStatus, "active");

		// A draft bound to this identity sends through its provider adapter.
		const draft = await client.callTool({
			name: "whoyou_mail_draft_create",
			arguments: {
				mailboxId,
				to: [{ name: "Dest", address: "dest@example.net" }],
				subject: sendSubject,
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
					nonce: `nonce-send-${provider}-0001`,
				}),
				idempotencyKey: `s7-${provider}-send-1`,
			},
		});
		assert.equal(sent.structuredContent.receipt.provider, provider);
		assert.equal(sent.structuredContent.receipt.providerMessageId, expectedProviderMessageId);
		const receipt = await db
			.prepare("SELECT provider FROM send_receipts WHERE draft_id = ?")
			.bind(created.draftId)
			.first();
		assert.equal(receipt.provider, provider);

		// Backfill imports one message; the incremental cursor dedupes it.
		const backfill = await post(mf, syncPath, {
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

		const incremental = await post(mf, syncPath, {
			accountId: "account-a",
			mailboxId,
			script: "ok",
		}).then((response) => response.json());
		assert.equal(incremental.mode, syncModeAfterBackfill);
		assert.equal(incremental.imported, 0);
		assert.equal(incremental.duplicates, 1);
		count = await db
			.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first();
		assert.equal(count.total, 1);
		if (checkAfterDelta) await checkAfterDelta(db, mailboxId);

		// An expired cursor falls back to the bounded backfill, then recovers.
		const expired = await post(mf, syncPath, {
			accountId: "account-a",
			mailboxId,
			script: expiredScript,
		}).then((response) => response.json());
		assert.equal(expired.ok, true);
		assert.equal(expired.mode, "idle");
		if (checkAfterExpiry) await checkAfterExpiry(db, mailboxId);
		const recovered = await post(mf, syncPath, {
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
		const reauth = await post(mf, sendPath, {
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
				confirmationCredential: linkConfirmation(mailboxId),
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
		const afterRemoval = await post(mf, sendPath, {
			accountId: "account-a",
			mailboxId,
			to: "dest@example.net",
		});
		assert.equal(afterRemoval.status, 404);
	});
}
