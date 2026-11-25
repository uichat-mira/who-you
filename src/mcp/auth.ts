import {
	OAuthError,
	OAuthErrorCode,
	type AuthInfo,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { WHOYOU_REQUIRED_SCOPE } from "./config";

export type WhoYouPrincipal = {
	/** Cloud Auth subject; the Cloud Account that owns the consumer. */
	accountId: string;
	/** Business consumer identity derived from the verified account subject. */
	consumerId: string;
	/**
	 * Cloud Auth username, used only to derive the owned mailbox prefix. It is
	 * descriptive, not authoritative: a token without it still authenticates, it
	 * just cannot derive an address.
	 */
	username?: string;
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
	appId: string;
	serviceId: string;
	/** Test/integration injection point; production uses the configured remote JWKS. */
	keySet?: JWTVerifyGetKey;
	clockToleranceSeconds?: number;
};

const invalidToken = (): OAuthError =>
	new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");

const claimKeys = new Set(["iss", "sub", "device_id", "aud", "app_id",
  "service_id", "resource", "scope", "iat", "nbf", "exp"]);

/** Verify exactly the V1 instance/resource credential. The subject is the
 * existing mailbox owner; no caller-selected consumer or username is trusted.
 */
export function createCloudAuthVerifier(options: CloudAuthVerifierOptions): WhoYouTokenVerifier {
  const keySet = options.keySet ?? createRemoteJWKSet(options.jwksUrl);
  return {
    async verifyAccessToken(token: string): Promise<WhoYouPrincipal> {
      let p: Record<string, unknown>;
      try {
        const verified = await jwtVerify(token, keySet, {
          issuer: options.issuer, audience: options.audience,
          algorithms: ["EdDSA"], clockTolerance: options.clockToleranceSeconds ?? 0,
          requiredClaims: [...claimKeys],
        });
        p = verified.payload as Record<string, unknown>;
      } catch { throw invalidToken(); }
      const now = Math.floor(Date.now() / 1000);
      if (Object.keys(p).some(key => !claimKeys.has(key)) ||
          p.aud !== options.audience || p.resource !== options.audience ||
          p.app_id !== options.appId || p.service_id !== options.serviceId ||
          typeof p.sub !== "string" || !p.sub.trim() ||
          typeof p.device_id !== "string" || !p.device_id.trim() ||
          typeof p.iat !== "number" || !Number.isSafeInteger(p.iat) ||
          typeof p.nbf !== "number" || !Number.isSafeInteger(p.nbf) ||
          typeof p.exp !== "number" || !Number.isSafeInteger(p.exp) ||
          p.iat > now || p.nbf < p.iat || p.nbf > now || p.exp <= now ||
          p.exp <= p.nbf || p.exp - p.iat > 600 ||
          !Array.isArray(p.scope) || p.scope.length !== 1 || p.scope[0] !== WHOYOU_REQUIRED_SCOPE) {
        throw invalidToken();
      }
      return { accountId: p.sub, consumerId: p.sub, scopes: [WHOYOU_REQUIRED_SCOPE],
        expiresAt: p.exp, issuer: options.issuer, audience: options.audience };
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
			...(principal.username ? { username: principal.username } : {}),
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
	const username = extra?.username;
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
		...(typeof username === "string" && username ? { username } : {}),
		scopes: [...authInfo.scopes],
		expiresAt: authInfo.expiresAt,
		issuer,
		audience,
	};
}
