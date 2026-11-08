# Who You — infrastructure handoff (not a product design)

**Status (2026-11-08): repository bootstrap plus S1 inbound, S2 draft/send and S3 state/lifecycle code slices.** No Cloudflare deployment, DNS record, Email Routing rule, D1 database or R2 bucket documented here exists as evidence of an active service.

## Confirmed starting point

- Mira Organization instructions: `uichat-mira/.github@main/AGENTS.md`, revision `2026-09-16.2`.
- GitHub initially had only `LICENSE` on `prod`. `dev` and `test` are established for the standard flow.
- Connected Cloudflare account can be queried. Existing Workers do **not** include a Who You service.
- Cloudflare domain `tomz.io` is in the connected account. **No hostname or DNS route for Who You is approved** by this document.
- No mail data store, provider OAuth client, domain Email Routing, SMTP sending, or mailbox credential has been provisioned for Who You.

## Technical baseline

- Cloudflare Workers (Cloud API / edge service) with TypeScript.
- Node.js 24 for local/CI. Use `cf` CLI for this **new** Workers project; Cloudflare currently marks the CLI beta. Follow the current `cf init` template, with `cloudflare.config.ts`.
- Typecheck + lint + meaningful T1/T2/T3 checks; use Cloudflare Worker runtime for platform integrations.
- Introduce Hono only with an actual route surface. Introduce D1, R2, KV, Queues, Workers Email/Email Sending or cron **only** for approved requirements. S1 now introduces D1 (`DB`) and R2 (`MAIL_BUCKET`) for inbound metadata and raw/body/attachment objects.
- Generate and commit a package lock; deterministic install is part of the first runtime PR.

## S1 inbound code slice (implemented, not provisioned)

Task card: `docs/task-cards/WHO-S1-inbound-read.md` on `docs/who-you-task-cards-v1`; design: `docs/product-design.md` v1.

- Schema: `migrations/0001_mail.sql` (`mailboxes`, `threads`, `messages`, `attachments`). Apply with the D1 migration mechanism owned by the deploy surface; the test harness applies the same file via D1 `batch`.
- Bindings: D1 `DB`, R2 `MAIL_BUCKET`, string `MAIL_DOMAIN`. `/mcp` is closed with `mail_storage_not_configured` when D1/R2 are absent, and `email()` fails transiently when storage or `MAIL_DOMAIN` is absent. `cloudflare.config.ts` deliberately does **not** declare D1/R2: the `cf` beta binding schema is unverified, and inventing it would be a false platform claim.
- Limits: `MAIL_MAX_RAW_BYTES`, `MAIL_MAX_PART_COUNT`, `MAIL_MAX_NESTING_DEPTH`, `MAIL_MAX_HEADER_BYTES`, `MAIL_MAX_ATTACHMENTS`, `MAIL_MAX_ATTACHMENT_BYTES`, `MAIL_MAILBOX_QUOTA_BYTES`, `MAIL_BODY_MAX_CHARS`, `MAIL_ATTACHMENT_INLINE_BYTES` (S1), plus `MAIL_EXPORT_MAX_MESSAGES` and `MAIL_EXPORT_MAX_BYTES` (S3). Defaults live in `src/mail/limits.ts`; they are policy ceilings for this slice, not measured Email Routing limits.
- Inbound MIME is read by `src/mail/raw-mime.ts`, a strict in-repo reader that enforces the caller's header, nesting, part and attachment ceilings and fails explicitly on structure it does not understand. No MIME library dependency is added in this slice; adopting a vetted library remains a separate product decision.
- MCP read tools: `whoyou_mailbox_get`, `whoyou_mail_search`, `whoyou_mail_thread_get`, `whoyou_mail_message_get`, `whoyou_mail_attachment_get`. All reads are scoped by the token-derived account id; quarantined messages are excluded from search and fail explicitly on direct read. Mail content output carries `UNTRUSTED_EMAIL_CONTENT`.
- Search uses a normalized `search_text` column with `instr`, not FTS5 (D1 FTS5 support unverified).
- Attachments are inlined as base64 only below `MAIL_ATTACHMENT_INLINE_BYTES`; larger attachments failed explicitly in S1 and are superseded by the S3 signed-download link (below).

Evidence boundary: `npm run check` (T1 unit + T3 Miniflare D1/R2 workerd) proves local code behavior only. It is **not** evidence that `tomlab.cn` is in the Cloudflare account, that Email Routing is enabled, that the platform passes `Authentication-Results`, or that any real message was received or sent.

