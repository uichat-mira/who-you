import assert from "node:assert/strict";
import test from "node:test";
import {
	capLimit,
	filterBySenders,
	narrowFolder,
	resolveJobScope,
} from "../dist/unit.mjs";

/**
 * S8c: job scope narrowing is pure, so its boundaries are asserted without D1.
 * The invariant under test is that a scope can only ever remove access.
 */

const job = (status) => ({
	id: "job_1",
	accountId: "account-a",
	mailboxId: "mbx_a",
	templateKey: "digest",
	title: "watch",
	status,
	currentStage: 3,
	longTerm: true,
	createdAt: 1,
	updatedAt: 2,
});

const stage = (stageNo, settings) => ({
	jobId: "job_1",
	stageNo,
	title: "s",
	bodyMd: "",
	settings,
	version: 1,
	contentHash: "0".repeat(64),
	status: "accepted",
	acceptedAt: 1,
	createdAt: 1,
	updatedAt: 1,
});

test("S8c: only an active job yields a scope", () => {
	assert.equal(resolveJobScope(null, []).code, "job_not_found");
	for (const status of ["draft", "in_review", "paused"]) {
		const result = resolveJobScope(job(status), []);
		assert.equal(result.ok, false);
		assert.equal(result.code, "job_not_active");
	}

	const active = resolveJobScope(job("active"), [
		stage(1, { scope: { folders: ["inbox"], senders: ["Boss@Example.com"] } }),
		stage(3, { boundaries: { maxMessagesPerRun: 5 } }),
	]);
	assert.equal(active.ok, true);
	assert.deepEqual(active.folders, ["inbox"]);
	assert.deepEqual(active.senders, ["boss@example.com"]);
	assert.equal(active.maxMessages, 5);
});

test("S8c: folder narrowing never widens the request", () => {
	// No job restriction: the request stands.
	assert.deepEqual(narrowFolder("inbox", []), ["inbox"]);
	assert.deepEqual(narrowFolder("all", []), ["all"]);

	// A job restriction intersects.
	assert.deepEqual(narrowFolder("inbox", ["inbox", "archive"]), ["inbox"]);
	assert.deepEqual(narrowFolder("trash", ["inbox", "archive"]), []);
	assert.deepEqual(narrowFolder("all", ["inbox", "archive"]), ["inbox", "archive"]);

	// An unknown folder in the allow list never becomes queryable.
	assert.deepEqual(narrowFolder("all", ["spam", "family"]), []);
	assert.deepEqual(narrowFolder("all", ["inbox", "spam"]), ["inbox"]);
});

test("S8c: sender filtering keeps only allow-listed senders", () => {
	const messages = [
		{ id: "m1", from: [{ name: "Boss", address: "Boss@Example.com" }] },
		{ id: "m2", from: [{ name: "Other", address: "other@example.com" }] },
		{ id: "m3", from: [] },
	];
	assert.deepEqual(
		filterBySenders(messages, ["boss@example.com"]).map((m) => m.id),
		["m1"],
	);
	// An empty allow list means "no sender restriction", not "block everything".
	assert.equal(filterBySenders(messages, []).length, 3);
	// An empty sender list on a message is never treated as a match.
	assert.deepEqual(filterBySenders(messages, ["other@example.com"]).map((m) => m.id), ["m2"]);
});

test("S8c: the per-run cap only lowers the limit", () => {
	assert.equal(capLimit(20, null), 20);
	assert.equal(capLimit(20, 5), 5);
	assert.equal(capLimit(3, 5), 3);
	assert.equal(capLimit(20, 0), 1);
});
