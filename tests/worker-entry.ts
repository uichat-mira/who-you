import worker from "../src/index";
import {
	createMailServices,
	resolveCredentialKeys,
	type MailServices,
	type WhoYouEnv,
} from "../src/mail/config";
import { CredentialRepository, type CredentialKeys } from "../src/mail/credentials";
import { parseKek } from "../src/mail/credential-crypto";
import { MAIL_DOWNLOAD_PATH, handleSignedDownload } from "../src/mail/download";
import { runRetentionSweep } from "../src/mail/retention";
import { provisionOwnMailbox } from "../src/mail/provision";
import { DELIVERY_WEBHOOK_PATH } from "../src/mail/webhook";
import { GMAIL_SCOPES, OAuthProviderError, type GmailOAuthClient } from "../src/mail/oauth-client";
import { GmailApiError, type GmailClient } from "../src/mail/gmail-client";
import { completeGmailLink } from "../src/mail/gmail-link";
import { syncGmailMailbox } from "../src/mail/gmail-sync";
import { GraphApiError, type GraphClient } from "../src/mail/microsoft-client";
import { completeMicrosoftLink } from "../src/mail/microsoft-link";
import { syncMicrosoftMailbox } from "../src/mail/microsoft-sync";
import { MICROSOFT_SCOPES, type MicrosoftOAuthClient } from "../src/mail/microsoft-oauth";
import { encodeBase64Url } from "../src/mail/base64url";
import { createRoutedMailSender } from "../src/mail/identity";
import { linkImapIdentity } from "../src/mail/imap-link";
import { syncImapMailbox } from "../src/mail/imap-sync";
import type { MailConnection, MailTransport } from "../src/mail/socket-transport";
import { MailTransportError } from "../src/mail/socket-transport";
import { MailSendError, type MailSender } from "../src/mail/send";
import type { MailboxRecord } from "../src/mail/store";
import {
	CLOUD_AUTH_TOKEN_ISSUER,
	MCP_METADATA_PATH,
	MCP_RESOURCE_PATH,
} from "../src/mcp/config";
import { createWhoYouRuntime } from "../src/mcp/runtime";
import {
	createFakeMailSender,
	createFixtureConfirmationVerifier,
	createFixtureIdentityConfirmationVerifier,
	createFixtureVerifier,
	fixtureOutbox,
} from "./fixtures";

/**
 * Test-only Worker entry. It exposes the same production `fetch` and `email`
 * handlers, but adds a `/__inbound` route because Miniflare has no public API
 * for dispatching the `email` handler itself. The route constructs the same
 * ForwardableEmailMessage shape workerd passes to `email()` and invokes the
 * production handler with the real D1/R2 bindings.
 */
type InboundRequest = {
	from?: string;
	to: string;
	raw: string;
	headers?: Record<string, string>;
};

function buildEmailMessage(input: InboundRequest): {
	message: ForwardableEmailMessage;
	rejectedReason: () => string | null;
} {
	const bytes = new TextEncoder().encode(input.raw);
	let rejected: string | null = null;
	const message = {
		from: input.from ?? "sender@example.com",
		to: input.to,
		headers: new Headers(input.headers ?? {}),
		raw: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		rawSize: bytes.byteLength,
		setReject(reason: string) {
			rejected = reason;
		},
		async forward() {},
		async reply() {
			throw new Error("reply is out of scope for S1");
		},
	} as unknown as ForwardableEmailMessage;
	return { message, rejectedReason: () => rejected };
}

const FIXTURE_GMAIL_RAW = [
	"From: Fixture Sender <sender@example.net>",
	"To: linked@gmail.com",
	"Subject: Gmail fixture message",
	"Message-ID: <gmail-fixture-1@example.net>",
	"Date: Mon, 10 Nov 2025 10:00:00 +0000",
	"MIME-Version: 1.0",
	'Content-Type: text/plain; charset="utf-8"',
	"",
	"Fixture body for the Gmail sync path.",
	"",
].join("\r\n");

const fixtureGmailRawBytes = (): Uint8Array => new TextEncoder().encode(FIXTURE_GMAIL_RAW);

