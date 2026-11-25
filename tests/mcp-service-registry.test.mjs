import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
	BASE_BINDINGS,
	MIGRATIONS,
	mfFetch,
	NOW,
	seedMailbox,
	seedMessage,
} from "./workerd-harness.mjs";
import {
	MCP_TEST_JWKS_URL,
	MCP_TEST_RESOURCE_URL,
} from "../dist/fixtures.mjs";
import {
	WHOYOU_SERVICE_AUDIENCE,
	WHOYOU_SERVICE_DEFINITION,
	WHOYOU_SERVICE_PROTOCOL_VERSION,
} from "../dist/unit.mjs";

/**
 * T3 contract test for OPS-048: a registry-shaped, really EdDSA-signed service
 * bearer is verified by the deployed entry (`dist/worker.mjs`) through the
 * remote JWKS path, then used for real read-only MCP calls.
 *
 * The catalog/issuance object below is an in-test authority implementing the
 * OPS-047 semantics (account-scoped registration, revision, revocation and
 * offline expiry). It is NOT Cloud Auth and is NOT live interoperability or
 * T4 evidence. No real account, production database, key or mailbox is used.
 */

const TOKEN_ISSUER = "mira:cloud-auth";
const KEY_ID = "cloud-auth-key";
const DEVICE_ID = "fixture-device";
const TTL_SECONDS = 600;

const trusted = await generateKeyPair("Ed25519");
const rogue = await generateKeyPair("Ed25519");
const trustedJwk = {
	...(await exportJWK(trusted.publicKey)),
	kid: KEY_ID,
	alg: "EdDSA",
	use: "sig",
};

const NOTES_DEFINITION = {
	serviceId: "notes",
	projectId: "fixture",
	displayName: "Notes",
	protocol: {
		name: "mcp",
		version: "2025-11-25",
		endpoint: "https://notes.example/mcp",
	},
	audience: "mira:service:notes",
	scopes: ["service:notes:read"],
};

const registryError = (code) =>
	Object.assign(new Error(code), { code });

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Minimal OPS-047 authority double. It shares only the contract shape with
 * Cloud Auth; it cannot prove canonical Cloud Auth behavior.
 */
function createRegistryAuthority({ now = () => Date.now() } = {}) {
	const allowed = new Set();
	const accounts = new Map();

	const rowsFor = (accountId) => {
		let rows = accounts.get(accountId);
		if (!rows) {
			rows = new Map();
			accounts.set(accountId, rows);
		}
		return rows;
	};

	const allow = (accountId) => allowed.add(accountId);

	const register = (accountId, definition) => {
		if (!allowed.has(accountId)) {
			throw registryError("SERVICE_REGISTRATION_ACCOUNT_NOT_FOUND");
		}
		const rows = rowsFor(accountId);
		const existing = rows.get(definition.serviceId);
		const encoded = JSON.stringify(definition);
		if (existing && !existing.revoked && existing.encoded === encoded) {
			return existing.revision;
		}
		const revision = (existing?.revision ?? 0) + 1;
		rows.set(definition.serviceId, {
			definition: clone(definition),
			revision,
			revoked: false,
			encoded,
		});
		return revision;
	};

	const revoke = (accountId, serviceId, expectedRevision) => {
		const row = rowsFor(accountId).get(serviceId);
		if (!row) throw registryError("SERVICE_REGISTRATION_NOT_FOUND");
		if (row.revision !== expectedRevision) {
			throw registryError("SERVICE_REGISTRATION_CHANGED");
		}
		if (row.revoked) return row.revision;
		row.revision += 1;
		row.revoked = true;
		return row.revision;
	};

	const catalog = (accountId) =>
		[...(accounts.get(accountId)?.values() ?? [])]
			.filter((row) => !row.revoked)
			.sort((left, right) =>
				left.definition.serviceId.localeCompare(right.definition.serviceId),
			)
			.map((row) => ({
				definition: clone(row.definition),
				revision: row.revision,
			}));

	const issue = async (accountId, serviceId, expectedRevision, options = {}) => {
		const row = rowsFor(accountId).get(serviceId);
		if (!row || row.revoked) {
			throw registryError("SERVICE_REGISTRATION_NOT_FOUND");
		}
		if (row.revision !== expectedRevision) {
			throw registryError("SERVICE_REGISTRATION_CHANGED");
		}
		const issuedAt = Math.floor(now() / 1000);
		const expiresAtSeconds = issuedAt + (options.ttlSeconds ?? TTL_SECONDS);
		const deviceId = options.deviceId ?? DEVICE_ID;
		const token = await new SignJWT({
			scope: [...row.definition.scopes],
			device_id: deviceId,
			// Canonical Who You admits only the existing consumer claim. It is
			// derived from the verified account session, never from a request.
			...(row.definition.audience === WHOYOU_SERVICE_AUDIENCE
				? { consumer_id: accountId }
				: {}),
		})
			.setProtectedHeader({ alg: "EdDSA", kid: KEY_ID })
			.setIssuer(TOKEN_ISSUER)
			.setAudience(row.definition.audience)
			.setSubject(accountId)
			.setExpirationTime(expiresAtSeconds)
			.sign(trusted.privateKey);
		return {
			token,
			tokenType: "Bearer",
			audience: row.definition.audience,
			expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
			serviceId,
			revision: row.revision,
			claims: {
				accountId,
				deviceId,
				scopes: [...row.definition.scopes],
				expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
			},
		};
	};

	return { allow, register, revoke, catalog, issue };
}

