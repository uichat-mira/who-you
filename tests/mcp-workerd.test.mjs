import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
	MCP_TEST_AUDIENCE,
	MCP_TEST_ISSUER,
	MCP_TEST_JWKS_URL,
	MCP_TEST_RESOURCE_URL,
	MCP_TEST_SCOPE,
} from "../dist/fixtures.mjs";

const FIXTURE_BINDINGS = {
	MCP_RESOURCE_URL: MCP_TEST_RESOURCE_URL,
	CLOUD_AUTH_ISSUER: MCP_TEST_ISSUER,
	CLOUD_AUTH_JWKS_URL: MCP_TEST_JWKS_URL,
	MCP_AUDIENCE: MCP_TEST_AUDIENCE,
	MCP_REQUIRED_SCOPES: MCP_TEST_SCOPE,
};

const MAIL_TOOL_NAMES = [
	"whoyou_whoami",
	"whoyou_mailbox_provision",
	"whoyou_mailbox_get",
	"whoyou_mail_search",
	"whoyou_mail_thread_get",
	"whoyou_mail_message_get",
	"whoyou_mail_attachment_get",
	"whoyou_mail_flag_set",
	"whoyou_job_create",
	"whoyou_job_list",
	"whoyou_job_get",
	"whoyou_job_stage_update",
	"whoyou_job_annotate",
	"whoyou_job_annotation_resolve",
	"whoyou_job_stage_accept",
	"whoyou_job_pause",
	"whoyou_job_resume",
	"whoyou_mail_draft_create",
	"whoyou_mail_draft_update",
	"whoyou_mail_draft_discard",
	"whoyou_mail_draft_get",
	"whoyou_mail_draft_list",
	"whoyou_mail_send",
	"whoyou_mailbox_list",
	"whoyou_mailbox_link",
	"whoyou_mailbox_unlink",
	"whoyou_mailbox_sync",
	"whoyou_mail_export",
	"whoyou_mail_message_delete",
	"whoyou_mail_mailbox_delete",
];

const READ_ONLY_TOOL_NAMES = new Set([
	"whoyou_whoami",
	"whoyou_mailbox_get",
	"whoyou_mailbox_list",
	"whoyou_mail_search",
	"whoyou_mail_thread_get",
	"whoyou_mail_message_get",
	"whoyou_mail_attachment_get",
	"whoyou_mail_draft_get",
	"whoyou_mail_draft_list",
	"whoyou_job_list",
	"whoyou_job_get",
]);

const DESTRUCTIVE_TOOL_NAMES = new Set([
	"whoyou_mail_draft_discard",
	"whoyou_mail_send",
	"whoyou_mailbox_unlink",
	"whoyou_mail_message_delete",
	"whoyou_mail_mailbox_delete",
]);

async function withWorker(scriptPath, bindings, run) {
	const mf = new Miniflare({
		modules: true,
		scriptPath,
		compatibilityDate: "2026-08-06",
		cf: false,
		bindings,
		// S1 requires D1 + R2 for `/mcp`; absent storage must stay fail-closed.
		d1Databases: ["DB"],
		r2Buckets: ["MAIL_BUCKET"],
	});
	try {
		await run({ mf });
	} finally {
		await mf.dispose();
	}
}

function disconnectedFetch(mf) {
	return async (input, init) => {
		const url = typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
		return mf.dispatchFetch(url, init);
	};
}

async function connect(mf, token, options = {}) {
	const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_RESOURCE_URL), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
		fetch: disconnectedFetch(mf),
	});
	const client = new Client({ name: "who-002-test", version: "1.0.0" }, options);
	await client.connect(transport);
	return { client, transport };
}

