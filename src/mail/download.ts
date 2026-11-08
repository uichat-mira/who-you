import type { WhoYouTokenVerifier } from "../mcp/auth";
import { createCloudAuthVerifier } from "../mcp/auth";
import {
	WHOYOU_REQUIRED_SCOPE,
	resolveMcpConfig,
	type McpEnv,
} from "../mcp/config";
import { createMailServices, type WhoYouEnv } from "./config";

/**
 * Short-lived, account-bound download links for attachments and export packages.
 *
 * A link is never a public object URL: it carries an HMAC over the account id,
 * the object reference and an absolute expiry, and the request must still carry
 * the caller's Cloud Auth bearer token. Forwarding the URL alone therefore grants
 * nothing, and the R2 key never appears in the URL or the tool output.
 */

export const MAIL_DOWNLOAD_PATH = "/mail/download";
/** Fixed 5-minute window; a longer `exp` is rejected as a forged link. */
export const SIGNED_DOWNLOAD_TTL_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 10_000;

export type DownloadKind = "attachment" | "export";

export type DownloadTarget = {
	kind: DownloadKind;
	/** Token-derived Cloud Account; the link is useless without that bearer. */
	accountId: string;
	id: string;
	/** Empty for export packages, which are mailbox-wide. */
	messageId: string;
	expiresAt: number;
};

export type DownloadSigner = {
	sign(target: DownloadTarget): Promise<string>;
	verify(target: DownloadTarget, signature: string): Promise<boolean>;
};

const encoder = new TextEncoder();

const canonicalTarget = (target: DownloadTarget): string =>
	[
		target.kind,
		target.accountId,
		target.id,
		target.messageId,
		String(target.expiresAt),
	].join("\n");

const base64UrlEncode = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const base64UrlDecode = (value: string): Uint8Array | null => {
	try {
		const padded = value.replaceAll("-", "+").replaceAll("_", "/");
		const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	} catch {
		return null;
	}
};

/**
 * Returns `null` when no usable key is configured. Callers must fail closed:
 * without a key there is no signed-download capability at all.
 */
