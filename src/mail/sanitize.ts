/**
 * Conservative HTML sanitizer for inbound mail (product design §8.1 #3).
 *
 * Inbound HTML is hostile input. This is an allowlist rewriter: unknown tags
 * are dropped, only inert attributes survive, no style/class/id/src survive, no
 * remote images are retained, and links are limited to http(s) and mailto with
 * a forced safe `rel`. Anything it cannot classify is removed rather than kept.
 */

const ALLOWED_TAGS = new Set([
	"a",
	"b",
	"blockquote",
	"br",
	"code",
	"div",
	"em",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"li",
	"ol",
	"p",
	"pre",
	"s",
	"span",
	"strong",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"u",
	"ul",
]);

const VOID_TAGS = new Set(["br", "hr"]);
const ALLOWED_ATTRIBUTES = new Set(["href", "title", "colspan", "rowspan"]);
const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

const REMOVED_BLOCKS = /<(script|style)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const MARKUP_DECLARATIONS = /<![^>]*>/g;
const PROCESSING_INSTRUCTIONS = /<\?[\s\S]*?\?>/g;
const TAGS = /<[^>]*>/g;
const OPENING_TAG = /^<\s*([a-zA-Z][a-zA-Z0-9]*)/;
const CLOSING_TAG = /^<\s*\/\s*([a-zA-Z][a-zA-Z0-9]*)/;
const ATTRIBUTES =
	/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

const isControlCharacter = (code: number): boolean => code < 32 || code === 127;

const stripControlCharacters = (value: string): string =>
	[...value].filter((character) => !isControlCharacter(character.charCodeAt(0))).join("");

const hasControlCharacter = (value: string): boolean =>
	[...value].some((character) => isControlCharacter(character.charCodeAt(0)));

const escapeText = (value: string): string =>
	value.replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (value: string): string =>
	stripControlCharacters(value)
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

const safeHref = (value: string): string | null => {
	const href = value.trim();
	if (!href || hasControlCharacter(href)) return null;
	if (!SAFE_LINK.test(href)) return null;
	return href;
};

const rewriteAttributes = (source: string): string => {
	let output = "";
	ATTRIBUTES.lastIndex = 0;
	let match = ATTRIBUTES.exec(source);
	while (match) {
		const name = match[1].toLowerCase();
		const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
		if (ALLOWED_ATTRIBUTES.has(name)) {
			if (name === "href") {
				const href = safeHref(rawValue);
				if (href) {
					output += ` href="${escapeAttribute(href)}"`;
				}
			} else if (name === "colspan" || name === "rowspan") {
				if (/^\d{1,3}$/.test(rawValue.trim())) {
					output += ` ${name}="${rawValue.trim()}"`;
				}
			} else if (name === "title") {
				output += ` title="${escapeAttribute(rawValue)}"`;
			}
		}
		match = ATTRIBUTES.exec(source);
	}
	return output;
};

/**
 * Returns HTML with no scripts, frames, forms, event handlers, style attributes
 * or automatically loading remote resources. Text and inert structure survive.
 */
export function sanitizeHtml(input: string): string {
	if (!input) return "";
	const cleaned = input
		.replace(REMOVED_BLOCKS, "")
		.replace(COMMENTS, "")
		.replace(PROCESSING_INSTRUCTIONS, "")
		.replace(MARKUP_DECLARATIONS, "");

	let output = "";
	let lastIndex = 0;
	TAGS.lastIndex = 0;
	let match = TAGS.exec(cleaned);
	while (match) {
		output += escapeText(cleaned.slice(lastIndex, match.index));
		const tag = match[0];
		const closing = CLOSING_TAG.exec(tag);
		if (closing) {
			const name = closing[1].toLowerCase();
			if (ALLOWED_TAGS.has(name) && !VOID_TAGS.has(name)) {
				output += `</${name}>`;
			}
		} else {
			const opening = OPENING_TAG.exec(tag);
			if (opening) {
				const name = opening[1].toLowerCase();
				if (ALLOWED_TAGS.has(name)) {
					if (VOID_TAGS.has(name)) {
						output += `<${name}>`;
					} else {
						const attributes = rewriteAttributes(tag);
						const link = name === "a" ? ' rel="noopener noreferrer nofollow"' : "";
						output += `<${name}${attributes}${link}>`;
					}
				}
			}
		}
		lastIndex = match.index + tag.length;
		match = TAGS.exec(cleaned);
	}
	output += escapeText(cleaned.slice(lastIndex));
	return output;
}
