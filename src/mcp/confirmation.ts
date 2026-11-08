import { z } from "zod";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import {
	ConfirmationCredentialError,
	type VerifiedConfirmation,
	type WhoYouConfirmationVerifier,
} from "../mail/confirmation";
import { WHOYOU_MAIL_SEND_SCOPE } from "./config";

export type CloudAuthConfirmationVerifierOptions = {
	/** Cloud Auth credential issuer, configured explicitly rather than derived. */
	issuer: string;
	/** Must be the dedicated Who You audience (`mira:who-you`). */
	audience: string;
	jwksUrl: URL;
	/** Test/integration injection point; production uses the remote JWKS. */
	keySet?: JWTVerifyGetKey;
	clockToleranceSeconds?: number;
};

/**
 * Cloud Auth's confirmation claim is `.strict()` on the issuer side, so a
 * superset here would be a contract drift. Rejecting unknown keys keeps both
 * sides honest.
 */
const confirmationSchema = z.strictObject({
	actor: z.literal("user"),
	draft_id: z
		.string()
		.trim()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9._:-]+$/),
	draft_version: z.number().int().positive().max(2_147_483_647),
	content_hash: z.string().regex(/^[a-f0-9]{64}$/),
	nonce: z
		.string()
		.min(16)
		.max(128)
		.regex(/^[A-Za-z0-9_-]+$/),
});

const isSendOnlyScope = (value: unknown): boolean => {
	if (Array.isArray(value)) {
		return value.length === 1 && value[0] === WHOYOU_MAIL_SEND_SCOPE;
	}
	if (typeof value === "string") {
		const parts = value.split(/\s+/).filter(Boolean);
		return parts.length === 1 && parts[0] === WHOYOU_MAIL_SEND_SCOPE;
	}
	return false;
};

/**
 * Verifies the send credential passed as a tool argument. It is deliberately
 * not an MCP bearer: Cloud Auth issues it with only `whoyou.mail.send`, so it
 * cannot read mail or open a general `/mcp` session on its own.
 */
export function createCloudAuthConfirmationVerifier(
	options: CloudAuthConfirmationVerifierOptions,
): WhoYouConfirmationVerifier {
	const keySet = options.keySet ?? createRemoteJWKSet(options.jwksUrl);
	return {
		async verifyConfirmation(token: string): Promise<VerifiedConfirmation> {
			let payload: Record<string, unknown>;
			try {
				const verified = await jwtVerify(token, keySet, {
					issuer: options.issuer,
					audience: options.audience,
					algorithms: ["EdDSA"],
					clockTolerance: options.clockToleranceSeconds ?? 5,
					requiredClaims: ["iss", "aud", "exp", "sub"],
				});
				payload = verified.payload as Record<string, unknown>;
			} catch {
				throw new ConfirmationCredentialError();
			}

			const accountId = typeof payload.sub === "string" ? payload.sub : "";
			const consumerId =
				typeof payload.consumer_id === "string" ? payload.consumer_id : "";
			if (!accountId || consumerId !== accountId) {
				throw new ConfirmationCredentialError();
			}
			if (!isSendOnlyScope(payload.scope)) {
				throw new ConfirmationCredentialError();
			}

			const parsed = confirmationSchema.safeParse(payload.confirmation);
			if (!parsed.success) throw new ConfirmationCredentialError();

			return {
				accountId,
				confirmation: {
					actor: parsed.data.actor,
					draftId: parsed.data.draft_id,
					draftVersion: parsed.data.draft_version,
					contentHash: parsed.data.content_hash,
					nonce: parsed.data.nonce,
				},
			};
		},
	};
}
