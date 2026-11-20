import type { CredentialKeys, CredentialRepository } from "./credentials";
import type { MailLimits } from "./limits";
import { GraphApiError, type GraphClient, type GraphDeltaMessage } from "./microsoft-client";
import { MICROSOFT_BACKFILL_WINDOW_MS } from "./microsoft-link";
import type { MicrosoftOAuthClient } from "./microsoft-oauth";
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
 * Microsoft Graph inbox sync (S7d).
 *
 * The first round is a bounded delta enumeration filtered to the last 30 days;
 * later rounds walk the `@odata.deltaLink` so only changes arrive. Both the
 * backfill position and the delta cursor are small JSON objects so a Worker
 * eviction never loses the position. Imports go through the S1 ingestion
 * pipeline, so Message-ID dedupe and object layout match own-domain mail.
 */

export const MICROSOFT_BACKFILL_MAX_MESSAGES = 500;
export const MICROSOFT_SYNC_MAX_MESSAGES_PER_RUN = 20;

export type MicrosoftSyncFailureCode = OAuthSyncFailureCode;

export type MicrosoftSyncDependencies = {
	repository: MailRepository;
	limits: MailLimits;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	oauth: MicrosoftOAuthClient;
	microsoft: GraphClient;
	syncStates: SyncStateRepository;
	now: number;
};

export type MicrosoftSyncOutcome =
	| {
			ok: true;
			imported: number;
			duplicates: number;
			skipped: number;
			mode: "backfill" | "delta" | "idle";
	  }
	| { ok: false; code: MicrosoftSyncFailureCode };

type DeltaCursor = { link: string };

const parseDeltaCursor = (value: string): DeltaCursor | null => {
	try {
		const parsed = JSON.parse(value) as { link?: unknown };
		if (typeof parsed.link !== "string" || !parsed.link) return null;
		return { link: parsed.link };
	} catch {
		return null;
	}
};

const parseBackfillPage = (value: string | null): { link: string | null; seen: number } => {
	if (!value) return { link: null, seen: 0 };
	try {
		const parsed = JSON.parse(value) as { link?: unknown; seen?: unknown };
		return {
			link: typeof parsed.link === "string" && parsed.link ? parsed.link : null,
			seen: typeof parsed.seen === "number" && Number.isFinite(parsed.seen) ? parsed.seen : 0,
		};
	} catch {
		return { link: null, seen: 0 };
	}
};

const encodeBackfillPage = (link: string | null, seen: number): string =>
	JSON.stringify({ link, seen });

const classifyMicrosoftFailure = (error: unknown): OAuthSyncDisposition => {
	if (error instanceof GraphApiError) {
		if (error.code === "unauthorized") return "unauthorized";
		if (error.code === "provider_unreachable") return "unreachable";
	}
	return "other";
};

export async function syncMicrosoftMailbox(
	deps: MicrosoftSyncDependencies,
	mailbox: MailboxRecord,
): Promise<MicrosoftSyncOutcome> {
	const access = await resolveOAuthAccessToken(deps, mailbox, "microsoft", (input) =>
		deps.oauth.refresh(input),
	);
	if (!access.ok) return access;
	const accessToken = access.accessToken;

	const existingState = await deps.syncStates.get(mailbox.id);
	let state: MailboxSyncState = existingState ?? {
		mailboxId: mailbox.id,
		provider: "microsoft",
		cursor: null,
		backfillBefore: deps.now - MICROSOFT_BACKFILL_WINDOW_MS,
		backfillPage: null,
		backfillHistoryId: null,
		lastSyncedAt: null,
		lastError: null,
	};

	const counters: OAuthSyncCounters = { imported: 0, duplicates: 0, skipped: 0 };
	const importMessage = createOAuthMailImporter<GraphDeltaMessage>(
		deps,
		mailbox,
		counters,
		async (entry) => {
			const message = await deps.microsoft.getMessageMime(accessToken, entry.id);
			return { raw: message.raw, receivedAt: entry.receivedAt };
		},
		(error) => error instanceof GraphApiError && error.code === "unauthorized",
	);

	try {
		if (!state.cursor) {
			// Backfill: one delta page per run, at most 500 imported messages per
			// identity. Paging continues past the cap until Graph hands us the
			// deltaLink, otherwise the cursor could never be established.
			if (state.backfillBefore === null) {
				state = { ...state, backfillBefore: deps.now - MICROSOFT_BACKFILL_WINDOW_MS };
			}
			const page = parseBackfillPage(state.backfillPage);
			const deltaPage = await deps.microsoft.listInboxDelta(
				accessToken,
				page.link !== null
					? { link: page.link }
					: { since: state.backfillBefore ?? deps.now - MICROSOFT_BACKFILL_WINDOW_MS },
			);
			let seen = page.seen;
			for (const entry of deltaPage.messages) {
				if (seen >= MICROSOFT_BACKFILL_MAX_MESSAGES) break;
				const advanced = await importMessage(entry);
				if (advanced) seen += 1;
			}

			if (deltaPage.deltaLink) {
				state = {
					...state,
					cursor: JSON.stringify({ link: deltaPage.deltaLink }),
					backfillBefore: null,
					backfillPage: null,
					backfillHistoryId: null,
				};
			} else {
				state = {
					...state,
					backfillPage: encodeBackfillPage(deltaPage.nextLink, seen),
				};
			}
			state = { ...state, lastSyncedAt: deps.now, lastError: null };
			await deps.syncStates.upsert({ ...state, now: deps.now });
			return { ok: true, ...counters, mode: "backfill" };
		}

		const cursor = parseDeltaCursor(state.cursor);
		if (!cursor) {
			// An unreadable cursor is treated as "never synced"; backfill is
			// idempotent, so already-imported mail is deduped by Message-ID.
			state = {
				...state,
				cursor: null,
				backfillBefore: deps.now - MICROSOFT_BACKFILL_WINDOW_MS,
				backfillPage: null,
				backfillHistoryId: null,
			};
			await deps.syncStates.upsert({ ...state, now: deps.now });
			return { ok: true, ...counters, mode: "idle" };
		}

		let deltaPage;
		try {
			deltaPage = await deps.microsoft.listInboxDelta(accessToken, { link: cursor.link });
		} catch (error) {
			if (error instanceof GraphApiError && error.code === "cursor_expired") {
				// Expired delta token: fall back to the bounded backfill window.
				state = {
					...state,
					cursor: null,
					backfillBefore: deps.now - MICROSOFT_BACKFILL_WINDOW_MS,
					backfillPage: null,
					backfillHistoryId: null,
					lastError: "cursor_expired",
				};
				await deps.syncStates.upsert({ ...state, now: deps.now });
				return { ok: true, ...counters, mode: "idle" };
			}
			throw error;
		}

		for (const entry of deltaPage.messages.slice(0, MICROSOFT_SYNC_MAX_MESSAGES_PER_RUN)) {
			await importMessage(entry);
		}

		const next: DeltaCursor = deltaPage.deltaLink
			? { link: deltaPage.deltaLink }
			: deltaPage.nextLink
				? { link: deltaPage.nextLink }
				: cursor;
		state = {
			...state,
			cursor: JSON.stringify(next),
			lastSyncedAt: deps.now,
			lastError: null,
		};
		await deps.syncStates.upsert({ ...state, now: deps.now });
		return { ok: true, ...counters, mode: "delta" };
	} catch (error) {
		return finishOAuthSyncFailure(deps, mailbox, error, classifyMicrosoftFailure);
	}
}
