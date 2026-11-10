#!/usr/bin/env bash
set -euo pipefail

for path in AGENTS.md README.md docs/engineering/FOUNDATION.md ai-review/PROFILE.md .github/CODEOWNERS .github/workflows/ci.yml; do
  test -s "$path" || { echo "::error::Missing bootstrap contract: $path" >&2; exit 1; }
done

if test ! -f package.json; then
  for path in src apps packages cloudflare.config.ts wrangler.jsonc wrangler.toml wrangler.json; do
    if test -e "$path"; then
      echo "::error::Runtime source/config exists but package.json is missing: $path" >&2
      exit 1
    fi
  done
  echo "PASS: documentation/governance bootstrap only (no runtime tests or deployability claimed)"
  exit 0
fi

node -e "const p=require('./package.json'); if (!p.scripts || !p.scripts.check) { throw new Error('Runtime must declare a real package check script'); }"
if test -f pnpm-lock.yaml; then
  corepack enable
  pnpm install --frozen-lockfile
  pnpm check
elif test -f package-lock.json; then
  npm ci
  npm run check
else
  echo "::error::Runtime must commit a package lockfile" >&2
  exit 1
fi
