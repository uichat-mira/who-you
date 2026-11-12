import type {
	CredentialKeys,
	CredentialRepository,
	CredentialStatus,
} from "./credentials";
import { GmailApiError, type GmailClient } from "./gmail-client";
import { encodeMimeBase64, GraphApiError, type GraphClient } from "./microsoft-client";
import { OAuthProviderError, type GmailOAuthClient } from "./oauth-client";
import type { MicrosoftOAuthClient } from "./microsoft-oauth";
import { buildRfc822Message, encodeRawMessage } from "./rfc822";
import type { RemoteTargetRepository } from "./remote-targets";
import { MailSendError, type MailSender, type OutboundMail, type SendIdentity } from "./send";
import { sendSmtpMessage, SmtpError } from "./smtp-client";
import type { MailTransport } from "./socket-transport";
import type { MailboxRecord, MailRepository } from "./store";

/**
 * Identity management and outbound routing (S7c/S7d).
 *
 * A draft keeps its mailbox; the router picks the provider adapter for that
 * mailbox and leaves the own-domain Resend / `send_email` path untouched.
 */

export type IdentityView = {
	mailbox: MailboxRecord;
	credentialStatus: CredentialStatus | null;
};

export async function listIdentities(
	repository: MailRepository,
	credentials: CredentialRepository,
	accountId: string,
): Promise<IdentityView[]> {
	const [mailboxes, records] = await Promise.all([
		repository.listMailboxesByAccount(accountId),
		credentials.list(accountId),
	]);
	const statusByMailbox = new Map<string, Partial<Record<string, CredentialStatus>>>();
	for (const record of records) {
		statusByMailbox.set(record.mailboxId, {
			...(statusByMailbox.get(record.mailboxId) ?? {}),
			[record.credentialType]: record.status,
		});
	}
	return mailboxes.map((mailbox) => {
		const statuses = statusByMailbox.get(mailbox.id) ?? {};
		// The refresh token governs OAuth identities; a self-filled identity is
		// governed by its IMAP password (both password rows share a lifetime).
		const credentialStatus =
			mailbox.provider === "imap_smtp"
				? (statuses.imap_password ?? null)
				: (statuses.oauth_refresh ?? null);
		return { mailbox, credentialStatus };
	});
}

export type UnlinkDependencies = {
	repository: MailRepository;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	oauth: GmailOAuthClient | null;
	remoteTargets: RemoteTargetRepository | null;
};

/**
 * Contract §8.2/§8.3 order: decrypt, best-effort provider revoke, unconditional
 * crypto-shredding, then objects and rows. Repeating the call is a no-op.
 *
 * Only Google exposes a token revocation endpoint; Microsoft has none, so a
 * Microsoft unlink goes straight to local shredding.
 */
export async function unlinkMailbox(
	deps: UnlinkDependencies,
	input: { accountId: string; mailboxId: string; now: number },
): Promise<{ ok: true; alreadyUnlinked: boolean }> {
	const mailbox = await deps.repository.findMailboxById(input.accountId, input.mailboxId);
	if (!mailbox) return { ok: true, alreadyUnlinked: true };

	if (deps.keys) {
		if (mailbox.provider === "imap_smtp") {
			// Both rows hold the same app password; shredding either alone would
			// leave a working credential behind.
			for (const credentialType of ["imap_password", "smtp_password"] as const) {
				await deps.credentials.revoke({
					accountId: input.accountId,
					mailboxId: mailbox.id,
					credentialType,
					now: input.now,
				});
			}
		} else {
			const credential = await deps.credentials.readActive({
				accountId: input.accountId,
				mailboxId: mailbox.id,
				credentialType: "oauth_refresh",
				keys: deps.keys,
			});
			if (credential.ok) {
				if (mailbox.provider === "gmail" && deps.oauth) {
					// A failed revocation is recorded only as a sync error; local shredding
					// must still happen so a leaked token cannot outlive the unlink.
					const revoked = await deps.oauth.revoke({ token: credential.secret });
					if (!revoked) {
						console.log(
							JSON.stringify({
								event: "whoyou_credential_event",
								outcome: "credential_revoke_unconfirmed",
								provider: "gmail",
								accountId: input.accountId,
								mailboxId: mailbox.id,
							}),
						);
					}
				}
				await deps.credentials.revoke({
					accountId: input.accountId,
					mailboxId: mailbox.id,
					credentialType: "oauth_refresh",
					now: input.now,
				});
			}
		}
	}

	if (deps.remoteTargets) await deps.remoteTargets.delete(mailbox.id);

	const keys = await deps.repository.listMailboxObjectKeys(mailbox.id);
	await deps.repository.deleteObjects(keys);
	await deps.repository.deleteMailboxScoped(mailbox.id);

	await deps.repository.insertAudit({
		id: `audit_${crypto.randomUUID()}`,
		accountId: input.accountId,
		action: "unlink_mailbox",
		targetId: mailbox.id,
		detail: mailbox.provider ? `provider=${mailbox.provider}` : "provider=none",
		createdAt: input.now,
	});

	return { ok: true, alreadyUnlinked: false };
}

