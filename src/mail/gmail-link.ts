import type { CredentialKeys, CredentialRepository } from "./credentials";
import type { GmailClient } from "./gmail-client";
import type { MailLimits } from "./limits";
import {
	completeOAuthLink,
	startOAuthLink,
	type CompleteOAuthLinkResult,
	type OAuthLinkFailureCode,
} from "./oauth-link";
import {
	GOOGLE_AUTHORIZATION_ENDPOINT,
	GOOGLE_REVOCATION_ENDPOINT,
	GOOGLE_TOKEN_ENDPOINT,
	OAuthProviderError,
	type GmailOAuthClient,
	type GoogleOAuthConfig,
} from "./oauth-client";
import { OAUTH_BACKFILL_WINDOW_MS, resolveOAuthClientEnv } from "./oauth-shared";
import type { OAuthStateRepository } from "./oauth-state";
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
export const GMAIL_BACKFILL_WINDOW_MS = OAUTH_BACKFILL_WINDOW_MS;

export type GmailOAuthEnv = {
	GMAIL_OAUTH_CLIENT_ID?: string;
	GMAIL_OAUTH_CLIENT_SECRET?: string;
	GMAIL_OAUTH_REDIRECT_URI?: string;
};

/** Returns null unless all three values are present and the redirect is secure. */
export function resolveGmailOAuthConfig(env: GmailOAuthEnv): GoogleOAuthConfig | null {
	const base = resolveOAuthClientEnv({
		clientId: env.GMAIL_OAUTH_CLIENT_ID,
		clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET,
		redirectUri: env.GMAIL_OAUTH_REDIRECT_URI,
	});
	if (!base) return null;
	return {
		...base,
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
	return startOAuthLink(
		{
			provider: "gmail",
			states: deps.states,
			oauth: deps.oauth,
			redirectUri: deps.redirectUri,
		},
		input,
	);
}

export type GmailLinkFailureCode = OAuthLinkFailureCode;
export type CompleteGmailLinkResult = CompleteOAuthLinkResult;

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

export async function completeGmailLink(
	deps: CompleteGmailLinkDependencies,
	input: { code: string; state: string },
): Promise<CompleteGmailLinkResult> {
	return completeOAuthLink(
		{
			provider: "gmail",
			repository: deps.repository,
			credentials: deps.credentials,
			keys: deps.keys,
			states: deps.states,
			syncStates: deps.syncStates,
			limits: deps.limits,
			now: deps.now,
			backfillWindowMs: GMAIL_BACKFILL_WINDOW_MS,
			exchange: async ({ code, codeVerifier }) => {
				const tokens = await deps.oauth.exchangeCode({ code, codeVerifier });
				if (!tokens.refreshToken) throw new OAuthProviderError("missing_refresh_token");
				let profile;
				try {
					profile = await deps.gmail.getProfile(tokens.accessToken);
				} catch {
					throw new OAuthProviderError("provider_unreachable");
				}
				return {
					refreshToken: tokens.refreshToken,
					scope: tokens.scope,
					address: profile.emailAddress,
					backfillHistoryId: profile.historyId,
				};
			},
		},
		input,
	);
}
