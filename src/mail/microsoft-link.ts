import type { CredentialKeys, CredentialRepository } from "./credentials";
import type { MailLimits } from "./limits";
import {
	addressFromMicrosoftIdToken,
	buildMicrosoftEndpoints,
	isValidMicrosoftTenant,
	MICROSOFT_DEFAULT_TENANT,
	type MicrosoftOAuthClient,
	type MicrosoftOAuthConfig,
} from "./microsoft-oauth";
import {
	completeOAuthLink,
	startOAuthLink,
	type CompleteOAuthLinkResult,
	type OAuthLinkFailureCode,
} from "./oauth-link";
import { OAuthProviderError, OAUTH_BACKFILL_WINDOW_MS, resolveOAuthClientEnv } from "./oauth-shared";
import type { OAuthStateRepository } from "./oauth-state";
import type { SyncStateRepository } from "./sync-state";
import type { MailRepository } from "./store";

/**
 * Microsoft link lifecycle (S7d).
 *
 * Mirrors the Gmail slice: `start` mints PKCE + a one-time state; `complete`
 * consumes the state, exchanges the code and takes the mailbox address from the
 * provider's ID token. Caller input never names the identity.
 */

export const MICROSOFT_CALLBACK_PATH = "/mail/oauth/microsoft/callback";
export const MICROSOFT_BACKFILL_WINDOW_MS = OAUTH_BACKFILL_WINDOW_MS;

export type MicrosoftOAuthEnv = {
	MICROSOFT_OAUTH_CLIENT_ID?: string;
	MICROSOFT_OAUTH_CLIENT_SECRET?: string;
	MICROSOFT_OAUTH_REDIRECT_URI?: string;
	MICROSOFT_OAUTH_TENANT?: string;
};

/**
 * Returns null unless the client pair is present, the redirect is secure and
 * the tenant is a plain identifier.
 */
export function resolveMicrosoftOAuthConfig(
	env: MicrosoftOAuthEnv,
): MicrosoftOAuthConfig | null {
	const tenant = (env.MICROSOFT_OAUTH_TENANT ?? MICROSOFT_DEFAULT_TENANT).trim();
	if (!isValidMicrosoftTenant(tenant)) return null;
	const base = resolveOAuthClientEnv({
		clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
		clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
		redirectUri: env.MICROSOFT_OAUTH_REDIRECT_URI,
	});
	if (!base) return null;
	return { ...base, tenant, ...buildMicrosoftEndpoints(tenant) };
}

export type StartMicrosoftLinkDependencies = {
	states: OAuthStateRepository;
	oauth: MicrosoftOAuthClient;
	redirectUri: string;
};

export async function startMicrosoftLink(
	deps: StartMicrosoftLinkDependencies,
	input: { accountId: string; now: number },
): Promise<{ authorizationUrl: string; state: string; expiresAt: number }> {
	return startOAuthLink(
		{
			provider: "microsoft",
			states: deps.states,
			oauth: deps.oauth,
			redirectUri: deps.redirectUri,
		},
		input,
	);
}

export type MicrosoftLinkFailureCode = OAuthLinkFailureCode;
export type CompleteMicrosoftLinkResult = CompleteOAuthLinkResult;

export type CompleteMicrosoftLinkDependencies = {
	repository: MailRepository;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	states: OAuthStateRepository;
	syncStates: SyncStateRepository;
	oauth: MicrosoftOAuthClient;
	limits: MailLimits;
	now: number;
};

export async function completeMicrosoftLink(
	deps: CompleteMicrosoftLinkDependencies,
	input: { code: string; state: string },
): Promise<CompleteMicrosoftLinkResult> {
	return completeOAuthLink(
		{
			provider: "microsoft",
			repository: deps.repository,
			credentials: deps.credentials,
			keys: deps.keys,
			states: deps.states,
			syncStates: deps.syncStates,
			limits: deps.limits,
			now: deps.now,
			backfillWindowMs: MICROSOFT_BACKFILL_WINDOW_MS,
			exchange: async ({ code, codeVerifier }) => {
				const tokens = await deps.oauth.exchangeCode({ code, codeVerifier });
				if (!tokens.refreshToken) throw new OAuthProviderError("missing_refresh_token");
				const address = addressFromMicrosoftIdToken(tokens.idToken);
				if (!address) throw new OAuthProviderError("provider_misconfigured");
				return {
					refreshToken: tokens.refreshToken,
					scope: tokens.scope,
					address,
					backfillHistoryId: null,
				};
			},
		},
		input,
	);
}
