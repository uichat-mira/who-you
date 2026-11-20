import assert from "node:assert/strict";
import test from "node:test";
import {
	IMAP_BACKFILL_MAX_MESSAGES,
	IMAP_BACKFILL_WINDOW_MS,
	IMAP_SYNC_MAX_MESSAGES_PER_RUN,
	ImapError,
	MailTransportError,
	SmtpError,
	fetchRawMessage,
	openImapSession,
	quoteImapString,
	searchUids,
	sendSmtpMessage,
	validateRemoteTarget,
} from "../dist/unit.mjs";

const rawMessage = (extraLines = []) =>
	[
		"From: linked@example.net",
		"To: recipient@example.org",
		"Subject: fixture",
		"Message-ID: <fixture-1@example.net>",
		"Date: Mon, 10 Nov 2025 10:00:00 +0000",
		"MIME-Version: 1.0",
		...extraLines,
		"",
		"body",
		"",
	].join("\r\n");

const smtpServer = ({ starttls = true, authFail = false } = {}) => {
	const queue = [];
	const state = { commands: [], authAttempts: 0, data: "" };
	let awaitingData = false;
	let loginStage = 0;
	queue.push("220 fake ESMTP ready");
	const connection = {
		async readLine() {
			const line = queue.shift();
			if (line === undefined) throw new MailTransportError();
			return line;
		},
		async readBytes() {
			return new Uint8Array();
		},
		async write(data) {
			const text = String(data);
			if (awaitingData) {
				awaitingData = false;
				state.data = text;
				queue.push("250 2.0.0 queued");
				return;
			}
			state.commands.push(text.trimEnd());
			if (loginStage === 1) {
				loginStage = 2;
				queue.push("334 UGFzc3dvcmQ6");
				return;
			}
			if (loginStage === 2) {
				loginStage = 0;
				queue.push(authFail ? "535 5.7.8 rejected" : "235 2.7.0 accepted");
				return;
			}
			if (text.startsWith("EHLO")) {
				queue.push(...(starttls ? ["250-fake", "250 STARTTLS"] : ["250-fake", "250 SIZE 1"]));
			} else if (text.startsWith("STARTTLS")) {
				queue.push("220 2.0.0 Ready");
			} else if (text.startsWith("AUTH PLAIN")) {
				state.authAttempts += 1;
				queue.push(authFail ? "535 5.7.8 rejected" : "235 2.7.0 accepted");
			} else if (text.startsWith("AUTH LOGIN")) {
				state.authAttempts += 1;
				loginStage = 1;
				queue.push("334 VXNlcm5hbWU6");
			} else if (text.startsWith("MAIL FROM") || text.startsWith("RCPT TO")) {
				queue.push("250 2.1.0 OK");
			} else if (text.startsWith("DATA")) {
				awaitingData = true;
				queue.push("354 continue");
			} else if (text.startsWith("QUIT")) {
				queue.push("221 bye");
			}
		},
		async upgradeTls() {},
		async close() {},
	};
	return { connection, state };
};

