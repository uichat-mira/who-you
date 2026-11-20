/** Deterministic SHA-256 helper used for message ids, cursors and dedupe fallbacks. */
export async function sha256Hex(
	value: ArrayBuffer | Uint8Array | string,
): Promise<string> {
	const bytes =
		typeof value === "string"
			? new TextEncoder().encode(value)
			: value instanceof Uint8Array
				? value
				: new Uint8Array(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
