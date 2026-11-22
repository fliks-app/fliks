#!/usr/bin/env bash
# Self-test of main-is-green.sh with a stub `gh` answering one canned line.
cd "$(dirname "$0")" || exit 1
stub=$(mktemp -d)
trap 'rm -rf "$stub"' EXIT
printf '#!/bin/sh\necho "$STUB"\n' > "$stub/gh"
chmod +x "$stub/gh"
n=0
case_() {
  local want=$1 reply=$2 got=0
  STUB=$reply PATH="$stub:$PATH" TRIES=2 DELAY=0 ./main-is-green.sh abc >/dev/null 2>&1 || got=1
  [[ $want == bad && $got == 1 || $want == ok && $got == 0 ]] || { echo "FAIL ($want): $reply"; n=1; }
}
case_ ok "completed success"
case_ bad "completed failure"
case_ bad "completed cancelled"
case_ bad "in_progress none"
case_ bad "none none"
case_ bad ""
# A failing `gh` is polled again, not fatal: the first call fails, the second succeeds.
printf '#!/bin/sh\nf=%s/n\nif [ -e "$f" ]; then echo "completed success"; else touch "$f"; exit 1; fi\n' "$stub" > "$stub/gh"
PATH="$stub:$PATH" TRIES=3 DELAY=0 ./main-is-green.sh abc >/dev/null 2>&1 || { echo "FAIL: transient gh error"; n=1; }
exit $n
