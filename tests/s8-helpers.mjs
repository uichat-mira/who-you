import { seedMailbox } from "./workerd-harness.mjs";

/**
 * Shared fixtures for the S8 job suites. Stage scaffolding and acceptance are
 * ordinary tool calls, so both suites drive the same helper instead of copying
 * the same six-step setup; that keeps one definition of "a fully accepted job".
 */

/** Seeds the standard writable account mailbox used by the S8 scenarios. */
export async function seedJobMailbox(db, accountId = "account-a") {
	await seedMailbox(db, {
		id: "mbx_a",
		accountId,
		address: "alpha@tomlab.cn",
		localPart: "alpha",
	});
}

export async function createJob(client, overrides = {}) {
	const created = await client.callTool({
		name: "whoyou_job_create",
		arguments: {
			template: "digest",
			title: "AI industry watch",
			longTerm: true,
			...overrides,
		},
	});
	return created;
}

/** Accepts stages 1..3 in order and asserts each acceptance succeeded. */
export async function acceptEveryStage(client, jobId) {
	const accepted = [];
	for (const stageNo of [1, 2, 3]) {
		const result = await client.callTool({
			name: "whoyou_job_stage_accept",
			arguments: { jobId, stageNo },
		});
		if (result.structuredContent?.error) {
			throw new Error(`stage ${stageNo} not accepted: ${result.structuredContent.error}`);
		}
		accepted.push({ stageNo, status: result.structuredContent.status });
	}
	return accepted;
}

/** Creates a job, applies the given stage-1 settings and accepts all stages. */
export async function createActiveJob(client, settings) {
	const jobId = (await createJob(client)).structuredContent.jobId;
	if (settings) {
		const updated = await client.callTool({
			name: "whoyou_job_stage_update",
			arguments: { jobId, stageNo: 1, settings },
		});
		if (updated.structuredContent?.error) {
			throw new Error(`stage 1 update failed: ${updated.structuredContent.error}`);
		}
	}
	await acceptEveryStage(client, jobId);
	return jobId;
}
