import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { WhoYouPrincipal, WhoYouTokenVerifier } from "../src/mcp/auth";
import {
	ConfirmationCredentialError,
	type WhoYouConfirmationVerifier,
} from "../src/mail/confirmation";
import type { MailSender } from "../src/mail/send";
import {
	IdentityConfirmationError,
	type WhoYouIdentityConfirmationVerifier,
} from "../src/mail/identity-confirmation";

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
export const MCP_TEST_WRITE_SCOPE = "whoyou.mail.write";
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
	// A second synthetic account used only to prove cross-account isolation.
	"fixture-account-b": {
		...base(),
		accountId: "account-b",
		consumerId: "consumer-3",
	},
	"fixture-wrong-issuer": { ...base(), issuer: "mira:cloud-guanlan" },
	"fixture-wrong-audience": { ...base(), audience: "mira:cloud-guanlan" },
	"fixture-expired": { ...base(), expiresAt: 1 },
	"fixture-missing-consumer": { ...base(), consumerId: "" },
	"fixture-wrong-scope": { ...base(), scopes: ["whoyou.ledger.write"] },
	// Read + draft-write principal used by the S2 draft/send surface.
	"fixture-mail-writer": {
		...base(),
		scopes: [MCP_TEST_SCOPE, MCP_TEST_WRITE_SCOPE],
	},
	"fixture-account-b-writer": {
		...base(),
		accountId: "account-b",
		consumerId: "consumer-3",
		scopes: [MCP_TEST_SCOPE, MCP_TEST_WRITE_SCOPE],
	},
	// S6: a writable principal whose Cloud Auth username derives cleanly.
	"fixture-username-writer": {
		...base(),
		accountId: "account-c",
		consumerId: "consumer-4",
		username: "Mira.User",
		scopes: [MCP_TEST_SCOPE, MCP_TEST_WRITE_SCOPE],
	},
	// S6: a writable principal with no usable username; provisioning must ask.
	"fixture-anonymous-writer": {
		...base(),
		accountId: "account-d",
		consumerId: "consumer-5",
		scopes: [MCP_TEST_SCOPE, MCP_TEST_WRITE_SCOPE],
	},
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

export type FixtureConfirmation = {
	accountId: string;
	actor: "user";
	draftId: string;
	draftVersion: number;
	contentHash: string;
	nonce: string;
};

const FIXTURE_CONFIRMATION_PREFIX = "fixture-confirmation.";

const base64UrlEncode = (value: string): string =>
	btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const base64UrlDecode = (value: string): string => {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	return atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
};

/** Builds a synthetic send credential; the test worker verifies it locally. */
export function encodeFixtureConfirmation(payload: FixtureConfirmation): string {
	return `${FIXTURE_CONFIRMATION_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`;
}

/**
 * Test-only confirmation verifier. It mirrors the production invariants (actor,
 * version, 64-hex hash, nonce shape) without a JWKS, so the send pipeline can be
 * exercised end to end while the real verifier is covered by its own unit test.
 */
export function createFixtureConfirmationVerifier(): WhoYouConfirmationVerifier {
	return {
		async verifyConfirmation(token: string) {
			if (!token.startsWith(FIXTURE_CONFIRMATION_PREFIX)) {
				throw new ConfirmationCredentialError();
			}
			let parsed: Record<string, unknown>;
			try {
				const raw = JSON.parse(base64UrlDecode(token.slice(FIXTURE_CONFIRMATION_PREFIX.length)));
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					throw new ConfirmationCredentialError();
				}
				parsed = raw as Record<string, unknown>;
			} catch {
				throw new ConfirmationCredentialError();
			}
			if (typeof parsed.accountId !== "string" || !parsed.accountId) {
				throw new ConfirmationCredentialError();
			}
			if (parsed.actor !== "user") throw new ConfirmationCredentialError();
			if (typeof parsed.draftId !== "string" || !parsed.draftId) {
				throw new ConfirmationCredentialError();
			}
			if (
				typeof parsed.draftVersion !== "number" ||
				!Number.isInteger(parsed.draftVersion) ||
				parsed.draftVersion < 1
			) {
				throw new ConfirmationCredentialError();
			}
			if (
				typeof parsed.contentHash !== "string" ||
				!/^[a-f0-9]{64}$/.test(parsed.contentHash)
			) {
				throw new ConfirmationCredentialError();
			}
			if (typeof parsed.nonce !== "string" || parsed.nonce.length < 16) {
				throw new ConfirmationCredentialError();
			}
			return {
				accountId: parsed.accountId,
				confirmation: {
					actor: "user",
					draftId: parsed.draftId,
					draftVersion: parsed.draftVersion,
					contentHash: parsed.contentHash,
					nonce: parsed.nonce,
				},
			};
		},
	};
}

