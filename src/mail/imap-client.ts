import { quoteImapString, type RemoteTransport } from "./remote-target";
import type { MailConnection } from "./socket-transport";
import { MailTransportError } from "./socket-transport";

/**
 * Minimal IMAP4rev1 polling client (S7e).
 *
 * Only what the sync path needs: capability probing, optional STARTTLS on 143,
 * LOGIN with quoted arguments, SELECT INBOX, UID SEARCH and a BODY.PEEK fetch
 * that never writes the \Seen flag. Response lines and literal sizes are
 * bounded so a hostile server cannot exhaust the Worker's memory.
 */

export type ImapErrorCode =
	| "provider_unreachable"
	| "provider_tls_required"
	| "provider_auth_failed"
	| "imap_protocol_error";

export class ImapError extends Error {
	constructor(readonly code: ImapErrorCode) {
		super(code);
		this.name = "ImapError";
	}
}

export type ImapMailboxState = { uidValidity: number; uidNext: number };

const MAX_RESPONSE_LINES = 10_000;
const MAX_LITERAL_BYTES = 25 * 1024 * 1024;
const tagCounters = new WeakMap<MailConnection, number>();

const nextTag = (connection: MailConnection): string => {
	const next = (tagCounters.get(connection) ?? 0) + 1;
	tagCounters.set(connection, next);
	return `a${next}`;
};

type TaggedResponse = {
	lines: string[];
	literals: Uint8Array[];
	status: "OK" | "NO" | "BAD";
};

const isTagged = (line: string, tag: string): boolean =>
	line.startsWith(`${tag} `) || line === tag;

const statusOf = (line: string, tag: string): TaggedResponse["status"] => {
	const rest = line.slice(tag.length).trim().toUpperCase();
	if (rest.startsWith("OK")) return "OK";
	if (rest.startsWith("NO")) return "NO";
	return "BAD";
};

const literalLength = (line: string): number | null => {
	const match = /\{(\d+)\}$/.exec(line);
	if (!match) return null;
	const value = Number.parseInt(match[1], 10);
	return Number.isInteger(value) && value >= 0 ? value : null;
};

const runCommand = async (
	connection: MailConnection,
	command: string,
	options: { skipTaggedError?: boolean } = {},
): Promise<TaggedResponse> => {
	const tag = nextTag(connection);
	await connection.write(`${tag} ${command}\r\n`);
	const lines: string[] = [];
	const literals: Uint8Array[] = [];
	for (let index = 0; index < MAX_RESPONSE_LINES; index += 1) {
		const line = await connection.readLine();
		if (isTagged(line, tag)) {
			return { lines, literals, status: statusOf(line, tag) };
		}
		lines.push(line);
		const length = literalLength(line);
		if (length !== null) {
			if (length > MAX_LITERAL_BYTES) throw new ImapError("imap_protocol_error");
			literals.push(await connection.readBytes(length));
			// The remainder of the line that carried the literal is read next.
			const rest = await connection.readLine();
			if (!isTagged(rest, tag)) lines.push(rest);
			else return { lines, literals, status: statusOf(rest, tag) };
		}
	}
	if (!options.skipTaggedError) throw new ImapError("imap_protocol_error");
	return { lines, literals, status: "BAD" };
};

const requireOk = (response: TaggedResponse, failure: ImapErrorCode): TaggedResponse => {
	if (response.status !== "OK") throw new ImapError(failure);
	return response;
};

const capabilityLines = (response: TaggedResponse): string[] =>
	response.lines
		.filter((line) => line.toUpperCase().startsWith("* CAPABILITY"))
		.flatMap((line) => line.slice("* CAPABILITY".length).trim().toUpperCase().split(/\s+/));

const readGreeting = async (connection: MailConnection): Promise<void> => {
	const greeting = (await connection.readLine()).toUpperCase();
	if (greeting.startsWith("* OK") || greeting.startsWith("* PREAUTH")) return;
	throw new ImapError("provider_unreachable");
};

const login = async (
	connection: MailConnection,
	username: string,
	password: string,
): Promise<void> => {
	const user = quoteImapString(username);
	const secret = quoteImapString(password);
	if (user === null || secret === null) throw new ImapError("imap_protocol_error");
	const response = await runCommand(connection, `LOGIN ${user} ${secret}`);
	requireOk(response, "provider_auth_failed");
};

