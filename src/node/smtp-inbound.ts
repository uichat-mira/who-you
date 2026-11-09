import { readFileSync } from "node:fs";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import type { WhoYouEnv } from "../mail/config";
import { handleInboundEmail } from "../mail/inbound";
import type { InboundEmail } from "../mail/ports";

export type InboundSmtpConfig = {
	host: string;
	port: number;
	maxBytes: number;
	/** STARTTLS material; both are required when either is present. */
	certPath?: string;
	keyPath?: string;
};

const toInboundMessage = (
	from: string,
	to: string,
	bytes: Buffer,
	rejections: string[],
): InboundEmail => ({
	from,
	to,
	headers: new Headers(),
	raw: new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	}),
	rawSize: bytes.length,
	setReject(reason) {
		rejections.push(reason);
	},
});

const rejectionError = (reason: string): Error => {
	const error = new Error(reason) as Error & { responseCode?: number };
	const match = /^([245]\d\d)\b/.exec(reason);
	if (match) error.responseCode = Number(match[1]);
	return error;
};

/**
 * SMTP inbound adapter. It buffers one bounded message, then feeds the same
 * business handler that Email Routing called, once per accepted recipient.
 */
export function createInboundSmtpServer(
	config: InboundSmtpConfig,
	env: WhoYouEnv,
): SMTPServer {
	const server = new SMTPServer({
		secure: false,
		size: config.maxBytes,
		disabledCommands: ["AUTH"],
		...(config.certPath === undefined || config.keyPath === undefined
			? {}
			: { cert: readFileSync(config.certPath), key: readFileSync(config.keyPath) }),
		logger: false,
		onData(stream, session: SMTPServerSession, callback) {
			void (async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of stream) {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
				}
				const bytes = Buffer.concat(chunks);
				const mailFrom = session.envelope.mailFrom;
				const from = mailFrom === false ? "" : mailFrom.address;
				const recipients = session.envelope.rcptTo.map((rcpt) => rcpt.address);
				if (recipients.length === 0) {
					callback(rejectionError("550 5.1.1 No recipient"));
					return;
				}

				for (const recipient of recipients) {
					const rejections: string[] = [];
					try {
						await handleInboundEmail(
							toInboundMessage(from, recipient, bytes, rejections),
							env,
						);
					} catch (error) {
						const message = error instanceof Error ? error.message : "inbound failed";
						console.log(
							JSON.stringify({ event: "whoyou_inbound_smtp_error", error: message }),
						);
						const failure = rejectionError("451 4.3.0 Temporary failure");
						failure.message = message;
						callback(failure);
						return;
					}
					if (rejections.length > 0) {
						callback(rejectionError(rejections[0]));
						return;
					}
				}
				callback();
			})();
		},
	});

	server.on("error", (error: Error) => {
		console.log(JSON.stringify({ event: "whoyou_inbound_smtp_server_error", error: error.message }));
	});

	return server;
}

export function listenInboundSmtp(server: SMTPServer, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

export function closeInboundSmtp(server: SMTPServer): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}
