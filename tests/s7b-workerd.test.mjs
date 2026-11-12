import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { NOW, withWorker } from "./workerd-harness.mjs";

const KEK_1 = Buffer.alloc(32, 1).toString("base64");
const KEK_2 = Buffer.alloc(32, 2).toString("base64");
const CREDENTIAL_URL = "https://127.0.0.1/__credential";

const credential = async (mf, body) => {
	const response = await mf.dispatchFetch(CREDENTIAL_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() };
};

const seedIdentity = (db, options) =>
	db
		.prepare(
			`INSERT INTO mailboxes (
			 id, account_id, address, local_part, kind, provider, status, quota_bytes,
			 bytes_used, message_count, quarantine_count, created_at, updated_at
			 ) VALUES (?,?,?,?,?,?, 'active', 1024, 0, 0, 0, ?, ?)`,
		)
		.bind(
			options.id,
			options.accountId ?? "account-a",
			options.address,
			options.localPart,
			options.kind ?? "third_party",
			options.provider,
			NOW,
			NOW,
		)
		.run();

const gmailStore = (overrides = {}) => ({
	action: "store",
	accountId: "account-a",
	mailboxId: "mbx_gmail",
	provider: "gmail",
	credentialType: "oauth_refresh",
	secret: "1//refresh-token-value",
	kek: KEK_1,
	version: 1,
	...overrides,
});

test("S7b stores only ciphertext and returns the secret for the same KEK", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedIdentity(db, {
			id: "mbx_gmail",
			address: "alpha@gmail.com",
			localPart: "alpha",
			provider: "gmail",
		});

		const stored = await credential(mf, gmailStore());
		assert.equal(stored.status, 200);
		assert.equal(stored.body.ok, true);
		assert.equal(stored.body.credential.status, "active");
		assert.equal(stored.body.credential.provider, "gmail");
		assert.equal(stored.body.credential.keyVersion, 1);
		assert.equal(stored.body.secret, undefined);

		const row = await db
			.prepare("SELECT ciphertext, wrapped_dek, nonce, wrap_nonce FROM provider_credentials")
			.first();
		assert.ok(row.ciphertext.length > 0);
		assert.equal(row.ciphertext.includes("refresh-token"), false);
		assert.equal(row.wrapped_dek.includes("refresh-token"), false);
		assert.ok(row.nonce.length > 0);
		assert.ok(row.wrap_nonce.length > 0);

		const read = await credential(mf, {
			action: "read",
			accountId: "account-a",
			mailboxId: "mbx_gmail",
			credentialType: "oauth_refresh",
			kek: KEK_1,
			version: 1,
		});
		assert.equal(read.body.ok, true);
		assert.equal(read.body.secret, "1//refresh-token-value");
	});
});

test("S7b keeps one active credential per slot while IMAP and SMTP passwords coexist", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedIdentity(db, {
			id: "mbx_gmail",
			address: "alpha@gmail.com",
			localPart: "alpha",
			provider: "gmail",
		});
		await seedIdentity(db, {
			id: "mbx_imap",
			address: "alpha@example.net",
			localPart: "alpha",
			provider: "imap_smtp",
		});

		assert.equal((await credential(mf, gmailStore())).body.ok, true);
		const duplicate = await credential(mf, gmailStore({ secret: "second-token" }));
		assert.equal(duplicate.body.ok, false);
		assert.equal(duplicate.body.code, "credential_already_exists");

		const imap = await credential(
			mf,
			gmailStore({
				mailboxId: "mbx_imap",
				provider: "imap_smtp",
				credentialType: "imap_password",
				secret: "imap-app-password",
			}),
		);
		const smtp = await credential(
			mf,
			gmailStore({
				mailboxId: "mbx_imap",
				provider: "imap_smtp",
				credentialType: "smtp_password",
				secret: "smtp-app-password",
			}),
		);
		assert.equal(imap.body.ok, true);
		assert.equal(smtp.body.ok, true);
	});
});

