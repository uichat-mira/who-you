import { test } from "node:test";
import assert from "node:assert/strict";
import { NOW, seedMailbox, withWorker } from "./workerd-harness.mjs";

const insertIdentity = (db, options) =>
	db
		.prepare(
			`INSERT INTO mailboxes (
			 id, account_id, address, local_part, kind, provider, status, quota_bytes,
			 bytes_used, message_count, quarantine_count, created_at, updated_at
			 ) VALUES (?,?,?,?,?,?, 'active', 1024, 0, 0, 0, ?, ?)`,
		)
		.bind(
			options.id,
			options.accountId,
			options.address,
			options.localPart,
			options.kind,
			options.provider,
			NOW,
			NOW,
		)
		.run();

test("S7a migration keeps existing identities own-domain and lets one account hold several addresses", async () => {
	await withWorker(async ({ db }) => {
		await seedMailbox(db, {
			id: "mbx_own",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});

		const existing = await db
			.prepare("SELECT kind, provider FROM mailboxes WHERE id = 'mbx_own'")
			.first();
		assert.equal(existing.kind, "own_domain");
		assert.equal(existing.provider, null);

		await insertIdentity(db, {
			id: "mbx_gmail",
			accountId: "account-a",
			address: "alpha@gmail.com",
			localPart: "alpha",
			kind: "third_party",
			provider: "gmail",
		});

		const { n } = await db
			.prepare("SELECT COUNT(*) AS n FROM mailboxes WHERE account_id = 'account-a'")
			.first();
		assert.equal(n, 2);
	});
});

test("S7a keeps address uniqueness across accounts and enforces kind/provider consistency", async () => {
	await withWorker(async ({ db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});

		await assert.rejects(
			insertIdentity(db, {
				id: "mbx_dup",
				accountId: "account-b",
				address: "alpha@tomlab.cn",
				localPart: "alpha",
				kind: "third_party",
				provider: "imap_smtp",
			}),
			"a third-party identity must not take another account's address",
		);

		await assert.rejects(
			insertIdentity(db, {
				id: "mbx_bad_1",
				accountId: "account-b",
				address: "beta@gmail.com",
				localPart: "beta",
				kind: "third_party",
				provider: null,
			}),
			"third_party requires a provider",
		);

		await assert.rejects(
			insertIdentity(db, {
				id: "mbx_bad_2",
				accountId: "account-b",
				address: "gamma@tomlab.cn",
				localPart: "gamma",
				kind: "own_domain",
				provider: "gmail",
			}),
			"own_domain must not carry a provider",
		);
	});
});
