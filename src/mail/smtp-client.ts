import type { MailConnection } from "./socket-transport";
import { MailTransportError } from "./socket-transport";
import type { RemoteTransport } from "./remote-target";

/**
 * Minimal SMTP submission client (S7e).
 *
 * Only authenticated submission on 465 (implicit TLS) or 587 (STARTTLS) is
 * implemented. Port 25 is never attempted, there is no anonymous delivery and
 * no relay semantics: `MAIL FROM` must be the same verified account that AUTH
 * logs in with, otherwise the link is rejected before any credential is sent.
 */

export type SmtpErrorCode =
	| "provider_unreachable"
	| "provider_tls_required"
	| "provider_auth_failed"
	| "smtp_rejected"
	| "provider_identity_mismatch";

export class SmtpError extends Error {
	constructor(readonly code: SmtpErrorCode) {
		super(code);
		this.name = "SmtpError";
	}
}

const MAX_REPLY_LINES = 100;

type SmtpReply = { code: number; lines: string[] };

const hasControl = (value: string): boolean => /[\r\n]/.test(value);

const encodeBase64 = (value: string): string => {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

const readReply = async (connection: MailConnection): Promise<SmtpReply> => {
	const lines: string[] = [];
	for (let index = 0; index < MAX_REPLY_LINES; index += 1) {
		const line = await connection.readLine();
		lines.push(line);
		if (line.length < 4 || line[3] !== "-") {
			const code = Number.parseInt(line.slice(0, 3), 10);
			if (!Number.isInteger(code)) throw new SmtpError("provider_unreachable");
			return { code, lines };
		}
	}
	throw new SmtpError("smtp_rejected");
};

const expect = (reply: SmtpReply, code: number, failure: SmtpErrorCode): SmtpReply => {
	if (reply.code !== code) throw new SmtpError(failure);
	return reply;
};

const sendCommand = async (
	connection: MailConnection,
	command: string,
	expected: number,
	failure: SmtpErrorCode,
): Promise<SmtpReply> => {
	if (hasControl(command)) throw new SmtpError("smtp_rejected");
	await connection.write(`${command}\r\n`);
	return expect(await readReply(connection), expected, failure);
};

const advertisesStartTls = (reply: SmtpReply): boolean =>
	reply.lines.some((line) => line.slice(4).trim().toUpperCase() === "STARTTLS");

const authenticate = async (
	connection: MailConnection,
	username: string,
	password: string,
): Promise<void> => {
	const plain = await sendCommand(
		connection,
		`AUTH PLAIN ${encodeBase64(`\u0000${username}\u0000${password}`)}`,
		235,
		"provider_auth_failed",
	).catch((error: unknown) => {
		if (error instanceof SmtpError && error.code === "provider_auth_failed") return null;
		throw error;
	});
	if (plain) return;

	await sendCommand(connection, "AUTH LOGIN", 334, "provider_auth_failed");
	await sendCommand(connection, encodeBase64(username), 334, "provider_auth_failed");
	await sendCommand(connection, encodeBase64(password), 235, "provider_auth_failed");
};

const dotStuff = (raw: string): string => {
	const normalized = raw.replace(/\r\n|\r|\n/g, "\n");
	const lines = normalized.split("\n").map((line) => (line.startsWith(".") ? `.${line}` : line));
	const body = lines.join("\r\n");
	return body.endsWith("\r\n") ? `${body}.\r\n` : `${body}\r\n.\r\n`;
};

const messageIdFrom = (raw: string): string | null => {
	const match = /^message-id:\s*(.+)$/im.exec(raw);
	return match ? match[1].trim() : null;
};

const envelopeAddress = (value: string): string => {
	if (!value || hasControl(value) || /[<>]/.test(value)) throw new SmtpError("smtp_rejected");
	return value;
};

export async function sendSmtpMessage(
	connection: MailConnection,
	input: {
		host: string;
		tls: RemoteTransport;
		username: string;
		password: string;
		from: string;
		to: string[];
		cc: string[];
		bcc: string[];
		raw: string;
	},
): Promise<{ messageId: string | null }> {
	// Checked before the greeting is even read, so a mismatched sender never
	// causes the password to leave the Worker.
	if (input.from.trim().toLowerCase() !== input.username.trim().toLowerCase()) {
		throw new SmtpError("provider_identity_mismatch");
	}

	try {
		expect(await readReply(connection), 220, "provider_unreachable");

		if (input.tls === "starttls") {
			const capabilities = await sendCommand(connection, "EHLO who-you", 250, "smtp_rejected");
			if (!advertisesStartTls(capabilities)) throw new SmtpError("provider_tls_required");
			await sendCommand(connection, "STARTTLS", 220, "provider_tls_required");
			await connection.upgradeTls(input.host);
		}

		await sendCommand(connection, "EHLO who-you", 250, "smtp_rejected");
		await authenticate(connection, input.username, input.password);

		const from = envelopeAddress(input.from);
		await sendCommand(connection, `MAIL FROM:<${from}>`, 250, "smtp_rejected");
		for (const recipient of [...input.to, ...input.cc, ...input.bcc]) {
			await sendCommand(
				connection,
				`RCPT TO:<${envelopeAddress(recipient)}>`,
				250,
				"smtp_rejected",
			);
		}

		await sendCommand(connection, "DATA", 354, "smtp_rejected");
		await connection.write(dotStuff(input.raw));
		expect(await readReply(connection), 250, "smtp_rejected");
		await connection.write("QUIT\r\n").catch(() => undefined);

		return { messageId: messageIdFrom(input.raw) };
	} catch (error) {
		if (error instanceof SmtpError) throw error;
		if (error instanceof MailTransportError) throw new SmtpError("provider_unreachable");
		throw new SmtpError("provider_unreachable");
	}
}
