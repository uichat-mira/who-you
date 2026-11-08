import type { DraftAddress, DraftContent } from "./draft";

/**
 * Draft, confirmation-nonce and send-receipt persistence. Every statement is
 * scoped by the token-derived account id; draft ids are never an authority
 * claim by themselves.
 */

export type DraftStatus = "draft" | "discarded";

export type DraftRecord = {
	id: string;
	accountId: string;
	mailboxId: string;
	version: number;
	contentHash: string;
	content: DraftContent;
	status: DraftStatus;
	createdAt: number;
	updatedAt: number;
};

export type SendReceipt = {
	id: string;
	accountId: string;
	draftId: string;
	draftVersion: number;
	contentHash: string;
	idempotencyKey: string;
	status: "sent" | "failed";
	errorCode: string | null;
	providerMessageId: string | null;
	createdAt: number;
};

export type DraftCursor = { updatedAt: number; id: string };

type DraftRow = {
	id: string;
	account_id: string;
	mailbox_id: string;
	version: number;
	content_hash: string;
	to_json: string;
	cc_json: string;
	bcc_json: string;
	subject: string;
	text_body: string;
	html_body: string | null;
	status: DraftStatus;
	created_at: number;
	updated_at: number;
};

type ReceiptRow = {
	id: string;
	account_id: string;
	draft_id: string;
	draft_version: number;
	content_hash: string;
	idempotency_key: string;
	status: "sent" | "failed";
	error_code: string | null;
	provider_message_id: string | null;
	created_at: number;
};

const parseAddresses = (value: string): DraftAddress[] => {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((entry) => {
			if (!entry || typeof entry !== "object") return [];
			const record = entry as { name?: unknown; address?: unknown };
			if (typeof record.name !== "string" || typeof record.address !== "string") return [];
			return [{ name: record.name, address: record.address }];
		});
	} catch {
		return [];
	}
};

