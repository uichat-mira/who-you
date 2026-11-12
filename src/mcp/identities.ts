import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MailServices } from "../mail/config";
import { startGmailLink } from "../mail/gmail-link";
import type { WhoYouIdentityConfirmationVerifier } from "../mail/identity-confirmation";
import { IdentityConfirmationError } from "../mail/identity-confirmation";
import {
	listIdentities,
	unlinkMailbox,
} from "../mail/identity";
import { linkImapIdentity, type ImapLinkFailureCode } from "../mail/imap-link";
import { startMicrosoftLink } from "../mail/microsoft-link";
import type { MailboxRecord } from "../mail/store";
import type { WhoYouPrincipal } from "./auth";
import { failure, requireWriteScope, success, type ToolResult } from "./mail";

export const MAILBOX_LIST_TOOL = "whoyou_mailbox_list";
export const MAILBOX_LINK_TOOL = "whoyou_mailbox_link";
export const MAILBOX_UNLINK_TOOL = "whoyou_mailbox_unlink";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const REVERSIBLE_WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
} as const;

const DESTRUCTIVE_WRITE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: true,
} as const;

export type IdentityToolDependencies = {
	identityConfirmations: WhoYouIdentityConfirmationVerifier;
};

const IMAP_LINK_MESSAGES: Record<ImapLinkFailureCode, string> = {
	invalid_target_host: "The host must be a plain hostname; IP literals and local names are rejected.",
	invalid_target_port: "Only IMAP 993 (or 143) and SMTP 465/587 are accepted.",
	provider_identity_mismatch: "The address must equal the SMTP login; relaying for another account is not allowed.",
	provider_auth_failed: "The provider rejected the username or app password.",
	provider_unreachable: "The provider could not be reached; nothing was stored.",
	provider_tls_required: "The provider did not offer STARTTLS; plaintext submission is refused.",
	credential_vault_unavailable: "The credential vault is not configured on this deployment.",
	address_already_linked: "This address is already linked to another identity.",
	link_failed: "The identity could not be linked; nothing was stored.",
};

const imapLinkMessage = (code: ImapLinkFailureCode): string => IMAP_LINK_MESSAGES[code];

const identityJson = (mailbox: MailboxRecord, credentialStatus: string | null): Record<string, unknown> => ({
	mailboxId: mailbox.id,
	address: mailbox.address,
	kind: mailbox.kind,
	provider: mailbox.provider,
	status: mailbox.status,
	credentialStatus,
	quotaBytes: mailbox.quotaBytes,
	bytesUsed: mailbox.bytesUsed,
	messageCount: mailbox.messageCount,
	createdAt: mailbox.createdAt,
});

const verifyIdentityConfirmation = async (
	deps: IdentityToolDependencies,
	principal: WhoYouPrincipal,
	token: string,
): Promise<
	| { ok: true; confirmation: { action: "link" | "unlink"; provider: string | null; mailboxId: string | null; nonce: string } }
	| ToolResult
> => {
	let verified;
	try {
		verified = await deps.identityConfirmations.verifyIdentityConfirmation(token);
	} catch (error) {
		if (error instanceof IdentityConfirmationError) {
			return failure(
				"confirmation_invalid",
				"The identity confirmation credential is missing, malformed or not issued for this account.",
			);
		}
		throw error;
	}
	if (verified.accountId !== principal.accountId) {
		return failure(
			"confirmation_invalid",
			"The identity confirmation credential is missing, malformed or not issued for this account.",
		);
	}
	return { ok: true, confirmation: verified.confirmation };
};

/**
 * Identity management surface (S7c/S7d). Tokens never appear in output; the
 * link tool returns only the provider authorization URL the user must open.
 */
