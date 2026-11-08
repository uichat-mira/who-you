import { mailboxAddress, normalizeLocalPart } from "./address";
import { sha256Hex } from "./hash";

export type MailboxStatus = "active" | "disabled";

export type MailboxRecord = {
	id: string;
	accountId: string;
	address: string;
	localPart: string;
	status: MailboxStatus;
	quotaBytes: number;
	bytesUsed: number;
	messageCount: number;
	quarantineCount: number;
	createdAt: number;
};

export type MailAddressJson = { name: string; address: string };

export type MessageSummary = {
	id: string;
	threadId: string;
	direction: "inbound" | "outbound";
	internetMessageId: string;
	from: MailAddressJson[];
	to: MailAddressJson[];
	cc: MailAddressJson[];
	subject: string;
	sentAt: number | null;
	receivedAt: number;
	sizeBytes: number;
	snippet: string;
	attachmentCount: number;
	authResults: string;
	dmarc: string;
	state: "visible" | "quarantined";
	quarantineReason: string | null;
};

export type MessageRecord = MessageSummary & {
	mailboxId: string;
	envelopeFrom: string | null;
	envelopeTo: string;
	textKey: string | null;
	htmlKey: string | null;
};

export type AttachmentRecord = {
	id: string;
	messageId: string;
	mailboxId: string;
	partPath: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	disposition: string;
	contentId: string | null;
	r2Key: string;
};

export type NewMailbox = {
	id: string;
	accountId: string;
	address: string;
	localPart: string;
	quotaBytes: number;
	now: number;
};

export type NewMessage = {
	id: string;
	mailboxId: string;
	threadId: string;
	direction: "inbound" | "outbound";
	internetMessageId: string;
	envelopeFrom: string | null;
	envelopeTo: string;
	from: MailAddressJson[];
	to: MailAddressJson[];
	cc: MailAddressJson[];
	subject: string;
	fromText: string;
	searchText: string;
	sentAt: number | null;
	receivedAt: number;
	sizeBytes: number;
	snippet: string;
	attachmentCount: number;
	authResults: string;
	dmarc: string;
	state: "visible" | "quarantined";
	quarantineReason: string | null;
	rawKey: string;
	textKey: string | null;
	htmlKey: string | null;
};

export type NewThread = {
	id: string;
	mailboxId: string;
	threadKey: string;
	rootMessageId: string | null;
	lastMessageAt: number;
};

export type SearchFilters = {
	query?: string;
	from?: string;
	direction?: "inbound" | "outbound";
	since?: number;
	until?: number;
	hasAttachments?: boolean;
	threadId?: string;
	limit: number;
	cursor?: { receivedAt: number; id: string };
};

export type ProvisionResult =
	| { ok: true; mailbox: MailboxRecord; created: boolean }
	| { ok: false; reason: "invalid_local_part" | "reserved_local_part" | "mailbox_exists" | "address_conflict" };

const objectPrefix = (accountId: string, mailboxId: string, messageId: string): string =>
	`accounts/${encodeURIComponent(accountId)}/mailboxes/${encodeURIComponent(mailboxId)}/messages/${messageId}`;

export const mailObjectKeys = {
	raw: (accountId: string, mailboxId: string, messageId: string): string =>
		`${objectPrefix(accountId, mailboxId, messageId)}/raw.eml`,
	text: (accountId: string, mailboxId: string, messageId: string): string =>
		`${objectPrefix(accountId, mailboxId, messageId)}/body.txt`,
	html: (accountId: string, mailboxId: string, messageId: string): string =>
		`${objectPrefix(accountId, mailboxId, messageId)}/body.html`,
	attachment: (
		accountId: string,
		mailboxId: string,
		messageId: string,
		attachmentId: string,
	): string =>
		`${objectPrefix(accountId, mailboxId, messageId)}/attachments/${attachmentId}`,
};

