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

/**
 * Shared workerd (Miniflare) harness for the integration suites: migrations,
 * bindings, a seeded two-account mailbox fixture and an MCP client wired to the
 * worker. Keeping it in one module stops each suite from re-declaring the same
 * fixture SQL and transport plumbing.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const NOW = 1_795_000_000_000;

/** Splits a D1 migration file into the single statements `batch()` accepts. */
export const migrationStatements = (path) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("--"))
		.join("\n")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);

export const MIGRATIONS = [
	...migrationStatements("migrations/0001_mail.sql"),
	...migrationStatements("migrations/0002_drafts_sends.sql"),
	...migrationStatements("migrations/0003_s3_state_search_retention.sql"),
	...migrationStatements("migrations/0004_deliverability_abuse.sql"),
	...migrationStatements("migrations/0005_mailbox_provisioning.sql"),
	...migrationStatements("migrations/0006_third_party_mailboxes.sql"),
	...migrationStatements("migrations/0007_provider_credentials.sql"),
	...migrationStatements("migrations/0008_gmail_identity.sql"),
	...migrationStatements("migrations/0009_imap_smtp_identity.sql"),
	...migrationStatements("migrations/0010_mail_jobs.sql"),
	...migrationStatements("migrations/0011_mail_job_audit.sql"),
];

export const BASE_BINDINGS = {
	MCP_RESOURCE_URL: MCP_TEST_RESOURCE_URL,
	CLOUD_AUTH_ISSUER: MCP_TEST_ISSUER,
	CLOUD_AUTH_JWKS_URL: MCP_TEST_JWKS_URL,
	MCP_AUDIENCE: MCP_TEST_AUDIENCE,
	MCP_REQUIRED_SCOPES: MCP_TEST_SCOPE,
	MAIL_DOMAIN: "tomlab.cn",
	MAIL_SIGNING_KEY: "s3-test-signing-key-0123456789abcdef",
	MAIL_INTERNAL_WEBHOOK_SECRET: "s4-test-webhook-secret-0123456789abcdef",
};

export const mfFetch =
	(mf) =>
	async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		return mf.dispatchFetch(url, init);
	};

/**
 * Boots the fixture entry with the full schema applied.
 * Accepts `withWorker(run)` or `withWorker(extraBindings, run)`.
 */
export async function withWorker(bindingsOrRun, maybeRun) {
	const [extraBindings, run] =
		typeof bindingsOrRun === "function" ? [{}, bindingsOrRun] : [bindingsOrRun, maybeRun];
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

export async function connect(mf, token, options = {}) {
	const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_RESOURCE_URL), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
		fetch: mfFetch(mf),
	});
	const client = new Client(
		{ name: "who-workerd-test", version: "1.0.0" },
		options.versionNegotiation
			? options
			: { ...options, versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(transport);
	return client;
}

export async function seedMailbox(db, options) {
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
			NOW,
			NOW,
		)
		.run();
}

export async function seedTwoAccounts(db) {
	for (const [suffix, accountId] of [
		["a", "account-a"],
		["b", "account-b"],
	]) {
		await seedMailbox(db, {
			id: `mbx_${suffix}`,
			accountId,
			address: `${suffix === "a" ? "alpha" : "beta"}@tomlab.cn`,
			localPart: suffix === "a" ? "alpha" : "beta",
		});
	}
}

/**
 * Inserts one visible inbound message with its thread, and keeps the mailbox
 * counters consistent. Shared so the suites do not each re-declare the same
 * 25-column INSERT; addresses and subjects stay synthetic.
 */
export async function seedMessage(db, options) {
	const mailboxId = options.mailboxId ?? "mbx_a";
	const accountId = options.accountId ?? "account-a";
	const threadId = options.threadId ?? `thr_${options.id}`;
	const state = options.state ?? "visible";
	const sizeBytes = options.sizeBytes ?? 100;
	const subject = options.subject ?? "Hello";
	const from = options.from ?? "alice@example.com";
	const receivedAt = options.receivedAt ?? NOW;

	await db
		.prepare(
			`INSERT INTO threads (id, mailbox_id, thread_key, root_message_id, last_message_at, message_count)
			 VALUES (?,?,?,NULL,?,1)`,
		)
		.bind(threadId, mailboxId, threadId, receivedAt)
		.run();
	await db
		.prepare(
			`INSERT INTO messages (
			 id, mailbox_id, thread_id, direction, internet_message_id, envelope_from, envelope_to,
			 from_json, to_json, cc_json, subject, from_text, search_text, sent_at, received_at,
			 size_bytes, snippet, attachment_count, auth_results, dmarc, state, quarantine_reason,
			 raw_key, text_key, html_key
			 ) VALUES (?,?,?, 'inbound', ?, ?, 'alpha@tomlab.cn', ?, '[]', '[]', ?, ?, ?, NULL, ?,
			 ?, ?, ?, 'spf=pass', 'pass', ?, NULL, ?, NULL, NULL)`,
		)
		.bind(
			options.id,
			mailboxId,
			threadId,
			`${options.id}@example.com`,
			from,
			JSON.stringify([{ name: "", address: from }]),
			subject,
			from,
			`${subject} ${options.bodyHint ?? "body"}`.toLowerCase(),
			receivedAt,
			sizeBytes,
			options.snippet ?? "snippet",
			options.attachmentCount ?? 0,
			state,
			`accounts/${accountId}/mailboxes/${mailboxId}/messages/${options.id}/raw.eml`,
		)
		.run();
	await db
		.prepare(
			`UPDATE mailboxes SET message_count = message_count + 1, bytes_used = bytes_used + ?,
			 quarantine_count = quarantine_count + ? WHERE id = ?`,
		)
		.bind(sizeBytes, state === "quarantined" ? 1 : 0, mailboxId)
		.run();
}
