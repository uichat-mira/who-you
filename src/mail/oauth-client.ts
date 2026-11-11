import { encodeBase64Url } from "./base64url";

/**
 * Google OAuth 2.0 authorization-code + PKCE client (S7c).
 *
 * Access tokens live only inside one call. The refresh token is the only
 * long-lived secret and is sealed by `CredentialRepository` before storage.
 * Provider error bodies are never surfaced or logged because they can echo
 * token material.
 */

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

export type OAuthTokenSet = {
	accessToken: string;
	/** Present on the authorization-code exchange, absent on refresh. */
	refreshToken: string | null;
	scope: string | null;
	expiresIn: number | null;
};

export type OAuthFailureCode =
	| "invalid_grant"
	| "invalid_client"
	| "missing_refresh_token"
	| "provider_scope_missing"
	| "provider_unreachable"
	| "provider_misconfigured";

export class OAuthProviderError extends Error {
	constructor(readonly code: OAuthFailureCode) {
		super(code);
		this.name = "OAuthProviderError";
	}
}

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
	const granted = new Set(scope.split(/\s+/).filter(Boolean));
	return GMAIL_SCOPES.every((required) => granted.has(required));
};

const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
	try {
		const payload = (await response.json()) as unknown;
		return payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
};

const providerErrorCode = (payload: Record<string, unknown>, status: number): OAuthFailureCode => {
	if (payload.error === "invalid_grant") return "invalid_grant";
	if (payload.error === "invalid_client") return "invalid_client";
	// A 5xx is transient; anything else with the wrong shape is our own config.
	return status >= 500 ? "provider_unreachable" : "provider_misconfigured";
};

const tokenSetFrom = (payload: Record<string, unknown>, requireRefresh: boolean): OAuthTokenSet => {
	const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
	if (!accessToken) throw new OAuthProviderError("provider_misconfigured");
	const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
	if (requireRefresh && !refreshToken) throw new OAuthProviderError("missing_refresh_token");
	const scope = typeof payload.scope === "string" ? payload.scope : null;
	// The code exchange must prove both scopes were granted; a refresh response
	// may omit scope, in which case the previously granted set is unchanged.
	if (requireRefresh && !hasRequiredGmailScope(scope)) {
		throw new OAuthProviderError("provider_scope_missing");
	}
	if (scope !== null && !requireRefresh && !hasRequiredGmailScope(scope)) {
		throw new OAuthProviderError("provider_scope_missing");
	}
	const expiresIn =
		typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
			? payload.expires_in
			: null;
	return { accessToken, refreshToken, scope, expiresIn };
};

export function createGoogleOAuthClient(
	config: GoogleOAuthConfig,
	fetchImpl: typeof fetch = fetch,
): GmailOAuthClient {
	const postForm = async (
		endpoint: string,
		body: Record<string, string>,
	): Promise<Record<string, unknown>> => {
		let response: Response;
		try {
			response = await fetchImpl(endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					accept: "application/json",
				},
				body: new URLSearchParams(body).toString(),
			});
		} catch {
			throw new OAuthProviderError("provider_unreachable");
		}
		const payload = await parseJson(response);
		if (!response.ok) throw new OAuthProviderError(providerErrorCode(payload, response.status));
		return payload;
	};

	return {
		authorizationUrl({ state, codeChallenge }): string {
			const url = new URL(config.authorizationEndpoint);
			url.searchParams.set("client_id", config.clientId);
			url.searchParams.set("redirect_uri", config.redirectUri);
			url.searchParams.set("response_type", "code");
			url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
			url.searchParams.set("state", state);
			url.searchParams.set("code_challenge", codeChallenge);
			url.searchParams.set("code_challenge_method", "S256");
			// `offline` plus `consent` is what makes Google return a refresh token.
			url.searchParams.set("access_type", "offline");
			url.searchParams.set("prompt", "consent");
			url.searchParams.set("include_granted_scopes", "false");
			return url.href;
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
			return tokenSetFrom(payload, true);
		},

		async refresh({ refreshToken }): Promise<OAuthTokenSet> {
			const payload = await postForm(config.tokenEndpoint, {
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: config.clientId,
				client_secret: config.clientSecret,
			});
			return tokenSetFrom(payload, false);
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
