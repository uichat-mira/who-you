import { sha256Hex } from "./hash";

/**
 * S8a pure rules for the mail job contract.
 *
 * A job is a staged, reviewable delegation. Nothing here touches D1, the
 * network, or a clock: every decision is a function of the supplied records, so
 * the state machine can be tested exhaustively and reused by both the MCP tools
 * and the run gate.
 */

export const JOB_STAGE_COUNT = 3;

export type JobTemplateKey = "digest" | "single" | "followup";
export type JobStatus = "draft" | "in_review" | "active" | "paused";
export type JobStageStatus = "draft" | "in_review" | "accepted";
export type JobAnnotationStatus = "open" | "resolved" | "stale";

export const JOB_TEMPLATE_KEYS: readonly JobTemplateKey[] = ["digest", "single", "followup"];

/**
 * Fixed codes. Callers branch on these instead of on prose, and none of them
 * can carry a subject, address or body.
 */
export type JobRuleCode =
	| "stage_out_of_range"
	| "previous_stage_not_accepted"
	| "stage_already_accepted"
	| "stage_has_open_annotations"
	| "stage_body_invalid"
	| "stage_body_too_long"
	| "agreed_settings_invalid"
	| "anchor_out_of_range"
	| "anchor_quote_mismatch"
	| "annotation_not_open"
	| "job_not_active"
	| "job_already_active"
	| "long_term_requires_final_acceptance";

export const MAX_STAGE_BODY_CHARS = 20_000;
export const MAX_ANNOTATION_BODY_CHARS = 2_000;
export const MAX_ANNOTATION_QUOTE_CHARS = 500;
export const MAX_SCOPE_ITEMS = 20;
export const MAX_SCOPE_ITEM_CHARS = 128;
export const MAX_BOUNDARY_MESSAGES = 100;

/** Controlled settings for one stage. It is never free-form. */
export type AgreedSettings = {
	mailboxId?: string;
	scope?: {
		folders?: string[];
		senders?: string[];
		keywords?: string[];
	};
	cadence?: "manual" | "hourly" | "daily" | "weekly";
	deliver?: {
		mode: "draft" | "send";
		to?: string[];
	};
	boundaries?: {
		maxMessagesPerRun?: number;
	};
};

export type AgreedSettingsResult =
	| { ok: true; settings: AgreedSettings }
	| { ok: false; code: JobRuleCode };

