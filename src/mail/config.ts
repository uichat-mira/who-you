import type { McpEnv } from "../mcp/config";
import { normalizeDomain } from "./address";
import {
	resolveMailLimits,
	type MailLimitEnv,
	type MailLimits,
} from "./limits";
import { MailRepository } from "./store";

/**
 * Deployed binding surface for this slice. Storage bindings are optional in the
 * type only so that misconfigured deployments fail closed at runtime instead of
 * failing typecheck; they are not optional for any mail-serving path.
 */
export type WhoYouEnv = McpEnv &
	MailLimitEnv & {
		DB?: D1Database;
		MAIL_BUCKET?: R2Bucket;
		MAIL_DOMAIN?: string;
	};

export type MailServices = {
	repository: MailRepository;
	limits: MailLimits;
	/** `null` when MAIL_DOMAIN is missing or invalid; inbound stays closed. */
	domain: string | null;
};

export type MailServicesResult =
	| { ok: true; services: MailServices }
	| { ok: false; reason: "mail_storage_not_configured" };

export function createMailServices(env: WhoYouEnv): MailServicesResult {
	if (!env.DB || !env.MAIL_BUCKET) {
		return { ok: false, reason: "mail_storage_not_configured" };
	}
	return {
		ok: true,
		services: {
			repository: new MailRepository(env.DB, env.MAIL_BUCKET),
			limits: resolveMailLimits(env),
			domain: normalizeDomain(env.MAIL_DOMAIN ?? ""),
		},
	};
}
