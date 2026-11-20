import assert from "node:assert/strict";
import test from "node:test";
import { connect, seedMailbox, withWorker } from "./workerd-harness.mjs";
import { acceptEveryStage, createJob, seedJobMailbox } from "./s8-helpers.mjs";

/**
 * S8b: the job contract over MCP. Every call goes through `/mcp` with a fixture
 * bearer, so account scoping, stage gating and audit rows are exercised as the
 * worker really serves them. No network egress happens.
 */

const STAGE_TITLES = ["Research goal", "Work cadence", "Delivery and boundaries"];

const JOB_TOOLS = [
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

const call = (client, name, args) => client.callTool({ name, arguments: args });

const auditActions = async (db, accountId, jobId) => {
	const rows = await db
		.prepare(
			`SELECT action, detail FROM mail_audit_log
			 WHERE account_id = ? ${jobId ? "AND target_id = ?" : ""} ORDER BY created_at, id`,
		)
		.bind(...(jobId ? [accountId, jobId] : [accountId]))
		.all();
	return rows.results;
};

test("S8b: a job starts as a three-stage draft that only stage 1 can edit", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedJobMailbox(db);
		const client = await connect(mf, "fixture-mail-writer");

		const names = (await client.listTools()).tools.map((tool) => tool.name);
		for (const tool of JOB_TOOLS) assert.ok(names.includes(tool), `${tool} should be exposed`);

		const created = await createJob(client);
		assert.equal(errorCode(created), null, JSON.stringify(created.structuredContent));
		const jobId = created.structuredContent.jobId;
		assert.match(jobId, /^job_/);
		assert.equal(created.structuredContent.status, "draft");
		assert.deepEqual(
			created.structuredContent.stages.map((stage) => stage.status),
			["draft", "draft", "draft"],
		);

		const listed = await call(client, "whoyou_job_list", {});
		assert.equal(listed.structuredContent.jobs.length, 1);
		assert.equal(listed.structuredContent.jobs[0].id, jobId);

		const detail = await call(client, "whoyou_job_get", { jobId });
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
		const blocked = await call(client, "whoyou_job_stage_update", {
			jobId,
			stageNo: 2,
			body: "premature",
		});
		assert.equal(errorCode(blocked), "previous_stage_not_accepted");

		const updated = await call(client, "whoyou_job_stage_update", {
			jobId,
			stageNo: 1,
			body: "Watch AI products, models and independent developers.",
			settings: {
				scope: { folders: ["inbox"], keywords: ["ai"] },
				cadence: "daily",
				boundaries: { maxMessagesPerRun: 10 },
			},
		});
		assert.equal(errorCode(updated), null);
		assert.equal(updated.structuredContent.stage.version, 2);
		assert.deepEqual(updated.structuredContent.staleAnnotationIds, []);

		const rows = await auditActions(db, "account-a");
		assert.deepEqual(
			rows.map((row) => row.action),
			["job_create", "job_stage_update"],
		);
		for (const row of rows) {
			assert.doesNotMatch(row.detail, /alpha@|@tomlab|AI industry watch|independent developers/);
		}
	});
});

test("S8b: annotations gate acceptance and go stale when the body changes", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedJobMailbox(db);
		const client = await connect(mf, "fixture-mail-writer");
		const jobId = (await createJob(client)).structuredContent.jobId;

		const body = "# Goal\n\nWatch AI industry changes.";
		await call(client, "whoyou_job_stage_update", { jobId, stageNo: 1, body });

		// An anchor that does not match the current text is refused.
		const mismatched = await call(client, "whoyou_job_annotate", {
			jobId,
			stageNo: 1,
			body: "wrong anchor",
			anchorStart: 0,
			anchorEnd: 5,
			quote: "zzzzz",
		});
		assert.equal(errorCode(mismatched), "anchor_quote_mismatch");

		assert.equal(
			errorCode(await call(client, "whoyou_job_annotate", { jobId, stageNo: 1, body: "This stage is too broad." })),
			null,
		);
		assert.equal(
			errorCode(
				await call(client, "whoyou_job_annotate", {
					jobId,
					stageNo: 1,
					body: "Say which models matter.",
					anchorStart: 14,
					anchorEnd: 31,
					quote: "AI industry chang",
				}),
			),
			null,
		);

		// Two open annotations block acceptance.
		assert.equal(
			errorCode(await call(client, "whoyou_job_stage_accept", { jobId, stageNo: 1 })),
			"stage_has_open_annotations",
		);

		// A body change bumps the version and stales both open annotations.
		const revised = await call(client, "whoyou_job_stage_update", {
			jobId,
			stageNo: 1,
			body: `${body}\n\nFocus on open-source releases.`,
		});
		assert.equal(revised.structuredContent.stage.version, 3);
		assert.equal(revised.structuredContent.staleAnnotationIds.length, 2);

		const after = await call(client, "whoyou_job_get", { jobId });
		for (const annotation of after.structuredContent.annotations) {
			assert.equal(annotation.status, "stale");
		}

		// Stale annotations cannot be resolved.
		assert.equal(
			errorCode(
				await call(client, "whoyou_job_annotation_resolve", {
					jobId,
					annotationId: after.structuredContent.annotations[0].id,
				}),
			),
			"annotation_not_open",
		);

		// With nothing open, stage 1 accepts and the job moves to stage 2.
		const accepted = await call(client, "whoyou_job_stage_accept", { jobId, stageNo: 1 });
		assert.equal(accepted.structuredContent.status, "in_review");
		assert.equal(accepted.structuredContent.active, false);

		const detail = await call(client, "whoyou_job_get", { jobId });
		assert.equal(detail.structuredContent.stages[0].status, "accepted");
		assert.equal(detail.structuredContent.job.currentStage, 2);
	});
});