export type FixtureIdentityConfirmation = {
	accountId: string;
	action: "link" | "unlink";
	provider: "gmail" | "microsoft" | "imap_smtp" | null;
	mailboxId: string | null;
	nonce: string;
};

const FIXTURE_IDENTITY_PREFIX = "fixture-identity.";

/** Builds a synthetic link/unlink credential; the test worker verifies it. */
export function encodeFixtureIdentityConfirmation(
	payload: FixtureIdentityConfirmation,
): string {
	return `${FIXTURE_IDENTITY_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`;
}

export function createFixtureIdentityConfirmationVerifier(): WhoYouIdentityConfirmationVerifier {
	return {
		async verifyIdentityConfirmation(token: string) {
			if (!token.startsWith(FIXTURE_IDENTITY_PREFIX)) {
				throw new IdentityConfirmationError();
			}
			let parsed: Record<string, unknown>;
			try {
				const raw = JSON.parse(base64UrlDecode(token.slice(FIXTURE_IDENTITY_PREFIX.length)));
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					throw new IdentityConfirmationError();
				}
				parsed = raw as Record<string, unknown>;
			} catch {
				throw new IdentityConfirmationError();
			}
			if (typeof parsed.accountId !== "string" || !parsed.accountId) {
				throw new IdentityConfirmationError();
			}
			if (parsed.action !== "link" && parsed.action !== "unlink") {
				throw new IdentityConfirmationError();
			}
			const provider =
				parsed.provider === "gmail" ||
				parsed.provider === "microsoft" ||
				parsed.provider === "imap_smtp"
					? parsed.provider
					: parsed.provider === null
						? null
						: undefined;
			if (provider === undefined) throw new IdentityConfirmationError();
			if (parsed.mailboxId !== null && typeof parsed.mailboxId !== "string") {
				throw new IdentityConfirmationError();
			}
			if (typeof parsed.nonce !== "string" || parsed.nonce.length < 16) {
				throw new IdentityConfirmationError();
			}
			return {
				accountId: parsed.accountId,
				confirmation: {
					actor: "user",
					action: parsed.action,
					provider,
					mailboxId: parsed.mailboxId,
					nonce: parsed.nonce,
				},
			};
		},
	};
}

export type FixtureSentMessage = {
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
};

const fixtureSent: FixtureSentMessage[] = [];

export function fixtureOutbox(): FixtureSentMessage[] {
	return fixtureSent.map((message) => ({
		...message,
		to: [...message.to],
		cc: [...message.cc],
		bcc: [...message.bcc],
	}));
}

/** Deterministic outbound fake; `failing` exercises the relay error path. */
export function createFakeMailSender(options: { failing?: boolean } = {}): MailSender {
	return {
		async send(message) {
			if (options.failing) throw new Error("fixture provider failure");
			// The fake holds the envelope only; body content is never asserted as PII.
			fixtureSent.push({
				from: message.from,
				to: message.to.map((entry) => entry.address),
				cc: message.cc.map((entry) => entry.address),
				bcc: message.bcc.map((entry) => entry.address),
				subject: message.subject,
			});
			return { providerMessageId: `fixture-provider-${fixtureSent.length}` };
		},
	};
}