const ALLOWED_KEYS = new Set([
	"mailboxId",
	"scope",
	"cadence",
	"deliver",
	"boundaries",
]);
const SCOPE_KEYS = new Set(["folders", "senders", "keywords"]);
const DELIVER_KEYS = new Set(["mode", "to"]);
const BOUNDARY_KEYS = new Set(["maxMessagesPerRun"]);
const CADENCE_VALUES = new Set(["manual", "hourly", "daily", "weekly"]);
const DELIVER_MODES = new Set(["draft", "send"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (): AgreedSettingsResult => ({ ok: false, code: "agreed_settings_invalid" });

const normalizeStringList = (value: unknown): string[] | null => {
	if (!Array.isArray(value) || value.length > MAX_SCOPE_ITEMS) return null;
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return null;
		const trimmed = entry.trim();
		if (!trimmed || trimmed.length > MAX_SCOPE_ITEM_CHARS) return null;
		// Settings never need control characters; rejecting them keeps the value
		// safe to render and to echo back in an error-free response.
		for (const character of trimmed) {
			const code = character.charCodeAt(0);
			if (code < 32 || code === 127) return null;
		}
		if (!out.includes(trimmed)) out.push(trimmed);
	}
	return out;
};

/**
 * Accepts only the whitelisted settings shape. Unknown keys are rejected rather
 * than ignored: silently dropping a key would let a caller believe a boundary
 * was stored when it was not.
 */
export function normalizeAgreedSettings(raw: unknown): AgreedSettingsResult {
	if (raw === undefined || raw === null) return { ok: true, settings: {} };
	if (!isPlainObject(raw)) return invalid();
	for (const key of Object.keys(raw)) {
		if (!ALLOWED_KEYS.has(key)) return invalid();
	}

	const settings: AgreedSettings = {};

	if (raw.mailboxId !== undefined) {
		if (typeof raw.mailboxId !== "string") return invalid();
		const mailboxId = raw.mailboxId.trim();
		if (!mailboxId || mailboxId.length > MAX_SCOPE_ITEM_CHARS) return invalid();
		settings.mailboxId = mailboxId;
	}

	if (raw.scope !== undefined) {
		if (!isPlainObject(raw.scope)) return invalid();
		for (const key of Object.keys(raw.scope)) {
			if (!SCOPE_KEYS.has(key)) return invalid();
		}
		const scope: NonNullable<AgreedSettings["scope"]> = {};
		for (const key of ["folders", "senders", "keywords"] as const) {
			if (raw.scope[key] === undefined) continue;
			const list = normalizeStringList(raw.scope[key]);
			if (!list) return invalid();
			scope[key] = list;
		}
		settings.scope = scope;
	}

	if (raw.cadence !== undefined) {
		if (typeof raw.cadence !== "string" || !CADENCE_VALUES.has(raw.cadence)) {
			return invalid();
		}
		settings.cadence = raw.cadence as NonNullable<AgreedSettings["cadence"]>;
	}

	if (raw.deliver !== undefined) {
		if (!isPlainObject(raw.deliver)) return invalid();
		for (const key of Object.keys(raw.deliver)) {
			if (!DELIVER_KEYS.has(key)) return invalid();
		}
		if (typeof raw.deliver.mode !== "string" || !DELIVER_MODES.has(raw.deliver.mode)) {
			return invalid();
		}
		const deliver: NonNullable<AgreedSettings["deliver"]> = {
			mode: raw.deliver.mode as "draft" | "send",
		};
		if (raw.deliver.to !== undefined) {
			const to = normalizeStringList(raw.deliver.to);
			if (!to) return invalid();
			deliver.to = to;
		}
		settings.deliver = deliver;
	}

	if (raw.boundaries !== undefined) {
		if (!isPlainObject(raw.boundaries)) return invalid();
		for (const key of Object.keys(raw.boundaries)) {
			if (!BOUNDARY_KEYS.has(key)) return invalid();
		}
		if (raw.boundaries.maxMessagesPerRun !== undefined) {
			const value = raw.boundaries.maxMessagesPerRun;
			if (
				typeof value !== "number" ||
				!Number.isInteger(value) ||
				value < 1 ||
				value > MAX_BOUNDARY_MESSAGES
			) {
				return invalid();
			}
			settings.boundaries = { maxMessagesPerRun: value };
		} else {
			settings.boundaries = {};
		}
	}

	return { ok: true, settings };
}

export type StageBodyResult =
	| { ok: true; body: string }
	| { ok: false; code: JobRuleCode };

/**
 * Requirement text is user-authored Markdown. Line structure is preserved and
 * every other control character is rejected, because a body is echoed back to
 * the caller and must never be able to smuggle a protocol-level break.
 */
export function normalizeStageBody(raw: string): StageBodyResult {
	const body = raw.replace(/\r\n?/g, "\n");
	for (const character of body) {
		const code = character.charCodeAt(0);
		if ((code < 32 && code !== 10 && code !== 9) || code === 127) {
			return { ok: false, code: "stage_body_invalid" };
		}
	}
	if (body.length > MAX_STAGE_BODY_CHARS) return { ok: false, code: "stage_body_too_long" };
	return { ok: true, body };
}

/**
 * Fixed-order canonical payload. Stage settings are serialized with sorted keys
 * so that two equivalent settings objects always hash the same.
 */
export function canonicalStagePayload(body: string, settings: AgreedSettings): string {
	const sortList = (value: string[] | undefined): string[] =>
		value ? [...value].sort() : [];
	return JSON.stringify({
		body,
		mailboxId: settings.mailboxId ?? null,
		scope: {
			folders: sortList(settings.scope?.folders),
			senders: sortList(settings.scope?.senders),
			keywords: sortList(settings.scope?.keywords),
		},
		cadence: settings.cadence ?? null,
		deliver: settings.deliver
			? { mode: settings.deliver.mode, to: sortList(settings.deliver.to) }
			: null,
		boundaries: {
			maxMessagesPerRun: settings.boundaries?.maxMessagesPerRun ?? null,
		},
	});
}

export function stageContentHash(body: string, settings: AgreedSettings): Promise<string> {
	return sha256Hex(canonicalStagePayload(body, settings));
}

export type JobStageView = {
	stageNo: number;
	status: JobStageStatus;
};

/**
 * Stage 1 is always editable. Stage n > 1 opens only after stage n-1 is
 * accepted, which is what makes "接受本阶段" meaningful instead of decorative.
 */
export function canEditStage(stages: readonly JobStageView[], stageNo: number): JobRuleCode | null {
	if (!Number.isInteger(stageNo) || stageNo < 1 || stageNo > JOB_STAGE_COUNT) {
		return "stage_out_of_range";
	}
	if (stageNo === 1) return null;
	const previous = stages.find((stage) => stage.stageNo === stageNo - 1);
	if (!previous) return "previous_stage_not_accepted";
	return previous.status === "accepted" ? null : "previous_stage_not_accepted";
}

export type StageAcceptInput = {
	stages: readonly JobStageView[];
	stageNo: number;
	openAnnotations: number;
};

/**
 * Acceptance is the only path to a frozen stage, so it requires both the
 * previous stage and a clean annotation set.
 */
export function canAcceptStage(input: StageAcceptInput): JobRuleCode | null {
	const editable = canEditStage(input.stages, input.stageNo);
	if (editable) return editable;
	const current = input.stages.find((stage) => stage.stageNo === input.stageNo);
	if (!current) return "stage_out_of_range";
	if (current.status === "accepted") return "stage_already_accepted";
	if (!Number.isInteger(input.openAnnotations) || input.openAnnotations < 0) {
		return "stage_has_open_annotations";
	}
	if (input.openAnnotations > 0) return "stage_has_open_annotations";
	return null;
}

export type JobActivationInput = {
	status: JobStatus;
	longTerm: boolean;
	stages: readonly JobStageView[];
};

/**
 * `active` and `paused` are run states owned by the user, so a stage change
 * never overwrites them. Before that, a job is `in_review` as soon as any stage
 * leaves `draft`, which is what makes it eligible for activation once every
 * stage is accepted.
 */
export function deriveJobStatus(
	current: JobStatus,
	stages: readonly JobStageView[],
): JobStatus {
	if (current === "active" || current === "paused") return current;
	const anyStarted = stages.some((stage) => stage.status !== "draft");
	return anyStarted ? "in_review" : "draft";
}

/**
 * `active` is what unlocks outbound work, so it is reachable only from
 * `in_review` after every stage is accepted. Long-term hosting adds one more
 * requirement rather than bypassing them.
 */
export function canActivateJob(input: JobActivationInput): JobRuleCode | null {
	if (input.status === "active") return "job_already_active";
	if (input.status !== "in_review") return "job_not_active";
	if (!input.longTerm) return "long_term_requires_final_acceptance";
	if (input.stages.length !== JOB_STAGE_COUNT) return "previous_stage_not_accepted";
	for (let stageNo = 1; stageNo <= JOB_STAGE_COUNT; stageNo += 1) {
		const stage = input.stages.find((entry) => entry.stageNo === stageNo);
		if (!stage || stage.status !== "accepted") return "previous_stage_not_accepted";
	}
	return null;
}

export type AnchorInput = {
	body: string;
	start: number | null;
	end: number | null;
	quote: string;
};

/**
 * An anchor must point at text that still exists. Stage-wide annotations use
 * null offsets; anything else must be in range and match the stored quote, so a
 * stale annotation is detectable instead of silently pointing at new text.
 */
export function validateAnnotationAnchor(input: AnchorInput): JobRuleCode | null {
	const { start, end } = input;
	if (start === null && end === null) {
		if (input.quote.length > 0) return "anchor_out_of_range";
		return null;
	}
	if (start === null || end === null) return "anchor_out_of_range";
	if (!Number.isInteger(start) || !Number.isInteger(end)) return "anchor_out_of_range";
	if (start < 0 || end <= start || end > input.body.length) return "anchor_out_of_range";
	if (input.quote.length > MAX_ANNOTATION_QUOTE_CHARS) return "anchor_out_of_range";
	if (input.body.slice(start, end) !== input.quote) return "anchor_quote_mismatch";
	return null;
}

export type AnnotationView = {
	id: string;
	stageVersion: number;
	status: JobAnnotationStatus;
};

/**
 * After a body change every unresolved annotation on the old revision becomes
 * `stale`. Resolved annotations keep their outcome, because their decision was
 * already recorded against text the user has since replaced.
 */
export function staleAnnotationsForVersion(
	annotations: readonly AnnotationView[],
	stageVersion: number,
): string[] {
	return annotations
		.filter((entry) => entry.status === "open" && entry.stageVersion !== stageVersion)
		.map((entry) => entry.id);
}

/** `open` annotations block acceptance; `stale` and `resolved` never do. */
export function countOpenAnnotations(
	annotations: readonly { status: JobAnnotationStatus }[],
): number {
	return annotations.filter((entry) => entry.status === "open").length;
}

/**
 * The run gate. Every outbound path checks this instead of the raw status, so a
 * paused or unfinished job cannot send even when a stale client asks it to.
 */
export function isJobRunnable(status: JobStatus): boolean {
	return status === "active";
}

export type JobScope = NonNullable<AgreedSettings["scope"]>;
export type JobDeliver = NonNullable<AgreedSettings["deliver"]>;

/**
 * Collects the settings that apply to a run by taking the most recent accepted
 * stage that defines them. This keeps stage 3 authoritative for delivery while
 * stage 1 can still supply the search scope.
 */
export function resolveEffectiveSettings(
	stages: readonly { stageNo: number; status: JobStageStatus; settings: AgreedSettings }[],
): AgreedSettings {
	const accepted = [...stages]
		.filter((stage) => stage.status === "accepted")
		.sort((left, right) => left.stageNo - right.stageNo);

	const effective: AgreedSettings = {};
	for (const stage of accepted) {
		const settings = stage.settings;
		if (settings.mailboxId !== undefined) effective.mailboxId = settings.mailboxId;
		if (settings.scope) effective.scope = { ...effective.scope, ...settings.scope };
		if (settings.cadence !== undefined) effective.cadence = settings.cadence;
		if (settings.deliver) effective.deliver = { ...settings.deliver };
		if (settings.boundaries) {
			effective.boundaries = { ...effective.boundaries, ...settings.boundaries };
		}
	}
	return effective;
}
