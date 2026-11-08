import { createMailServices, type WhoYouEnv } from "../mail/config";
import { createCloudAuthVerifier, type WhoYouTokenVerifier } from "./auth";
import { resolveMcpConfig } from "./config";
import { createWhoYouMcp, type WhoYouMcpRuntime } from "./server";

export type McpRuntimeOptions = {
	/** Test-only injection; the deployed entry never supplies this. */
	verifier?: WhoYouTokenVerifier;
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

	if (options.verifier) {
		return {
			ok: true,
			runtime: createWhoYouMcp(config, verifier, mail.services),
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
		runtime: createWhoYouMcp(config, verifier, mail.services),
	};
	byKey.set(key, result);
	return result;
}
