import type { CredentialKeys, CredentialRepository } from "./credentials";
import { fetchRawMessage, ImapError, openImapSession, searchUids } from "./imap-client";
import type { MailLimits } from "./limits";
import { createOAuthMailImporter, type OAuthSyncCounters } from "./oauth-sync";
import type { RemoteTargetRepository } from "./remote-targets";
import type { MailConnection, MailTransport } from "./socket-transport";
import type { SyncStateRepository } from "./sync-state";
import type { MailboxRecord, MailRepository } from "./store";

/**
 * IMAP polling sync (S7e).
 *
 * The cursor is `{uidValidity,lastUid}`. A changed `UIDVALIDITY` invalidates the
 * UID space, so the cursor is cleared and the next run rescans the bounded
 * window; Message-ID dedupe keeps that idempotent. Backfill is capped at 500
 * messages over a 30-day window, with at most 20 consumed per run so one
 * identity cannot exhaust the CPU budget.
 */

export const IMAP_BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const IMAP_BACKFILL_MAX_MESSAGES = 500;
export const IMAP_SYNC_MAX_MESSAGES_PER_RUN = 20;

export type ImapSyncFailureCode =
	| "provider_credentials_not_configured"
	| "provider_unreachable"
	| "provider_tls_required"
	| "provider_auth_failed"
	| "credential_unavailable"
	| "sync_failed";

export type ImapSyncOutcome =
	| {
			ok: true;
			imported: number;
			duplicates: number;
			skipped: number;
			mode: "backfill" | "incremental" | "idle";
	  }
	| { ok: false; code: ImapSyncFailureCode };

export type ImapSyncDependencies = {
	repository: MailRepository;
	limits: MailLimits;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	syncStates: SyncStateRepository;
	remoteTargets: RemoteTargetRepository;
	transport: MailTransport | null;
	now: number;
};

type ImapCursor = { uidValidity: number; lastUid: number };
type BackfillProgress = { seen: number; lastUid: number };

const parseCursor = (value: string): ImapCursor | null => {
	try {
		const parsed = JSON.parse(value) as { uidValidity?: unknown; lastUid?: unknown };
		if (!Number.isInteger(parsed.uidValidity) || !Number.isInteger(parsed.lastUid)) return null;
		return { uidValidity: parsed.uidValidity as number, lastUid: parsed.lastUid as number };
	} catch {
		return null;
	}
};

const parseBackfill = (value: string | null): BackfillProgress => {
	if (!value) return { seen: 0, lastUid: 0 };
	try {
		const parsed = JSON.parse(value) as { seen?: unknown; lastUid?: unknown };
		return {
			seen: typeof parsed.seen === "number" && Number.isFinite(parsed.seen) ? parsed.seen : 0,
			lastUid:
				typeof parsed.lastUid === "number" && Number.isFinite(parsed.lastUid)
					? parsed.lastUid
					: 0,
		};
	} catch {
		return { seen: 0, lastUid: 0 };
	}
};

const mapSessionFailure = (error: unknown): ImapSyncFailureCode => {
	if (error instanceof ImapError) {
		if (error.code === "provider_auth_failed") return "provider_auth_failed";
		if (error.code === "provider_tls_required") return "provider_tls_required";
		if (error.code === "provider_unreachable") return "provider_unreachable";
		return "sync_failed";
	}
	return "provider_unreachable";
};

const recordFailure = async (
	deps: ImapSyncDependencies,
	mailbox: MailboxRecord,
	code: ImapSyncFailureCode,
): Promise<ImapSyncOutcome> => {
	await deps.syncStates.markError(mailbox.id, code, deps.now);
	return { ok: false, code };
};

const transportMode = (port: number): "implicit" | "starttls" =>
	port === 993 ? "implicit" : "starttls";

