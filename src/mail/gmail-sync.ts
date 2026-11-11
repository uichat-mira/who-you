import type { CredentialFailureCode, CredentialKeys, CredentialRepository } from "./credentials";
import { GmailApiError, type GmailClient } from "./gmail-client";
import { readHeaderValue, ingestRawMail } from "./ingest";
import type { MailLimits } from "./limits";
import { OAuthProviderError, type GmailOAuthClient } from "./oauth-client";
import type { MailboxSyncState, SyncStateRepository } from "./sync-state";
import type { MailboxRecord, MailRepository } from "./store";
import { GMAIL_BACKFILL_WINDOW_MS } from "./gmail-link";

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

export type GmailSyncFailureCode =
	| "provider_credentials_not_configured"
	| "provider_reauth_required"
	| "provider_unreachable"
	| "credential_unavailable"
	| "sync_failed";

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

const asCredentialFailure = (code: CredentialFailureCode): GmailSyncFailureCode =>
	code === "credential_reauth_required" ? "provider_reauth_required" : "credential_unavailable";

export async function syncGmailMailbox(
	deps: GmailSyncDependencies,
	mailbox: MailboxRecord,
): Promise<GmailSyncOutcome> {
	if (!deps.keys) return { ok: false, code: "provider_credentials_not_configured" };
	if (mailbox.provider !== "gmail" || mailbox.kind !== "third_party") {
		return { ok: false, code: "sync_failed" };
	}

	const credential = await deps.credentials.readActive({
		accountId: mailbox.accountId,
		mailboxId: mailbox.id,
		credentialType: "oauth_refresh",
		keys: deps.keys,
	});
	if (!credential.ok) {
		const code = asCredentialFailure(credential.code);
		await deps.syncStates.markError(mailbox.id, code, deps.now);
		return { ok: false, code };
	}

	let accessToken: string;
	try {
		const refreshed = await deps.oauth.refresh({ refreshToken: credential.secret });
		accessToken = refreshed.accessToken;
	} catch (error) {
		if (error instanceof OAuthProviderError) {
			if (error.code === "invalid_grant") {
				await deps.credentials.markReauth({
					accountId: mailbox.accountId,
					mailboxId: mailbox.id,
					credentialType: "oauth_refresh",
					now: deps.now,
				});
				await deps.syncStates.markError(mailbox.id, "provider_reauth_required", deps.now);
				return { ok: false, code: "provider_reauth_required" };
			}
			if (error.code === "provider_unreachable") {
				await deps.syncStates.markError(mailbox.id, "provider_unreachable", deps.now);
				return { ok: false, code: "provider_unreachable" };
			}
		}
		await deps.syncStates.markError(mailbox.id, "sync_failed", deps.now);
		return { ok: false, code: "sync_failed" };
	}

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

	const counters = { imported: 0, duplicates: 0, skipped: 0 };

	const importMessage = async (id: string): Promise<boolean> => {
		let message;
		try {
			message = await deps.gmail.getMessage(accessToken, id);
		} catch (error) {
			if (error instanceof GmailApiError && error.code === "unauthorized") {
				throw error;
			}
			counters.skipped += 1;
			return false;
		}
		if (message.raw.byteLength > deps.limits.maxRawBytes) {
			counters.skipped += 1;
			return true;
		}
		const fromHeader = (readHeaderValue(message.raw, "from") ?? "").toLowerCase();
		const direction = fromHeader.includes(mailbox.address.toLowerCase())
			? "outbound"
			: "inbound";
		const result = await ingestRawMail({
			repository: deps.repository,
			limits: deps.limits,
			mailbox,
			raw: message.raw,
			envelopeFrom: mailbox.address,
			receivedAt: message.internalDate ?? deps.now,
			direction,
		});
		if (!result.ok) {
			counters.skipped += 1;
			return true;
		}
		if (result.duplicate) counters.duplicates += 1;
		else counters.imported += 1;
		return true;
	};

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
		if (error instanceof GmailApiError && error.code === "unauthorized") {
			await deps.credentials.markReauth({
				accountId: mailbox.accountId,
				mailboxId: mailbox.id,
				credentialType: "oauth_refresh",
				now: deps.now,
			});
			await deps.syncStates.markError(mailbox.id, "provider_reauth_required", deps.now);
			return { ok: false, code: "provider_reauth_required" };
		}
		if (error instanceof GmailApiError && error.code === "provider_unreachable") {
			await deps.syncStates.markError(mailbox.id, "provider_unreachable", deps.now);
			return { ok: false, code: "provider_unreachable" };
		}
		await deps.syncStates.markError(mailbox.id, "sync_failed", deps.now);
		return { ok: false, code: "sync_failed" };
	}
}
