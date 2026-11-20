import type {
	ExportRecord,
	MailRepository,
	MessageRecord,
	NewAuditEntry,
} from "./store";
import { messageFields } from "./store";
import { ZipArchive } from "./zip";

/**
 * Data-lifecycle operations for S3.
 *
 * Deletion always removes R2 objects first and D1 rows second. A retry after a
 * partial failure is therefore safe: missing objects are a no-op for R2, and
 * the row batch only runs once storage is confirmed gone. Deletion is
 * account-scoped before anything else, so a guessed id never reaches storage.
 */

export type DeleteMessageResult =
	| { ok: true; alreadyDeleted: boolean; deletedObjects: number; deletedRows: number }
	| { ok: false; code: "message_not_trashed" };

const uniqueKeys = (keys: (string | null)[]): string[] =>
	[...new Set(keys.filter((key): key is string => Boolean(key)))];

const deleteObjectsInChunks = async (
	repository: MailRepository,
	keys: string[],
): Promise<number> => {
	for (let index = 0; index < keys.length; index += 100) {
		await repository.deleteObjects(keys.slice(index, index + 100));
	}
	return keys.length;
};

/** Permanent delete. The message must already be in the trash view. */
export async function deleteMessage(
	repository: MailRepository,
	options: { accountId: string; messageId: string; now: number },
): Promise<DeleteMessageResult> {
	const message = await repository.getMessage(options.accountId, options.messageId);
	if (!message) {
		return { ok: true, alreadyDeleted: true, deletedObjects: 0, deletedRows: 0 };
	}
	if (!message.flags.trashed) {
		return { ok: false, code: "message_not_trashed" };
	}

	const attachmentKeys = await repository.listAttachmentKeys(message.mailboxId, message.id);
	const keys = uniqueKeys([message.rawKey, message.textKey, message.htmlKey, ...attachmentKeys]);
	await deleteObjectsInChunks(repository, keys);

	const deletedRows = await repository.deleteMessageRows({
		mailboxId: message.mailboxId,
		messageId: message.id,
		threadId: message.threadId,
		sizeBytes: message.sizeBytes,
		wasQuarantined: message.state === "quarantined",
		audit: {
			id: `audit_${crypto.randomUUID()}`,
			accountId: options.accountId,
			action: "delete_message",
			targetId: message.id,
			detail: JSON.stringify({ objects: keys.length, rows: 1 }),
			createdAt: options.now,
		},
		now: options.now,
	});

	return {
		ok: true,
		alreadyDeleted: deletedRows === 0,
		deletedObjects: keys.length,
		deletedRows,
	};
}

export type DeleteMailboxResult = {
	alreadyDeleted: boolean;
	deletedObjects: number;
};

/**
 * Erases the whole mailbox: every R2 object first, then every owned row. Used
 * for user-initiated "delete my data" and for account offboarding.
 */
export async function deleteMailbox(
	repository: MailRepository,
	options: { accountId: string; now: number },
): Promise<DeleteMailboxResult> {
	const mailbox = await repository.findMailboxByAccount(options.accountId);
	if (!mailbox) return { alreadyDeleted: true, deletedObjects: 0 };

	const keys = await repository.listMailboxObjectKeys(mailbox.id);
	await deleteObjectsInChunks(repository, keys);
	await repository.deleteMailboxRows(mailbox.id, options.accountId);

	return { alreadyDeleted: false, deletedObjects: keys.length };
}

export type ExportFailureCode =
	| "mailbox_not_provisioned"
	| "export_rate_limited"
	| "export_too_large";

export type ExportResult =
	| { ok: true; record: ExportRecord; skipped: number }
	| { ok: false; code: ExportFailureCode };

const EXPORT_SCHEMA = "who-you-export/1";

const manifestMessage = (
	message: MessageRecord,
	emlPath: string | null,
): Record<string, unknown> => ({
	...messageFields(message),
	state: message.state,
	flags: message.flags,
	eml: emlPath,
});

/**
 * Builds one ZIP per account per UTC day: every message as raw EML plus a JSON
 * manifest. The unique (account, day) insert is the rate-limit authority, so a
 * losing concurrent request cleans up its own object.
 */
export async function createExport(
	repository: MailRepository,
	options: { accountId: string; now: number; maxMessages: number; maxBytes: number },
): Promise<ExportResult> {
	const mailbox = await repository.findMailboxByAccount(options.accountId);
	if (!mailbox) return { ok: false, code: "mailbox_not_provisioned" };

	const exportDay = new Date(options.now).toISOString().slice(0, 10);
	if (await repository.findExportForDay(options.accountId, exportDay)) {
		return { ok: false, code: "export_rate_limited" };
	}

	const messages = await repository.listExportMessages(options.accountId, options.maxMessages + 1);
	if (messages.length > options.maxMessages) {
		return { ok: false, code: "export_too_large" };
	}
	const declaredBytes = messages.reduce((sum, message) => sum + message.sizeBytes, 0);
	if (declaredBytes > options.maxBytes) {
		return { ok: false, code: "export_too_large" };
	}

	const archive = new ZipArchive();
	const entries: Record<string, unknown>[] = [];
	let skipped = 0;
	for (const message of messages) {
		const object = await repository.getObject(message.rawKey);
		if (!object) {
			skipped += 1;
			entries.push(manifestMessage(message, null));
			continue;
		}
		const path = `messages/${message.id}.eml`;
		archive.add(path, new Uint8Array(object.bytes));
		entries.push(manifestMessage(message, path));
	}

	const exportId = `exp_${crypto.randomUUID()}`;
	const manifest = {
		schema: EXPORT_SCHEMA,
		exportId,
		mailbox: mailbox.address,
		generatedAt: new Date(options.now).toISOString(),
		messageCount: entries.length,
		skippedCount: skipped,
		messages: entries,
	};
	archive.add("manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
	archive.addParentDirectories();
	const bytes = archive.build();

	const r2Key = `accounts/${encodeURIComponent(options.accountId)}/exports/${exportId}.zip`;
	await repository.putObject(r2Key, bytes, "application/zip");

	const record: ExportRecord = {
		id: exportId,
		accountId: options.accountId,
		mailboxId: mailbox.id,
		exportDay,
		messageCount: entries.length,
		skippedCount: skipped,
		byteSize: bytes.byteLength,
		r2Key,
		createdAt: options.now,
	};
	if (!(await repository.insertExport(record))) {
		await repository.deleteObjects([r2Key]);
		return { ok: false, code: "export_rate_limited" };
	}

	const audit: NewAuditEntry = {
		id: `audit_${crypto.randomUUID()}`,
		accountId: options.accountId,
		action: "export",
		targetId: exportId,
		detail: JSON.stringify({ messages: entries.length, skipped, bytes: bytes.byteLength }),
		createdAt: options.now,
	};
	await repository.insertAudit(audit);

	return { ok: true, record, skipped };
}