const upgradeIfNeeded = async (
	connection: MailConnection,
	input: { host: string; tls: RemoteTransport },
): Promise<void> => {
	if (input.tls === "implicit") return;
	const capabilities = await runCommand(connection, "CAPABILITY");
	requireOk(capabilities, "imap_protocol_error");
	if (!capabilityLines(capabilities).includes("STARTTLS")) {
		throw new ImapError("provider_tls_required");
	}
	const started = await runCommand(connection, "STARTTLS");
	requireOk(started, "provider_tls_required");
	await connection.upgradeTls(input.host);
	const rechecked = await runCommand(connection, "CAPABILITY");
	requireOk(rechecked, "imap_protocol_error");
};

const integerFrom = (lines: string[], field: string): number | null => {
	const pattern = new RegExp(`\\[${field}\\s+(\\d+)\\]`, "i");
	for (const line of lines) {
		const match = pattern.exec(line);
		if (match) {
			const value = Number.parseInt(match[1], 10);
			return Number.isInteger(value) && value > 0 ? value : null;
		}
	}
	return null;
};

export async function openImapSession(
	connection: MailConnection,
	input: { host: string; tls: RemoteTransport; username: string; password: string },
): Promise<{
	selectInbox(): Promise<ImapMailboxState>;
	close(): Promise<void>;
}> {
	try {
		await readGreeting(connection);
		await upgradeIfNeeded(connection, input);
		await login(connection, input.username, input.password);
	} catch (error) {
		if (error instanceof ImapError) throw error;
		if (error instanceof MailTransportError) throw new ImapError("provider_unreachable");
		throw new ImapError("provider_unreachable");
	}

	return {
		async selectInbox() {
			const response = await runCommand(connection, 'SELECT "INBOX"');
			requireOk(response, "imap_protocol_error");
			const uidValidity = integerFrom(response.lines, "UIDVALIDITY");
			const uidNext = integerFrom(response.lines, "UIDNEXT");
			if (uidValidity === null || uidNext === null) throw new ImapError("imap_protocol_error");
			return { uidValidity, uidNext };
		},
		async close() {
			await connection.write(`${nextTag(connection)} LOGOUT\r\n`).catch(() => undefined);
			await connection.close().catch(() => undefined);
		},
	};
}

const imapDate = (timestamp: number): string => {
	const date = new Date(timestamp);
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${day}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
};

export async function searchUids(
	connection: MailConnection,
	input: { since: string | null; afterUid: number | null; limit: number },
): Promise<number[]> {
	const criteria = input.since ? `SINCE ${imapDate(Date.parse(input.since))}` : null;
	const range = input.afterUid !== null ? `UID ${input.afterUid + 1}:*` : null;
	const query = [criteria, range].filter(Boolean).join(" ") || "ALL";
	const response = await runCommand(connection, `UID SEARCH ${query}`);
	requireOk(response, "imap_protocol_error");
	const uids: number[] = [];
	for (const line of response.lines) {
		if (!line.toUpperCase().startsWith("* SEARCH")) continue;
		for (const token of line.split(/\s+/).slice(2)) {
			const uid = Number.parseInt(token, 10);
			if (!Number.isInteger(uid) || uid <= 0) continue;
			if (input.afterUid !== null && uid <= input.afterUid) continue;
			uids.push(uid);
		}
	}
	return [...new Set(uids)].sort((left, right) => left - right).slice(0, input.limit);
}

export async function fetchRawMessage(
	connection: MailConnection,
	uid: number,
	maxBytes: number,
): Promise<Uint8Array> {
	if (!Number.isInteger(uid) || uid <= 0) throw new ImapError("imap_protocol_error");
	const response = await runCommand(connection, `UID FETCH ${uid} (BODY.PEEK[])`);
	requireOk(response, "imap_protocol_error");
	const literal = response.literals[0];
	if (!literal || literal.byteLength === 0) throw new ImapError("imap_protocol_error");
	if (literal.byteLength > maxBytes) throw new ImapError("imap_protocol_error");
	return literal;
}
