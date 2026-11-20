import { encodeBase64Url } from "./base64url";
import {
	createOAuthAuthorizationUrl,
	createOAuthFormPoster,
	parseOAuthTokenSet,
	parseScopeSet,
	type OAuthTokenSet,
} from "./oauth-shared";

/**
 * Google OAuth 2.0 authorization-code + PKCE client (S7c).
 *
 * Access tokens live only inside one call. The refresh token is the only
 * long-lived secret and is sealed by `CredentialRepository` before storage.
 * Provider error bodies are never surfaced or logged because they can echo
 * token material.
 */

export { OAuthProviderError, type OAuthFailureCode, type OAuthTokenSet } from "./oauth-shared";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SCOPES = [GMAIL_SEND_SCOPE, GMAIL_READONLY_SCOPE];

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export type GoogleOAuthConfig = {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	revocationEndpoint: string;
};

export type GmailOAuthClient = {
	authorizationUrl(input: { state: string; codeChallenge: string }): string;
	exchangeCode(input: { code: string; codeVerifier: string }): Promise<OAuthTokenSet>;
	refresh(input: { refreshToken: string }): Promise<OAuthTokenSet>;
	/** Best effort: provider revocation failure never blocks local shredding. */
	revoke(input: { token: string }): Promise<boolean>;
};

const base64UrlBytes = (bytes: Uint8Array): string => encodeBase64Url(bytes);

/** PKCE verifier (43 chars) and its S256 challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64UrlBytes(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return { verifier, challenge: base64UrlBytes(new Uint8Array(digest)) };
}

/** Opaque, unguessable authorization `state`. */
export const createOAuthState = (): string =>
	base64UrlBytes(crypto.getRandomValues(new Uint8Array(32)));

export const hasRequiredGmailScope = (scope: string | null): boolean => {
	if (!scope) return false;
	const granted = parseScopeSet(scope);
	return GMAIL_SCOPES.every((required) => granted.has(required));
};

export function createGoogleOAuthClient(
	config: GoogleOAuthConfig,
	fetchImpl: typeof fetch = fetch,
): GmailOAuthClient {
	const postForm = createOAuthFormPoster(fetchImpl);

	return {
		authorizationUrl({ state, codeChallenge }): string {
			return createOAuthAuthorizationUrl({
				authorizationEndpoint: config.authorizationEndpoint,
				clientId: config.clientId,
				redirectUri: config.redirectUri,
				scope: GMAIL_SCOPES,
				state,
				codeChallenge,
				// `offline` plus `consent` is what makes Google return a refresh token.
				extraParams: {
					access_type: "offline",
					prompt: "consent",
					include_granted_scopes: "false",
				},
			});
		},

		async exchangeCode({ code, codeVerifier }): Promise<OAuthTokenSet> {
			const payload = await postForm(config.tokenEndpoint, {
				grant_type: "authorization_code",
				code,
				client_id: config.clientId,
				client_secret: config.clientSecret,
				redirect_uri: config.redirectUri,
				code_verifier: codeVerifier,
			});
			return parseOAuthTokenSet(payload, true, hasRequiredGmailScope);
		},

		async refresh({ refreshToken }): Promise<OAuthTokenSet> {
			const payload = await postForm(config.tokenEndpoint, {
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: config.clientId,
				client_secret: config.clientSecret,
			});
			return parseOAuthTokenSet(payload, false, hasRequiredGmailScope);
		},

		async revoke({ token }): Promise<boolean> {
			try {
				const response = await fetchImpl(config.revocationEndpoint, {
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						accept: "application/json",
					},
					body: new URLSearchParams({ token }).toString(),
				});
				return response.ok;
			} catch {
				return false;
			}
		},
	};
}
