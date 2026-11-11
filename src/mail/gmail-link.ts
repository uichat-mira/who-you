import type { CredentialKeys, CredentialRepository } from "./credentials";
import type { GmailClient } from "./gmail-client";
import type { MailLimits } from "./limits";
import {
	createOAuthState,
	createPkcePair,
	GOOGLE_AUTHORIZATION_ENDPOINT,
	GOOGLE_REVOCATION_ENDPOINT,
	GOOGLE_TOKEN_ENDPOINT,
	OAuthProviderError,
	type GmailOAuthClient,
	type GoogleOAuthConfig,
} from "./oauth-client";
import { OAUTH_STATE_TTL_MS, type OAuthStateRepository } from "./oauth-state";
import type { SyncStateRepository } from "./sync-state";
import type { MailRepository } from "./store";

/**
 * Gmail link lifecycle (S7c).
 *
 * `start` mints a PKCE pair and a one-time state; `complete` consumes the state,
 * exchanges the code, learns the Gmail address and only then creates the
 * mailbox. The refresh token is sealed before it is written, and the mailbox
 * address comes from Google rather than from caller input.
 */

export const GMAIL_CALLBACK_PATH = "/mail/oauth/gmail/callback";
export const GMAIL_BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type GmailOAuthEnv = {
	GMAIL_OAUTH_CLIENT_ID?: string;
	GMAIL_OAUTH_CLIENT_SECRET?: string;
	GMAIL_OAUTH_REDIRECT_URI?: string;
};

const ALLOWED_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Returns null unless all three values are present and the redirect is either
 * HTTPS or a loopback HTTP URL. A partial configuration must never half-enable
 * the provider.
 */
export function resolveGmailOAuthConfig(env: GmailOAuthEnv): GoogleOAuthConfig | null {
	const clientId = (env.GMAIL_OAUTH_CLIENT_ID ?? "").trim();
	const clientSecret = (env.GMAIL_OAUTH_CLIENT_SECRET ?? "").trim();
	const redirectUri = (env.GMAIL_OAUTH_REDIRECT_URI ?? "").trim();
	if (!clientId || !clientSecret || !redirectUri) return null;

	let parsed: URL;
	try {
		parsed = new URL(redirectUri);
	} catch {
		return null;
	}
	const secure = parsed.protocol === "https:";
	const loopback = parsed.protocol === "http:" && ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname);
	if (!secure && !loopback) return null;

	return {
		clientId,
		clientSecret,
		redirectUri,
		authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
		tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
		revocationEndpoint: GOOGLE_REVOCATION_ENDPOINT,
	};
}

export type StartGmailLinkDependencies = {
	states: OAuthStateRepository;
	oauth: GmailOAuthClient;
	redirectUri: string;
};

export async function startGmailLink(
	deps: StartGmailLinkDependencies,
	input: { accountId: string; now: number },
): Promise<{ authorizationUrl: string; state: string; expiresAt: number }> {
	const { verifier, challenge } = await createPkcePair();
	const state = createOAuthState();
	const expiresAt = input.now + OAUTH_STATE_TTL_MS;
	await deps.states.create({
		state,
		accountId: input.accountId,
		provider: "gmail",
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

export type GmailLinkFailureCode =
	| "invalid_state"
	| "provider_reauth_required"
	| "provider_scope_missing"
	| "provider_unreachable"
	| "provider_misconfigured"
	| "credential_vault_unavailable"
	| "address_already_linked"
	| "link_failed";

export type CompleteGmailLinkResult =
	| { ok: true; mailboxId: string; address: string; relinked: boolean }
	| { ok: false; code: GmailLinkFailureCode };

export type CompleteGmailLinkDependencies = {
	repository: MailRepository;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	states: OAuthStateRepository;
	syncStates: SyncStateRepository;
	oauth: GmailOAuthClient;
	gmail: GmailClient;
	limits: MailLimits;
	now: number;
};

const mapOAuthFailure = (error: OAuthProviderError): GmailLinkFailureCode => {
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

const normalizeAddress = (value: string): string | null => {
	const address = value.trim().toLowerCase();
	if (!address || address.length > 320) return null;
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return null;
	return address;
};

export async function completeGmailLink(
	deps: CompleteGmailLinkDependencies,
	input: { code: string; state: string },
): Promise<CompleteGmailLinkResult> {
	const state = await deps.states.consume(input.state, deps.now);
	if (!state || state.provider !== "gmail") return { ok: false, code: "invalid_state" };

	let tokens;
	try {
		tokens = await deps.oauth.exchangeCode({
			code: input.code,
			codeVerifier: state.codeVerifier,
		});
	} catch (error) {
		if (error instanceof OAuthProviderError) {
			return { ok: false, code: mapOAuthFailure(error) };
		}
		return { ok: false, code: "provider_unreachable" };
	}
	if (!tokens.refreshToken) return { ok: false, code: "provider_reauth_required" };

	let profile;
	try {
		profile = await deps.gmail.getProfile(tokens.accessToken);
	} catch {
		return { ok: false, code: "provider_unreachable" };
	}
	const address = normalizeAddress(profile.emailAddress);
	if (!address) return { ok: false, code: "provider_misconfigured" };

	const existing = await deps.repository.findMailboxByAddress(address);
	if (existing && existing.accountId !== state.accountId) {
		return { ok: false, code: "address_already_linked" };
	}
	if (existing && (existing.kind !== "third_party" || existing.provider !== "gmail")) {
		return { ok: false, code: "address_already_linked" };
	}
	if (!deps.keys) return { ok: false, code: "credential_vault_unavailable" };

	const mailboxId =
		existing?.id ?? `mbx_${crypto.randomUUID().replace(/-/g, "")}`;
	const relinked = Boolean(existing);
	if (!existing) {
		const inserted = await deps.repository.insertMailbox({
			id: mailboxId,
			accountId: state.accountId,
			address,
			localPart: address.slice(0, address.lastIndexOf("@")),
			kind: "third_party",
			provider: "gmail",
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
		provider: "gmail",
		credentialType: "oauth_refresh",
		secret: tokens.refreshToken,
		scope: tokens.scope ?? "",
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
		provider: "gmail",
		cursor: null,
		backfillBefore: deps.now - GMAIL_BACKFILL_WINDOW_MS,
		backfillPage: null,
		backfillHistoryId: profile.historyId,
		lastSyncedAt: null,
		lastError: null,
		now: deps.now,
	});

	await deps.repository.insertAudit({
		id: `audit_${crypto.randomUUID()}`,
		accountId: state.accountId,
		action: "link_mailbox",
		targetId: mailboxId,
		detail: "provider=gmail",
		createdAt: deps.now,
	});

	return { ok: true, mailboxId, address, relinked };
}
