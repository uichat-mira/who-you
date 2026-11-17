import assert from "node:assert/strict";
import test from "node:test";
import { connect, seedMailbox, withWorker } from "./workerd-harness.mjs";

/**
 * S8b: the job contract over MCP. Every call goes through `/mcp` with a fixture
 * bearer, so account scoping, stage gating and audit rows are exercised as the
 * worker really serves them. No network egress happens.
 */

const STAGE_TITLES = ["Research goal", "Work cadence", "Delivery and boundaries"];

const jobTools = [
	"whoyou_job_create",
	"whoyou_job_list",
	"whoyou_job_get",
	"whoyou_job_stage_update",
	"whoyou_job_annotate",
	"whoyou_job_annotation_resolve",
	"whoyou_job_stage_accept",
	"whoyou_job_pause",
	"whoyou_job_resume",
];

const errorCode = (result) => result.structuredContent?.error ?? null;

const createJob = async (client, overrides = {}) => {
	const created = await client.callTool({
		name: "whoyou_job_create",
		arguments: { template: "digest", title: "AI industry watch", longTerm: true, ...overrides },
	});
	return created;
};

test("S8b: a job starts as a three-stage draft that only stage 1 can edit", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});
		const client = await connect(mf, "fixture-mail-writer");

		const names = (await client.listTools()).tools.map((tool) => tool.name);
		for (const tool of jobTools) {
			assert.ok(names.includes(tool), `${tool} should be exposed`);
		}

		const created = await createJob(client);
		assert.equal(created.structuredContent.error, undefined, JSON.stringify(created.structuredContent));
		const jobId = created.structuredContent.jobId;
		assert.match(jobId, /^job_/);
		assert.equal(created.structuredContent.status, "draft");
		assert.equal(created.structuredContent.stages.length, 3);
		assert.deepEqual(
			created.structuredContent.stages.map((stage) => stage.status),
			["draft", "draft", "draft"],
		);

		const listed = await client.callTool({ name: "whoyou_job_list", arguments: {} });
		assert.equal(listed.structuredContent.jobs.length, 1);
		assert.equal(listed.structuredContent.jobs[0].id, jobId);

		const detail = await client.callTool({
			name: "whoyou_job_get",
			arguments: { jobId },
		});
		assert.deepEqual(
			detail.structuredContent.stages.map((stage) => stage.title),
			STAGE_TITLES,
		);
		for (const stage of detail.structuredContent.stages) {
			assert.equal(stage.body.length > 0, true);
			assert.match(stage.contentHash, /^[0-9a-f]{64}$/);
			assert.equal(stage.version, 1);
		}

		// Stage 2 is not editable before stage 1 is accepted.
		const blocked = await client.callTool({
			name: "whoyou_job_stage_update",
			arguments: { jobId, stageNo: 2, body: "premature" },
		});
		assert.equal(errorCode(blocked), "previous_stage_not_accepted");

		// Stage 1 is editable.
		const updated = await client.callTool({
			name: "whoyou_job_stage_update",
			arguments: {
				jobId,
				stageNo: 1,
				body: "Watch AI products, models and independent developers.",
				settings: {
					scope: { folders: ["inbox"], keywords: ["ai"] },
					cadence: "daily",
					boundaries: { maxMessagesPerRun: 10 },
				},
			},
		});
		assert.equal(updated.structuredContent.error, undefined);
		assert.equal(updated.structuredContent.stage.version, 2);
		assert.deepEqual(updated.structuredContent.staleAnnotationIds, []);

		const audited = await db
			.prepare("SELECT action, detail FROM mail_audit_log WHERE account_id = ? ORDER BY created_at")
			.bind("account-a")
			.all();
		const actions = audited.results.map((row) => row.action);
		assert.deepEqual(actions, ["job_create", "job_stage_update"]);
		for (const row of audited.results) {
			assert.doesNotMatch(row.detail, /alpha@|@tomlab|AI industry watch|independent developers/);
		}
	});
});

