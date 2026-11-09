# Who You — infrastructure handoff (not a product design)

**Status (2026-11-09): repository bootstrap plus S1 inbound, S2 draft/send, S3 state/lifecycle and S4 deliverability/abuse code slices, with the runtime migrated from Cloudflare Workers to a Node.js 24 process on an Aliyun VPS.** No VPS, DNS record, SMTP relay, mailbox credential or active service documented here exists as evidence of a running deployment.

## Confirmed starting point

- Mira Organization instructions: `uichat-mira/.github@main/AGENTS.md`, revision `2026-09-16.2`.
- GitHub initially had only `LICENSE` on `prod`. `dev` and `test` are established for the standard flow.
- The runtime target is one Aliyun VPS (Linux, 1 core / 2 threads, 1.6 GB memory).
- **No hostname, MX record, SMTP relay, inbound 25-port policy or mailbox credential is approved** by this document.
- No production mail data, provider OAuth client or mailbox credential has been provisioned for Who You.

## Technical baseline

- TypeScript on Node.js 24, run as a long-running process (`node dist/node.mjs`) under systemd. There is no Workers runtime, `cf` CLI, D1, R2, Email Service binding or Cron Trigger.
- Platform edges are ports in `src/mail/ports.ts`: `SqlDatabase`, `MailBucket`, `MailSender`, plus the minimal `InboundEmail` envelope. Business code (`src/mail/*`, `src/mcp/*`) depends only on those ports; `src/app.ts` exposes the HTTP and scheduled handlers without any Cloudflare type.
- Node adapters live in `src/node/`:
  - `sqlite-database.ts` — `node:sqlite` `DatabaseSync`, D1-shaped `prepare/bind/first/all/run/batch`; booleans bind as 0/1 and `undefined` as `null`, and `batch` is BEGIN/COMMIT/ROLLBACK.
  - `filesystem-bucket.ts` — `MailBucket` over `WHOYOU_DATA_DIR/objects`, rejects `..`/absolute keys, returns a `ReadableStream` plus byte size.
  - `smtp-sender.ts` — outbound relay through `nodemailer` (STARTTLS or implicit TLS, optional AUTH).
  - `smtp-inbound.ts` — inbound SMTP through `smtp-server`, one bounded message fed to the unchanged inbound handler per recipient.
  - `migrations.ts` — applies `migrations/*.sql` in filename order at startup, tracked idempotently in `schema_migrations`.
  - `http-server.ts` — `node:http` to standard `Request`/`Response`, adds `GET /health` (process + DB readable), otherwise delegates unchanged routes.
  - `main.ts` — env → migrations → HTTP → optional inbound SMTP → interval sweep → SIGINT/SIGTERM shutdown.
- Configuration is read from `process.env` (see `docs/deployment/vps.md`). Critical missing values return an explicit unconfigured result rather than a silent fallback.
- Typecheck + lint + meaningful T1/T2/T3 checks; integration suites run the same handlers against the Node ports and a temporary data directory.
- Generate and commit a package lock; deterministic install is part of the runtime PR.

## S1 inbound code slice (implemented, not provisioned)

Task card: `docs/task-cards/WHO-S1-inbound-read.md` on `docs/who-you-task-cards-v1`; design: `docs/product-design.md` v1.