const imapServer = ({
	uidValidity = 42,
	uidNext = 3,
	search = "1 2",
	raw = rawMessage(),
	starttls = true,
} = {}) => {
	const queue = [];
	const literals = [];
	const state = { commands: [] };
	queue.push("* OK fake IMAP ready");
	let selectMissingUidValidity = false;
	const connection = {
		async readLine() {
			const line = queue.shift();
			if (line === undefined) throw new MailTransportError();
			return line;
		},
		async readBytes(length) {
			const literal = literals.shift();
			if (!literal) throw new MailTransportError();
			return literal.subarray(0, length);
		},
		async write(data) {
			const text = String(data);
			state.commands.push(text.trimEnd());
			const space = text.indexOf(" ");
			const tag = text.slice(0, space);
			const command = text.slice(space + 1).trimEnd();
			if (command.startsWith("CAPABILITY")) {
				queue.push(
					...[
						starttls ? "* CAPABILITY IMAP4rev1 STARTTLS" : "* CAPABILITY IMAP4rev1",
						`${tag} OK CAPABILITY completed`,
					],
				);
			} else if (command.startsWith("STARTTLS")) {
				queue.push(`${tag} OK Begin TLS`);
			} else if (command.startsWith("LOGIN")) {
				queue.push(`${tag} OK LOGIN completed`);
			} else if (command.startsWith("SELECT")) {
				queue.push("* FLAGS (\\Seen)");
				if (!selectMissingUidValidity) {
					queue.push(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid`);
				}
				queue.push(`* OK [UIDNEXT ${uidNext}] Predicted next UID`);
				queue.push(`${tag} OK [READ-WRITE] SELECT completed`);
			} else if (command.startsWith("UID SEARCH")) {
				queue.push(`* SEARCH ${search}`.trimEnd(), `${tag} OK SEARCH completed`);
			} else if (command.startsWith("UID FETCH")) {
				const uid = Number.parseInt(command.split(/\s+/)[2], 10);
				const bytes = new TextEncoder().encode(raw);
				queue.push(`* 1 FETCH (UID ${uid} BODY[] {${bytes.byteLength}}`);
				literals.push(bytes);
				queue.push(")", `${tag} OK FETCH completed`);
			} else if (command.startsWith("LOGOUT")) {
				queue.push("* BYE", `${tag} OK LOGOUT completed`);
			}
		},
		async upgradeTls() {},
		async close() {},
	};
	return { connection, state, breakSelect: () => (selectMissingUidValidity = true) };
};

test("remote target rejects IP literals, local names and malformed labels", () => {
	const invalidHosts = [
		"127.0.0.1",
		"0x7f.0.0.1",
		"0177.0.0.1",
		"2130706433",
		"0x7f000001",
		"::1",
		"[::1]",
		"user@example.com",
		"example.com/path",
		"example.com?query",
		"example.com#fragment",
		"example.com:993",
		"localhost",
		"imap.localhost",
		"printer.local",
		"metadata.google.internal",
		"example..com",
		".example.com",
		"example.com.",
		"-example.com",
		"example-.com",
		"exa_mple.com",
		"exämple.com",
		"",
		`${"a".repeat(64)}.com`,
		`${"a.".repeat(127)}com`,
	];
	for (const host of invalidHosts) {
		const result = validateRemoteTarget({ protocol: "imap", host, port: 993 });
		assert.equal(result.ok, false, host);
		assert.equal(result.code, "host_invalid", host);
	}
});

test("remote target only allows the contract port whitelist", () => {
	const cases = [
		[{ protocol: "imap", host: "imap.example.com", port: 25 }, "port_not_allowed"],
		[{ protocol: "imap", host: "imap.example.com", port: 110 }, "port_not_allowed"],
		[{ protocol: "imap", host: "imap.example.com", port: 995 }, "port_not_allowed"],
		[{ protocol: "imap", host: "imap.example.com", port: 465 }, "port_not_allowed"],
		[{ protocol: "imap", host: "imap.example.com", port: 143 }, "port_not_allowed"],
		[{ protocol: "smtp", host: "smtp.example.com", port: 25 }, "port_not_allowed"],
		[{ protocol: "smtp", host: "smtp.example.com", port: 993 }, "port_not_allowed"],
		[{ protocol: "smtp", host: "smtp.example.com", port: 2525 }, "port_not_allowed"],
	];
	for (const [input, code] of cases) {
		const result = validateRemoteTarget(input);
		assert.equal(result.ok, false);
		assert.equal(result.code, code);
	}

	assert.deepEqual(validateRemoteTarget({ protocol: "imap", host: "IMAP.Example.COM", port: 993 }), {
		ok: true,
		target: { host: "imap.example.com", port: 993, tls: "implicit" },
	});
	assert.deepEqual(
		validateRemoteTarget({
			protocol: "imap",
			host: "imap.example.com",
			port: 143,
			allowImap143: true,
		}),
		{ ok: true, target: { host: "imap.example.com", port: 143, tls: "starttls" } },
	);
	assert.equal(validateRemoteTarget({ protocol: "smtp", host: "smtp.example.com", port: 465 }).target.tls, "implicit");
	assert.equal(validateRemoteTarget({ protocol: "smtp", host: "smtp.example.com", port: 587 }).target.tls, "starttls");
});

test("IMAP quoting escapes backslashes and quotes and rejects CR/LF or oversized values", () => {
	assert.equal(quoteImapString('a"b'), '"a\\"b"');
	assert.equal(quoteImapString("a\\b"), '"a\\\\b"');
	assert.equal(quoteImapString("a\rb"), null);
	assert.equal(quoteImapString("a\nb"), null);
	assert.equal(quoteImapString("a".repeat(1024)), `"${"a".repeat(1024)}"`);
	assert.equal(quoteImapString("a".repeat(1025)), null);
});

test("SMTP submits with dot-stuffing and reports the Message-ID", async () => {
	const server = smtpServer();
	const raw = rawMessage([".leading-dot"]);
	const result = await sendSmtpMessage(server.connection, {
		host: "smtp.example.com",
		tls: "starttls",
		username: "linked@example.net",
		password: "app-password",
		from: "linked@example.net",
		to: ["recipient@example.org"],
		cc: [],
		bcc: [],
		raw,
	});
	assert.equal(result.messageId, "<fixture-1@example.net>");
	assert.ok(server.state.commands.includes("STARTTLS"));
	assert.ok(server.state.data.includes("\r\n..leading-dot"));
	assert.ok(server.state.data.endsWith("\r\n.\r\n"));
});

test("SMTP refuses to authenticate when STARTTLS is not advertised", async () => {
	const server = smtpServer({ starttls: false });
	await assert.rejects(
		sendSmtpMessage(server.connection, {
			host: "smtp.example.com",
			tls: "starttls",
			username: "linked@example.net",
			password: "app-password",
			from: "linked@example.net",
			to: ["recipient@example.org"],
			cc: [],
			bcc: [],
			raw: rawMessage(),
		}),
		(error) => error instanceof SmtpError && error.code === "provider_tls_required",
	);
	assert.equal(server.state.authAttempts, 0);
	assert.equal(server.state.commands.some((line) => line.startsWith("AUTH")), false);
});

test("SMTP rejects a sender that differs from the login before any credential is sent", async () => {
	const server = smtpServer();
	await assert.rejects(
		sendSmtpMessage(server.connection, {
			host: "smtp.example.com",
			tls: "starttls",
			username: "linked@example.net",
			password: "app-password",
			from: "other@example.net",
			to: ["recipient@example.org"],
			cc: [],
			bcc: [],
			raw: rawMessage(),
		}),
		(error) => error instanceof SmtpError && error.code === "provider_identity_mismatch",
	);
	assert.equal(server.state.commands.length, 0);
	assert.equal(server.state.authAttempts, 0);
});

test("SMTP maps a rejected password to provider_auth_failed", async () => {
	const server = smtpServer({ authFail: true });
	await assert.rejects(
		sendSmtpMessage(server.connection, {
			host: "smtp.example.com",
			tls: "starttls",
			username: "linked@example.net",
			password: "wrong",
			from: "linked@example.net",
			to: ["recipient@example.org"],
			cc: [],
			bcc: [],
			raw: rawMessage(),
		}),
		(error) => error instanceof SmtpError && error.code === "provider_auth_failed",
	);
	assert.ok(server.state.authAttempts >= 1);
});

test("IMAP session quotes credentials and strictly parses UIDVALIDITY/UIDNEXT", async () => {
	const server = imapServer();
	const session = await openImapSession(server.connection, {
		host: "imap.example.com",
		tls: "implicit",
		username: "linked@example.net",
		password: 'app"pass',
	});
	assert.ok(
		server.state.commands.some((line) =>
			line.includes('LOGIN "linked@example.net" "app\\"pass"'),
		),
	);
	assert.deepEqual(await session.selectInbox(), { uidValidity: 42, uidNext: 3 });

	const broken = imapServer();
	broken.breakSelect();
	const brokenSession = await openImapSession(broken.connection, {
		host: "imap.example.com",
		tls: "implicit",
		username: "linked@example.net",
		password: "app-password",
	});
	await assert.rejects(
		brokenSession.selectInbox(),
		(error) => error instanceof ImapError && error.code === "imap_protocol_error",
	);
});

test("IMAP STARTTLS is mandatory on 143 and login rejects header injection", async () => {
	const noTls = imapServer({ starttls: false });
	await assert.rejects(
		openImapSession(noTls.connection, {
			host: "imap.example.com",
			tls: "starttls",
			username: "linked@example.net",
			password: "app-password",
		}),
		(error) => error instanceof ImapError && error.code === "provider_tls_required",
	);
	assert.equal(noTls.state.commands.some((line) => line.includes("LOGIN")), false);

	const injected = imapServer();
	await assert.rejects(
		openImapSession(injected.connection, {
			host: "imap.example.com",
			tls: "implicit",
			username: "linked@example.net\r\nA1 DELETE INBOX",
			password: "app-password",
		}),
		(error) => error instanceof ImapError && error.code === "imap_protocol_error",
	);
	assert.equal(injected.state.commands.some((line) => line.includes("DELETE")), false);
});

test("IMAP search and fetch use BODY.PEEK and never mark messages read", async () => {
	const server = imapServer();
	const uids = await searchUids(server.connection, { since: null, afterUid: 0, limit: 20 });
	assert.deepEqual(uids, [1, 2]);
	const raw = await fetchRawMessage(server.connection, 2, 10_000);
	assert.equal(new TextDecoder().decode(raw).includes("Message-ID: <fixture-1@example.net>"), true);
	const fetchCommand = server.state.commands.find((line) => line.includes("UID FETCH"));
	assert.ok(fetchCommand.includes("BODY.PEEK[]"));
	assert.equal(server.state.commands.some((line) => /BODY(?!\.PEEK)/.test(line)), false);
});

test("S7e sync budgets match the contract", () => {
	assert.equal(IMAP_BACKFILL_WINDOW_MS, 30 * 24 * 60 * 60 * 1000);
	assert.equal(IMAP_BACKFILL_MAX_MESSAGES, 500);
	assert.equal(IMAP_SYNC_MAX_MESSAGES_PER_RUN, 20);
});
