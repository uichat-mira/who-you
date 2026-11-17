import assert from "node:assert/strict";
import test from "node:test";
import { encodeFixtureConfirmation } from "../dist/fixtures.mjs";
import { NOW, connect, seedMessage, withWorker } from "./workerd-harness.mjs";
import { createActiveJob, createJob, seedJobMailbox } from "./s8-helpers.mjs";

/**
 * S8c: the job gate on the existing tools. A tool without `jobId` keeps its old
 * behaviour; with one it can only ever lose access. No network egress happens.
 */

const seedTwoVisibleMessages = async (db) => {
	await seedMessage(db, { id: "msg_1", from: "boss@example.com", subject: "Budget" });
	await seedMessage(db, { id: "msg_2", from: "other@example.com", subject: "Newsletter" });
};

const searchErrors = async (client, args) =>
	(await client.callTool({ name: "whoyou_mail_search", arguments: args })).structuredContent;

test("S8c: an active job narrows search to its agreed scope", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedJobMailbox(db);
		await seedTwoVisibleMessages(db);
		const client = await connect(mf, "fixture-mail-writer");

		// Without a job the tool is unchanged: both senders are visible.
		const unscoped = await searchErrors(client, { folder: "inbox" });
		assert.equal(unscoped.error, undefined);
		assert.equal(unscoped.messages.length, 2);

		// A draft job cannot scope a read.
		const pendingJobId = (await createJob(client)).structuredContent.jobId;
		assert.equal((await searchErrors(client, { folder: "inbox", jobId: pendingJobId })).error, "job_not_active");

		const jobId = await createActiveJob(client, {
			scope: { folders: ["inbox"], senders: ["boss@example.com"] },
		});

		const scoped = await searchErrors(client, { folder: "inbox", jobId });
		assert.equal(scoped.error, undefined);
		assert.equal(scoped.messages.length, 1);
		assert.equal(scoped.messages[0].from[0].address, "boss@example.com");

		// A folder outside the agreed scope is refused rather than widened.
		assert.equal((await searchErrors(client, { folder: "trash", jobId })).error, "outside_job_scope");

		// Unknown job ids and other accounts are refused identically.
		assert.equal((await searchErrors(client, { folder: "inbox", jobId: "job_missing" })).error, "job_not_found");
		const other = await connect(mf, "fixture-account-b-writer");
		assert.equal((await searchErrors(other, { folder: "inbox", jobId })).error, "job_not_found");
	});
});

test("S8c: the boundary cap lowers the search limit", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedJobMailbox(db);
		for (let index = 1; index <= 4; index += 1) {
			await seedMessage(db, {
				id: `msg_${index}`,
				from: "boss@example.com",
				subject: `Note ${index}`,
				receivedAt: NOW - index * 1000,
			});
		}

		const client = await connect(mf, "fixture-mail-writer");
		const jobId = await createActiveJob(client, { boundaries: { maxMessagesPerRun: 2 } });

		const capped = await searchErrors(client, { folder: "inbox", limit: 20, jobId });
		assert.equal(capped.messages.length, 2);

		// Without the job the caller still gets the full page it asked for.
		const uncapped = await searchErrors(client, { folder: "inbox", limit: 20 });
		assert.equal(uncapped.messages.length, 4);
	});
});

test("S8c: a job gate blocks send while the job is not active", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedJobMailbox(db);
		const client = await connect(mf, "fixture-mail-writer");

		const draft = await client.callTool({
			name: "whoyou_mail_draft_create",
			arguments: { to: [{ name: "", address: "recipient@example.org" }], subject: "gated", text: "body" },
		});
		const draftId = draft.structuredContent.draft.draftId;
		const sendWith = (jobId, key) =>
			client.callTool({
				name: "whoyou_mail_send",
				arguments: { draftId, confirmationCredential: "not-a-credential", idempotencyKey: key, jobId },
			});

		// A draft job refuses the send before the confirmation is even examined.
		const pendingJobId = (await createJob(client)).structuredContent.jobId;
		assert.equal((await sendWith(pendingJobId, "idem-1")).structuredContent.error, "job_not_active");

		// Pausing an active job has the same effect.
		const jobId = await createActiveJob(client);
		await client.callTool({ name: "whoyou_job_pause", arguments: { jobId } });
		assert.equal((await sendWith(jobId, "idem-2")).structuredContent.error, "job_not_active");

		// Without a job id the tool still reaches its original draft-bound path.
		const ungated = await client.callTool({
			name: "whoyou_mail_send",
			arguments: { draftId, confirmationCredential: "not-a-credential", idempotencyKey: "idem-3" },
		});
		assert.notEqual(ungated.structuredContent.error, "job_not_active");
	});
});

test("S8c: a successful job-bound send records one run row without mail content", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedJobMailbox(db);
		const client = await connect(mf, "fixture-mail-writer");

		const created = (
			await client.callTool({
				name: "whoyou_mail_draft_create",
				arguments: {
					to: [{ name: "", address: "recipient@example.org" }],
					subject: "run recording",
					text: "body",
				},
			})
		).structuredContent.draft;

		const jobId = await createActiveJob(client);
		const sent = await client.callTool({
			name: "whoyou_mail_send",
			arguments: {
				draftId: created.draftId,
				confirmationCredential: encodeFixtureConfirmation({
					accountId: "account-a",
					actor: "user",
					draftId: created.draftId,
					draftVersion: created.version,
					contentHash: created.contentHash,
					nonce: "nonce-s8c-run-0001",
				}),
				idempotencyKey: "key-s8c-run-1",
				jobId,
			},
		});
		assert.equal(sent.structuredContent.error, undefined, JSON.stringify(sent.structuredContent));

		const runs = await db
			.prepare("SELECT run_no, status, reason_code FROM mail_job_runs WHERE job_id = ?")
			.bind(jobId)
			.all();
		assert.equal(runs.results.length, 1);
		assert.equal(runs.results[0].run_no, 1);
		assert.equal(runs.results[0].status, "succeeded");
		assert.equal(runs.results[0].reason_code, null);
	});
});
