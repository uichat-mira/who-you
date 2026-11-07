import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { WhoYouPrincipal, WhoYouTokenVerifier } from "../src/mcp/auth";

/**
 * Deterministic MCP contract fixtures. Every address, account and consumer here
 * is synthetic; no real mailbox, credential or message content exists.
 */
export const MCP_TEST_RESOURCE_URL = "https://127.0.0.1/mcp";
export const MCP_TEST_ISSUER = "https://auth.example.com"; // OAuth authorization-server URL
export const MCP_TEST_TOKEN_ISSUER = "mira:cloud-auth"; // Signed Cloud Auth credential issuer
export const MCP_TEST_JWKS_URL = "https://auth.example.com/.well-known/jwks.json";
export const MCP_TEST_AUDIENCE = "mira:who-you";
export const MCP_TEST_SCOPE = "whoyou.read";
export const MCP_TEST_FUTURE_EXP = 4_102_444_800; // 2100-01-01T00:00:00Z

const base = (): WhoYouPrincipal => ({
	accountId: "account-a",
	consumerId: "consumer-1",
	scopes: [MCP_TEST_SCOPE],
	expiresAt: MCP_TEST_FUTURE_EXP,
	issuer: MCP_TEST_TOKEN_ISSUER,
	audience: MCP_TEST_AUDIENCE,
});

export const FIXTURE_TOKENS: Record<string, WhoYouPrincipal> = {
	"fixture-consumer-1": base(),
	"fixture-consumer-2": { ...base(), consumerId: "consumer-2" },
	"fixture-wrong-issuer": { ...base(), issuer: "mira:cloud-guanlan" },
	"fixture-wrong-audience": { ...base(), audience: "mira:cloud-guanlan" },
	"fixture-expired": { ...base(), expiresAt: 1 },
	"fixture-missing-consumer": { ...base(), consumerId: "" },
	"fixture-wrong-scope": { ...base(), scopes: ["whoyou.ledger.write"] },
};

const invalidToken = (): OAuthError =>
	new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");

/**
 * Test-only verifier: it approves a fixed synthetic table and still enforces the
 * same issuer/audience/expiry/identity invariants as the JWKS verifier.
 */
export function createFixtureVerifier(expected: {
	issuer: string;
	audience: string;
}): WhoYouTokenVerifier {
	return {
		async verifyAccessToken(token: string): Promise<WhoYouPrincipal> {
			const principal = FIXTURE_TOKENS[token];
			if (!principal) throw invalidToken();
			if (
				principal.issuer !== expected.issuer ||
				principal.audience !== expected.audience
			) {
				throw invalidToken();
			}
			if (!principal.accountId || !principal.consumerId) throw invalidToken();
			if (principal.expiresAt <= Date.now() / 1000) throw invalidToken();
			return { ...principal, scopes: [...principal.scopes] };
		},
	};
}
