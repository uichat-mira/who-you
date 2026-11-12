import { connect } from "cloudflare:sockets";
import type { RemoteTransport } from "./remote-target";

/**
 * Minimal byte/line transport shared by the SMTP and IMAP clients (S7e).
 *
 * The production implementation wraps `cloudflare:sockets`. It is imported
 * through a non-literal specifier so the bundler does not try to resolve the
 * runtime-only module, and it never exposes a way to skip certificate checks:
 * implicit TLS uses the two-argument `connect` plus `startTls`, and STARTTLS
 * upgrades in place with `expectedServerHostname`.
 */

export type MailConnection = {
	readLine(): Promise<string>;
	readBytes(length: number): Promise<Uint8Array>;
	write(data: string | Uint8Array): Promise<void>;
	upgradeTls(expectedHostname: string): Promise<void>;
	close(): Promise<void>;
};

export type MailTransport = {
	connect(input: { host: string; port: number; tls: RemoteTransport }): Promise<MailConnection>;
};

export class MailTransportError extends Error {
	constructor() {
		super("provider_unreachable");
		this.name = "MailTransportError";
	}
}

export const CONNECT_TIMEOUT_MS = 10_000;
export const IO_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 8 * 1024;

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new MailTransportError()), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

type SocketLike = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	opened: Promise<unknown>;
	close(): Promise<void>;
	startTls(options: { expectedServerHostname: string }): SocketLike;
};

class BufferedConnection implements MailConnection {
	private socket: SocketLike;
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private chunks: Uint8Array[] = [];
	private buffered = 0;
	private closed = false;

	constructor(socket: SocketLike) {
		this.socket = socket;
	}

	private async ensureReader(): Promise<ReadableStreamDefaultReader<Uint8Array>> {
		this.reader ??= this.socket.readable.getReader();
		return this.reader;
	}

	private async fill(): Promise<void> {
		if (this.closed) throw new MailTransportError();
		const reader = await this.ensureReader();
		const chunk = await withTimeout(reader.read(), IO_TIMEOUT_MS);
		if (chunk.done || !chunk.value?.byteLength) throw new MailTransportError();
		this.chunks.push(chunk.value);
		this.buffered += chunk.value.byteLength;
	}

	private take(length: number): Uint8Array {
		const out = new Uint8Array(length);
		let written = 0;
		while (written < length) {
			const head = this.chunks[0];
			const needed = length - written;
			if (head.byteLength <= needed) {
				out.set(head, written);
				written += head.byteLength;
				this.chunks.shift();
			} else {
				out.set(head.subarray(0, needed), written);
				this.chunks[0] = head.subarray(needed);
				written += needed;
			}
		}
		this.buffered -= length;
		return out;
	}

	async readLine(): Promise<string> {
		for (;;) {
			// Scan the current buffer for CRLF without assuming one chunk is a line.
			const joined = this.peek();
			for (let index = 0; index + 1 < joined.byteLength; index += 1) {
				if (joined[index] === 13 && joined[index + 1] === 10) {
					if (index > MAX_LINE_BYTES) throw new MailTransportError();
					const bytes = this.take(index);
					this.take(2);
					return new TextDecoder().decode(bytes);
				}
			}
			if (this.buffered > MAX_LINE_BYTES) throw new MailTransportError();
			await this.fill();
		}
	}

	private peek(): Uint8Array {
		if (this.chunks.length === 1) return this.chunks[0] as Uint8Array;
		const joined = new Uint8Array(this.buffered);
		let offset = 0;
		for (const chunk of this.chunks) {
			joined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return joined;
	}

	async readBytes(length: number): Promise<Uint8Array> {
		while (this.buffered < length) await this.fill();
		return this.take(length);
	}

	async write(data: string | Uint8Array): Promise<void> {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		this.writer ??= this.socket.writable.getWriter();
		await withTimeout(this.writer.write(bytes), IO_TIMEOUT_MS);
	}

	async upgradeTls(expectedHostname: string): Promise<void> {
		this.reader?.releaseLock();
		this.writer?.releaseLock();
		this.reader = null;
		this.writer = null;
		this.chunks = [];
		this.buffered = 0;
		this.socket = this.socket.startTls({ expectedServerHostname: expectedHostname });
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.reader?.releaseLock();
		this.writer?.releaseLock();
		await this.socket.close().catch(() => undefined);
	}
}

export function createSocketTransport(): MailTransport {
	return {
		async connect(input) {
			try {
				const socket = connect(
					{ hostname: input.host, port: input.port },
					{ secureTransport: "starttls", allowHalfOpen: false },
				) as unknown as SocketLike;
				await withTimeout(socket.opened, CONNECT_TIMEOUT_MS);
				// Implicit TLS is `connect(..., {secureTransport: "starttls"})` followed
				// by `startTls`: a listener that rejects the certificate aborts here,
				// so no credential is ever written to a plaintext socket.
				const secured =
					input.tls === "implicit"
						? socket.startTls({ expectedServerHostname: input.host })
						: socket;
				return new BufferedConnection(secured);
			} catch {
				throw new MailTransportError();
			}
		},
	};
}
