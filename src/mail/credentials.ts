import {
	CredentialCryptoError,
	openSecret,
	rewrapDek,
	sealSecret,
} from "./credential-crypto";
import type { MailboxProvider } from "./store";

/**
 * Credential storage for third-party identities (S7b).
 *
 * The repository is deliberately secret-agnostic at the type level: rows never
 * carry plaintext, and `readActive` is the only method that returns a secret,
 * after unsealing it with the KEK material the caller supplies. Every failure
 * is a fixed code so callers cannot distinguish "wrong password" from
 * "unreadable ciphertext" through the API surface.
 */

export type CredentialType = "oauth_refresh" | "imap_password" | "smtp_password";

export type CredentialStatus = "active" | "reauth_required" | "unreadable" | "revoked";

export type CredentialRecord = {
	id: string;
	accountId: string;
	mailboxId: string;
	provider: MailboxProvider;
	credentialType: CredentialType;
	status: CredentialStatus;
	dekId: string;
	keyVersion: number;
	scope: string;
	createdAt: number;
	updatedAt: number;
	revokedAt: number | null;
};

export type CredentialKey = { version: number; kek: Uint8Array };

export type CredentialKeys = {
	current: CredentialKey;
	/** Retained for one rotation window so old rows stay readable. */
	previous: CredentialKey | null;
};

export type CredentialFailureCode =
	| "credential_missing"
	| "credential_already_exists"
	| "credential_reauth_required"
	| "credential_unreadable"
	| "credential_revoked";

type CredentialRow = {
	id: string;
	account_id: string;
	mailbox_id: string;
	provider: MailboxProvider;
	credential_type: CredentialType;
	status: CredentialStatus;
	dek_id: string;
	wrapped_dek: string | null;
	wrap_nonce: string | null;
	ciphertext: string | null;
	nonce: string | null;
	key_version: number;
	scope: string;
	created_at: number;
	updated_at: number;
	revoked_at: number | null;
};

const COLUMNS = `id, account_id, mailbox_id, provider, credential_type, status, dek_id,
	wrapped_dek, wrap_nonce, ciphertext, nonce, key_version, scope, created_at,
	updated_at, revoked_at`;

const toRecord = (row: CredentialRow): CredentialRecord => ({
	id: row.id,
	accountId: row.account_id,
	mailboxId: row.mailbox_id,
	provider: row.provider,
	credentialType: row.credential_type,
	status: row.status,
	dekId: row.dek_id,
	keyVersion: row.key_version,
	scope: row.scope,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	revokedAt: row.revoked_at,
});

const keyForVersion = (keys: CredentialKeys, version: number): Uint8Array | null => {
	if (keys.current.version === version) return keys.current.kek;
	if (keys.previous?.version === version) return keys.previous.kek;
	return null;
};

export type StoreCredentialInput = {
	accountId: string;
	mailboxId: string;
	provider: MailboxProvider;
	credentialType: CredentialType;
	secret: string;
	scope?: string;
	keys: CredentialKeys;
	now: number;
};

/**
 * One Cloud Account may hold several mailboxes, and one mailbox may legitimately
 * carry an IMAP and an SMTP password, so uniqueness is (mailbox, type, active).
 */
export class CredentialRepository {
	constructor(private readonly db: D1Database) {}

	async store(
		input: StoreCredentialInput,
	): Promise<{ ok: true; credential: CredentialRecord } | { ok: false; code: CredentialFailureCode }> {
		const envelope = await sealSecret(input.keys.current.kek, input.secret, {
			accountId: input.accountId,
			provider: input.provider,
			mailboxId: input.mailboxId,
			credentialType: input.credentialType,
		});
		const id = `cred_${crypto.randomUUID().replace(/-/g, "")}`;
		try {
			await this.db
				.prepare(
					`INSERT INTO provider_credentials (
					 id, account_id, mailbox_id, provider, credential_type, status, dek_id,
					 wrapped_dek, wrap_nonce, ciphertext, nonce, key_version, scope,
					 created_at, updated_at
					 ) VALUES (?,?,?,?,?, 'active', ?,?,?,?,?,?,?,?,?)`,
				)
				.bind(
					id,
					input.accountId,
					input.mailboxId,
					input.provider,
					input.credentialType,
					envelope.dekId,
					envelope.wrappedDek,
					envelope.wrapNonce,
					envelope.ciphertext,
					envelope.nonce,
					input.keys.current.version,
					input.scope ?? "",
					input.now,
					input.now,
				)
				.run();
		} catch (error) {
			if (String(error).toUpperCase().includes("UNIQUE")) {
				return { ok: false, code: "credential_already_exists" };
			}
			throw error;
		}
		const row = await this.db
			.prepare(`SELECT ${COLUMNS} FROM provider_credentials WHERE id = ?`)
			.bind(id)
			.first<CredentialRow>();
		if (!row) throw new Error("credential_insert_lost");
		return { ok: true, credential: toRecord(row) };
	}

