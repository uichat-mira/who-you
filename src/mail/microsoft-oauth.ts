import { decodeBase64UrlText } from "./base64url";
import {
	createOAuthAuthorizationUrl,
	createOAuthFormPoster,
	OAuthProviderError,
	parseOAuthTokenSet,
	parseScopeSet,
	type OAuthTokenSet,
} from "./oauth-shared";

/**
 * Microsoft identity platform (v2.0) authorization-code + PKCE client (S7d).
 *
 * Only the refresh token is stored, sealed by `CredentialRepository`. Access
 * tokens and the ID token live for one call. The ID token is trusted because it
 * arrives directly from the TLS token endpoint; its signature is not verified
 * because it is used only to learn the account's own address, never to
 * authenticate a session.
 *
 * Scopes stay minimal: Graph `Mail.Send` + `Mail.Read`, plus the OIDC scopes
 * that make the provider return a refresh token and the address claim.
 */

export const MICROSOFT_SEND_SCOPE = "https://graph.microsoft.com/Mail.Send";
export const MICROSOFT_READ_SCOPE = "https://graph.microsoft.com/Mail.Read";
export const MICROSOFT_GRAPH_SCOPE_PREFIX = "https://graph.microsoft.com/";
/** `offline_access` returns a refresh token; `openid profile email` add the address claim. */
export const MICROSOFT_OIDC_SCOPES = ["openid", "profile", "email", "offline_access"];
export const MICROSOFT_SCOPES = [
	...MICROSOFT_OIDC_SCOPES,
	MICROSOFT_SEND_SCOPE,
	MICROSOFT_READ_SCOPE,
];

export const MICROSOFT_AUTHORITY_HOST = "https://login.microsoftonline.com";
export const MICROSOFT_DEFAULT_TENANT = "common";

export type MicrosoftOAuthConfig = {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	tenant: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
};

export type MicrosoftTokenSet = OAuthTokenSet & { idToken: string | null };

export type MicrosoftOAuthClient = {
	authorizationUrl(input: { state: string; codeChallenge: string }): string;
	exchangeCode(input: { code: string; codeVerifier: string }): Promise<MicrosoftTokenSet>;
	refresh(input: { refreshToken: string }): Promise<MicrosoftTokenSet>;
};

/**
 * Accepts both the requested URI form and the short form some tenants echo.
 */
export const hasRequiredMicrosoftScope = (scope: string | null): boolean => {
	if (!scope) return false;
	const granted = parseScopeSet(scope);
	const has = (short: string): boolean =>
		granted.has(short) || granted.has(`${MICROSOFT_GRAPH_SCOPE_PREFIX}${short}`);
	return has("Mail.Send") && has("Mail.Read");
};

/**
 * Reads the account address from an ID token issued by the token endpoint.
 * Microsoft uses `preferred_username` for both work (UPN) and personal accounts;
 * `email`/`upn` cover older app registrations.
 */
export function addressFromMicrosoftIdToken(idToken: string | null): string | null {
	if (!idToken) return null;
	const parts = idToken.split(".");
	if (parts.length < 2) return null;
	let claims: Record<string, unknown>;
	try {
		const parsed = JSON.parse(decodeBase64UrlText(parts[1])) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		claims = parsed as Record<string, unknown>;
	} catch {
		return null;
	}
	for (const claim of ["preferred_username", "email", "upn", "unique_name"]) {
		const value = claims[claim];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

const tokenSetFrom = (
	payload: Record<string, unknown>,
	requireRefresh: boolean,
): MicrosoftTokenSet => ({
	...parseOAuthTokenSet(payload, requireRefresh, hasRequiredMicrosoftScope),
	idToken: typeof payload.id_token === "string" ? payload.id_token : null,
});

export function createMicrosoftOAuthClient(
	config: MicrosoftOAuthConfig,
	fetchImpl: typeof fetch = fetch,
): MicrosoftOAuthClient {
	const postForm = createOAuthFormPoster(fetchImpl);

	return {
		authorizationUrl({ state, codeChallenge }): string {
			return createOAuthAuthorizationUrl({
				authorizationEndpoint: config.authorizationEndpoint,
				clientId: config.clientId,
				redirectUri: config.redirectUri,
				scope: MICROSOFT_SCOPES,
				state,
				codeChallenge,
				// Consent makes the tenant return a refresh token even after a prior
				// grant that omitted `offline_access`.
				extraParams: { response_mode: "query", prompt: "consent" },
			});
		},

		async exchangeCode({ code, codeVerifier }): Promise<MicrosoftTokenSet> {
			const payload = await postForm(config.tokenEndpoint, {
				grant_type: "authorization_code",
				code,
				client_id: config.clientId,
				client_secret: config.clientSecret,
				redirect_uri: config.redirectUri,
				code_verifier: codeVerifier,
				scope: MICROSOFT_SCOPES.join(" "),
			});
			const tokens = tokenSetFrom(payload, true);
			// Without an address the mailbox cannot be named, and caller input is
			// never trusted for identity.
			if (!addressFromMicrosoftIdToken(tokens.idToken)) {
				throw new OAuthProviderError("provider_misconfigured");
			}
			return tokens;
		},

		async refresh({ refreshToken }): Promise<MicrosoftTokenSet> {
			const payload = await postForm(config.tokenEndpoint, {
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: config.clientId,
				client_secret: config.clientSecret,
				scope: MICROSOFT_SCOPES.join(" "),
			});
			return tokenSetFrom(payload, false);
		},
	};
}

/**
 * The tenant segment is interpolated into the authority URL, so it must be a
 * plain identifier (`common`, a GUID or a verified domain), never a path.
 */
export const isValidMicrosoftTenant = (value: string): boolean =>
	/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(value);

export const buildMicrosoftEndpoints = (
	tenant: string,
): { authorizationEndpoint: string; tokenEndpoint: string } => ({
	authorizationEndpoint: `${MICROSOFT_AUTHORITY_HOST}/${tenant}/oauth2/v2.0/authorize`,
	tokenEndpoint: `${MICROSOFT_AUTHORITY_HOST}/${tenant}/oauth2/v2.0/token`,
});
