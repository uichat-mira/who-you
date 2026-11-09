import { mailboxAddress, normalizeLocalPart } from "./address";
import { sha256Hex } from "./hash";
import type { MailBucket, SqlDatabase, SqlStatement } from "./ports";

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
	/** Automatic deliverability/abuse pause; receiving stays enabled. */
	sendPausedAt: number | null;
	sendPausedReason: string | null;
	createdAt: number;
};

export type MailAddressJson = { name: string; address: string };

export type MessageFlags = {
	read: boolean;
	starred: boolean;
	archived: boolean;
	trashed: boolean;
};

/** Which mailbox view a search covers. `all` ignores the folder split. */
export type MessageFolder = "inbox" | "archive" | "trash" | "all";

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
	flags: MessageFlags;
	flagVersion: number;
};

export type MessageRecord = MessageSummary & {
	mailboxId: string;
	envelopeFrom: string | null;
	envelopeTo: string;
	rawKey: string;
	textKey: string | null;
	htmlKey: string | null;
};

/** The message fields every outward view shares; callers add their own extras. */
export const messageFields = (message: MessageSummary): Record<string, unknown> => ({
	id: message.id,
	threadId: message.threadId,
	direction: message.direction,
	internetMessageId: message.internetMessageId,
	from: message.from,
	to: message.to,
	cc: message.cc,
	subject: message.subject,
	sentAt: message.sentAt,
	receivedAt: message.receivedAt,
	sizeBytes: message.sizeBytes,
});

export type ExportRecord = {
	id: string;
	accountId: string;
	mailboxId: string;
	exportDay: string;
	messageCount: number;
	skippedCount: number;
	byteSize: number;
	r2Key: string;
	createdAt: number;
};

export type AuditAction = "export" | "delete_message" | "delete_mailbox";

export type NewAuditEntry = {
	id: string;
	accountId: string;
	action: AuditAction;
	targetId: string | null;
	detail: string;
	createdAt: number;
};

export type DeliveryEventType =
	| "delivered"
	| "soft_bounce"
	| "hard_bounce"
	| "complaint"
	| "dsn";

export type NewDeliveryEvent = {
	id: string;
	accountId: string;
	sendReceiptId: string | null;
	providerMessageId: string | null;
	type: DeliveryEventType;
	/** SHA-256 of the normalized recipient; the address itself is not stored. */
	recipientHash: string;
	recipientDomain: string;
	status: string | null;
	diagnosticCode: string | null;
	occurredAt: number;
	createdAt: number;
};

export type SuppressionReason = "hard_bounce" | "complaint";

export type NewSuppression = {
	accountId: string;
	recipient: string;
	reason: SuppressionReason;
	sourceEventId: string | null;
	createdAt: number;
};

export type SendPause = { pausedAt: number; reason: string | null };

export type AbuseWindowCounts = {
	sends: number;
	hardBounces: number;
	complaints: number;
	externalRecipients: number;
};

export type DeliverabilityAlertKind =
	| "hard_bounce_rate"
	| "complaint_rate"
	| "external_volume"
	| "send_paused";

export type NewDeliverabilityAlert = {
	id: string;
	accountId: string;
	kind: DeliverabilityAlertKind;
	detail: string;
	createdAt: number;
};

export type DeliverabilityTotals = {
	sends: number;
	externalRecipients: number;
	delivered: number;
	softBounces: number;
	hardBounces: number;
	complaints: number;
};

export type ReceiptLookup = { id: string; accountId: string };

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
	folder?: MessageFolder;
	unreadOnly?: boolean;
	starredOnly?: boolean;
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
	send_paused_at: number | null;
	send_paused_reason: string | null;
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
	raw_key: string;
	text_key: string | null;
	html_key: string | null;
	is_read: number;
	is_starred: number;
	is_archived: number;
	is_trashed: number;
	flag_version: number;
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
	sendPausedAt: row.send_paused_at,
	sendPausedReason: row.send_paused_reason,
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
	flags: {
		read: row.is_read === 1,
		starred: row.is_starred === 1,
		archived: row.is_archived === 1,
		trashed: row.is_trashed === 1,
	},
	flagVersion: row.flag_version,
});

