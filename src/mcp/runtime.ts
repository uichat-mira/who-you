import { createMailServices, type WhoYouEnv } from "../mail/config";
import type { WhoYouConfirmationVerifier } from "../mail/confirmation";
import { createCloudflareMailSender, type MailSender } from "../mail/send";
import { createCloudAuthVerifier, type WhoYouTokenVerifier } from "./auth";
import { createCloudAuthConfirmationVerifier } from "./confirmation";
import { WHOYOU_SERVICE_AUDIENCE, resolveMcpConfig } from "./config";
import { createWhoYouMcp, type WhoYouMcpRuntime } from "./server";

export type McpRuntimeOptions = {
	/** Test-only injection; the deployed entry never supplies this. */
	verifier?: WhoYouTokenVerifier;
	/** Test-only injection for the draft-bound send credential. */
	confirmationVerifier?: WhoYouConfirmationVerifier;
	/** Test-only injection; `null` proves the no-binding path. */
	sender?: MailSender | null;
};

export type McpRuntimeResult =
	| { ok: true; runtime: WhoYouMcpRuntime }
	| { ok: false; reason: string };

const cache = new WeakMap<object, Map<string, McpRuntimeResult>>();

const runtimeCacheKey = (config: {
	resourceUrl: URL;
	issuer: string;
	jwksUrl: URL;
	audience: string;
	requiredScopes: string[];
	consumerClaim: string;
}): string =>
	[
		config.resourceUrl.href,
		config.issuer,
		config.jwksUrl.href,
		config.audience,
		config.requiredScopes.join(" "),
		config.consumerClaim,
	].join("\n");

/**
 * Resolves configuration and dependencies for one request. Production trust is
 * built only from the configured Cloud Auth issuer/JWKS/audience; tests inject a
 * deterministic verifier through their own worker entry, not through env.
 */
export function createWhoYouRuntime(
	env: WhoYouEnv,
	options: McpRuntimeOptions = {},
): McpRuntimeResult {
	const resolved = resolveMcpConfig(env);
	if (!resolved.ok) return resolved;

	const mail = createMailServices(env);
	if (!mail.ok) return mail;

	const { config } = resolved;
	const verifier =
		options.verifier ??
		createCloudAuthVerifier({
			issuer: config.tokenIssuer,
			audience: config.audience,
			jwksUrl: config.jwksUrl,
			consumerClaim: config.consumerClaim,
		});

	// A send confirmation is always minted for the dedicated Who You audience,
	// independent of whether MCP_AUDIENCE is that label or the exact /mcp URL.
	const confirmations =
		options.confirmationVerifier ??
		createCloudAuthConfirmationVerifier({
			issuer: config.tokenIssuer,
			audience: WHOYOU_SERVICE_AUDIENCE,
			jwksUrl: config.jwksUrl,
		});

	const sender =
		options.sender !== undefined
			? options.sender
			: createCloudflareMailSender(env.MAIL_EMAIL_SEND);

	const tools = { confirmations, sender };

	const injected =
		options.verifier !== undefined ||
		options.confirmationVerifier !== undefined ||
		options.sender !== undefined;
	if (injected) {
		return {
			ok: true,
			runtime: createWhoYouMcp(config, verifier, mail.services, tools),
		};
	}

	// The deployed Worker reuses one runtime per isolate and configuration set;
	// stateless MCP still creates no protocol session.
	const key = runtimeCacheKey(config);
	let byKey = cache.get(env);
	if (!byKey) {
		byKey = new Map<string, McpRuntimeResult>();
		cache.set(env, byKey);
	}
	const existing = byKey.get(key);
	if (existing) return existing;

	const result: McpRuntimeResult = {
		ok: true,
		runtime: createWhoYouMcp(config, verifier, mail.services, tools),
	};
	byKey.set(key, result);
	return result;
}