export function registerIdentityTools(
	server: McpServer,
	principal: WhoYouPrincipal,
	services: MailServices,
	deps: IdentityToolDependencies,
): void {
	const accountId = principal.accountId;

	server.registerTool(
		MAILBOX_LIST_TOOL,
		{
			title: "Who You mailbox identities",
			description:
				"Lists every identity held by the caller: the own-domain address and any linked third-party mailboxes. Credential status is reported per identity; no credential material is returned. Identity comes from the bearer token, never from arguments.",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		async () => {
			const identities = await listIdentities(services.repository, services.credentials, accountId);
			const structured = {
				identities: identities.map((entry) => identityJson(entry.mailbox, entry.credentialStatus)),
			};
			const markdown = identities.length
				? identities
						.map(
							(entry) =>
								`- \`${entry.mailbox.id}\` · ${entry.mailbox.address} · ${entry.mailbox.kind}${
									entry.mailbox.provider ? `/${entry.mailbox.provider}` : ""
								}${entry.credentialStatus ? ` · credential: ${entry.credentialStatus}` : ""}`,
						)
						.join("\n")
				: "No mailbox identities are provisioned for this account.";
			return success(markdown, structured);
		},
	);

	server.registerTool(
		MAILBOX_LINK_TOOL,
		{
			title: "Who You link a third-party identity",
			description:
				"Links a Gmail or Microsoft mailbox with OAuth + PKCE, or an IMAP/SMTP mailbox with a user-supplied host, port, username and app password. Requires an identity confirmation credential bound to action=link and the same provider. OAuth returns a provider authorization URL the user must open; IMAP/SMTP verifies the login and stores the password sealed, so no host or password is ever returned. Never share the authorization URL.",
			inputSchema: z.object({
				provider: z.enum(["gmail", "microsoft", "imap_smtp"]),
				confirmationCredential: z.string().trim().min(1).max(8192),
				/** imap_smtp only: the address, its SMTP login and the two endpoints. */
				address: z.string().trim().min(1).max(320).optional(),
				username: z.string().trim().min(1).max(320).optional(),
				imapHost: z.string().trim().min(1).max(253).optional(),
				imapPort: z.number().int().min(1).max(65535).optional(),
				smtpHost: z.string().trim().min(1).max(253).optional(),
				smtpPort: z.number().int().min(1).max(65535).optional(),
				appPassword: z.string().min(1).max(4096).optional(),
			}),
			annotations: REVERSIBLE_WRITE,
		},
		async (args) => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;
			if (!services.credentialKeys) {
				return failure(
					"provider_not_configured",
					"The credential vault is not configured on this deployment.",
				);
			}
			const suppliedImapField = [
				args.address,
				args.username,
				args.imapHost,
				args.imapPort,
				args.smtpHost,
				args.smtpPort,
				args.appPassword,
			].some((value) => value !== undefined);
			if (args.provider !== "imap_smtp" && suppliedImapField) {
				return failure(
					"invalid_arguments",
					"IMAP/SMTP endpoint fields are only accepted when provider is imap_smtp.",
				);
			}
			if (args.provider === "gmail" && (!services.oauth || !services.gmailRedirectUri)) {
				return failure(
					"provider_not_configured",
					"Gmail OAuth is not configured on this deployment.",
				);
			}
			if (
				args.provider === "microsoft" &&
				(!services.microsoftOauth || !services.microsoftRedirectUri)
			) {
				return failure(
					"provider_not_configured",
					"Microsoft OAuth is not configured on this deployment.",
				);
			}

			const verified = await verifyIdentityConfirmation(
				deps,
				principal,
				args.confirmationCredential,
			);
			if (!("ok" in verified)) return verified;
			if (verified.confirmation.action !== "link") {
				return failure(
					"confirmation_action_mismatch",
					"This confirmation credential was issued for a different identity action.",
				);
			}
			if (verified.confirmation.provider !== args.provider) {
				return failure(
					"confirmation_provider_mismatch",
					"This confirmation credential was issued for a different provider.",
				);
			}

			const consumed = await services.repository.consumeIdentityNonce({
				nonce: verified.confirmation.nonce,
				accountId,
				action: "link",
				now: Date.now(),
			});
			if (!consumed) {
				return failure(
					"confirmation_replayed",
					"This confirmation credential was already used; no second link was started.",
				);
			}

			if (args.provider === "imap_smtp") {
				const address = args.address?.trim().toLowerCase();
				const username = args.username?.trim().toLowerCase();
				if (
					!address ||
					!username ||
					!args.imapHost ||
					!args.smtpHost ||
					!args.appPassword ||
					args.imapPort === undefined ||
					args.smtpPort === undefined
				) {
					return failure(
						"invalid_arguments",
						"provider=imap_smtp requires address, username, imapHost, imapPort, smtpHost, smtpPort and appPassword.",
					);
				}
				const linked = await linkImapIdentity(
					{
						repository: services.repository,
						credentials: services.credentials,
						keys: services.credentialKeys,
						syncStates: services.syncStates,
						limits: services.limits,
						remoteTargets: services.remoteTargets,
						transport: services.transport,
						now: Date.now(),
					},
					{
						accountId,
						address,
						username,
						imapHost: args.imapHost,
						imapPort: args.imapPort,
						smtpHost: args.smtpHost,
						smtpPort: args.smtpPort,
						appPassword: args.appPassword,
					},
				);
				if (!linked.ok) return failure(linked.code, imapLinkMessage(linked.code));
				return success(
					`The IMAP/SMTP identity ${linked.address} was linked. Syncing starts from the last 30 days; no password or host is ever returned.`,
					{
						provider: "imap_smtp",
						mailboxId: linked.mailboxId,
						address: linked.address,
						relinked: linked.relinked,
					},
				);
			}

			if (args.provider === "gmail") {
				const oauth = services.oauth;
				const redirectUri = services.gmailRedirectUri;
				if (!oauth || !redirectUri) {
					return failure(
						"provider_not_configured",
						"Gmail OAuth is not configured on this deployment.",
					);
				}
				const started = await startGmailLink(
					{ states: services.oauthStates, oauth, redirectUri },
					{ accountId, now: Date.now() },
				);
				return success(
					`Open this URL to authorize Gmail: ${started.authorizationUrl}\n\nThis link expires at ${new Date(started.expiresAt).toISOString()} and works once.`,
					{
						provider: "gmail",
						authorizationUrl: started.authorizationUrl,
						state: started.state,
						expiresAt: started.expiresAt,
					},
				);
			}

			const oauth = services.microsoftOauth;
			const redirectUri = services.microsoftRedirectUri;
			if (!oauth || !redirectUri) {
				return failure(
					"provider_not_configured",
					"Microsoft OAuth is not configured on this deployment.",
				);
			}
			const started = await startMicrosoftLink(
				{ states: services.oauthStates, oauth, redirectUri },
				{ accountId, now: Date.now() },
			);
			return success(
				`Open this URL to authorize Microsoft: ${started.authorizationUrl}\n\nThis link expires at ${new Date(started.expiresAt).toISOString()} and works once.`,
				{
					provider: "microsoft",
					authorizationUrl: started.authorizationUrl,
					state: started.state,
					expiresAt: started.expiresAt,
				},
			);
		},
	);

	server.registerTool(
		MAILBOX_UNLINK_TOOL,
		{
			title: "Who You unlink a third-party identity",
			description:
				"Removes a linked third-party identity, its credential (crypto-shredded) and every synced message, attachment and object. Requires an identity confirmation credential bound to action=unlink, the provider and this mailbox id. Repeating the call is idempotent.",
			inputSchema: z.object({
				mailboxId: z.string().trim().min(1).max(80),
				confirmationCredential: z.string().trim().min(1).max(8192),
			}),
			annotations: DESTRUCTIVE_WRITE,
		},
		async (args) => {
			const denied = requireWriteScope(principal);
			if (denied) return denied;

			const verified = await verifyIdentityConfirmation(
				deps,
				principal,
				args.confirmationCredential,
			);
			if (!("ok" in verified)) return verified;
			if (verified.confirmation.action !== "unlink") {
				return failure(
					"confirmation_action_mismatch",
					"This confirmation credential was issued for a different identity action.",
				);
			}
			if (verified.confirmation.mailboxId !== args.mailboxId) {
				return failure(
					"confirmation_mailbox_mismatch",
					"This confirmation credential was issued for a different mailbox.",
				);
			}

			const mailbox = await services.repository.findMailboxById(accountId, args.mailboxId);
			if (!mailbox) {
				return success("That identity is not linked to this account; nothing to remove.", {
					mailboxId: args.mailboxId,
					alreadyUnlinked: true,
				});
			}
			if (mailbox.kind !== "third_party") {
				return failure(
					"mailbox_not_third_party",
					"The own-domain identity cannot be unlinked; it is managed by the account lifecycle.",
				);
			}
			if (
				verified.confirmation.provider !== null &&
				verified.confirmation.provider !== mailbox.provider
			) {
				return failure(
					"confirmation_provider_mismatch",
					"This confirmation credential was issued for a different provider.",
				);
			}

			const consumed = await services.repository.consumeIdentityNonce({
				nonce: verified.confirmation.nonce,
				accountId,
				action: "unlink",
				now: Date.now(),
			});
			if (!consumed) {
				return failure(
					"confirmation_replayed",
					"This confirmation credential was already used; no second unlink was performed.",
				);
			}

			const result = await unlinkMailbox(
				{
					repository: services.repository,
					credentials: services.credentials,
					keys: services.credentialKeys,
					oauth: services.oauth,
					remoteTargets: services.remoteTargets,
				},
				{ accountId, mailboxId: args.mailboxId, now: Date.now() },
			);
			return success("The identity and its synced mail were removed.", {
				mailboxId: args.mailboxId,
				alreadyUnlinked: result.alreadyUnlinked,
			});
		},
	);
}
