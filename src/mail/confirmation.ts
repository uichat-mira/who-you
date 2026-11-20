/**
 * Verifier contract for a Cloud Auth draft-bound confirmation credential.
 *
 * Cloud Auth owns issuance (`mira:who-you` audience, the single
 * `whoyou.mail.send` scope and a strict `confirmation` claim). Who You only
 * verifies an already-issued credential and never mints or stores it.
 */

export type WhoYouConfirmation = {
	actor: "user";
	draftId: string;
	draftVersion: number;
	contentHash: string;
	nonce: string;
};

export type VerifiedConfirmation = {
	/** Cloud Account from the credential subject; must equal the MCP principal. */
	accountId: string;
	confirmation: WhoYouConfirmation;
};

export interface WhoYouConfirmationVerifier {
	verifyConfirmation(token: string): Promise<VerifiedConfirmation>;
}

/** Opaque failure: every credential problem maps to the same tool error. */
export class ConfirmationCredentialError extends Error {
	readonly code = "confirmation_invalid";

	constructor() {
		super("confirmation_invalid");
		this.name = "ConfirmationCredentialError";
	}
}