test("S8b: annotations gate acceptance and go stale when the body changes", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});
		const client = await connect(mf, "fixture-mail-writer");
		const jobId = (await createJob(client)).structuredContent.jobId;

		const body = "# Goal\n\nWatch AI industry changes.";
		await client.callTool({
			name: "whoyou_job_stage_update",
			arguments: { jobId, stageNo: 1, body },
		});

		// An anchor that does not match the current text is refused.
		const mismatched = await client.callTool({
			name: "whoyou_job_annotate",
			arguments: { jobId, stageNo: 1, body: "wrong anchor", anchorStart: 0, anchorEnd: 5, quote: "zzzzz" },
		});
		assert.equal(errorCode(mismatched), "anchor_quote_mismatch");

		const stageWide = await client.callTool({
			name: "whoyou_job_annotate",
			arguments: { jobId, stageNo: 1, body: "This stage is too broad." },
		});
		assert.equal(stageWide.structuredContent.error, undefined);

		const anchored = await client.callTool({
			name: "whoyou_job_annotate",
			arguments: {
				jobId,
				stageNo: 1,
				body: "Say which models matter.",
				anchorStart: 14,
				anchorEnd: 31,
				quote: "AI industry chang",
			},
		});
		assert.equal(anchored.structuredContent.error, undefined);

		// Two open annotations block acceptance.
		const blocked = await client.callTool({
			name: "whoyou_job_stage_accept",
			arguments: { jobId, stageNo: 1 },
		});
		assert.equal(errorCode(blocked), "stage_has_open_annotations");

		// A body change bumps the version and stales both open annotations.
		const revised = await client.callTool({
			name: "whoyou_job_stage_update",
			arguments: { jobId, stageNo: 1, body: `${body}\n\nFocus on open-source releases.` },
		});
		assert.equal(revised.structuredContent.stage.version, 3);
		assert.equal(revised.structuredContent.staleAnnotationIds.length, 2);

		const after = await client.callTool({ name: "whoyou_job_get", arguments: { jobId } });
		for (const annotation of after.structuredContent.annotations) {
			assert.equal(annotation.status, "stale");
		}

		// Stale annotations cannot be resolved.
		const reopen = await client.callTool({
			name: "whoyou_job_annotation_resolve",
			arguments: { jobId, annotationId: after.structuredContent.annotations[0].id },
		});
		assert.equal(errorCode(reopen), "annotation_not_open");

		// With nothing open, stage 1 accepts.
		const accepted = await client.callTool({
			name: "whoyou_job_stage_accept",
			arguments: { jobId, stageNo: 1 },
		});
		assert.equal(accepted.structuredContent.status, "in_review");
		assert.equal(accepted.structuredContent.active, false);

		const detail = await client.callTool({ name: "whoyou_job_get", arguments: { jobId } });
		assert.equal(detail.structuredContent.stages[0].status, "accepted");
		assert.equal(detail.structuredContent.job.currentStage, 2);
	});
});