export type RoutedMailSenderDependencies = {
	/** Own-domain adapter (Resend or `send_email`); null when unconfigured. */
	fallback: MailSender | null;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	oauth: GmailOAuthClient | null;
	gmail: GmailClient | null;
	microsoftOauth: MicrosoftOAuthClient | null;
	microsoft: GraphClient | null;
	/** Socket transport for `imap_smtp` identities; null closes that route. */
	transport: MailTransport | null;
	/** Endpoint rows for `imap_smtp` identities; null closes that route. */
	remoteTargets: RemoteTargetRepository | null;
};

type OAuthProviderName = "gmail" | "microsoft";

type RefreshableOAuth = {
	refresh(input: { refreshToken: string }): Promise<{ accessToken: string }>;
};

type OAuthTransport = {
	send(accessToken: string, raw: string): Promise<{ id: string }>;
};

const providerLabel = (provider: OAuthProviderName): string =>
	provider === "gmail" ? "Gmail" : "Microsoft";

const gmailTransport = (gmail: GmailClient): OAuthTransport => ({
	async send(accessToken, raw) {
		const sent = await gmail.sendMessage(accessToken, { raw: encodeRawMessage(raw) });
		return { id: sent.id };
	},
});

const microsoftTransport = (microsoft: GraphClient): OAuthTransport => ({
	async send(accessToken, raw) {
		const sent = await microsoft.sendMessage(accessToken, {
			rawBase64: encodeMimeBase64(raw),
		});
		return { id: sent.id };
	},
});

const reauth = async (
	deps: RoutedMailSenderDependencies,
	identity: SendIdentity,
	now: number,
	provider: OAuthProviderName,
): Promise<never> => {
	await deps.credentials.markReauth({
		accountId: identity.accountId,
		mailboxId: identity.mailboxId,
		credentialType: "oauth_refresh",
		now,
	});
	throw new MailSendError(
		"provider_reauth_required",
		`The ${providerLabel(provider)} authorization is no longer valid; the identity must be linked again before it can send.`,
	);
};

/**
 * Unseals one credential for an outbound route. The failure codes are shared by
 * OAuth and self-filled identities so both report the same fixed set.
 */
async function readCredentialSecret(
	deps: RoutedMailSenderDependencies,
	identity: SendIdentity,
	credentialType: "oauth_refresh" | "smtp_password",
	keys: CredentialKeys,
	label: string,
): Promise<string> {
	const credential = await deps.credentials.readActive({
		accountId: identity.accountId,
		mailboxId: identity.mailboxId,
		credentialType,
		keys,
	});
	if (credential.ok) return credential.secret;
	if (
		credential.code === "credential_reauth_required" ||
		credential.code === "credential_revoked"
	) {
		throw new MailSendError(
			"provider_reauth_required",
			`The ${label} credential is no longer valid; the identity must be linked again before it can send.`,
		);
	}
	if (credential.code === "credential_missing") {
		throw new MailSendError(
			"credential_missing",
			`No stored ${label} credential exists for this identity.`,
		);
	}
	throw new MailSendError(
		"credential_unreadable",
		`The stored ${label} credential cannot be decrypted; the identity is disabled.`,
	);
}

async function sendViaOAuth(
	deps: RoutedMailSenderDependencies,
	input: {
		identity: SendIdentity;
		provider: OAuthProviderName;
		oauth: RefreshableOAuth;
		transport: OAuthTransport;
		keys: CredentialKeys;
		message: OutboundMail;
		now: number;
	},
): Promise<{ providerMessageId: string; provider?: string }> {
	const { identity, provider, oauth, transport, message } = input;
	const label = providerLabel(provider);

	const secret = await readCredentialSecret(
		deps,
		identity,
		"oauth_refresh",
		input.keys,
		label,
	);

	let accessToken: string;
	try {
		const refreshed = await oauth.refresh({ refreshToken: secret });
		accessToken = refreshed.accessToken;
	} catch (error) {
		if (error instanceof OAuthProviderError && error.code === "invalid_grant") {
			await reauth(deps, identity, input.now, provider);
		}
		throw new MailSendError(
			"relay_unavailable",
			`The ${label} token refresh failed; delivery is unknown and the confirmation is spent.`,
		);
	}

	const raw = buildRfc822Message({ ...message, from: identity.address });
	try {
		const sent = await transport.send(accessToken, raw);
		return { providerMessageId: sent.id, provider };
	} catch (error) {
		if (
			(error instanceof GmailApiError || error instanceof GraphApiError) &&
			error.code === "unauthorized"
		) {
			await reauth(deps, identity, input.now, provider);
		}
		throw new MailSendError(
			"relay_unavailable",
			`The ${label} provider rejected or failed the message; delivery is unknown and the confirmation is spent.`,
		);
	}
}