type GmailScript = "ok" | "empty" | "history_expired" | "unauthorized";

/** Deterministic Gmail double; it never touches the network. */
function createScriptedGmail(script: GmailScript): GmailClient {
	const messageId = "gmail-msg-1";
	const failUnauthorized = (): never => {
		throw new GmailApiError("unauthorized", 401);
	};
	return {
		async getProfile() {
			if (script === "unauthorized") failUnauthorized();
			return { emailAddress: "linked@gmail.com", historyId: "100" };
		},
		async sendMessage() {
			if (script === "unauthorized") failUnauthorized();
			return { id: "gmail-sent-1", threadId: "gmail-thread-1" };
		},
		async listMessages() {
			if (script === "unauthorized") failUnauthorized();
			if (script === "empty") return { ids: [], nextPageToken: null };
			return { ids: [messageId], nextPageToken: null };
		},
		async getMessage() {
			if (script === "unauthorized") failUnauthorized();
			return {
				id: messageId,
				threadId: "gmail-thread-1",
				internalDate: 1_795_000_000_000,
				raw: fixtureGmailRawBytes(),
			};
		},
		async listHistory() {
			if (script === "unauthorized") failUnauthorized();
			if (script === "history_expired") throw new GmailApiError("history_expired", 404);
			return { historyId: "101", messageIds: [messageId], nextPageToken: null };
		},
	};
}

/** OAuth double: returns fixed tokens without contacting Google. */
function createFixtureOAuth(options: { invalidGrant?: boolean } = {}): GmailOAuthClient {
	return {
		authorizationUrl({ state, codeChallenge }) {
			const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
			url.searchParams.set("state", state);
			url.searchParams.set("code_challenge", codeChallenge);
			return url.href;
		},
		async exchangeCode() {
			if (options.invalidGrant) {
				throw new OAuthProviderError("invalid_grant");
			}
			return {
				accessToken: "fixture-access-token",
				refreshToken: "fixture-refresh-token",
				scope: GMAIL_SCOPES.join(" "),
				expiresIn: 3600,
			};
		},
		async refresh() {
			if (options.invalidGrant) {
				throw new OAuthProviderError("invalid_grant");
			}
			return {
				accessToken: "fixture-access-token",
				refreshToken: null,
				scope: GMAIL_SCOPES.join(" "),
				expiresIn: 3600,
			};
		},
		async revoke() {
			return true;
		},
	};
}

const FIXTURE_MICROSOFT_RAW = [
	"From: Fixture Sender <sender@example.net>",
	"To: linked@outlook.com",
	"Subject: Microsoft fixture message",
	"Message-ID: <microsoft-fixture-1@example.net>",
	"Date: Mon, 10 Nov 2025 10:00:00 +0000",
	"MIME-Version: 1.0",
	'Content-Type: text/plain; charset="utf-8"',
	"",
	"Fixture body for the Microsoft sync path.",
	"",
].join("\r\n");

const fixtureMicrosoftRawBytes = (): Uint8Array =>
	new TextEncoder().encode(FIXTURE_MICROSOFT_RAW);

/** Unsigned ID token; the address claim is all the link path reads. */
const fixtureMicrosoftIdToken = (): string =>
	[
		encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
		encodeBase64Url(JSON.stringify({ preferred_username: "linked@outlook.com" })),
		"fixture-signature",
	].join(".");

type MicrosoftScript = "ok" | "empty" | "cursor_expired" | "unauthorized";

/** OAuth double: returns fixed Microsoft tokens without contacting the authority. */
function createFixtureMicrosoftOAuth(
	options: { invalidGrant?: boolean } = {},
): MicrosoftOAuthClient {
	return {
		authorizationUrl({ state, codeChallenge }) {
			const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
			url.searchParams.set("state", state);
			url.searchParams.set("code_challenge", codeChallenge);
			return url.href;
		},
		async exchangeCode() {
			if (options.invalidGrant) throw new OAuthProviderError("invalid_grant");
			return {
				accessToken: "fixture-ms-access-token",
				refreshToken: "fixture-ms-refresh-token",
				scope: MICROSOFT_SCOPES.join(" "),
				expiresIn: 3600,
				idToken: fixtureMicrosoftIdToken(),
			};
		},
		async refresh() {
			if (options.invalidGrant) throw new OAuthProviderError("invalid_grant");
			return {
				accessToken: "fixture-ms-access-token",
				refreshToken: null,
				scope: MICROSOFT_SCOPES.join(" "),
				expiresIn: 3600,
				idToken: null,
			};
		},
	};
}

