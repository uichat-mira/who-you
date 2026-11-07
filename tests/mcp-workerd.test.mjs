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

async function withWorker(scriptPath, bindings, run) {
	const mf = new Miniflare({
		modules: true,
		scriptPath,
		compatibilityDate: "2026-08-06",
		cf: false,
		bindings,
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
			assert.deepEqual(listed.tools.map((tool) => tool.name), ["whoyou_whoami"]);
			// Mailbox tools do not exist yet; the only tool is a pure identity read.
			assert.equal(listed.tools[0].annotations?.readOnlyHint, true);
			assert.equal(listed.tools[0].annotations?.destructiveHint, false);

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
				assert.equal(listed.tools.length, 1);
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
		assert.equal((await ok.json()).result.tools.length, 1);

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
