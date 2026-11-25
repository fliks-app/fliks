#!/usr/bin/env bash
# Waits for the push run of ci.yml on a main commit; succeeds only if it succeeded. A run that ended cancelled
# (superseded) or skipped is not decisive: the next main commit's run decides, up to $2 (default main's tip).
# Any other conclusion fails; so do an unknown or empty answer and no decisive run within the budget.
set -uo pipefail
cur=$1 until=${2:-}
for _ in $(seq "${TRIES:-120}"); do
  out=$(gh run list --workflow ci.yml --branch main --event push --commit "$cur" \
    --json status,conclusion --jq '.[0] // {} | "\(.status // "none") \(.conclusion // "none")"' 2>/dev/null) || out=
  read -r status conclusion <<< "$out"
  if [ "${status:-}" = completed ]; then
    case "$conclusion" in
      success) exit 0 ;;
      cancelled | skipped)
        if [ "$cur" != "$until" ]; then
          next=$(gh api "repos/{owner}/{repo}/compare/$cur...main" --jq '.commits[0].sha // empty' 2>/dev/null) || next=
          if [ -n "$next" ]; then
            echo "ci.yml on main@$cur concluded: $conclusion, following main@$next" >&2
            cur=$next
            continue
          fi
        fi
        ;;
      *)
        echo "ci.yml on main@$cur concluded: $conclusion" >&2
        exit 1
        ;;
    esac
  fi
  sleep "${DELAY:-30}"
done
echo "no decisive ci.yml run on main from $1 (stopped at $cur)" >&2
exit 1
