import type { CredentialKeys, CredentialRepository } from "./credentials";
import type { MailLimits } from "./limits";
import { createOAuthState, createPkcePair } from "./oauth-client";
import {
	OAuthProviderError,
	OAUTH_BACKFILL_WINDOW_MS,
} from "./oauth-shared";
import { OAUTH_STATE_TTL_MS, type OAuthStateRepository } from "./oauth-state";
import type { SyncStateRepository } from "./sync-state";
import type { MailboxProvider, MailRepository } from "./store";

/**
 * Shared third-party link lifecycle (S7c/S7d).
 *
 * `start` mints PKCE + a one-time state. `complete` consumes the state,
 * exchanges the code through the provider-specific closure, takes the mailbox
 * address from the provider (never from caller input), seals the refresh token
 * and records the sync cursor. Re-consent replaces the sealed token.
 */

export type OAuthLinkFailureCode =
	| "invalid_state"
	| "provider_reauth_required"
	| "provider_scope_missing"
	| "provider_unreachable"
	| "provider_misconfigured"
	| "credential_vault_unavailable"
	| "address_already_linked"
	| "link_failed";

export type CompleteOAuthLinkResult =
	| { ok: true; mailboxId: string; address: string; relinked: boolean }
	| { ok: false; code: OAuthLinkFailureCode };

/** What a successful code exchange must yield for the link to proceed. */
export type OAuthLinkIdentity = {
	refreshToken: string;
	scope: string | null;
	address: string;
	/** Provider-specific starting point for the first incremental sync. */
	backfillHistoryId: string | null;
};

export type StartOAuthLinkDependencies = {
	provider: MailboxProvider;
	states: OAuthStateRepository;
	oauth: { authorizationUrl(input: { state: string; codeChallenge: string }): string };
	redirectUri: string;
};

export async function startOAuthLink(
	deps: StartOAuthLinkDependencies,
	input: { accountId: string; now: number },
): Promise<{ authorizationUrl: string; state: string; expiresAt: number }> {
	const { verifier, challenge } = await createPkcePair();
	const state = createOAuthState();
	const expiresAt = input.now + OAUTH_STATE_TTL_MS;
	await deps.states.create({
		state,
		accountId: input.accountId,
		provider: deps.provider,
		codeVerifier: verifier,
		redirectUri: deps.redirectUri,
		createdAt: input.now,
		expiresAt,
	});
	return {
		authorizationUrl: deps.oauth.authorizationUrl({ state, codeChallenge: challenge }),
		state,
		expiresAt,
	};
}

export type CompleteOAuthLinkDependencies = {
	provider: MailboxProvider;
	repository: MailRepository;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	states: OAuthStateRepository;
	syncStates: SyncStateRepository;
	limits: MailLimits;
	now: number;
	backfillWindowMs?: number;
	exchange: (input: { code: string; codeVerifier: string }) => Promise<OAuthLinkIdentity>;
};

const mapOAuthFailure = (error: OAuthProviderError): OAuthLinkFailureCode => {
	switch (error.code) {
		case "invalid_grant":
		case "missing_refresh_token":
			return "provider_reauth_required";
		case "provider_scope_missing":
			return "provider_scope_missing";
		case "provider_unreachable":
			return "provider_unreachable";
		default:
			return "provider_misconfigured";
	}
};

/**
 * Linear-time shape check: one `@`, no whitespace, and a dot in the domain.
 * Avoids the backtracking regexes Sonar flags on address validation.
 */
const normalizeAddress = (value: string): string | null => {
	const address = value.trim().toLowerCase();
	if (!address || address.length > 320) return null;
	const at = address.indexOf("@");
	if (at <= 0 || at !== address.lastIndexOf("@")) return null;
	const domain = address.slice(at + 1);
	if (!domain.includes(".")) return null;
	for (const char of address) {
		if (char === "@") continue;
		if (char.trim() === "" || char === "<" || char === ">") return null;
	}
	return address;
};

export async function completeOAuthLink(
	deps: CompleteOAuthLinkDependencies,
	input: { code: string; state: string },
): Promise<CompleteOAuthLinkResult> {
	const state = await deps.states.consume(input.state, deps.now);
	if (!state || state.provider !== deps.provider) return { ok: false, code: "invalid_state" };

	let identity: OAuthLinkIdentity;
	try {
		identity = await deps.exchange({
			code: input.code,
			codeVerifier: state.codeVerifier,
		});
	} catch (error) {
		return {
			ok: false,
			code: error instanceof OAuthProviderError ? mapOAuthFailure(error) : "provider_unreachable",
		};
	}
	if (!identity.refreshToken) return { ok: false, code: "provider_reauth_required" };

	const address = normalizeAddress(identity.address);
	if (!address) return { ok: false, code: "provider_misconfigured" };

	const existing = await deps.repository.findMailboxByAddress(address);
	if (existing && existing.accountId !== state.accountId) {
		return { ok: false, code: "address_already_linked" };
	}
	if (existing && (existing.kind !== "third_party" || existing.provider !== deps.provider)) {
		return { ok: false, code: "address_already_linked" };
	}
	if (!deps.keys) return { ok: false, code: "credential_vault_unavailable" };

	const mailboxId = existing?.id ?? `mbx_${crypto.randomUUID().replace(/-/g, "")}`;
	const relinked = Boolean(existing);
	if (!existing) {
		const inserted = await deps.repository.insertMailbox({
			id: mailboxId,
			accountId: state.accountId,
			address,
			localPart: address.slice(0, address.lastIndexOf("@")),
			kind: "third_party",
			provider: deps.provider,
			quotaBytes: deps.limits.mailboxQuotaBytes,
			now: deps.now,
		});
		if (!inserted) return { ok: false, code: "address_already_linked" };
	} else {
		// Re-consent replaces the sealed token; the old one can no longer send.
		await deps.credentials.revoke({
			accountId: state.accountId,
			mailboxId,
			credentialType: "oauth_refresh",
			now: deps.now,
		});
	}

	const stored = await deps.credentials.store({
		accountId: state.accountId,
		mailboxId,
		provider: deps.provider,
		credentialType: "oauth_refresh",
		secret: identity.refreshToken,
		scope: identity.scope ?? "",
		keys: deps.keys,
		now: deps.now,
	});
	if (!stored.ok) {
		if (!relinked) {
			await deps.repository.deleteMailboxScoped(mailboxId);
		}
		return { ok: false, code: "link_failed" };
	}

	await deps.syncStates.upsert({
		mailboxId,
		provider: deps.provider,
		cursor: null,
		backfillBefore: deps.now - (deps.backfillWindowMs ?? OAUTH_BACKFILL_WINDOW_MS),
		backfillPage: null,
		backfillHistoryId: identity.backfillHistoryId,
		lastSyncedAt: null,
		lastError: null,
		now: deps.now,
	});

	await deps.repository.insertAudit({
		id: `audit_${crypto.randomUUID()}`,
		accountId: state.accountId,
		action: "link_mailbox",
		targetId: mailboxId,
		detail: `provider=${deps.provider}`,
		createdAt: deps.now,
	});

	return { ok: true, mailboxId, address, relinked };
}
