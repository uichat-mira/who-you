import { z } from "zod";
import {
	MCP_RESOURCE_PATH,
	WHOYOU_REQUIRED_SCOPE,
	WHOYOU_SERVICE_AUDIENCE,
} from "./config";

/**
 * The trusted operator input for the Mira ID service registry (OPS-047).
 *
 * Registration itself belongs to Cloud Auth's administrator CLI. This module
 * owns only Who You's side of that contract: the stable service identity, the
 * one protocol revision this repository can prove, the actual HTTPS MCP
 * endpoint and the already-approved canonical read grant. It never contains an
 * account, mailbox, credential or provider fact.
 */
export const WHOYOU_SERVICE_ID = "who-you";
export const WHOYOU_SERVICE_PROJECT_ID = "who-you";
export const WHOYOU_SERVICE_DISPLAY_NAME = "Who You";
export const WHOYOU_SERVICE_PROTOCOL_NAME = "mcp";
/**
 * One stable declaration for the registry. It is intentionally not a tool
 * catalog: OPS-046's capability resource remains the versioned tool view, and
 * the registry only filters by protocol name/version.
 */
export const WHOYOU_SERVICE_PROTOCOL_VERSION = "2025-11-25";
/** Current deployed read-only MCP entry. Other environments must be reviewed separately. */
export const WHOYOU_SERVICE_REGISTRATION_ENDPOINT = "https://who-you.tomz.io/mcp";

const whoYouServiceEndpoint = z
	.string()
	.max(2048)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				value === value.trim() &&
				!/[\s\\]/.test(value) &&
				url.protocol === "https:" &&
				Boolean(url.hostname) &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash &&
				url.pathname === MCP_RESOURCE_PATH
			);
		} catch {
			return false;
		}
	}, "Expected the HTTPS /mcp endpoint without credentials, query or fragment");

/**
 * Mirrors the closed A1 `serviceDefinitionSchema` shape for the canonical Who
 * You grant. Keeping the schema strict here catches an accidental extra field
 * before a maintainer pipes this document into the trusted admin CLI.
 */
export const WHOYOU_SERVICE_DEFINITION_SCHEMA = z.strictObject({
	serviceId: z.literal(WHOYOU_SERVICE_ID),
	projectId: z.literal(WHOYOU_SERVICE_PROJECT_ID),
	displayName: z.literal(WHOYOU_SERVICE_DISPLAY_NAME),
	protocol: z.strictObject({
		name: z.literal(WHOYOU_SERVICE_PROTOCOL_NAME),
		version: z.literal(WHOYOU_SERVICE_PROTOCOL_VERSION),
		endpoint: whoYouServiceEndpoint,
	}),
	audience: z.literal(WHOYOU_SERVICE_AUDIENCE),
	// A1 permits exactly this one canonical read scope for Who You. Write, send
	// and confirmation authority can never be requested through this registry.
	scopes: z.tuple([z.literal(WHOYOU_REQUIRED_SCOPE)]),
});

export type WhoYouServiceDefinition = z.infer<typeof WHOYOU_SERVICE_DEFINITION_SCHEMA>;

export function buildWhoYouServiceDefinition(endpoint: string): WhoYouServiceDefinition {
	return WHOYOU_SERVICE_DEFINITION_SCHEMA.parse({
		serviceId: WHOYOU_SERVICE_ID,
		projectId: WHOYOU_SERVICE_PROJECT_ID,
		displayName: WHOYOU_SERVICE_DISPLAY_NAME,
		protocol: {
			name: WHOYOU_SERVICE_PROTOCOL_NAME,
			version: WHOYOU_SERVICE_PROTOCOL_VERSION,
			endpoint,
		},
		audience: WHOYOU_SERVICE_AUDIENCE,
		scopes: [WHOYOU_REQUIRED_SCOPE],
	});
}

/**
 * The checked-in operator artifact is generated from this object and compared
 * byte-for-byte by the unit test, so the repository carries one declaration
 * rather than two drifting copies.
 */
export const WHOYOU_SERVICE_DEFINITION: WhoYouServiceDefinition =
	buildWhoYouServiceDefinition(WHOYOU_SERVICE_REGISTRATION_ENDPOINT);

export function serializeWhoYouServiceDefinition(
	definition: WhoYouServiceDefinition = WHOYOU_SERVICE_DEFINITION,
): string {
	return `${JSON.stringify(definition, null, 2)}\n`;
}
