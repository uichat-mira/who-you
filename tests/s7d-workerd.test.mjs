import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURE_KEK, runThirdPartyMailboxScenario } from "./s7-helpers.mjs";

test("S7d: Microsoft link, send, delta sync and unlink stay inside one account", async () => {
	await runThirdPartyMailboxScenario({
		provider: "microsoft",
		otherProvider: "gmail",
		bindings: {
			MAIL_CREDENTIAL_KEK: FIXTURE_KEK,
			MICROSOFT_OAUTH_CLIENT_ID: "fixture-ms-client-id",
			MICROSOFT_OAUTH_CLIENT_SECRET: "fixture-ms-client-secret",
			MICROSOFT_OAUTH_REDIRECT_URI: "https://127.0.0.1/mail/oauth/microsoft/callback",
			MAIL_SEND_MODE: "microsoft",
		},
		callbackPath: "/__microsoft/callback",
		syncPath: "/__microsoft/sync",
		sendPath: "/__microsoft/send",
		expectedAddress: "linked@outlook.com",
		expectedProviderMessageId: "ms-sent-1",
		plaintextTokenMarker: "fixture-ms-refresh-token",
		expiredScript: "cursor_expired",
		syncModeAfterBackfill: "delta",
		sendSubject: "Microsoft outbound fixture",
		expectedScopes: [
			"https://graph.microsoft.com/Mail.Send",
			"https://graph.microsoft.com/Mail.Read",
			"offline_access",
		],
		assertAuthorizationUrl: (url) => {
			assert.equal(url.hostname, "login.microsoftonline.com");
			assert.equal(url.pathname, "/common/oauth2/v2.0/authorize");
			assert.equal(url.searchParams.get("prompt"), "consent");
		},
		checkAfterDelta: async (db, mailboxId) => {
			const syncState = await db
				.prepare(
					"SELECT cursor, backfill_before, backfill_page FROM mailbox_sync_state WHERE mailbox_id = ?",
				)
				.bind(mailboxId)
				.first();
			assert.match(syncState.cursor, /deltatoken=1/);
			assert.equal(syncState.backfill_before, null);
			assert.equal(syncState.backfill_page, null);
		},
		checkAfterExpiry: async (db, mailboxId) => {
			const afterExpiry = await db
				.prepare("SELECT cursor, last_error FROM mailbox_sync_state WHERE mailbox_id = ?")
				.bind(mailboxId)
				.first();
			assert.equal(afterExpiry.cursor, null);
			assert.equal(afterExpiry.last_error, "cursor_expired");
		},
	});
});
