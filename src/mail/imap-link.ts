import type { CredentialKeys, CredentialRepository } from "./credentials";
import { openImapSession } from "./imap-client";
import { ImapError } from "./imap-client";
import { IMAP_BACKFILL_WINDOW_MS } from "./imap-sync";
import type { MailLimits } from "./limits";
import { validateRemoteTarget, type RemoteTarget } from "./remote-target";
import type { RemoteTargetRepository } from "./remote-targets";
import type { MailTransport } from "./socket-transport";
import { MailTransportError } from "./socket-transport";
import type { SyncStateRepository } from "./sync-state";
import type { MailRepository } from "./store";

/**
 * Link lifecycle for a user-supplied IMAP/SMTP identity (S7e).
 *
 * Unlike OAuth, the address is user input, so the strongest available proof of
 * ownership is a successful IMAP login with the same account that will send.
 * The host is validated before any socket is opened, the identity must match
 * the SMTP login exactly (anti-relay), and every failure is a fixed code that
 * reveals nothing about the target.
 */

export type ImapLinkFailureCode =
	| "invalid_target_host"
	| "invalid_target_port"
	| "provider_identity_mismatch"
	| "provider_auth_failed"
	| "provider_unreachable"
	| "provider_tls_required"
	| "credential_vault_unavailable"
	| "address_already_linked"
	| "link_failed";

export type LinkImapIdentityResult =
	| { ok: true; mailboxId: string; address: string; relinked: boolean }
	| { ok: false; code: ImapLinkFailureCode };

export type LinkImapIdentityDependencies = {
	repository: MailRepository;
	credentials: CredentialRepository;
	keys: CredentialKeys | null;
	syncStates: SyncStateRepository;
	limits: MailLimits;
	remoteTargets: RemoteTargetRepository;
	transport: MailTransport | null;
	now: number;
};

export type LinkImapIdentityInput = {
	accountId: string;
	address: string;
	username: string;
	imapHost: string;
	imapPort: number;
	smtpHost: string;
	smtpPort: number;
	appPassword: string;
};

const targetFailure = (
	code: "host_invalid" | "port_not_allowed",
): "invalid_target_host" | "invalid_target_port" =>
	code === "host_invalid" ? "invalid_target_host" : "invalid_target_port";

const mapSessionFailure = (error: unknown): ImapLinkFailureCode => {
	if (error instanceof ImapError) {
		if (error.code === "provider_auth_failed") return "provider_auth_failed";
		if (error.code === "provider_tls_required") return "provider_tls_required";
		return "provider_unreachable";
	}
	if (error instanceof MailTransportError) return "provider_unreachable";
	return "link_failed";
};

/**
 * Verifies the credentials against the IMAP endpoint. The caller closes the
 * connection even when `selectInbox` fails, so no socket leaks on rejection.
 */
const verifyImapLogin = async (
	transport: MailTransport,
	target: RemoteTarget,
	username: string,
	password: string,
): Promise<void> => {
	const connection = await transport.connect({
		host: target.host,
		port: target.port,
		tls: target.tls,
	});
	try {
		const session = await openImapSession(connection, {
			host: target.host,
			tls: target.tls,
			username,
			password,
		});
		await session.selectInbox();
		await session.close();
	} finally {
		await connection.close().catch(() => undefined);
	}
};

export async function linkImapIdentity(
	deps: LinkImapIdentityDependencies,
	input: LinkImapIdentityInput,
): Promise<LinkImapIdentityResult> {
	const imap = validateRemoteTarget({
		protocol: "imap",
		host: input.imapHost,
		port: input.imapPort,
	});
	if (!imap.ok) return { ok: false, code: targetFailure(imap.code) };

	const smtp = validateRemoteTarget({
		protocol: "smtp",
		host: input.smtpHost,
		port: input.smtpPort,
	});
	if (!smtp.ok) return { ok: false, code: targetFailure(smtp.code) };

	const address = input.address.trim().toLowerCase();
	const username = input.username.trim().toLowerCase();
	if (!address || address !== username) return { ok: false, code: "provider_identity_mismatch" };
	if (!deps.keys) return { ok: false, code: "credential_vault_unavailable" };
	if (!deps.transport) return { ok: false, code: "provider_unreachable" };

	const existing = await deps.repository.findMailboxByAddress(address);
	if (existing && existing.accountId !== input.accountId) {
		return { ok: false, code: "address_already_linked" };
	}
	if (existing && (existing.kind !== "third_party" || existing.provider !== "imap_smtp")) {
		return { ok: false, code: "address_already_linked" };
	}

	try {
		await verifyImapLogin(
			deps.transport,
			imap.target,
			username,
			input.appPassword,
		);
	} catch (error) {
		return { ok: false, code: mapSessionFailure(error) };
	}

	const mailboxId = existing?.id ?? `mbx_${crypto.randomUUID().replace(/-/g, "")}`;
	const relinked = Boolean(existing);
	if (!existing) {
		const inserted = await deps.repository.insertMailbox({
			id: mailboxId,
			accountId: input.accountId,
			address,
			localPart: address.slice(0, address.lastIndexOf("@")),
			kind: "third_party",
			provider: "imap_smtp",
			quotaBytes: deps.limits.mailboxQuotaBytes,
			now: deps.now,
		});
		if (!inserted) return { ok: false, code: "address_already_linked" };
	} else {
		// Re-linking replaces the stored password; the old one can no longer send.
		for (const credentialType of ["imap_password", "smtp_password"] as const) {
			await deps.credentials.revoke({
				accountId: input.accountId,
				mailboxId,
				credentialType,
				now: deps.now,
			});
		}
	}

	const rollback = async (): Promise<void> => {
		await deps.remoteTargets.delete(mailboxId).catch(() => undefined);
		if (!relinked) {
			await deps.repository.deleteMailboxScoped(mailboxId).catch(() => undefined);
		}
	};

	for (const credentialType of ["imap_password", "smtp_password"] as const) {
		const stored = await deps.credentials.store({
			accountId: input.accountId,
			mailboxId,
			provider: "imap_smtp",
			credentialType,
			secret: input.appPassword,
			keys: deps.keys,
			now: deps.now,
		});
		if (!stored.ok) {
			await rollback();
			return { ok: false, code: "link_failed" };
		}
	}

	await deps.remoteTargets.upsert({
		mailboxId,
		imapHost: imap.target.host,
		imapPort: imap.target.port,
		smtpHost: smtp.target.host,
		smtpPort: smtp.target.port,
		username,
		now: deps.now,
	});

	await deps.syncStates.upsert({
		mailboxId,
		provider: "imap_smtp",
		cursor: null,
		backfillBefore: deps.now - IMAP_BACKFILL_WINDOW_MS,
		backfillPage: null,
		backfillHistoryId: null,
		lastSyncedAt: null,
		lastError: null,
		now: deps.now,
	});

	await deps.repository.insertAudit({
		id: `audit_${crypto.randomUUID()}`,
		accountId: input.accountId,
		action: "link_mailbox",
		targetId: mailboxId,
		detail: "provider=imap_smtp",
		createdAt: deps.now,
	});

	return { ok: true, mailboxId, address, relinked };
}
