import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlDatabase, SqlResult, SqlStatement } from "../mail/ports";

/** SQLite only binds numbers, strings, bigints, buffers and null. */
const normalize = (value: unknown): unknown => {
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value === undefined) return null;
	return value;
};

const MUTATION_SQL =
	/^(?:insert|update|delete|replace|create|alter|drop|pragma|vacuum|begin|commit|rollback|attach|detach|reindex|analyze)\b/i;

const firstKeyword = (sql: string): string => {
	let rest = sql.trimStart();
	while (rest.startsWith("--") || rest.startsWith("/*")) {
		if (rest.startsWith("--")) {
			const end = rest.indexOf("\n");
			if (end === -1) return "";
			rest = rest.slice(end + 1).trimStart();
		} else {
			const end = rest.indexOf("*/");
			if (end === -1) return "";
			rest = rest.slice(end + 2).trimStart();
		}
	}
	return rest;
};

const isMutation = (sql: string): boolean => MUTATION_SQL.test(firstKeyword(sql));

class SqliteStatement implements SqlStatement {
	private readonly params: unknown[];

	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		params: unknown[] = [],
	) {
		this.params = params;
	}

	bind(...values: unknown[]): SqlStatement {
		return new SqliteStatement(this.db, this.sql, values.map(normalize));
	}

	async first<T>(): Promise<T | null> {
		const row = this.statement().get(...(this.params as never[]));
		return (row as T | undefined) ?? null;
	}

	async all<T>(): Promise<{ results: T[]; meta: { changes?: number } }> {
		const rows = this.statement().all(...(this.params as never[])) as T[];
		return { results: rows, meta: { changes: 0 } };
	}

	async run(): Promise<{ meta: { changes: number } }> {
		const result = this.statement().run(...(this.params as never[]));
		return { meta: { changes: Number(result.changes) } };
	}

	/** Executes once and returns the D1-shaped batch entry. */
	execute(): SqlResult {
		const statement = this.statement();
		if (isMutation(this.sql)) {
			const result = statement.run(...(this.params as never[]));
			return { meta: { changes: Number(result.changes) } };
		}
		return {
			results: statement.all(...(this.params as never[])) as unknown[],
			meta: { changes: 0 },
		};
	}

	private statement(): StatementSync {
		return this.db.prepare(this.sql);
	}
}

/**
 * `SqlDatabase` adapter over Node's built-in synchronous SQLite driver.
 *
 * The driver is synchronous, so a batch's BEGIN/COMMIT can never be interleaved
 * by another request in the same process. WAL keeps a concurrent backup reader
 * (for example `sqlite3 .backup`) from blocking writes for long.
 */
export class SqliteDatabase implements SqlDatabase {
	readonly raw: DatabaseSync;

	constructor(filename: string) {
		if (filename !== ":memory:") {
			mkdirSync(path.dirname(filename), { recursive: true });
		}
		this.raw = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
		this.raw.exec("PRAGMA journal_mode = WAL");
		this.raw.exec("PRAGMA busy_timeout = 5000");
	}

	prepare(sql: string): SqlStatement {
		return new SqliteStatement(this.raw, sql);
	}

	async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
		this.raw.exec("BEGIN IMMEDIATE");
		try {
			const results = statements.map((statement) => {
				if (!(statement instanceof SqliteStatement)) {
					throw new Error("sqlite_batch_statement_mismatch");
				}
				return statement.execute();
			});
			this.raw.exec("COMMIT");
			return results;
		} catch (error) {
			this.raw.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.raw.close();
	}
}

export function createSqliteDatabase(filename: string): SqliteDatabase {
	return new SqliteDatabase(filename);
}
