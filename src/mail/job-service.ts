import type { JobRepository, JobStageRecord } from "./job-store";
import {
	JOB_STAGE_COUNT,
	canAcceptStage,
	canActivateJob,
	canEditStage,
	countOpenAnnotations,
	deriveJobStatus,
	normalizeAgreedSettings,
	normalizeStageBody,
	stageContentHash,
	staleAnnotationsForVersion,
	validateAnnotationAnchor,
	type AgreedSettings,
	type JobStatus,
	type JobTemplateKey,
} from "./job-state";

/**
 * S8b orchestration for the mail job contract.
 *
 * Each operation loads the current rows, asks the pure rules in `job-state.ts`
 * for a verdict, and only then writes. Nothing here logs, and every failure is
 * one of the fixed codes below, so a caller can branch without parsing prose.
 */

export type JobFailureCode =
	| "job_not_found"
	| "mailbox_not_found"
	| "invalid_template"
	| "invalid_title"
	| "stage_out_of_range"
	| "previous_stage_not_accepted"
	| "stage_already_accepted"
	| "stage_has_open_annotations"
	| "stage_body_invalid"
	| "stage_body_too_long"
	| "agreed_settings_invalid"
	| "anchor_out_of_range"
	| "anchor_quote_mismatch"
	| "annotation_body_invalid"
	| "annotation_not_found"
	| "annotation_not_open"
	| "job_not_active"
	| "job_already_active"
	| "long_term_requires_final_acceptance";

export type JobFailure = { ok: false; code: JobFailureCode };

export const JOB_FAILURE_MESSAGES: Record<JobFailureCode, string> = {
	job_not_found: "No such job exists for this account.",
	mailbox_not_found: "The mailbox does not belong to this account.",
	invalid_template: "The template must be one of digest, single or followup.",
	invalid_title: "The title must be plain text between 1 and 200 characters.",
	stage_out_of_range: "Stages are numbered 1 to 3.",
	previous_stage_not_accepted: "Accept the previous stage before editing or accepting this one.",
	stage_already_accepted: "This stage is already accepted.",
	stage_has_open_annotations: "Resolve every open annotation before accepting this stage.",
	stage_body_invalid: "The requirement text must not contain control characters.",
	stage_body_too_long: "The requirement text is too long for one stage.",
	agreed_settings_invalid: "The agreed settings contain an unsupported key or value.",
	anchor_out_of_range: "The annotation anchor does not match the current requirement text.",
	anchor_quote_mismatch: "The quoted text no longer matches the requirement body.",
	annotation_body_invalid: "The annotation body is empty, too long or contains control characters.",
	annotation_not_found: "No such annotation exists on this job.",
	annotation_not_open: "Only an open annotation can be resolved.",
	job_not_active: "The job is not active, so this run cannot proceed.",
	job_already_active: "The job is already active.",
	long_term_requires_final_acceptance:
		"Activation requires every stage accepted and long-term hosting enabled.",
};

const MAX_TITLE_CHARS = 200;

const fail = (code: JobFailureCode): JobFailure => ({ ok: false, code });

/**
 * Default stage scaffolding per template. These are starting points the user
 * edits; nothing is inferred from mail content here.
 */
export const STAGE_DEFAULTS: Record<
	JobTemplateKey,
	readonly { title: string; body: string }[]
> = {
	digest: [
		{
			title: "Research goal",
			body: "Describe what this mail job should notice, and what it should leave to you.\n\nState the senders, folders and keywords that define the scope, and the judgement you want to keep for yourself.",
		},
		{
			title: "Work cadence",
			body: "Describe how often this job should look for new mail, and how much it may read per run.\n\nA run never sends on its own; it prepares a draft for you.",
		},
		{
			title: "Delivery and boundaries",
			body: "Describe what a finished run produces and what it must never do.\n\nLong-term hosting only starts after you accept this stage.",
		},
	],
	single: [
		{
			title: "Request",
			body: "Describe the one mail task you want completed, and the messages it may read.",
		},
		{
			title: "Timing",
			body: "Describe when this task should run and when it stops being useful.",
		},
		{
			title: "Delivery and boundaries",
			body: "Describe what the result looks like and what must never happen.",
		},
	],
	followup: [
		{
			title: "Follow-up scope",
			body: "Describe the conversation you want followed up and the point at which a reply is expected.",
		},
		{
			title: "Reminders",
			body: "Describe how often to check and when to remind you.",
		},
		{
			title: "Delivery and boundaries",
			body: "Describe what a reminder contains and what it must never do.",
		},
	],
};

const normalizeTitle = (raw: string): string | null => {
	const title = raw.replace(/\r\n?/g, " ").replace(/\s+/g, " ").trim();
	if (!title || title.length > MAX_TITLE_CHARS) return null;
	for (const character of title) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) return null;
	}
	return title;
};

