import type { MailboxProvider } from "./store";

/**
 * Verifier contract for an identity link/unlink confirmation (S7c).
 *
 * Linking a third-party mailbox is a high-risk write: an injected MCP call must
 * not be able to attach an attacker mailbox to a victim account. Cloud Auth
 * issues a single-use credential bound to the account, action, provider and,
 * for unlink, the mailbox id.
 */

export type IdentityAction = "link" | "unlink";

export type WhoYouIdentityConfirmation = {
	actor: "user";
	action: IdentityAction;
	provider: MailboxProvider | null;
	mailboxId: string | null;
	nonce: string;
};

export type VerifiedIdentityConfirmation = {
	accountId: string;
	confirmation: WhoYouIdentityConfirmation;
};

export interface WhoYouIdentityConfirmationVerifier {
	verifyIdentityConfirmation(token: string): Promise<VerifiedIdentityConfirmation>;
}

export class IdentityConfirmationError extends Error {
	readonly code = "confirmation_invalid";

	constructor() {
		super("confirmation_invalid");
		this.name = "IdentityConfirmationError";
	}
}
