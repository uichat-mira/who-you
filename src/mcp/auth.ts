import {
	OAuthError,
	OAuthErrorCode,
	type AuthInfo,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type WhoYouPrincipal = {
	/** Cloud Auth subject; the Cloud Account that owns the consumer. */
	accountId: string;
	/** Stable consumer identity minted into the credential, never supplied by a tool argument. */
	consumerId: string;
	scopes: string[];
	/** Seconds since epoch, as in the JWT `exp` claim. */
	expiresAt: number;
	issuer: string;
	audience: string;
};

/**
 * Narrow resource-server verifier contract. Cloud Auth owns issuance; Who You
 * only verifies an already-issued access token and derives the principal.
 */
export interface WhoYouTokenVerifier {
	verifyAccessToken(token: string): Promise<WhoYouPrincipal>;
}

export type CloudAuthVerifierOptions = {
	issuer: string;
	audience: string;
	jwksUrl: URL;
	consumerClaim: string;
	/** Test/integration injection point; production uses the configured remote JWKS. */
	keySet?: JWTVerifyGetKey;
	clockToleranceSeconds?: number;
};

const invalidToken = (): OAuthError =>
	new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");

const tokenScopes = (payload: Record<string, unknown>): string[] => {
	// Cloud Auth V0 signs scope as an array; standard OAuth access tokens may
	// encode space-delimited scopes. Reject malformed arrays rather than
	// silently discarding entries and accidentally broadening authority.
	if (Array.isArray(payload.scope)) {
		if (
			!payload.scope.every(
				(value) => typeof value === "string" && value.length > 0,
			)
		) {
			throw invalidToken();
		}
		return payload.scope;
	}
	if (typeof payload.scope === "string") {
		return payload.scope.split(/\s+/).filter(Boolean);
	}
	return [];
};

/**
 * The deployed verifier: Cloud Auth public JWKS, exact issuer/audience binding,
 * a non-empty subject and a token-bound consumer identity. Anything else is an
 * opaque 401; there is no fallback to a test fixture or unconfigured local trust.
 */
export function createCloudAuthVerifier(
	options: CloudAuthVerifierOptions,
): WhoYouTokenVerifier {
	const keySet = options.keySet ?? createRemoteJWKSet(options.jwksUrl);
	return {
		async verifyAccessToken(token: string): Promise<WhoYouPrincipal> {
			let payload: Record<string, unknown>;
			try {
				const verified = await jwtVerify(token, keySet, {
					issuer: options.issuer,
					audience: options.audience,
					// The current Cloud Auth public JWKS contains Ed25519 keys only.
					algorithms: ["EdDSA"],
					clockTolerance: options.clockToleranceSeconds ?? 5,
					requiredClaims: ["iss", "aud", "exp", "sub"],
				});
				payload = verified.payload as Record<string, unknown>;
			} catch {
				throw invalidToken();
			}

			const accountId = typeof payload.sub === "string" ? payload.sub : "";
			const consumerId =
				typeof payload[options.consumerClaim] === "string"
					? (payload[options.consumerClaim] as string)
					: "";
			const expiresAt = typeof payload.exp === "number" ? payload.exp : NaN;
			if (!accountId || !consumerId || !Number.isFinite(expiresAt)) {
				throw invalidToken();
			}

			return {
				accountId,
				consumerId,
				scopes: tokenScopes(payload),
				expiresAt,
				issuer: options.issuer,
				audience: options.audience,
			};
		},
	};
}

/** Adapter from the Who You principal to the SDK's auth pass-through shape. */
export function authInfoFromPrincipal(
	token: string,
	principal: WhoYouPrincipal,
	resourceUrl: URL,
): AuthInfo {
	return {
		token,
		clientId: principal.consumerId,
		scopes: principal.scopes,
		expiresAt: principal.expiresAt,
		// JWT aud has already been verified against the configured Who You
		// audience. MCP expectedResource is the actual /mcp URL, not the label.
		resource: resourceUrl,
		extra: {
			accountId: principal.accountId,
			consumerId: principal.consumerId,
			issuer: principal.issuer,
			audience: principal.audience,
		},
	};
}

/** Reads only verifier-derived identity; tool arguments never supply these values. */
export function principalFromAuthInfo(
	authInfo: AuthInfo | undefined,
): WhoYouPrincipal {
	const extra = authInfo?.extra;
	const accountId = extra?.accountId;
	const consumerId = extra?.consumerId;
	const issuer = extra?.issuer;
	const audience = extra?.audience;
	if (
		!authInfo ||
		typeof accountId !== "string" ||
		typeof consumerId !== "string" ||
		typeof issuer !== "string" ||
		typeof audience !== "string" ||
		!Array.isArray(authInfo.scopes) ||
		typeof authInfo.expiresAt !== "number"
	) {
		throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");
	}
	return {
		accountId,
		consumerId,
		scopes: [...authInfo.scopes],
		expiresAt: authInfo.expiresAt,
		issuer,
		audience,
	};
}