export type JobServiceDeps = {
	jobs: JobRepository;
	findMailbox(accountId: string, mailboxId: string): Promise<{ id: string } | null>;
	/** Defaults to the account's own mailbox when the caller omits one. */
	findOwnMailbox(accountId: string): Promise<{ id: string } | null>;
};

export type CreatedJob = {
	ok: true;
	jobId: string;
	status: JobStatus;
	longTerm: boolean;
	stages: JobStageRecord[];
};

export async function createJob(
	deps: JobServiceDeps,
	input: {
		accountId: string;
		mailboxId?: string | null;
		templateKey: JobTemplateKey;
		title: string;
		longTerm: boolean;
		now: number;
	},
): Promise<CreatedJob | JobFailure> {
	if (!(input.templateKey in STAGE_DEFAULTS)) return fail("invalid_template");
	const title = normalizeTitle(input.title);
	if (!title) return fail("invalid_title");

	const mailbox = input.mailboxId
		? await deps.findMailbox(input.accountId, input.mailboxId)
		: await deps.findOwnMailbox(input.accountId);
	if (!mailbox) return fail("mailbox_not_found");

	const jobId = `job_${crypto.randomUUID()}`;
	await deps.jobs.createJob({
		id: jobId,
		accountId: input.accountId,
		mailboxId: mailbox.id,
		templateKey: input.templateKey,
		title,
		now: input.now,
	});
	if (input.longTerm) {
		await deps.jobs.updateJobState(input.accountId, jobId, {
			longTerm: true,
			now: input.now,
		});
	}

	const defaults = STAGE_DEFAULTS[input.templateKey];
	for (let index = 0; index < JOB_STAGE_COUNT; index += 1) {
		const stage = defaults[index];
		const body = normalizeStageBody(stage?.body ?? "");
		const contentHash = await stageContentHash(body.ok ? body.body : "", {});
		await deps.jobs.insertStage({
			jobId,
			stageNo: index + 1,
			title: stage?.title ?? `Stage ${index + 1}`,
			bodyMd: body.ok ? body.body : "",
			agreedJson: "{}",
			contentHash,
			now: input.now,
		});
	}

	return {
		ok: true,
		jobId,
		status: "draft",
		longTerm: input.longTerm,
		stages: await deps.jobs.listStages(jobId),
	};
}

export type UpdatedStage = { ok: true; stage: JobStageRecord; staleAnnotationIds: string[] };

/**
 * A body or settings change bumps the stage revision and invalidates every
 * unresolved annotation taken from the previous revision. Accepting a stage
 * freezes it, so editing after acceptance is refused rather than silently
 * reopening a decision the user already made.
 */
export async function updateStage(
	deps: JobServiceDeps,
	input: {
		accountId: string;
		jobId: string;
		stageNo: number;
		body?: string;
		settings?: unknown;
		now: number;
	},
): Promise<UpdatedStage | JobFailure> {
	const job = await deps.jobs.getJob(input.accountId, input.jobId);
	if (!job) return fail("job_not_found");
	const stages = await deps.jobs.listStages(input.jobId);
	const editable = canEditStage(
		stages.map((stage) => ({ stageNo: stage.stageNo, status: stage.status })),
		input.stageNo,
	);
	if (editable) return fail(editable);

	const current = stages.find((stage) => stage.stageNo === input.stageNo);
	if (!current) return fail("stage_out_of_range");
	if (current.status === "accepted") return fail("stage_already_accepted");

	const body = normalizeStageBody(input.body ?? current.bodyMd);
	if (!body.ok) return fail(body.code === "stage_body_too_long" ? "stage_body_too_long" : "stage_body_invalid");

	let settings: AgreedSettings = current.settings;
	if (input.settings !== undefined) {
		const normalized = normalizeAgreedSettings(input.settings);
		if (!normalized.ok) return fail("agreed_settings_invalid");
		settings = normalized.settings;
	}

	const contentHash = await stageContentHash(body.body, settings);
	await deps.jobs.updateStageContent({
		jobId: input.jobId,
		stageNo: input.stageNo,
		bodyMd: body.body,
		agreedJson: JSON.stringify(settings),
		contentHash,
		now: input.now,
	});

	const updated = await deps.jobs.getStage(input.jobId, input.stageNo);
	if (!updated) return fail("stage_out_of_range");

	// Annotations from earlier revisions cannot be trusted against new text.
	const annotations = await deps.jobs.listAnnotations(input.jobId, input.stageNo);
	const staleAnnotationIds = staleAnnotationsForVersion(
		annotations.map((entry) => ({
			id: entry.id,
			stageVersion: entry.stageVersion,
			status: entry.status,
		})),
		updated.version,
	);
	await deps.jobs.markAnnotationsStale(staleAnnotationIds);

	return { ok: true, stage: updated, staleAnnotationIds };
}

export type CreatedAnnotation = {
	ok: true;
	annotationId: string;
	stageVersion: number;
};