const toMessageRecord = (row: MessageRow): MessageRecord => ({
	...toMessageSummary(row),
	mailboxId: row.mailbox_id,
	envelopeFrom: row.envelope_from,
	envelopeTo: row.envelope_to,
	rawKey: row.raw_key,
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
	m.raw_key, m.text_key, m.html_key,
	m.is_read, m.is_starred, m.is_archived, m.is_trashed, m.flag_version`;

type ExportRow = {
	id: string;
	account_id: string;
	mailbox_id: string;
	export_day: string;
	message_count: number;
	skipped_count: number;
	byte_size: number;
	r2_key: string;
	created_at: number;
};

const toExport = (row: ExportRow): ExportRecord => ({
	id: row.id,
	accountId: row.account_id,
	mailboxId: row.mailbox_id,
	exportDay: row.export_day,
	messageCount: row.message_count,
	skippedCount: row.skipped_count,
	byteSize: row.byte_size,
	r2Key: row.r2_key,
	createdAt: row.created_at,
});

const flagInt = (value: boolean): number => (value ? 1 : 0);

const flagsEqual = (left: MessageFlags, right: MessageFlags): boolean =>
	left.read === right.read &&
	left.starred === right.starred &&
	left.archived === right.archived &&
	left.trashed === right.trashed;

export type FlagUpdateResult =
	| { ok: true; message: MessageSummary; changed: boolean }
	| {
			ok: false;
			reason: "message_not_found" | "message_quarantined" | "flag_version_conflict";
			currentVersion?: number;
	  };

export class MailRepository {
	private readonly db: SqlDatabase;
	private readonly bucket: MailBucket;

	constructor(db: SqlDatabase, bucket: MailBucket) {
		this.db = db;
		this.bucket = bucket;
	}

	async findMailboxByAddress(address: string): Promise<MailboxRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT id, account_id, address, local_part, status, quota_bytes, bytes_used,
				 message_count, quarantine_count, send_paused_at, send_paused_reason,
				 created_at
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
				 message_count, quarantine_count, send_paused_at, send_paused_reason,
				 created_at
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
		return { bytes: await new Response(object.body).arrayBuffer(), size: object.size };
	}

	/**
	 * Writes message metadata, thread continuity, attachments and mailbox usage
	 * in one D1 batch. The message insert is `ON CONFLICT DO NOTHING`, so a
	 * concurrent duplicate delivery cannot create a second row.
	 */
	async insertMessage(
		message: NewMessage,
		thread: NewThread,
		attachments: AttachmentRecord[],
		receivedAt: number,
	): Promise<boolean> {
		const statements: SqlStatement[] = [
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
				 ) VALUES (?,?,?,?,?,1)
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
				),
			...attachments.map((attachment) =>
				this.db
					.prepare(
						`INSERT INTO attachments (
						 id, message_id, mailbox_id, part_path, filename, mime_type,
						 size_bytes, disposition, content_id, r2_key
					 ) VALUES (?,?,?,?,?,?,?,?,?,?)
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
					),
			),
			this.db
				.prepare(
					`UPDATE mailboxes
					 SET bytes_used = bytes_used + ?,
					     message_count = message_count + 1,
					     quarantine_count = quarantine_count + ?,
					     updated_at = ?
					 WHERE id = ?`,
				)
				.bind(message.sizeBytes, message.state === "quarantined" ? 1 : 0, receivedAt, message.mailboxId),
		];

		const results = await this.db.batch(statements);
		return (results[0]?.meta.changes ?? 0) > 0;
	}

	async search(accountId: string, filters: SearchFilters): Promise<MessageSummary[]> {
		const folder = filters.folder ?? "inbox";
		const clauses = ["b.account_id = ?", "m.state = 'visible'"];
		const bindings: (string | number)[] = [accountId];
		// Trash is its own view: a normal search must not resurface deleted mail.
		// Quarantine stays excluded everywhere because those messages are not
		// visible to the account until an operator releases them.
		if (folder === "inbox") {
			clauses.push("m.is_trashed = 0", "m.is_archived = 0");
		} else if (folder === "archive") {
			clauses.push("m.is_trashed = 0", "m.is_archived = 1");
		} else if (folder === "trash") {
			clauses.push("m.is_trashed = 1");
		}
		if (filters.unreadOnly) {
			clauses.push("m.is_read = 0");
		}
		if (filters.starredOnly) {
			clauses.push("m.is_starred = 1");
		}
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

	/**
	 * Attachment lookup for signed download. Unlike `listAttachments` it also
	 * returns quarantined messages, because the route must fail explicitly
	 * (`message_quarantined`) instead of pretending the object never existed.
	 */
	async findAttachmentForDownload(
		accountId: string,
		messageId: string,
		attachmentId: string,
	): Promise<{ attachment: AttachmentRecord; state: "visible" | "quarantined" } | null> {
		const row = await this.db
			.prepare(
				`SELECT a.id, a.message_id, a.mailbox_id, a.part_path, a.filename, a.mime_type,
				 a.size_bytes, a.disposition, a.content_id, a.r2_key, m.state
				 FROM attachments a
				 JOIN messages m ON m.id = a.message_id
				 JOIN mailboxes b ON b.id = m.mailbox_id
				 WHERE b.account_id = ? AND m.id = ? AND a.id = ?
				 LIMIT 1`,
			)
			.bind(accountId, messageId, attachmentId)
			.first<AttachmentRow & { state: "visible" | "quarantined" }>();
		if (!row) return null;
		return { attachment: toAttachment(row), state: row.state };
	}

	async readObject(key: string): Promise<{ body: ReadableStream; size: number } | null> {
		const object = await this.bucket.get(key);
		if (!object) return null;
		return { body: object.body, size: object.size };
	}

	/**
	 * Optimistic, idempotent flag write.
	 *
	 * A repeated identical write returns the current message without bumping the
	 * version, and a concurrent identical write that loses the CAS re-reads and
	 * reports `changed: false` instead of a spurious conflict.
	 */
	async updateFlags(
		accountId: string,
		messageId: string,
		patch: Partial<MessageFlags>,
		expectedVersion: number | undefined,
		now: number,
	): Promise<FlagUpdateResult> {
		const lookup = async (): Promise<MessageRow | null> =>
			this.db
				.prepare(
					`SELECT ${MESSAGE_COLUMNS}
					 FROM messages m
					 JOIN mailboxes b ON b.id = m.mailbox_id
					 WHERE b.account_id = ? AND m.id = ?
					 LIMIT 1`,
				)
				.bind(accountId, messageId)
				.first<MessageRow>();

		const row = await lookup();
		if (!row) return { ok: false, reason: "message_not_found" };
		if (row.state === "quarantined") return { ok: false, reason: "message_quarantined" };

		const current = toMessageSummary(row);
		const target: MessageFlags = { ...current.flags, ...patch };
		const unchanged = flagsEqual(current.flags, target);
		if (expectedVersion !== undefined && expectedVersion !== current.flagVersion) {
			return unchanged
				? { ok: true, message: current, changed: false }
				: { ok: false, reason: "flag_version_conflict", currentVersion: current.flagVersion };
		}
		if (unchanged) return { ok: true, message: current, changed: false };

		const result = await this.db
			.prepare(
				`UPDATE messages
				 SET is_read = ?, is_starred = ?, is_archived = ?, is_trashed = ?,
				 flag_version = flag_version + 1, flags_updated_at = ?
				 WHERE id = ? AND mailbox_id = ? AND flag_version = ?`,
			)
			.bind(
				flagInt(target.read),
				flagInt(target.starred),
				flagInt(target.archived),
				flagInt(target.trashed),
				now,
				current.id,
				row.mailbox_id,
				current.flagVersion,
			)
			.run();
		if ((result.meta.changes ?? 0) === 0) {
			const latest = await lookup();
			if (!latest) return { ok: false, reason: "message_not_found" };
			const latestSummary = toMessageSummary(latest);
			if (flagsEqual(latestSummary.flags, target)) {
				return { ok: true, message: latestSummary, changed: false };
			}
			return {
				ok: false,
				reason: "flag_version_conflict",
				currentVersion: latestSummary.flagVersion,
			};
		}

		const updated = await lookup();
		return updated
			? { ok: true, message: toMessageSummary(updated), changed: true }
			: { ok: false, reason: "message_not_found" };
	}

	async listExportMessages(accountId: string, limit: number): Promise<MessageRecord[]> {
		const rows = await this.db
			.prepare(
				`SELECT ${MESSAGE_COLUMNS}
				 FROM messages m
				 JOIN mailboxes b ON b.id = m.mailbox_id
				 WHERE b.account_id = ?
				 ORDER BY m.received_at ASC, m.id ASC
				 LIMIT ?`,
			)
			.bind(accountId, limit)
			.all<MessageRow>();
		return (rows.results ?? []).map(toMessageRecord);
	}

	async findExport(accountId: string, exportId: string): Promise<ExportRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT id, account_id, mailbox_id, export_day, message_count, skipped_count,
				 byte_size, r2_key, created_at
				 FROM mail_exports WHERE account_id = ? AND id = ? LIMIT 1`,
			)
			.bind(accountId, exportId)
			.first<ExportRow>();
		return row ? toExport(row) : null;
	}

	async findExportForDay(accountId: string, exportDay: string): Promise<ExportRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT id, account_id, mailbox_id, export_day, message_count, skipped_count,
				 byte_size, r2_key, created_at
				 FROM mail_exports WHERE account_id = ? AND export_day = ? LIMIT 1`,
			)
			.bind(accountId, exportDay)
			.first<ExportRow>();
		return row ? toExport(row) : null;
	}

	/** `false` means the per-account daily slot was already taken. */
	async insertExport(record: ExportRecord): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO mail_exports (
				 id, account_id, mailbox_id, export_day, message_count, skipped_count,
				 byte_size, r2_key, created_at
				 ) VALUES (?,?,?,?,?,?,?,?,?)
				 ON CONFLICT (account_id, export_day) DO NOTHING`,
			)
			.bind(
				record.id,
				record.accountId,
				record.mailboxId,
				record.exportDay,
				record.messageCount,
				record.skippedCount,
				record.byteSize,
				record.r2Key,
				record.createdAt,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async insertAudit(entry: NewAuditEntry): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO mail_audit_log (id, account_id, action, target_id, detail, created_at)
				 VALUES (?,?,?,?,?,?)`,
			)
			.bind(
				entry.id,
				entry.accountId,
				entry.action,
				entry.targetId,
				entry.detail,
				entry.createdAt,
			)
			.run();
	}

	async deleteAuditBefore(cutoff: number): Promise<number> {
		const result = await this.db
			.prepare("DELETE FROM mail_audit_log WHERE created_at < ?")
			.bind(cutoff)
			.run();
		return result.meta.changes ?? 0;
	}

	async listAttachmentKeys(mailboxId: string, messageId: string): Promise<string[]> {
		const rows = await this.db
			.prepare("SELECT r2_key FROM attachments WHERE mailbox_id = ? AND message_id = ?")
			.bind(mailboxId, messageId)
			.all<{ r2_key: string }>();
		return (rows.results ?? []).map((row) => row.r2_key);
	}

	/** Removes one message and its attachments. Must run after R2 deletion. */
	async deleteMessageRows(options: {
		mailboxId: string;
		messageId: string;
		threadId: string;
		sizeBytes: number;
		wasQuarantined: boolean;
		audit: NewAuditEntry;
		now: number;
	}): Promise<number> {
		const results = await this.db.batch([
			this.db
				.prepare("DELETE FROM attachments WHERE mailbox_id = ? AND message_id = ?")
				.bind(options.mailboxId, options.messageId),
			this.db
				.prepare("DELETE FROM messages WHERE mailbox_id = ? AND id = ?")
				.bind(options.mailboxId, options.messageId),
			this.db
				.prepare(
					`UPDATE mailboxes
					 SET bytes_used = MAX(0, bytes_used - ?),
					 message_count = MAX(0, message_count - 1),
					 quarantine_count = MAX(0, quarantine_count - ?),
					 updated_at = ?
					 WHERE id = ?`,
				)
				.bind(
					options.sizeBytes,
					options.wasQuarantined ? 1 : 0,
					options.now,
					options.mailboxId,
				),
			this.db
				.prepare(
					"UPDATE threads SET message_count = MAX(0, message_count - 1) WHERE id = ? AND mailbox_id = ?",
				)
				.bind(options.threadId, options.mailboxId),
			this.db
				.prepare(
					`INSERT INTO mail_audit_log (id, account_id, action, target_id, detail, created_at)
					 VALUES (?,?,?,?,?,?)`,
				)
				.bind(
					options.audit.id,
					options.audit.accountId,
					options.audit.action,
					options.audit.targetId,
					options.audit.detail,
					options.audit.createdAt,
				),
		]);
		const deleted = results[1]?.meta.changes ?? 0;
		return deleted;
	}

	async listMailboxObjectKeys(mailboxId: string): Promise<string[]> {
		const statements = [
			this.db
				.prepare(
					`SELECT raw_key AS key FROM messages WHERE mailbox_id = ?
					 UNION ALL SELECT text_key AS key FROM messages WHERE mailbox_id = ? AND text_key IS NOT NULL
					 UNION ALL SELECT html_key AS key FROM messages WHERE mailbox_id = ? AND html_key IS NOT NULL`,
				)
				.bind(mailboxId, mailboxId, mailboxId),
			this.db.prepare("SELECT r2_key AS key FROM attachments WHERE mailbox_id = ?").bind(mailboxId),
			this.db.prepare("SELECT r2_key AS key FROM mail_exports WHERE mailbox_id = ?").bind(mailboxId),
		];
		const results = await this.db.batch(statements);
		const keys: string[] = [];
		for (const result of results) {
			for (const row of (result.results ?? []) as { key: string }[]) {
				keys.push(row.key);
			}
		}
		return keys;
	}

	/**
	 * Removes every row owned by the mailbox. Must run after R2 deletion. The
	 * audit history for this account is erased too: an account deletion is a
	 * data-subject erasure, not a retention checkpoint.
	 */
	async deleteMailboxRows(mailboxId: string, accountId: string): Promise<void> {
		await this.db.batch([
			this.db.prepare("DELETE FROM attachments WHERE mailbox_id = ?").bind(mailboxId),
			this.db.prepare("DELETE FROM messages WHERE mailbox_id = ?").bind(mailboxId),
			this.db.prepare("DELETE FROM threads WHERE mailbox_id = ?").bind(mailboxId),
			this.db.prepare("DELETE FROM mail_exports WHERE mailbox_id = ?").bind(mailboxId),
			this.db.prepare("DELETE FROM mail_drafts WHERE mailbox_id = ?").bind(mailboxId),
			this.db.prepare("DELETE FROM confirmation_nonces WHERE account_id = ?").bind(accountId),
			this.db.prepare("DELETE FROM send_receipts WHERE account_id = ?").bind(accountId),
			this.db.prepare("DELETE FROM delivery_events WHERE account_id = ?").bind(accountId),
			this.db.prepare("DELETE FROM suppressions WHERE account_id = ?").bind(accountId),
			this.db.prepare("DELETE FROM deliverability_alerts WHERE account_id = ?").bind(accountId),
			this.db.prepare("DELETE FROM mail_audit_log WHERE account_id = ?").bind(accountId),
			this.db.prepare("DELETE FROM mailboxes WHERE id = ?").bind(mailboxId),
		]);
	}

	async insertDeliveryEvent(event: NewDeliveryEvent): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO delivery_events (
				 id, account_id, send_receipt_id, provider_message_id, type,
				 recipient_hash, recipient_domain, status, diagnostic_code,
				 occurred_at, created_at
				 ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT (id) DO NOTHING`,
			)
			.bind(
				event.id,
				event.accountId,
				event.sendReceiptId,
				event.providerMessageId,
				event.type,
				event.recipientHash,
				event.recipientDomain,
				event.status,
				event.diagnosticCode,
				event.occurredAt,
				event.createdAt,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	/** `false` means the recipient was already suppressed. */
	async insertSuppression(suppression: NewSuppression): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO suppressions (
				 account_id, recipient, reason, source_event_id, created_at
				 ) VALUES (?,?,?,?,?)
				 ON CONFLICT (account_id, recipient) DO NOTHING`,
			)
			.bind(
				suppression.accountId,
				suppression.recipient,
				suppression.reason,
				suppression.sourceEventId,
				suppression.createdAt,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async findSuppressedRecipients(
		accountId: string,
		recipients: string[],
	): Promise<string[]> {
		if (!recipients.length) return [];
		const unique = [...new Set(recipients)];
		const placeholders = unique.map(() => "?").join(",");
		const rows = await this.db
			.prepare(
				`SELECT recipient FROM suppressions
				 WHERE account_id = ? AND recipient IN (${placeholders})`,
			)
			.bind(accountId, ...unique)
			.all<{ recipient: string }>();
		return (rows.results ?? []).map((row) => row.recipient);
	}

	async findSendPause(accountId: string): Promise<SendPause | null> {
		const row = await this.db
			.prepare(
				`SELECT send_paused_at, send_paused_reason FROM mailboxes
				 WHERE account_id = ? LIMIT 1`,
			)
			.bind(accountId)
			.first<{ send_paused_at: number | null; send_paused_reason: string | null }>();
		if (!row || row.send_paused_at === null) return null;
		return { pausedAt: row.send_paused_at, reason: row.send_paused_reason };
	}

	/** Only the first trip wire pauses; repeat signals keep the original reason. */
	async pauseSend(accountId: string, reason: string, now: number): Promise<boolean> {
		const result = await this.db
			.prepare(
				`UPDATE mailboxes
				 SET send_paused_at = ?, send_paused_reason = ?, updated_at = ?
				 WHERE account_id = ? AND send_paused_at IS NULL`,
			)
			.bind(now, reason, now, accountId)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async insertDeliverabilityAlert(alert: NewDeliverabilityAlert): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO deliverability_alerts (id, account_id, kind, detail, created_at)
				 VALUES (?,?,?,?,?)
				 ON CONFLICT (id) DO NOTHING`,
			)
			.bind(alert.id, alert.accountId, alert.kind, alert.detail, alert.createdAt)
			.run();
	}

	async abuseWindow(accountId: string, since: number): Promise<AbuseWindowCounts> {
		const row = await this.db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM send_receipts WHERE account_id = ? AND created_at >= ?) AS sends,
				 (SELECT COUNT(*) FROM delivery_events
				  WHERE account_id = ? AND type = 'hard_bounce' AND occurred_at >= ?) AS hard_bounces,
				 (SELECT COUNT(*) FROM delivery_events
				  WHERE account_id = ? AND type = 'complaint' AND occurred_at >= ?) AS complaints,
				 (SELECT COALESCE(SUM(external_recipient_count), 0) FROM send_receipts
				  WHERE account_id = ? AND created_at >= ?) AS external_recipients`,
			)
			.bind(accountId, since, accountId, since, accountId, since, accountId, since)
			.first<{
				sends: number;
				hard_bounces: number;
				complaints: number;
				external_recipients: number;
			}>();
		return {
			sends: row?.sends ?? 0,
			hardBounces: row?.hard_bounces ?? 0,
			complaints: row?.complaints ?? 0,
			externalRecipients: row?.external_recipients ?? 0,
		};
	}

	async findReceiptByProviderMessageId(
		providerMessageId: string,
	): Promise<ReceiptLookup | null> {
		const row = await this.db
			.prepare(
				`SELECT id, account_id FROM send_receipts
				 WHERE provider_message_id = ? LIMIT 1`,
			)
			.bind(providerMessageId)
			.first<{ id: string; account_id: string }>();
		return row ? { id: row.id, accountId: row.account_id } : null;
	}

	async deliverabilityTotals(since: number): Promise<DeliverabilityTotals> {
		const row = await this.db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM send_receipts WHERE created_at >= ?) AS sends,
				 (SELECT COALESCE(SUM(external_recipient_count), 0) FROM send_receipts
				  WHERE created_at >= ?) AS external_recipients,
				 (SELECT COUNT(*) FROM delivery_events WHERE type = 'delivered' AND occurred_at >= ?) AS delivered,
				 (SELECT COUNT(*) FROM delivery_events WHERE type = 'soft_bounce' AND occurred_at >= ?) AS soft_bounces,
				 (SELECT COUNT(*) FROM delivery_events WHERE type = 'hard_bounce' AND occurred_at >= ?) AS hard_bounces,
				 (SELECT COUNT(*) FROM delivery_events WHERE type = 'complaint' AND occurred_at >= ?) AS complaints`,
			)
			.bind(since, since, since, since, since, since)
			.first<{
				sends: number;
				external_recipients: number;
				delivered: number;
				soft_bounces: number;
				hard_bounces: number;
				complaints: number;
			}>();
		return {
			sends: row?.sends ?? 0,
			externalRecipients: row?.external_recipients ?? 0,
			delivered: row?.delivered ?? 0,
			softBounces: row?.soft_bounces ?? 0,
			hardBounces: row?.hard_bounces ?? 0,
			complaints: row?.complaints ?? 0,
		};
	}

	async countSuppressions(): Promise<number> {
		const row = await this.db
			.prepare("SELECT COUNT(*) AS total FROM suppressions")
			.first<{ total: number }>();
		return row?.total ?? 0;
	}

	async countPausedAccounts(): Promise<number> {
		const row = await this.db
			.prepare("SELECT COUNT(*) AS total FROM mailboxes WHERE send_paused_at IS NOT NULL")
			.first<{ total: number }>();
		return row?.total ?? 0;
	}

	async insertWebhookNonce(nonce: string, now: number): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT INTO internal_webhook_nonces (nonce, created_at) VALUES (?,?)
				 ON CONFLICT (nonce) DO NOTHING`,
			)
			.bind(nonce, now)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async deleteWebhookNoncesBefore(cutoff: number): Promise<number> {
		const result = await this.db
			.prepare("DELETE FROM internal_webhook_nonces WHERE created_at < ?")
			.bind(cutoff)
			.run();
		return result.meta.changes ?? 0;
	}

	async deleteDeliveryEventsBefore(cutoff: number): Promise<number> {
		const result = await this.db
			.prepare("DELETE FROM delivery_events WHERE occurred_at < ?")
			.bind(cutoff)
			.run();
		return result.meta.changes ?? 0;
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
					sendPausedAt: null,
					sendPausedReason: null,
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