## S2 draft / confirm / send code slice (implemented, not provisioned)

Task card: `docs/task-cards/WHO-S2-draft-confirm-send.md` on `docs/who-you-task-cards-v1`.

- Schema: `migrations/0002_drafts_sends.sql` (`mail_drafts`, `confirmation_nonces`, `send_receipts`).
- Tools: `whoyou_mail_draft_create`, `_update`, `_discard`, `_get`, `_list` (all require the `whoyou.mail.write` scope) and `whoyou_mail_send` (exactly `draftId`, `confirmationCredential`, `idempotencyKey`). Draft write tools reject unknown arguments, so recipients, sender and body cannot be overridden at send time.
- Confirmation contract: Cloud Auth issues a standalone `mira:who-you` / `whoyou.mail.send` credential with a strict `confirmation` claim binding `draft_id`, `draft_version`, `content_hash` and a single-use `nonce`. Who You verifies it offline against the same JWKS; it is never an MCP bearer.
- `contentHash` is SHA-256 over a fixed-order canonical payload (normalized addresses, subject, text, HTML and an empty attachment placeholder). A stale version or hash is rejected; a nonce is consumed atomically before any provider call.
- Sending uses the Cloudflare Email Service `send_email` binding (`MAIL_EMAIL_SEND`). When the binding or the mailbox sender address is absent, the tool fails with `relay_unavailable` and sends nothing. `cloudflare.config.ts` still declares no bindings: the beta binding schema for D1/R2/Email Sending is unverified, and inventing it would be a false platform claim.
- Receipts are insert-only and unique per `(account_id, idempotency_key)`. Only successful sends are persisted, so a failed attempt stays retryable with a fresh confirmation; a replayed credential fails with `confirmation_replayed`.

Explicit gaps: attachment upload/display protocol is undefined, so attachment arguments are rejected and only a placeholder participates in the hash; per-day quotas and recipient ceilings are slice-level constants (20 recipients, 200 000 body characters), not approved product policy; a provider failure spends the nonce and leaves delivery unknown; and no real outbound message, SPF/DKIM/DMARC result or `send_email` behaviour has been observed. Real sending requires a separate security authorization and a real integration run.

Evidence boundary: the S2 tests fake the provider and the confirmation issuer. They prove ordering, binding and single-use behaviour inside workerd D1 — not Cloudflare Email Service semantics, deliverability, or Cloud Auth issuance end to end.

## S3 state, attachments, search, retention and lifecycle code slice (implemented, not provisioned)

Task card: `docs/task-cards/WHO-S3-state-search-retention.md` on `docs/who-you-task-cards-v1`.

- Schema: `migrations/0003_s3_state_search_retention.sql`. Adds mailbox-level flags plus `flag_version` to `messages`, `mail_audit_log`, and `mail_exports` with the `(account_id, export_day)` rate-limit key.
- Flags: `whoyou_mail_flag_set` writes `read`, `starred`, `archived`, `trashed` and requires `whoyou.mail.write`. `flag_version` advances only when the effective flag set changes, so a repeated identical write is a no-op; `expectedVersion` gives optimistic concurrency, and a concurrent identical write that loses the CAS re-reads and reports `changed: false` instead of a false conflict. Quarantined messages cannot be flagged.
- Trash is a folder, not a delete: search defaults to `inbox` (untrashed, unarchived), with `folder: archive | trash | all`, plus `unreadOnly` and `starredOnly`. Quarantined messages stay excluded everywhere.
- Signed downloads: `/mail/download` serves exactly one object per link. The link carries an HMAC-SHA256 over `kind, accountId, id, messageId, exp` using `MAIL_SIGNING_KEY`, expires after 5 minutes, and still requires the caller's Cloud Auth bearer with the read scope. Forwarding the URL grants nothing and the R2 key never appears in the URL or tool output. Missing, quarantined, unowned and deleted objects fail with explicit codes (`attachment_not_found`, `message_quarantined`, `attachment_unavailable`); an absent or short signing key closes the route with `download_signing_not_configured`.
- Search hardening: query and stored `search_text` share `normalizeSearchQuery` (NFC, case-fold, whitespace collapse, 200-character cap); ordering and cursor stay `(received_at DESC, id DESC)` with `(received_at, id)` tie-breaking, and a 60-message repeated-timestamp page-through is asserted not to duplicate or skip. FTS5 is still **not** used: D1 FTS5 availability remains unverified, so `instr` is the declared backend in both environments.
- Export: `whoyou_mail_export` builds one store-only ZIP (raw EML per message plus `manifest.json`), one per account per UTC day enforced by the unique key, capped by `MAIL_EXPORT_MAX_MESSAGES` / `MAIL_EXPORT_MAX_BYTES`, delivered through the same 5-minute signed link, and recorded in `mail_audit_log`. The manifest never contains another account's data.
- Delete: `whoyou_mail_message_delete` requires the message to be trashed, removes R2 objects first and D1 rows second, and is retry-safe (`alreadyDeleted: true`). `whoyou_mail_mailbox_delete` requires `confirm: true` and erases every R2 object and every owned row (messages, threads, drafts, nonces, receipts, exports, audit, mailbox), leaving other accounts untouched.
- Retention: user mail has **no TTL** — it lives until the user deletes it. Only `mail_audit_log` expires, after `MAIL_RETENTION_AUDIT_DAYS` (default 180). The approved 90-day bounce-record window is recorded in `src/mail/retention.ts`, but S4 owns bounce ingestion and no bounce store exists yet, so nothing sweeps it. The sweep runs from the `scheduled()` handler; a Cron Trigger must point at it in deployment. Deletion takes effect immediately in D1/R2; the ≤ 7-day backup-residue window is a Cloudflare backup property, not something this Worker can verify.

