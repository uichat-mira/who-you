import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { handleRequest as appHandleRequest } from "../dist/app.mjs";
import {
	createFilesystemBucket,
	listObjectKeys,
} from "../dist/node/filesystem-bucket.mjs";
import { runMigrations } from "../dist/node/migrations.mjs";
import { createSqliteDatabase } from "../dist/node/sqlite-database.mjs";
import testEntry, { resetFixtureOutbox } from "../dist/test-worker.mjs";
import {
	MCP_TEST_AUDIENCE,
	MCP_TEST_ISSUER,
	MCP_TEST_JWKS_URL,
	MCP_TEST_RESOURCE_URL,
	MCP_TEST_SCOPE,
} from "../dist/fixtures.mjs";

/**
 * Shared Node harness for the integration suites. It replaces Miniflare with a
 * temporary directory, the production SQLite/filesystem ports and the production
 * migration runner, while keeping the `withWorker` / `mfFetch` / `connect`
 * surface the suites already use.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const NOW = 1_795_000_000_000;

/** Splits a migration file into the single statements the port accepts. */
export const migrationStatements = (filePath) =>
	readFileSync(filePath, "utf8")
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

const isStream = (value) =>
	typeof ReadableStream !== "undefined" && value instanceof ReadableStream;

const toRequest = (input, init) => {
	if (input instanceof Request && init === undefined) return input;
	const target =
		typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const headers = new Headers(init?.headers ?? undefined);
	const parsed = new URL(target);
	// The MCP SDK validates the Host header; a direct function dispatch has no
	// socket that would otherwise populate it for undici.
	if (!headers.has("host")) headers.set("host", parsed.host);
	const requestInit = { ...init, headers };
	if (isStream(init?.body) && requestInit.duplex === undefined) {
		requestInit.duplex = "half";
	}
	return new Request(target, requestInit);
};

export const mfFetch =
	(mf) =>
	async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		return mf.dispatchFetch(url, init);
	};

const bucketFacade = (bucket, dataDir) => ({
	put: async (key, value) => bucket.put(key, value),
	delete: async (keys) => bucket.delete(keys),
	get: async (key) => bucket.get(key),
	list: async ({ prefix = "" } = {}) => ({
		objects: listObjectKeys(dataDir, prefix).map((key) => ({ key })),
	}),
});

async function runWithRuntime(bindingsOrRun, maybeRun, dispatch) {
	const [extraBindings, run] =
		typeof bindingsOrRun === "function" ? [{}, bindingsOrRun] : [bindingsOrRun, maybeRun];
	const directory = mkdtempSync(path.join(tmpdir(), "whoyou-node-"));
	const dbPath = path.join(directory, "mail.db");
	const dataDir = path.join(directory, "data");
	const db = createSqliteDatabase(dbPath);
	const bucket = createFilesystemBucket(dataDir);
	resetFixtureOutbox();
	try {
		runMigrations(db.raw, path.resolve(process.cwd(), "migrations"));
		const env = {
			...BASE_BINDINGS,
			...extraBindings,
			DB: db,
			MAIL_BUCKET: bucket,
		};
		const mf = {
			dispatchFetch: async (input, init) => dispatch(toRequest(input, init), env),
			getR2Bucket: () => bucketFacade(bucket, dataDir),
		};
		await run({ mf, db, env, bucket, dataDir });
	} finally {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

/**
 * Boots the fixture entry with the full schema applied.
 * Accepts `withWorker(run)` or `withWorker(extraBindings, run)`.
 */
export async function withWorker(bindingsOrRun, maybeRun) {
	return runWithRuntime(
		bindingsOrRun,
		maybeRun,
		(request, env) => testEntry.fetch(request, env),
	);
}

/**
 * Boots the production platform entry (no fixture verifier or outbox injection)
 * so suites can prove the unconfigured/closed paths.
 * Accepts `withDeployedWorker(run)` or `withDeployedWorker(extraBindings, run)`.
 */
export async function withDeployedWorker(bindingsOrRun, maybeRun) {
	return runWithRuntime(
		bindingsOrRun,
		maybeRun,
		(request, env) => appHandleRequest(request, env),
	);
}

/**
 * Boots the production platform entry with only the bindings the caller passes,
 * without storage ports. This proves the deployed entry has no fixture fallback
 * and stays closed when nothing is configured.
 */
export async function withBareWorker(bindingsOrRun, maybeRun) {
	const [extraBindings, run] =
		typeof bindingsOrRun === "function" ? [{}, bindingsOrRun] : [bindingsOrRun, maybeRun];
	const env = { ...BASE_BINDINGS, ...extraBindings };
	const mf = {
		dispatchFetch: async (input, init) => appHandleRequest(toRequest(input, init), env),
	};
	await run({ mf, env });
}

export async function connect(mf, token, options = {}) {
	const { client } = await connectWithTransport(mf, token, options);
	return client;
}

export async function connectWithTransport(mf, token, options = {}) {
	const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_RESOURCE_URL), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
		fetch: mfFetch(mf),
	});
	const client = new Client(
		{ name: "who-node-test", version: "1.0.0" },
		options.versionNegotiation || options.supportedProtocolVersions
			? options
			: { ...options, versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(transport);
	return { client, transport };
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
