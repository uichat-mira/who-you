import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
	GRAPH_API_BASE_URL,
	GRAPH_DELTA_PAGE_SIZE,
	GraphApiError,
	MICROSOFT_OIDC_SCOPES,
	MICROSOFT_READ_SCOPE,
	MICROSOFT_SCOPES,
	MICROSOFT_SEND_SCOPE,
	OAuthProviderError,
	addressFromMicrosoftIdToken,
	buildMicrosoftEndpoints,
	createGraphClient,
	createMicrosoftOAuthClient,
	encodeBase64Url,
	encodeMimeBase64,
	hasRequiredMicrosoftScope,
	isValidMicrosoftTenant,
	resolveMicrosoftOAuthConfig,
} from "../dist/unit.mjs";

const config = {
	clientId: "client-id",
	clientSecret: "client-secret",
	redirectUri: "https://who.example/mail/oauth/microsoft/callback",
	tenant: "common",
	authorizationEndpoint: "https://login.example/common/oauth2/v2.0/authorize",
	tokenEndpoint: "https://login.example/common/oauth2/v2.0/token",
};

const jsonResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const fixtureIdToken = (claims) =>
	[
		encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
		encodeBase64Url(JSON.stringify(claims)),
		"signature",
	].join(".");

const tokenPayload = (overrides = {}) => ({
	access_token: "ms-access-1",
	refresh_token: "ms-refresh-1",
	scope: MICROSOFT_SCOPES.join(" "),
	expires_in: 3600,
	id_token: fixtureIdToken({ preferred_username: "linked@outlook.com" }),
	...overrides,
});

test("authorization URL targets the tenant and asks for minimal Graph scopes", () => {
	const client = createMicrosoftOAuthClient(config, async () => jsonResponse({}));
	const url = new URL(
		client.authorizationUrl({ state: "state-value", codeChallenge: "challenge-value" }),
	);
	assert.equal(url.searchParams.get("client_id"), "client-id");
	assert.equal(url.searchParams.get("response_type"), "code");
	assert.equal(url.searchParams.get("response_mode"), "query");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
	assert.equal(url.searchParams.get("state"), "state-value");
	assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
	assert.equal(url.searchParams.get("scope"), MICROSOFT_SCOPES.join(" "));
	assert.equal(url.searchParams.get("prompt"), "consent");
	// Google-only parameters must not leak into the Microsoft request.
	assert.equal(url.searchParams.get("access_type"), null);

	const scopes = url.searchParams.get("scope").split(" ");
	assert.ok(scopes.includes(MICROSOFT_SEND_SCOPE));
	assert.ok(scopes.includes(MICROSOFT_READ_SCOPE));
	assert.ok(scopes.includes("offline_access"));
	assert.ok(MICROSOFT_OIDC_SCOPES.every((scope) => scopes.includes(scope)));
});

test("scope validation accepts both full and short Graph scope names", () => {
	assert.equal(hasRequiredMicrosoftScope(MICROSOFT_SCOPES.join(" ")), true);
	assert.equal(hasRequiredMicrosoftScope("Mail.Send Mail.Read"), true);
	assert.equal(hasRequiredMicrosoftScope("https://graph.microsoft.com/Mail.Send"), false);
	assert.equal(hasRequiredMicrosoftScope(MICROSOFT_SEND_SCOPE), false);
	assert.equal(hasRequiredMicrosoftScope(null), false);
});

test("code exchange returns tokens and reads the address from the ID token", async () => {
	let body = "";
	const client = createMicrosoftOAuthClient(config, async (_url, init) => {
		body = String(init.body);
		return jsonResponse(tokenPayload());
	});
	const tokens = await client.exchangeCode({ code: "code-1", codeVerifier: "verifier-1" });
	assert.equal(tokens.accessToken, "ms-access-1");
	assert.equal(tokens.refreshToken, "ms-refresh-1");
	assert.equal(tokens.expiresIn, 3600);
	assert.equal(addressFromMicrosoftIdToken(tokens.idToken), "linked@outlook.com");
	assert.match(body, /grant_type=authorization_code/);
	assert.match(body, /code_verifier=verifier-1/);
	assert.match(body, /scope=/);
});

