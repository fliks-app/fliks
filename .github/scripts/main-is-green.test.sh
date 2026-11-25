#!/usr/bin/env bash
# Self-test of main-is-green.sh with a stub `gh`: `run list` answers "<status> <conclusion>" per commit from
# $STUB/run.<sha>, `api compare` answers the next commit from $STUB/next.<sha>; a missing file answers empty.
cd "$(dirname "$0")" || exit 1
stub=$(mktemp -d)
trap 'rm -rf "$stub"' EXIT
cat > "$stub/gh" <<'SH'
#!/bin/bash
if [ "$1" = run ]; then
  while [ $# -gt 0 ]; do [ "$1" = --commit ] && sha=$2; shift; done
  cat "$STUB/run.$sha" 2>/dev/null
else
  sha=${2#*compare/}; cat "$STUB/next.${sha%%...*}" 2>/dev/null
fi
exit 0
SH
chmod +x "$stub/gh"
n=0
# case_ <ok|bad> <name> [<sha>=<reply> | <sha>-><next>]...: the gate runs from `a`, stopping at $UNTIL when set.
case_() {
  local want=$1 name=$2 got=0 kv; shift 2
  rm -f "$stub"/run.* "$stub"/next.*
  for kv in "$@"; do
    if [[ $kv == *'->'* ]]; then echo "${kv#*->}" > "$stub/next.${kv%%->*}"; else echo "${kv#*=}" > "$stub/run.${kv%%=*}"; fi
  done
  STUB=$stub PATH="$stub:$PATH" TRIES=6 DELAY=0 ./main-is-green.sh a ${UNTIL:-} >/dev/null 2>&1 || got=1
  [[ $want == bad && $got == 1 || $want == ok && $got == 0 ]] || { echo "FAIL ($want): $name"; n=1; }
}
case_ ok "parent success" "a=completed success"
case_ bad "parent failure" "a=completed failure"
case_ bad "parent timed out" "a=completed timed_out"
case_ bad "parent in progress" "a=in_progress none"
case_ bad "no run" "a=none none"
case_ bad "empty answer" "a="
case_ bad "no answer at all"
case_ bad "unknown conclusion" "a=completed startup_failure"
case_ ok "parent cancelled, next success" "a=completed cancelled" a-\>b "b=completed success"
case_ ok "parent cancelled, release commit success" "a=completed cancelled" a-\>r "r=completed success"
case_ ok "parent cancelled, next skipped, then success" "a=completed cancelled" a-\>b b-\>c "b=completed skipped" "c=completed success"
case_ bad "parent cancelled, nothing after" "a=completed cancelled"
case_ bad "parent cancelled, next still running" "a=completed cancelled" a-\>b "b=in_progress none"
case_ bad "parent cancelled, release cancelled, nothing after" "a=completed cancelled" a-\>r r-\>x "r=completed cancelled"
case_ bad "parent cancelled, next failure" "a=completed cancelled" a-\>b "b=completed failure"
case_ bad "parent cancelled, next cancelled, then failure" "a=completed cancelled" a-\>b b-\>c "b=completed cancelled" "c=completed failure"
UNTIL=r case_ bad "stops at the release commit" "a=completed cancelled" a-\>r r-\>x "r=completed cancelled" "x=completed success"
UNTIL=r case_ ok "release commit success" "a=completed cancelled" a-\>r "r=completed success"
# A failing `gh` is polled again, not fatal: the first call fails, the second succeeds.
printf '#!/bin/sh\nf=%s/n\nif [ -e "$f" ]; then echo "completed success"; else touch "$f"; exit 1; fi\n' "$stub" > "$stub/gh"
PATH="$stub:$PATH" TRIES=3 DELAY=0 ./main-is-green.sh a >/dev/null 2>&1 || { echo "FAIL: transient gh error"; n=1; }
exit $n
