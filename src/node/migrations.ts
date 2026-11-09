import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** Splits the simple, comment-only SQL files this project ships. */
export function splitStatements(sql: string): string[] {
	const body = sql
		.split(/\r?\n/)
		.filter((line) => !line.trimStart().startsWith("--"))
		.join("\n");
	return body
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

export function listMigrationFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		throw new Error(`migrations_dir_not_found: ${dir}`);
	}
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Applies every not-yet-recorded migration in filename order.
 *
 * Each file and its `schema_migrations` row commit in one transaction, so a
 * crash mid-file leaves the database exactly at the previous applied version.
 */
export function runMigrations(db: DatabaseSync, dir: string): string[] {
	db.exec(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			filename TEXT PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)`,
	);

	const applied = new Set(
		(db.prepare("SELECT filename FROM schema_migrations").all() as Array<{
			filename: string;
		}>).map((row) => row.filename),
	);
	const files = listMigrationFiles(dir);
	const freshlyApplied: string[] = [];

	for (const file of files) {
		if (applied.has(file)) continue;
		const statements = splitStatements(readFileSync(path.join(dir, file), "utf8"));
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const statement of statements) {
				db.exec(statement);
			}
			db.prepare(
				"INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)",
			).run(file, Date.now());
			db.exec("COMMIT");
			freshlyApplied.push(file);
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	return freshlyApplied;
}