const parseJson = <T>(value: unknown, fallback: T): T => {
	if (typeof value !== "string") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
};

type MailboxRow = {
	id: string;
	account_id: string;
	address: string;
	local_part: string;
	status: MailboxStatus;
	quota_bytes: number;
	bytes_used: number;
	message_count: number;
	quarantine_count: number;
	created_at: number;
};

type MessageRow = {
	id: string;
	mailbox_id: string;
	thread_id: string;
	direction: "inbound" | "outbound";
	internet_message_id: string;
	envelope_from: string | null;
	envelope_to: string;
	from_json: string;
	to_json: string;
	cc_json: string;
	subject: string | null;
	sent_at: number | null;
	received_at: number;
	size_bytes: number;
	snippet: string;
	attachment_count: number;
	auth_results: string;
	dmarc: string;
	state: "visible" | "quarantined";
	quarantine_reason: string | null;
	text_key: string | null;
	html_key: string | null;
};

type AttachmentRow = {
	id: string;
	message_id: string;
	mailbox_id: string;
	part_path: string;
	filename: string;
	mime_type: string;
	size_bytes: number;
	disposition: string;
	content_id: string | null;
	r2_key: string;
};

const toMailbox = (row: MailboxRow): MailboxRecord => ({
	id: row.id,
	accountId: row.account_id,
	address: row.address,
	localPart: row.local_part,
	status: row.status,
	quotaBytes: row.quota_bytes,
	bytesUsed: row.bytes_used,
	messageCount: row.message_count,
	quarantineCount: row.quarantine_count,
	createdAt: row.created_at,
});

const toMessageSummary = (row: MessageRow): MessageSummary => ({
	id: row.id,
	threadId: row.thread_id,
	direction: row.direction,
	internetMessageId: row.internet_message_id,
	from: parseJson<MailAddressJson[]>(row.from_json, []),
	to: parseJson<MailAddressJson[]>(row.to_json, []),
	cc: parseJson<MailAddressJson[]>(row.cc_json, []),
	subject: row.subject ?? "",
	sentAt: row.sent_at,
	receivedAt: row.received_at,
	sizeBytes: row.size_bytes,
	snippet: row.snippet,
	attachmentCount: row.attachment_count,
	authResults: row.auth_results,
	dmarc: row.dmarc,
	state: row.state,
	quarantineReason: row.quarantine_reason,
});

const toMessageRecord = (row: MessageRow): MessageRecord => ({
	...toMessageSummary(row),
	mailboxId: row.mailbox_id,
	envelopeFrom: row.envelope_from,
	envelopeTo: row.envelope_to,
	textKey: row.text_key,
	htmlKey: row.html_key,
});

const toAttachment = (row: AttachmentRow): AttachmentRecord => ({
	id: row.id,
	messageId: row.message_id,
	mailboxId: row.mailbox_id,
	partPath: row.part_path,
	filename: row.filename,
	mimeType: row.mime_type,
	sizeBytes: row.size_bytes,
	disposition: row.disposition,
	contentId: row.content_id,
	r2Key: row.r2_key,
});

const MESSAGE_COLUMNS = `
	m.id, m.mailbox_id, m.thread_id, m.direction, m.internet_message_id,
	m.envelope_from, m.envelope_to, m.from_json, m.to_json, m.cc_json,
	m.subject, m.sent_at, m.received_at, m.size_bytes, m.snippet,
	m.attachment_count, m.auth_results, m.dmarc, m.state, m.quarantine_reason,
	m.text_key, m.html_key`;

export class MailRepository {
	private readonly db: D1Database;
	private readonly bucket: R2Bucket;

	constructor(db: D1Database, bucket: R2Bucket) {
		this.db = db;
		this.bucket = bucket;
	}

