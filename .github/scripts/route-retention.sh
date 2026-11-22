#!/usr/bin/env bash
# Fails when an operation of the previous release's openapi.json is missing from the current one and is not
# listed in server/wire-breaks.txt (a reviewed list of deliberate removals), or when a listed line is for an
# operation the release does not have (a line that exempts nothing and would hide a later re-removal).
set -euo pipefail
export LC_ALL=C # jq sorts by codepoint, comm needs the same order
ops='[.paths | to_entries[] | .key as $p | .value | keys[] | select(IN("get","put","post","delete","patch","head","options")) | "\(ascii_upcase) \($p)"] | sort | .[]'
allowed=${3:-"$(dirname "$0")/../../server/wire-breaks.txt"}
listed=$(sed -e '/^#/d' -e '/^[[:space:]]*$/d' "$allowed" | sort)
gone=$(comm -23 <(jq -r "$ops" "$1") <(jq -r "$ops" "$2") | comm -23 - <(echo "$listed"))
stale=$(comm -13 <(jq -r "$ops" "$1") <(echo "$listed"))
[ -z "$gone" ] || { echo "Operations removed since the last release:" >&2; echo "$gone" >&2; }
[ -z "$stale" ] || { echo "Lines of wire-breaks.txt the last release does not serve, delete them:" >&2; echo "$stale" >&2; }
[ -z "$gone$stale" ]
