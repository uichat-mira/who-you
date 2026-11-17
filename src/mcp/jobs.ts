import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MailServices } from "../mail/config";
import type { JobAnnotationRecord, JobRecord, JobStageRecord } from "../mail/job-store";
import {
	JOB_FAILURE_MESSAGES,
	acceptStage,
	annotate,
	createJob,
	resolveAnnotation,
	setJobPaused,
	updateStage,
	type JobFailure,
	type JobServiceDeps,
} from "../mail/job-service";
import { JOB_STAGE_COUNT, JOB_TEMPLATE_KEYS, type JobTemplateKey } from "../mail/job-state";
import type { AuditAction } from "../mail/store";
import type { WhoYouPrincipal } from "./auth";
import { failure, requireWriteScope, success, type ToolResult } from "./mail";

export const JOB_CREATE_TOOL = "whoyou_job_create";
export const JOB_LIST_TOOL = "whoyou_job_list";
export const JOB_GET_TOOL = "whoyou_job_get";
export const JOB_STAGE_UPDATE_TOOL = "whoyou_job_stage_update";
export const JOB_ANNOTATE_TOOL = "whoyou_job_annotate";
export const JOB_ANNOTATION_RESOLVE_TOOL = "whoyou_job_annotation_resolve";
export const JOB_STAGE_ACCEPT_TOOL = "whoyou_job_stage_accept";
export const JOB_PAUSE_TOOL = "whoyou_job_pause";
export const JOB_RESUME_TOOL = "whoyou_job_resume";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const WRITE_IDEMPOTENT = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const SAFE_ID = z.string().trim().min(1).max(80);
const STAGE_NO = z.number().int().min(1).max(JOB_STAGE_COUNT);

/**
 * Audit detail is a bounded machine summary. Stage numbers and counts only:
 * never an address, subject or requirement text.
 */
const jobAuditDetail = (action: string, stageNo?: number, extra?: string): string =>
	[`action=${action}`, stageNo === undefined ? null : `stage=${stageNo}`, extra ?? null]
		.filter(Boolean)
		.join(";");

const jobJson = (job: JobRecord): Record<string, unknown> => ({
	id: job.id,
	mailboxId: job.mailboxId,
	templateKey: job.templateKey,
	title: job.title,
	status: job.status,
	currentStage: job.currentStage,
	longTerm: job.longTerm,
	updatedAt: job.updatedAt,
});

const stageJson = (stage: JobStageRecord): Record<string, unknown> => ({
	stageNo: stage.stageNo,
	title: stage.title,
	status: stage.status,
	version: stage.version,
	contentHash: stage.contentHash,
	settings: stage.settings,
	bodyCharacters: stage.bodyMd.length,
	acceptedAt: stage.acceptedAt,
});

const annotationJson = (annotation: JobAnnotationRecord): Record<string, unknown> => ({
	id: annotation.id,
	stageNo: annotation.stageNo,
	stageVersion: annotation.stageVersion,
	status: annotation.status,
	anchorStart: annotation.anchorStart,
	anchorEnd: annotation.anchorEnd,
	quote: annotation.quote,
	body: annotation.body,
});

/**
 * Stage bodies are user-authored requirement text, not mail content, so they
 * are echoed back in full; the annotation `quote` is likewise a selection of
 * that same text.
 */
const renderStage = (stage: JobStageRecord): string =>
	[
		`## Stage ${stage.stageNo} · ${stage.title}`,
		`- status: ${stage.status}`,
		`- version: ${stage.version}`,
		`- hash: \`${stage.contentHash}\``,
		"",
		stage.bodyMd || "_(empty)_",
	].join("\n");