Explicit gaps: the 5-minute signed link must be fetched with the bearer, so it is an agent/client download rather than a browser-clickable link; export is capped at 25 MB / 1000 messages per account per day; a mailbox-wide export includes quarantined messages by design; the Cron Trigger, `MAIL_SIGNING_KEY`, and backup policy are deployment-side and unverified.

Evidence boundary: `npm run check` proves the flag CAS, signed-link verification, export scoping, delete ordering/idempotency and audit sweep inside workerd with Miniflare D1/R2. It does not prove Cloud Auth production issuance, R2 backup residue, or any deployed route.

## Cloudflare rollout discipline (reserved names, not created)

Proposed Worker names: `who-you-dev`, `who-you-test`, `who-you-prod`. Names are **candidates**, not existing resources or reservations.

1. Confirm owning Cloudflare account, intended domain and exact environment isolation.
2. Create the first **dev-only** Worker from an approved runtime task; no mailbox access and no real email data.
3. Prove test environment isolation and secret management; then enable `test` deployment via its own protected GitHub environment.
4. Allow `prod` deployment only from `prod` with an authorized release, evidence and rollback/smoke plan.
5. DNS, custom domains, OAuth redirect URIs, Email Routing, provider credentials and persistence require an explicit security/product contract first.

Reference: [Cloudflare cf first Worker](https://developers.cloudflare.com/cf/get-started/first-worker/), [cf configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/).

## GitHub collaboration

- `dev`: feature integration.
- `test`: acceptance promotion.
- `prod`: production source.
- `feat/*`, `fix/*`, `docs/*`, `chore/*`: implementation branches.
- `.github/CODEOWNERS`: requests maintainer review for engineering guardrails and deploy surfaces, but **does not enforce approvals without branch protection**.
- CI: Branch Policy + Repository Contract → `Mira Gate`. Docs-only state is **explicitly not runtime-validated**.
- `mira-external-worker.yml`: opt-in paid centralized Organization Worker; comment exactly `/worker run` on an approved open Issue, or dispatch with Issue number. It requires the corresponding Org secret to be available to this repository; it cannot run without it. Produces Draft PR into `dev`, no merge or deploy.
- `opencode-review.yml`: independent advisory AI review only for ready, internal PRs to `dev`. It requires an available `AI_PROVIDER_OPENCODE_GO_KEY`. It is **not** a mandatory approval substitute.
- Mira Mobile PR activity identifies the delegated developer as GitHub `tzt2026` (the historical `t-zt` alias no longer resolves in GitHub search). This repository currently reports `read` permission for `tzt2026`; an administrator must grant the intended write role before a CODEOWNERS assignment can be effective. No invitation or permission change has been made.

## Checks still owned by a GitHub administrator

The available integration cannot mutate repository rulesets, default branch, review-required settings, or collaborators. In repository settings, establish:
- default branch `dev` for normal development (while `prod` retains production semantics);
- require PR + `Mira Gate` on `dev`, `test`, `prod`; require approvals (at least one independent human reviewer for protected changes), restrict bypass/force pushes, and review any admin exceptions;
- confirm GitHub Actions permitted reusable workflows and organization-level secret access for this repo;
- add the delegated developer's exact GitHub handle with appropriate least privilege.

These settings are **pending**, not declared complete.
