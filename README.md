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
