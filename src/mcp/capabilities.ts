import * as z from "zod/v4";

export const WHOAMI_TOOL_NAME = "whoyou_whoami";

export const READ_ONLY_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

export const WHOAMI_OUTPUT_SCHEMA = z.object({
	accountId: z.string(),
	consumerId: z.string(),
	scopes: z.array(z.string()),
});

export type WhoamiResult = z.infer<typeof WHOAMI_OUTPUT_SCHEMA>;

export const WHOAMI_TOOL_DESCRIPTION =
	"Report the verified Cloud Auth account and stable consumer identity attached to this MCP credential. " +
	"Identity comes only from the access token; tool arguments cannot select another account or consumer. " +
	"Mailbox authorization and the local consumer ledger are not part of this slice.";

/** Markdown is the primary rendering; `structuredContent` carries the same identity. */
export function renderWhoamiMarkdown(identity: WhoamiResult): string {
	return [
		"# Who You · caller identity",
		`Account: ${identity.accountId}`,
		`Consumer: ${identity.consumerId}`,
		`Scopes: ${identity.scopes.join(", ") || "none"}`,
	].join("\n");
}
