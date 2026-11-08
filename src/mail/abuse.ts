import { positiveInt } from "./limits";

/**
 * S4 abuse policy.
 *
 * These thresholds are slice defaults chosen by this task card, not approved
 * product policy (product design §8.2 leaves them to a maintainer decision).
 * Every value is overridable through deployment bindings so the real numbers
 * can be set without a code change.
 */
export type AbuseLimitEnv = {
	MAIL_ABUSE_WINDOW_MINUTES?: string;
	MAIL_ABUSE_HARD_BOUNCE_COUNT?: string;
	MAIL_ABUSE_HARD_BOUNCE_RATIO_PERCENT?: string;
	MAIL_ABUSE_COMPLAINT_COUNT?: string;
	MAIL_ABUSE_EXTERNAL_RECIPIENT_COUNT?: string;
};

export type AbusePolicy = {
	windowMs: number;
	hardBounceCount: number;
	/** Fraction in (0, 1]; the binding is expressed as a percentage. */
	hardBounceRatio: number;
	complaintCount: number;
	externalRecipientCount: number;
};

export const DEFAULT_ABUSE_POLICY: AbusePolicy = {
	windowMs: 60 * 60 * 1000,
	hardBounceCount: 3,
	hardBounceRatio: 0.05,
	complaintCount: 2,
	externalRecipientCount: 200,
};

const minutesToMs = (minutes: number): number => minutes * 60 * 1000;

/**
 * A malformed percentage falls back to the default instead of silently
 * disabling the ratio rule or widening it to 1 (100%).
 */
const parseRatioPercent = (value: string | undefined, fallback: number): number => {
	if (!value) return fallback;
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return fallback;
	return parsed / 100;
};

export function resolveAbusePolicy(env: AbuseLimitEnv): AbusePolicy {
	return {
		windowMs: minutesToMs(
			positiveInt(env.MAIL_ABUSE_WINDOW_MINUTES, DEFAULT_ABUSE_POLICY.windowMs / 60_000),
		),
		hardBounceCount: positiveInt(
			env.MAIL_ABUSE_HARD_BOUNCE_COUNT,
			DEFAULT_ABUSE_POLICY.hardBounceCount,
		),
		hardBounceRatio: parseRatioPercent(
			env.MAIL_ABUSE_HARD_BOUNCE_RATIO_PERCENT,
			DEFAULT_ABUSE_POLICY.hardBounceRatio,
		),
		complaintCount: positiveInt(
			env.MAIL_ABUSE_COMPLAINT_COUNT,
			DEFAULT_ABUSE_POLICY.complaintCount,
		),
		externalRecipientCount: positiveInt(
			env.MAIL_ABUSE_EXTERNAL_RECIPIENT_COUNT,
			DEFAULT_ABUSE_POLICY.externalRecipientCount,
		),
	};
}

export type AbuseWindow = {
	sends: number;
	hardBounces: number;
	complaints: number;
	externalRecipients: number;
};

export type AbuseVerdict =
	| { pause: false; kind: null; detail: "" }
	| {
			pause: true;
			kind: "hard_bounce_rate" | "complaint_rate" | "external_volume";
			/** Counters only; never an address, subject or body. */
			detail: string;
	  };

/**
 * Pure decision function so the thresholds can be exercised without D1. Any
 * single trip wire pauses the whole account; resume is a human operation.
 */
export function evaluateAbuse(window: AbuseWindow, policy: AbusePolicy): AbuseVerdict {
	if (window.complaints >= policy.complaintCount) {
		return {
			pause: true,
			kind: "complaint_rate",
			detail: `complaints=${window.complaints};sends=${window.sends}`,
		};
	}
	if (window.externalRecipients >= policy.externalRecipientCount) {
		return {
			pause: true,
			kind: "external_volume",
			detail: `external_recipients=${window.externalRecipients};sends=${window.sends}`,
		};
	}
	if (
		window.sends > 0 &&
		window.hardBounces >= policy.hardBounceCount &&
		window.hardBounces / window.sends >= policy.hardBounceRatio
	) {
		return {
			pause: true,
			kind: "hard_bounce_rate",
			detail: `hard_bounces=${window.hardBounces};sends=${window.sends}`,
		};
	}
	return { pause: false, kind: null, detail: "" };
}
