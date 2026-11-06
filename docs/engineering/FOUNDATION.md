# Who You — infrastructure handoff (not a product design)

**Status (2026-11-06): repository bootstrap only.** Cloudflare and GitHub resources documented here are not evidence of an active deployment.

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
- Introduce Hono only with an actual route surface. Introduce D1, R2, KV, Queues, Workers Email/Email Sending or cron **only** for approved requirements.
- Generate and commit a package lock; deterministic install is part of the first runtime PR.

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
