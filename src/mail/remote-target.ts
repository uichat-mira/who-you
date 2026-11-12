/**
 * Syntax-level validation for a user-supplied IMAP/SMTP endpoint (S7e).
 *
 * Cloudflare Workers only accepts hostnames, and its `remoteAddress` is a
 * `hostname:port` string rather than a peer IP, so CIDR checks are impossible
 * inside the Worker. The contract therefore treats DNS rebinding as accepted
 * risk R1 and relies on this pure function plus the port allowlist and forced
 * TLS as compensating controls. No DNS lookup happens here.
 */

export type RemoteProtocol = "imap" | "smtp";
export type RemoteTransport = "implicit" | "starttls";
export type RemoteTarget = { host: string; port: number; tls: RemoteTransport };

export type RemoteTargetResult =
	| { ok: true; target: RemoteTarget }
	| { ok: false; code: "host_invalid" | "port_not_allowed" };

const FORBIDDEN_HOST_CHARS = new Set(["@", "/", "?", "#", ":", "[", "]", "\\"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"];
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const MAX_IMAP_STRING_BYTES = 1024;

const isAsciiHostChar = (char: string): boolean => {
	const code = char.charCodeAt(0);
	if (code > 127 || code < 33) return false;
	return !FORBIDDEN_HOST_CHARS.has(char);
};

const isNumericLabel = (label: string): boolean => {
	if (!label) return false;
	if (label.startsWith("0x") || label.startsWith("0X")) {
		return /^[0-9a-fA-F]+$/.test(label.slice(2));
	}
	return /^[0-9]+$/.test(label);
};

/**
 * Rejects every textual IPv4/IPv6/int form: dotted quads, decimal/octal/hex
 * integers, and IPv6 written with or without brackets.
 */
const looksLikeIpLiteral = (host: string): boolean => {
	if (host.startsWith("::") || host.includes("::")) return true;
	const labels = host.split(".");
	if (labels.length === 1) return isNumericLabel(host);
	if (labels.length === 4 && labels.every(isNumericLabel)) return true;
	// Any all-numeric dotted form is an IP variant even when it is not 4 labels.
	return labels.length > 1 && labels.every(isNumericLabel);
};

const isBlockedHostname = (host: string): boolean => {
	if (host === "localhost") return true;
	return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
};

const isValidHostname = (host: string): boolean => {
	if (!host || host.length > MAX_HOST_LENGTH) return false;
	if (looksLikeIpLiteral(host) || isBlockedHostname(host)) return false;
	for (const char of host) {
		if (!isAsciiHostChar(char)) return false;
	}
	for (const label of host.split(".")) {
		if (!label || label.length > MAX_LABEL_LENGTH) return false;
		if (label.startsWith("-") || label.endsWith("-")) return false;
		if (label.includes("_")) return false;
	}
	return true;
};

const resolvePort = (
	protocol: RemoteProtocol,
	port: number,
	allowImap143: boolean,
): RemoteTransport | null => {
	if (protocol === "imap") {
		if (port === 993) return "implicit";
		if (port === 143 && allowImap143) return "starttls";
		return null;
	}
	if (port === 465) return "implicit";
	if (port === 587) return "starttls";
	return null;
};

export function validateRemoteTarget(input: {
	protocol: RemoteProtocol;
	host: string;
	port: number;
	allowImap143?: boolean;
}): RemoteTargetResult {
	const host = input.host.trim().toLowerCase();
	if (!isValidHostname(host)) return { ok: false, code: "host_invalid" };
	const tls = resolvePort(input.protocol, input.port, input.allowImap143 === true);
	if (!tls) return { ok: false, code: "port_not_allowed" };
	return { ok: true, target: { host, port: input.port, tls } };
}

/**
 * Encodes one IMAP argument as a quoted string. CR/LF would allow command
 * injection and an oversized mailbox name would let a caller exhaust the
 * response budget, so both fail closed.
 */
export function quoteImapString(value: string): string | null {
	if (value.includes("\r") || value.includes("\n")) return null;
	if (new TextEncoder().encode(value).byteLength > MAX_IMAP_STRING_BYTES) return null;
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}
