import type {
	AgreedSettings,
	JobAnnotationStatus,
	JobStageStatus,
	JobStatus,
	JobTemplateKey,
} from "./job-state";

/**
 * Storage for the S8 mail job contract.
 *
 * Every statement is scoped by `account_id`: a job id is opaque and never an
 * authority claim. Nothing here stores mail content, and the audit-facing
 * columns only ever hold fixed codes.
 */

export type JobRecord = {
	id: string;
	accountId: string;
	mailboxId: string;
	templateKey: JobTemplateKey;
	title: string;
	status: JobStatus;
	currentStage: number;
	longTerm: boolean;
	createdAt: number;
	updatedAt: number;
};

export type JobStageRecord = {
	jobId: string;
	stageNo: number;
	title: string;
	bodyMd: string;
	settings: AgreedSettings;
	version: number;
	contentHash: string;
	status: JobStageStatus;
	acceptedAt: number | null;
	createdAt: number;
	updatedAt: number;
};

export type JobAnnotationRecord = {
	id: string;
	jobId: string;
	stageNo: number;
	stageVersion: number;
	anchorStart: number | null;
	anchorEnd: number | null;
	quote: string;
	body: string;
	status: JobAnnotationStatus;
	createdAt: number;
	resolvedAt: number | null;
};

export type JobRunRecord = {
	id: string;
	jobId: string;
	runNo: number;
	status: "running" | "succeeded" | "failed";
	reasonCode: string | null;
	startedAt: number;
	finishedAt: number | null;
};

type JobRow = {
	id: string;
	account_id: string;
	mailbox_id: string;
	template_key: JobTemplateKey;
	title: string;
	status: JobStatus;
	current_stage: number;
	long_term: number;
	created_at: number;
	updated_at: number;
};

type StageRow = {
	job_id: string;
	stage_no: number;
	title: string;
	body_md: string;
	agreed_json: string;
	version: number;
	content_hash: string;
	status: JobStageStatus;
	accepted_at: number | null;
	created_at: number;
	updated_at: number;
};

type AnnotationRow = {
	id: string;
	job_id: string;
	stage_no: number;
	stage_version: number;
	anchor_start: number | null;
	anchor_end: number | null;
	quote: string;
	body: string;
	status: JobAnnotationStatus;
	created_at: number;
	resolved_at: number | null;
};

type RunRow = {
	id: string;
	job_id: string;
	run_no: number;
	status: "running" | "succeeded" | "failed";
	reason_code: string | null;
	started_at: number;
	finished_at: number | null;
};

