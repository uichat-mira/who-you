import worker from "../src/index";
import { createMailServices, resolveCredentialKeys, type WhoYouEnv } from "../src/mail/config";
import { CredentialRepository, type CredentialKeys } from "../src/mail/credentials";
import { parseKek } from "../src/mail/credential-crypto";
import { MAIL_DOWNLOAD_PATH, handleSignedDownload } from "../src/mail/download";
import { runRetentionSweep } from "../src/mail/retention";
import { provisionOwnMailbox } from "../src/mail/provision";
import { DELIVERY_WEBHOOK_PATH } from "../src/mail/webhook";
import {
	CLOUD_AUTH_TOKEN_ISSUER,
	MCP_METADATA_PATH,
	MCP_RESOURCE_PATH,
} from "../src/mcp/config";
import { createWhoYouRuntime } from "../src/mcp/runtime";
import {
	createFakeMailSender,
	createFixtureConfirmationVerifier,
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

type TestEnv = WhoYouEnv & {
	/** Test-only switch for the injected outbound fake. */
	MAIL_SEND_MODE?: "ok" | "failing" | "missing";
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
		const resolved = createWhoYouRuntime(env, {
			verifier: createFixtureVerifier({
				issuer: CLOUD_AUTH_TOKEN_ISSUER,
				audience: env.MCP_AUDIENCE ?? "",
			}),
			confirmationVerifier: createFixtureConfirmationVerifier(),
			sender:
				env.MAIL_SEND_MODE === "missing"
					? null
					: createFakeMailSender({ failing: env.MAIL_SEND_MODE === "failing" }),
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