async function signCustomToken({
	audience = WHOYOU_SERVICE_AUDIENCE,
	issuer = TOKEN_ISSUER,
	subject = "account-a",
	consumer = "account-a",
	scope = ["whoyou.read"],
	expiresIn = 3600,
	key = trusted.privateKey,
} = {}) {
	const payload = { scope: [...scope], device_id: DEVICE_ID };
	if (consumer !== null) payload.consumer_id = consumer;
	return new SignJWT(payload)
		.setProtectedHeader({ alg: "EdDSA", kid: KEY_ID })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject(subject)
		.setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
		.sign(key);
}

async function withDeployedWorker(run) {
	const authority = createRegistryAuthority();
	const mf = new Miniflare({
		modules: true,
		scriptPath: "dist/worker.mjs",
		compatibilityDate: "2026-08-06",
		cf: false,
		bindings: BASE_BINDINGS,
		d1Databases: ["DB"],
		r2Buckets: ["MAIL_BUCKET"],
		outboundService: async (request) => {
			if (request.url === MCP_TEST_JWKS_URL) {
				return Response.json({ keys: [trustedJwk] });
			}
			return new Response("not found", { status: 404 });
		},
	});
	try {
		const db = await mf.getD1Database("DB");
		await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
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
		await seedMessage(db, {
			id: "msg_a1",
			mailboxId: "mbx_a",
			accountId: "account-a",
			subject: "Alpha planning",
			receivedAt: NOW,
		});
		await seedMessage(db, {
			id: "msg_a2",
			mailboxId: "mbx_a",
			accountId: "account-a",
			subject: "Alpha follow-up",
			receivedAt: NOW + 1_000,
		});
		await seedMessage(db, {
			id: "msg_b1",
			mailboxId: "mbx_b",
			accountId: "account-b",
			subject: "Beta planning",
			receivedAt: NOW,
		});
		await run({ mf, db, authority });
	} finally {
		await mf.dispose();
	}
}

async function connect(mf, token, options = {}) {
	const transport = new StreamableHTTPClientTransport(
		new URL(MCP_TEST_RESOURCE_URL),
		{
			requestInit: { headers: { authorization: `Bearer ${token}` } },
			fetch: mfFetch(mf),
		},
	);
	const client = new Client(
		{ name: "registry-contract-test", version: "1.0.0" },
		options,
	);
	await client.connect(transport);
	return client;
}

async function rawToolsList(mf, token) {
	const response = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
	return response;
}

