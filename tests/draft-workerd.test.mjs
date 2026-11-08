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
	encodeFixtureConfirmation,
} from "../dist/fixtures.mjs";

const migrationStatements = (path) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("--"))
		.join("\n")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);

const MIGRATIONS = [
	...migrationStatements("migrations/0001_mail.sql"),
	...migrationStatements("migrations/0002_drafts_sends.sql"),
];

const BASE_BINDINGS = {
	MCP_RESOURCE_URL: MCP_TEST_RESOURCE_URL,
	CLOUD_AUTH_ISSUER: MCP_TEST_ISSUER,
	CLOUD_AUTH_JWKS_URL: MCP_TEST_JWKS_URL,
	MCP_AUDIENCE: MCP_TEST_AUDIENCE,
	MCP_REQUIRED_SCOPES: MCP_TEST_SCOPE,
	MAIL_DOMAIN: "tomlab.cn",
};

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
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
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

async function connect(mf, token) {
	const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_RESOURCE_URL), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
		fetch: async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			return mf.dispatchFetch(url, init);
		},
	});
	const client = new Client(
		{ name: "who-s2-test", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(transport);
	return client;
}

async function sentMessages(mf) {
	const response = await mf.dispatchFetch("https://127.0.0.1/__sent");
	assert.equal(response.status, 200);
	const body = await response.json();
	return body.sent;
}

const draftArgs = (overrides = {}) => ({
	to: [{ name: "Alice", address: "alice@example.com" }],
	subject: "Quarterly numbers",
	text: "Hello from Who You.",
	...overrides,
});

const confirmation = (options) =>
	encodeFixtureConfirmation({
		accountId: "account-a",
		actor: "user",
		draftId: options.draftId,
		draftVersion: options.draftVersion,
		contentHash: options.contentHash,
		nonce: options.nonce,
		...options.overrides,
	});

test("draft lifecycle is scoped, version-guarded and write-scope gated", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);

		const readOnly = await connect(mf, "fixture-consumer-1");
		try {
			const denied = await readOnly.callTool({
				name: "whoyou_mail_draft_create",
				arguments: draftArgs(),
			});
			assert.equal(denied.isError, true);
			assert.equal(denied.structuredContent.error, "insufficient_scope");
		} finally {
			await readOnly.close();
		}

		const client = await connect(mf, "fixture-mail-writer");
		try {
			const created = await client.callTool({
				name: "whoyou_mail_draft_create",
				arguments: draftArgs(),
			});
			assert.equal(created.isError, undefined);
			const draft = created.structuredContent.draft;
			assert.equal(draft.version, 1);
			assert.equal(draft.status, "draft");
			assert.match(draft.contentHash, /^[a-f0-9]{64}$/);
			assert.equal(draft.to[0].address, "alice@example.com");

			const updated = await client.callTool({
				name: "whoyou_mail_draft_update",
				arguments: {
					draftId: draft.draftId,
					expectedVersion: 1,
					subject: "Quarterly numbers (revised)",
				},
			});
			assert.equal(updated.structuredContent.draft.version, 2);
			assert.notEqual(updated.structuredContent.draft.contentHash, draft.contentHash);

			const stale = await client.callTool({
				name: "whoyou_mail_draft_update",
				arguments: {
					draftId: draft.draftId,
					expectedVersion: 1,
					subject: "Overwrite",
				},
			});
			assert.equal(stale.isError, true);
			assert.equal(stale.structuredContent.error, "draft_version_conflict");

			const fetched = await client.callTool({
				name: "whoyou_mail_draft_get",
				arguments: { draftId: draft.draftId },
			});
			assert.equal(fetched.structuredContent.draft.version, 2);

			const listed = await client.callTool({
				name: "whoyou_mail_draft_list",
				arguments: {},
			});
			assert.equal(listed.structuredContent.drafts.length, 1);
			assert.equal(listed.structuredContent.nextCursor, null);
		} finally {
			await client.close();
		}

		const other = await connect(mf, "fixture-account-b-writer");
		try {
			const foreign = await other.callTool({
				name: "whoyou_mail_draft_list",
				arguments: {},
			});
			assert.deepEqual(foreign.structuredContent.drafts, []);
		} finally {
			await other.close();
		}

		const writer = await connect(mf, "fixture-mail-writer");
		try {
			const draftId = (
				await writer.callTool({ name: "whoyou_mail_draft_list", arguments: {} })
			).structuredContent.drafts[0].draftId;
			const discarded = await writer.callTool({
				name: "whoyou_mail_draft_discard",
				arguments: { draftId },
			});
			assert.equal(discarded.structuredContent.draft.status, "discarded");
			const afterDiscard = await writer.callTool({
				name: "whoyou_mail_draft_list",
				arguments: {},
			});
			assert.deepEqual(afterDiscard.structuredContent.drafts, []);
			const editDiscarded = await writer.callTool({
				name: "whoyou_mail_draft_update",
				arguments: { draftId, expectedVersion: 2, subject: "no" },
			});
			assert.equal(editDiscarded.structuredContent.error, "draft_discarded");
			const sendDiscarded = await writer.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId,
					confirmationCredential: "irrelevant",
					idempotencyKey: "key-discarded-1",
				},
			});
			assert.equal(sendDiscarded.structuredContent.error, "draft_not_found");
		} finally {
			await writer.close();
		}

		const rows = await db.prepare("SELECT COUNT(*) AS total FROM mail_drafts").first();
		assert.equal(rows.total, 1);
		assert.deepEqual(await sentMessages(mf), []);
	});
});

