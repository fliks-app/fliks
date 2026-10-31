#!/usr/bin/env bash
# One command for the whole parity suite: builds, starts every stub/fixture/engine/target it needs, runs each
# scenario group in each mode, prints one table, tears everything down. Usage: server/parity/run-all.sh [filter]
# Ports 4960-4999 are reserved: 4960 arr stub, 4961 livetv fixture, 4962 emby stub, 4963 engine stub,
# 4964 provider stub, 4965 engine, 4966 fliks-server.
set -uo pipefail

SERVER=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(dirname "$SERVER")
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$SERVER/target}
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4} SQLX_OFFLINE=true
RUN=$CARGO_TARGET_DIR/run-all
export FLIKS_PARITY_ROOT=$RUN/root # media and fixtures of this run only; other runs keep /tmp/fliks-parity
DBPFX=${PARITY_DB_PREFIX:-pall_}
HEAVY=${HEAVY:-fliks-heavy}
FILTER=${1:-}
export PARITY_PG=${PARITY_PG:-fliks-postgres-1} # the PostgreSQL container the run creates its databases in
PG=$PARITY_PG
P_ARR=4960 P_LIVETV=4961 P_EMBY=4962 P_ESTUB=4963 P_PROV=4964 P_ENGINE=4965 P_TARGET=4966
PIDS=()

log() { echo "[run-all] $*" >&2; }
die() { log "$*"; exit 2; }

psql_admin() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 -q "$@"' _ "$@"; }

stop_all() {
  local p
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null; done
  sleep 1
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null; done
  PIDS=()
}
cleanup() {
  trap - EXIT INT TERM
  stop_all
  psql_admin -d postgres -At -c "SELECT datname FROM pg_database WHERE datname LIKE '${DBPFX//_/\\_}%'" 2>/dev/null |
    while read -r d; do psql_admin -d postgres -c "DROP DATABASE IF EXISTS \"$d\" WITH (FORCE)" </dev/null 2>/dev/null; done
}
trap 'exit 130' INT TERM

# start <name> <cwd> <cmd...>: own process group (setsid), no inherited lock fd; the group id is recorded for teardown.
start() {
  local name=$1 dir=$2; shift 2
  (cd "$dir" && exec setsid "$@" >"$RUN/$name.log" 2>&1 3>&- </dev/null) &
  PIDS+=($!)
}
wait_http() { # wait_http <url> [seconds]
  local i
  for i in $(seq "${2:-60}"); do curl -s -o /dev/null "$1" && return 0; sleep 1; done
  return 1
}

# ---- preconditions ----
for t in docker ffmpeg python3 node curl sha256sum; do command -v "$t" >/dev/null || die "missing tool: $t"; done
docker exec "$PG" true 2>/dev/null || die "docker container $PG is not running"
for p in $P_ARR $P_LIVETV $P_EMBY $P_ESTUB $P_PROV $P_ENGINE $P_TARGET; do
  ss -ltn | grep -q "[:.]$p " && die "port $p is in use (4960-4999 are reserved for run-all.sh)"
done
trap cleanup EXIT # only now: a second run stopped by the port check must not drop the first run's databases
mkdir -p "$RUN"
export PATH=$SERVER/parity/bin:$PATH # pg_dump/psql run inside the postgres container
rm -rf "$RUN"/{target-*,*.log}