const toJob = (row: JobRow): JobRecord => ({
	id: row.id,
	accountId: row.account_id,
	mailboxId: row.mailbox_id,
	templateKey: row.template_key,
	title: row.title,
	status: row.status,
	currentStage: row.current_stage,
	longTerm: row.long_term === 1,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

const toStage = (row: StageRow): JobStageRecord => {
	// Stored JSON is only ever written after `normalizeAgreedSettings`, so a
	// parse failure means the row was tampered with outside this repository.
	let settings: AgreedSettings = {};
	try {
		settings = JSON.parse(row.agreed_json) as AgreedSettings;
	} catch {
		settings = {};
	}
	return {
		jobId: row.job_id,
		stageNo: row.stage_no,
		title: row.title,
		bodyMd: row.body_md,
		settings,
		version: row.version,
		contentHash: row.content_hash,
		status: row.status,
		acceptedAt: row.accepted_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
};

const toAnnotation = (row: AnnotationRow): JobAnnotationRecord => ({
	id: row.id,
	jobId: row.job_id,
	stageNo: row.stage_no,
	stageVersion: row.stage_version,
	anchorStart: row.anchor_start,
	anchorEnd: row.anchor_end,
	quote: row.quote,
	body: row.body,
	status: row.status,
	createdAt: row.created_at,
	resolvedAt: row.resolved_at,
});

const toRun = (row: RunRow): JobRunRecord => ({
	id: row.id,
	jobId: row.job_id,
	runNo: row.run_no,
	status: row.status,
	reasonCode: row.reason_code,
	startedAt: row.started_at,
	finishedAt: row.finished_at,
});

export const JOB_LIST_LIMIT = 50;

export class JobRepository {
	constructor(private readonly db: D1Database) {}

	async createJob(input: {
		id: string;
		accountId: string;
		mailboxId: string;
		templateKey: JobTemplateKey;
		title: string;
		now: number;
	}): Promise<JobRecord> {
		await this.db
			.prepare(
				`INSERT INTO mail_jobs (
				 id, account_id, mailbox_id, template_key, title, status,
				 current_stage, long_term, created_at, updated_at
				 ) VALUES (?,?,?,?,?,'draft',1,0,?,?)`,
			)
			.bind(
				input.id,
				input.accountId,
				input.mailboxId,
				input.templateKey,
				input.title,
				input.now,
				input.now,
			)
			.run();
		const created = await this.getJob(input.accountId, input.id);
		if (!created) throw new Error("job_insert_failed");
		return created;
	}

	async getJob(accountId: string, jobId: string): Promise<JobRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT id, account_id, mailbox_id, template_key, title, status,
				 current_stage, long_term, created_at, updated_at
				 FROM mail_jobs WHERE id = ? AND account_id = ?`,
			)
			.bind(jobId, accountId)
			.first<JobRow>();
		return row ? toJob(row) : null;
	}

	async listJobs(accountId: string, limit: number = JOB_LIST_LIMIT): Promise<JobRecord[]> {
		const rows = await this.db
			.prepare(
				`SELECT id, account_id, mailbox_id, template_key, title, status,
				 current_stage, long_term, created_at, updated_at
				 FROM mail_jobs WHERE account_id = ?
				 ORDER BY updated_at DESC, id LIMIT ?`,
			)
			.bind(accountId, Math.min(Math.max(limit, 1), JOB_LIST_LIMIT))
			.all<JobRow>();
		return (rows.results ?? []).map(toJob);
	}

	async updateJobState(
		accountId: string,
		jobId: string,
		patch: {
			status?: JobStatus;
			currentStage?: number;
			longTerm?: boolean;
			now: number;
		},
	): Promise<void> {
		const assignments: string[] = ["updated_at = ?"];
		const values: unknown[] = [patch.now];
		if (patch.status !== undefined) {
			assignments.unshift("status = ?");
			values.unshift(patch.status);
		}
		if (patch.currentStage !== undefined) {
			assignments.unshift("current_stage = ?");
			values.unshift(patch.currentStage);
		}
		if (patch.longTerm !== undefined) {
			assignments.unshift("long_term = ?");
			values.unshift(patch.longTerm ? 1 : 0);
		}
		values.push(jobId, accountId);
		await this.db
			.prepare(`UPDATE mail_jobs SET ${assignments.join(", ")} WHERE id = ? AND account_id = ?`)
			.bind(...values)
			.run();
	}

	async listStages(jobId: string): Promise<JobStageRecord[]> {
		const rows = await this.db
			.prepare(
				`SELECT job_id, stage_no, title, body_md, agreed_json, version,
				 content_hash, status, accepted_at, created_at, updated_at
				 FROM mail_job_stages WHERE job_id = ? ORDER BY stage_no`,
			)
			.bind(jobId)
			.all<StageRow>();
		return (rows.results ?? []).map(toStage);
	}

	async getStage(jobId: string, stageNo: number): Promise<JobStageRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT job_id, stage_no, title, body_md, agreed_json, version,
				 content_hash, status, accepted_at, created_at, updated_at
				 FROM mail_job_stages WHERE job_id = ? AND stage_no = ?`,
			)
			.bind(jobId, stageNo)
			.first<StageRow>();
		return row ? toStage(row) : null;
	}

	async insertStage(input: {
		jobId: string;
		stageNo: number;
		title: string;
		bodyMd: string;
		agreedJson: string;
		contentHash: string;
		now: number;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO mail_job_stages (
				 job_id, stage_no, title, body_md, agreed_json, version,
				 content_hash, status, accepted_at, created_at, updated_at
				 ) VALUES (?,?,?,?,?,1,?,'draft',NULL,?,?)`,
			)
			.bind(
				input.jobId,
				input.stageNo,
				input.title,
				input.bodyMd,
				input.agreedJson,
				input.contentHash,
				input.now,
				input.now,
			)
			.run();
	}

	/**
	 * Body/settings change bumps the revision. The caller must have already
	 * verified that the stage is editable and has recomputed the hash.
	 */
	async updateStageContent(input: {
		jobId: string;
		stageNo: number;
		bodyMd: string;
		agreedJson: string;
		contentHash: string;
		now: number;
	}): Promise<void> {
		await this.db
			.prepare(
				`UPDATE mail_job_stages SET
				 body_md = ?, agreed_json = ?, content_hash = ?,
				 version = version + 1, updated_at = ?
				 WHERE job_id = ? AND stage_no = ?`,
			)
			.bind(
				input.bodyMd,
				input.agreedJson,
				input.contentHash,
				input.now,
				input.jobId,
				input.stageNo,
			)
			.run();
	}

	async markStageStatus(input: {
		jobId: string;
		stageNo: number;
		status: JobStageStatus;
		acceptedAt: number | null;
		now: number;
	}): Promise<void> {
		await this.db
			.prepare(
				`UPDATE mail_job_stages SET status = ?, accepted_at = ?, updated_at = ?
				 WHERE job_id = ? AND stage_no = ?`,
			)
			.bind(input.status, input.acceptedAt, input.now, input.jobId, input.stageNo)
			.run();
	}

	async listAnnotations(jobId: string, stageNo?: number): Promise<JobAnnotationRecord[]> {
		const rows = await this.db
			.prepare(
				`SELECT id, job_id, stage_no, stage_version, anchor_start, anchor_end,
				 quote, body, status, created_at, resolved_at
				 FROM mail_job_annotations
				 WHERE job_id = ? ${stageNo === undefined ? "" : "AND stage_no = ?"}
				 ORDER BY stage_no, created_at, id`,
			)
			.bind(...(stageNo === undefined ? [jobId] : [jobId, stageNo]))
			.all<AnnotationRow>();
		return (rows.results ?? []).map(toAnnotation);
	}

	async insertAnnotation(input: {
		id: string;
		jobId: string;
		stageNo: number;
		stageVersion: number;
		anchorStart: number | null;
		anchorEnd: number | null;
		quote: string;
		body: string;
		now: number;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO mail_job_annotations (
				 id, job_id, stage_no, stage_version, anchor_start, anchor_end,
				 quote, body, status, created_at, resolved_at
				 ) VALUES (?,?,?,?,?,?,?,?,'open',?,NULL)`,
			)
			.bind(
				input.id,
				input.jobId,
				input.stageNo,
				input.stageVersion,
				input.anchorStart,
				input.anchorEnd,
				input.quote,
				input.body,
				input.now,
			)
			.run();
	}

	async resolveAnnotation(input: {
		jobId: string;
		annotationId: string;
		now: number;
	}): Promise<void> {
		await this.db
			.prepare(
				`UPDATE mail_job_annotations SET status = 'resolved', resolved_at = ?
				 WHERE id = ? AND job_id = ? AND status = 'open'`,
			)
			.bind(input.now, input.annotationId, input.jobId)
			.run();
	}

	/** Marks the listed annotations stale; already-stale rows are left alone. */
	async markAnnotationsStale(annotationIds: readonly string[]): Promise<void> {
		if (annotationIds.length === 0) return;
		const placeholders = annotationIds.map(() => "?").join(",");
		await this.db
			.prepare(
				`UPDATE mail_job_annotations SET status = 'stale'
				 WHERE status = 'open' AND id IN (${placeholders})`,
			)
			.bind(...annotationIds)
			.run();
	}

	async listRuns(jobId: string, limit = 10): Promise<JobRunRecord[]> {
		const rows = await this.db
			.prepare(
				`SELECT id, job_id, run_no, status, reason_code, started_at, finished_at
				 FROM mail_job_runs WHERE job_id = ?
				 ORDER BY run_no DESC LIMIT ?`,
			)
			.bind(jobId, Math.min(Math.max(limit, 1), 50))
			.all<RunRow>();
		return (rows.results ?? []).map(toRun);
	}
}
