#!/usr/bin/env bash
# Waits for the push run of ci.yml on a main commit; succeeds only if it succeeded. A failed `gh` call
# or an empty answer counts as unknown and is polled again. A run superseded while pending ends
# "cancelled": re-run it (`gh run rerun`) once main is green, the gate fails closed meanwhile.
set -uo pipefail
sha=$1
for _ in $(seq "${TRIES:-120}"); do
  out=$(gh run list --workflow ci.yml --branch main --event push --commit "$sha" \
    --json status,conclusion --jq '.[0] // {} | "\(.status // "none") \(.conclusion // "none")"' 2>/dev/null) || out=
  read -r status conclusion <<< "$out"
  if [ "${status:-}" = completed ]; then
    [ "$conclusion" = success ] && exit 0
    echo "ci.yml on main@$sha concluded: $conclusion" >&2
    exit 1
  fi
  sleep "${DELAY:-30}"
done
echo "ci.yml on main@$sha has not finished" >&2
exit 1