test("S7b revoke shreds the material, keeps the row and allows a fresh link", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedIdentity(db, {
			id: "mbx_gmail",
			address: "alpha@gmail.com",
			localPart: "alpha",
			provider: "gmail",
		});
		await credential(mf, gmailStore());

		const revoked = await credential(mf, {
			action: "revoke",
			accountId: "account-a",
			mailboxId: "mbx_gmail",
			credentialType: "oauth_refresh",
			kek: KEK_1,
			version: 1,
		});
		assert.equal(revoked.body.changes, 1);

		const row = await db
			.prepare("SELECT status, ciphertext, wrapped_dek, revoked_at FROM provider_credentials")
			.first();
		assert.equal(row.status, "revoked");
		assert.equal(row.ciphertext, null);
		assert.equal(row.wrapped_dek, null);
		assert.equal(row.revoked_at, NOW);

		const read = await credential(mf, {
			action: "read",
			accountId: "account-a",
			mailboxId: "mbx_gmail",
			credentialType: "oauth_refresh",
			kek: KEK_1,
			version: 1,
		});
		assert.equal(read.body.ok, false);
		assert.equal(read.body.code, "credential_revoked");

		assert.equal((await credential(mf, gmailStore({ secret: "fresh-token" }))).body.ok, true);
		const { n } = await db
			.prepare("SELECT COUNT(*) AS n FROM provider_credentials")
			.first();
		assert.equal(n, 2);
	});
});

test("S7b marks the row unreadable when the KEK cannot open it", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedIdentity(db, {
			id: "mbx_gmail",
			address: "alpha@gmail.com",
			localPart: "alpha",
			provider: "gmail",
		});
		await credential(mf, gmailStore());

		const read = await credential(mf, {
			action: "read",
			accountId: "account-a",
			mailboxId: "mbx_gmail",
			credentialType: "oauth_refresh",
			kek: KEK_2,
			version: 1,
		});
		assert.equal(read.body.ok, false);
		assert.equal(read.body.code, "credential_unreadable");
		assert.equal(read.body.secret, undefined);

		const row = await db
			.prepare("SELECT status FROM provider_credentials")
			.first();
		assert.equal(row.status, "unreadable");
	});
});

test("S7b rotation rewraps the DEK so the new KEK reads the same secret", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedIdentity(db, {
			id: "mbx_gmail",
			address: "alpha@gmail.com",
			localPart: "alpha",
			provider: "gmail",
		});
		await credential(mf, gmailStore());

		const withoutPrevious = await credential(mf, {
			action: "rewrap",
			kek: KEK_2,
			version: 2,
		});
		assert.deepEqual(withoutPrevious.body, { rewrapped: 0, unreadable: 0 });

		const rewrapped = await credential(mf, {
			action: "rewrap",
			kek: KEK_2,
			version: 2,
			previousKek: KEK_1,
			previousVersion: 1,
		});
		assert.deepEqual(rewrapped.body, { rewrapped: 1, unreadable: 0 });

		const row = await db
			.prepare("SELECT key_version FROM provider_credentials")
			.first();
		assert.equal(row.key_version, 2);

		// No previous key here: readability proves the wrap really moved.
		const read = await credential(mf, {
			action: "read",
			accountId: "account-a",
			mailboxId: "mbx_gmail",
			credentialType: "oauth_refresh",
			kek: KEK_2,
			version: 2,
		});
		assert.equal(read.body.ok, true);
		assert.equal(read.body.secret, "1//refresh-token-value");
	});
});

test("S7b list stays metadata-only and the vault closes without a KEK", async () => {
	await withWorker(async ({ mf, db }) => {
		await seedIdentity(db, {
			id: "mbx_gmail",
			address: "alpha@gmail.com",
			localPart: "alpha",
			provider: "gmail",
		});
		await seedIdentity(db, {
			id: "mbx_imap",
			address: "alpha@example.net",
			localPart: "alpha",
			provider: "imap_smtp",
		});

		const closed = await credential(mf, {
			action: "store",
			accountId: "account-a",
			mailboxId: "mbx_gmail",
			provider: "gmail",
			credentialType: "oauth_refresh",
			secret: "should-not-be-stored",
		});
		assert.equal(closed.status, 503);
		assert.equal(closed.body.error, "kek_missing");
		assert.equal(
			(await db.prepare("SELECT COUNT(*) AS n FROM provider_credentials").first()).n,
			0,
		);

		await credential(mf, gmailStore());
		await credential(
			mf,
			gmailStore({
				mailboxId: "mbx_imap",
				provider: "imap_smtp",
				credentialType: "imap_password",
				secret: "imap-app-password",
			}),
		);

		const listed = await credential(mf, {
			action: "list",
			accountId: "account-a",
			kek: KEK_1,
			version: 1,
		});
		assert.equal(listed.body.length, 2);
		for (const record of listed.body) {
			assert.equal(record.accountId, "account-a");
			for (const forbidden of ["secret", "ciphertext", "wrappedDek", "wrapNonce", "nonce"]) {
				assert.equal(forbidden in record, false, forbidden);
			}
		}
	});
});