test("send requires a credential bound to the current revision and sends at most once", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		const client = await connect(mf, "fixture-mail-writer");
		try {
			const created = await client.callTool({
				name: "whoyou_mail_draft_create",
				arguments: draftArgs(),
			});
			const draft = created.structuredContent.draft;

			const garbage = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: draft.draftId,
					confirmationCredential: "not-a-credential",
					idempotencyKey: "key-invalid-1",
				},
			});
			assert.equal(garbage.isError, true);
			assert.equal(garbage.structuredContent.error, "confirmation_invalid");

			const foreignAccount = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: draft.draftId,
					confirmationCredential: confirmation({
						draftId: draft.draftId,
						draftVersion: draft.version,
						contentHash: draft.contentHash,
						nonce: "nonce-foreign-account-01",
						overrides: { accountId: "account-b" },
					}),
					idempotencyKey: "key-foreign-1",
				},
			});
			assert.equal(foreignAccount.structuredContent.error, "confirmation_invalid");

			const wrongVersion = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: draft.draftId,
					confirmationCredential: confirmation({
						draftId: draft.draftId,
						draftVersion: draft.version + 1,
						contentHash: draft.contentHash,
						nonce: "nonce-wrong-version-01",
					}),
					idempotencyKey: "key-version-1",
				},
			});
			assert.equal(wrongVersion.structuredContent.error, "draft_version_mismatch");

			const wrongHash = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: draft.draftId,
					confirmationCredential: confirmation({
						draftId: draft.draftId,
						draftVersion: draft.version,
						contentHash: "f".repeat(64),
						nonce: "nonce-wrong-hash-001",
					}),
					idempotencyKey: "key-hash-1",
				},
			});
			assert.equal(wrongHash.structuredContent.error, "draft_content_changed");
			assert.deepEqual(await sentMessages(mf), []);

			const sent = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: draft.draftId,
					confirmationCredential: confirmation({
						draftId: draft.draftId,
						draftVersion: draft.version,
						contentHash: draft.contentHash,
						nonce: "nonce-valid-send-0001",
					}),
					idempotencyKey: "key-send-1",
				},
			});
			assert.equal(sent.isError, undefined);
			assert.equal(sent.structuredContent.alreadySent, false);
			assert.equal(sent.structuredContent.receipt.status, "sent");
			const outbox = await sentMessages(mf);
			assert.equal(outbox.length, 1);
			assert.equal(outbox[0].from, "alpha@tomlab.cn");
			assert.equal(outbox[0].to[0], "alice@example.com");

			const replay = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: draft.draftId,
					confirmationCredential: confirmation({
						draftId: draft.draftId,
						draftVersion: draft.version,
						contentHash: draft.contentHash,
						nonce: "nonce-valid-send-0001",
					}),
					idempotencyKey: "key-send-2",
				},
			});
			assert.equal(replay.isError, true);
			assert.equal(replay.structuredContent.error, "confirmation_replayed");
			assert.equal((await sentMessages(mf)).length, 1);

			const duplicate = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: draft.draftId,
					confirmationCredential: confirmation({
						draftId: draft.draftId,
						draftVersion: draft.version,
						contentHash: draft.contentHash,
						nonce: "nonce-fresh-send-0002",
					}),
					idempotencyKey: "key-send-1",
				},
			});
			assert.equal(duplicate.isError, undefined);
			assert.equal(duplicate.structuredContent.alreadySent, true);
			assert.equal(
				duplicate.structuredContent.receipt.receiptId,
				sent.structuredContent.receipt.receiptId,
			);
			assert.equal((await sentMessages(mf)).length, 1);

			const otherDraft = await client.callTool({
				name: "whoyou_mail_draft_create",
				arguments: draftArgs({ subject: "Second" }),
			});
			const reusedKey = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: otherDraft.structuredContent.draft.draftId,
					confirmationCredential: confirmation({
						draftId: otherDraft.structuredContent.draft.draftId,
						draftVersion: 1,
						contentHash: otherDraft.structuredContent.draft.contentHash,
						nonce: "nonce-other-draft-0003",
					}),
					idempotencyKey: "key-send-1",
				},
			});
			assert.equal(reusedKey.structuredContent.error, "idempotency_key_reused");
		} finally {
			await client.close();
		}

		const receipts = await db.prepare("SELECT COUNT(*) AS total FROM send_receipts").first();
		assert.equal(receipts.total, 1);
		const nonces = await db.prepare("SELECT COUNT(*) AS total FROM confirmation_nonces").first();
		assert.equal(nonces.total, 1);
	});
});