test("a registered account uses its registry ticket for real read-only MCP and stays inside its own mailbox", async () => {
	await withDeployedWorker(async ({ mf, authority }) => {
		authority.allow("account-a");
		authority.allow("account-b");
		assert.equal(authority.register("account-a", WHOYOU_SERVICE_DEFINITION), 1);

		const entry = authority.catalog("account-a")[0];
		assert.deepEqual(entry, {
			definition: WHOYOU_SERVICE_DEFINITION,
			revision: 1,
		});

		const credential = await authority.issue("account-a", "who-you", 1);
		assert.equal(credential.audience, "mira:who-you");
		assert.deepEqual(credential.claims.scopes, ["whoyou.read"]);

		const client = await connect(mf, credential.token, {
			supportedProtocolVersions: [WHOYOU_SERVICE_PROTOCOL_VERSION],
		});
		try {
			// The registry's declared protocol version is actually negotiable.
			assert.equal(
				client.getNegotiatedProtocolVersion(),
				WHOYOU_SERVICE_PROTOCOL_VERSION,
			);

			const whoami = await client.callTool({
				name: "whoyou_whoami",
				arguments: {},
			});
			assert.equal(whoami.isError, undefined);
			assert.equal(whoami.structuredContent.accountId, "account-a");
			assert.equal(whoami.structuredContent.consumerId, "account-a");
			assert.deepEqual(whoami.structuredContent.scopes, ["whoyou.read"]);

			const listed = await client.listTools();
			assert.ok(
				listed.tools.some((tool) => tool.name === "whoyou_mail_search"),
			);
			assert.ok(
				listed.tools.some((tool) => tool.name === "whoyou_mail_send"),
				"registration is not a second tool list",
			);

			const resources = await client.listResources();
			assert.ok(
				resources.resources.some(
					(resource) =>
						resource.uri === "mira://service/who-you/capabilities",
				),
			);
			const capabilities = await client.readResource({
				uri: "mira://service/who-you/capabilities",
			});
			assert.equal(
				JSON.parse(capabilities.contents[0].text).schema,
				"mira.service-capabilities/v1",
			);

			const mailbox = await client.callTool({
				name: "whoyou_mailbox_get",
				arguments: {},
			});
			assert.equal(mailbox.isError, undefined);
			assert.equal(mailbox.structuredContent.address, "alpha@tomlab.cn");

			const firstPage = await client.callTool({
				name: "whoyou_mail_search",
				arguments: { limit: 1 },
			});
			assert.equal(firstPage.isError, undefined);
			assert.equal(firstPage.structuredContent.messages.length, 1);
			assert.ok(firstPage.structuredContent.nextCursor);

			const secondPage = await client.callTool({
				name: "whoyou_mail_search",
				arguments: {
					limit: 1,
					cursor: firstPage.structuredContent.nextCursor,
				},
			});
			assert.equal(secondPage.isError, undefined);
			assert.equal(secondPage.structuredContent.messages.length, 1);
			assert.notEqual(
				secondPage.structuredContent.messages[0].id,
				firstPage.structuredContent.messages[0].id,
			);

			// The canonical read registration does not become write authority.
			const denied = await client.callTool({
				name: "whoyou_mail_flag_set",
				arguments: { messageId: "msg_a1", read: true },
			});
			assert.equal(denied.isError, true);
			assert.equal(denied.structuredContent.error, "insufficient_scope");
		} finally {
			await client.close();
		}

		// A second registered account is isolated even though it uses the exact
		// same service descriptor and endpoint.
		authority.register("account-b", WHOYOU_SERVICE_DEFINITION);
		const otherCredential = await authority.issue("account-b", "who-you", 1);
		const other = await connect(mf, otherCredential.token, {
			supportedProtocolVersions: [WHOYOU_SERVICE_PROTOCOL_VERSION],
		});
		try {
			const identity = await other.callTool({
				name: "whoyou_whoami",
				arguments: {},
			});
			assert.equal(identity.structuredContent.accountId, "account-b");
			assert.equal(identity.structuredContent.consumerId, "account-b");

			const mailbox = await other.callTool({
				name: "whoyou_mailbox_get",
				arguments: {},
			});
			assert.equal(mailbox.structuredContent.address, "beta@tomlab.cn");

			const alpha = await other.callTool({
				name: "whoyou_mail_search",
				arguments: { query: "Alpha" },
			});
			assert.deepEqual(alpha.structuredContent.messages, []);

			const foreign = await other.callTool({
				name: "whoyou_mail_message_get",
				arguments: { messageId: "msg_a1" },
			});
			assert.equal(foreign.isError, true);
			assert.equal(foreign.structuredContent.error, "message_not_found");
		} finally {
			await other.close();
		}
	});
});

test("an account without a business mailbox link receives an empty read surface, not another account's mail", async () => {
	await withDeployedWorker(async ({ mf, authority }) => {
		authority.allow("account-c");
		authority.register("account-c", WHOYOU_SERVICE_DEFINITION);
		const credential = await authority.issue("account-c", "who-you", 1);
		const client = await connect(mf, credential.token);
		try {
			const whoami = await client.callTool({
				name: "whoyou_whoami",
				arguments: {},
			});
			assert.equal(whoami.isError, undefined);
			assert.equal(whoami.structuredContent.accountId, "account-c");
			assert.equal(whoami.structuredContent.consumerId, "account-c");

			const mailbox = await client.callTool({
				name: "whoyou_mailbox_get",
				arguments: {},
			});
			assert.equal(mailbox.isError, true);
			assert.equal(
				mailbox.structuredContent.error,
				"mailbox_not_provisioned",
			);

			const identities = await client.callTool({
				name: "whoyou_mailbox_list",
				arguments: {},
			});
			assert.deepEqual(identities.structuredContent.identities, []);

			const search = await client.callTool({
				name: "whoyou_mail_search",
				arguments: {},
			});
			assert.deepEqual(search.structuredContent.messages, []);
		} finally {
			await client.close();
		}

		// No registration for this account: the registry refuses to mint a
		// credential rather than relying on the service endpoint to reject it.
		await assert.rejects(
			authority.issue("account-unregistered", "who-you", 1),
			(error) => error.code === "SERVICE_REGISTRATION_NOT_FOUND",
		);
	});
});

