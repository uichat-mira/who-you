import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
	GMAIL_READONLY_SCOPE,
	GMAIL_SCOPES,
	GMAIL_SEND_SCOPE,
	GmailApiError,
	OAuthProviderError,
	buildRfc822Message,
	createGmailClient,
	createGoogleOAuthClient,
	createPkcePair,
	decodeBase64Url,
	hasRequiredGmailScope,
	encodeRawMessage,
	resolveGmailOAuthConfig,
} from "../dist/unit.mjs";

const config = {
	clientId: "client-id",
	clientSecret: "client-secret",
	redirectUri: "https://who.example/mail/oauth/gmail/callback",
	authorizationEndpoint: "https://accounts.example/auth",
	tokenEndpoint: "https://oauth.example/token",
	revocationEndpoint: "https://oauth.example/revoke",
};

const jsonResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

test("PKCE pair is S256-shaped and the authorization URL carries every required parameter", async () => {
	const { verifier, challenge } = await createPkcePair();
	assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
	assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
	assert.notEqual(verifier, challenge);

	const client = createGoogleOAuthClient(config, async () => jsonResponse({}));
	const url = new URL(
		client.authorizationUrl({ state: "state-value", codeChallenge: challenge }),
	);
	assert.equal(url.searchParams.get("client_id"), "client-id");
	assert.equal(url.searchParams.get("response_type"), "code");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("code_challenge"), challenge);
	assert.equal(url.searchParams.get("state"), "state-value");
	assert.equal(url.searchParams.get("access_type"), "offline");
	assert.equal(url.searchParams.get("scope"), GMAIL_SCOPES.join(" "));
	assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
});

test("scope validation requires both gmail.send and gmail.readonly", () => {
	assert.equal(hasRequiredGmailScope(GMAIL_SCOPES.join(" ")), true);
	assert.equal(hasRequiredGmailScope(GMAIL_SEND_SCOPE), false);
	assert.equal(hasRequiredGmailScope(`${GMAIL_READONLY_SCOPE} extra`), false);
	assert.equal(hasRequiredGmailScope(null), false);
	assert.equal(hasRequiredGmailScope(`prefix ${GMAIL_SCOPES.join(" ")}`), true);
});

test("code exchange returns tokens when both scopes are granted", async () => {
	let body = "";
	const client = createGoogleOAuthClient(config, async (_url, init) => {
		body = String(init.body);
		return jsonResponse({
			access_token: "access-1",
			refresh_token: "refresh-1",
			scope: GMAIL_SCOPES.join(" "),
			expires_in: 3600,
		});
	});
	const tokens = await client.exchangeCode({ code: "code-1", codeVerifier: "verifier-1" });
	assert.equal(tokens.accessToken, "access-1");
	assert.equal(tokens.refreshToken, "refresh-1");
	assert.equal(tokens.expiresIn, 3600);
	assert.match(body, /grant_type=authorization_code/);
	assert.match(body, /code_verifier=verifier-1/);
});

test("missing scope, invalid_grant and invalid_client map to fixed codes", async () => {
	const missingScope = createGoogleOAuthClient(config, async () =>
		jsonResponse({
			access_token: "access-1",
			refresh_token: "refresh-1",
			scope: GMAIL_SEND_SCOPE,
		}),
	);
	await assert.rejects(
		() => missingScope.exchangeCode({ code: "c", codeVerifier: "v" }),
		(error) => error instanceof OAuthProviderError && error.code === "provider_scope_missing",
	);

	const invalidGrant = createGoogleOAuthClient(config, async () =>
		jsonResponse({ error: "invalid_grant" }, 400),
	);
	await assert.rejects(
		() => invalidGrant.refresh({ refreshToken: "r" }),
		(error) => error instanceof OAuthProviderError && error.code === "invalid_grant",
	);

	const invalidClient = createGoogleOAuthClient(config, async () =>
		jsonResponse({ error: "invalid_client" }, 401),
	);
	await assert.rejects(
		() => invalidClient.refresh({ refreshToken: "r" }),
		(error) => error instanceof OAuthProviderError && error.code === "invalid_client",
	);

	const upstream = createGoogleOAuthClient(config, async () => jsonResponse({}, 503));
	await assert.rejects(
		() => upstream.refresh({ refreshToken: "r" }),
		(error) => error instanceof OAuthProviderError && error.code === "provider_unreachable",
	);

	const offline = createGoogleOAuthClient(config, async () => {
		throw new Error("network down");
	});
	await assert.rejects(
		() => offline.refresh({ refreshToken: "r" }),
		(error) => error instanceof OAuthProviderError && error.code === "provider_unreachable",
	);
});

test("exchange without a refresh token is reauth and never stored as empty", async () => {
	const client = createGoogleOAuthClient(config, async () =>
		jsonResponse({ access_token: "access-1", scope: GMAIL_SCOPES.join(" ") }),
	);
	await assert.rejects(
		() => client.exchangeCode({ code: "c", codeVerifier: "v" }),
		(error) => error instanceof OAuthProviderError && error.code === "missing_refresh_token",
	);
});

