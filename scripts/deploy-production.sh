#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_REF:-}" = refs/heads/prod
test "${RELEASE_SHA:?}" = "$(git rev-parse HEAD)"
: "${CLOUDFLARE_ACCOUNT_ID:?}" "${CLOUDFLARE_API_TOKEN:?}"
api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/who-you-tomz-preview"
get() {
  curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api/$1"
}
snapshot() {
  get settings | jq -ce '.result.bindings | map({name,type,id,bucket_name,text}) | sort_by(.name)'
}
schedules() {
  get schedules | jq -ce '.result.schedules | map(.cron) | sort'
}
before=$(snapshot)
# Fail closed if the existing production storage or required secrets are absent.
jq -e '
  any(.[]; .name=="DB" and .type=="d1" and .id=="d1bea1ba-466c-414b-8988-99978678bd9f") and
  any(.[]; .name=="MAIL_BUCKET" and .type=="r2_bucket" and .bucket_name=="who-you-tomz-preview-attachments") and
  ([.[] | select(.type=="secret_text") | .name] | sort) ==
  ["GMAIL_OAUTH_CLIENT_SECRET","MAIL_CREDENTIAL_KEK","WHOYOU_APP_SECRET","WHOYOU_WEB_SESSION_KEY"]
' <<< "$before" >/dev/null
before_cron=$(schedules)
test "$before_cron" = '["*/5 * * * *","17 3 * * *"]'
previous=$(get deployments | jq -er '.result.deployments[0].versions | select(length==1 and .[0].percentage==100) | .[0].version_id')
printf 'Rollback version: %s\n' "$previous" | tee -a "$GITHUB_STEP_SUMMARY"
# cf preserves existing Worker secrets. Never upload, export or replace their values.
./node_modules/.bin/cf deploy --prebuilt --no-provision --tag "prod-${RELEASE_SHA:0:8}" --message "Who You prod $RELEASE_SHA"
test "$(snapshot)" = "$before" || { echo 'Production binding drift detected' >&2; exit 1; }
test "$(schedules)" = "$before_cron" || { echo 'Production schedule drift detected' >&2; exit 1; }
active=$(get deployments | jq -er '.result.deployments[0].versions | select(length==1 and .[0].percentage==100) | .[0].version_id')
get "versions/$active" | jq -e --arg tag "prod-${RELEASE_SHA:0:8}" '.result.annotations["workers/tag"] == $tag' >/dev/null
printf 'Active version: %s\n' "$active" | tee -a "$GITHUB_STEP_SUMMARY"
check_http() {
  local path="$1" expected="$2" code
  for attempt in 1 2 3 4 5; do
    code=$(curl --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' "https://who-you.tomz.io$path") || code=000
    if test "$code" = "$expected"; then
      printf '%s -> %s\n' "$path" "$code"
      return 0
    fi
    sleep 3
  done
  echo "Smoke failure: $path returned $code (expected $expected)" >&2
  return 1
}
check_http / 200
check_http /.well-known/oauth-protected-resource/mcp 200
check_http /mcp 401
check_http /account 303
