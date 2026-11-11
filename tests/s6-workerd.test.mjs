import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, seedMailbox, withWorker } from "./workerd-harness.mjs";

const TOOL = "whoyou_mailbox_provision";

const mailboxCount = async (db, accountId) => {
	const row = await db
		.prepare("SELECT COUNT(*) AS total FROM mailboxes WHERE account_id = ?")
		.bind(accountId)
		.first();
	return row.total;
};

test("first use derives the address from the Cloud Auth username exactly once", async () => {
	await withWorker({}, async ({ mf, db }) => {
		const client = await connect(mf, "fixture-username-writer");

		const first = await client.callTool({ name: TOOL, arguments: {} });
		assert.notEqual(first.isError, true);
		assert.equal(first.structuredContent.address, "mira.user@tomlab.cn");
		assert.equal(first.structuredContent.created, true);
		assert.equal(await mailboxCount(db, "account-c"), 1);

		const again = await client.callTool({ name: TOOL, arguments: {} });
		assert.notEqual(again.isError, true);
		assert.equal(again.structuredContent.address, "mira.user@tomlab.cn");
		assert.equal(again.structuredContent.created, false);
		assert.equal(again.structuredContent.mailboxId, first.structuredContent.mailboxId);
		assert.equal(await mailboxCount(db, "account-c"), 1);

		const audit = await db
			.prepare(
				"SELECT action, detail, target_id FROM mail_audit_log WHERE account_id = ? ORDER BY created_at",
			)
			.bind("account-c")
			.all();
		assert.equal(audit.results.length, 1);
		assert.equal(audit.results[0].action, "provision_mailbox");
		assert.equal(audit.results[0].detail, "derived");
		assert.equal(audit.results[0].target_id, first.structuredContent.mailboxId);
	});
});

test("an unusable username asks the user for a prefix instead of inventing one", async () => {
	await withWorker({}, async ({ mf, db }) => {
		const client = await connect(mf, "fixture-anonymous-writer");

		const asked = await client.callTool({ name: TOOL, arguments: {} });
		assert.equal(asked.isError, true);
		assert.equal(asked.structuredContent.error, "local_part_required");
		assert.match(asked.content[0].text, /localPart/);
		// A prompt is not a rejected attempt: nothing is allocated or audited.
		assert.equal(await mailboxCount(db, "account-d"), 0);
		const audits = await db
			.prepare("SELECT COUNT(*) AS total FROM mail_audit_log WHERE account_id = ?")
			.bind("account-d")
			.first();
		assert.equal(audits.total, 0);

		const chosen = await client.callTool({
			name: TOOL,
			arguments: { localPart: "Delta.Team" },
		});
		assert.notEqual(chosen.isError, true);
		assert.equal(chosen.structuredContent.address, "delta.team@tomlab.cn");
		assert.equal(chosen.structuredContent.created, true);

		const audit = await db
			.prepare("SELECT detail FROM mail_audit_log WHERE account_id = ?")
			.bind("account-d")
			.first();
		assert.equal(audit.detail, "requested");
	});
});

test("invalid, reserved and taken prefixes are reported without allocating an address", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});
		const client = await connect(mf, "fixture-anonymous-writer");

		const invalid = await client.callTool({ name: TOOL, arguments: { localPart: "a" } });
		assert.equal(invalid.structuredContent.error, "invalid_local_part");

		const reserved = await client.callTool({
			name: TOOL,
			arguments: { localPart: "postmaster" },
		});
		assert.equal(reserved.structuredContent.error, "reserved_local_part");

		const taken = await client.callTool({ name: TOOL, arguments: { localPart: "alpha" } });
		assert.equal(taken.structuredContent.error, "address_taken");
		assert.equal(await mailboxCount(db, "account-d"), 0);

		const audit = await db
			.prepare("SELECT detail FROM mail_audit_log WHERE account_id = ? ORDER BY created_at")
			.bind("account-d")
			.all();
		assert.deepEqual(
			audit.results.map((row) => row.detail),
			["invalid_local_part", "reserved_local_part", "address_taken"],
		);
	});
});

test("provisioning needs the write scope", async () => {
	await withWorker({}, async ({ mf, db }) => {
		const client = await connect(mf, "fixture-consumer-1");
		const denied = await client.callTool({ name: TOOL, arguments: { localPart: "reader" } });
		assert.equal(denied.isError, true);
		assert.equal(denied.structuredContent.error, "insufficient_scope");
		assert.equal(await mailboxCount(db, "account-a"), 0);
	});
});

test("mailbox_get points at the provisioning tool when nothing exists", async () => {
	await withWorker({}, async ({ mf }) => {
		const client = await connect(mf, "fixture-anonymous-writer");
		const result = await client.callTool({ name: "whoyou_mailbox_get", arguments: {} });
		assert.equal(result.structuredContent.error, "mailbox_not_provisioned");
		assert.match(result.content[0].text, /whoyou_mailbox_provision/);
	});
});
