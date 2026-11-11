/**
 * Envelope encryption for third-party mailbox credentials.
 *
 * Secrets are sealed with a per-identity data key (DEK); the DEK is wrapped with
 * the deployment key (KEK, Worker secret `MAIL_CREDENTIAL_KEK`). Each encryption
 * binds context through AES-GCM additional data so a ciphertext cannot be moved
 * to another account, identity or credential slot.
 *
 * The AAD never contains `key_version`: rotating the KEK only rewrites the
 * wrapped DEK, and the sealed secret must stay readable across rotations.
 */

const textEncoder = new TextEncoder();

const toBase64 = (bytes: ArrayBuffer | Uint8Array): string => {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (let index = 0; index < view.length; index += 8192) {
		binary += String.fromCharCode(...view.subarray(index, index + 8192));
	}
	return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
};

export const CREDENTIAL_KEK_BYTES = 32;

/** Parses a base64 KEK; anything that is not exactly 32 bytes is rejected. */
export function parseKek(raw: string | undefined | null): Uint8Array | null {
	const value = (raw ?? "").trim();
	if (!value) return null;
	try {
		const bytes = fromBase64(value);
		return bytes.length === CREDENTIAL_KEK_BYTES ? bytes : null;
	} catch {
		return null;
	}
}

export type CredentialAadInput = {
	accountId: string;
	provider: string;
	mailboxId: string;
	dekId: string;
	credentialType: string;
};

/**
 * Binds a sealed secret to one identity slot. Kept as a pure function so the
 * exact string can be asserted in tests and audited for drift.
 */
export const credentialAad = (input: CredentialAadInput): string =>
	[
		input.accountId,
		input.provider,
		input.mailboxId,
		input.dekId,
		input.credentialType,
	].join("|");

/** Binds a wrapped DEK to its account and DEK id (not to the KEK version). */
export const dekWrapAad = (accountId: string, dekId: string): string =>
	`dek|${accountId}|${dekId}`;

export type SealedSecret = {
	dekId: string;
	wrappedDek: string;
	wrapNonce: string;
	ciphertext: string;
	nonce: string;
};

export class CredentialCryptoError extends Error {
	constructor(
		readonly code: "dek_unwrap_failed" | "secret_open_failed" | "envelope_invalid",
	) {
		super(code);
		this.name = "CredentialCryptoError";
	}
}

const importKek = (
	kek: Uint8Array,
	usage: Array<"encrypt" | "decrypt">,
): Promise<CryptoKey> => crypto.subtle.importKey("raw", kek, { name: "AES-GCM" }, false, usage);

const randomBytes = (length: number): Uint8Array =>
	crypto.getRandomValues(new Uint8Array(length));

const newDekId = (): string => `dek_${crypto.randomUUID().replace(/-/g, "")}`;

/**
 * Generates a DEK, wraps it with the KEK and seals `secret` with it.
 * Returns only base64 material; the raw DEK never leaves this function.
 */
export async function sealSecret(
	kek: Uint8Array,
	secret: string,
	input: Omit<CredentialAadInput, "dekId">,
): Promise<SealedSecret> {
	const dekId = newDekId();
	const dek = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
		"encrypt",
		"decrypt",
	])) as CryptoKey;
	const dekRaw = new Uint8Array(
		(await crypto.subtle.exportKey("raw", dek)) as ArrayBuffer,
	);

	const wrapNonce = randomBytes(12);
	const wrappedDek = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: wrapNonce,
			additionalData: textEncoder.encode(dekWrapAad(input.accountId, dekId)),
		},
		await importKek(kek, ["encrypt"]),
		dekRaw,
	);

	const nonce = randomBytes(12);
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: nonce,
			additionalData: textEncoder.encode(credentialAad({ ...input, dekId })),
		},
		dek,
		textEncoder.encode(secret),
	);

	return {
		dekId,
		wrappedDek: toBase64(wrappedDek),
		wrapNonce: toBase64(wrapNonce),
		ciphertext: toBase64(ciphertext),
		nonce: toBase64(nonce),
	};
}

async function openDek(
	kek: Uint8Array,
	envelope: Pick<SealedSecret, "dekId" | "wrappedDek" | "wrapNonce">,
	accountId: string,
): Promise<CryptoKey> {
	try {
		const raw = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: fromBase64(envelope.wrapNonce),
				additionalData: textEncoder.encode(dekWrapAad(accountId, envelope.dekId)),
			},
			await importKek(kek, ["decrypt"]),
			fromBase64(envelope.wrappedDek),
		);
		// Extractable so rotation can re-wrap this DEK without the secret.
		return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
			"decrypt",
		]);
	} catch {
		throw new CredentialCryptoError("dek_unwrap_failed");
	}
}

/** Opens a sealed secret; every failure is a typed crypto error, never plaintext. */
export async function openSecret(
	kek: Uint8Array,
	envelope: SealedSecret,
	input: CredentialAadInput,
): Promise<string> {
	if (!envelope.ciphertext || !envelope.nonce) {
		throw new CredentialCryptoError("envelope_invalid");
	}
	const dek = await openDek(kek, envelope, input.accountId);
	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: fromBase64(envelope.nonce),
				additionalData: textEncoder.encode(credentialAad(input)),
			},
			dek,
			fromBase64(envelope.ciphertext),
		);
		return new TextDecoder().decode(plaintext);
	} catch {
		throw new CredentialCryptoError("secret_open_failed");
	}
}

/**
 * Re-wraps the DEK under a new KEK. The sealed secret is untouched, which is
 * what makes key rotation a metadata-only operation.
 */
export async function rewrapDek(
	previousKek: Uint8Array,
	nextKek: Uint8Array,
	envelope: Pick<SealedSecret, "dekId" | "wrappedDek" | "wrapNonce">,
	accountId: string,
): Promise<{ wrappedDek: string; wrapNonce: string }> {
	const dek = await openDek(previousKek, envelope, accountId);
	const raw = (await crypto.subtle.exportKey("raw", dek)) as ArrayBuffer;
	const wrapNonce = randomBytes(12);
	const wrapped = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: wrapNonce,
			additionalData: textEncoder.encode(dekWrapAad(accountId, envelope.dekId)),
		},
		await importKek(nextKek, ["encrypt"]),
		raw,
	);
	return { wrappedDek: toBase64(wrapped), wrapNonce: toBase64(wrapNonce) };
}

export const base64Bytes = fromBase64;
export const bytesBase64 = toBase64;
