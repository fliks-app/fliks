#!/usr/bin/env bash
# Fails when an operation of the previous release's openapi.json is missing from the current one and is not
# listed in server/wire-breaks.txt (a reviewed list of deliberate removals).
set -euo pipefail
export LC_ALL=C # jq sorts by codepoint, comm needs the same order
ops='[.paths | to_entries[] | .key as $p | .value | keys[] | select(IN("get","put","post","delete","patch","head","options")) | "\(ascii_upcase) \($p)"] | sort | .[]'
allowed=${3:-"$(dirname "$0")/../../server/wire-breaks.txt"}
gone=$(comm -23 <(jq -r "$ops" "$1") <(jq -r "$ops" "$2") | comm -23 - <(sed -e '/^#/d' -e '/^[[:space:]]*$/d' "$allowed" | sort))
[ -z "$gone" ] || { echo "Operations removed since the last release:" >&2; echo "$gone" >&2; exit 1; }