- Schema: `migrations/0001_mail.sql` (`mailboxes`, `threads`, `messages`, `attachments`). The Node process applies every `migrations/*.sql` at startup and records applied filenames in `schema_migrations`; the test harness runs the same runner against a temporary SQLite file.
- Configuration: SQLite path `WHOYOU_DB_PATH`, object root `WHOYOU_DATA_DIR`, string `MAIL_DOMAIN`. `/mcp` is closed with `mail_storage_not_configured` when a port is absent, and the inbound handler fails transiently when storage or `MAIL_DOMAIN` is absent. Missing critical `WHOYOU_*` values stop startup with an explicit config error instead of inventing a storage backend.
- Limits: `MAIL_MAX_RAW_BYTES`, `MAIL_MAX_PART_COUNT`, `MAIL_MAX_NESTING_DEPTH`, `MAIL_MAX_HEADER_BYTES`, `MAIL_MAX_ATTACHMENTS`, `MAIL_MAX_ATTACHMENT_BYTES`, `MAIL_MAILBOX_QUOTA_BYTES`, `MAIL_BODY_MAX_CHARS`, `MAIL_ATTACHMENT_INLINE_BYTES` (S1), plus `MAIL_EXPORT_MAX_MESSAGES` and `MAIL_EXPORT_MAX_BYTES` (S3). Defaults live in `src/mail/limits.ts`; they are policy ceilings for this slice, not measured MTA/provider limits.
- Inbound MIME is read by `src/mail/raw-mime.ts`, a strict in-repo reader that enforces the caller's header, nesting, part and attachment ceilings and fails explicitly on structure it does not understand. No MIME library dependency is added in this slice; adopting a vetted library remains a separate product decision.
- MCP read tools: `whoyou_mailbox_get`, `whoyou_mail_search`, `whoyou_mail_thread_get`, `whoyou_mail_message_get`, `whoyou_mail_attachment_get`. All reads are scoped by the token-derived account id; quarantined messages are excluded from search and fail explicitly on direct read. Mail content output carries `UNTRUSTED_EMAIL_CONTENT`.
- Search uses a normalized `search_text` column with `instr`; the business query contract is unchanged from the Cloudflare version and does not depend on a specific database engine.
- Attachments are inlined as base64 only below `MAIL_ATTACHMENT_INLINE_BYTES`; larger attachments failed explicitly in S1 and are superseded by the S3 signed-download link (below).

Evidence boundary: `npm run check` (T1 unit + T3 Node integration on the SQLite/filesystem ports) proves local code behavior only. It is **not** evidence that MX delivery to port 25 works, that the relay accepts mail, that `Authentication-Results` is produced, or that any real message was received or sent.

## S2 draft / confirm / send code slice (implemented, not provisioned)

Task card: `docs/task-cards/WHO-S2-draft-confirm-send.md` on `docs/who-you-task-cards-v1`.

- Schema: `migrations/0002_drafts_sends.sql` (`mail_drafts`, `confirmation_nonces`, `send_receipts`).
- Tools: `whoyou_mail_draft_create`, `_update`, `_discard`, `_get`, `_list` (all require the `whoyou.mail.write` scope) and `whoyou_mail_send` (exactly `draftId`, `confirmationCredential`, `idempotencyKey`). Draft write tools reject unknown arguments, so recipients, sender and body cannot be overridden at send time.
- Confirmation contract: Cloud Auth issues a standalone `mira:who-you` / `whoyou.mail.send` credential with a strict `confirmation` claim binding `draft_id`, `draft_version`, `content_hash` and a single-use `nonce`. Who You verifies it offline against the same JWKS; it is never an MCP bearer.
- `contentHash` is SHA-256 over a fixed-order canonical payload (normalized addresses, subject, text, HTML and an empty attachment placeholder). A stale version or hash is rejected; a nonce is consumed atomically before any provider call.
- Sending uses the `MailSender` port. The Node adapter relays through `nodemailer` using `WHOYOU_SMTP_HOST/PORT/SECURE/USER/PASS`; `WHOYOU_SMTP_FROM`, when set, is only the envelope sender and never replaces the draft's visible From. When no relay or mailbox sender address is available, the tool fails with `relay_unavailable` and sends nothing.
- Receipts are insert-only and unique per `(account_id, idempotency_key)`. Only successful sends are persisted, so a failed attempt stays retryable with a fresh confirmation; a replayed credential fails with `confirmation_replayed`.

Explicit gaps: attachment upload/display protocol is undefined, so attachment arguments are rejected and only a placeholder participates in the hash; per-day quotas and recipient ceilings are slice-level constants (20 recipients, 200 000 body characters), not approved product policy; a provider failure spends the nonce and leaves delivery unknown; and no real outbound message, SPF/DKIM/DMARC result or relay acceptance behaviour has been observed. Real sending requires a separate security authorization and a real integration run.

Evidence boundary: the S2 tests fake the provider and the confirmation issuer. They prove ordering, binding and single-use behaviour against SQLite — not SMTP relay semantics, deliverability, or Cloud Auth issuance end to end.

## S3 state, attachments, search, retention and lifecycle code slice (implemented, not provisioned)

Task card: `docs/task-cards/WHO-S3-state-search-retention.md` on `docs/who-you-task-cards-v1`.

