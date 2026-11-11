import { decodeBase64Url } from "./base64url";

/**
 * Minimal Gmail REST client for S7c. Only the five endpoints the identity
 * needs are implemented; every call takes an access token obtained for a single
 * execution and never persists it.
 */

export const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

export type GmailProfile = { emailAddress: string; historyId: string };

export type GmailMessageRef = { id: string; threadId: string };

export type GmailRawMessage = {
	id: string;
	threadId: string;
	internalDate: number | null;
	raw: Uint8Array;
};

export type GmailMessageList = {
	ids: string[];
	nextPageToken: string | null;
};

export type GmailHistoryPage = {
	historyId: string | null;
	messageIds: string[];
	nextPageToken: string | null;
};

export type GmailErrorCode =
	| "unauthorized"
	| "history_expired"
	| "provider_unreachable"
	| "provider_error";

export class GmailApiError extends Error {
	constructor(
		readonly code: GmailErrorCode,
		readonly status: number,
	) {
		super(code);
		this.name = "GmailApiError";
	}
}

export type GmailClient = {
	getProfile(accessToken: string): Promise<GmailProfile>;
	sendMessage(
		accessToken: string,
		input: { raw: string; threadId?: string },
	): Promise<GmailMessageRef>;
	listMessages(
		accessToken: string,
		input: { query?: string; maxResults?: number; pageToken?: string },
	): Promise<GmailMessageList>;
	getMessage(accessToken: string, id: string): Promise<GmailRawMessage>;
	listHistory(
		accessToken: string,
		input: { startHistoryId: string; maxResults?: number; pageToken?: string },
	): Promise<GmailHistoryPage>;
};

const asString = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

const messageRef = (payload: Record<string, unknown>): GmailMessageRef => {
	const id = asString(payload.id);
	const threadId = asString(payload.threadId) ?? id;
	if (!id) throw new GmailApiError("provider_error", 200);
	return { id, threadId: threadId as string };
};

export function createGmailClient(
	fetchImpl: typeof fetch = fetch,
	baseUrl: string = GMAIL_API_BASE_URL,
): GmailClient {
	const request = async (
		accessToken: string,
		path: string,
		init?: RequestInit,
	): Promise<Record<string, unknown>> => {
		let response: Response;
		try {
			response = await fetchImpl(`${baseUrl}${path}`, {
				...init,
				headers: {
					authorization: `Bearer ${accessToken}`,
					accept: "application/json",
					...(init?.headers ?? {}),
				},
			});
		} catch {
			throw new GmailApiError("provider_unreachable", 0);
		}

		let payload: Record<string, unknown> = {};
		try {
			const parsed = (await response.json()) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				payload = parsed as Record<string, unknown>;
			}
		} catch {
			payload = {};
		}

		if (response.ok) return payload;
		if (response.status === 401 || response.status === 403) {
			throw new GmailApiError("unauthorized", response.status);
		}
		if (response.status === 404) {
			// Gmail answers 404 when the supplied historyId has aged out.
			throw new GmailApiError(
				path.startsWith("/users/me/history") ? "history_expired" : "provider_error",
				404,
			);
		}
		throw new GmailApiError("provider_error", response.status);
	};

	return {
		async getProfile(accessToken): Promise<GmailProfile> {
			const payload = await request(accessToken, "/users/me/profile");
			const emailAddress = asString(payload.emailAddress);
			const historyId = asString(payload.historyId);
			if (!emailAddress || !historyId) throw new GmailApiError("provider_error", 200);
			return { emailAddress, historyId };
		},

		async sendMessage(accessToken, { raw, threadId }): Promise<GmailMessageRef> {
			const payload = await request(accessToken, "/users/me/messages/send", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
			});
			return messageRef(payload);
		},

		async listMessages(accessToken, { query, maxResults, pageToken }): Promise<GmailMessageList> {
			const params = new URLSearchParams();
			if (query) params.set("q", query);
			if (maxResults) params.set("maxResults", String(maxResults));
			if (pageToken) params.set("pageToken", pageToken);
			const suffix = params.toString() ? `?${params.toString()}` : "";
			const payload = await request(accessToken, `/users/me/messages${suffix}`);
			const messages = Array.isArray(payload.messages) ? payload.messages : [];
			const ids = messages
				.map((entry) =>
					entry && typeof entry === "object"
						? asString((entry as Record<string, unknown>).id)
						: null,
				)
				.filter((value): value is string => Boolean(value));
			return { ids, nextPageToken: asString(payload.nextPageToken) };
		},

		async getMessage(accessToken, id): Promise<GmailRawMessage> {
			const payload = await request(
				accessToken,
				`/users/me/messages/${encodeURIComponent(id)}?format=raw`,
			);
			const raw = asString(payload.raw);
			if (!raw) throw new GmailApiError("provider_error", 200);
			const internalDateRaw = asString(payload.internalDate);
			const internalDate = internalDateRaw ? Number.parseInt(internalDateRaw, 10) : null;
			const ref = messageRef(payload);
			return {
				...ref,
				internalDate: internalDate !== null && Number.isFinite(internalDate) ? internalDate : null,
				raw: decodeBase64Url(raw),
			};
		},

		async listHistory(accessToken, { startHistoryId, maxResults, pageToken }): Promise<GmailHistoryPage> {
			const params = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded" });
			if (maxResults) params.set("maxResults", String(maxResults));
			if (pageToken) params.set("pageToken", pageToken);
			const payload = await request(accessToken, `/users/me/history?${params.toString()}`);
			const ids = new Set<string>();
			const history = Array.isArray(payload.history) ? payload.history : [];
			for (const entry of history) {
				if (!entry || typeof entry !== "object") continue;
				const added = (entry as Record<string, unknown>).messagesAdded;
				if (!Array.isArray(added)) continue;
				for (const item of added) {
					if (!item || typeof item !== "object") continue;
					const message = (item as Record<string, unknown>).message;
					if (!message || typeof message !== "object") continue;
					const id = asString((message as Record<string, unknown>).id);
					if (id) ids.add(id);
				}
			}
			return {
				historyId: asString(payload.historyId),
				messageIds: [...ids],
				nextPageToken: asString(payload.nextPageToken),
			};
		},
	};
}
