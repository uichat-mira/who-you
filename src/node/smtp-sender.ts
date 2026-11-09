import nodemailer from "nodemailer";
import type { MailSender, OutboundMail } from "../mail/send";

export type SmtpSenderConfig = {
	host: string;
	port: number;
	/** `true` for implicit TLS (usually 465), `false` for STARTTLS/plain. */
	secure: boolean;
	user?: string;
	pass?: string;
	/**
	 * Envelope (Return-Path) sender. The visible From header always comes from
	 * the business-layer draft; a relay may still require its own return path.
	 */
	from?: string;
};

/**
 * SMTP relay adapter. Transport failures surface as thrown errors; the send
 * pipeline maps them to the existing `relay_unavailable` failure code, so no
 * business error strings change here.
 */
export function createSmtpMailSender(config: SmtpSenderConfig): MailSender {
	const transport = nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		...(config.user === undefined
			? {}
			: { auth: { user: config.user, pass: config.pass ?? "" } }),
	});

	const addresses = (entries: OutboundMail["to"]): Array<{ name?: string; address: string }> =>
		entries.map((entry) => ({
			address: entry.address,
			...(entry.name ? { name: entry.name } : {}),
		}));

	return {
		async send(message: OutboundMail): Promise<{ providerMessageId: string }> {
			const info = await transport.sendMail({
				from: message.from,
				to: addresses(message.to),
				cc: addresses(message.cc),
				bcc: addresses(message.bcc),
				subject: message.subject,
				text: message.text,
				...(message.html === null ? {} : { html: message.html }),
				...(config.from === undefined ? {} : { envelope: { from: config.from } }),
			});
			return { providerMessageId: info.messageId };
		},
	};
}