test("a real workerd modern MCP client lists and calls the read-only whoami tool", async () => {
	await withWorker("dist/test-worker.mjs", FIXTURE_BINDINGS, async ({ mf }) => {
		const { client, transport } = await connect(mf, "fixture-consumer-1", {
			versionNegotiation: { mode: { pin: "2026-07-28" } },
		});
		try {
			assert.equal(client.getProtocolEra(), "modern");
			assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
			assert.equal(transport.sessionId, undefined);

			const listed = await client.listTools();
			assert.deepEqual(listed.tools.map((tool) => tool.name), MAIL_TOOL_NAMES);
			// Read tools stay non-destructive; write/send tools must not claim read-only.
			for (const tool of listed.tools) {
				const readOnly = READ_ONLY_TOOL_NAMES.has(tool.name);
				const destructive = DESTRUCTIVE_TOOL_NAMES.has(tool.name);
				assert.equal(tool.annotations?.readOnlyHint, readOnly);
				assert.equal(tool.annotations?.destructiveHint, destructive);
			}

			const whoami = await client.callTool({ name: "whoyou_whoami", arguments: {} });
			assert.equal(whoami.isError, undefined);
			assert.equal(whoami.structuredContent.accountId, "account-a");
			assert.equal(whoami.structuredContent.consumerId, "consumer-1");
			assert.deepEqual(whoami.structuredContent.scopes, [MCP_TEST_SCOPE]);
			assert.match(whoami.content[0].text, /# Who You · caller identity/);

			// A model-supplied identity cannot override the token-derived principal.
			const spoofed = await client.callTool({
				name: "whoyou_whoami",
				arguments: { accountId: "account-b", consumerId: "consumer-2" },
			});
			assert.equal(spoofed.structuredContent.accountId, "account-a");
			assert.equal(spoofed.structuredContent.consumerId, "consumer-1");
		} finally {
			await client.close();
		}
	});
});

test("a real workerd client discovers the versioned capability resource and every named tool resolves", async () => {
	await withWorker("dist/test-worker.mjs", FIXTURE_BINDINGS, async ({ mf }) => {
		const { client } = await connect(mf, "fixture-consumer-1", {
			versionNegotiation: { mode: { pin: "2026-07-28" } },
		});
		try {
			const [listed, resourceList] = await Promise.all([
				client.listTools(),
				client.listResources(),
			]);
			const toolNames = listed.tools.map((tool) => tool.name);
			assert.deepEqual(toolNames, MAIL_TOOL_NAMES);

			const resource = resourceList.resources.find(
				(entry) => entry.uri === "mira://service/who-you/capabilities",
			);
			assert.ok(resource, "the capability resource must be discoverable");
			assert.equal(resource.mimeType, "application/json");
			assert.equal(resource.name, "who-you-service-capabilities");

			const read = await client.readResource({
				uri: "mira://service/who-you/capabilities",
			});
			assert.equal(read.contents.length, 1);
			const [content] = read.contents;
			assert.equal(content.uri, "mira://service/who-you/capabilities");
			assert.equal(content.mimeType, "application/json");
			assert.equal(typeof content.text, "string");

			const manifest = JSON.parse(content.text);
			assert.equal(manifest.schema, "mira.service-capabilities/v1");
			assert.equal(manifest.version, "1.0.0");
			assert.equal(manifest.service.id, "who-you");
			assert.equal(manifest.service.name, "Who You");
			assert.equal(manifest.service.mcp.serverName, "who-you");
			assert.equal(manifest.service.mcp.sdk, "@modelcontextprotocol/server@2.4.0");
			assert.deepEqual(manifest.service.mcp.protocolVersions, [
				"2026-07-28",
				"2025-11-25",
				"2025-06-18",
			]);

			const capabilityIds = manifest.capabilities.map((capability) => capability.id);
			assert.equal(new Set(capabilityIds).size, capabilityIds.length);
			const manifestTools = manifest.capabilities.flatMap(
				(capability) => capability.tools,
			);
			assert.equal(
				new Set(manifestTools).size,
				manifestTools.length,
				"each tool must appear in exactly one capability",
			);
			assert.deepEqual([...manifestTools].sort(), [...toolNames].sort());

			// No account, consumer, mailbox or bearer material may leak into the
			// shared manifest, and a second account sees exactly the same document.
			assert.doesNotMatch(
				content.text,
				/account-a|account-b|consumer-1|fixture|Bearer [A-Za-z0-9._-]+/,
			);
			const other = await connect(mf, "fixture-account-b", {
				versionNegotiation: { mode: { pin: "2026-07-28" } },
			});
			try {
				const otherRead = await other.client.readResource({
					uri: "mira://service/who-you/capabilities",
				});
				assert.equal(otherRead.contents[0].text, content.text);
			} finally {
				await other.client.close();
			}

			// Choosing a tool from the manifest still goes through the real
			// tools/call chain; the manifest creates no separate execution path.
			const identity = manifest.capabilities.find(
				(capability) => capability.id === "who-you.identity",
			);
			const chosen = identity.tools[0];
			assert.ok(toolNames.includes(chosen));
			const called = await client.callTool({ name: chosen, arguments: {} });
			assert.equal(called.isError, undefined);
			assert.equal(called.structuredContent.consumerId, "consumer-1");

			// An unsupported resource URI stays an explicit protocol error.
			await assert.rejects(
				client.readResource({ uri: "mira://service/who-you/unknown" }),
			);
		} finally {
			await client.close();
		}
	});
});

test("the capability resource sits behind the same bearer and scope gate as tools", async () => {
	await withWorker("dist/test-worker.mjs", FIXTURE_BINDINGS, async ({ mf }) => {
		const resourceEnvelope = {
			jsonrpc: "2.0",
			id: 1,
			method: "resources/read",
			params: { uri: "mira://service/who-you/capabilities" },
		};
		for (const [token, status] of [
			[null, 401],
			["fixture-forged", 401],
			["fixture-wrong-issuer", 401],
			["fixture-wrong-scope", 403],
		]) {
			const response = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(resourceEnvelope),
			});
			assert.equal(response.status, status, token ?? "anonymous");
			const body = await response.text();
			assert.doesNotMatch(body, /mira\.service-capabilities|whoyou_/);
		}
	});
});