	async findMailboxByAddress(address: string): Promise<MailboxRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT id, account_id, address, local_part, status, quota_bytes, bytes_used,
				 message_count, quarantine_count, created_at
				 FROM mailboxes WHERE address = ? LIMIT 1`,
			)
			.bind(address)
			.first<MailboxRow>();
		return row ? toMailbox(row) : null;
	}

	async findMailboxByAccount(accountId: string): Promise<MailboxRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT id, account_id, address, local_part, status, quota_bytes, bytes_used,
				 message_count, quarantine_count, created_at
				 FROM mailboxes WHERE account_id = ? LIMIT 1`,
			)
			.bind(accountId)
			.first<MailboxRow>();
		return row ? toMailbox(row) : null;
	}

	async insertMailbox(mailbox: NewMailbox): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO mailboxes (
				 id, account_id, address, local_part, status, quota_bytes,
				 bytes_used, message_count, quarantine_count, created_at, updated_at
				 ) VALUES (?,?,?,?, 'active', ?, 0, 0, 0, ?, ?)
				 ON CONFLICT (address) DO NOTHING`,
			)
			.bind(
				mailbox.id,
				mailbox.accountId,
				mailbox.address,
				mailbox.localPart,
				mailbox.quotaBytes,
				mailbox.now,
				mailbox.now,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async messageExists(mailboxId: string, internetMessageId: string): Promise<boolean> {
		const row = await this.db
			.prepare("SELECT id FROM messages WHERE mailbox_id = ? AND internet_message_id = ?")
			.bind(mailboxId, internetMessageId)
			.first<{ id: string }>();
		return Boolean(row);
	}

	async putObject(key: string, data: Uint8Array, contentType: string): Promise<void> {
		await this.bucket.put(key, data, {
			httpMetadata: { contentType },
		});
	}

	async deleteObjects(keys: string[]): Promise<void> {
		if (!keys.length) return;
		await this.bucket.delete(keys);
	}

	async getObject(key: string): Promise<{ bytes: ArrayBuffer; size: number } | null> {
		const object = await this.bucket.get(key);
		if (!object) return null;
		return { bytes: await object.arrayBuffer(), size: object.size };
	}

	/**
	 * Writes message metadata, thread continuity, attachments and mailbox usage
	 * in one D1 batch. The message insert is `ON CONFLICT DO NOTHING`, so a
	 * concurrent duplicate delivery cannot create a second row. A fresh attempt
	 * id makes the dependent statements conditional on the winning insert.
	 */
	async insertMessage(
		message: NewMessage,
		thread: NewThread,
		attachments: AttachmentRecord[],
		receivedAt: number,
	): Promise<boolean> {
		const statements: D1PreparedStatement[] = [
			this.db
				.prepare(
					`INSERT INTO messages (
					 id, mailbox_id, thread_id, direction, internet_message_id,
					 envelope_from, envelope_to, from_json, to_json, cc_json,
					 subject, from_text, search_text, sent_at, received_at,
					 size_bytes, snippet, attachment_count, auth_results, dmarc,
					 state, quarantine_reason, raw_key, text_key, html_key
				 ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT (mailbox_id, internet_message_id) DO NOTHING`,
				)
				.bind(
					message.id,
					message.mailboxId,
					message.threadId,
					message.direction,
					message.internetMessageId,
					message.envelopeFrom,
					message.envelopeTo,
					JSON.stringify(message.from),
					JSON.stringify(message.to),
					JSON.stringify(message.cc),
					message.subject,
					message.fromText,
					message.searchText,
					message.sentAt,
					message.receivedAt,
					message.sizeBytes,
					message.snippet,
					message.attachmentCount,
					message.authResults,
					message.dmarc,
					message.state,
					message.quarantineReason,
					message.rawKey,
					message.textKey,
					message.htmlKey,
				),
			this.db
				.prepare(
					`INSERT INTO threads (
					 id, mailbox_id, thread_key, root_message_id, last_message_at, message_count
				 ) SELECT ?,?,?,?,?,1
				 WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)
				 ON CONFLICT (mailbox_id, thread_key) DO UPDATE SET
					 last_message_at = MAX(last_message_at, excluded.last_message_at),
					 message_count = message_count + 1`,
				)
				.bind(
					thread.id,
					thread.mailboxId,
					thread.threadKey,
					thread.rootMessageId,
					thread.lastMessageAt,
					message.id,
				),
			...attachments.map((attachment) =>
				this.db
					.prepare(
						`INSERT INTO attachments (
						 id, message_id, mailbox_id, part_path, filename, mime_type,
						 size_bytes, disposition, content_id, r2_key
					 ) SELECT ?,?,?,?,?,?,?,?,?,?
					 WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)
					 ON CONFLICT (message_id, part_path) DO NOTHING`,
					)
					.bind(
						attachment.id,
						attachment.messageId,
						attachment.mailboxId,
						attachment.partPath,
						attachment.filename,
						attachment.mimeType,
						attachment.sizeBytes,
						attachment.disposition,
						attachment.contentId,
						attachment.r2Key,
						message.id,
					),
			),
			this.db
				.prepare(
					`UPDATE mailboxes
					 SET bytes_used = bytes_used + ?,
					     message_count = message_count + 1,
					     quarantine_count = quarantine_count + ?,
					     updated_at = ?
					 WHERE id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
				)
				.bind(message.sizeBytes, message.state === "quarantined" ? 1 : 0, receivedAt, message.mailboxId, message.id),
		];

		const results = await this.db.batch(statements);
		return (results[0]?.meta.changes ?? 0) > 0;
	}

	async search(accountId: string, filters: SearchFilters): Promise<MessageSummary[]> {
		const clauses = ["b.account_id = ?", "m.state = 'visible'"];
		const bindings: (string | number)[] = [accountId];
		if (filters.direction) {
			clauses.push("m.direction = ?");
			bindings.push(filters.direction);
		}
		if (filters.query) {
			clauses.push("instr(m.search_text, ?) > 0");
			bindings.push(filters.query);
		}
		if (filters.from) {
			clauses.push("instr(m.from_text, ?) > 0");
			bindings.push(filters.from);
		}
		if (filters.since !== undefined) {
			clauses.push("m.received_at >= ?");
			bindings.push(filters.since);
		}
		if (filters.until !== undefined) {
			clauses.push("m.received_at <= ?");
			bindings.push(filters.until);
		}
		if (filters.hasAttachments) {
			clauses.push("m.attachment_count > 0");
		}
		if (filters.threadId) {
			clauses.push("m.thread_id = ?");
			bindings.push(filters.threadId);
		}
		if (filters.cursor) {
			clauses.push("(m.received_at < ? OR (m.received_at = ? AND m.id < ?))");
			bindings.push(filters.cursor.receivedAt, filters.cursor.receivedAt, filters.cursor.id);
		}
		bindings.push(filters.limit + 1);

		const rows = await this.db
			.prepare(
				`SELECT ${MESSAGE_COLUMNS}
				 FROM messages m
				 JOIN mailboxes b ON b.id = m.mailbox_id
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY m.received_at DESC, m.id DESC
				 LIMIT ?`,
			)
			.bind(...bindings)
			.all<MessageRow>();
		return (rows.results ?? []).map(toMessageSummary);
	}

	async getThread(
		accountId: string,
		threadId: string,
		limit: number,
	): Promise<MessageSummary[]> {
		const rows = await this.db
			.prepare(
				`SELECT ${MESSAGE_COLUMNS}
				 FROM messages m
				 JOIN mailboxes b ON b.id = m.mailbox_id
				 WHERE b.account_id = ? AND m.thread_id = ? AND m.state = 'visible'
				 ORDER BY m.received_at ASC, m.id ASC
				 LIMIT ?`,
			)
			.bind(accountId, threadId, limit)
			.all<MessageRow>();
		return (rows.results ?? []).map(toMessageSummary);
	}

	async getMessage(accountId: string, messageId: string): Promise<MessageRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT ${MESSAGE_COLUMNS}
				 FROM messages m
				 JOIN mailboxes b ON b.id = m.mailbox_id
				 WHERE b.account_id = ? AND m.id = ?
				 LIMIT 1`,
			)
			.bind(accountId, messageId)
			.first<MessageRow>();
		return row ? toMessageRecord(row) : null;
	}

	async listAttachments(accountId: string, messageId: string): Promise<AttachmentRecord[]> {
		const rows = await this.db
			.prepare(
				`SELECT a.id, a.message_id, a.mailbox_id, a.part_path, a.filename, a.mime_type,
				 a.size_bytes, a.disposition, a.content_id, a.r2_key
				 FROM attachments a
				 JOIN messages m ON m.id = a.message_id
				 JOIN mailboxes b ON b.id = m.mailbox_id
				 WHERE b.account_id = ? AND m.id = ? AND m.state = 'visible'
				 ORDER BY a.part_path ASC`,
			)
			.bind(accountId, messageId)
			.all<AttachmentRow>();
		return (rows.results ?? []).map(toAttachment);
	}

	async getAttachment(
		accountId: string,
		messageId: string,
		attachmentId: string,
	): Promise<AttachmentRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT a.id, a.message_id, a.mailbox_id, a.part_path, a.filename, a.mime_type,
				 a.size_bytes, a.disposition, a.content_id, a.r2_key
				 FROM attachments a
				 JOIN messages m ON m.id = a.message_id
				 JOIN mailboxes b ON b.id = m.mailbox_id
				 WHERE b.account_id = ? AND m.id = ? AND a.id = ?
				 LIMIT 1`,
			)
			.bind(accountId, messageId, attachmentId)
			.first<AttachmentRow>();
		return row ? toAttachment(row) : null;
	}
}