const FIXTURE_DELTA_LINK =
	"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=1";

/** Deterministic Graph double; it never touches the network. */
function createScriptedMicrosoft(script: MicrosoftScript): GraphClient {
	const messageId = "ms-msg-1";
	const failUnauthorized = (): never => {
		throw new GraphApiError("unauthorized", 401);
	};
	return {
		async sendMessage() {
			if (script === "unauthorized") failUnauthorized();
			return { id: "ms-sent-1" };
		},
		async getMessageMime() {
			if (script === "unauthorized") failUnauthorized();
			return { id: messageId, raw: fixtureMicrosoftRawBytes() };
		},
		async listInboxDelta() {
			if (script === "unauthorized") failUnauthorized();
			if (script === "cursor_expired") throw new GraphApiError("cursor_expired", 410);
			if (script === "empty") {
				return { messages: [], nextLink: null, deltaLink: FIXTURE_DELTA_LINK };
			}
			return {
				messages: [{ id: messageId, receivedAt: 1_795_000_000_000 }],
				nextLink: null,
				deltaLink: FIXTURE_DELTA_LINK,
			};
		},
	};
}

type TestEnv = WhoYouEnv & {
	/** Test-only switch for the injected outbound fake. */
	MAIL_SEND_MODE?: "ok" | "failing" | "missing" | "gmail" | "microsoft";
};

type CallbackInput = { code: string; state: string; invalidGrant: boolean };

const methodNotAllowed = (): Response =>
	Response.json({ error: "method_not_allowed" }, { status: 405 });

async function handleCallbackRoute(
	request: Request,
	env: TestEnv,
	complete: (
		services: MailServices,
		keys: CredentialKeys,
		input: CallbackInput,
	) => Promise<unknown>,
): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed();
	const input = (await request.json()) as {
		code?: string;
		state?: string;
		invalidGrant?: boolean;
	};
	const resolved = createMailServices(env);
	if (!resolved.ok || !resolved.services.credentialKeys) {
		return Response.json({ error: "mail_not_configured" }, { status: 503 });
	}
	if (!input.code || !input.state) {
		return Response.json({ error: "invalid_request" }, { status: 400 });
	}
	const result = await complete(resolved.services, resolved.services.credentialKeys, {
		code: input.code,
		state: input.state,
		invalidGrant: Boolean(input.invalidGrant),
	});
	return Response.json(result);
}

