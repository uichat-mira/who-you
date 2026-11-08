/**
 * Provisional S1 mail limits.
 *
 * These are policy ceilings chosen by this slice, not verified Cloudflare
 * Email Routing platform facts. Product design §10 #3 and §11 #4 still own the
 * real platform limits and product defaults; every value here is overridable
 * through deployment bindings so the gap can be closed without a code change.
 */
export type MailLimitEnv = {
	MAIL_MAX_RAW_BYTES?: string;
	MAIL_MAX_PART_COUNT?: string;
	MAIL_MAX_NESTING_DEPTH?: string;
	MAIL_MAX_HEADER_BYTES?: string;
	MAIL_MAX_ATTACHMENTS?: string;
	MAIL_MAX_ATTACHMENT_BYTES?: string;
	MAIL_MAILBOX_QUOTA_BYTES?: string;
	MAIL_BODY_MAX_CHARS?: string;
	MAIL_ATTACHMENT_INLINE_BYTES?: string;
	MAIL_EXPORT_MAX_MESSAGES?: string;
	MAIL_EXPORT_MAX_BYTES?: string;
};

export type MailLimits = {
	maxRawBytes: number;
	maxPartCount: number;
	maxNestingDepth: number;
	maxHeaderBytes: number;
	maxAttachments: number;
	maxAttachmentBytes: number;
	mailboxQuotaBytes: number;
	bodyMaxChars: number;
	attachmentInlineBytes: number;
	exportMaxMessages: number;
	exportMaxBytes: number;
};

export const DEFAULT_MAIL_LIMITS: MailLimits = {
	maxRawBytes: 5 * 1024 * 1024,
	maxPartCount: 64,
	maxNestingDepth: 8,
	maxHeaderBytes: 1024 * 1024,
	maxAttachments: 20,
	maxAttachmentBytes: 5 * 1024 * 1024,
	mailboxQuotaBytes: 256 * 1024 * 1024,
	bodyMaxChars: 200_000,
	attachmentInlineBytes: 256 * 1024,
	exportMaxMessages: 1000,
	exportMaxBytes: 25 * 1024 * 1024,
};

const positiveInt = (value: string | undefined, fallback: number): number => {
	if (!value) return fallback;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
};

/**
 * Invalid numeric bindings fall back to the safe, smaller default instead of
 * silently disabling a limit.
 */
export function resolveMailLimits(env: MailLimitEnv): MailLimits {
	return {
		maxRawBytes: positiveInt(env.MAIL_MAX_RAW_BYTES, DEFAULT_MAIL_LIMITS.maxRawBytes),
		maxPartCount: positiveInt(env.MAIL_MAX_PART_COUNT, DEFAULT_MAIL_LIMITS.maxPartCount),
		maxNestingDepth: positiveInt(
			env.MAIL_MAX_NESTING_DEPTH,
			DEFAULT_MAIL_LIMITS.maxNestingDepth,
		),
		maxHeaderBytes: positiveInt(
			env.MAIL_MAX_HEADER_BYTES,
			DEFAULT_MAIL_LIMITS.maxHeaderBytes,
		),
		maxAttachments: positiveInt(
			env.MAIL_MAX_ATTACHMENTS,
			DEFAULT_MAIL_LIMITS.maxAttachments,
		),
		maxAttachmentBytes: positiveInt(
			env.MAIL_MAX_ATTACHMENT_BYTES,
			DEFAULT_MAIL_LIMITS.maxAttachmentBytes,
		),
		mailboxQuotaBytes: positiveInt(
			env.MAIL_MAILBOX_QUOTA_BYTES,
			DEFAULT_MAIL_LIMITS.mailboxQuotaBytes,
		),
		bodyMaxChars: positiveInt(env.MAIL_BODY_MAX_CHARS, DEFAULT_MAIL_LIMITS.bodyMaxChars),
		attachmentInlineBytes: positiveInt(
			env.MAIL_ATTACHMENT_INLINE_BYTES,
			DEFAULT_MAIL_LIMITS.attachmentInlineBytes,
		),
		exportMaxMessages: positiveInt(
			env.MAIL_EXPORT_MAX_MESSAGES,
			DEFAULT_MAIL_LIMITS.exportMaxMessages,
		),
		exportMaxBytes: positiveInt(env.MAIL_EXPORT_MAX_BYTES, DEFAULT_MAIL_LIMITS.exportMaxBytes),
	};
}
