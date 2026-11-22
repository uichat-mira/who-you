import type { CredentialKeys, CredentialRepository } from "./credentials";
import { GmailApiError, type GmailClient } from "./gmail-client";
import type { MailLimits } from "./limits";
import { GMAIL_BACKFILL_WINDOW_MS } from "./gmail-link";
import type { GmailOAuthClient } from "./oauth-client";
import {
	createOAuthMailImporter,
	finishOAuthSyncFailure,
	resolveOAuthAccessToken,
	type OAuthSyncCounters,
	type OAuthSyncDisposition,
	type OAuthSyncFailureCode,
} from "./oauth-sync";
import type { MailboxSyncState, SyncStateRepository } from "./sync-state";
import type { MailboxRecord, MailRepository } from "./store";

/**
 * Gmail incremental sync (S7c).
 *
 * The cursor is a small JSON object so history pagination survives a Worker
 * eviction. Backfill is bounded by the 30-day window and a 500-message cap; when
 * it finishes, the cursor captured at link time takes over. Every import goes
 * through the S1 ingestion pipeline, so Message-ID dedupe and object layout are
 * shared with own-domain mail.
 */

export const GMAIL_BACKFILL_MAX_MESSAGES = 500;
export const GMAIL_SYNC_MAX_MESSAGES_PER_RUN = 20;

export type GmailSyncFailureCode = OAuthSyncFailureCode | "sync_in_progress";

export type GmailSyncDependencies = {
	repository: MailRepository;
	limits: MailLimits;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	oauth: GmailOAuthClient;
	gmail: GmailClient;
	syncStates: SyncStateRepository;
	now: number;
};

export type GmailSyncOutcome =
	| {
			ok: true;
			imported: number;
			duplicates: number;
			skipped: number;
			mode: "backfill" | "history" | "idle";
	  }
	| { ok: false; code: GmailSyncFailureCode };

type HistoryCursor = {
	startHistoryId: string;
	pageToken: string | null;
	pendingIds?: string[];
	nextHistoryId?: string | null;
};

// Preserve IDs from a provider page without advancing past unprocessed mail.
const parsePendingIds = (value: unknown): string[] => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) {
		throw new Error("invalid_pending_ids");
	}
	return value as string[];
};

const parseHistoryCursor = (value: string): HistoryCursor | null => {
	try {
		const parsed = JSON.parse(value) as { startHistoryId?: unknown; pageToken?: unknown; pendingIds?: unknown; nextHistoryId?: unknown };
		if (typeof parsed.startHistoryId !== "string" || !parsed.startHistoryId) return null;
		if (parsed.pageToken !== null && typeof parsed.pageToken !== "string") return null;
		return {
			startHistoryId: parsed.startHistoryId,
			pageToken: (parsed.pageToken as string | null) ?? null,
			pendingIds: parsePendingIds(parsed.pendingIds),
			nextHistoryId: typeof parsed.nextHistoryId === "string" ? parsed.nextHistoryId : null,
		};
	} catch {
		return null;
	}
};

const parseBackfillPage = (value: string | null): { pageToken: string | null; seen: number; pendingIds: string[] } => {
	if (!value) return { pageToken: null, seen: 0, pendingIds: [] };
	try {
		const parsed = JSON.parse(value) as { pageToken?: unknown; seen?: unknown; pendingIds?: unknown };
		return {
			pageToken: typeof parsed.pageToken === "string" ? parsed.pageToken : null,
			seen: typeof parsed.seen === "number" && Number.isFinite(parsed.seen) ? parsed.seen : 0,
			pendingIds: parsePendingIds(parsed.pendingIds),
		};
	} catch {
		return { pageToken: null, seen: 0, pendingIds: [] };
	}
};

const encodeBackfillPage = (pageToken: string | null, seen: number, pendingIds: string[]): string =>
	JSON.stringify({ pageToken, seen, pendingIds });

const classifyGmailFailure = (error: unknown): OAuthSyncDisposition => {
	if (error instanceof GmailApiError) {
		if (error.code === "unauthorized") return "unauthorized";
		if (error.code === "provider_unreachable") return "unreachable";
	}
	return "other";
};

