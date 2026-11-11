import worker from "../src/index";
import { createMailServices, resolveCredentialKeys, type WhoYouEnv } from "../src/mail/config";
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
import { createRoutedMailSender } from "../src/mail/identity";
import { MailSendError } from "../src/mail/send";
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

type TestEnv = WhoYouEnv & {
	/** Test-only switch for the injected outbound fake. */
	MAIL_SEND_MODE?: "ok" | "failing" | "missing" | "gmail";
};

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
			if (request.method !== "POST") {
				return Response.json({ error: "method_not_allowed" }, { status: 405 });
			}
			const input = (await request.json()) as {
				code?: string;
				state?: string;
				invalidGrant?: boolean;
			};
			const services = createMailServices(env);
			if (!services.ok || !services.services.credentialKeys) {
				return Response.json({ error: "mail_not_configured" }, { status: 503 });
			}
			if (!input.code || !input.state) {
				return Response.json({ error: "invalid_request" }, { status: 400 });
			}
			const result = await completeGmailLink(
				{
					repository: services.services.repository,
					credentials: services.services.credentials,
					keys: services.services.credentialKeys,
					states: services.services.oauthStates,
					syncStates: services.services.syncStates,
					oauth: createFixtureOAuth({ invalidGrant: input.invalidGrant }),
					gmail: createScriptedGmail("ok"),
					limits: services.services.limits,
					now: Date.now(),
				},
				{ code: input.code, state: input.state },
			);
			return Response.json(result);
		}

		if (path === "/__gmail/sync") {
			if (request.method !== "POST") {
				return Response.json({ error: "method_not_allowed" }, { status: 405 });
			}
			const input = (await request.json()) as {
				accountId?: string;
				mailboxId?: string;
				script?: GmailScript;
			};
			const services = createMailServices(env);
			if (!services.ok || !services.services.credentialKeys) {
				return Response.json({ error: "mail_not_configured" }, { status: 503 });
			}
			if (!input.accountId || !input.mailboxId) {
				return Response.json({ error: "invalid_request" }, { status: 400 });
			}
			const mailbox = await services.services.repository.findMailboxById(
				input.accountId,
				input.mailboxId,
			);
			if (!mailbox) return Response.json({ error: "mailbox_not_found" }, { status: 404 });
			const result = await syncGmailMailbox(
				{
					repository: services.services.repository,
					limits: services.services.limits,
					credentials: services.services.credentials,
					keys: services.services.credentialKeys,
					oauth: createFixtureOAuth(),
					gmail: createScriptedGmail(input.script ?? "ok"),
					syncStates: services.services.syncStates,
					now: Date.now(),
				},
				mailbox,
			);
			return Response.json(result);
		}

		if (path === "/__gmail/send") {
			if (request.method !== "POST") {
				return Response.json({ error: "method_not_allowed" }, { status: 405 });
			}
			const input = (await request.json()) as {
				accountId?: string;
				mailboxId?: string;
				to?: string;
				invalidGrant?: boolean;
				script?: GmailScript;
			};
			const services = createMailServices(env);
			if (!services.ok || !services.services.credentialKeys) {
				return Response.json({ error: "mail_not_configured" }, { status: 503 });
			}
			if (!input.accountId || !input.mailboxId || !input.to) {
				return Response.json({ error: "invalid_request" }, { status: 400 });
			}
			const mailbox = await services.services.repository.findMailboxById(
				input.accountId,
				input.mailboxId,
			);
			if (!mailbox) return Response.json({ error: "mailbox_not_found" }, { status: 404 });
			const sender = createRoutedMailSender({
				fallback: null,
				credentials: services.services.credentials,
				keys: services.services.credentialKeys,
				oauth: createFixtureOAuth({ invalidGrant: input.invalidGrant }),
				gmail: createScriptedGmail(input.script ?? "ok"),
			});
			try {
				const sent = await sender.send(
					{
						from: mailbox.address,
						to: [{ name: "", address: input.to }],
						cc: [],
						bcc: [],
						subject: "Fixture Gmail send",
						text: "Fixture body",
						html: null,
					},
					{
						accountId: input.accountId,
						mailboxId: mailbox.id,
						address: mailbox.address,
						provider: "gmail",
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
		const injectedSender =
			env.MAIL_SEND_MODE === "gmail" && mailServices.ok && mailServices.services.credentialKeys
				? createRoutedMailSender({
						fallback: null,
						credentials: mailServices.services.credentials,
						keys: mailServices.services.credentialKeys,
						oauth: createFixtureOAuth(),
						gmail: createScriptedGmail("ok"),
					})
				: env.MAIL_SEND_MODE === "missing"
					? null
					: createFakeMailSender({ failing: env.MAIL_SEND_MODE === "failing" });
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
