#!/usr/bin/env bash
# Replaces the APK of the Amazon Appstore listing and commits the edit, which sends it to Amazon review.
# Usage: amazon-publish.sh <apk>. Env: APP (the application API URL), AMAZON_TAG, CLIENT_ID, CLIENT_SECRET.
set -euo pipefail
apk_file=$1

# Only an error body is printed: a successful one carries the token.
resp=$(curl -sS --fail-with-body https://api.amazon.com/auth/o2/token \
  -d grant_type=client_credentials -d scope=appstore::apps:readwrite \
  --data-urlencode "client_id=$CLIENT_ID" --data-urlencode "client_secret=$CLIENT_SECRET") \
  || { echo "::error::Amazon token request failed: $resp"; exit 1; }
token=$(jq -r '.access_token // empty' <<<"$resp")
[ -n "$token" ] || { echo "::error::Amazon token response has no access_token"; exit 1; }
auth="Authorization: Bearer $token"
# Amazon explains a refusal only in the body, so a failed call prints it.
api() {
  local out
  out=$(curl -sS --fail-with-body -H "$auth" "$@") \
    || { echo "::error::Amazon ${*: -1} failed: $out" >&2; return 1; }
  printf '%s' "$out"
}
etag() { api -D - "$1" | awk 'tolower($1)=="etag:" {print $2}' | tr -d '\r'; }

# Only one edit can be open per app: reuse the one a failed run left behind. A committed edit
# stays the open one, SUBMITTED, until Amazon's review ends, and nothing in it can change.
active=$(curl -s -H "$auth" "$APP/edits" || true)
edit=$(jq -r '.id // empty' <<<"$active" 2>/dev/null || true)
status=$(jq -r '.status // empty' <<<"$active" 2>/dev/null || true)
case $status in
  '' | IN_PROGRESS) ;;
  SUBMITTED)
    message="$AMAZON_TAG not sent to Amazon: the previous release is still in review"
    # A tag defers to the next one; a manual dispatch asked for this very upload, so it fails.
    [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] && { echo "::error::$message"; exit 1; }
    echo "::warning::$message"
    exit 0 ;;
  *) echo "::error::Amazon edit $edit is $status, neither in progress nor in review"; exit 1 ;;
esac
[ -n "$edit" ] || edit=$(api -X POST "$APP/edits" | jq -r .id)

apk=$(api "$APP/edits/$edit/apks" | jq -r '.[0].id')
api -X PUT -H "If-Match: $(etag "$APP/edits/$edit/apks/$apk")" \
  -H 'Content-Type: application/octet-stream' -H 'fileName: fliks.apk' \
  --data-binary @"$apk_file" "$APP/edits/$edit/apks/$apk/replace" > /dev/null

# Validation refuses an edit without release notes for en-US. fr-FR is
# optional: only a listing the app already has is updated.
notes() {
  local url="$APP/edits/$edit/listings/$1" listing
  listing=$(curl -sf -H "$auth" "$url") || { [ "$1" != en-US ] && return 0; api "$url"; return 1; }
  jq --arg n "$2" '.recentChanges = $n' <<<"$listing" \
    | api -X PUT -H "If-Match: $(etag "$url")" -H 'Content-Type: application/json' \
        --data-binary @- "$url" > /dev/null
}
notes en-US 'Bug fixes and improvements.'
notes fr-FR 'Corrections de bugs et améliorations.'

api -X POST "$APP/edits/$edit/validate" > /dev/null
api -X POST -H "If-Match: $(etag "$APP/edits/$edit")" "$APP/edits/$edit/commit" > /dev/null
echo "$AMAZON_TAG sent to Amazon for review"