test("exchange failures collapse to fixed codes", async () => {
	const missingRefresh = createMicrosoftOAuthClient(config, async () =>
		jsonResponse(tokenPayload({ refresh_token: undefined })),
	);
	await assert.rejects(
		() => missingRefresh.exchangeCode({ code: "c", codeVerifier: "v" }),
		(error) => error instanceof OAuthProviderError && error.code === "missing_refresh_token",
	);

	const missingIdToken = createMicrosoftOAuthClient(config, async () =>
		jsonResponse(tokenPayload({ id_token: undefined })),
	);
	await assert.rejects(
		() => missingIdToken.exchangeCode({ code: "c", codeVerifier: "v" }),
		(error) => error instanceof OAuthProviderError && error.code === "provider_misconfigured",
	);

	const missingScope = createMicrosoftOAuthClient(config, async () =>
		jsonResponse(tokenPayload({ scope: MICROSOFT_SEND_SCOPE })),
	);
	await assert.rejects(
		() => missingScope.exchangeCode({ code: "c", codeVerifier: "v" }),
		(error) => error instanceof OAuthProviderError && error.code === "provider_scope_missing",
	);

	const invalidGrant = createMicrosoftOAuthClient(config, async () =>
		jsonResponse({ error: "invalid_grant" }, 400),
	);
	await assert.rejects(
		() => invalidGrant.refresh({ refreshToken: "r" }),
		(error) => error instanceof OAuthProviderError && error.code === "invalid_grant",
	);

	const unauthorizedClient = createMicrosoftOAuthClient(config, async () =>
		jsonResponse({ error: "unauthorized_client" }, 401),
	);
	await assert.rejects(
		() => unauthorizedClient.refresh({ refreshToken: "r" }),
		(error) => error instanceof OAuthProviderError && error.code === "invalid_client",
	);

	const upstream = createMicrosoftOAuthClient(config, async () => jsonResponse({}, 503));
	await assert.rejects(
		() => upstream.refresh({ refreshToken: "r" }),
		(error) => error instanceof OAuthProviderError && error.code === "provider_unreachable",
	);

	const offline = createMicrosoftOAuthClient(config, async () => {
		throw new Error("network down");
	});
	await assert.rejects(
		() => offline.refresh({ refreshToken: "r" }),
		(error) => error instanceof OAuthProviderError && error.code === "provider_unreachable",
	);
});

test("refresh tolerates a response without refresh token, scope or ID token", async () => {
	const client = createMicrosoftOAuthClient(config, async () =>
		jsonResponse({
			access_token: "ms-access-2",
			scope: MICROSOFT_SCOPES.join(" "),
			expires_in: 3600,
		}),
	);
	const tokens = await client.refresh({ refreshToken: "r" });
	assert.equal(tokens.accessToken, "ms-access-2");
	assert.equal(tokens.refreshToken, null);
	assert.equal(tokens.idToken, null);
});

test("ID token address prefers preferred_username and ignores malformed input", () => {
	assert.equal(
		addressFromMicrosoftIdToken(fixtureIdToken({ preferred_username: "a@b.example", email: "c@d.example" })),
		"a@b.example",
	);
	assert.equal(addressFromMicrosoftIdToken(fixtureIdToken({ email: "c@d.example" })), "c@d.example");
	assert.equal(addressFromMicrosoftIdToken(fixtureIdToken({ upn: "e@f.example" })), "e@f.example");
	assert.equal(addressFromMicrosoftIdToken(fixtureIdToken({})), null);
	assert.equal(addressFromMicrosoftIdToken("not-a-jwt"), null);
	assert.equal(addressFromMicrosoftIdToken("a.%%%.c"), null);
	assert.equal(addressFromMicrosoftIdToken(null), null);
});