test("wrong audience, wrong account binding, forged, expired and consumer-less tickets are rejected", async () => {
	await withDeployedWorker(async ({ mf, authority }) => {
		authority.allow("account-a");
		authority.register("account-a", WHOYOU_SERVICE_DEFINITION);
		authority.register("account-a", NOTES_DEFINITION);
		const notesCredential = await authority.issue("account-a", "notes", 1);
		assert.equal(notesCredential.audience, "mira:service:notes");

		for (const [name, token] of [
			["another registered service", notesCredential.token],
			[
				"wrong audience",
				await signCustomToken({ audience: "mira:cloud-guanlan" }),
			],
			["foreign signature", await signCustomToken({ key: rogue.privateKey })],
			["expired", await signCustomToken({ expiresIn: -60 })],
			["missing consumer", await signCustomToken({ consumer: null })],
			["empty consumer", await signCustomToken({ consumer: "" })],
		]) {
			const response = await rawToolsList(mf, token);
			assert.equal(response.status, 401, name);
			const body = await response.text();
			assert.doesNotMatch(body, /whoyou_whoami|account-a/, name);
		}

		// Account data follows the verified subject, not a model- or token-supplied
		// consumer-looking label. The legitimate Mobile traversal would reject the
		// identity mismatch before executing a tool.
		const mismatched = await signCustomToken({
			subject: "account-b",
			consumer: "account-a",
		});
		const client = await connect(mf, mismatched, {
			supportedProtocolVersions: [WHOYOU_SERVICE_PROTOCOL_VERSION],
		});
		try {
			const whoami = await client.callTool({
				name: "whoyou_whoami",
				arguments: {},
			});
			assert.equal(whoami.structuredContent.accountId, "account-b");
			assert.equal(whoami.structuredContent.consumerId, "account-a");

			const mailbox = await client.callTool({
				name: "whoyou_mailbox_get",
				arguments: {},
			});
			assert.equal(mailbox.structuredContent.address, "beta@tomlab.cn");

			const foreign = await client.callTool({
				name: "whoyou_mail_message_get",
				arguments: { messageId: "msg_a1" },
			});
			assert.equal(foreign.structuredContent.error, "message_not_found");
		} finally {
			await client.close();
		}
	});
});

test("revocation stops registry renewal, keeps an already-issued offline ticket until expiry, and leaves other services registered", async () => {
	await withDeployedWorker(async ({ mf, authority }) => {
		authority.allow("account-a");
		authority.register("account-a", WHOYOU_SERVICE_DEFINITION);
		authority.register("account-a", NOTES_DEFINITION);
		const offline = await authority.issue("account-a", "who-you", 1);
		const notesBefore = await authority.issue("account-a", "notes", 1);

		assert.equal(authority.revoke("account-a", "who-you", 1), 2);
		assert.deepEqual(
			authority.catalog("account-a").map((entry) => entry.definition.serviceId),
			["notes"],
		);
		await assert.rejects(
			authority.issue("account-a", "who-you", 1),
			(error) => error.code === "SERVICE_REGISTRATION_NOT_FOUND",
		);
		await assert.rejects(
			authority.issue("account-a", "who-you", 2),
			(error) => error.code === "SERVICE_REGISTRATION_NOT_FOUND",
		);

		// OPS-047 offline expiry: revocation prevents future registry issuance but
		// does not instantly invalidate a bearer already held by this resource.
		const client = await connect(mf, offline.token, {
			supportedProtocolVersions: [WHOYOU_SERVICE_PROTOCOL_VERSION],
		});
		try {
			const whoami = await client.callTool({
				name: "whoyou_whoami",
				arguments: {},
			});
			assert.equal(whoami.isError, undefined);
			assert.equal(whoami.structuredContent.accountId, "account-a");
		} finally {
			await client.close();
		}

		// An unrelated service keeps its own active registration and credential.
		assert.ok(Date.parse(offline.expiresAt) > Date.now());
		assert.equal((await rawToolsList(mf, notesBefore.token)).status, 401);
		const notesAfter = await authority.issue("account-a", "notes", 1);
		assert.equal(notesAfter.audience, "mira:service:notes");
		assert.equal((await rawToolsList(mf, notesAfter.token)).status, 401);
	});
});
