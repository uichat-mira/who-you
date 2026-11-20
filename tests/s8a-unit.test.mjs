import assert from "node:assert/strict";
import test from "node:test";
import {
	JOB_STAGE_COUNT,
	MAX_ANNOTATION_QUOTE_CHARS,
	MAX_BOUNDARY_MESSAGES,
	MAX_STAGE_BODY_CHARS,
	canAcceptStage,
	canActivateJob,
	canEditStage,
	canonicalStagePayload,
	countOpenAnnotations,
	deriveJobStatus,
	isJobRunnable,
	normalizeAgreedSettings,
	normalizeStageBody,
	resolveEffectiveSettings,
	staleAnnotationsForVersion,
	stageContentHash,
	validateAnnotationAnchor,
} from "../dist/unit.mjs";

/**
 * S8a: the mail job contract is a pure state machine, so every branch is
 * asserted here without D1, a socket or a clock.
 */

const stage = (stageNo, status) => ({ stageNo, status });
const allAccepted = [1, 2, 3].map((n) => stage(n, "accepted"));

test("S8a: stage editing opens only after the previous stage is accepted", () => {
	assert.equal(JOB_STAGE_COUNT, 3);
	assert.equal(canEditStage([], 1), null);
	assert.equal(canEditStage([], 2), "previous_stage_not_accepted");
	assert.equal(
		canEditStage([stage(1, "in_review"), stage(2, "draft")], 2),
		"previous_stage_not_accepted",
	);
	assert.equal(canEditStage([stage(1, "accepted"), stage(2, "draft")], 2), null);
	assert.equal(canEditStage(allAccepted, 3), null);

	for (const bad of [0, 4, -1, 1.5, Number.NaN]) {
		assert.equal(canEditStage([], bad), "stage_out_of_range");
	}
});

test("S8a: acceptance requires the previous stage, a non-accepted stage and zero open annotations", () => {
	assert.equal(
		canAcceptStage({ stages: [stage(1, "draft")], stageNo: 1, openAnnotations: 0 }),
		null,
	);
	assert.equal(
		canAcceptStage({ stages: [stage(1, "draft")], stageNo: 1, openAnnotations: 2 }),
		"stage_has_open_annotations",
	);
	assert.equal(
		canAcceptStage({ stages: [stage(1, "accepted")], stageNo: 1, openAnnotations: 0 }),
		"stage_already_accepted",
	);
	assert.equal(
		canAcceptStage({ stages: [stage(1, "draft")], stageNo: 2, openAnnotations: 0 }),
		"previous_stage_not_accepted",
	);
	assert.equal(
		canAcceptStage({ stages: [stage(1, "draft")], stageNo: 9, openAnnotations: 0 }),
		"stage_out_of_range",
	);
});

test("S8a: a job only becomes runnable from in_review after every stage is accepted", () => {
	assert.equal(canActivateJob({ status: "draft", longTerm: true, stages: allAccepted }), "job_not_active");
	assert.equal(canActivateJob({ status: "in_review", longTerm: false, stages: allAccepted }), "long_term_requires_final_acceptance");
	assert.equal(
		canActivateJob({
			status: "in_review",
			longTerm: true,
			stages: [stage(1, "accepted"), stage(2, "accepted"), stage(3, "in_review")],
		}),
		"previous_stage_not_accepted",
	);
	assert.equal(
		canActivateJob({ status: "in_review", longTerm: true, stages: allAccepted.slice(0, 2) }),
		"previous_stage_not_accepted",
	);
	assert.equal(canActivateJob({ status: "in_review", longTerm: true, stages: allAccepted }), null);
	assert.equal(canActivateJob({ status: "active", longTerm: true, stages: allAccepted }), "job_already_active");

	assert.equal(isJobRunnable("active"), true);
	for (const status of ["draft", "in_review", "paused"]) {
		assert.equal(isJobRunnable(status), false);
	}
});