# ---- build once ----
log "building fliks-server (parity feature) and the parity runner"
(cd "$SERVER" && $HEAVY cargo build -p fliks-server --features parity) || die "cargo build failed"
TESTEXE=$(cd "$SERVER" && $HEAVY cargo test -p fliks-server --features parity --test it --no-run --message-format=json 2>/dev/null |
  python3 -c 'import sys,json
for l in sys.stdin:
    try: m=json.loads(l)
    except ValueError: continue
    if m.get("executable") and m.get("target",{}).get("name")=="it": print(m["executable"])' | tail -1)
[ -x "$TESTEXE" ] || die "parity runner binary not found"
BIN=$CARGO_TARGET_DIR/debug/fliks-server

# ---- engine: the pinned release, checked against engine.lock ----
ENGVER=${PARITY_ENGINE_VERSION:-$(sed -n 's/^version=//p' "$ROOT/engine.lock")}
ENGSHA=$(sed -n 's/^sha256_linux_x64=//p' "$ROOT/engine.lock")
ENGURL=https://github.com/fliks-app/engine/releases/download/v$ENGVER
# another version (PARITY_ENGINE_VERSION) is checked against the sha256 published with that release
[ "$ENGVER" = "$(sed -n 's/^version=//p' "$ROOT/engine.lock")" ] || ENGSHA=$(curl -fsSL "$ENGURL/fliks-engine-linux-x64.sha256" | cut -d' ' -f1)
ENGBIN=$CARGO_TARGET_DIR/engine-$ENGVER
if [ ! -x "$ENGBIN" ]; then
  log "downloading engine v$ENGVER"
  curl -fsSL -o "$ENGBIN.tmp" "$ENGURL/fliks-engine-linux-x64" || die "engine download failed"
  [ "$(sha256sum "$ENGBIN.tmp" | cut -d' ' -f1)" = "$ENGSHA" ] || die "engine sha256 differs from engine.lock"
  chmod +x "$ENGBIN.tmp" && mv "$ENGBIN.tmp" "$ENGBIN"
fi

# ---- media, database template ----
"$SERVER/parity/media-gen.sh" || die "media-gen failed"
TPL=${DBPFX}tpl
DB=${DBPFX}run
psql_admin -d postgres -c "DROP DATABASE IF EXISTS $TPL WITH (FORCE)" -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $TPL" || die "template db"
sed "s|/tmp/fliks-parity|$FLIKS_PARITY_ROOT|g" "$SERVER/parity/seed/base.sql" | psql_admin -d "$TPL" >/dev/null || die "base.sql"
DBHOST=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PG")
DBUSER=$(docker exec "$PG" sh -c 'printf %s "$POSTGRES_USER"')
DBPASS=$(docker exec "$PG" sh -c 'printf %s "$POSTGRES_PASSWORD"')
# scenario databases are copies of the template: bring it to the current schema once
env -u DATABASE_URL DB_HOST=$DBHOST DB_PORT=5432 DB_USERNAME=$DBUSER DB_PASSWORD=$DBPASS DB_NAME=$TPL "$BIN" migrate || die "migrating the template"

# ---- stubs that live for the whole run ----
start arr-stub "$SERVER/parity/stubs" env ARR_STUB_PORT=$P_ARR node arr-stub.mjs
start emby-stub "$SERVER/parity/stubs" node emby-stub.mjs $P_EMBY
start engine-stub "$SERVER/parity/stubs" node engine-stub.mjs $P_ESTUB
start provider-stub "$SERVER/parity/external" python3 stub.py $P_PROV
start livetv-fixture "$SERVER/parity/external/livetv" python3 server.py $P_LIVETV
for p in $P_ARR $P_EMBY $P_ESTUB $P_PROV $P_LIVETV; do wait_http "http://127.0.0.1:$p/" 20 || die "stub on $p did not start (see $RUN/*.log)"; done

# ---- modes ----
SUMMARY=()
FAILED=0
run_mode() { # run_mode <engine up|down|stub> <providers 0|1> <filter>
  local engine=$1 prov=$2 filter=$3 tag=$1/prov$2 d=$RUN/target-$1-$2
  local ENG_URL="" ENG_TOK="" HOST_TOK=""
  log "mode engine=$engine providers=$prov"
  rm -rf "$d" "$FLIKS_PARITY_ROOT/data"; mkdir -p "$d"/{conf,cache,runtime}
  "$SERVER/parity/media-gen.sh" || { SUMMARY+=("$tag|ERROR|0|0|media-gen"); FAILED=1; return; }
  case $engine in
    up)
      mkdir -p "$d/engine"
      start "engine-$1-$2" "$d" env FLIKS_ENGINE_TOKEN=pall-engine ENGINE_DATA_DIR="$d/engine/data" \
        FLIKS_CACHE_DIR="$d/engine/cache" FLIKS_TRANSCODE_DIR="$d/engine/transcode" "$ENGBIN" --listen 127.0.0.1:$P_ENGINE
      wait_http "http://127.0.0.1:$P_ENGINE/v1/hello" 20 || { log "engine did not start"; SUMMARY+=("$tag|ERROR|0|0|engine"); FAILED=1; stop_all_but_stubs; return; }
      ENG_URL=http://127.0.0.1:$P_ENGINE ENG_TOK=pall-engine ;;
    stub) ENG_URL=http://127.0.0.1:$P_ESTUB ENG_TOK=stub ;;
  esac
  local penv=(DB_HOST=$DBHOST DB_PORT=5432 DB_USERNAME=$DBUSER DB_PASSWORD=$DBPASS DB_NAME=$DB
    PORT=$P_TARGET JWT_SECRET=parity-secret FLIKS_PLUGINS_DISABLED=1 FLIKS_DISABLE_UPDATE_CHECK=1
    FLIKS_CAST_DIR="$ROOT/server/public" RUST_LOG=info
    FLIKS_CONF_DIR="$d/conf" FLIKS_DATA_DIR="$FLIKS_PARITY_ROOT/data" FLIKS_CACHE_DIR="$d/cache" FLIKS_RUNTIME_DIR="$d/runtime"
    FLIKS_ENGINE_URL=$ENG_URL FLIKS_ENGINE_TOKEN=$ENG_TOK)
  # provider hosts are the stub in every mode, so a keyless run never leaves loopback
  penv+=(FLIKS_TMDB_API_URL=http://127.0.0.1:$P_PROV/tmdb/3 FLIKS_TVDB_API_URL=http://127.0.0.1:$P_PROV/tvdb/v4
    FLIKS_TMDB_IMAGE_URL=http://127.0.0.1:$P_PROV/img/t/p FLIKS_SUBTITLE_PROVIDERS_URL=http://127.0.0.1:$P_PROV)
  [ "$prov" = 1 ] && penv+=(TMDB_API_KEY=tmdb-parity TVDB_API_KEY=tvdb-parity)
  psql_admin -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $TPL"
  start "target-$1-$2" "$d" env -u TMDB_API_KEY -u TVDB_API_KEY -u DATABASE_URL -u INVOCATION_ID -u pm_id -u FLIKS_SUPERVISED "${penv[@]}" "$BIN"
  if ! wait_http "http://127.0.0.1:$P_TARGET/api/auth/login" 90; then
    log "target did not start, see $RUN/target-$1-$2.log"; SUMMARY+=("$tag|ERROR|0|0|target"); FAILED=1
    stop_all_but_stubs; return
  fi
  if [ "$engine" = up ]; then
    sleep 2
    HOST_TOK=$(curl -s -H "Authorization: Bearer $ENG_TOK" "$ENG_URL/v1/config" |
      python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("hostToken") or d.get("host_token") or "")')
  fi
  local out=$RUN/result-$1-$2.log
  # own group like the stubs: a background job ignores SIGINT, so Ctrl-C alone would orphan it
  (cd "$SERVER" && exec setsid env CARGO_MANIFEST_DIR="$SERVER/crates/server" PARITY_TARGET=http://127.0.0.1:$P_TARGET PARITY_DB=$DB PARITY_TPL=$TPL \
    PARITY_ENGINE=$engine PARITY_PROVIDERS=$prov PARITY_STUB=http://127.0.0.1:$P_PROV PARITY_HOST_TOKEN="$HOST_TOK" \
    PARITY_FRONT=$ENG_URL PARITY_LIVETV=http://127.0.0.1:$P_LIVETV PARITY_FILTER="$filter" \
    "$TESTEXE" parity::parity --ignored --nocapture) >"$out" 2>&1 3>&- </dev/null &
  PIDS+=($!)
  wait $!
  local rc=$? line ok failed skipped
  line=$(grep -E '^parity: [0-9]+ passed' "$out" | tail -1)
  ok=$(sed -n 's/^parity: \([0-9]*\) passed.*/\1/p' <<<"$line"); failed=$(sed -n 's/.* \([0-9]*\) failed.*/\1/p' <<<"$line")
  skipped=$(sed -n 's/.* \([0-9]*\) skipped.*/\1/p' <<<"$line")
  if [ -z "$line" ]; then SUMMARY+=("$tag|ERROR|0|0|runner crashed rc=$rc"); FAILED=1
  else
    SUMMARY+=("$tag|$ok|${failed:-0}|${skipped:-0}|")
    [ "${failed:-0}" != 0 ] || [ "$rc" != 0 ] && FAILED=1
  fi
  grep -E '^FAIL' "$out" | cut -c1-400 >&2
  stop_all_but_stubs
}