export async function syncImapMailbox(
	deps: ImapSyncDependencies,
	mailbox: MailboxRecord,
): Promise<ImapSyncOutcome> {
	if (mailbox.kind !== "third_party" || mailbox.provider !== "imap_smtp") {
		return { ok: false, code: "sync_failed" };
	}
	const transport = deps.transport;
	if (!deps.keys || !transport) {
		return { ok: false, code: "provider_credentials_not_configured" };
	}
	const keys = deps.keys;

	const credential = await deps.credentials.readActive({
		accountId: mailbox.accountId,
		mailboxId: mailbox.id,
		credentialType: "imap_password",
		keys,
	});
	if (!credential.ok) return recordFailure(deps, mailbox, "credential_unavailable");

	const target = await deps.remoteTargets.get(mailbox.id);
	if (!target) return recordFailure(deps, mailbox, "sync_failed");

	const counters: OAuthSyncCounters = { imported: 0, duplicates: 0, skipped: 0 };
	const importMessage = createOAuthMailImporter<number>(
		deps,
		mailbox,
		counters,
		async (uid) => ({
			raw: await fetchRawMessage(connection, uid, deps.limits.maxRawBytes),
			receivedAt: null,
		}),
		(error) => error instanceof ImapError && error.code === "provider_auth_failed",
	);

	let state = (await deps.syncStates.get(mailbox.id)) ?? {
		mailboxId: mailbox.id,
		provider: "imap_smtp" as const,
		cursor: null,
		backfillBefore: deps.now - IMAP_BACKFILL_WINDOW_MS,
		backfillPage: null,
		backfillHistoryId: null,
		lastSyncedAt: null,
		lastError: null,
	};

	let connection: MailConnection;
	try {
		connection = await transport.connect({
			host: target.imapHost,
			port: target.imapPort,
			tls: transportMode(target.imapPort),
		});
	} catch {
		return recordFailure(deps, mailbox, "provider_unreachable");
	}

	try {
		const session = await openImapSession(connection, {
			host: target.imapHost,
			tls: transportMode(target.imapPort),
			username: target.username,
			password: credential.secret,
		});
		const selected = await session.selectInbox();

		let cursor = state.cursor ? parseCursor(state.cursor) : null;
		if (cursor && cursor.uidValidity !== selected.uidValidity) {
			// UIDs from the previous validity window are meaningless; a rescan is
			// deduped by Message-ID, so clearing the cursor cannot duplicate rows.
			cursor = null;
			state = {
				...state,
				cursor: null,
				backfillBefore: state.backfillBefore ?? deps.now - IMAP_BACKFILL_WINDOW_MS,
				backfillPage: null,
				lastError: "uidvalidity_changed",
			};
		}
		if (!cursor && state.backfillBefore === null) {
			state = { ...state, backfillBefore: deps.now - IMAP_BACKFILL_WINDOW_MS };
		}

		const backfill = parseBackfill(state.backfillPage);
		const seen = cursor ? 0 : backfill.seen;
		const afterUid = cursor ? cursor.lastUid : backfill.lastUid;
		const limit = cursor
			? IMAP_SYNC_MAX_MESSAGES_PER_RUN
			: Math.max(0, Math.min(IMAP_SYNC_MAX_MESSAGES_PER_RUN, IMAP_BACKFILL_MAX_MESSAGES - seen));

		const mode: "backfill" | "incremental" | "idle" =
			limit === 0 ? "idle" : cursor ? "incremental" : "backfill";

		if (mode !== "idle") {
			const uids = await searchUids(connection, {
				since: cursor ? null : new Date(state.backfillBefore as number).toISOString(),
				afterUid: afterUid > 0 ? afterUid : null,
				limit,
			});

			let lastUid = afterUid;
			for (const uid of uids) {
				await importMessage(uid);
				lastUid = Math.max(lastUid, uid);
			}

			const uidValidity = selected.uidValidity;
			if (mode === "backfill") {
				const nextSeen = seen + uids.length;
				const finished = nextSeen >= IMAP_BACKFILL_MAX_MESSAGES || uids.length < limit;
				state = finished
					? {
							...state,
							cursor: JSON.stringify({
								uidValidity,
								lastUid: Math.max(lastUid, selected.uidNext - 1),
							}),
							backfillBefore: null,
							backfillPage: null,
							lastError: null,
						}
					: {
							...state,
							backfillPage: JSON.stringify({ seen: nextSeen, lastUid }),
							lastError: null,
						};
			} else {
				state = {
					...state,
					cursor: JSON.stringify({ uidValidity, lastUid }),
					lastError: null,
				};
			}
		}

		state = { ...state, lastSyncedAt: deps.now };
		await deps.syncStates.upsert({ ...state, now: deps.now });
		await session.close();
		return { ok: true, ...counters, mode };
	} catch (error) {
		return recordFailure(deps, mailbox, mapSessionFailure(error));
	} finally {
		await connection.close().catch(() => undefined);
	}
}