test("send arguments cannot override stored recipients or content", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		const client = await connect(mf, "fixture-mail-writer");
		try {
			const created = await client.callTool({
				name: "whoyou_mail_draft_create",
				arguments: draftArgs(),
			});
			const draft = created.structuredContent.draft;
			const override = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: draft.draftId,
					confirmationCredential: confirmation({
						draftId: draft.draftId,
						draftVersion: draft.version,
						contentHash: draft.contentHash,
						nonce: "nonce-override-attempt-1",
					}),
					idempotencyKey: "key-override-1",
					to: [{ name: "Mallory", address: "mallory@example.com" }],
					subject: "Overridden",
				},
			});
			assert.equal(override.isError, true);
			assert.deepEqual(await sentMessages(mf), []);
		} finally {
			await client.close();
		}
	});
});

test("a failing provider is reported as relay_unavailable and spends the credential", async () => {
	await withWorker({ MAIL_SEND_MODE: "failing" }, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		const client = await connect(mf, "fixture-mail-writer");
		try {
			const created = await client.callTool({
				name: "whoyou_mail_draft_create",
				arguments: draftArgs(),
			});
			const draft = created.structuredContent.draft;
			const payload = {
				draftId: draft.draftId,
				confirmationCredential: confirmation({
					draftId: draft.draftId,
					draftVersion: draft.version,
					contentHash: draft.contentHash,
					nonce: "nonce-provider-failure1",
				}),
				idempotencyKey: "key-failing-1",
			};
			const failed = await client.callTool({ name: "whoyou_mail_send", arguments: payload });
			assert.equal(failed.isError, true);
			assert.equal(failed.structuredContent.error, "relay_unavailable");

			const retry = await client.callTool({ name: "whoyou_mail_send", arguments: payload });
			assert.equal(retry.structuredContent.error, "confirmation_replayed");
		} finally {
			await client.close();
		}

		assert.deepEqual(await sentMessages(mf), []);
		const receipts = await db.prepare("SELECT COUNT(*) AS total FROM send_receipts").first();
		assert.equal(receipts.total, 0);
	});
});

test("a missing outbound binding fails closed before spending the credential", async () => {
	await withWorker({ MAIL_SEND_MODE: "missing" }, async ({ mf, db }) => {
		await seedTwoAccounts(db);
		const client = await connect(mf, "fixture-mail-writer");
		try {
			const created = await client.callTool({
				name: "whoyou_mail_draft_create",
				arguments: draftArgs(),
			});
			const draft = created.structuredContent.draft;
			const result = await client.callTool({
				name: "whoyou_mail_send",
				arguments: {
					draftId: draft.draftId,
					confirmationCredential: confirmation({
						draftId: draft.draftId,
						draftVersion: draft.version,
						contentHash: draft.contentHash,
						nonce: "nonce-missing-binding01",
					}),
					idempotencyKey: "key-missing-1",
				},
			});
			assert.equal(result.isError, true);
			assert.equal(result.structuredContent.error, "relay_unavailable");
		} finally {
			await client.close();
		}

		assert.deepEqual(await sentMessages(mf), []);
		const nonces = await db.prepare("SELECT COUNT(*) AS total FROM confirmation_nonces").first();
		assert.equal(nonces.total, 0);
	});
});
