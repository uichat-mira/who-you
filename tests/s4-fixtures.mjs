/**
 * Synthetic DSN / ARF reports shared by the S4 unit and integration suites.
 * Every address is a reserved example.com / tomlab.cn fixture; nothing here
 * resembles real user mail.
 */

const envelope = (header, body) => [
	"From: Mail Delivery Subsystem <mailer-daemon@example.net>",
	"To: alpha@tomlab.cn",
	"Subject: Delivery report",
	"MIME-Version: 1.0",
	`Content-Type: ${header}`,
	"",
	body,
].join("\r\n");

const dsnReport = (recipient, action, status, diagnostic) =>
	envelope(
		'multipart/report; report-type=delivery-status; boundary="s4-dsn-boundary"',
		[
			"--s4-dsn-boundary",
			"Content-Type: text/plain; charset=us-ascii",
			"",
			"This is an automatically generated delivery report.",
			"",
			"--s4-dsn-boundary",
			"Content-Type: message/delivery-status",
			"",
			"Reporting-MTA: dns; mx.example.net",
			"Original-Message-ID: <synthetic-original@tomlab.cn>",
			"",
			`Final-Recipient: rfc822; ${recipient}`,
			`Action: ${action}`,
			`Status: ${status}`,
			`Diagnostic-Code: smtp; ${diagnostic}`,
			"",
			"--s4-dsn-boundary",
			"Content-Type: message/rfc822",
			"",
			"Message-ID: <synthetic-original@tomlab.cn>",
			"Subject: synthetic fixture",
			"",
			"synthetic body",
			"",
			"--s4-dsn-boundary--",
		].join("\r\n"),
	);

export const hardBounceReport = (recipient) =>
	dsnReport(recipient, "failed", "5.1.1", "550 5.1.1 User unknown");

export const softBounceReport = (recipient) =>
	dsnReport(recipient, "delayed", "4.2.2", "450 4.2.2 Mailbox full");

export const deliveredReport = (recipient) =>
	dsnReport(recipient, "delivered", "2.0.0", "250 2.0.0 Accepted");

export const complaintReport = (recipient) =>
	envelope(
		'multipart/report; report-type=feedback-report; boundary="s4-arf-boundary"',
		[
			"--s4-arf-boundary",
			"Content-Type: text/plain; charset=us-ascii",
			"",
			"This is a spam complaint report.",
			"",
			"--s4-arf-boundary",
			"Content-Type: message/feedback-report",
			"",
			"Feedback-Type: abuse",
			"Version: 1",
			"User-Agent: SyntheticReporter/1.0",
			"Original-Mail-From: alpha@tomlab.cn",
			`Original-Rcpt-To: ${recipient}`,
			"",
			"--s4-arf-boundary",
			"Content-Type: message/rfc822",
			"",
			"Message-ID: <synthetic-complaint@tomlab.cn>",
			"Subject: synthetic fixture",
			"",
			"synthetic body",
			"",
			"--s4-arf-boundary--",
		].join("\r\n"),
	);

export const malformedReport = () =>
	envelope(
		'multipart/report; report-type=delivery-status; boundary="s4-empty-boundary"',
		[
			"--s4-empty-boundary",
			"Content-Type: text/plain",
			"",
			"No recipient status block follows.",
			"--s4-empty-boundary--",
		].join("\r\n"),
	);

export const notAReport = () =>
	[
		"From: sender@example.com",
		"To: alpha@tomlab.cn",
		"Subject: plain mail",
		"Content-Type: text/plain",
		"",
		"Just a normal message.",
	].join("\r\n");
