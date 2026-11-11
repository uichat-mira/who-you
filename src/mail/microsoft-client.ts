/**
 * Minimal Microsoft Graph client for S7d. Only the four endpoints the identity
 * needs are implemented; every call takes an access token obtained for a single
 * execution and never persists it.
 *
 * Sending uses the documented MIME path: create a draft from base64 MIME, then
 * send that draft. `POST /me/sendMail` would accept MIME too but answers 202
 * with no body, so it yields no provider message id to record in the receipt.
 */

export const GRAPH_API_BASE_URL = "https://graph.microsoft.com/v1.0";
export const GRAPH_HOST = "graph.microsoft.com";
export const GRAPH_DELTA_PAGE_SIZE = 20;

export type GraphMessageRef = { id: string };

export type GraphRawMessage = { id: string; raw: Uint8Array };

export type GraphDeltaMessage = { id: string; receivedAt: number | null };

export type GraphDeltaPage = {
	messages: GraphDeltaMessage[];
	nextLink: string | null;
	deltaLink: string | null;
};

export type GraphErrorCode =
	| "unauthorized"
	| "cursor_expired"
	| "provider_unreachable"
	| "provider_error";

export class GraphApiError extends Error {
	constructor(
		readonly code: GraphErrorCode,
		readonly status: number,
	) {
		super(code);
		this.name = "GraphApiError";
	}
}

export type GraphClient = {
	/** Creates a MIME draft and sends it; returns the provider message id. */
	sendMessage(accessToken: string, input: { rawBase64: string }): Promise<GraphMessageRef>;
	/** `GET /me/messages/{id}/$value` returns the raw RFC822 bytes. */
	getMessageMime(accessToken: string, id: string): Promise<GraphRawMessage>;
	/** One inbox delta page; pass `link` from a previous page, or `since` on the first call. */
	listInboxDelta(
		accessToken: string,
		input: { link?: string | null; since?: number },
	): Promise<GraphDeltaPage>;
};

const asString = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

/**
 * Delta pagination links are provider-supplied URLs. Only Graph itself may be
 * fetched, so a hostile or corrupted link cannot turn sync into an SSRF probe.
 */
const graphLink = (value: string): string => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new GraphApiError("provider_error", 0);
	}
	if (url.protocol !== "https:" || url.hostname !== GRAPH_HOST) {
		throw new GraphApiError("provider_error", 0);
	}
	return url.href;
};

/** Standard padded base64, which is what the Graph MIME endpoints expect. */
export const encodeMimeBase64 = (raw: string): string => {
	const bytes = new TextEncoder().encode(raw);
	let binary = "";
	for (let index = 0; index < bytes.length; index += 8192) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
	}
	return btoa(binary);
};

const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
	try {
		const payload = (await response.json()) as unknown;
		return payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
};

const errorFor = (status: number): GraphApiError => {
	if (status === 401 || status === 403) return new GraphApiError("unauthorized", status);
	// 410 Gone means the delta token aged out; the caller falls back to backfill.
	if (status === 410) return new GraphApiError("cursor_expired", status);
	return new GraphApiError("provider_error", status);
};

export function createGraphClient(
	fetchImpl: typeof fetch = fetch,
	baseUrl: string = GRAPH_API_BASE_URL,
): GraphClient {
	const request = async (
		accessToken: string,
		pathOrUrl: string,
		init?: RequestInit,
	): Promise<Record<string, unknown>> => {
		const url = pathOrUrl.startsWith("https://") ? graphLink(pathOrUrl) : `${baseUrl}${pathOrUrl}`;
		let response: Response;
		try {
			response = await fetchImpl(url, {
				...init,
				headers: {
					authorization: `Bearer ${accessToken}`,
					accept: "application/json",
					...(init?.headers ?? {}),
				},
			});
		} catch {
			throw new GraphApiError("provider_unreachable", 0);
		}
		const payload = await parseJson(response);
		if (!response.ok) throw errorFor(response.status);
		return payload;
	};

	return {
		async sendMessage(accessToken, { rawBase64 }): Promise<GraphMessageRef> {
			const draft = await request(accessToken, "/me/messages", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: rawBase64,
			});
			const id = asString(draft.id);
			if (!id) throw new GraphApiError("provider_error", 201);
			await request(accessToken, `/me/messages/${encodeURIComponent(id)}/send`, {
				method: "POST",
			});
			return { id };
		},

		async getMessageMime(accessToken, id): Promise<GraphRawMessage> {
			let response: Response;
			const url = `${baseUrl}/me/messages/${encodeURIComponent(id)}/$value`;
			try {
				response = await fetchImpl(url, {
					headers: {
						authorization: `Bearer ${accessToken}`,
						accept: "message/rfc822",
					},
				});
			} catch {
				throw new GraphApiError("provider_unreachable", 0);
			}
			if (!response.ok) throw errorFor(response.status);
			const buffer = await response.arrayBuffer();
			return { id, raw: new Uint8Array(buffer) };
		},

		async listInboxDelta(accessToken, { link, since }): Promise<GraphDeltaPage> {
			let url: string;
			if (link) {
				url = graphLink(link);
			} else {
				const initial = new URL(`${baseUrl}/me/mailFolders/inbox/messages/delta`);
				initial.searchParams.set("$select", "id,internetMessageId,receivedDateTime");
				initial.searchParams.set("$top", String(GRAPH_DELTA_PAGE_SIZE));
				if (since !== undefined) {
					initial.searchParams.set(
						"$filter",
						`receivedDateTime ge ${new Date(since).toISOString()}`,
					);
				}
				url = initial.href;
			}

			const payload = await request(accessToken, url, {
				headers: { prefer: `odata.maxpagesize=${GRAPH_DELTA_PAGE_SIZE}` },
			});

			const messages: GraphDeltaMessage[] = [];
			const values = Array.isArray(payload.value) ? payload.value : [];
			for (const entry of values) {
				if (!entry || typeof entry !== "object") continue;
				const record = entry as Record<string, unknown>;
				// Delta rounds include tombstones for deleted messages; sync never
				// mirrors deletions, so they are ignored.
				if (record["@removed"] !== undefined) continue;
				const id = asString(record.id);
				if (!id) continue;
				const received = asString(record.receivedDateTime);
				const parsed = received ? Date.parse(received) : Number.NaN;
				messages.push({
					id,
					receivedAt: Number.isFinite(parsed) ? parsed : null,
				});
			}

			const nextLink = asString(payload["@odata.nextLink"]);
			const deltaLink = asString(payload["@odata.deltaLink"]);
			return {
				messages,
				nextLink: nextLink ? graphLink(nextLink) : null,
				deltaLink: deltaLink ? graphLink(deltaLink) : null,
			};
		},
	};
}
