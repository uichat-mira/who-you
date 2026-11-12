/**
 * Storage for the user-supplied IMAP/SMTP endpoint (S7e).
 *
 * One row per `imap_smtp` identity. The host and username are user data and
 * therefore never logged; unlink deletes the row explicitly because the
 * mailbox-scoped delete list predates this table.
 */

export type RemoteTargetRecord = {
	mailboxId: string;
	imapHost: string;
	imapPort: number;
	smtpHost: string;
	smtpPort: number;
	username: string;
};

type RemoteTargetRow = {
	mailbox_id: string;
	imap_host: string;
	imap_port: number;
	smtp_host: string;
	smtp_port: number;
	username: string;
};

const toRecord = (row: RemoteTargetRow): RemoteTargetRecord => ({
	mailboxId: row.mailbox_id,
	imapHost: row.imap_host,
	imapPort: row.imap_port,
	smtpHost: row.smtp_host,
	smtpPort: row.smtp_port,
	username: row.username,
});

export class RemoteTargetRepository {
	constructor(private readonly db: D1Database) {}

	async upsert(record: RemoteTargetRecord & { now: number }): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO mailbox_remote_targets (
				 mailbox_id, imap_host, imap_port, smtp_host, smtp_port, username,
				 created_at, updated_at
				 ) VALUES (?,?,?,?,?,?,?,?)
				 ON CONFLICT (mailbox_id) DO UPDATE SET
				 imap_host = excluded.imap_host,
				 imap_port = excluded.imap_port,
				 smtp_host = excluded.smtp_host,
				 smtp_port = excluded.smtp_port,
				 username = excluded.username,
				 updated_at = excluded.updated_at`,
			)
			.bind(
				record.mailboxId,
				record.imapHost,
				record.imapPort,
				record.smtpHost,
				record.smtpPort,
				record.username,
				record.now,
				record.now,
			)
			.run();
	}

	async get(mailboxId: string): Promise<RemoteTargetRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT mailbox_id, imap_host, imap_port, smtp_host, smtp_port, username
				 FROM mailbox_remote_targets WHERE mailbox_id = ?`,
			)
			.bind(mailboxId)
			.first<RemoteTargetRow>();
		return row ? toRecord(row) : null;
	}

	async delete(mailboxId: string): Promise<void> {
		await this.db
			.prepare("DELETE FROM mailbox_remote_targets WHERE mailbox_id = ?")
			.bind(mailboxId)
			.run();
	}
}
