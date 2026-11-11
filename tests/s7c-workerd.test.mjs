import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURE_KEK, runThirdPartyMailboxScenario } from "./s7-helpers.mjs";

test("S7c: Gmail link, send, sync and unlink stay inside one account", async () => {
	await runThirdPartyMailboxScenario({
		provider: "gmail",
		otherProvider: "microsoft",
		bindings: {
			MAIL_CREDENTIAL_KEK: FIXTURE_KEK,
			GMAIL_OAUTH_CLIENT_ID: "fixture-client-id",
			GMAIL_OAUTH_CLIENT_SECRET: "fixture-client-secret",
			GMAIL_OAUTH_REDIRECT_URI: "https://127.0.0.1/mail/oauth/gmail/callback",
			MAIL_SEND_MODE: "gmail",
		},
		callbackPath: "/__gmail/callback",
		syncPath: "/__gmail/sync",
		sendPath: "/__gmail/send",
		expectedAddress: "linked@gmail.com",
		expectedProviderMessageId: "gmail-sent-1",
		plaintextTokenMarker: "fixture-refresh-token",
		expiredScript: "history_expired",
		syncModeAfterBackfill: "history",
		sendSubject: "Gmail outbound fixture",
		expectedScopeString:
			"https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
		assertAuthorizationUrl: (url) => {
			assert.equal(url.hostname, "accounts.google.com");
			assert.equal(url.searchParams.get("access_type"), "offline");
		},
	});
});