async function sendViaImap(
	deps: RoutedMailSenderDependencies,
	input: {
		identity: SendIdentity;
		keys: CredentialKeys;
		message: OutboundMail;
		now: number;
	},
): Promise<{ providerMessageId: string; provider?: string }> {
	const transport = deps.transport;
	const remoteTargets = deps.remoteTargets;
	if (!transport || !remoteTargets) {
		throw new MailSendError(
			"provider_not_configured",
			"The IMAP/SMTP provider or credential vault is not configured on this deployment.",
		);
	}

	const secret = await readCredentialSecret(
		deps,
		input.identity,
		"smtp_password",
		input.keys,
		"IMAP/SMTP",
	);
	const target = await remoteTargets.get(input.identity.mailboxId);
	if (!target) {
		throw new MailSendError(
			"credential_missing",
			"No stored IMAP/SMTP endpoint exists for this identity.",
		);
	}

	const tls = target.smtpPort === 465 ? "implicit" : "starttls";
	const raw = buildRfc822Message({ ...input.message, from: input.identity.address });
	let connection: Awaited<ReturnType<MailTransport["connect"]>> | null = null;
	try {
		connection = await transport.connect({
			host: target.smtpHost,
			port: target.smtpPort,
			tls,
		});
		const sent = await sendSmtpMessage(connection, {
			host: target.smtpHost,
			tls,
			username: target.username,
			password: secret,
			from: input.identity.address,
			to: input.message.to.map((entry) => entry.address),
			cc: input.message.cc.map((entry) => entry.address),
			bcc: input.message.bcc.map((entry) => entry.address),
			raw,
		});
		return { providerMessageId: sent.messageId ?? "", provider: "imap_smtp" };
	} catch (error) {
		if (error instanceof SmtpError) {
			if (error.code === "provider_auth_failed") {
				await deps.credentials.markReauth({
					accountId: input.identity.accountId,
					mailboxId: input.identity.mailboxId,
					credentialType: "smtp_password",
					now: input.now,
				});
				throw new MailSendError(
					"provider_reauth_required",
					"The IMAP/SMTP password was rejected; the identity must be linked again before it can send.",
				);
			}
			throw new MailSendError(
				"relay_unavailable",
				"The IMAP/SMTP provider rejected or failed the message; delivery is unknown and the confirmation is spent.",
			);
		}
		throw new MailSendError(
			"relay_unavailable",
			"The IMAP/SMTP provider could not be reached; delivery is unknown and the confirmation is spent.",
		);
	} finally {
		if (connection) await connection.close().catch(() => undefined);
	}
}

export function createRoutedMailSender(
	deps: RoutedMailSenderDependencies,
	now: () => number = Date.now,
): MailSender {
	return {
		async send(message: OutboundMail, identity?: SendIdentity) {
			if (
				!identity ||
				(identity.provider !== "gmail" &&
					identity.provider !== "microsoft" &&
					identity.provider !== "imap_smtp")
			) {
				if (!deps.fallback) {
					throw new MailSendError(
						"relay_unavailable",
						"No outbound provider is configured for this identity.",
					);
				}
				return deps.fallback.send(message);
			}

			const keys = deps.keys;
			if (!keys) {
				throw new MailSendError(
					"provider_not_configured",
					`The ${
						identity.provider === "imap_smtp"
							? "IMAP/SMTP"
							: providerLabel(identity.provider)
					} provider or credential vault is not configured on this deployment.`,
				);
			}

			if (identity.provider === "imap_smtp") {
				return sendViaImap(deps, { identity, keys, message, now: now() });
			}

			if (identity.provider === "gmail") {
				const oauth = deps.oauth;
				const gmail = deps.gmail;
				if (!oauth || !gmail) {
					throw new MailSendError(
						"provider_not_configured",
						"The Gmail provider or credential vault is not configured on this deployment.",
					);
				}
				return sendViaOAuth(deps, {
					identity,
					provider: "gmail",
					oauth,
					transport: gmailTransport(gmail),
					keys,
					message,
					now: now(),
				});
			}

			const oauth = deps.microsoftOauth;
			const microsoft = deps.microsoft;
			if (!oauth || !microsoft) {
				throw new MailSendError(
					"provider_not_configured",
					"The Microsoft provider or credential vault is not configured on this deployment.",
				);
			}
			return sendViaOAuth(deps, {
				identity,
				provider: "microsoft",
				oauth,
				transport: microsoftTransport(microsoft),
				keys,
				message,
				now: now(),
			});
		},
	};
}
