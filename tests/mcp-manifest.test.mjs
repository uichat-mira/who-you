import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	SERVICE_CAPABILITIES_MANIFEST,
	SERVICE_CAPABILITIES_MANIFEST_VERSION,
	SERVICE_CAPABILITIES_RESOURCE_MIME_TYPE,
	SERVICE_CAPABILITIES_RESOURCE_URI,
	SERVICE_CAPABILITIES_SCHEMA,
	SERVICE_CAPABILITIES_SCHEMA_VERSION,
	serializeServiceCapabilitiesManifest,
} from "../dist/unit.mjs";

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

const forbiddenKeys = new Set([
	"accountId",
	"consumerId",
	"address",
	"addresses",
	"mailboxId",
	"mailboxes",
	"messages",
	"token",
	"accessToken",
	"refreshToken",
	"credential",
	"confirmationCredential",
	"secret",
	"password",
	"body",
	"subject",
]);

function assertNoSensitiveKeys(value, path = "manifest") {
	if (Array.isArray(value)) {
		value.forEach((entry, index) => assertNoSensitiveKeys(entry, `${path}[${index}]`));
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, entry] of Object.entries(value)) {
		assert.equal(forbiddenKeys.has(key), false, `${path}.${key} must not be declared`);
		assertNoSensitiveKeys(entry, `${path}.${key}`);
	}
}

test("the service capability manifest is strict, versioned JSON with the fixed resource contract", () => {
	assert.equal(SERVICE_CAPABILITIES_RESOURCE_URI, "mira://service/who-you/capabilities");
	assert.equal(SERVICE_CAPABILITIES_RESOURCE_MIME_TYPE, "application/json");
	assert.equal(SERVICE_CAPABILITIES_SCHEMA_VERSION, "mira.service-capabilities/v1");
	assert.equal(SERVICE_CAPABILITIES_MANIFEST_VERSION, "1.0.0");

	const serialized = serializeServiceCapabilitiesManifest();
	const parsed = JSON.parse(serialized);
	assert.deepEqual(SERVICE_CAPABILITIES_SCHEMA.parse(parsed), SERVICE_CAPABILITIES_MANIFEST);
	assert.equal(serialized, JSON.stringify(SERVICE_CAPABILITIES_MANIFEST));
	assert.equal(SERVICE_CAPABILITIES_MANIFEST.schema, SERVICE_CAPABILITIES_SCHEMA_VERSION);
	assert.equal(SERVICE_CAPABILITIES_MANIFEST.version, SERVICE_CAPABILITIES_MANIFEST_VERSION);
	assert.equal(SERVICE_CAPABILITIES_MANIFEST.service.id, "who-you");
	assert.equal(SERVICE_CAPABILITIES_MANIFEST.service.mcp.serverName, "who-you");

	assert.throws(() =>
		SERVICE_CAPABILITIES_SCHEMA.parse({ ...parsed, unexpected: true }),
	);
	const [first] = parsed.capabilities;
	assert.throws(() =>
		SERVICE_CAPABILITIES_SCHEMA.parse({
			...parsed,
			capabilities: [{ ...first, tools: [], access: "admin" }],
		}),
	);
	assert.throws(() =>
		SERVICE_CAPABILITIES_SCHEMA.parse({
			...parsed,
			capabilities: [{ ...first, extra: "field" }],
		}),
	);
});

test("every registered tool is classified exactly once and read/write/send/destructive classes stay separate", () => {
	const capabilities = SERVICE_CAPABILITIES_MANIFEST.capabilities;
	assert.equal(capabilities.length, 17);
	const ids = capabilities.map((capability) => capability.id);
	assert.equal(new Set(ids).size, ids.length, "capability ids must be unique");

	const mapped = capabilities.flatMap((capability) => capability.tools);
	assert.equal(new Set(mapped).size, mapped.length, "a tool must map to one capability");
	assert.equal(mapped.length, 30, "currently 30 tools; the workerd test verifies exact runtime registration");

	const reads = new Set(
		capabilities
			.filter((capability) => capability.access === "read")
			.flatMap((capability) => capability.tools),
	);
	assert.deepEqual([...reads].sort(), [...READ_ONLY_TOOL_NAMES].sort());

	const writeTools = new Set(
		capabilities
			.filter((capability) => capability.access === "write")
			.flatMap((capability) => capability.tools),
	);
	const send = capabilities.find((capability) => capability.access === "send");
	const destructive = capabilities.filter(
		(capability) => capability.access === "destructive",
	);
	assert.ok(send, "a send capability is required");
	assert.deepEqual(send.tools, ["whoyou_mail_send"]);
	assert.equal(send.confirmation, "draft-credential");
	assert.deepEqual(
		destructive.flatMap((capability) => capability.tools).sort(),
		[
			"whoyou_mail_draft_discard",
			"whoyou_mail_mailbox_delete",
			"whoyou_mail_message_delete",
			"whoyou_mailbox_unlink",
		].sort(),
	);
	for (const tool of [...writeTools, ...send.tools]) {
		assert.equal(reads.has(tool), false, `${tool} must not be presented as read-only`);
	}

	const identityConfirmation = capabilities.find(
		(capability) => capability.id === "who-you.mailbox.link",
	);
	const mailboxErase = capabilities.find((capability) => capability.id === "who-you.mailbox.delete");
	assert.equal(mailboxErase.confirmation, "confirm-argument");
	assert.match(mailboxErase.description, /confirm: true/);
	assert.equal(identityConfirmation.confirmation, "identity-credential");
	assert.ok(
		identityConfirmation.requiredScopes.includes("whoyou.mail.write"),
		"identity linking must still require the write scope",
	);
	assert.ok(
		capabilities
			.find((capability) => capability.id === "who-you.mail.send")
			.requiredScopes.includes("whoyou.read"),
	);
});

test("the manifest carries no account, mail or credential fields and records the current SDK/protocol versions", () => {
	assertNoSensitiveKeys(SERVICE_CAPABILITIES_MANIFEST);

	const serialized = serializeServiceCapabilitiesManifest();
	assert.doesNotMatch(serialized, /account-a|consumer-1|fixture|Bearer [A-Za-z0-9._-]+/);
	assert.doesNotMatch(serialized, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);

	const packageJson = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.equal(
		SERVICE_CAPABILITIES_MANIFEST.service.mcp.sdk,
		`@modelcontextprotocol/server@${packageJson.dependencies["@modelcontextprotocol/server"]}`,
	);
	assert.deepEqual(SERVICE_CAPABILITIES_MANIFEST.service.mcp.protocolVersions, [
		"2026-07-28",
		"2025-11-25",
		"2025-06-18",
	]);
	assert.match(
		SERVICE_CAPABILITIES_MANIFEST.fallback.unknownSchema,
		/ignore this resource/i,
	);
	assert.match(
		SERVICE_CAPABILITIES_MANIFEST.fallback.unclassifiedTools,
		/keep every tools\/list entry visible/i,
	);
});
