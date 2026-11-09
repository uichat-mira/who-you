# Who You on a VPS (Node.js 24)

This document describes how to run the Who You mail service as a single
long-running Node.js 24 process on a Linux VPS (reference target: Aliyun, 1
core / 2 threads, 1.6 GB RAM). It contains **no real hostnames, accounts or
secrets**; every value below is a placeholder to be supplied by the operator.

## 1. Layout and prerequisites

- Node.js **24 or newer** (`node:sqlite` is required).
- A writable data directory owned by the service user, for example
  `/srv/who-you/`:
  - `data/` — object store (`<WHOYOU_DATA_DIR>/objects/...`)
  - `mail.db` — SQLite database plus `-wal`/`-shm` files
- The repository (including `migrations/`) checked out at a stable path.
- Build once, then run the bundle:

```bash
npm ci
npm run build          # emits dist/node.mjs
node dist/node.mjs     # or: npm start
```

The process refuses to start when `WHOYOU_DB_PATH` or `WHOYOU_DATA_DIR` is
missing, and reports the exact missing/invalid name (without printing secrets).

## 2. Environment variables

Business names are unchanged from the Workers version; Node-specific knobs use
the `WHOYOU_` prefix.

### Required for any mail-serving path

| Variable | Meaning |
| --- | --- |
| `WHOYOU_DB_PATH` | Absolute path to the SQLite file, e.g. `/srv/who-you/mail.db` |
| `WHOYOU_DATA_DIR` | Absolute path to the object root, e.g. `/srv/who-you/data` |
| `MAIL_DOMAIN` | Mail domain used to build mailbox addresses |

### HTTP / scheduling

| Variable | Default | Meaning |
| --- | --- | --- |
| `WHOYOU_HTTP_HOST` | `127.0.0.1` | Bind address; keep loopback unless a reverse proxy/firewall is in front |
| `WHOYOU_HTTP_PORT` | `8787` | HTTP port |
| `WHOYOU_SWEEP_INTERVAL_MS` | `3600000` | Retention/reputation sweep interval; runs are non-overlapping |
| `WHOYOU_MIGRATIONS_DIR` | `<cwd>/migrations` | Override only if the bundle is started from another directory |

### MCP / Cloud Auth (same names as before)

`MCP_RESOURCE_URL`, `CLOUD_AUTH_ISSUER`, `CLOUD_AUTH_JWKS_URL`, `MCP_AUDIENCE`,
`MCP_REQUIRED_SCOPES`, `MCP_CONSUMER_CLAIM`.

`/mcp` stays closed with `mcp_not_configured` when these are absent or invalid.
`MCP_RESOURCE_URL` must be the public HTTPS origin that clients use.

### Mail limits, retention, abuse, signing and relay callback

`MAIL_MAX_RAW_BYTES`, `MAIL_MAX_PART_COUNT`, `MAIL_MAX_NESTING_DEPTH`,
`MAIL_MAX_HEADER_BYTES`, `MAIL_MAX_ATTACHMENTS`, `MAIL_MAX_ATTACHMENT_BYTES`,
`MAIL_MAILBOX_QUOTA_BYTES`, `MAIL_BODY_MAX_CHARS`, `MAIL_ATTACHMENT_INLINE_BYTES`,
`MAIL_EXPORT_MAX_MESSAGES`, `MAIL_EXPORT_MAX_BYTES`,
`MAIL_RETENTION_AUDIT_DAYS`, `MAIL_RETENTION_BOUNCE_DAYS`,
`MAIL_ABUSE_WINDOW_MINUTES`, `MAIL_ABUSE_HARD_BOUNCE_COUNT`,
`MAIL_ABUSE_HARD_BOUNCE_RATIO_PERCENT`, `MAIL_ABUSE_COMPLAINT_COUNT`,
`MAIL_ABUSE_EXTERNAL_RECIPIENT_COUNT`,
`MAIL_SIGNING_KEY` (≥ 32 characters), and
`MAIL_INTERNAL_WEBHOOK_SECRET` (≥ 32 characters).

### Inbound SMTP (optional)

Inbound is disabled unless at least one of host/port is set.

| Variable | Meaning |
| --- | --- |
| `WHOYOU_SMTP_INBOUND_HOST` | Bind address; defaults to `127.0.0.1` when only a port is set |
| `WHOYOU_SMTP_INBOUND_PORT` | Listening port (typically `25`; `587` only for a dedicated submission listener) |
| `WHOYOU_SMTP_INBOUND_CERT_PATH` | PEM certificate path for STARTTLS |
| `WHOYOU_SMTP_INBOUND_KEY_PATH` | PEM private key path for STARTTLS |

