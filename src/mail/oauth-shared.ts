/**
 * Provider-agnostic OAuth 2.0 authorization-code + PKCE primitives (S7c/S7d).
 *
 * Google and Microsoft differ in endpoints, scopes and the authorization
 * parameters, but the wire format, the token envelope and the failure taxonomy
 * are identical. Keeping them here means one place decides how a provider
 * error maps to a fixed code and how a token response is validated.
 *
 * Provider response bodies are never surfaced because they can echo token
 * material.
 */

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

export const OAUTH_BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const parseJsonBody = async (response: Response): Promise<Record<string, unknown>> => {
	try {
		const payload = (await response.json()) as unknown;
		return payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
};

const providerErrorCode = (
	payload: Record<string, unknown>,
	status: number,
): OAuthFailureCode => {
	if (payload.error === "invalid_grant") return "invalid_grant";
	// `unauthorized_client` is the same permanent configuration/consent failure.
	if (payload.error === "invalid_client" || payload.error === "unauthorized_client") {
		return "invalid_client";
	}
	// A 5xx is transient; anything else with the wrong shape is our own config.
	return status >= 500 ? "provider_unreachable" : "provider_misconfigured";
};

export type OAuthFormPoster = (
	endpoint: string,
	body: Record<string, string>,
) => Promise<Record<string, unknown>>;

/** Posts a form body and rejects with a fixed `OAuthProviderError` on failure. */
export const createOAuthFormPoster = (fetchImpl: typeof fetch): OAuthFormPoster => {
	return async (endpoint, body) => {
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
		const payload = await parseJsonBody(response);
		if (!response.ok) throw new OAuthProviderError(providerErrorCode(payload, response.status));
		return payload;
	};
};

export const parseScopeSet = (scope: string | null): Set<string> =>
	new Set((scope ?? "").split(/\s+/).filter(Boolean));

export const parseOAuthTokenSet = (
	payload: Record<string, unknown>,
	requireRefresh: boolean,
	hasRequiredScope: (scope: string | null) => boolean,
): OAuthTokenSet => {
	const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
	if (!accessToken) throw new OAuthProviderError("provider_misconfigured");
	const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
	if (requireRefresh && !refreshToken) throw new OAuthProviderError("missing_refresh_token");
	const scope = typeof payload.scope === "string" ? payload.scope : null;
	// The code exchange must prove the required scopes; a refresh response may
	// omit `scope`, in which case the previously granted set is unchanged.
	if (requireRefresh && !hasRequiredScope(scope)) {
		throw new OAuthProviderError("provider_scope_missing");
	}
	if (scope !== null && !requireRefresh && !hasRequiredScope(scope)) {
		throw new OAuthProviderError("provider_scope_missing");
	}
	const expiresIn =
		typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
			? payload.expires_in
			: null;
	return { accessToken, refreshToken, scope, expiresIn };
};

export const createOAuthAuthorizationUrl = (input: {
	authorizationEndpoint: string;
	clientId: string;
	redirectUri: string;
	scope: string[];
	state: string;
	codeChallenge: string;
	extraParams?: Record<string, string>;
}): string => {
	const url = new URL(input.authorizationEndpoint);
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("scope", input.scope.join(" "));
	url.searchParams.set("state", input.state);
	url.searchParams.set("code_challenge", input.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	for (const [key, value] of Object.entries(input.extraParams ?? {})) {
		url.searchParams.set(key, value);
	}
	return url.href;
};

const ALLOWED_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type OAuthClientEnv = {
	clientId: string | undefined;
	clientSecret: string | undefined;
	redirectUri: string | undefined;
};

/**
 * Returns null unless all three values are present and the redirect is either
 * HTTPS or a loopback HTTP URL. A partial configuration must never half-enable
 * a provider.
 */
export function resolveOAuthClientEnv(env: OAuthClientEnv): {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
} | null {
	const clientId = (env.clientId ?? "").trim();
	const clientSecret = (env.clientSecret ?? "").trim();
	const redirectUri = (env.redirectUri ?? "").trim();
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

	return { clientId, clientSecret, redirectUri };
}