- Schema: `migrations/0003_s3_state_search_retention.sql`. Adds mailbox-level flags plus `flag_version` to `messages`, `mail_audit_log`, and `mail_exports` with the `(account_id, export_day)` rate-limit key.
- Flags: `whoyou_mail_flag_set` writes `read`, `starred`, `archived`, `trashed` and requires `whoyou.mail.write`. `flag_version` advances only when the effective flag set changes, so a repeated identical write is a no-op; `expectedVersion` gives optimistic concurrency, and a concurrent identical write that loses the CAS re-reads and reports `changed: false` instead of a false conflict. Quarantined messages cannot be flagged.
- Trash is a folder, not a delete: search defaults to `inbox` (untrashed, unarchived), with `folder: archive | trash | all`, plus `unreadOnly` and `starredOnly`. Quarantined messages stay excluded everywhere.
- Signed downloads: `/mail/download` serves exactly one object per link. The link carries an HMAC-SHA256 over `kind, accountId, id, messageId, exp` using `MAIL_SIGNING_KEY`, expires after 5 minutes, and still requires the caller's Cloud Auth bearer with the read scope. Forwarding the URL grants nothing and the object key never appears in the URL or tool output. Missing, quarantined, unowned and deleted objects fail with explicit codes (`attachment_not_found`, `message_quarantined`, `attachment_unavailable`); an absent or short signing key closes the route with `download_signing_not_configured`.
- Search hardening: query and stored `search_text` share `normalizeSearchQuery` (NFC, case-fold, whitespace collapse, 200-character cap); ordering and cursor stay `(received_at DESC, id DESC)` with `(received_at, id)` tie-breaking, and a 60-message repeated-timestamp page-through is asserted not to duplicate or skip. FTS5 is still **not** used: `instr` is the declared backend in both production and tests.
- Export: `whoyou_mail_export` builds one store-only ZIP (raw EML per message plus `manifest.json`), one per account per UTC day enforced by the unique key, capped by `MAIL_EXPORT_MAX_MESSAGES` / `MAIL_EXPORT_MAX_BYTES`, delivered through the same 5-minute signed link, and recorded in `mail_audit_log`. The manifest never contains another account's data.
- Delete: `whoyou_mail_message_delete` requires the message to be trashed, removes bucket objects first and SQLite rows second, and is retry-safe (`alreadyDeleted: true`). `whoyou_mail_mailbox_delete` requires `confirm: true` and erases every bucket object and every owned row (messages, threads, drafts, nonces, receipts, exports, audit, mailbox), leaving other accounts untouched.
- Retention: user mail has **no TTL** — it lives until the user deletes it. Only `mail_audit_log`, S4 `delivery_events` and the internal webhook nonce rows expire; `mail_audit_log` follows `MAIL_RETENTION_AUDIT_DAYS` (default 180), delivery events follow the 90-day bounce window, and nonces are kept one day (longer than the accepted 5-minute skew). Suppressions are **not** swept: a hard bounce or complaint keeps blocking that recipient until a human changes it. The Node runtime calls the sweep from a `setInterval` loop (`WHOYOU_SWEEP_INTERVAL_MS`, no overlapping runs). Deletion takes effect immediately in SQLite/the object directory; any backup-residue window is a property of the operator's `sqlite3 .backup`/snapshot policy, not something this process verifies.

Explicit gaps: the 5-minute signed link must be fetched with the bearer, so it is an agent/client download rather than a browser-clickable link; export is capped at 25 MB / 1000 messages per account per day; a mailbox-wide export includes quarantined messages by design; the sweep interval, `MAIL_SIGNING_KEY` and backup policy are deployment-side and unverified.

Evidence boundary: `npm run check` proves the flag CAS, signed-link verification, export scoping, delete ordering/idempotency and audit sweep against SQLite and the filesystem bucket. It does not prove Cloud Auth production issuance, backup residue, or any deployed route.

## S4 deliverability and abuse code slice (implemented, not provisioned)

Task card: `docs/task-cards/WHO-S4-deliverability-abuse.md` on `docs/who-you-task-cards-v1`.