const renderJob = (
	job: JobRecord,
	stages: readonly JobStageRecord[],
	annotations: readonly JobAnnotationRecord[],
): string => {
	const lines = [
		`# Who You · job ${job.id}`,
		`- title: ${job.title}`,
		`- template: ${job.templateKey}`,
		`- status: ${job.status}`,
		`- current stage: ${job.currentStage} / ${JOB_STAGE_COUNT}`,
		`- long-term hosting: ${job.longTerm ? "requested" : "off"}`,
		"",
		...stages.map(renderStage),
	];
	const open = annotations.filter((entry) => entry.status === "open");
	lines.push("", `## Annotations · ${open.length} open of ${annotations.length}`);
	for (const annotation of annotations) {
		lines.push(
			`- \`${annotation.id}\` stage ${annotation.stageNo} v${annotation.stageVersion} [${annotation.status}] ${annotation.body}`,
		);
	}
	if (!annotations.length) lines.push("_No annotations._");
	lines.push(
		"",
		job.status === "active"
			? "This job is active; runs may prepare drafts but never send without a separate confirmation."
			: "This job is not active, so no run may send.",
	);
	return lines.join("\n");
};

const jobFailure = (result: JobFailure): ToolResult =>
	failure(result.code, JOB_FAILURE_MESSAGES[result.code]);

