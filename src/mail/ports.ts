/**
 * Platform ports for the mail service.
 *
 * Business code (`src/mail/*`, `src/mcp/*`) only depends on these narrow
 * structural contracts, so the same SQL, object-key and error semantics run on
 * SQLite/filesystem, on a D1/R2-compatible backend, or in tests. The shapes
 * intentionally mirror D1/R2 so the port keeps the semantics the queries were
 * written against.
 */

export type SqlResult = {
	results?: unknown[];
	meta: { changes?: number };
};

export interface SqlStatement {
	bind(...values: unknown[]): SqlStatement;
	first<T>(): Promise<T | null>;
	all<T>(): Promise<{ results: T[]; meta: { changes?: number } }>;
	run(): Promise<{ meta: { changes: number } }>;
}

export interface SqlDatabase {
	prepare(sql: string): SqlStatement;
	/** Runs the statements in one transaction and returns one result per statement. */
	batch(statements: SqlStatement[]): Promise<SqlResult[]>;
}

export type MailBucketGetResult = {
	body: ReadableStream;
	size: number;
};

export interface MailBucket {
	put(key: string, data: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
	get(key: string): Promise<MailBucketGetResult | null>;
	delete(keys: string | string[]): Promise<void>;
	head?(key: string): Promise<{ size: number } | null>;
}

/**
 * The inbound mail envelope a transport adapter must supply. It follows the
 * Cloudflare forwardable-message shape only in the fields the inbound pipeline
 * actually reads, and never exposes forward/reply capability.
 */
export interface InboundEmail {
	from: string;
	to: string;
	headers: Headers;
	raw: ReadableStream;
	rawSize: number;
	setReject(reason: string): void;
}