export async function syncGmailMailbox(
	deps: GmailSyncDependencies,
	mailbox: MailboxRecord,
): Promise<GmailSyncOutcome> {
	// One bounded batch per identity. The lease makes a second manual click, a
	// cron tick and a retry mutually exclusive; a busy caller imports nothing.
	const leaseId = `lease_${crypto.randomUUID()}`;
	const acquired = await deps.syncStates.acquireLease({
		mailboxId: mailbox.id,
		accountId: mailbox.accountId,
		provider: "gmail",
		leaseId,
		now: deps.now,
	});
	if (!acquired) return { ok: false, code: "sync_in_progress" };

	try {
		// Ownership is held for every awaited provider, D1 and R2 operation.
		// Recheck after admission: a stale scheduled snapshot cannot resurrect an
		// unlinked identity or use a disabled mailbox.
		const current = await deps.repository.findMailboxById(mailbox.accountId, mailbox.id);
		if (!current || current.status !== "active") return { ok: false, code: "sync_failed" };
		if ((await deps.syncStates.get(mailbox.id))?.lastError === "unlink_pending") {
			return { ok: false, code: "sync_failed" };
		}
		return await runGmailSyncBatch(deps, current);
	} finally {
		// Releasing after the batch (not before) keeps the guard honest even when
		// the provider call throws mid-import. A failed release cannot undo writes.
		await deps.syncStates.releaseLease(mailbox.id, leaseId, Date.now());
	}
}

