import type { AgreedSettings, JobScope } from "./job-state";
import type { JobRecord, JobStageRecord } from "./job-store";
import { isJobRunnable, resolveEffectiveSettings } from "./job-state";
import type { MessageFolder } from "./store";

/**
 * S8c: applying an active job's agreed scope to the existing mail tools.
 *
 * The tools stay usable without a job (`jobId` is optional), so this module only
 * narrows. It never widens: a job can restrict folders and senders and cap how
 * many messages one call returns, but it cannot grant access to a mailbox or a
 * message the caller could not already read.
 */

export type JobScopeFailureCode = "job_not_found" | "job_not_active";

export type ResolvedJobScope = {
	ok: true;
	job: JobRecord;
	settings: AgreedSettings;
	/** Allowed folders; empty means "no folder restriction". */
	folders: string[];
	/** Lowercased sender addresses; empty means "no sender restriction". */
	senders: string[];
	/** Optional per-call cap from `boundaries.maxMessagesPerRun`. */
	maxMessages: number | null;
};

export type JobScopeResult = ResolvedJobScope | { ok: false; code: JobScopeFailureCode };

/**
 * Resolves the settings that a run may use. A paused or unfinished job is
 * refused here, because a scope check is the only reason a tool needs the job at
 * all; a stale client must not be able to read scope from a non-active job.
 */
export function resolveJobScope(
	job: JobRecord | null,
	stages: readonly JobStageRecord[],
): JobScopeResult {
	if (!job) return { ok: false, code: "job_not_found" };
	if (!isJobRunnable(job.status)) return { ok: false, code: "job_not_active" };

	const settings = resolveEffectiveSettings(
		stages.map((stage) => ({
			stageNo: stage.stageNo,
			status: stage.status,
			settings: stage.settings,
		})),
	);
	const scope: JobScope = settings.scope ?? {};
	const senders = (scope.senders ?? []).map((value) => value.trim().toLowerCase());

	return {
		ok: true,
		job,
		settings,
		folders: (scope.folders ?? []).map((value) => value.trim().toLowerCase()),
		senders: senders.filter(Boolean),
		maxMessages: settings.boundaries?.maxMessagesPerRun ?? null,
	};
}

/**
 * Intersects the caller's requested folder with the job's allowed folders. An
 * empty allow list means the job did not restrict folders, so the request stands.
 * Only folders the repository understands can survive this intersection.
 */
export function narrowFolder(
	requested: MessageFolder,
	allowed: readonly string[],
): MessageFolder[] {
	const valid: MessageFolder[] = ["inbox", "archive", "trash"];
	if (allowed.length === 0) return [requested];
	if (requested === "all") {
		const permitted = valid.filter((folder) => allowed.includes(folder));
		return permitted.length > 0 ? permitted : [];
	}
	return allowed.includes(requested) ? [requested] : [];
}

export type ScopableMessage = {
	from: { name: string; address: string }[];
};

/**
 * Drops rows outside the job's sender allow list. Filtering happens after the
 * page query, so a caller can receive fewer rows than `limit`; that is the safe
 * direction, because nothing outside the scope is ever returned.
 */
export function filterBySenders<T extends ScopableMessage>(
	messages: readonly T[],
	senders: readonly string[],
): T[] {
	if (senders.length === 0) return [...messages];
	return messages.filter((message) =>
		message.from.some((entry) => {
			const address = entry.address?.trim().toLowerCase() ?? "";
			return address.length > 0 && senders.includes(address);
		}),
	);
}

/** Applies the per-run cap. `null` means the job set no cap. */
export function capLimit(limit: number, maxMessages: number | null): number {
	if (maxMessages === null) return limit;
	return Math.min(limit, Math.max(1, maxMessages));
}
