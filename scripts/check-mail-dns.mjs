#!/usr/bin/env node
/**
 * Read-only SPF/DKIM/DMARC existence and consistency check for the Who You
 * sending domain.
 *
 * This script never edits DNS and never tightens policy. DMARC `p=none` is the
 * approved posture for this slice; a maintainer changes it only through the
 * DNS provider with product/security review. Absence of a DKIM selector is
 * reported as a gap, not guessed.
 *
 * Usage:
 *   node scripts/check-mail-dns.mjs --domain tomlab.cn --dkim-selector whoyou
 */

import { resolveMx, resolveTxt } from "node:dns/promises";

const option = (name) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};

const domain = (option("--domain") ?? process.env.MAIL_DOMAIN ?? "").trim().toLowerCase();
if (!domain || !domain.includes(".")) {
	console.error(
		"usage: node scripts/check-mail-dns.mjs --domain <domain> [--dkim-selector <selector>]",
	);
	process.exit(2);
}

const selector = (option("--dkim-selector") ?? "").trim().toLowerCase();

const readTxt = async (name) => {
	try {
		return (await resolveTxt(name)).map((chunks) => chunks.join(""));
	} catch {
		return [];
	}
};

const checks = [];
const problems = [];
const notes = [];

const spfRecords = (await readTxt(domain)).filter((record) => record.startsWith("v=spf1"));
if (spfRecords.length === 0) {
	problems.push("spf_missing");
} else if (spfRecords.length > 1) {
	// Multiple SPF records are a hard consistency failure: receivers pick one
	// unpredictably. This script reports it and does not merge records.
	problems.push("spf_multiple_records");
} else {
	checks.push({ name: "spf", ok: true, record: spfRecords[0] });
	if (!/(?:^|\s)-(?:all|softfail)\b/.test(spfRecords[0])) {
		notes.push("spf_all_qualifier_absent");
	}
}

const dmarcRecords = (await readTxt(`_dmarc.${domain}`)).filter((record) =>
	record.startsWith("v=DMARC1"),
);
if (dmarcRecords.length === 0) {
	problems.push("dmarc_missing");
} else if (dmarcRecords.length > 1) {
	problems.push("dmarc_multiple_records");
} else {
	const policy = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\b/i.exec(dmarcRecords[0]);
	checks.push({
		name: "dmarc",
		ok: true,
		policy: policy ? policy[1].toLowerCase() : null,
	});
	if (!policy) {
		problems.push("dmarc_policy_unparsable");
	} else if (policy[1].toLowerCase() === "none") {
		notes.push("dmarc_policy_none_approved_for_this_slice");
	}
}

if (!selector) {
	notes.push("dkim_selector_not_provided");
} else {
	const dkimRecords = (await readTxt(`${selector}._domainkey.${domain}`)).filter((record) =>
		record.startsWith("v=DKIM1"),
	);
	if (dkimRecords.length === 0) {
		problems.push("dkim_record_missing");
	} else if (dkimRecords.length > 1) {
		problems.push("dkim_multiple_records");
	} else {
		const publicKey = /(?:^|;)\s*p\s*=\s*([A-Za-z0-9+/=]+)/.exec(dkimRecords[0]);
		if (!publicKey) {
			problems.push("dkim_public_key_missing");
		} else {
			checks.push({ name: "dkim", ok: true, selector });
		}
	}
}

try {
	const mx = await resolveMx(domain);
	checks.push({ name: "mx", ok: mx.length > 0, count: mx.length });
} catch {
	problems.push("mx_unresolvable");
}

const report = {
	domain,
	mode: "read_only",
	dmarcPolicyChange: "not_performed",
	checks,
	problems,
	notes,
};
console.log(JSON.stringify(report, null, 2));
process.exit(problems.length ? 1 : 0);
