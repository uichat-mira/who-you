import type { MailboxProvider } from "./store";

/**
 * One-time OAuth link attempts (S7c). Only the PKCE verifier lives here; the
 * authorization code and every token are exchanged in memory and never stored.
 */

export type OAuthLinkState = {
	state: string;
	accountId: string;
	provider: MailboxProvider;
	codeVerifier: string;
	redirectUri: string;
	createdAt: number;
	expiresAt: number;
};

type OAuthLinkStateRow = {
	state: string;
	account_id: string;
	provider: MailboxProvider;
	code_verifier: string;
	redirect_uri: string;
	created_at: number;
	expires_at: number;
};

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const toState = (row: OAuthLinkStateRow): OAuthLinkState => ({
	state: row.state,
	accountId: row.account_id,
	provider: row.provider,
	codeVerifier: row.code_verifier,
	redirectUri: row.redirect_uri,
	createdAt: row.created_at,
	expiresAt: row.expires_at,
});

export class OAuthStateRepository {
	constructor(private readonly db: D1Database) {}

	async create(input: OAuthLinkState): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO oauth_link_states (
				 state, account_id, provider, code_verifier, redirect_uri, created_at, expires_at
				 ) VALUES (?,?,?,?,?,?,?)`,
			)
			.bind(
				input.state,
				input.accountId,
				input.provider,
				input.codeVerifier,
				input.redirectUri,
				input.createdAt,
				input.expiresAt,
			)
			.run();
	}

	/**
	 * Single use: the row is deleted before the caller exchanges the code, and
	 * expiry is enforced by the same statement. A concurrent callback can only
	 * observe one winner.
	 */
	async consume(state: string, now: number): Promise<OAuthLinkState | null> {
		const row = await this.db
			.prepare(
				`SELECT state, account_id, provider, code_verifier, redirect_uri,
				 created_at, expires_at
				 FROM oauth_link_states WHERE state = ? AND expires_at > ?`,
			)
			.bind(state, now)
			.first<OAuthLinkStateRow>();
		if (!row) return null;
		const deleted = await this.db
			.prepare("DELETE FROM oauth_link_states WHERE state = ? AND expires_at > ?")
			.bind(state, now)
			.run();
		if ((deleted.meta.changes ?? 0) === 0) return null;
		return toState(row);
	}

	async deleteExpired(now: number): Promise<number> {
		const result = await this.db
			.prepare("DELETE FROM oauth_link_states WHERE expires_at <= ?")
			.bind(now)
			.run();
		return result.meta.changes ?? 0;
	}
}