test("S8b: accepting the final stage activates only with long-term hosting", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedMailbox(db, {
			id: "mbx_a",
			accountId: "account-a",
			address: "alpha@tomlab.cn",
			localPart: "alpha",
		});
		const client = await connect(mf, "fixture-mail-writer");

		// Without long-term hosting the same three acceptances never activate.
		const ephemeral = (await createJob(client, { longTerm: false })).structuredContent.jobId;
		for (const stageNo of [1, 2, 3]) {
			const result = await client.callTool({
				name: "whoyou_job_stage_accept",
				arguments: { jobId: ephemeral, stageNo },
			});
			assert.equal(result.structuredContent.active, false, `stage ${stageNo} must not activate`);
		}
		const ephemeralDetail = await client.callTool({
			name: "whoyou_job_get",
			arguments: { jobId: ephemeral },
		});
		assert.equal(ephemeralDetail.structuralContent, undefined);
		assert.equal(ephemeralDetail.structuredContent.job.status, "in_review");

		// Long-term hosting plus three acceptances does activate.
		const jobId = (await createJob(client)).structuredContent.jobId;
		for (const stageNo of [1, 2, 3]) {
			const result = await client.callTool({
				name: "whoyou_job_stage_accept",
				arguments: { jobId, stageNo },
			});
			assert.equal(result.structuredContent.error, undefined, `stage ${stageNo}: ${JSON.stringify(result.structuredContent)}`);
			assert.equal(result.structuredContent.active, stageNo === 3);
		}
		const detail = await client.callTool({ name: "whoyou_job_get", arguments: { jobId } });
		assert.equal(detail.structuredContent.job.status, "active");

		// Pause blocks mail work; resume returns to active.
		const paused = await client.callTool({
			name: "whoyou_job_pause",
			arguments: { jobId },
		});
		assert.equal(paused.structuredContent.status, "paused");
		const pausedAgain = await client.callTool({
			name: "whoyou_job_pause",
			arguments: { jobId },
		});
		assert.equal(errorCode(pausedAgain), "job_not_active");

		const resumed = await client.callTool({
			name: "whoyou_job_resume",
			arguments: { jobId },
		});
		assert.equal(resumed.structuredContent.status, "active");

		const actions = (
			await db
				.prepare("SELECT action FROM mail_audit_log WHERE account_id = ? AND target_id = ?")
				.bind("account-a", jobId)
				.all()
		).results.map((row) => row.action);
		assert.ok(actions.includes("job_stage_accept"));
		assert.ok(actions.includes("job_pause"));
		assert.ok(actions.includes("job_resume"));
	});
});

test("S8b: jobs are account-scoped and write tools need the write scope", async () => {
	await withWorker({}, async ({ mf, db }) => {
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

		const writer = await connect(mf, "fixture-mail-writer");
		const jobId = (await createJob(writer)).structuredContent.jobId;

		// Another account cannot read or mutate the job.
		const other = await connect(mf, "fixture-account-b-writer");
		const otherDetail = await other.callTool({ name: "whoyou_job_get", arguments: { jobId } });
		assert.equal(errorCode(otherDetail), "job_not_found");

		// A read-only token cannot create a job.
		const reader = await connect(mf, "fixture-consumer-1");
		const denied = await reader.callTool({
			name: "whoyou_job_create",
			arguments: { template: "digest", title: "nope" },
		});
		assert.equal(errorCode(denied), "insufficient_scope");

		// An unknown mailbox id is refused rather than silently defaulted.
		const badMailbox = await createJob(writer, { mailboxId: "mbx_missing" });
		assert.equal(errorCode(badMailbox), "mailbox_not_found");

		// Settings with an unknown key are rejected at input validation, so the
		// caller never gets a silently-dropped boundary.
		const badSettings = await writer.callTool({
			name: "whoyou_job_stage_update",
			arguments: { jobId, stageNo: 1, settings: { unknownKey: true } },
		});
		assert.equal(badSettings.isError, true);
		assert.equal(badSettings.structuredContent?.stage, undefined);

		// An unsupported value inside a known key reaches the domain rules and
		// returns a fixed code instead.
		const badBoundary = await writer.callTool({
			name: "whoyou_job_stage_update",
			arguments: { jobId, stageNo: 1, settings: { boundaries: { maxMessagesPerRun: 0 } } },
		});
		assert.equal(badBoundary.isError, true);

		// Templates are limited to the frozen set.
		const badTemplate = await writer.callTool({
			name: "whoyou_job_create",
			arguments: { template: "broadcast", title: "nope" },
		});
		assert.equal(badTemplate.isError, true);
		assert.equal(badTemplate.structuredContent?.jobId, undefined);
	});
});