test("S8a: job status derives from stage progress without clobbering run states", () => {
	assert.equal(deriveJobStatus("draft", [stage(1, "draft")]), "draft");
	assert.equal(deriveJobStatus("draft", [stage(1, "in_review")]), "in_review");
	assert.equal(deriveJobStatus("draft", [stage(1, "accepted")]), "in_review");
	assert.equal(deriveJobStatus("active", [stage(1, "draft")]), "active");
	assert.equal(deriveJobStatus("paused", [stage(1, "draft")]), "paused");
});

test("S8a: agreed settings accept only the whitelisted shape", () => {
	const accepted = normalizeAgreedSettings({
		mailboxId: "mbx_a",
		scope: { folders: ["inbox"], senders: ["boss@example.com"], keywords: ["invoice"] },
		cadence: "daily",
		deliver: { mode: "draft", to: ["me@example.com"] },
		boundaries: { maxMessagesPerRun: 20 },
	});
	assert.equal(accepted.ok, true);
	assert.deepEqual(accepted.settings.scope.folders, ["inbox"]);
	assert.equal(accepted.settings.cadence, "daily");

	assert.deepEqual(normalizeAgreedSettings(undefined), { ok: true, settings: {} });
	assert.deepEqual(normalizeAgreedSettings(null), { ok: true, settings: {} });

	const rejected = [
		{ unknownKey: true },
		{ scope: { unknown: ["x"] } },
		{ scope: { folders: "inbox" } },
		{ scope: { folders: ["x".repeat(129)] } },
		{ cadence: "sometimes" },
		{ deliver: { mode: "relay" } },
		{ deliver: { mode: "draft", unexpected: 1 } },
		{ boundaries: { maxMessagesPerRun: 0 } },
		{ boundaries: { maxMessagesPerRun: MAX_BOUNDARY_MESSAGES + 1 } },
		{ boundaries: { maxMessagesPerRun: 2.5 } },
		{ mailboxId: "" },
		{ mailboxId: "x".repeat(129) },
		["scope"],
		"scope",
	];
	for (const input of rejected) {
		const result = normalizeAgreedSettings(input);
		assert.equal(result.ok, false, `should reject ${JSON.stringify(input)}`);
		assert.equal(result.code, "agreed_settings_invalid");
	}

	// Duplicates collapse and surrounding whitespace is trimmed.
	const deduped = normalizeAgreedSettings({ scope: { folders: [" inbox ", "inbox", "trash"] } });
	assert.equal(deduped.ok, true);
	assert.deepEqual(deduped.settings.scope.folders, ["inbox", "trash"]);

	// Control characters in a settings value are rejected.
	assert.equal(normalizeAgreedSettings({ scope: { folders: ["in\u0000box"] } }).ok, false);
});

test("S8a: stage body keeps line structure and rejects control characters and oversize bodies", () => {
	assert.deepEqual(normalizeStageBody("line one\r\nline two"), { ok: true, body: "line one\nline two" });
	assert.deepEqual(normalizeStageBody("a\rb"), { ok: true, body: "a\nb" });
	assert.equal(normalizeStageBody("tab\tok").ok, true);
	assert.equal(normalizeStageBody("bad\u0000body").code, "stage_body_invalid");
	assert.equal(normalizeStageBody("bad\u001bbody").code, "stage_body_invalid");
	assert.equal(normalizeStageBody("x".repeat(MAX_STAGE_BODY_CHARS + 1)).code, "stage_body_too_long");
	assert.equal(normalizeStageBody("").ok, true);
});

test("S8a: the stage hash is stable across key and field ordering", async () => {
	const left = canonicalStagePayload("body", {
		mailboxId: "mbx_a",
		scope: { folders: ["trash", "inbox"] },
		cadence: "daily",
	});
	const right = canonicalStagePayload("body", {
		cadence: "daily",
		scope: { folders: ["inbox", "trash"] },
		mailboxId: "mbx_a",
	});
	assert.equal(left, right);

	const hash = await stageContentHash("body", { cadence: "daily" });
	assert.match(hash, /^[0-9a-f]{64}$/);
	assert.notEqual(hash, await stageContentHash("body ", { cadence: "daily" }));
	assert.notEqual(hash, await stageContentHash("body", { cadence: "weekly" }));
});