async function runGmailSyncBatch(
	deps: GmailSyncDependencies,
	mailbox: MailboxRecord,
): Promise<GmailSyncOutcome> {
	const access = await resolveOAuthAccessToken(deps, mailbox, "gmail", (input) =>
		deps.oauth.refresh(input),
	);
	if (!access.ok) return access;
	const accessToken = access.accessToken;

	const existingState = await deps.syncStates.get(mailbox.id);
	let state: MailboxSyncState = existingState ?? {
		mailboxId: mailbox.id,
		provider: "gmail",
		cursor: null,
		backfillBefore: deps.now - GMAIL_BACKFILL_WINDOW_MS,
		backfillPage: null,
		backfillHistoryId: null,
		lastSyncedAt: null,
		lastError: null,
		leaseId: null,
		leaseExpiresAt: null,
	};

	const counters: OAuthSyncCounters = { imported: 0, duplicates: 0, skipped: 0 };
	const importMessage = createOAuthMailImporter<string>(
		deps,
		mailbox,
		counters,
		async (id) => {
			const message = await deps.gmail.getMessage(accessToken, id);
			return { raw: message.raw, receivedAt: message.internalDate };
		},
		// Only a missing message is a permanent fetch skip. Transient provider or
		// storage errors abort this batch so its cursor remains retryable.
		(error) => !(error instanceof GmailApiError && error.status === 404),
		true,
	);

	try {
		if (!state.cursor) {
			// Backfill: one page per run, capped at 500 messages per identity.
			if (state.backfillBefore === null) {
				state = { ...state, backfillBefore: deps.now - GMAIL_BACKFILL_WINDOW_MS };
			}
			const page = parseBackfillPage(state.backfillPage);
			if (!state.backfillHistoryId) {
				const profile = await deps.gmail.getProfile(accessToken);
				state = { ...state, backfillHistoryId: profile.historyId };
			}

			if (page.seen >= GMAIL_BACKFILL_MAX_MESSAGES) {
				state = {
					...state,
					cursor: JSON.stringify({ startHistoryId: state.backfillHistoryId ?? "0", pageToken: null }),
					backfillBefore: null,
					backfillPage: null,
					backfillHistoryId: null,
					lastSyncedAt: deps.now,
					lastError: null,
				};
				await deps.syncStates.upsert({ ...state, now: deps.now });
				return { ok: true, ...counters, mode: "idle" };
			}

			const listing = page.pendingIds.length
				? { ids: page.pendingIds, nextPageToken: page.pageToken }
				: await deps.gmail.listMessages(accessToken, {
					query: "newer_than:30d -in:sent",
					maxResults: GMAIL_SYNC_MAX_MESSAGES_PER_RUN,
					pageToken: page.pageToken ?? undefined,
				});
			const count = Math.min(GMAIL_SYNC_MAX_MESSAGES_PER_RUN, GMAIL_BACKFILL_MAX_MESSAGES - page.seen, listing.ids.length);
			for (const id of listing.ids.slice(0, count)) {
				await importMessage(id);
				page.seen += 1;
			}
			const pendingIds = listing.ids.slice(count);
			const finished = (!pendingIds.length && !listing.nextPageToken) || page.seen >= GMAIL_BACKFILL_MAX_MESSAGES;
			if (finished) {
				state = {
					...state,
					cursor: JSON.stringify({
						startHistoryId: state.backfillHistoryId ?? "0",
						pageToken: null,
					}),
					backfillBefore: null,
					backfillPage: null,
					backfillHistoryId: null,
				};
			} else {
				state = {
					...state,
					backfillPage: encodeBackfillPage(listing.nextPageToken, page.seen, pendingIds),
				};
			}
			state = { ...state, lastSyncedAt: deps.now, lastError: null };
			await deps.syncStates.upsert({ ...state, now: deps.now });
			return { ok: true, ...counters, mode: "backfill" };
		}

		const cursor = parseHistoryCursor(state.cursor);
		if (!cursor) {
			// A cursor we cannot read is treated as "never synced"; backfill is
			// idempotent, so this cannot duplicate rows.
			state = {
				...state,
				cursor: null,
				backfillBefore: deps.now - GMAIL_BACKFILL_WINDOW_MS,
				backfillPage: null,
				backfillHistoryId: null,
			};
			await deps.syncStates.upsert({ ...state, now: deps.now });
			return { ok: true, ...counters, mode: "idle" };
		}

		let history;
		try {
			history = cursor.pendingIds?.length
				? { messageIds: cursor.pendingIds, nextPageToken: cursor.pageToken, historyId: cursor.nextHistoryId ?? null }
				: await deps.gmail.listHistory(accessToken, {
				startHistoryId: cursor.startHistoryId,
				maxResults: GMAIL_SYNC_MAX_MESSAGES_PER_RUN,
				pageToken: cursor.pageToken ?? undefined,
			});
		} catch (error) {
			if (error instanceof GmailApiError && error.code === "history_expired") {
				// Expired cursor: fall back to a fresh bounded backfill. Rows are
				// deduped by Message-ID, so already-synced mail is not duplicated.
				const profile = await deps.gmail.getProfile(accessToken);
				state = {
					...state,
					cursor: null,
					backfillBefore: deps.now - GMAIL_BACKFILL_WINDOW_MS,
					backfillPage: null,
					backfillHistoryId: profile.historyId,
					lastError: "history_expired",
				};
				await deps.syncStates.upsert({ ...state, now: deps.now });
				return { ok: true, ...counters, mode: "idle" };
			}
			throw error;
		}

		for (const id of history.messageIds.slice(0, GMAIL_SYNC_MAX_MESSAGES_PER_RUN)) {
			await importMessage(id);
		}

		const pendingIds = history.messageIds.slice(GMAIL_SYNC_MAX_MESSAGES_PER_RUN);
		const nextCursor: HistoryCursor = pendingIds.length
			? { startHistoryId: cursor.startHistoryId, pageToken: history.nextPageToken, pendingIds, nextHistoryId: history.historyId }
			: history.nextPageToken
				? { startHistoryId: cursor.startHistoryId, pageToken: history.nextPageToken }
				: { startHistoryId: history.historyId ?? cursor.startHistoryId, pageToken: null };
		state = {
			...state,
			cursor: JSON.stringify(nextCursor),
			lastSyncedAt: deps.now,
			lastError: null,
		};
		await deps.syncStates.upsert({ ...state, now: deps.now });
		return { ok: true, ...counters, mode: "history" };
	} catch (error) {
		return finishOAuthSyncFailure(deps, mailbox, error, classifyGmailFailure);
	}
}
