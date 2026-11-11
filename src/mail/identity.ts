import type {
	CredentialKeys,
	CredentialRepository,
	CredentialStatus,
} from "./credentials";
import { GmailApiError, type GmailClient } from "./gmail-client";
import { OAuthProviderError, type GmailOAuthClient } from "./oauth-client";
import { buildRfc822Message, encodeRawMessage } from "./rfc822";
import { MailSendError, type MailSender, type OutboundMail, type SendIdentity } from "./send";
import type { MailboxRecord, MailRepository } from "./store";

/**
 * Identity management and outbound routing (S7c).
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
	const statusByMailbox = new Map<string, CredentialStatus>();
	for (const record of records) {
		// The refresh token is the status that governs send and sync for OAuth.
		if (record.credentialType !== "oauth_refresh") continue;
		statusByMailbox.set(record.mailboxId, record.status);
	}
	return mailboxes.map((mailbox) => ({
		mailbox,
		credentialStatus: statusByMailbox.get(mailbox.id) ?? null,
	}));
}

export type UnlinkDependencies = {
	repository: MailRepository;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	oauth: GmailOAuthClient | null;
};

/**
 * Contract §8.2/§8.3 order: decrypt, best-effort provider revoke, unconditional
 * crypto-shredding, then objects and rows. Repeating the call is a no-op.
 */
export async function unlinkMailbox(
	deps: UnlinkDependencies,
	input: { accountId: string; mailboxId: string; now: number },
): Promise<{ ok: true; alreadyUnlinked: boolean }> {
	const mailbox = await deps.repository.findMailboxById(input.accountId, input.mailboxId);
	if (!mailbox) return { ok: true, alreadyUnlinked: true };

	if (mailbox.provider === "gmail" && deps.keys && deps.oauth) {
		const credential = await deps.credentials.readActive({
			accountId: input.accountId,
			mailboxId: mailbox.id,
			credentialType: "oauth_refresh",
			keys: deps.keys,
		});
		if (credential.ok) {
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
};

const reauth = async (
	deps: RoutedMailSenderDependencies,
	identity: SendIdentity,
	now: number,
): Promise<never> => {
	await deps.credentials.markReauth({
		accountId: identity.accountId,
		mailboxId: identity.mailboxId,
		credentialType: "oauth_refresh",
		now,
	});
	throw new MailSendError(
		"provider_reauth_required",
		"The Gmail authorization is no longer valid; the identity must be linked again before it can send.",
	);
};

export function createRoutedMailSender(
	deps: RoutedMailSenderDependencies,
	now: () => number = Date.now,
): MailSender {
	return {
		async send(
			message: OutboundMail,
			identity?: SendIdentity,
		): Promise<{ providerMessageId: string; provider?: string }> {
			if (!identity || identity.provider !== "gmail") {
				if (!deps.fallback) {
					throw new MailSendError(
						"relay_unavailable",
						"No outbound provider is configured for this identity.",
					);
				}
				return deps.fallback.send(message);
			}

			if (!deps.keys || !deps.oauth || !deps.gmail) {
				throw new MailSendError(
					"provider_not_configured",
					"The Gmail provider or credential vault is not configured on this deployment.",
				);
			}

			const credential = await deps.credentials.readActive({
				accountId: identity.accountId,
				mailboxId: identity.mailboxId,
				credentialType: "oauth_refresh",
				keys: deps.keys,
			});
			if (!credential.ok) {
				if (
					credential.code === "credential_reauth_required" ||
					credential.code === "credential_revoked"
				) {
					throw new MailSendError(
						"provider_reauth_required",
						"The Gmail authorization is no longer valid; the identity must be linked again before it can send.",
					);
				}
				if (credential.code === "credential_missing") {
					throw new MailSendError(
						"credential_missing",
						"No stored Gmail credential exists for this identity.",
					);
				}
				throw new MailSendError(
					"credential_unreadable",
					"The stored Gmail credential cannot be decrypted; the identity is disabled.",
				);
			}

			let accessToken: string;
			try {
				const refreshed = await deps.oauth.refresh({ refreshToken: credential.secret });
				accessToken = refreshed.accessToken;
			} catch (error) {
				if (error instanceof OAuthProviderError && error.code === "invalid_grant") {
					await reauth(deps, identity, now());
				}
				throw new MailSendError(
					"relay_unavailable",
					"The Gmail token refresh failed; delivery is unknown and the confirmation is spent.",
				);
			}

			const raw = buildRfc822Message({ ...message, from: identity.address });
			try {
				const sent = await deps.gmail.sendMessage(accessToken, {
					raw: encodeRawMessage(raw),
				});
				return { providerMessageId: sent.id, provider: "gmail" };
			} catch (error) {
				if (error instanceof GmailApiError && error.code === "unauthorized") {
					await reauth(deps, identity, now());
				}
				throw new MailSendError(
					"relay_unavailable",
					"The Gmail provider rejected or failed the message; delivery is unknown and the confirmation is spent.",
				);
			}
		},
	};
}