test("revoke is best effort and never throws", async () => {
	const ok = createGoogleOAuthClient(config, async () => new Response("", { status: 200 }));
	assert.equal(await ok.revoke({ token: "t" }), true);
	const rejected = createGoogleOAuthClient(config, async () => new Response("", { status: 400 }));
	assert.equal(await rejected.revoke({ token: "t" }), false);
	const offline = createGoogleOAuthClient(config, async () => {
		throw new Error("offline");
	});
	assert.equal(await offline.revoke({ token: "t" }), false);
});

test("gmail send posts the raw payload with the bearer token", async () => {
	let seenUrl = "";
	let seenInit;
	const client = createGmailClient(async (url, init) => {
		seenUrl = String(url);
		seenInit = init;
		return jsonResponse({ id: "msg-1", threadId: "thread-1" });
	}, "https://gmail.test/gmail/v1");

	const sent = await client.sendMessage("access-1", { raw: "cmF3" });
	assert.equal(sent.id, "msg-1");
	assert.equal(sent.threadId, "thread-1");
	assert.equal(seenUrl, "https://gmail.test/gmail/v1/users/me/messages/send");
	assert.equal(seenInit.method, "POST");
	assert.equal(new Headers(seenInit.headers).get("authorization"), "Bearer access-1");
	assert.deepEqual(JSON.parse(String(seenInit.body)), { raw: "cmF3" });
});

test("gmail errors map 401 to unauthorized and 404 on history to history_expired", async () => {
	const unauthorized = createGmailClient(
		async () => jsonResponse({ error: { code: 401 } }, 401),
		"https://gmail.test/gmail/v1",
	);
	await assert.rejects(
		() => unauthorized.listMessages("t", {}),
		(error) => error instanceof GmailApiError && error.code === "unauthorized",
	);

	const expired = createGmailClient(
		async () => jsonResponse({ error: { code: 404 } }, 404),
		"https://gmail.test/gmail/v1",
	);
	await assert.rejects(
		() => expired.listHistory("t", { startHistoryId: "1" }),
		(error) => error instanceof GmailApiError && error.code === "history_expired",
	);
});

test("gmail history and raw message parsing keep only ids and bytes", async () => {
	const raw = "From: a@example.net\r\nSubject: hi\r\n\r\nbody";
	const rawB64 = Buffer.from(raw, "utf8").toString("base64url");
	const client = createGmailClient(async (url) => {
		if (String(url).includes("/history")) {
			return jsonResponse({
				historyId: "200",
				history: [
					{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m1" } }] },
					{ messagesAdded: [{ message: { id: "m2" } }] },
				],
			});
		}
		return jsonResponse({
			id: "m1",
			threadId: "t1",
			internalDate: "1795000000000",
			raw: rawB64,
		});
	}, "https://gmail.test/gmail/v1");

	const page = await client.listHistory("t", { startHistoryId: "100" });
	assert.deepEqual(page.messageIds, ["m1", "m2"]);
	assert.equal(page.historyId, "200");

	const message = await client.getMessage("t", "m1");
	assert.equal(message.id, "m1");
	assert.equal(new TextDecoder().decode(message.raw), raw);
	assert.equal(message.internalDate, 1795000000000);
});

test("raw RFC822 hides CRLF injection, encodes non-ASCII and preserves Bcc", () => {
	const raw = buildRfc822Message(
		{
			from: "linked@gmail.com",
			to: [{ name: "Ada\r\nBcc: attacker@example.net", address: "ada@example.net" }],
			cc: [],
			bcc: [{ name: "", address: "hidden@example.net" }],
			subject: "会议\r\nX-Evil: 1",
			text: "hello",
			html: "<p>hello</p>",
		},
		{ now: 1_795_000_000_000, messageId: "<fixed@example.net>" },
	);

	assert.match(raw, /^Message-ID: <fixed@example\.net>$/m);
	assert.match(raw, /^Bcc: hidden@example\.net$/m);
	assert.doesNotMatch(raw, /X-Evil/);
	assert.equal(raw.split("\r\n").filter((line) => line.includes("Ada")).length, 1);
	assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
	assert.match(raw, /multipart\/alternative/);

	const decoded = new TextDecoder().decode(decodeBase64Url(encodeRawMessage(raw)));
	assert.equal(decoded, raw);
});

test("gmail OAuth config resolves only complete, secure deployments", () => {
	const base = {
		GMAIL_OAUTH_CLIENT_ID: "id",
		GMAIL_OAUTH_CLIENT_SECRET: "secret",
		GMAIL_OAUTH_REDIRECT_URI: "https://who.example/mail/oauth/gmail/callback",
	};
	assert.equal(resolveGmailOAuthConfig(base)?.redirectUri, base.GMAIL_OAUTH_REDIRECT_URI);
	assert.equal(resolveGmailOAuthConfig({ ...base, GMAIL_OAUTH_CLIENT_SECRET: "" }), null);
	assert.equal(
		resolveGmailOAuthConfig({ ...base, GMAIL_OAUTH_REDIRECT_URI: "http://who.example/cb" }),
		null,
	);
	assert.equal(
		resolveGmailOAuthConfig({
			...base,
			GMAIL_OAUTH_REDIRECT_URI: "http://localhost:8787/mail/oauth/gmail/callback",
		})?.redirectUri,
		"http://localhost:8787/mail/oauth/gmail/callback",
	);
});
