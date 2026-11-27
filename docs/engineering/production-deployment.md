# Production deployment

The sole production source is `prod`. The production workflow runs on pushes to
`prod` or a manual dispatch selecting `prod`, only when the Organization
variable `MIRA_DEPLOY_ENABLED` is `true`. It uses the Organization Actions
secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

The live Worker serving https://who-you.tomz.io is historically named
`who-you-tomz-preview`. Its explicit production configuration lives in
`deploy/cloudflare.prod.config.ts`; the default development configuration is
not a production target. Existing Worker secrets are inherited, never exported
or re-uploaded. No resource provisioning, D1 migration, or credential rotation
is part of this workflow; those need separate authorization and evidence.

A production release containing OPS-055 AppSecret rotation support requires
`migrations/0014_application_app_secret.sql` to have been applied to the live
D1 before the Worker is published. The deployment workflow does not apply or
repair this migration. If the table is absent or unreadable,
`/mira/verify-registration` intentionally fails closed instead of falling back
to the deployment bootstrap AppSecret.

Before publication the workflow records the active version as a rollback point,
checks storage, required secrets and Cron configuration, and builds the locked
source. After publication it verifies binding/schedule parity, the active
version tag and public/unauthenticated HTTP smoke checks. These checks do not
prove authenticated mailbox operations. If verification fails, inspect the
deployment and restore the recorded previous version using the Cloudflare
Worker Deployments UI. Do not roll back database state through this workflow.