const toDraft = (row: DraftRow): DraftRecord => ({
	id: row.id,
	accountId: row.account_id,
	mailboxId: row.mailbox_id,
	version: row.version,
	contentHash: row.content_hash,
	content: {
		to: parseAddresses(row.to_json),
		cc: parseAddresses(row.cc_json),
		bcc: parseAddresses(row.bcc_json),
		subject: row.subject,
		text: row.text_body,
		html: row.html_body,
	},
	status: row.status,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

const toReceipt = (row: ReceiptRow): SendReceipt => ({
	id: row.id,
	accountId: row.account_id,
	draftId: row.draft_id,
	draftVersion: row.draft_version,
	contentHash: row.content_hash,
	idempotencyKey: row.idempotency_key,
	status: row.status,
	errorCode: row.error_code,
	providerMessageId: row.provider_message_id,
	createdAt: row.created_at,
});

const RECEIPT_COLUMNS = `
	r.id, r.account_id, r.draft_id, r.draft_version, r.content_hash,
	r.idempotency_key, r.status, r.error_code, r.provider_message_id, r.created_at`;

export class DraftRepository {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	async createDraft(draft: {
		id: string;
		accountId: string;
		mailboxId: string;
		version: number;
		contentHash: string;
		content: DraftContent;
		now: number;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO mail_drafts (
				 id, account_id, mailbox_id, version, content_hash,
				 to_json, cc_json, bcc_json, subject, text_body, html_body,
				 status, created_at, updated_at
				 ) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`,
			)
			.bind(
				draft.id,
				draft.accountId,
				draft.mailboxId,
				draft.version,
				draft.contentHash,
				JSON.stringify(draft.content.to),
				JSON.stringify(draft.content.cc),
				JSON.stringify(draft.content.bcc),
				draft.content.subject,
				draft.content.text,
				draft.content.html,
				draft.now,
				draft.now,
			)
			.run();
	}

	async getDraft(accountId: string, draftId: string): Promise<DraftRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT id, account_id, mailbox_id, version, content_hash,
				 to_json, cc_json, bcc_json, subject, text_body, html_body,
				 status, created_at, updated_at
				 FROM mail_drafts WHERE account_id = ? AND id = ? LIMIT 1`,
			)
			.bind(accountId, draftId)
			.first<DraftRow>();
		return row ? toDraft(row) : null;
	}

	/** Active drafts only, newest update first. Returns `limit + 1` rows. */
	async listDrafts(
		accountId: string,
		limit: number,
		cursor?: DraftCursor,
	): Promise<DraftRecord[]> {
		const clauses = ["account_id = ?", "status = 'draft'"];
		const bindings: (string | number)[] = [accountId];
		if (cursor) {
			clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
			bindings.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
		}
		bindings.push(limit + 1);
		const rows = await this.db
			.prepare(
				`SELECT id, account_id, mailbox_id, version, content_hash,
				 to_json, cc_json, bcc_json, subject, text_body, html_body,
				 status, created_at, updated_at
				 FROM mail_drafts
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY updated_at DESC, id DESC
				 LIMIT ?`,
			)
			.bind(...bindings)
			.all<DraftRow>();
		return (rows.results ?? []).map(toDraft);
	}

	/**
	 * Optimistic-concurrency update. The `version = ?` predicate is the guard:
	 * a stale revision loses the race and receives zero changed rows instead of
	 * overwriting content the user did not confirm.
	 */
	async updateDraft(draft: {
		accountId: string;
		draftId: string;
		expectedVersion: number;
		contentHash: string;
		content: DraftContent;
		now: number;
	}): Promise<boolean> {
		const result = await this.db
			.prepare(
				`UPDATE mail_drafts SET
				 version = version + 1, content_hash = ?, to_json = ?, cc_json = ?, bcc_json = ?,
				 subject = ?, text_body = ?, html_body = ?, updated_at = ?
				 WHERE account_id = ? AND id = ? AND version = ? AND status = 'draft'`,
			)
			.bind(
				draft.contentHash,
				JSON.stringify(draft.content.to),
				JSON.stringify(draft.content.cc),
				JSON.stringify(draft.content.bcc),
				draft.content.subject,
				draft.content.text,
				draft.content.html,
				draft.now,
				draft.accountId,
				draft.draftId,
				draft.expectedVersion,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async discardDraft(accountId: string, draftId: string, now: number): Promise<boolean> {
		const result = await this.db
			.prepare(
				`UPDATE mail_drafts SET status = 'discarded', updated_at = ?
				 WHERE account_id = ? AND id = ? AND status = 'draft'`,
			)
			.bind(now, accountId, draftId)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	/**
	 * Atomic single-use gate. Any send side effect happens only after this
	 * insert reports one changed row; a conflict means the credential nonce was
	 * already spent (including a concurrent replay).
	 */
	async consumeNonce(options: {
		nonce: string;
		accountId: string;
		draftId: string;
		now: number;
	}): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO confirmation_nonces (nonce, account_id, draft_id, consumed_at)
				 VALUES (?,?,?,?)
				 ON CONFLICT (nonce) DO NOTHING`,
			)
			.bind(options.nonce, options.accountId, options.draftId, options.now)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async findReceipt(
		accountId: string,
		idempotencyKey: string,
	): Promise<SendReceipt | null> {
		const row = await this.db
			.prepare(
				`SELECT ${RECEIPT_COLUMNS}
				 FROM send_receipts r
				 WHERE r.account_id = ? AND r.idempotency_key = ?
				 LIMIT 1`,
			)
			.bind(accountId, idempotencyKey)
			.first<ReceiptRow>();
		return row ? toReceipt(row) : null;
	}

	/** Insert-only receipt. A conflict keeps the first durable answer. */
	async insertReceipt(receipt: SendReceipt): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO send_receipts (
				 id, account_id, draft_id, draft_version, content_hash,
				 idempotency_key, status, error_code, provider_message_id, created_at
				 ) VALUES (?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT (account_id, idempotency_key) DO NOTHING`,
			)
			.bind(
				receipt.id,
				receipt.accountId,
				receipt.draftId,
				receipt.draftVersion,
				receipt.contentHash,
				receipt.idempotencyKey,
				receipt.status,
				receipt.errorCode,
				receipt.providerMessageId,
				receipt.createdAt,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}
}