test("S8a: annotation anchors must point at existing text", () => {
	const body = "持续关注 AI 行业的变化";
	assert.equal(validateAnnotationAnchor({ body, start: null, end: null, quote: "" }), null);
	assert.equal(validateAnnotationAnchor({ body, start: null, end: null, quote: "x" }), "anchor_out_of_range");
	assert.equal(validateAnnotationAnchor({ body, start: 0, end: 4, quote: "持续关注" }), null);
	assert.equal(validateAnnotationAnchor({ body, start: 0, end: 4, quote: "持续关" }), "anchor_quote_mismatch");
	assert.equal(validateAnnotationAnchor({ body, start: 0, end: 0, quote: "" }), "anchor_out_of_range");
	assert.equal(validateAnnotationAnchor({ body, start: 5, end: 2, quote: "" }), "anchor_out_of_range");
	assert.equal(validateAnnotationAnchor({ body, start: -1, end: 2, quote: "" }), "anchor_out_of_range");
	assert.equal(
		validateAnnotationAnchor({ body, start: 0, end: body.length + 1, quote: "" }),
		"anchor_out_of_range",
	);
	assert.equal(validateAnnotationAnchor({ body, start: 0, end: null, quote: "" }), "anchor_out_of_range");
	assert.equal(
		validateAnnotationAnchor({
			body,
			start: 0,
			end: 4,
			quote: "x".repeat(MAX_ANNOTATION_QUOTE_CHARS + 1),
		}),
		"anchor_out_of_range",
	);
});

test("S8a: a body revision makes unresolved annotations stale but keeps resolved ones", () => {
	const annotations = [
		{ id: "a1", stageVersion: 1, status: "open" },
		{ id: "a2", stageVersion: 1, status: "resolved" },
		{ id: "a3", stageVersion: 2, status: "open" },
		{ id: "a4", stageVersion: 1, status: "stale" },
	];
	assert.deepEqual(staleAnnotationsForVersion(annotations, 2), ["a1"]);
	assert.deepEqual(staleAnnotationsForVersion(annotations, 1), ["a3"]);
	assert.deepEqual(staleAnnotationsForVersion([], 1), []);

	assert.equal(countOpenAnnotations(annotations), 2);
	assert.equal(countOpenAnnotations([]), 0);
	assert.equal(countOpenAnnotations([{ status: "stale" }, { status: "resolved" }]), 0);
});

test("S8a: effective settings come from accepted stages, later stages winning", () => {
	const effective = resolveEffectiveSettings([
		{
			stageNo: 1,
			status: "accepted",
			settings: {
				mailboxId: "mbx_a",
				scope: { folders: ["inbox"], keywords: ["ai"] },
				cadence: "daily",
			},
		},
		{
			stageNo: 2,
			status: "draft",
			settings: { cadence: "hourly" },
		},
		{
			stageNo: 3,
			status: "accepted",
			settings: {
				scope: { folders: ["archive"] },
				deliver: { mode: "draft" },
				boundaries: { maxMessagesPerRun: 5 },
			},
		},
	]);

	// Stage 2 is not accepted, so its cadence must not apply.
	assert.equal(effective.cadence, "daily");
	assert.deepEqual(effective.scope.folders, ["archive"]);
	assert.deepEqual(effective.scope.keywords, ["ai"]);
	assert.equal(effective.mailboxId, "mbx_a");
	assert.deepEqual(effective.deliver, { mode: "draft" });
	assert.deepEqual(effective.boundaries, { maxMessagesPerRun: 5 });

	assert.deepEqual(resolveEffectiveSettings([]), {});
});
