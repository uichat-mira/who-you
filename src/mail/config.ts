import type { McpEnv } from "../mcp/config";
import { resolveMcpConfig } from "../mcp/config";
import { normalizeDomain } from "./address";
import { resolveAbusePolicy, type AbuseLimitEnv, type AbusePolicy } from "./abuse";
import {
	resolveMailLimits,
	type MailLimitEnv,
	type MailLimits,
} from "./limits";
import { DraftRepository } from "./draft-store";
import { CredentialRepository, type CredentialKeys } from "./credentials";
import { parseKek } from "./credential-crypto";
import { resolveRetention, type RetentionEnv, type RetentionPolicy } from "./retention";
import { MailRepository } from "./store";

/**
 * Deployed binding surface for this slice. Storage bindings are optional in the
 * type only so that misconfigured deployments fail closed at runtime instead of
 * failing typecheck; they are not optional for any mail-serving path.
 */
export type WhoYouEnv = McpEnv &
	MailLimitEnv &
	AbuseLimitEnv &
	RetentionEnv & {
		DB?: D1Database;
		MAIL_BUCKET?: R2Bucket;
		MAIL_DOMAIN?: string;
		/** Cloudflare Email Service binding; send is closed when it is absent. */
		MAIL_EMAIL_SEND?: SendEmail;
		/**
		 * Resend API key. Preferred over `MAIL_EMAIL_SEND` when present; Resend
		 * needs no MX change, so it coexists with Cloudflare Email Routing.
		 */
		MAIL_RESEND_API_KEY?: string;
		/**
		 * HMAC key for short-lived attachment/export links. Absent or shorter
		 * than 32 characters closes the signed-download capability entirely.
		 */
		MAIL_SIGNING_KEY?: string;
		/**
		 * HMAC key for the internal relay delivery callback. Absent or shorter
		 * than 32 characters closes the callback entirely (503, fail-closed).
		 */
		MAIL_INTERNAL_WEBHOOK_SECRET?: string;
		/** Base64 32-byte KEK sealing third-party credentials. Absent closes S7. */
		MAIL_CREDENTIAL_KEK?: string;
		MAIL_CREDENTIAL_KEK_VERSION?: string;
		/** Previous KEK kept for one rotation window. */
		MAIL_CREDENTIAL_KEK_PREVIOUS?: string;
		MAIL_CREDENTIAL_KEK_PREVIOUS_VERSION?: string;
	};

export type MailServices = {
	repository: MailRepository;
	drafts: DraftRepository;
	limits: MailLimits;
	/** `null` when MAIL_DOMAIN is missing or invalid; inbound stays closed. */
	domain: string | null;
	/** `null` when MAIL_SIGNING_KEY is missing or too short. */
	signingKey: string | null;
	retention: RetentionPolicy;
	abuse: AbusePolicy;
	/** Public resource URL used as the origin of signed download links. */
	resourceUrl: URL | null;
	credentials: CredentialRepository;
	/** `null` when MAIL_CREDENTIAL_KEK is missing or not a base64 32-byte key. */
	credentialKeys: CredentialKeys | null;
};

export type MailServicesResult =
	| { ok: true; services: MailServices }
	| { ok: false; reason: "mail_storage_not_configured" };

const parseVersion = (raw: string | undefined, fallback: number): number => {
	const value = Number.parseInt((raw ?? "").trim(), 10);
	return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * Resolves the KEK ring. A missing or malformed current KEK closes third-party
 * credentials entirely instead of storing material that cannot be unsealed.
 */
export function resolveCredentialKeys(env: WhoYouEnv): CredentialKeys | null {
	const current = parseKek(env.MAIL_CREDENTIAL_KEK);
	if (!current) return null;
	const version = parseVersion(env.MAIL_CREDENTIAL_KEK_VERSION, 1);
	const previous = parseKek(env.MAIL_CREDENTIAL_KEK_PREVIOUS);
	const previousVersion = parseVersion(env.MAIL_CREDENTIAL_KEK_PREVIOUS_VERSION, 0);
	return {
		current: { version, kek: current },
		previous:
			previous && previousVersion > 0 && previousVersion !== version
				? { version: previousVersion, kek: previous }
				: null,
	};
}

export function createMailServices(env: WhoYouEnv): MailServicesResult {
	if (!env.DB || !env.MAIL_BUCKET) {
		return { ok: false, reason: "mail_storage_not_configured" };
	}
	const signingKey = (env.MAIL_SIGNING_KEY ?? "").trim();
	const mcpConfig = resolveMcpConfig(env);
	return {
		ok: true,
		services: {
			repository: new MailRepository(env.DB, env.MAIL_BUCKET),
			drafts: new DraftRepository(env.DB),
			limits: resolveMailLimits(env),
			domain: normalizeDomain(env.MAIL_DOMAIN ?? ""),
			signingKey: signingKey.length >= 32 ? signingKey : null,
			retention: resolveRetention(env),
			abuse: resolveAbusePolicy(env),
			resourceUrl: mcpConfig.ok ? mcpConfig.config.resourceUrl : null,
			credentials: new CredentialRepository(env.DB),
			credentialKeys: resolveCredentialKeys(env),
		},
	};
}
