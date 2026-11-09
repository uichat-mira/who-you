# Who You · 狐邮 / 忽悠

> Engineering bootstrap only. Product definition belongs to the delegated product team.

This repository is the **cloud-side continuation of Mira Desktop's existing mail-center capability**. This sentence is background, **not** a claim that a protocol, synchronization design, UI, API, or data model has been approved.

## Collaboration

- Product scope, user journeys, providers, storage, migration, and UX remain **undecided**. Old President and Trae can propose these as explicit design decisions, not silently implement assumptions.
- Developers work in `feat/*` branches and open Draft PRs into `dev`; `dev → test → prod` is the promotion sequence.
- `AGENTS.md` applies to human+AI contributions; each implementation must have an authorized Issue/task contract.
- Organization guidance: [Mira AGENTS](https://github.com/uichat-mira/.github/blob/main/AGENTS.md).
- The repository has **no deployed service**, linked mailbox, credential, database, or working mail API at bootstrap.

## Reserved technical direction (not a product specification)

- Runtime entry point: a **Node.js 24** long-running process on an Aliyun VPS (`node dist/node.mjs`), TypeScript, bundled with esbuild. Cloudflare Workers, `cf`, Wrangler, D1, R2, Email Service bindings and Cron Triggers are no longer used.
- Platform edges are ports (`src/mail/ports.ts`): SQLite for metadata, a filesystem object bucket, `nodemailer` for outbound relay and `smtp-server` for inbound. Deploy notes live in `docs/deployment/vps.md`.
- Test/runtime contract: Mira T1/T2/T3 + `check`; `node:test` integration suites run the same handlers against the Node ports and a temporary data directory.
- Hono may be adopted for HTTP API routing when routes are actually designed.
- Do **not** select a different storage engine, queue, external provider or cloud storage of message bodies until an explicit task/architecture contract justifies it.

Read [engineering foundation](docs/engineering/FOUNDATION.md) before touching infrastructure.

## Local setup

Node.js **24+** is required (`node:sqlite`, `smtp-server`).

```bash
npm ci
npm run check     # typecheck + lint + unit + integration
npm run build     # emits dist/node.mjs
npm start         # node dist/node.mjs; requires WHOYOU_DB_PATH + WHOYOU_DATA_DIR
```

`bash scripts/check.sh` verifies repository bootstrap contracts; `npm run check` is the runtime verification gate. Never represent local test results as evidence of a deployed service.

## Runtime scaffold (WHO-001 / WHO-002; not deployed)

- `npm run check` = typecheck + lint + T1 auth tests + T3 Node/MCP-client integration tests.
- One agent-facing surface: stateless Streamable HTTP `/mcp` plus RFC 9728 discovery at `/.well-known/oauth-protected-resource/mcp`.
- Cloud Auth bearer verification: JWKS, issuer `mira:cloud-auth`, audience `mira:who-you`, required scope `whoyou.read`, consumer claim `consumer_id`. Missing configuration is `503 mcp_not_configured`; there is no anonymous or fixture fallback.
- The only tool is `whoyou_whoami`. No mailbox, persistence, provider OAuth, or email send exists.
