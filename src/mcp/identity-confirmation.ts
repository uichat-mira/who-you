import { z } from "zod";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import {
	IdentityConfirmationError,
	type VerifiedIdentityConfirmation,
	type WhoYouIdentityConfirmationVerifier,
} from "../mail/identity-confirmation";
import { WHOYOU_MAIL_WRITE_SCOPE } from "./config";

export type CloudAuthIdentityConfirmationVerifierOptions = {
	issuer: string;
	audience: string;
	jwksUrl: URL;
	keySet?: JWTVerifyGetKey;
	clockToleranceSeconds?: number;
};

const confirmationSchema = z.strictObject({
	actor: z.literal("user"),
	action: z.enum(["link", "unlink"]),
	provider: z.enum(["gmail", "microsoft", "imap_smtp"]).nullable(),
	mailbox_id: z
		.string()
		.trim()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9._:-]+$/)
		.nullable(),
	nonce: z
		.string()
		.min(16)
		.max(128)
		.regex(/^[A-Za-z0-9_-]+$/),
});

const isWriteOnlyScope = (value: unknown): boolean => {
	if (Array.isArray(value)) {
		return value.length === 1 && value[0] === WHOYOU_MAIL_WRITE_SCOPE;
	}
	if (typeof value === "string") {
		const parts = value.split(/\s+/).filter(Boolean);
		return parts.length === 1 && parts[0] === WHOYOU_MAIL_WRITE_SCOPE;
	}
	return false;
};

/**
 * Same issuance pipeline as the S4 send credential, but with the identity
 * confirmation claim. The credential is not an MCP bearer and cannot read mail.
 */
export function createCloudAuthIdentityConfirmationVerifier(
	options: CloudAuthIdentityConfirmationVerifierOptions,
): WhoYouIdentityConfirmationVerifier {
	const keySet = options.keySet ?? createRemoteJWKSet(options.jwksUrl);
	return {
		async verifyIdentityConfirmation(token: string): Promise<VerifiedIdentityConfirmation> {
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
				throw new IdentityConfirmationError();
			}

			const accountId = typeof payload.sub === "string" ? payload.sub : "";
			const consumerId =
				typeof payload.consumer_id === "string" ? payload.consumer_id : "";
			if (!accountId || consumerId !== accountId) throw new IdentityConfirmationError();
			if (!isWriteOnlyScope(payload.scope)) throw new IdentityConfirmationError();

			const parsed = confirmationSchema.safeParse(payload.confirmation);
			if (!parsed.success) throw new IdentityConfirmationError();

			return {
				accountId,
				confirmation: {
					actor: parsed.data.actor,
					action: parsed.data.action,
					provider: parsed.data.provider,
					mailboxId: parsed.data.mailbox_id,
					nonce: parsed.data.nonce,
				},
			};
		},
	};
}
