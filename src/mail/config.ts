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
		 * HMAC key for short-lived attachment/export links. Absent or shorter
		 * than 32 characters closes the signed-download capability entirely.
		 */
		MAIL_SIGNING_KEY?: string;
		/**
		 * HMAC key for the internal relay delivery callback. Absent or shorter
		 * than 32 characters closes the callback entirely (503, fail-closed).
		 */
		MAIL_INTERNAL_WEBHOOK_SECRET?: string;
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
};

export type MailServicesResult =
	| { ok: true; services: MailServices }
	| { ok: false; reason: "mail_storage_not_configured" };

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
		},
	};
}
