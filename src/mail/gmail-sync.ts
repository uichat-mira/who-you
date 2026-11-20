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

export type GmailSyncFailureCode = OAuthSyncFailureCode;

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

type HistoryCursor = { startHistoryId: string; pageToken: string | null };

const parseHistoryCursor = (value: string): HistoryCursor | null => {
	try {
		const parsed = JSON.parse(value) as { startHistoryId?: unknown; pageToken?: unknown };
		if (typeof parsed.startHistoryId !== "string" || !parsed.startHistoryId) return null;
		if (parsed.pageToken !== null && typeof parsed.pageToken !== "string") return null;
		return {
			startHistoryId: parsed.startHistoryId,
			pageToken: (parsed.pageToken as string | null) ?? null,
		};
	} catch {
		return null;
	}
};

const parseBackfillPage = (value: string | null): { pageToken: string | null; seen: number } => {
	if (!value) return { pageToken: null, seen: 0 };
	try {
		const parsed = JSON.parse(value) as { pageToken?: unknown; seen?: unknown };
		return {
			pageToken: typeof parsed.pageToken === "string" ? parsed.pageToken : null,
			seen: typeof parsed.seen === "number" && Number.isFinite(parsed.seen) ? parsed.seen : 0,
		};
	} catch {
		return { pageToken: null, seen: 0 };
	}
};

const encodeBackfillPage = (pageToken: string | null, seen: number): string =>
	JSON.stringify({ pageToken, seen });

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
		(error) => error instanceof GmailApiError && error.code === "unauthorized",
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

			const listing = await deps.gmail.listMessages(accessToken, {
				query: "newer_than:30d -in:sent",
				maxResults: GMAIL_SYNC_MAX_MESSAGES_PER_RUN,
				pageToken: page.pageToken ?? undefined,
			});
			for (const id of listing.ids) {
				if (page.seen >= GMAIL_BACKFILL_MAX_MESSAGES) break;
				const advanced = await importMessage(id);
				if (advanced) page.seen += 1;
			}

			const finished = !listing.nextPageToken || page.seen >= GMAIL_BACKFILL_MAX_MESSAGES;
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
					backfillPage: encodeBackfillPage(listing.nextPageToken, page.seen),
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
			history = await deps.gmail.listHistory(accessToken, {
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

		const nextCursor: HistoryCursor = history.nextPageToken
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
