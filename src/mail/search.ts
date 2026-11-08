/**
 * Shared mail search normalization.
 *
 * D1 FTS5 availability is still unverified (product design §10 #6), so search
 * uses `instr` over the normalized `search_text` / `from_text` columns. Query
 * normalization must match the stored normalization exactly, otherwise
 * case-folding or whitespace differences silently hide matching rows.
 */

export const MAX_SEARCH_QUERY_CHARS = 200;

export function normalizeSearchQuery(value: string): string {
	return value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_QUERY_CHARS);
}
