import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/**
 * Exercises the deployed entry (`dist/worker.mjs`), not the fixture entry:
 * `createRemoteJWKSet` fetches Cloud Auth's JWKS inside workerd, the signature
 * is verified there, and the principal is derived from the token. Outbound
 * traffic is intercepted with Miniflare's `outboundService` so no test depends
 * on the real Cloud Auth host while the production fetch path still runs.
 */

const RESOURCE_URL = "https://127.0.0.1/mcp";
const METADATA_URL = "https://127.0.0.1/.well-known/oauth-protected-resource/mcp";
const OAUTH_ISSUER = "https://auth.example.com";
const JWKS_URL = "https://auth.example.com/.well-known/jwks.json";
const TOKEN_ISSUER = "mira:cloud-auth";
const AUDIENCE = "mira:who-you";
const SCOPE = "whoyou.read";

const BINDINGS = {
	MCP_RESOURCE_URL: RESOURCE_URL,
	CLOUD_AUTH_ISSUER: OAUTH_ISSUER,
	CLOUD_AUTH_JWKS_URL: JWKS_URL,
	MCP_AUDIENCE: AUDIENCE,
	MCP_REQUIRED_SCOPES: SCOPE,
};

const trusted = await generateKeyPair("Ed25519");
const rogue = await generateKeyPair("Ed25519");
const trustedJwk = {
	...(await exportJWK(trusted.publicKey)),
	kid: "cloud-auth-key",
	alg: "EdDSA",
	use: "sig",
};

async function signToken({
	key = trusted.privateKey,
	issuer = TOKEN_ISSUER,
	subject = "account-live",
	consumer = "consumer-live",
	expiresIn = 3600,
} = {}) {
	return new SignJWT({ scope: [SCOPE], consumer_id: consumer })
		.setProtectedHeader({ alg: "EdDSA", kid: "cloud-auth-key" })
		.setIssuer(issuer)
		.setAudience(AUDIENCE)
		.setSubject(subject)
		.setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
		.sign(key);
}

async function withDeployedWorker(run) {
	let jwksHits = 0;
	const mf = new Miniflare({
		modules: true,
		scriptPath: "dist/worker.mjs",
		compatibilityDate: "2026-08-06",
		cf: false,
		bindings: BINDINGS,
		outboundService: async (request) => {
			if (request.url === JWKS_URL) {
				jwksHits += 1;
				return Response.json({ keys: [trustedJwk] });
			}
			return new Response("not found", { status: 404 });
		},
	});
	try {
		return await run({ mf, jwksHits: () => jwksHits });
	} finally {
		await mf.dispose();
	}
}

const mfFetch = (mf) => async (input, init) => {
	const url = typeof input === "string"
		? input
		: input instanceof URL
			? input.href
			: input.url;
	return mf.dispatchFetch(url, init);
};

test("the deployed entry verifies a real MCP client through the remote JWKS path", async () => {
	await withDeployedWorker(async ({ mf, jwksHits }) => {
		const transport = new StreamableHTTPClientTransport(new URL(RESOURCE_URL), {
			requestInit: { headers: { authorization: `Bearer ${await signToken()}` } },
			fetch: mfFetch(mf),
		});
		const client = new Client(
			{ name: "remote-jwks-test", version: "1.0.0" },
			{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
		);
		await client.connect(transport);
		try {
			const whoami = await client.callTool({ name: "whoyou_whoami", arguments: {} });
			assert.equal(whoami.isError, undefined);
			assert.equal(whoami.structuredContent.accountId, "account-live");
			assert.equal(whoami.structuredContent.consumerId, "consumer-live");
			assert.deepEqual(whoami.structuredContent.scopes, [SCOPE]);
		} finally {
			await client.close();
		}
		assert.ok(jwksHits() >= 1, "the deployed verifier must fetch Cloud Auth JWKS");
	});
});

test("the deployed JWKS path rejects a foreign signature without trusting a fixture", async () => {
	await withDeployedWorker(async ({ mf, jwksHits }) => {
		const rejected = await mf.dispatchFetch(RESOURCE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${await signToken({ key: rogue.privateKey })}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		assert.equal(rejected.status, 401);
		const body = await rejected.text();
		assert.doesNotMatch(body, /whoyou_whoami|account-live|consumer-live/);
		assert.ok(jwksHits() >= 1, "the deployed verifier must fetch Cloud Auth JWKS");
	});
});

test("discovery advertises the OAuth issuer; tokens must carry the service issuer", async () => {
	await withDeployedWorker(async ({ mf }) => {
		const discovery = await mf.dispatchFetch(METADATA_URL, {
			headers: { origin: "https://app.example" },
		});
		assert.equal(discovery.status, 200);
		const document = await discovery.json();
		assert.equal(document.resource, RESOURCE_URL);
		assert.deepEqual(document.authorization_servers, [OAUTH_ISSUER]);
		assert.deepEqual(document.scopes_supported, [SCOPE]);

		// The discovery URL is an OAuth authorization server, not a JWT issuer.
		const wrongIssuer = await mf.dispatchFetch(RESOURCE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${await signToken({ issuer: OAUTH_ISSUER })}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		assert.equal(wrongIssuer.status, 401);

		const expired = await mf.dispatchFetch(RESOURCE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${await signToken({ expiresIn: -60 })}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		assert.equal(expired.status, 401);
	});
});