export function createDownloadSigner(secret: string | null): DownloadSigner | null {
	const trimmed = secret?.trim() ?? "";
	if (trimmed.length < 32) return null;
	const key = crypto.subtle.importKey(
		"raw",
		encoder.encode(trimmed),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	return {
		async sign(target) {
			const signature = await crypto.subtle.sign(
				"HMAC",
				await key,
				encoder.encode(canonicalTarget(target)),
			);
			return base64UrlEncode(new Uint8Array(signature));
		},
		async verify(target, signature) {
			const bytes = base64UrlDecode(signature);
			if (!bytes) return false;
			return crypto.subtle.verify(
				"HMAC",
				await key,
				bytes,
				encoder.encode(canonicalTarget(target)),
			);
		},
	};
}

export function buildDownloadUrl(
	resourceUrl: URL,
	target: DownloadTarget,
	signature: string,
): string {
	const url = new URL(MAIL_DOWNLOAD_PATH, resourceUrl.origin);
	url.searchParams.set("kind", target.kind);
	url.searchParams.set("id", target.id);
	if (target.messageId) url.searchParams.set("messageId", target.messageId);
	url.searchParams.set("exp", String(target.expiresAt));
	url.searchParams.set("sig", signature);
	return url.href;
}

const jsonError = (status: number, error: string, headers: Record<string, string> = {}): Response =>
	Response.json({ error }, { status, headers });

const bearerToken = (request: Request): string | null => {
	const header = request.headers.get("authorization");
	if (!header) return null;
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	return match ? match[1] : null;
};

const contentDisposition = (filename: string): string => {
	const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

const readTarget = (url: URL): DownloadTarget | null => {
	const kind = url.searchParams.get("kind");
	const id = url.searchParams.get("id");
	const exp = Number(url.searchParams.get("exp"));
	if (kind !== "attachment" && kind !== "export") return null;
	if (!id || id.length > 120) return null;
	if (!Number.isInteger(exp)) return null;
	return {
		kind,
		accountId: "",
		id,
		messageId: url.searchParams.get("messageId") ?? "",
		expiresAt: exp,
	};
};

/**
 * Serves one signed object. The bearer decides the account, so even a correctly
 * signed link resolves only inside the caller's own mailbox.
 */
export async function handleSignedDownload(
	request: Request,
	env: WhoYouEnv,
	verifier: WhoYouTokenVerifier,
): Promise<Response> {
	if (request.method !== "GET") {
		return jsonError(405, "method_not_allowed", { Allow: "GET" });
	}

	const config = resolveMcpConfig(env);
	if (!config.ok) return jsonError(503, "download_not_configured");

	const url = new URL(request.url);
	if (url.origin !== config.config.resourceUrl.origin) {
		return jsonError(404, "not_found");
	}

	const token = bearerToken(request);
	if (!token) {
		return jsonError(401, "invalid_token", {
			"WWW-Authenticate": `Bearer realm="${config.config.resourceUrl.href}"`,
		});
	}
	let principal;
	try {
		principal = await verifier.verifyAccessToken(token);
	} catch {
		return jsonError(401, "invalid_token", {
			"WWW-Authenticate": `Bearer realm="${config.config.resourceUrl.href}"`,
		});
	}
	if (!principal.scopes.includes(WHOYOU_REQUIRED_SCOPE)) {
		return jsonError(403, "insufficient_scope");
	}

	const services = createMailServices(env);
	if (!services.ok) return jsonError(503, "mail_storage_not_configured");
	const signer = createDownloadSigner(services.services.signingKey);
	if (!signer) return jsonError(503, "download_signing_not_configured");

	const signature = url.searchParams.get("sig") ?? "";
	const target = readTarget(url);
	if (!target) return jsonError(400, "invalid_download_reference");

	target.accountId = principal.accountId;
	const now = Date.now();
	if (target.expiresAt <= now) return jsonError(410, "download_expired");
	if (target.expiresAt > now + SIGNED_DOWNLOAD_TTL_MS + MAX_CLOCK_SKEW_MS) {
		return jsonError(403, "invalid_signature");
	}
	if (!(await signer.verify(target, signature))) {
		return jsonError(403, "invalid_signature");
	}

	const repository = services.services.repository;

	if (target.kind === "attachment") {
		if (!target.messageId) return jsonError(400, "invalid_download_reference");
		const found = await repository.findAttachmentForDownload(
			principal.accountId,
			target.messageId,
			target.id,
		);
		if (!found) return jsonError(404, "attachment_not_found");
		if (found.state === "quarantined") return jsonError(409, "message_quarantined");
		const object = await repository.readObject(found.attachment.r2Key);
		if (!object) return jsonError(404, "attachment_unavailable");
		return objectResponse(object, found.attachment.mimeType, found.attachment.filename);
	}

	const record = await repository.findExport(principal.accountId, target.id);
	if (!record) return jsonError(404, "export_not_found");
	const object = await repository.readObject(record.r2Key);
	if (!object) return jsonError(404, "export_unavailable");
	return objectResponse(object, "application/zip", `who-you-export-${record.exportDay}.zip`);
}

const objectResponse = (
	object: { body: ReadableStream; size: number },
	contentType: string,
	filename: string,
): Response =>
	new Response(object.body, {
		status: 200,
		headers: {
			"content-type": contentType,
			"content-length": String(object.size),
			"content-disposition": contentDisposition(filename),
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});

/**
 * Production verifier for the download route. It is built from the same Cloud
 * Auth configuration as `/mcp`; a missing configuration closes the route.
 */
export function createDownloadVerifier(env: McpEnv & WhoYouEnv): WhoYouTokenVerifier | null {
	const resolved = resolveMcpConfig(env);
	if (!resolved.ok) return null;
	return createCloudAuthVerifier({
		issuer: resolved.config.tokenIssuer,
		audience: resolved.config.audience,
		jwksUrl: resolved.config.jwksUrl,
		consumerClaim: resolved.config.consumerClaim,
	});
}