test("S8b: accepting the final stage activates only with long-term hosting", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedJobMailbox(db);
		const client = await connect(mf, "fixture-mail-writer");

		// Without long-term hosting the same three acceptances never activate.
		const ephemeral = (await createJob(client, { longTerm: false })).structuredContent.jobId;
		const ephemeralResults = await acceptEveryStage(client, ephemeral);
		assert.deepEqual(
			ephemeralResults.map((entry) => entry.status),
			["in_review", "in_review", "in_review"],
		);
		const ephemeralDetail = await call(client, "whoyou_job_get", { jobId: ephemeral });
		assert.equal(ephemeralDetail.structuredContent.job.status, "in_review");

		// Long-term hosting plus three acceptances does activate.
		const jobId = (await createJob(client)).structuredContent.jobId;
		await acceptEveryStage(client, jobId);
		const detail = await call(client, "whoyou_job_get", { jobId });
		assert.equal(detail.structuredContent.job.status, "active");

		// Pause blocks mail work; resume returns to active.
		assert.equal(
			(await call(client, "whoyou_job_pause", { jobId })).structuredContent.status,
			"paused",
		);
		assert.equal(errorCode(await call(client, "whoyou_job_pause", { jobId })), "job_not_active");
		assert.equal(
			(await call(client, "whoyou_job_resume", { jobId })).structuredContent.status,
			"active",
		);

		const actions = (await auditActions(db, "account-a", jobId)).map((row) => row.action);
		assert.ok(actions.includes("job_stage_accept"));
		assert.ok(actions.includes("job_pause"));
		assert.ok(actions.includes("job_resume"));
	});
});

test("S8b: jobs are account-scoped and write tools need the write scope", async () => {
	await withWorker({}, async ({ mf, db }) => {
		await seedJobMailbox(db);
		await seedMailbox(db, {
			id: "mbx_b",
			accountId: "account-b",
			address: "beta@tomlab.cn",
			localPart: "beta",
		});

		const writer = await connect(mf, "fixture-mail-writer");
		const jobId = (await createJob(writer)).structuredContent.jobId;

		// Another account cannot read the job.
		const other = await connect(mf, "fixture-account-b-writer");
		assert.equal(errorCode(await call(other, "whoyou_job_get", { jobId })), "job_not_found");

		// A read-only token cannot create a job.
		const reader = await connect(mf, "fixture-consumer-1");
		assert.equal(
			errorCode(await call(reader, "whoyou_job_create", { template: "digest", title: "nope" })),
			"insufficient_scope",
		);

		// An unknown mailbox id is refused rather than silently defaulted.
		assert.equal(errorCode(await createJob(writer, { mailboxId: "mbx_missing" })), "mailbox_not_found");

		// Unknown settings keys and out-of-range values are both rejected, at
		// input validation and at the domain rules respectively.
		for (const settings of [
			{ unknownKey: true },
			{ boundaries: { maxMessagesPerRun: 0 } },
			{ cadence: "sometimes" },
		]) {
			const rejected = await call(writer, "whoyou_job_stage_update", { jobId, stageNo: 1, settings });
			assert.equal(rejected.isError, true, JSON.stringify(settings));
			assert.equal(rejected.structuredContent?.stage, undefined);
		}

		// Templates are limited to the frozen set.
		const badTemplate = await call(writer, "whoyou_job_create", { template: "broadcast", title: "nope" });
		assert.equal(badTemplate.isError, true);
		assert.equal(badTemplate.structuredContent?.jobId, undefined);
	});
});