test("OAuth config resolution requires a complete, secure and well-formed pair", () => {
	const complete = resolveMicrosoftOAuthConfig({
		MICROSOFT_OAUTH_CLIENT_ID: "id",
		MICROSOFT_OAUTH_CLIENT_SECRET: "secret",
		MICROSOFT_OAUTH_REDIRECT_URI: "https://who.example/mail/oauth/microsoft/callback",
	});
	assert.equal(complete.tenant, "common");
	assert.equal(
		complete.authorizationEndpoint,
		"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
	);
	assert.equal(complete.tokenEndpoint, "https://login.microsoftonline.com/common/oauth2/v2.0/token");

	const custom = resolveMicrosoftOAuthConfig({
		MICROSOFT_OAUTH_CLIENT_ID: "id",
		MICROSOFT_OAUTH_CLIENT_SECRET: "secret",
		MICROSOFT_OAUTH_REDIRECT_URI: "http://localhost:8787/mail/oauth/microsoft/callback",
		MICROSOFT_OAUTH_TENANT: "contoso.onmicrosoft.com",
	});
	assert.equal(custom.tenant, "contoso.onmicrosoft.com");
	assert.equal(
		custom.authorizationEndpoint,
		"https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize",
	);

	assert.equal(
		resolveMicrosoftOAuthConfig({
			MICROSOFT_OAUTH_CLIENT_ID: "id",
			MICROSOFT_OAUTH_REDIRECT_URI: "https://who.example/callback",
		}),
		null,
	);
	assert.equal(
		resolveMicrosoftOAuthConfig({
			MICROSOFT_OAUTH_CLIENT_ID: "id",
			MICROSOFT_OAUTH_CLIENT_SECRET: "secret",
			MICROSOFT_OAUTH_REDIRECT_URI: "http://who.example/callback",
		}),
		null,
	);
	assert.equal(
		resolveMicrosoftOAuthConfig({
			MICROSOFT_OAUTH_CLIENT_ID: "id",
			MICROSOFT_OAUTH_CLIENT_SECRET: "secret",
			MICROSOFT_OAUTH_REDIRECT_URI: "https://who.example/callback",
			MICROSOFT_OAUTH_TENANT: "../../evil",
		}),
		null,
	);
	assert.equal(isValidMicrosoftTenant("common"), true);
	assert.equal(isValidMicrosoftTenant("consumers"), true);
	assert.equal(isValidMicrosoftTenant("-bad"), false);
	assert.equal(isValidMicrosoftTenant("a/b"), false);
	assert.deepEqual(buildMicrosoftEndpoints("common"), {
		authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
	});
});

test("MIME base64 is standard, padded and round-trips", () => {
	const raw = "From: a@b.example\r\nSubject: héllo\r\n\r\nbody";
	const encoded = encodeMimeBase64(raw);
	assert.equal(encoded, Buffer.from(raw, "utf8").toString("base64"));
	assert.ok(!encoded.includes("-"));
	assert.ok(!encoded.includes("_"));
	assert.equal(Buffer.from(encoded, "base64").toString("utf8"), raw);
});

test("send creates a MIME draft and then sends it, returning the provider id", async () => {
	const calls = [];
	const client = createGraphClient(async (url, init = {}) => {
		calls.push({ url, init });
		if (calls.length === 1) return jsonResponse({ id: "draft-1" }, 201);
		return new Response(null, { status: 202 });
	});
	const sent = await client.sendMessage("access-token", { rawBase64: "RnJvbTogYUBi" });
	assert.equal(sent.id, "draft-1");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, `${GRAPH_API_BASE_URL}/me/messages`);
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers["content-type"], "text/plain");
	assert.equal(calls[0].init.body, "RnJvbTogYUBi");
	assert.equal(calls[1].url, `${GRAPH_API_BASE_URL}/me/messages/draft-1/send`);
	assert.equal(calls[1].init.method, "POST");
});

