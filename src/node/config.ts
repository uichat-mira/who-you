import path from "node:path";
import type { WhoYouEnv } from "../mail/config";
import type { MailSender } from "../mail/send";
import { createFilesystemBucket } from "./filesystem-bucket";
import type { InboundSmtpConfig } from "./smtp-inbound";
import { createSmtpMailSender } from "./smtp-sender";
import { createSqliteDatabase, type SqliteDatabase } from "./sqlite-database";

/**
 * Names read by the business layer (`resolveMcpConfig`, `createMailServices`,
 * `resolveMailLimits`, `resolveRetention`, `resolveAbusePolicy`) plus the
 * delivery webhook secret. Node-specific knobs use the `WHOYOU_` prefix.
 */
const MAIL_ENV_KEYS = [
	"MCP_RESOURCE_URL",
	"CLOUD_AUTH_ISSUER",
	"CLOUD_AUTH_JWKS_URL",
	"MCP_AUDIENCE",
	"MCP_REQUIRED_SCOPES",
	"MCP_CONSUMER_CLAIM",
	"MAIL_DOMAIN",
	"MAIL_SIGNING_KEY",
	"MAIL_INTERNAL_WEBHOOK_SECRET",
	"MAIL_MAX_RAW_BYTES",
	"MAIL_MAX_PART_COUNT",
	"MAIL_MAX_NESTING_DEPTH",
	"MAIL_MAX_HEADER_BYTES",
	"MAIL_MAX_ATTACHMENTS",
	"MAIL_MAX_ATTACHMENT_BYTES",
	"MAIL_MAILBOX_QUOTA_BYTES",
	"MAIL_BODY_MAX_CHARS",
	"MAIL_ATTACHMENT_INLINE_BYTES",
	"MAIL_EXPORT_MAX_MESSAGES",
	"MAIL_EXPORT_MAX_BYTES",
	"MAIL_RETENTION_AUDIT_DAYS",
	"MAIL_RETENTION_BOUNCE_DAYS",
	"MAIL_ABUSE_WINDOW_MINUTES",
	"MAIL_ABUSE_HARD_BOUNCE_COUNT",
	"MAIL_ABUSE_HARD_BOUNCE_RATIO_PERCENT",
	"MAIL_ABUSE_COMPLAINT_COUNT",
	"MAIL_ABUSE_EXTERNAL_RECIPIENT_COUNT",
] as const;

export type NodeRuntimeConfig = {
	env: WhoYouEnv;
	db: SqliteDatabase;
	dataDir: string;
	dbPath: string;
	migrationsDir: string;
	http: { host: string; port: number };
	sweepIntervalMs: number;
	inboundSmtp: InboundSmtpConfig | null;
	/** Whether an outbound relay was configured (never log credentials). */
	outboundRelayConfigured: boolean;
};

export type NodeConfigResult =
	| { ok: true; config: NodeRuntimeConfig }
	| { ok: false; reason: string };

const trim = (value: string | undefined): string => (value ?? "").trim();

const parsePort = (value: string, fallback: number): number | null => {
	if (value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
	return parsed;
};

const parsePositiveInt = (value: string, fallback: number): number => {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBoolean = (value: string): boolean =>
	["1", "true", "yes", "on"].includes(value.toLowerCase());

function pickMailEnv(source: NodeJS.ProcessEnv): Record<string, string> {
	const picked: Record<string, string> = {};
	for (const key of MAIL_ENV_KEYS) {
		const value = source[key];
		if (value !== undefined) picked[key] = value;
	}
	return picked;
}

/**
 * Assembles the platform env from `process.env`. Missing critical configuration
 * yields an explicit unconfigured result; the caller must not start half a
 * service. No secret is ever included in a reason string.
 */
export function resolveNodeConfig(source: NodeJS.ProcessEnv = process.env): NodeConfigResult {
	const dbPath = trim(source.WHOYOU_DB_PATH);
	if (dbPath === "") return { ok: false, reason: "missing_WHOYOU_DB_PATH" };
	const dataDir = trim(source.WHOYOU_DATA_DIR);
	if (dataDir === "") return { ok: false, reason: "missing_WHOYOU_DATA_DIR" };

	const httpPort = parsePort(trim(source.WHOYOU_HTTP_PORT), 8787);
	if (httpPort === null) return { ok: false, reason: "invalid_WHOYOU_HTTP_PORT" };

	const sweepIntervalMs = parsePositiveInt(
		trim(source.WHOYOU_SWEEP_INTERVAL_MS),
		60 * 60 * 1000,
	);

	const migrationsDir = trim(source.WHOYOU_MIGRATIONS_DIR)
		|| path.resolve(process.cwd(), "migrations");

	let inboundSmtp: InboundSmtpConfig | null = null;
	const inboundPortRaw = trim(source.WHOYOU_SMTP_INBOUND_PORT);
	const inboundHostRaw = trim(source.WHOYOU_SMTP_INBOUND_HOST);
	if (inboundPortRaw !== "" || inboundHostRaw !== "") {
		const port = parsePort(inboundPortRaw, 25);
		if (port === null) return { ok: false, reason: "invalid_WHOYOU_SMTP_INBOUND_PORT" };
		const certPath = trim(source.WHOYOU_SMTP_INBOUND_CERT_PATH);
		const keyPath = trim(source.WHOYOU_SMTP_INBOUND_KEY_PATH);
		if ((certPath === "") !== (keyPath === "")) {
			return { ok: false, reason: "incomplete_WHOYOU_SMTP_INBOUND_TLS" };
		}
		inboundSmtp = {
			host: inboundHostRaw || "127.0.0.1",
			port,
			maxBytes: parsePositiveInt(trim(source.MAIL_MAX_RAW_BYTES), 5 * 1024 * 1024),
			...(certPath === "" ? {} : { certPath, keyPath }),
		};
	}

	const relayHost = trim(source.WHOYOU_SMTP_HOST);
	let sender: MailSender | undefined;
	if (relayHost !== "") {
		const relayPort = parsePort(trim(source.WHOYOU_SMTP_PORT), 587);
		if (relayPort === null) return { ok: false, reason: "invalid_WHOYOU_SMTP_PORT" };
		const user = trim(source.WHOYOU_SMTP_USER);
		const pass = trim(source.WHOYOU_SMTP_PASS);
		if (user !== "" && pass === "") {
			return { ok: false, reason: "missing_WHOYOU_SMTP_PASS" };
		}
		const from = trim(source.WHOYOU_SMTP_FROM);
		sender = createSmtpMailSender({
			host: relayHost,
			port: relayPort,
			secure: parseBoolean(trim(source.WHOYOU_SMTP_SECURE)),
			...(user === "" ? {} : { user, pass }),
			...(from === "" ? {} : { from }),
		});
	}

	let db: SqliteDatabase;
	try {
		db = createSqliteDatabase(dbPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		return { ok: false, reason: `db_open_failed: ${message}` };
	}

	const env: WhoYouEnv = {
		...pickMailEnv(source),
		DB: db,
		MAIL_BUCKET: createFilesystemBucket(dataDir),
		...(sender === undefined ? {} : { MAIL_SENDER: sender }),
	} as WhoYouEnv;

	return {
		ok: true,
		config: {
			env,
			db,
			dataDir,
			dbPath,
			migrationsDir,
			http: { host: trim(source.WHOYOU_HTTP_HOST) || "127.0.0.1", port: httpPort },
			sweepIntervalMs,
			inboundSmtp,
			outboundRelayConfigured: sender !== undefined,
		},
	};
}