Cert and key must be supplied together; otherwise startup fails with
`incomplete_WHOYOU_SMTP_INBOUND_TLS`. When both are absent the listener runs
without STARTTLS, which is acceptable only for a private test network.
Inbound does not offer AUTH and accepts one recipient envelope at a time; each
accepted recipient runs the unchanged inbound handler.

### Outbound SMTP relay (optional)

| Variable | Meaning |
| --- | --- |
| `WHOYOU_SMTP_HOST` | Relay hostname; when absent, sending fails closed with `relay_unavailable` |
| `WHOYOU_SMTP_PORT` | Relay port (default `587`) |
| `WHOYOU_SMTP_SECURE` | `true`/`1` for implicit TLS (usually `465`), otherwise STARTTLS/plain |
| `WHOYOU_SMTP_USER` / `WHOYOU_SMTP_PASS` | Optional relay credentials; a user requires a non-empty password |
| `WHOYOU_SMTP_FROM` | Optional envelope sender (Return-Path); never replaces the draft's visible From |

## 3. systemd unit example

Place secrets in an operator-owned `EnvironmentFile` with mode `0600`; do not
paste them into the unit or the repository.

```ini
[Unit]
Description=Who You mail service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=whoyou
Group=whoyou
WorkingDirectory=/srv/who-you/app
EnvironmentFile=/etc/who-you/who-you.env
ExecStart=/usr/bin/node /srv/who-you/app/dist/node.mjs
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
# 1.6 GB host: leave headroom for the OS, SQLite cache and TLS.
MemoryHigh=900M
MemoryMax=1G
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/srv/who-you
# Only if the listener uses port 25:
# AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

`SIGTERM`/`SIGINT` stop the HTTP listener, the inbound SMTP listener, the
interval sweep and the SQLite handle before the process exits `0`.

## 4. Health check

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/health
# expected: 200
curl -s http://127.0.0.1:8787/health
# expected: {"status":"ok","db":"ok"}
```

`503` with `{"status":"error","db":"unreadable"}` means the database cannot be
read. The health endpoint is bound to `WHOYOU_HTTP_HOST`; keep it on loopback
and probe it locally or through a private monitoring path.

## 5. Data directory and backup

- SQLite runs in WAL mode. Back it up with a consistent online copy:

```bash
sqlite3 /srv/who-you/mail.db ".backup '/srv/who-you/backups/mail-$(date +%F).db'"
```

- Object files are immutable once written. Back them up with a snapshot or
  `rsync -a --delete /srv/who-you/data/ /srv/who-you/backup-objects/`.
- Keep `mail.db` and `data/` from the **same** point in time; a database backup
  with a newer object tree can reference objects that do not exist yet.
- The process never deletes user mail on a timer. Only audit rows, delivery
  events and webhook nonces expire; retention settings above control that.
- Restore by stopping the service, replacing `mail.db` (and removing stale
  `-wal`/`-shm`) and restoring the object tree, then starting it again. Startup
  replays any missing migrations idempotently via `schema_migrations`.

## 6. Network and mail-specific notes

- **Inbound 25**: the VPS provider must allow inbound TCP 25 and the domain's
  MX record must point at the VPS. Many providers block 25 by default; confirm
  with the provider before promising mail delivery. Use a firewall rule that
  only exposes 25 (and optionally 587) publicly; keep the HTTP port private.
- **TLS**: publish an MX-usable certificate for the mail hostname and set both
  `WHOYOU_SMTP_INBOUND_CERT_PATH` and `WHOYOU_SMTP_INBOUND_KEY_PATH`. Renewal
  must reload/restart the service (the unit restarts on failure).
- **DNS**: publish SPF, DKIM and DMARC for the sending domain. The repository's
  `scripts/check-mail-dns.mjs` is read-only and can verify current records; it
  never changes them.
- **Outbound**: prefer a dedicated relay/provider submission endpoint with
  STARTTLS and credentials instead of direct-to-MX from a residential or
  blocked VPS address. Keep retry/bounce processing in the relay and point its
  webhook at `POST /internal/delivery` with the HMAC secret above.
- **Abuse/limits**: `WHOYOU_SMTP_INBOUND_PORT`'s listener and the HTTP handler
  share `MAIL_MAX_RAW_BYTES`; sizes are bounded before MIME parsing.
- **Memory**: inbound SMTP buffers one bounded message per connection. With
  1.6 GB RAM, keep `MAIL_MAX_RAW_BYTES` conservative and watch RSS during
  attachment-heavy traffic.

## 7. Upgrade / rollback

1. Stop the service (`systemctl stop who-you-<env>`).
2. Back up SQLite and the object tree.
3. Check out the approved revision, `npm ci`, `npm run build`.
4. Start the service; confirm `GET /health` returns 200.
5. Roll back by restoring the previous revision and the backed-up database/object
   pair. Migrations are additive in this repository; a rollback that crosses a
   new schema version must restore the database backup, not only the code.