test("send surfaces Graph failures as fixed codes", async () => {
	const unauthorized = createGraphClient(async () => jsonResponse({}, 401));
	await assert.rejects(
		() => unauthorized.sendMessage("t", { rawBase64: "eA==" }),
		(error) => error instanceof GraphApiError && error.code === "unauthorized",
	);
	const offline = createGraphClient(async () => {
		throw new Error("network down");
	});
	await assert.rejects(
		() => offline.sendMessage("t", { rawBase64: "eA==" }),
		(error) => error instanceof GraphApiError && error.code === "provider_unreachable",
	);
});

test("raw message download returns bytes from $value", async () => {
	const calls = [];
	const client = createGraphClient(async (url, init = {}) => {
		calls.push({ url, init });
		return new Response("From: a@b.example\r\n\r\nbody", { status: 200 });
	});
	const message = await client.getMessageMime("token", "ms-msg-1");
	assert.equal(calls[0].url, `${GRAPH_API_BASE_URL}/me/messages/ms-msg-1/$value`);
	assert.equal(calls[0].init.headers.accept, "message/rfc822");
	assert.equal(new TextDecoder().decode(message.raw), "From: a@b.example\r\n\r\nbody");

	const expired = createGraphClient(async () => new Response(null, { status: 410 }));
	await assert.rejects(
		() => expired.getMessageMime("token", "id"),
		(error) => error instanceof GraphApiError && error.code === "cursor_expired",
	);
});

test("delta pages carry ids, timestamps, pagination links and skip tombstones", async () => {
	const calls = [];
	const client = createGraphClient(async (url) => {
		calls.push(url);
		return jsonResponse({
			value: [
				{
					id: "ms-msg-1",
					receivedDateTime: "2025-11-10T10:00:00Z",
					"@removed": undefined,
				},
				{ id: "ms-msg-2", receivedDateTime: "not-a-date" },
				{ id: "ms-msg-3", "@removed": { reason: "deleted" } },
			],
			"@odata.nextLink":
				"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc",
		});
	});
	const since = Date.parse("2025-10-11T00:00:00Z");
	const page = await client.listInboxDelta("token", { since });
	assert.deepEqual(
		page.messages.map((message) => message.id),
		["ms-msg-1", "ms-msg-2"],
	);
	assert.equal(page.messages[0].receivedAt, Date.parse("2025-11-10T10:00:00Z"));
	assert.equal(page.messages[1].receivedAt, null);
	assert.equal(
		page.nextLink,
		"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc",
	);
	assert.equal(page.deltaLink, null);

	const initial = new URL(calls[0]);
	assert.equal(initial.pathname, "/v1.0/me/mailFolders/inbox/messages/delta");
	assert.equal(initial.searchParams.get("$top"), String(GRAPH_DELTA_PAGE_SIZE));
	assert.equal(
		initial.searchParams.get("$filter"),
		`receivedDateTime ge ${new Date(since).toISOString()}`,
	);

	// A provider-supplied link is followed verbatim, never re-filtered.
	await client.listInboxDelta("token", { link: page.nextLink });
	assert.equal(calls[1], page.nextLink);
	assert.equal(new URL(calls[1]).searchParams.get("$filter"), null);
});

test("delta rejects pagination links that leave Graph", async () => {
	let requested = false;
	const client = createGraphClient(async () => {
		requested = true;
		return jsonResponse({ value: [] });
	});
	await assert.rejects(
		() => client.listInboxDelta("token", { link: "https://evil.example/delta" }),
		(error) => error instanceof GraphApiError && error.code === "provider_error",
	);
	assert.equal(requested, false, "a foreign link must never be fetched");
});

test("delta maps expired tokens and authorization failures", async () => {
	const gone = createGraphClient(async () => new Response(null, { status: 410 }));
	await assert.rejects(
		() => gone.listInboxDelta("token", { link: "https://graph.microsoft.com/v1.0/me/x" }),
		(error) => error instanceof GraphApiError && error.code === "cursor_expired",
	);
	const forbidden = createGraphClient(async () => jsonResponse({}, 403));
	await assert.rejects(
		() => forbidden.listInboxDelta("token", { since: Date.now() }),
		(error) => error instanceof GraphApiError && error.code === "unauthorized",
	);
});