# keeps the long-lived stubs (first 5 pids), stops the per-mode engine/target
stop_all_but_stubs() {
  local keep=("${PIDS[@]:0:5}") p
  for p in "${PIDS[@]:5}"; do kill -TERM -- "-$p" 2>/dev/null; done
  sleep 1
  for p in "${PIDS[@]:5}"; do kill -KILL -- "-$p" 2>/dev/null; done
  PIDS=("${keep[@]}")
}

# PARITY_MODES limits the modes, e.g. "up0 down1" (default: all)
want() { [[ " ${PARITY_MODES:-up0 down0 stub0 up1 down1} " == *" $1 "* ]]; }
want up0 && run_mode up 0 "$FILTER"
want down0 && run_mode down 0 "$FILTER"
want stub0 && run_mode stub 0 "${FILTER:-scenarios/markers/}"
want up1 && run_mode up 1 "$FILTER"
want down1 && run_mode down 1 "$FILTER"

echo
printf '%-14s %8s %8s %8s  %s\n' MODE PASSED FAILED SKIPPED NOTE
for r in "${SUMMARY[@]}"; do IFS='|' read -r a b c d e <<<"$r"; printf '%-14s %8s %8s %8s  %s\n' "$a" "$b" "$c" "$d" "$e"; done
echo "logs: $RUN"
[ "$FAILED" = 0 ] && echo "parity: ALL GREEN" || echo "parity: FAILURES"
exit $FAILED
