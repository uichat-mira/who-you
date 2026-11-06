# Who You · 狐邮 / 忽悠

> Engineering bootstrap + product design proposal. Nothing here is an approved capability and no runtime exists.

This repository is the **cloud-side continuation of Mira Desktop's existing mail-center capability**. That sentence is background; the concrete boundaries, contracts and open decisions are in the product design below.

## Product design

**[Who You 产品与服务设计 v0](docs/product-design.md)** is the single source of truth for what this service is, what it refuses to be, the Agent-facing MCP contract sketch, the security red lines, and the decisions still owed by maintainers.

Three rules from that document are non-negotiable in any implementation:

1. Agents produce **drafts**, never sends. Sending requires an explicit user action bound to one specific draft.
2. The per-consumer ledger is **local state**; remote mailbox mutation is a separate, higher privilege.
3. **Email content is untrusted input.** It is data, never an authorization signal.

## Collaboration

- Product scope, user journeys, providers, storage, migration, and UX are recorded as explicit decisions in the product design; do not silently implement assumptions.
- Developers work in `feat/*` branches and open Draft PRs into `dev`; `dev → test → prod` is the promotion sequence.
- `AGENTS.md` applies to human+AI contributions; each implementation must have an authorized Issue/task contract.
- Organization guidance: [Mira AGENTS](https://github.com/uichat-mira/.github/blob/main/AGENTS.md).
- The repository has **no deployed service**, linked mailbox, credential, database, or working mail API.

## Reserved technical direction (not a product specification)

- Cloud entry point: **Cloudflare Workers**, TypeScript, Node.js 24.
- Preferred new-project CLI: **Cloudflare `cf`**, using `cloudflare.config.ts` when runtime scaffolding begins. Do not introduce Wrangler alongside it without a documented reason.
- Test/runtime contract: Mira T1/T2/T3 + `check`; Vitest with Cloudflare Workers runtime for Worker-specific behavior once code exists.
- Hono may be adopted for HTTP API routing when routes are actually designed.
- Do **not** select D1, R2, Queues, cron, an email provider, or cloud storage of message bodies until an explicit task/architecture contract justifies it.

Read [engineering foundation](docs/engineering/FOUNDATION.md) before touching infrastructure.

## Local setup

This is a **docs/governance bootstrap**, not a runnable application.

```bash
bash scripts/check.sh
```

When an approved runtime task begins, run `cf init` (Node >=22.18, Node 24 preferred), commit a package manifest **and frozen lockfile**, and implement `npm run check` or `pnpm check` as the actual verification gate. The script intentionally refuses runtime source without that setup. Never represent the current documentation CI as runtime evidence.
