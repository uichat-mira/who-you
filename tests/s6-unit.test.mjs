import { test } from "node:test";
import assert from "node:assert/strict";
import {
	authInfoFromPrincipal,
	decideLocalPart,
	LOCAL_PART_RULES,
	principalFromAuthInfo,
} from "../dist/unit.mjs";

test("a usable Cloud Auth username derives the mailbox prefix", () => {
	assert.deepEqual(decideLocalPart({ username: "Mira.User" }), {
		ok: true,
		localPart: "mira.user",
		source: "derived",
	});
	assert.deepEqual(decideLocalPart({ username: "  Alice  " }), {
		ok: true,
		localPart: "alice",
		source: "derived",
	});
});

test("an unusable or missing username asks for a prefix instead of generating one", () => {
	for (const username of [null, undefined, "", "   ", "王小明", "admin", "a--b", "a"]) {
		assert.deepEqual(
			decideLocalPart({ username }),
			{ ok: false, code: "local_part_required" },
			String(username),
		);
	}
});

test("an explicit prefix wins over the username and is validated strictly", () => {
	assert.deepEqual(
		decideLocalPart({ username: "mira", localPart: "Custom.Name" }),
		{ ok: true, localPart: "custom.name", source: "requested" },
	);
	assert.deepEqual(decideLocalPart({ localPart: "a" }), {
		ok: false,
		code: "invalid_local_part",
	});
	assert.deepEqual(decideLocalPart({ localPart: "a--b" }), {
		ok: false,
		code: "invalid_local_part",
	});
	assert.deepEqual(decideLocalPart({ localPart: "postmaster" }), {
		ok: false,
		code: "reserved_local_part",
	});
});

test("the rules text names every constraint the validator enforces", () => {
	for (const fragment of ["3–32", "lowercase", "reserved"]) {
		assert.ok(LOCAL_PART_RULES.includes(fragment), fragment);
	}
});

test("the username claim survives the SDK auth pass-through", () => {
	const base = {
		accountId: "account-c",
		consumerId: "consumer-4",
		scopes: ["whoyou.read"],
		expiresAt: 4_102_444_800,
		issuer: "mira:cloud-auth",
		audience: "mira:who-you",
	};
	const withName = principalFromAuthInfo(
		authInfoFromPrincipal("opaque-token", { ...base, username: "mira" }, new URL("https://127.0.0.1/mcp")),
	);
	assert.equal(withName.username, "mira");

	// A principal without the claim still authenticates; provisioning then asks.
	const anonymous = principalFromAuthInfo(
		authInfoFromPrincipal("opaque-token", base, new URL("https://127.0.0.1/mcp")),
	);
	assert.equal(anonymous.username, undefined);
});