export function registerJobTools(
	server: McpServer,
	principal: WhoYouPrincipal,
	services: MailServices,
): void {
	const accountId = principal.accountId;
	const deps: JobServiceDeps = {
		jobs: services.jobs,
		findMailbox: async (owner, mailboxId) => {
			const mailbox = await services.repository.findMailboxById(owner, mailboxId);
			return mailbox ? { id: mailbox.id } : null;
		},
		findOwnMailbox: async (owner) => {
			const mailbox = await services.repository.findMailboxByAccount(owner);
			return mailbox ? { id: mailbox.id } : null;
		},
	};

	const audit = async (
		action: AuditAction,
		jobId: string,
		detail: string,
		now: number,
	): Promise<void> => {
		await services.repository.insertAudit({
			id: `audit_${crypto.randomUUID()}`,
			accountId,
			action,
			targetId: jobId,
			detail,
			createdAt: now,
		});
	};

	server.registerTool(
		JOB_CREATE_TOOL,
		{
			title: "Who You job create",
			description: `Creates a staged mail job for the caller's account. A job is a reviewable delegation, not a mailbox view: it holds three requirement stages, structured settings and versioned annotations. Nothing is sent while the job is not active. Templates: ${JOB_TEMPLATE_KEYS.join(", ")}. Stage 1 opens immediately; stages 2 and 3 unlock only after the previous stage is accepted. Identity comes from the bearer token; a mailbox id is validated against the same account.`,
			inputSchema: z.object({
				template: z.enum(["digest", "single", "followup"]),
				title: z.string().trim().min(1).max(200),
				mailboxId: SAFE_ID.optional(),
				longTerm: z.boolean().default(false),
			}),
			annotations: WRITE,
		},
		async (args) => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const now = Date.now();
			const created = await createJob(deps, {
				accountId,
				mailboxId: args.mailboxId ?? null,
				templateKey: args.template as JobTemplateKey,
				title: args.title,
				longTerm: args.longTerm,
				now,
			});
			if (!created.ok) return jobFailure(created);
			await audit("job_create", created.jobId, jobAuditDetail("create", 1, `template=${args.template}`), now);
			return success(
				[
					`# Who You · job created`,
					`- job: \`${created.jobId}\``,
					`- status: ${created.status}`,
					`- stages: ${created.stages.length} (only stage 1 is open)`,
					"",
					"Edit stage 1, then resolve its annotations and accept it to unlock stage 2.",
				].join("\n"),
				{ jobId: created.jobId, status: created.status, stages: created.stages.map(stageJson) },
			);
		},
	);

	server.registerTool(
		JOB_LIST_TOOL,
		{
			title: "Who You jobs",
			description:
				"Lists the caller's mail jobs, newest first, with status and stage progress. Metadata only; call whoyou_job_get for requirement text and annotations.",
			annotations: READ_ONLY,
		},
		async () => {
			const jobs = await services.jobs.listJobs(accountId);
			const lines = ["# Who You · jobs", `- count: ${jobs.length}`];
			for (const job of jobs) {
				lines.push(
					`- \`${job.id}\` ${job.status} · stage ${job.currentStage}/${JOB_STAGE_COUNT} · ${job.templateKey} · ${job.title}`,
				);
			}
			if (!jobs.length) lines.push("_No jobs yet._");
			return success(lines.join("\n"), { jobs: jobs.map(jobJson) });
		},
	);

	server.registerTool(
		JOB_GET_TOOL,
		{
			title: "Who You job",
			description:
				"Returns one job with all three stages, their structured settings and every annotation. Requirement text is the caller's own writing; it is never mail content.",
			inputSchema: z.object({ jobId: SAFE_ID }),
			annotations: READ_ONLY,
		},
		async (args) => {
			const job = await services.jobs.getJob(accountId, args.jobId);
			if (!job) {
				return failure("job_not_found", JOB_FAILURE_MESSAGES.job_not_found);
			}
			const stages = await services.jobs.listStages(job.id);
			const annotations = await services.jobs.listAnnotations(job.id);
			return success(renderJob(job, stages, annotations), {
				job: jobJson(job),
				stages: stages.map((stage) => ({ ...stageJson(stage), body: stage.bodyMd })),
				annotations: annotations.map(annotationJson),
			});
		},
	);

	server.registerTool(
		JOB_STAGE_UPDATE_TOOL,
		{
			title: "Who You job stage update",
			description:
				"Replaces a stage's requirement text and/or agreed settings. Every change increments the stage version and recomputes its content hash, which marks every unresolved annotation from the previous version stale. Settings accept only: mailboxId, scope{folders,senders,keywords}, cadence, deliver{mode,to}, boundaries{maxMessagesPerRun}; unknown keys are rejected.",
			inputSchema: z.object({
				jobId: SAFE_ID,
				stageNo: STAGE_NO,
				body: z.string().max(20_000).optional(),
				settings: z
					.object({
						mailboxId: z.string().trim().min(1).max(128).optional(),
						scope: z
							.object({
								folders: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
								senders: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
								keywords: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
							})
							.strict()
							.optional(),
						cadence: z.enum(["manual", "hourly", "daily", "weekly"]).optional(),
						deliver: z
							.object({
								mode: z.enum(["draft", "send"]),
								to: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
							})
							.strict()
							.optional(),
						boundaries: z
							.object({ maxMessagesPerRun: z.number().int().min(1).max(100).optional() })
							.strict()
							.optional(),
					})
					.strict()
					.optional(),
			}),
			annotations: WRITE,
		},
		async (args) => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const now = Date.now();
			const updated = await updateStage(deps, {
				accountId,
				jobId: args.jobId,
				stageNo: args.stageNo,
				body: args.body,
				settings: args.settings,
				now,
			});
			if (!updated.ok) return jobFailure(updated);
			await audit(
				"job_stage_update",
				args.jobId,
				jobAuditDetail(
					"stage_update",
					args.stageNo,
					`version=${updated.stage.version};stale=${updated.staleAnnotationIds.length}`,
				),
				now,
			);
			return success(
				[
					`# Who You · stage ${args.stageNo} updated`,
					`- version: ${updated.stage.version}`,
					`- hash: \`${updated.stage.contentHash}\``,
					`- stale annotations: ${updated.staleAnnotationIds.length}`,
				].join("\n"),
				{
					stage: stageJson(updated.stage),
					staleAnnotationIds: updated.staleAnnotationIds,
				},
			);
		},
	);

	server.registerTool(
		JOB_ANNOTATE_TOOL,
		{
			title: "Who You job annotate",
			description:
				"Adds an annotation to one stage. Omit anchorStart/anchorEnd for a stage-wide annotation; otherwise both offsets are required and `quote` must equal the exact requirement text they cover, so an annotation can never silently point at new text. Open annotations block stage acceptance.",
			inputSchema: z.object({
				jobId: SAFE_ID,
				stageNo: STAGE_NO,
				body: z.string().trim().min(1).max(2_000),
				anchorStart: z.number().int().min(0).optional(),
				anchorEnd: z.number().int().min(0).optional(),
				quote: z.string().max(500).optional(),
			}),
			annotations: WRITE,
		},
		async (args) => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const now = Date.now();
			const created = await annotate(deps, {
				accountId,
				jobId: args.jobId,
				stageNo: args.stageNo,
				anchorStart: args.anchorStart ?? null,
				anchorEnd: args.anchorEnd ?? null,
				quote: args.quote ?? "",
				body: args.body,
				now,
			});
			if (!created.ok) return jobFailure(created);
			await audit("job_annotate", args.jobId, jobAuditDetail("annotate", args.stageNo), now);
			return success(
				[
					"# Who You · annotation added",
					`- annotation: \`${created.annotationId}\``,
					`- stage version: ${created.stageVersion}`,
					"- resolve it before this stage can be accepted",
				].join("\n"),
				{ annotationId: created.annotationId, stageVersion: created.stageVersion },
			);
		},
	);

	server.registerTool(
		JOB_ANNOTATION_RESOLVE_TOOL,
		{
			title: "Who You job annotation resolve",
			description:
				"Marks one open annotation resolved. A stale annotation cannot be resolved: the requirement text it referred to has already changed.",
			inputSchema: z.object({ jobId: SAFE_ID, annotationId: SAFE_ID }),
			annotations: WRITE_IDEMPOTENT,
		},
		async (args) => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const now = Date.now();
			const resolved = await resolveAnnotation(deps, {
				accountId,
				jobId: args.jobId,
				annotationId: args.annotationId,
				now,
			});
			if (!resolved.ok) return jobFailure(resolved);
			await audit(
				"job_annotation_resolve",
				args.jobId,
				jobAuditDetail("annotation_resolve"),
				now,
			);
			return success("# Who You · annotation resolved", {
				annotationId: args.annotationId,
				status: "resolved",
			});
		},
	);

	server.registerTool(
		JOB_STAGE_ACCEPT_TOOL,
		{
			title: "Who You job stage accept",
			description:
				"Accepts the current stage, freezing its text and settings. Requires the previous stage accepted and zero open annotations. When the final stage is accepted while long-term hosting is enabled, the job becomes active; nothing was active before that point.",
			inputSchema: z.object({ jobId: SAFE_ID, stageNo: STAGE_NO }),
			annotations: WRITE_IDEMPOTENT,
		},
		async (args) => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const now = Date.now();
			const accepted = await acceptStage(deps, {
				accountId,
				jobId: args.jobId,
				stageNo: args.stageNo,
				now,
			});
			if (!accepted.ok) return jobFailure(accepted);
			await audit(
				"job_stage_accept",
				args.jobId,
				jobAuditDetail("stage_accept", args.stageNo, `status=${accepted.status}`),
				now,
			);
			return success(
				[
					`# Who You · stage ${args.stageNo} accepted`,
					`- job status: ${accepted.status}`,
					`- active: ${accepted.active ? "yes" : "no"}`,
				].join("\n"),
				{ status: accepted.status, active: accepted.active },
			);
		},
	);

	server.registerTool(
		JOB_PAUSE_TOOL,
		{
			title: "Who You job pause",
			description:
				"Pauses an active job. A paused job keeps its stages and history but cannot produce or send mail until it is resumed.",
			inputSchema: z.object({ jobId: SAFE_ID }),
			annotations: WRITE_IDEMPOTENT,
		},
		async (args) => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const now = Date.now();
			const paused = await setJobPaused(deps, {
				accountId,
				jobId: args.jobId,
				paused: true,
				now,
			});
			if (!paused.ok) return jobFailure(paused);
			await audit("job_pause", args.jobId, jobAuditDetail("pause"), now);
			return success("# Who You · job paused", { status: paused.status });
		},
	);

	server.registerTool(
		JOB_RESUME_TOOL,
		{
			title: "Who You job resume",
			description:
				"Resumes a paused job. Resuming does not re-open any accepted stage and does not create a send; the job returns to active.",
			inputSchema: z.object({ jobId: SAFE_ID }),
			annotations: WRITE_IDEMPOTENT,
		},
		async (args) => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			const now = Date.now();
			const resumed = await setJobPaused(deps, {
				accountId,
				jobId: args.jobId,
				paused: false,
				now,
			});
			if (!resumed.ok) return jobFailure(resumed);
			await audit("job_resume", args.jobId, jobAuditDetail("resume"), now);
			return success("# Who You · job resumed", { status: resumed.status });
		},
	);
}
