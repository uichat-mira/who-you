import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	SignJWT,
} from "jose";
import {
	CLOUD_AUTH_TOKEN_ISSUER,
	WHOYOU_REQUIRED_SCOPE,
	WHOYOU_SERVICE_AUDIENCE,
	createCloudAuthVerifier,
	principalFromAuthInfo,
	authInfoFromPrincipal,
	resolveMcpConfig,
} from "../dist/unit.mjs";

const AUDIENCE = WHOYOU_SERVICE_AUDIENCE;
const JWKS_URL = new URL("https://auth.example.com/.well-known/jwks.json");
const OTHER_KEY = await generateKeyPair("Ed25519");
const { publicKey, privateKey } = await generateKeyPair("Ed25519");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "EdDSA", use: "sig" };
const keySet = createLocalJWKSet({ keys: [publicJwk] });

const verifier = createCloudAuthVerifier({
	issuer: CLOUD_AUTH_TOKEN_ISSUER,
	audience: AUDIENCE,
	jwksUrl: JWKS_URL,
	consumerClaim: "consumer_id",
	keySet,
});

const NOW = Math.floor(Date.now() / 1000);

async function token(options = {}) {
	const {
		issuer = CLOUD_AUTH_TOKEN_ISSUER,
		audience = AUDIENCE,
		expiresAt = NOW + 3600,
		subject = "account-a",
		consumer = "consumer-1",
		scope = [WHOYOU_REQUIRED_SCOPE],
		key = privateKey,
	} = options;
	const payload = { scope };
	if (consumer !== null) payload.consumer_id = consumer;
	let signed = new SignJWT(payload)
		.setProtectedHeader({ alg: "EdDSA" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setExpirationTime(expiresAt);
	if (subject !== null) signed = signed.setSubject(subject);
	return signed.sign(key);
}

test("a valid Cloud Auth token yields only token-derived identity", async () => {
	const principal = await verifier.verifyAccessToken(await token());
	assert.equal(principal.accountId, "account-a");
	assert.equal(principal.consumerId, "consumer-1");
	assert.deepEqual(principal.scopes, [WHOYOU_REQUIRED_SCOPE]);
	assert.equal(principal.issuer, CLOUD_AUTH_TOKEN_ISSUER);
	assert.equal(principal.audience, AUDIENCE);
	assert.equal(principal.expiresAt, NOW + 3600);
});

test("standard space-delimited OAuth scope strings are recognized", async () => {
	const principal = await verifier.verifyAccessToken(
		await token({ scope: `${WHOYOU_REQUIRED_SCOPE} whoyou.ledger.write` }),
	);
	assert.deepEqual(principal.scopes, [WHOYOU_REQUIRED_SCOPE, "whoyou.ledger.write"]);
});

test("wrong issuer, audience, expiry, signature or identity is an opaque invalid_token", async () => {
	const cases = [
		["wrong issuer", { issuer: "mira:cloud-guanlan" }],
		["OAuth discovery URL is not the JWT issuer", { issuer: "https://auth.example.com" }],
		["wrong audience", { audience: "mira:cloud-guanlan" }],
		["expired", { expiresAt: NOW - 60 }],
		["missing exp", { expiresAt: undefined }],
		["missing subject", { subject: null }],
		["missing consumer claim", { consumer: null }],
		["empty consumer claim", { consumer: "" }],
		["foreign signing key", { key: OTHER_KEY.privateKey }],
		["malformed scope array", { scope: [WHOYOU_REQUIRED_SCOPE, 7] }],
	];
	for (const [name, options] of cases) {
		const candidate = options.expiresAt === undefined
			? await new SignJWT({ scope: [WHOYOU_REQUIRED_SCOPE], consumer_id: "consumer-1" })
				.setProtectedHeader({ alg: "EdDSA" })
				.setIssuer(CLOUD_AUTH_TOKEN_ISSUER)
				.setAudience(AUDIENCE)
				.setSubject("account-a")
				.sign(privateKey)
			: await token(options);
		await assert.rejects(verifier.verifyAccessToken(candidate), undefined, name);
	}
});

test("the SDK auth pass-through preserves verifier identity and rejects malformed auth info", async () => {
	const principal = await verifier.verifyAccessToken(await token());
	const authInfo = authInfoFromPrincipal(
		"opaque-token",
		principal,
		new URL("https://127.0.0.1/mcp"),
	);
	const restored = principalFromAuthInfo(authInfo);
	assert.equal(restored.accountId, principal.accountId);
	assert.equal(restored.consumerId, principal.consumerId);
	assert.deepEqual(restored.scopes, principal.scopes);
	await assert.rejects(async () => principalFromAuthInfo(undefined));
});

test("missing or malformed configuration stays closed", () => {
	assert.deepEqual(resolveMcpConfig({}), {
		ok: false,
		reason: "mcp_resource_url",
	});
	assert.deepEqual(
		resolveMcpConfig({
			MCP_RESOURCE_URL: "http://example.com/mcp",
			CLOUD_AUTH_ISSUER: "https://auth.example.com",
			CLOUD_AUTH_JWKS_URL: "https://auth.example.com/jwks.json",
			MCP_AUDIENCE: AUDIENCE,
		}),
		{ ok: false, reason: "mcp_resource_url" },
	);
	assert.deepEqual(
		resolveMcpConfig({
			MCP_RESOURCE_URL: "https://who.example.com/not-mcp",
			CLOUD_AUTH_ISSUER: "https://auth.example.com",
			CLOUD_AUTH_JWKS_URL: "https://auth.example.com/jwks.json",
			MCP_AUDIENCE: AUDIENCE,
		}),
		{ ok: false, reason: "mcp_resource_path" },
	);
	assert.deepEqual(
		resolveMcpConfig({
			MCP_RESOURCE_URL: "https://who.example.com/mcp",
			CLOUD_AUTH_ISSUER: "https://auth.example.com",
			CLOUD_AUTH_JWKS_URL: "https://auth.example.com/jwks.json",
			MCP_AUDIENCE: "mira:cloud-guanlan",
		}),
		{ ok: false, reason: "mcp_audience_not_who_you" },
	);
	assert.deepEqual(
		resolveMcpConfig({
			MCP_RESOURCE_URL: "https://who.example.com/mcp",
			CLOUD_AUTH_ISSUER: "https://auth.example.com",
			CLOUD_AUTH_JWKS_URL: "https://auth.example.com/jwks.json",
			MCP_AUDIENCE: AUDIENCE,
			MCP_REQUIRED_SCOPES: 'who"you',
		}),
		{ ok: false, reason: "mcp_required_scopes" },
	);
});

test("a complete binding set resolves the Who You resource boundary", () => {
	const resolved = resolveMcpConfig({
		MCP_RESOURCE_URL: "https://who.example.com/mcp",
		CLOUD_AUTH_ISSUER: "https://auth.example.com",
		CLOUD_AUTH_JWKS_URL: "https://auth.example.com/jwks.json",
		MCP_AUDIENCE: AUDIENCE,
	});
	assert.equal(resolved.ok, true);
	if (!resolved.ok) return;
	assert.equal(resolved.config.tokenIssuer, CLOUD_AUTH_TOKEN_ISSUER);
	assert.equal(resolved.config.issuer, "https://auth.example.com");
	assert.deepEqual(resolved.config.requiredScopes, [WHOYOU_REQUIRED_SCOPE]);
	assert.equal(resolved.config.consumerClaim, "consumer_id");
	assert.equal(
		resolved.config.metadataUrl,
		"https://who.example.com/.well-known/oauth-protected-resource/mcp",
	);
});