/** Shared prelude for the sync and send routes: auth, body and mailbox. */
async function handleMailboxRoute(
	request: Request,
	env: TestEnv,
	run: (services: MailServices, keys: CredentialKeys, mailbox: MailboxRecord, body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed();
	const body = (await request.json()) as Record<string, unknown>;
	const resolved = createMailServices(env);
	if (!resolved.ok || !resolved.services.credentialKeys) {
		return Response.json({ error: "mail_not_configured" }, { status: 503 });
	}
	const accountId = typeof body.accountId === "string" ? body.accountId : "";
	const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId : "";
	if (!accountId || !mailboxId) {
		return Response.json({ error: "invalid_request" }, { status: 400 });
	}
	const mailbox = await resolved.services.repository.findMailboxById(accountId, mailboxId);
	if (!mailbox) return Response.json({ error: "mailbox_not_found" }, { status: 404 });
	return run(resolved.services, resolved.services.credentialKeys, mailbox, body);
}

const stringField = (body: Record<string, unknown>, key: string): string =>
	typeof body[key] === "string" ? (body[key] as string) : "";

async function handleSendRoute(
	request: Request,
	env: TestEnv,
	config: {
		provider: "gmail" | "microsoft" | "imap_smtp";
		subject: string;
		buildSender: (
			services: MailServices,
			keys: CredentialKeys,
			input: { invalidGrant: boolean; script: string },
		) => MailSender;
	},
): Promise<Response> {
	return handleMailboxRoute(request, env, async (services, keys, mailbox, body) => {
		const to = stringField(body, "to");
		if (!to) return Response.json({ error: "invalid_request" }, { status: 400 });
		const sender = config.buildSender(services, keys, {
			invalidGrant: body.invalidGrant === true,
			script: stringField(body, "script") || "ok",
		});
		try {
			const sent = await sender.send(
				{
					from: mailbox.address,
					to: [{ name: "", address: to }],
					cc: [],
					bcc: [],
					subject: config.subject,
					text: "Fixture body",
					html: null,
				},
				{
					accountId: mailbox.accountId,
					mailboxId: mailbox.id,
					address: mailbox.address,
					provider: config.provider,
				},
			);
			return Response.json(sent);
		} catch (error) {
			if (error instanceof MailSendError) {
				return Response.json(
					{ error: error.code },
					{ status: error.code === "provider_reauth_required" ? 409 : 502 },
				);
			}
			throw error;
		}
	});
}

async function handleSyncRoute(
	request: Request,
	env: TestEnv,
	run: (services: MailServices, keys: CredentialKeys, mailbox: MailboxRecord, script: string) => Promise<unknown>,
): Promise<Response> {
	return handleMailboxRoute(request, env, async (services, keys, mailbox, body) => {
		const script = stringField(body, "script") || "ok";
		return Response.json(await run(services, keys, mailbox, script));
	});
}

/** The routed sender the MCP runtime uses when `MAIL_SEND_MODE` selects one. */
function buildRoutedSender(
	services: MailServices,
	keys: CredentialKeys,
	provider: "gmail" | "microsoft",
): MailSender {
	return createRoutedMailSender(
		provider === "gmail"
			? {
					fallback: null,
					credentials: services.credentials,
					keys,
					oauth: createFixtureOAuth(),
					gmail: createScriptedGmail("ok"),
					microsoftOauth: null,
					microsoft: null,
					transport: null,
					remoteTargets: null,
				}
			: {
					fallback: null,
					credentials: services.credentials,
					keys,
					oauth: null,
					gmail: null,
					microsoftOauth: createFixtureMicrosoftOAuth(),
					microsoft: createScriptedMicrosoft("ok"),
					transport: null,
					remoteTargets: null,
				},
	);
}

const FIXTURE_IMAP_RAW = [
	"From: IMAP Sender <sender@example.org>",
	"To: linked@example.net",
	"Subject: IMAP fixture message",
	"Message-ID: <imap-fixture-1@example.org>",
	"Date: Mon, 10 Nov 2025 10:00:00 +0000",
	"MIME-Version: 1.0",
	'Content-Type: text/plain; charset="utf-8"',
	"",
	"Fixture body for the IMAP sync path.",
	"",
].join("\r\n");

type ImapScript = "ok" | "empty" | "imap_auth_fail" | "uidvalidity_changed";
type SmtpScript = "ok" | "no_starttls" | "auth_fail";

type FakeTransportState = {
	connectCalls: number;
	authAttempts: number;
	commands: string[];
};

type FakeTransport = MailTransport & { state: FakeTransportState };

/**
 * Scripted socket double for S7e. It answers the exact command grammar the SMTP
 * and IMAP clients emit and never performs DNS or network I/O.
 */
function createFakeTransport(input: {
	imapScript?: ImapScript;
	smtpScript?: SmtpScript;
	uidValidity?: number;
}): FakeTransport {
	const state: FakeTransportState = { connectCalls: 0, authAttempts: 0, commands: [] };
	const imapScript = input.imapScript ?? "ok";
	const smtpScript = input.smtpScript ?? "ok";
	const uidValidity = input.uidValidity ?? 42;
	return {
		state,
		async connect({ port }) {
			state.connectCalls += 1;
			const isImap = port === 993 || port === 143;
			const queue: string[] = [];
			const literals: Uint8Array[] = [];
			let awaitingData = false;
			let loginStage = 0;
			const push = (...lines: string[]): void => {
				queue.push(...lines);
			};
			if (isImap) push("* OK fake IMAP ready");
			else push("220 fake ESMTP ready");

			const write = async (data: string | Uint8Array): Promise<void> => {
				const text = typeof data === "string" ? data : new TextDecoder().decode(data);
				if (awaitingData) {
					awaitingData = false;
					push("250 2.0.0 queued");
					return;
				}
				state.commands.push(text.trimEnd());
				if (isImap) {
					const space = text.indexOf(" ");
					const tag = text.slice(0, space);
					const command = text.slice(space + 1).trimEnd();
					if (command.startsWith("CAPABILITY")) {
						push(
							"* CAPABILITY IMAP4rev1 STARTTLS",
							`${tag} OK CAPABILITY completed`,
						);
					} else if (command.startsWith("STARTTLS")) {
						push(`${tag} OK Begin TLS`);
					} else if (command.startsWith("LOGIN")) {
						push(
							imapScript === "imap_auth_fail"
								? `${tag} NO [AUTHENTICATIONFAILED] rejected`
								: `${tag} OK LOGIN completed`,
						);
					} else if (command.startsWith("SELECT")) {
						push(
							"* FLAGS (\\Seen)",
							`* OK [UIDVALIDITY ${uidValidity}] UIDs valid`,
							"* OK [UIDNEXT 3] Predicted next UID",
							`${tag} OK [READ-WRITE] SELECT completed`,
						);
					} else if (command.startsWith("UID SEARCH")) {
						push(
							imapScript === "empty" ? "* SEARCH" : "* SEARCH 1 2",
							`${tag} OK SEARCH completed`,
						);
					} else if (command.startsWith("UID FETCH")) {
						const uid = Number.parseInt(command.split(/\s+/)[2] ?? "1", 10);
						const raw = new TextEncoder().encode(FIXTURE_IMAP_RAW);
						push(`* 1 FETCH (UID ${uid} BODY[] {${raw.byteLength}}`);
						literals.push(raw);
						push(")", `${tag} OK FETCH completed`);
					} else if (command.startsWith("LOGOUT")) {
						push("* BYE", `${tag} OK LOGOUT completed`);
					}
					return;
				}

				if (loginStage === 1) {
					loginStage = 2;
					push("334 UGFzc3dvcmQ6");
					return;
				}
				if (loginStage === 2) {
					loginStage = 0;
					push(smtpScript === "auth_fail" ? "535 5.7.8 rejected" : "235 2.7.0 accepted");
					return;
				}
				if (text.startsWith("EHLO")) {
					push(
						...(smtpScript === "no_starttls"
							? ["250-fake", "250 SIZE 100000"]
							: ["250-fake", "250 STARTTLS"]),
					);
				} else if (text.startsWith("STARTTLS")) {
					push("220 2.0.0 Ready to start TLS");
				} else if (text.startsWith("AUTH PLAIN")) {
					state.authAttempts += 1;
					push(smtpScript === "auth_fail" ? "535 5.7.8 rejected" : "235 2.7.0 accepted");
				} else if (text.startsWith("AUTH LOGIN")) {
					state.authAttempts += 1;
					loginStage = 1;
					push("334 VXNlcm5hbWU6");
				} else if (text.startsWith("MAIL FROM") || text.startsWith("RCPT TO")) {
					push("250 2.1.0 OK");
				} else if (text.startsWith("DATA")) {
					awaitingData = true;
					push("354 End data with <CR><LF>.<CR><LF>");
				} else if (text.startsWith("QUIT")) {
					push("221 2.0.0 Bye");
				}
			};

			return {
				async readLine() {
					const line = queue.shift();
					if (line === undefined) throw new MailTransportError();
					return line;
				},
				async readBytes(length: number) {
					const literal = literals.shift();
					if (!literal || literal.byteLength < length) throw new MailTransportError();
					return literal.subarray(0, length);
				},
				write,
				async upgradeTls() {
					return;
				},
				async close() {
					return;
				},
			} satisfies MailConnection;
		},
	};
}

export default {
	async fetch(request: Request, env: TestEnv): Promise<Response> {
		const path = new URL(request.url).pathname;

		if (path === "/__sent") {
			if (request.method !== "GET") {
				return Response.json({ error: "method_not_allowed" }, { status: 405 });
			}
			return Response.json({ sent: fixtureOutbox() });
		}

		if (path === "/__inbound") {
			if (request.method !== "POST") {
				return Response.json({ error: "method_not_allowed" }, { status: 405 });
			}
			let input: InboundRequest;
			try {
				input = (await request.json()) as InboundRequest;
			} catch {
				return Response.json({ error: "invalid_request" }, { status: 400 });
			}
			const { message, rejectedReason } = buildEmailMessage(input);
			if (!worker.email) throw new Error("test entry requires the production email handler");
			try {
				await worker.email(message, env);
			} catch {
				return Response.json({ error: "inbound_failed" }, { status: 500 });
			}
			return Response.json({ rejected: rejectedReason() });
		}

		if (path === "/__provision") {
			if (request.method !== "POST") {
				return Response.json({ error: "method_not_allowed" }, { status: 405 });
			}
			const input = (await request.json()) as {
				accountId?: string;
				localPart?: string;
				username?: string;
			};
			if (!input.accountId) {
				return Response.json({ error: "invalid_request" }, { status: 400 });
			}
			const services = createMailServices(env);
			if (!services.ok || !services.services.domain) {
				return Response.json({ error: "mail_not_configured" }, { status: 503 });
			}
			const result = await provisionOwnMailbox(services.services.repository, {
				accountId: input.accountId,
				username: input.username ?? null,
				localPart: input.localPart ?? null,
				domain: services.services.domain,
				quotaBytes: services.services.limits.mailboxQuotaBytes,
				now: 1_795_000_000_000,
			});
			return Response.json(result);
		}

		if (path === "/__credential") {
			if (request.method !== "POST") {
				return Response.json({ error: "method_not_allowed" }, { status: 405 });
			}
			const input = (await request.json()) as {
				action: "store" | "read" | "revoke" | "list" | "rewrap";
				accountId?: string;
				mailboxId?: string;
				provider?: "gmail" | "microsoft" | "imap_smtp";
				credentialType?: "oauth_refresh" | "imap_password" | "smtp_password";
				secret?: string;
				scope?: string;
				kek?: string;
				version?: number;
				previousKek?: string;
				previousVersion?: number;
			};
			if (!env.DB) return Response.json({ error: "storage_missing" }, { status: 503 });

			let keys: CredentialKeys | null = resolveCredentialKeys(env);
			if (input.kek) {
				const current = parseKek(input.kek);
				const previous = parseKek(input.previousKek);
				keys = current
					? {
						current: { version: input.version ?? 1, kek: current },
						previous:
							previous && input.previousVersion
								? { version: input.previousVersion, kek: previous }
								: null,
					}
					: null;
			}
			if (!keys) return Response.json({ error: "kek_missing" }, { status: 503 });

			const repository = new CredentialRepository(env.DB);
			const now = 1_795_000_000_000;
			if (input.action === "store") {
				if (!input.accountId || !input.mailboxId || !input.provider || !input.credentialType) {
					return Response.json({ error: "invalid_request" }, { status: 400 });
				}
				const result = await repository.store({
					accountId: input.accountId,
					mailboxId: input.mailboxId,
					provider: input.provider,
					credentialType: input.credentialType,
					secret: input.secret ?? "",
					scope: input.scope,
					keys,
					now,
				});
				return Response.json(result);
			}
			if (input.action === "read") {
				if (!input.accountId || !input.mailboxId || !input.credentialType) {
					return Response.json({ error: "invalid_request" }, { status: 400 });
				}
				return Response.json(
					await repository.readActive({
						accountId: input.accountId,
						mailboxId: input.mailboxId,
						credentialType: input.credentialType,
						keys,
					}),
				);
			}
			if (input.action === "revoke") {
				if (!input.accountId || !input.mailboxId || !input.credentialType) {
					return Response.json({ error: "invalid_request" }, { status: 400 });
				}
				const changes = await repository.revoke({
					accountId: input.accountId,
					mailboxId: input.mailboxId,
					credentialType: input.credentialType,
					now,
				});
				return Response.json({ changes });
			}
			if (input.action === "rewrap") {
				return Response.json(await repository.rewrapPending({ keys, now }));
			}
			return Response.json(await repository.list(input.accountId ?? ""));
		}

		if (path === "/__gmail/callback") {
			return handleCallbackRoute(request, env, (services, keys, input) =>
				completeGmailLink(
					{
						repository: services.repository,
						credentials: services.credentials,
						keys,
						states: services.oauthStates,
						syncStates: services.syncStates,
						oauth: createFixtureOAuth({ invalidGrant: input.invalidGrant }),
						gmail: createScriptedGmail("ok"),
						limits: services.limits,
						now: Date.now(),
					},
					input,
				),
			);
		}

		if (path === "/__gmail/sync") {
			return handleSyncRoute(request, env, (services, keys, mailbox, script) =>
				syncGmailMailbox(
					{
						repository: services.repository,
						limits: services.limits,
						credentials: services.credentials,
						keys,
						oauth: createFixtureOAuth(),
						gmail: createScriptedGmail(script as GmailScript),
						syncStates: services.syncStates,
						now: Date.now(),
					},
					mailbox,
				),
			);
		}

		if (path === "/__gmail/send") {
			return handleSendRoute(request, env, {
				provider: "gmail",
				subject: "Fixture Gmail send",
				buildSender: (services, keys, input) =>
					createRoutedMailSender({
						fallback: null,
						credentials: services.credentials,
						keys,
						oauth: createFixtureOAuth({ invalidGrant: input.invalidGrant }),
						gmail: createScriptedGmail(input.script as GmailScript),
						microsoftOauth: null,
						microsoft: null,
						transport: null,
						remoteTargets: null,
					}),
			});
		}

		if (path === "/__microsoft/callback") {
			return handleCallbackRoute(request, env, (services, keys, input) =>
				completeMicrosoftLink(
					{
						repository: services.repository,
						credentials: services.credentials,
						keys,
						states: services.oauthStates,
						syncStates: services.syncStates,
						oauth: createFixtureMicrosoftOAuth({ invalidGrant: input.invalidGrant }),
						limits: services.limits,
						now: Date.now(),
					},
					input,
				),
			);
		}

		if (path === "/__microsoft/sync") {
			return handleSyncRoute(request, env, (services, keys, mailbox, script) =>
				syncMicrosoftMailbox(
					{
						repository: services.repository,
						limits: services.limits,
						credentials: services.credentials,
						keys,
						oauth: createFixtureMicrosoftOAuth(),
						microsoft: createScriptedMicrosoft(script as MicrosoftScript),
						syncStates: services.syncStates,
						now: Date.now(),
					},
					mailbox,
				),
			);
		}

		if (path === "/__microsoft/send") {
			return handleSendRoute(request, env, {
				provider: "microsoft",
				subject: "Fixture Microsoft send",
				buildSender: (services, keys, input) =>
					createRoutedMailSender({
						fallback: null,
						credentials: services.credentials,
						keys,
						oauth: null,
						gmail: null,
						microsoftOauth: createFixtureMicrosoftOAuth({
							invalidGrant: input.invalidGrant,
						}),
						microsoft: createScriptedMicrosoft(input.script as MicrosoftScript),
						transport: null,
						remoteTargets: null,
					}),
			});
		}

		if (path === "/__imap/link") {
			const input = (await request.json()) as Record<string, unknown>;
			const resolved = createMailServices(env);
			if (!resolved.ok || !resolved.services.credentialKeys) {
				return Response.json({ error: "mail_storage_not_configured" }, { status: 503 });
			}
			const services = resolved.services;
			const transport = createFakeTransport({
				imapScript: (input.imapScript as ImapScript | undefined) ?? "ok",
				uidValidity: Number(input.uidValidity ?? 42),
			});
			const result = await linkImapIdentity(
				{
					repository: services.repository,
					credentials: services.credentials,
					keys: services.credentialKeys,
					syncStates: services.syncStates,
					limits: services.limits,
					remoteTargets: services.remoteTargets,
					transport,
					now: Date.now(),
				},
				{
					accountId: String(input.accountId ?? ""),
					address: String(input.address ?? ""),
					username: String(input.username ?? ""),
					imapHost: String(input.imapHost ?? ""),
					imapPort: Number(input.imapPort ?? 0),
					smtpHost: String(input.smtpHost ?? ""),
					smtpPort: Number(input.smtpPort ?? 0),
					appPassword: String(input.appPassword ?? ""),
				},
			);
			return Response.json({
				...result,
				connectCalls: transport.state.connectCalls,
				authAttempts: transport.state.authAttempts,
			});
		}

		if (path === "/__imap/sync") {
			return handleSyncRoute(request, env, async (services, keys, mailbox, script) => {
				const transport = createFakeTransport({
					imapScript: script as ImapScript,
					uidValidity: script === "uidvalidity_changed" ? 43 : 42,
				});
				const outcome = await syncImapMailbox(
					{
						repository: services.repository,
						limits: services.limits,
						credentials: services.credentials,
						keys,
						syncStates: services.syncStates,
						remoteTargets: services.remoteTargets,
						transport,
						now: Date.now(),
					},
					mailbox,
				);
				return {
					...outcome,
					connectCalls: transport.state.connectCalls,
					authAttempts: transport.state.authAttempts,
				};
			});
		}

		if (path === "/__imap/send") {
			return handleSendRoute(request, env, {
				provider: "imap_smtp",
				subject: "IMAP/SMTP outbound",
				buildSender: (services, keys, input) => {
					const transport = createFakeTransport({
						smtpScript: input.script as SmtpScript,
					});
					return createRoutedMailSender({
						fallback: null,
						credentials: services.credentials,
						keys,
						oauth: null,
						gmail: null,
						microsoftOauth: null,
						microsoft: null,
						transport,
						remoteTargets: services.remoteTargets,
					});
				},
			});
		}

		if (path === "/__retention") {
			if (request.method !== "POST") {
				return Response.json({ error: "method_not_allowed" }, { status: 405 });
			}
			const services = createMailServices(env);
			if (!services.ok) {
				return Response.json({ error: "mail_not_configured" }, { status: 503 });
			}
			const input = (await request.json()) as { now?: number };
			const result = await runRetentionSweep(
				services.services.repository,
				services.services.retention,
				input.now ?? Date.now(),
			);
			return Response.json(result);
		}

		if (path === DELIVERY_WEBHOOK_PATH) {
			// The production handler is self-contained: it needs only the HMAC
			// secret and the real D1 binding, so the fixture entry can delegate.
			return worker.fetch(request, env);
		}

		if (path === MAIL_DOWNLOAD_PATH) {
			return handleSignedDownload(
				request,
				env,
				createFixtureVerifier({
					issuer: CLOUD_AUTH_TOKEN_ISSUER,
					audience: env.MCP_AUDIENCE ?? "",
				}),
			);
		}

		if (path !== MCP_RESOURCE_PATH && path !== MCP_METADATA_PATH) {
			return Response.json({ error: "not_found" }, { status: 404 });
		}
		const mailServices = createMailServices(env);
		const mode = env.MAIL_SEND_MODE;
		const injectedSender =
			(mode === "gmail" || mode === "microsoft") &&
			mailServices.ok &&
			mailServices.services.credentialKeys
				? buildRoutedSender(
						mailServices.services,
						mailServices.services.credentialKeys,
						mode,
					)
				: mode === "missing"
					? null
					: createFakeMailSender({ failing: mode === "failing" });
		const resolved = createWhoYouRuntime(env, {
			verifier: createFixtureVerifier({
				issuer: CLOUD_AUTH_TOKEN_ISSUER,
				audience: env.MCP_AUDIENCE ?? "",
			}),
			confirmationVerifier: createFixtureConfirmationVerifier(),
			identityConfirmationVerifier: createFixtureIdentityConfirmationVerifier(),
			sender: injectedSender,
		});
		if (!resolved.ok) {
			return Response.json(
				{ error: "mcp_not_configured", reason: resolved.reason },
				{ status: 503 },
			);
		}
		return resolved.runtime.fetch(request);
	},
} satisfies ExportedHandler<WhoYouEnv>;