test("real 2025-06-18 and 2025-11-25 initialize clients use the stateless legacy path", async () => {
	await withWorker("dist/test-worker.mjs", FIXTURE_BINDINGS, async ({ mf }) => {
		for (const version of ["2025-06-18", "2025-11-25"]) {
			const { client, transport } = await connect(mf, "fixture-consumer-2", {
				supportedProtocolVersions: [version],
			});
			try {
				assert.equal(client.getProtocolEra(), "legacy");
				assert.equal(client.getNegotiatedProtocolVersion(), version);
				assert.equal(transport.sessionId, undefined);
				const listed = await client.listTools();
				assert.equal(listed.tools.length, MAIL_TOOL_NAMES.length);
				const resources = await client.listResources();
				assert.ok(
					resources.resources.some(
						(resource) =>
							resource.uri === "mira://service/who-you/capabilities",
					),
				);
				const capability = await client.readResource({
					uri: "mira://service/who-you/capabilities",
				});
				assert.equal(
					JSON.parse(capability.contents[0].text).schema,
					"mira.service-capabilities/v1",
				);
				const whoami = await client.callTool({ name: "whoyou_whoami", arguments: {} });
				assert.equal(whoami.isError, undefined);
				assert.equal(whoami.structuredContent.consumerId, "consumer-2");
			} finally {
				await client.close();
			}
		}
	});
});

test("modern raw requests carry no session id and reject a missing Mcp-Method header", async () => {
	await withWorker("dist/test-worker.mjs", FIXTURE_BINDINGS, async ({ mf }) => {
		const envelope = {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "1" },
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		};
		const headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: "Bearer fixture-consumer-1",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": "tools/list",
		};
		const ok = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(envelope),
		});
		assert.equal(ok.status, 200);
		assert.equal(ok.headers.get("mcp-session-id"), null);
		assert.equal((await ok.json()).result.tools.length, MAIL_TOOL_NAMES.length);

		const missingHeaders = { ...headers };
		delete missingHeaders["Mcp-Method"];
		const missing = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
			method: "POST",
			headers: missingHeaders,
			body: JSON.stringify(envelope),
		});
		assert.equal(missing.status, 400);
		assert.equal((await missing.json()).error.code, -32020);
	});
});

test("unauthenticated and insufficient callers see 401 discovery but no tools or identity", async () => {
	await withWorker("dist/test-worker.mjs", FIXTURE_BINDINGS, async ({ mf }) => {
		const unauthorized = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		assert.equal(unauthorized.status, 401);
		assert.match(
			unauthorized.headers.get("www-authenticate"),
			/resource_metadata="https:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource\/mcp"/,
		);
		const body = await unauthorized.text();
		assert.doesNotMatch(body, /whoyou_whoami|account-a/);

		const metadata = await mf.dispatchFetch(
			"https://127.0.0.1/.well-known/oauth-protected-resource/mcp",
		);
		assert.equal(metadata.status, 200);
		const document = await metadata.json();
		assert.equal(document.resource, MCP_TEST_RESOURCE_URL);
		assert.deepEqual(document.authorization_servers, [MCP_TEST_ISSUER]);
		assert.deepEqual(document.scopes_supported, [MCP_TEST_SCOPE]);

		for (const [token, status] of [
			["fixture-wrong-issuer", 401],
			["fixture-wrong-audience", 401],
			["fixture-expired", 401],
			["fixture-missing-consumer", 401],
			["fixture-wrong-scope", 403],
		]) {
			const rejected = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
				method: "GET",
				headers: {
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${token}`,
				},
			});
			assert.equal(rejected.status, status, token);
		}
	});
});

test("RFC 9728 discovery serves cross-origin browsers while /mcp keeps its same-origin gate", async () => {
	await withWorker("dist/test-worker.mjs", FIXTURE_BINDINGS, async ({ mf }) => {
		const metadataUrl = "https://127.0.0.1/.well-known/oauth-protected-resource/mcp";
		const crossOrigin = { origin: "https://app.example" };

		const document = await mf.dispatchFetch(metadataUrl, { headers: crossOrigin });
		assert.equal(document.status, 200);
		assert.equal(document.headers.get("access-control-allow-origin"), "*");
		assert.deepEqual((await document.json()).authorization_servers, [MCP_TEST_ISSUER]);

		const preflight = await mf.dispatchFetch(metadataUrl, {
			method: "OPTIONS",
			headers: {
				...crossOrigin,
				"access-control-request-headers": "content-type",
			},
		});
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

		const blocked = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: "Bearer fixture-consumer-1",
				...crossOrigin,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		assert.equal(blocked.status, 403);
		assert.equal((await blocked.json()).error.code, -32000);

		const sameOrigin = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: "Bearer fixture-consumer-1",
				origin: "https://127.0.0.1",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		assert.equal(sameOrigin.status, 200);
	});
});

test("the deployed Worker has no fixture fallback and stays closed without bindings", async () => {
	await withWorker("dist/worker.mjs", {}, async ({ mf }) => {
		const closed = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: "Bearer fixture-consumer-1",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		assert.equal(closed.status, 503);
		assert.equal((await closed.json()).error, "mcp_not_configured");

		const metadata = await mf.dispatchFetch(
			"https://127.0.0.1/.well-known/oauth-protected-resource/mcp",
		);
		assert.equal(metadata.status, 503);

		const other = await mf.dispatchFetch("https://127.0.0.1/health");
		assert.equal(other.status, 404);
	});
});