- Schema: `migrations/0004_deliverability_abuse.sql` (`delivery_events`, `suppressions`, `deliverability_alerts`, `internal_webhook_nonces`, mailbox `send_paused_at` / `send_paused_reason`, and recipient counters on `send_receipts`). `delivery_events` stores a recipient **hash and domain only**; the exact normalized address exists solely in `suppressions`, because send verification must compare it.
- Relay callback: `POST /internal/delivery` is machine-to-machine and authenticates with an **independent** HMAC (`MAIL_INTERNAL_WEBHOOK_SECRET`), never an agent MCP bearer. The signature covers `${timestamp}\n${nonce}\n${rawBody}`; timestamps outside a 5-minute window are rejected, nonces are single-use, and a missing or short (<32 character) secret closes the route with `503 delivery_webhook_not_configured`. Payload bodies are capped at 1 MiB. Routing uses an explicit `accountId` or a `providerMessageId` receipt lookup; an unknown report returns `422 delivery_event_unroutable`.
- Report reader: `src/mail/dsn.ts` reads RFC 3464 DSN and RFC 5965 ARF from raw RFC822 through the same in-repo MIME reader as inbound mail, so the transport (relay callback now, mailbox fallback later) is replaceable. Diagnostic free text is reduced to SMTP/enhanced codes before storage. Structure it does not understand returns `report_malformed`; non-reports return `not_a_report`.
- Suppression: a hard bounce (`5.x.x` failure) or an ARF complaint inserts one permanent `(account_id, recipient)` row. Every send re-checks `to`, `cc` and `bcc` and fails with `recipient_suppressed` **before** the single-use nonce is spent, so nothing is relayed and the confirmation stays retryable after the recipient is removed.
- Automatic pause: slice defaults (not product-approved) are a 60-minute sliding window with complaint count ≥ 2, OR external recipients ≥ 200, OR hard bounces ≥ 3 **and** ratio ≥ 5%. Any trip wire sets `send_paused_at` and writes a PII-free `deliverability_alerts` row (`detail` carries counters only); the same counters are emitted as a `whoyou_deliverability_pause` structured log line. Sending then fails with `send_paused`, and `whoyou_mailbox_get` exposes `sendPaused` plus the machine reason. Resume is a human operation; there is deliberately **no auto-resume path or endpoint** in this slice.
- DNS posture: `scripts/check-mail-dns.mjs` performs a read-only SPF/DKIM/DMARC existence and consistency check and reports `p=none` without changing it. It never edits records and never tightens policy.
- Reputation metric: the daily scheduled sweep aggregates `delivery_events` and `send_receipts` into counter-only `whoyou_delivery_reputation` output. There is **no DMARC `rua` ingestion**.
- Retry safety: delivery event ids derive from account, type, recipient hash and the report's original message id (falling back to the provider id or receive time), under an `ON CONFLICT DO NOTHING` primary key, so an authenticated retry cannot double-count.

Explicit gaps: no third-party spam/virus gateway is integrated (spam/virus verdicts from an external scanner are a documented gap, not a hidden feature); no DMARC aggregate-report mailbox is read; the callback has not been exercised by a real relay, so DSN/ARF shapes beyond the fixtures, provider retry behaviour and real relay feedback formats remain unverified; no real domain reputation or blocklist data is observed.

Evidence boundary: `npm run check` proves HMAC/replay handling, report parsing, suppression blocking, pause thresholds, volume counting and PII-free alerts against SQLite. It does not prove a real bounce or complaint ever arrives, that a mail domain is configured, or that any DNS record exists.

## VPS rollout discipline (reserved names, not created)

Proposed systemd unit name: `who-you-dev`, `who-you-test`, `who-you-prod`. Names are **candidates**, not existing resources or reservations. Deployment commands are in `docs/deployment/vps.md`.

1. Confirm the owning Aliyun VPS, intended mail domain and exact environment isolation.
2. Create the first **dev-only** service from an approved runtime task; no mailbox access and no real email data.
3. Prove test environment isolation, secret handling and data-directory permissions; then enable `test` through its own protected GitHub environment.
4. Allow `prod` promotion only with an authorized release, evidence and rollback/smoke plan (`/health`, MX/port-25 probe, one controlled inbound/outbound message).
5. DNS/MX, TLS certificates, OAuth redirect URIs, relay credentials and backups require an explicit security/product contract first.

Reference: `docs/deployment/vps.md` in this repository.

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
