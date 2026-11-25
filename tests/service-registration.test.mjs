import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	CLOUD_AUTH_TOKEN_ISSUER,
	SERVICE_CAPABILITIES_MANIFEST,
	WHOYOU_REQUIRED_SCOPE,
	WHOYOU_SERVICE_AUDIENCE,
	WHOYOU_SERVICE_DEFINITION,
	WHOYOU_SERVICE_DEFINITION_SCHEMA,
	WHOYOU_SERVICE_DISPLAY_NAME,
	WHOYOU_SERVICE_ID,
	WHOYOU_SERVICE_PROJECT_ID,
	WHOYOU_SERVICE_PROTOCOL_NAME,
	WHOYOU_SERVICE_PROTOCOL_VERSION,
	WHOYOU_SERVICE_REGISTRATION_ENDPOINT,
	buildWhoYouServiceDefinition,
	resolveMcpConfig,
	serializeWhoYouServiceDefinition,
} from "../dist/unit.mjs";

const DECLARATION_PATH = new URL(
	"../config/mira-service-registry/who-you.json",
	import.meta.url,
);

const readDeclaration = () => readFileSync(DECLARATION_PATH, "utf8");

test("the checked-in Mira ID registration declaration is the single secret-free Who You definition", () => {
	const serialized = readDeclaration();
	assert.equal(serialized, serializeWhoYouServiceDefinition());
	const parsed = WHOYOU_SERVICE_DEFINITION_SCHEMA.parse(JSON.parse(serialized));
	assert.deepEqual(parsed, WHOYOU_SERVICE_DEFINITION);

	assert.equal(parsed.serviceId, WHOYOU_SERVICE_ID);
	assert.equal(parsed.serviceId, "who-you");
	assert.equal(parsed.projectId, WHOYOU_SERVICE_PROJECT_ID);
	assert.equal(parsed.projectId, "who-you");
	assert.equal(parsed.displayName, WHOYOU_SERVICE_DISPLAY_NAME);
	assert.equal(parsed.protocol.name, WHOYOU_SERVICE_PROTOCOL_NAME);
	assert.equal(parsed.protocol.name, "mcp");
	assert.equal(parsed.protocol.version, WHOYOU_SERVICE_PROTOCOL_VERSION);
	assert.equal(parsed.protocol.endpoint, WHOYOU_SERVICE_REGISTRATION_ENDPOINT);
	assert.equal(parsed.audience, WHOYOU_SERVICE_AUDIENCE);
	assert.equal(parsed.audience, "mira:who-you");
	assert.deepEqual(parsed.scopes, [WHOYOU_REQUIRED_SCOPE]);
	assert.deepEqual(parsed.scopes, ["whoyou.read"]);

	// No account, mailbox, token, provider secret or mail content belongs in an
	// operator-visible registration declaration.
	assert.doesNotMatch(serialized, /Bearer [A-Za-z0-9._-]+/);
	assert.doesNotMatch(serialized, /token|secret|password|credential|account|mailbox/i);
	assert.doesNotMatch(
		serialized,
		/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
	);
});

test("the declaration is valid under the A1 serviceDefinitionSchema constraints", () => {
	const definition = JSON.parse(readDeclaration());

	assert.match(definition.serviceId, /^[a-z][a-z0-9-]{0,63}$/);
	assert.match(definition.projectId, /^[a-z][a-z0-9-]{0,63}$/);
	assert.equal(typeof definition.displayName, "string");
	assert.ok(definition.displayName.trim().length >= 1);
	assert.ok(definition.displayName.length <= 100);
	assert.match(definition.protocol.name, /^[a-z][a-z0-9-]{0,63}$/);
	assert.match(definition.protocol.version, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
	assert.ok(definition.protocol.endpoint.length <= 2048);

	const endpoint = new URL(definition.protocol.endpoint);
	assert.equal(endpoint.protocol, "https:");
	assert.equal(endpoint.hostname, "who-you.tomz.io");
	assert.equal(endpoint.pathname, "/mcp");
	assert.equal(endpoint.username, "");
	assert.equal(endpoint.password, "");
	assert.equal(endpoint.search, "");
	assert.equal(endpoint.hash, "");

	// A1 reserves the canonical Who You audience and grants only whoyou.read.
	assert.equal(definition.audience, "mira:who-you");
	assert.deepEqual(definition.scopes, ["whoyou.read"]);
	assert.equal(new Set(definition.scopes).size, definition.scopes.length);
	assert.equal(definition.scopes.length, 1);
});

test("the registration endpoint resolves as the current Worker /mcp resource and protocol is evidenced", () => {
	const resolved = resolveMcpConfig({
		MCP_RESOURCE_URL: WHOYOU_SERVICE_REGISTRATION_ENDPOINT,
		CLOUD_AUTH_ISSUER: "https://auth.example.com",
		CLOUD_AUTH_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
		MCP_AUDIENCE: WHOYOU_SERVICE_AUDIENCE,
	});
	assert.equal(resolved.ok, true);
	if (!resolved.ok) return;
	assert.equal(resolved.config.resourceUrl.href, WHOYOU_SERVICE_REGISTRATION_ENDPOINT);
	assert.equal(resolved.config.audience, "mira:who-you");
	assert.deepEqual(resolved.config.requiredScopes, ["whoyou.read"]);
	assert.equal(resolved.config.tokenIssuer, CLOUD_AUTH_TOKEN_ISSUER);

	assert.ok(
		SERVICE_CAPABILITIES_MANIFEST.service.mcp.protocolVersions.includes(
			WHOYOU_SERVICE_PROTOCOL_VERSION,
		),
		"the declared protocol revision must have repository compatibility evidence",
	);
	assert.equal(
		SERVICE_CAPABILITIES_MANIFEST.service.id,
		WHOYOU_SERVICE_DEFINITION.serviceId,
	);
});

test("unsafe or broader registration definitions are rejected before operator use", () => {
	for (const endpoint of [
		"http://who-you.tomz.io/mcp",
		"https://user:password@who-you.tomz.io/mcp",
		"https://who-you.tomz.io/mcp?token=1",
		"https://who-you.tomz.io/mcp#fragment",
		"https://who-you.tomz.io/not-mcp",
		"https://who-you.tomz.io/mcp ",
		"https://who-you.tomz.io\\mcp",
	]) {
		assert.throws(() => buildWhoYouServiceDefinition(endpoint), endpoint);
	}

	const baseline = JSON.parse(readDeclaration());
	for (const mutation of [
		{ ...baseline, audience: "mira:service:who-you" },
		{ ...baseline, audience: "mira:cloud-guanlan" },
		{ ...baseline, scopes: ["whoyou.read", "whoyou.mail.write"] },
		{ ...baseline, scopes: ["service:who-you:read"] },
		{ ...baseline, serviceId: "imposter" },
		{ ...baseline, projectId: "other" },
		{ ...baseline, extra: true },
		{
			...baseline,
			protocol: { ...baseline.protocol, version: "2024-01-01" },
		},
	]) {
		assert.throws(() => WHOYOU_SERVICE_DEFINITION_SCHEMA.parse(mutation));
	}

	// The Worker itself still refuses any audience other than Who You.
	assert.deepEqual(
		resolveMcpConfig({
			MCP_RESOURCE_URL: WHOYOU_SERVICE_REGISTRATION_ENDPOINT,
			CLOUD_AUTH_ISSUER: "https://auth.example.com",
			CLOUD_AUTH_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
			MCP_AUDIENCE: "mira:service:who-you",
		}),
		{ ok: false, reason: "mcp_audience_not_who_you" },
	);
});
