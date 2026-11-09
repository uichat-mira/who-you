import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { MailBucket } from "../mail/ports";

const OBJECTS_DIR = "objects";

/** Rejects absolute, traversal and Windows-specific key shapes outright. */
function assertSafeKey(key: string): string[] {
	if (!key || key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
		throw new Error("invalid_object_key");
	}
	const segments = key.split("/");
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === ".." || segment.includes(":")) {
			throw new Error("invalid_object_key");
		}
	}
	return segments;
}

export function bucketRoot(dataDir: string): string {
	return path.join(dataDir, OBJECTS_DIR);
}

/** Absolute on-disk path for a validated object key. */
export function objectPath(dataDir: string, key: string): string {
	return path.join(bucketRoot(dataDir), ...assertSafeKey(key));
}

/** Walk the object tree and return keys in lexical order (test/backup helper). */
export function listObjectKeys(dataDir: string, prefix = ""): string[] {
	const root = bucketRoot(dataDir);
	const keys: string[] = [];

	const walk = (dir: string, relative: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				walk(path.join(dir, entry.name), childRelative);
			} else if (entry.isFile() && childRelative.startsWith(prefix)) {
				keys.push(childRelative);
			}
		}
	};

	walk(root, "");
	return keys.sort((a, b) => a.localeCompare(b));
}

export class FilesystemBucket implements MailBucket {
	constructor(private readonly dataDir: string) {
		mkdirSync(bucketRoot(dataDir), { recursive: true });
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		const target = objectPath(this.dataDir, key);
		mkdirSync(path.dirname(target), { recursive: true });
		const temporary = `${target}.tmp-${randomUUID()}`;
		try {
			writeFileSync(temporary, data);
			renameSync(temporary, target);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}

	async get(key: string): Promise<{ body: ReadableStream; size: number } | null> {
		const target = objectPath(this.dataDir, key);
		let size: number;
		try {
			const stats = statSync(target);
			if (!stats.isFile()) return null;
			size = stats.size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		const body = Readable.toWeb(createReadStream(target)) as unknown as ReadableStream;
		return { body, size };
	}

	async delete(keys: string | string[]): Promise<void> {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			rmSync(objectPath(this.dataDir, key), { force: true });
		}
	}

	async head(key: string): Promise<{ size: number } | null> {
		try {
			const stats = statSync(objectPath(this.dataDir, key));
			return stats.isFile() ? { size: stats.size } : null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
}

export function createFilesystemBucket(dataDir: string): FilesystemBucket {
	return new FilesystemBucket(dataDir);
}
