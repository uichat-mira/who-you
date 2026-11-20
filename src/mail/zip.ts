/**
 * Minimal store-only ZIP writer for user data exports.
 *
 * No compression and no external dependency: every entry is a whole file, which
 * keeps the archive byte-deterministic for a fixed input and avoids adding a
 * ZIP library to a security-sensitive path. CRC-32 and the archive structure
 * follow PKWARE APPNOTE 4.4 (local header, central directory, end record).
 */

export type ZipEntry = { name: string; bytes: Uint8Array };

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

const crc32 = (bytes: Uint8Array): number => {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
};

/** Fixed DOS timestamp so the same input always produces the same archive. */
const DOS_TIME = 0;
/** 1980-01-01 in DOS date encoding: year 0, month 1, day 1. */
const DOS_DATE = 0x21;

const writeUint16 = (target: number[], value: number): void => {
	target.push(value & 0xff, (value >>> 8) & 0xff);
};

const writeUint32 = (target: number[], value: number): void => {
	target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
};

const textBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const entryName = (entry: ZipEntry): string =>
	entry.name.replace(/^\/+/, "").replace(/\\/g, "/");

export class ZipArchive {
	private readonly entries: ZipEntry[] = [];
	private readonly seen = new Set<string>();

	add(name: string, bytes: Uint8Array): void {
		const normalized = name.replace(/^\/+/, "").replace(/\\/g, "/");
		if (!normalized || this.seen.has(normalized)) {
			throw new Error(`duplicate or empty zip entry: ${normalized}`);
		}
		this.seen.add(normalized);
		this.entries.push({ name: normalized, bytes });
	}

	/** Adds the implicit directory entries so common unzip tools show a tree. */
	addParentDirectories(): void {
		const directories = new Set<string>();
		for (const entry of this.entries) {
			const parts = entryName(entry).split("/");
			for (let index = 1; index < parts.length; index += 1) {
				directories.add(`${parts.slice(0, index).join("/")}/`);
			}
		}
		const sorted = [...directories].sort((left, right) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		for (const directory of sorted) {
			if (this.seen.has(directory)) continue;
			this.seen.add(directory);
			this.entries.push({ name: directory, bytes: new Uint8Array(0) });
		}
	}

	build(): Uint8Array {
		const localParts: number[] = [];
		const centralParts: number[] = [];
		let offset = 0;

		for (const entry of this.entries) {
			const nameBytes = textBytes(entry.name);
			const crc = crc32(entry.bytes);
			const size = entry.bytes.byteLength;
			// Bit 11 declares UTF-8 names; no data descriptor (sizes are known).
			const flags = 0x0800;

			const localOffset = offset;
			writeUint32(localParts, 0x04034b50);
			writeUint16(localParts, 20);
			writeUint16(localParts, flags);
			writeUint16(localParts, 0);
			writeUint16(localParts, DOS_TIME);
			writeUint16(localParts, DOS_DATE);
			writeUint32(localParts, crc);
			writeUint32(localParts, size);
			writeUint32(localParts, size);
			writeUint16(localParts, nameBytes.byteLength);
			writeUint16(localParts, 0);
			localParts.push(...nameBytes, ...entry.bytes);
			offset += 30 + nameBytes.byteLength + size;

			writeUint32(centralParts, 0x02014b50);
			writeUint16(centralParts, 20);
			writeUint16(centralParts, 20);
			writeUint16(centralParts, flags);
			writeUint16(centralParts, 0);
			writeUint16(centralParts, DOS_TIME);
			writeUint16(centralParts, DOS_DATE);
			writeUint32(centralParts, crc);
			writeUint32(centralParts, size);
			writeUint32(centralParts, size);
			writeUint16(centralParts, nameBytes.byteLength);
			writeUint16(centralParts, 0);
			writeUint16(centralParts, 0);
			writeUint16(centralParts, 0);
			writeUint16(centralParts, 0);
			writeUint32(centralParts, 0);
			writeUint32(centralParts, localOffset);
			centralParts.push(...nameBytes);
		}

		const centralSize = centralParts.length;
		const centralOffset = offset;
		writeUint32(centralParts, 0x06054b50);
		writeUint16(centralParts, 0);
		writeUint16(centralParts, 0);
		writeUint16(centralParts, this.entries.length);
		writeUint16(centralParts, this.entries.length);
		writeUint32(centralParts, centralSize);
		writeUint32(centralParts, centralOffset);
		writeUint16(centralParts, 0);

		return new Uint8Array([...localParts, ...centralParts]);
	}
}