export async function annotate(
	deps: JobServiceDeps,
	input: {
		accountId: string;
		jobId: string;
		stageNo: number;
		anchorStart?: number | null;
		anchorEnd?: number | null;
		quote?: string;
		body: string;
		now: number;
	},
): Promise<CreatedAnnotation | JobFailure> {
	const job = await deps.jobs.getJob(input.accountId, input.jobId);
	if (!job) return fail("job_not_found");
	const stage = await deps.jobs.getStage(input.jobId, input.stageNo);
	if (!stage) return fail("stage_out_of_range");

	const body = normalizeStageBody(input.body);
	if (!body.ok || !body.body.trim()) return fail("annotation_body_invalid");

	const anchorStart = input.anchorStart ?? null;
	const anchorEnd = input.anchorEnd ?? null;
	const quote = input.quote ?? "";
	const anchor = validateAnnotationAnchor({
		body: stage.bodyMd,
		start: anchorStart,
		end: anchorEnd,
		quote,
	});
	if (anchor) return fail(anchor === "anchor_quote_mismatch" ? "anchor_quote_mismatch" : "anchor_out_of_range");

	const annotationId = `ann_${crypto.randomUUID()}`;
	await deps.jobs.insertAnnotation({
		id: annotationId,
		jobId: input.jobId,
		stageNo: input.stageNo,
		stageVersion: stage.version,
		anchorStart,
		anchorEnd,
		quote,
		body: body.body,
		now: input.now,
	});
	return { ok: true, annotationId, stageVersion: stage.version };
}

export async function resolveAnnotation(
	deps: JobServiceDeps,
	input: { accountId: string; jobId: string; annotationId: string; now: number },
): Promise<{ ok: true } | JobFailure> {
	const job = await deps.jobs.getJob(input.accountId, input.jobId);
	if (!job) return fail("job_not_found");
	const annotations = await deps.jobs.listAnnotations(input.jobId);
	const target = annotations.find((entry) => entry.id === input.annotationId);
	if (!target) return fail("annotation_not_found");
	if (target.status !== "open") return fail("annotation_not_open");
	await deps.jobs.resolveAnnotation({
		jobId: input.jobId,
		annotationId: input.annotationId,
		now: input.now,
	});
	return { ok: true };
}

export type AcceptedStage = {
	ok: true;
	status: JobStatus;
	active: boolean;
};

/**
 * Accepting the final stage with long-term hosting enabled is the only path to
 * `active`; every other acceptance only advances the draft.
 */
export async function acceptStage(
	deps: JobServiceDeps,
	input: { accountId: string; jobId: string; stageNo: number; now: number },
): Promise<AcceptedStage | JobFailure> {
	const job = await deps.jobs.getJob(input.accountId, input.jobId);
	if (!job) return fail("job_not_found");
	const stages = await deps.jobs.listStages(input.jobId);
	const annotations = await deps.jobs.listAnnotations(input.jobId, input.stageNo);

	const verdict = canAcceptStage({
		stages: stages.map((stage) => ({ stageNo: stage.stageNo, status: stage.status })),
		stageNo: input.stageNo,
		openAnnotations: countOpenAnnotations(annotations),
	});
	if (verdict) return fail(verdict);

	await deps.jobs.markStageStatus({
		jobId: input.jobId,
		stageNo: input.stageNo,
		status: "accepted",
		acceptedAt: input.now,
		now: input.now,
	});

	const after = (await deps.jobs.listStages(input.jobId)).map((stage) => ({
		stageNo: stage.stageNo,
		status: stage.status,
	}));
	const derived = deriveJobStatus(job.status, after);

	const activation = canActivateJob({
		status: derived,
		longTerm: job.longTerm,
		stages: after,
	});
	const active = activation === null;
	await deps.jobs.updateJobState(input.accountId, input.jobId, {
		status: active ? "active" : derived,
		currentStage: Math.min(input.stageNo + 1, JOB_STAGE_COUNT),
		now: input.now,
	});

	return { ok: true, status: active ? "active" : derived, active };
}

export async function setJobPaused(
	deps: JobServiceDeps,
	input: { accountId: string; jobId: string; paused: boolean; now: number },
): Promise<{ ok: true; status: JobStatus } | JobFailure> {
	const job = await deps.jobs.getJob(input.accountId, input.jobId);
	if (!job) return fail("job_not_found");
	if (input.paused) {
		if (job.status !== "active") return fail("job_not_active");
		await deps.jobs.updateJobState(input.accountId, input.jobId, {
			status: "paused",
			now: input.now,
		});
		return { ok: true, status: "paused" };
	}
	if (job.status !== "paused") {
		return fail(job.status === "active" ? "job_already_active" : "job_not_active");
	}
	await deps.jobs.updateJobState(input.accountId, input.jobId, {
		status: "active",
		now: input.now,
	});
	return { ok: true, status: "active" };
}