/**
 * Idempotent S1 address provisioning. The account-creation caller does not
 * exist yet; the Cloud Auth account-provisioning contract is a separate task.
 * Re-provisioning the same account and address returns the existing row.
 */
export async function provisionMailbox(
	repository: MailRepository,
	options: {
		accountId: string;
		localPart: string;
		domain: string;
		quotaBytes: number;
		now: number;
	},
): Promise<ProvisionResult> {
	const normalized = normalizeLocalPart(options.localPart);
	if (!normalized.ok) return { ok: false, reason: normalized.reason };

	const existing = await repository.findMailboxByAccount(options.accountId);
	if (existing) {
		return existing.address === mailboxAddress(normalized.localPart, options.domain)
			? { ok: true, mailbox: existing, created: false }
			: { ok: false, reason: "mailbox_exists" };
	}

	const base = normalized.localPart;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const candidate =
			attempt === 0
				? base
				: `${base.slice(0, 27)}-${(await sha256Hex(`${options.accountId}:${attempt}`)).slice(0, 4)}`;
		const id = `mbx_${(await sha256Hex(`${options.accountId}\n${candidate}`)).slice(0, 32)}`;
		const address = mailboxAddress(candidate, options.domain);
		const inserted = await repository.insertMailbox({
			id,
			accountId: options.accountId,
			address,
			localPart: candidate,
			quotaBytes: options.quotaBytes,
			now: options.now,
		});
		if (inserted) {
			return {
				ok: true,
				created: true,
				mailbox: {
					id,
					accountId: options.accountId,
					address,
					localPart: candidate,
					status: "active",
					quotaBytes: options.quotaBytes,
					bytesUsed: 0,
					messageCount: 0,
					quarantineCount: 0,
					createdAt: options.now,
				},
			};
		}
		const raced = await repository.findMailboxByAccount(options.accountId);
		if (raced) {
			return raced.address === address
				? { ok: true, mailbox: raced, created: false }
				: { ok: false, reason: "mailbox_exists" };
		}
	}
	return { ok: false, reason: "address_conflict" };
}
