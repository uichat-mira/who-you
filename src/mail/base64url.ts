/**
 * Unpadded base64url helpers. Used for PKCE values, Gmail `raw` payloads and
 * opaque cursors; every entry point is deterministic and dependency-free.
 */

const bytesToBinary = (bytes: Uint8Array): string => {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 8192) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
	}
	return binary;
};

export const encodeBase64Url = (value: Uint8Array | string): string => {
	const bytes =
		typeof value === "string" ? new TextEncoder().encode(value) : value;
	return btoa(bytesToBinary(bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
};

export const decodeBase64Url = (value: string): Uint8Array => {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
};

export const decodeBase64UrlText = (value: string): string =>
	new TextDecoder().decode(decodeBase64Url(value));
