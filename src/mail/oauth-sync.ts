import type { CredentialFailureCode, CredentialKeys, CredentialRepository } from "./credentials";
import { ingestRawMail, readHeaderValue } from "./ingest";
import type { MailLimits } from "./limits";
import { OAuthProviderError } from "./oauth-shared";
import type { SyncStateRepository } from "./sync-state";
import type { MailboxProvider, MailboxRecord, MailRepository } from "./store";

/**
 * Shared OAuth mailbox sync plumbing (S7c/S7d).
 *
 * Credential handling, token refresh, failure mapping and the ingestion call
 * are identical for every provider; only the cursor shape and the message
 * listing differ, so those stay in the provider modules.
 */

export type OAuthSyncFailureCode =
	| "provider_credentials_not_configured"
	| "provider_reauth_required"
	| "provider_unreachable"
	| "provider_tls_required"
	| "provider_auth_failed"
	| "credential_unavailable"
	| "sync_failed";

export type OAuthSyncCounters = { imported: number; duplicates: number; skipped: number };

export type OAuthSyncBaseDependencies = {
	repository: MailRepository;
	limits: MailLimits;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	syncStates: SyncStateRepository;
	now: number;
};

export type OAuthAccessResult =
	| { ok: true; accessToken: string }
	| { ok: false; code: OAuthSyncFailureCode };

const asCredentialFailureCode = (code: CredentialFailureCode): OAuthSyncFailureCode =>
	code === "credential_reauth_required" ? "provider_reauth_required" : "credential_unavailable";

/**
 * Guards provider/kind, unseals the refresh token and exchanges it for a
 * short-lived access token. Every failure records a fixed reason on the
 * mailbox and returns the mapped code.
 */
export async function resolveOAuthAccessToken(
	deps: OAuthSyncBaseDependencies,
	mailbox: MailboxRecord,
	expectedProvider: MailboxProvider,
	refresh: (input: { refreshToken: string }) => Promise<{ accessToken: string }>,
): Promise<OAuthAccessResult> {
	if (!deps.keys) return { ok: false, code: "provider_credentials_not_configured" };
	if (mailbox.provider !== expectedProvider || mailbox.kind !== "third_party") {
		return { ok: false, code: "sync_failed" };
	}

	const credential = await deps.credentials.readActive({
		accountId: mailbox.accountId,
		mailboxId: mailbox.id,
		credentialType: "oauth_refresh",
		keys: deps.keys,
	});
	if (!credential.ok) {
		const code = asCredentialFailureCode(credential.code);
		await deps.syncStates.markError(mailbox.id, code, deps.now);
		return { ok: false, code };
	}

	try {
		const refreshed = await refresh({ refreshToken: credential.secret });
		return { ok: true, accessToken: refreshed.accessToken };
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
}

export type FetchedOAuthMessage = { raw: Uint8Array; receivedAt: number | null };

/**
 * Builds the per-message importer. `true` means the entry consumed a backfill
 * slot; a fetch error other than authorization is skipped without consuming
 * one, so a single bad message cannot stall the cursor forever.
 */
export function createOAuthMailImporter<T>(
	deps: OAuthSyncBaseDependencies,
	mailbox: MailboxRecord,
	counters: OAuthSyncCounters,
	fetchMessage: (entry: T) => Promise<FetchedOAuthMessage>,
	isUnauthorized: (error: unknown) => boolean,
): (entry: T) => Promise<boolean> {
	return async (entry) => {
		let message: FetchedOAuthMessage;
		try {
			message = await fetchMessage(entry);
		} catch (error) {
			if (isUnauthorized(error)) throw error;
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
			receivedAt: message.receivedAt ?? deps.now,
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
}

export type OAuthSyncDisposition = "unauthorized" | "unreachable" | "other";

/** Maps the provider-specific error at the outer boundary to a fixed code. */
export async function finishOAuthSyncFailure(
	deps: OAuthSyncBaseDependencies,
	mailbox: MailboxRecord,
	error: unknown,
	classify: (error: unknown) => OAuthSyncDisposition,
): Promise<{ ok: false; code: OAuthSyncFailureCode }> {
	const disposition = classify(error);
	if (disposition === "unauthorized") {
		await deps.credentials.markReauth({
			accountId: mailbox.accountId,
			mailboxId: mailbox.id,
			credentialType: "oauth_refresh",
			now: deps.now,
		});
		await deps.syncStates.markError(mailbox.id, "provider_reauth_required", deps.now);
		return { ok: false, code: "provider_reauth_required" };
	}
	if (disposition === "unreachable") {
		await deps.syncStates.markError(mailbox.id, "provider_unreachable", deps.now);
		return { ok: false, code: "provider_unreachable" };
	}
	await deps.syncStates.markError(mailbox.id, "sync_failed", deps.now);
	return { ok: false, code: "sync_failed" };
}
