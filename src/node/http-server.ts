import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { handleRequest } from "../app";
import type { WhoYouEnv } from "../mail/config";
import type { SqlDatabase } from "../mail/ports";

export type HttpServerConfig = {
	host: string;
	port: number;
	env: WhoYouEnv;
	db: SqlDatabase;
};

const requestHeaders = (incoming: IncomingMessage): Headers => {
	const headers = new Headers();
	for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
		headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
	}
	return headers;
};

const hasBody = (method: string): boolean => method !== "GET" && method !== "HEAD";

/**
 * Converts the Node request into a standard `Request`. A stream body needs
 * `duplex: "half"` in undici; without it real MCP POST bodies would throw.
 */
export function toWebRequest(incoming: IncomingMessage, host: string, port: number): Request {
	const protocol = (incoming.headers["x-forwarded-proto"] as string | undefined) ?? "http";
	const requestHost = incoming.headers.host ?? `${host}:${port}`;
	const url = new URL(incoming.url ?? "/", `${protocol}://${requestHost}`);
	const init: RequestInit & { duplex?: "half" } = {
		method: incoming.method ?? "GET",
		headers: requestHeaders(incoming),
	};
	if (hasBody(init.method ?? "")) {
		init.body = Readable.toWeb(incoming) as unknown as ReadableStream;
		init.duplex = "half";
	}
	return new Request(url, init);
}

async function writeWebResponse(response: Response, outgoing: ServerResponse): Promise<void> {
	outgoing.statusCode = response.status;
	response.headers.forEach((value, name) => {
		outgoing.setHeader(name, value);
	});
	const cookies = response.headers.getSetCookie?.() ?? [];
	if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);

	if (response.body === null || response.body === undefined) {
		outgoing.end();
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const body = Readable.fromWeb(response.body as never);
		body.on("error", reject);
		outgoing.on("close", resolve);
		outgoing.on("finish", resolve);
		body.pipe(outgoing);
	});
}

async function healthResponse(db: SqlDatabase): Promise<Response> {
	try {
		const row = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
		if (row?.ok !== 1) {
			return Response.json({ status: "error", db: "unreadable" }, { status: 503 });
		}
		return Response.json({ status: "ok", db: "ok" });
	} catch {
		return Response.json({ status: "error", db: "unreadable" }, { status: 503 });
	}
}

/**
 * Node HTTP transport. `/health` is the only process-local endpoint; every
 * other route is the unchanged platform-independent handler, including `/mcp`,
 * its discovery metadata, `/mail/download` and `/internal/delivery`.
 */
export function createHttpServer(config: HttpServerConfig): Server {
	return createServer((incoming, outgoing) => {
		void (async () => {
			try {
				const url = new URL(
					incoming.url ?? "/",
					`http://${incoming.headers.host ?? `${config.host}:${config.port}`}`,
				);
				if (url.pathname === "/health" && (incoming.method === "GET" || incoming.method === "HEAD")) {
					await writeWebResponse(await healthResponse(config.db), outgoing);
					return;
				}
				const request = toWebRequest(incoming, config.host, config.port);
				await writeWebResponse(await handleRequest(request, config.env), outgoing);
			} catch (error) {
				const message = error instanceof Error ? error.message : "internal error";
				console.log(JSON.stringify({ event: "whoyou_http_error", error: message }));
				if (!outgoing.headersSent) {
					outgoing.statusCode = 500;
					outgoing.setHeader("content-type", "application/json; charset=utf-8");
				}
				outgoing.end(JSON.stringify({ error: "internal_error" }));
			}
		})();
	});
}

export function listenHttpServer(server: Server, host: string, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			const address = server.address();
			resolve(typeof address === "object" && address !== null ? address.port : port);
		});
	});
}

export function closeHttpServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