	/**
	 * Returns the sealed secret for one slot. Decryption failures flip the row to
	 * `unreadable` and fail closed instead of retrying or degrading.
	 */
	async readActive(input: {
		accountId: string;
		mailboxId: string;
		credentialType: CredentialType;
		keys: CredentialKeys;
	}): Promise<
		| { ok: true; credential: CredentialRecord; secret: string }
		| { ok: false; code: CredentialFailureCode }
	> {
		const row = await this.db
			.prepare(
				`SELECT ${COLUMNS} FROM provider_credentials
				 WHERE account_id = ? AND mailbox_id = ? AND credential_type = ?
				 ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1`,
			)
			.bind(input.accountId, input.mailboxId, input.credentialType)
			.first<CredentialRow>();
		if (!row) return { ok: false, code: "credential_missing" };
		if (row.status === "revoked") return { ok: false, code: "credential_revoked" };
		if (row.status === "reauth_required") {
			return { ok: false, code: "credential_reauth_required" };
		}
		if (row.status === "unreadable") return { ok: false, code: "credential_unreadable" };

		const kek = keyForVersion(input.keys, row.key_version);
		if (!kek || !row.wrapped_dek || !row.wrap_nonce || !row.ciphertext || !row.nonce) {
			await this.markUnreadable(row.id, Date.now());
			return { ok: false, code: "credential_unreadable" };
		}
		try {
			const secret = await openSecret(
				kek,
				{
					dekId: row.dek_id,
					wrappedDek: row.wrapped_dek,
					wrapNonce: row.wrap_nonce,
					ciphertext: row.ciphertext,
					nonce: row.nonce,
				},
				{
					accountId: row.account_id,
					provider: row.provider,
					mailboxId: row.mailbox_id,
					dekId: row.dek_id,
					credentialType: row.credential_type,
				},
			);
			return { ok: true, credential: toRecord(row), secret };
		} catch (error) {
			if (error instanceof CredentialCryptoError) {
				await this.markUnreadable(row.id, Date.now());
				return { ok: false, code: "credential_unreadable" };
			}
			throw error;
		}
	}

	private async markUnreadable(id: string, now: number): Promise<void> {
		await this.db
			.prepare(
				`UPDATE provider_credentials SET status = 'unreadable', updated_at = ?
				 WHERE id = ? AND status = 'active'`,
			)
			.bind(now, id)
			.run();
	}

	/** Crypto-shredding: the row survives for audit, the material does not. */
	async revoke(input: {
		accountId: string;
		mailboxId: string;
		credentialType: CredentialType;
		now: number;
	}): Promise<number> {
		const result = await this.db
			.prepare(
				`UPDATE provider_credentials
				 SET status = 'revoked', ciphertext = NULL, nonce = NULL,
				 wrapped_dek = NULL, wrap_nonce = NULL, revoked_at = ?, updated_at = ?
				 WHERE account_id = ? AND mailbox_id = ? AND credential_type = ?
				 AND status <> 'revoked'`,
			)
			.bind(input.now, input.now, input.accountId, input.mailboxId, input.credentialType)
			.run();
		return result.meta.changes ?? 0;
	}

	async list(accountId: string): Promise<CredentialRecord[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${COLUMNS} FROM provider_credentials
				 WHERE account_id = ? ORDER BY created_at`,
			)
			.bind(accountId)
			.all<CredentialRow>();
		return results.map(toRecord);
	}

	/**
	 * Re-wraps DEKs that are still on an older KEK version. Secrets are never
	 * re-encrypted, so this is safe to run while traffic continues.
	 */
	async rewrapPending(input: {
		keys: CredentialKeys;
		now: number;
		limit?: number;
	}): Promise<{ rewrapped: number; unreadable: number }> {
		if (!input.keys.previous) return { rewrapped: 0, unreadable: 0 };
		const { results } = await this.db
			.prepare(
				`SELECT ${COLUMNS} FROM provider_credentials
				 WHERE key_version <> ? AND status <> 'revoked'
				 AND wrapped_dek IS NOT NULL AND wrap_nonce IS NOT NULL
				 LIMIT ?`,
			)
			.bind(input.keys.current.version, input.limit ?? 25)
			.all<CredentialRow>();

		let rewrapped = 0;
		let unreadable = 0;
		for (const row of results) {
			const previousKek = keyForVersion(input.keys, row.key_version);
			if (!previousKek || !row.wrapped_dek || !row.wrap_nonce) {
				await this.markUnreadable(row.id, input.now);
				unreadable += 1;
				continue;
			}
			try {
				const next = await rewrapDek(
					previousKek,
					input.keys.current.kek,
					{
						dekId: row.dek_id,
						wrappedDek: row.wrapped_dek,
						wrapNonce: row.wrap_nonce,
					},
					row.account_id,
				);
				await this.db
					.prepare(
						`UPDATE provider_credentials
						 SET wrapped_dek = ?, wrap_nonce = ?, key_version = ?, updated_at = ?
						 WHERE id = ?`,
					)
					.bind(next.wrappedDek, next.wrapNonce, input.keys.current.version, input.now, row.id)
					.run();
				rewrapped += 1;
			} catch (error) {
				if (!(error instanceof CredentialCryptoError)) throw error;
				await this.markUnreadable(row.id, input.now);
				unreadable += 1;
			}
		}
		return { rewrapped, unreadable };
	}
}
