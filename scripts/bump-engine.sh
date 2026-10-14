#!/usr/bin/env bash
# Usage: scripts/bump-engine.sh <version>          rewrite engine.lock and the generated schema (e.g. 0.1.1)
#        scripts/bump-engine.sh --schema <version> regenerate the schema only, from that release (CI)
#        scripts/bump-engine.sh --local <checkout> regenerate the schema from <checkout>/openapi.json
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
schema=backend/src/modules/engine/schema.d.ts

# gen_schema <openapi.json> <label>: the label is the engine version, or `local`.
gen_schema() {
    (cd backend && npx --no-install openapi-typescript "$1" --default-non-nullable=false -o "$tmp/schema.d.ts" >/dev/null)
    { echo "// Generated from fliks-engine openapi.json ($2). Do not edit: run scripts/bump-engine.sh."; cat "$tmp/schema.d.ts"; } > "$schema"
}

release_schema() {
    gh release download "v$1" -R fliks-app/engine -p openapi.json -D "$tmp"
    gen_schema "$tmp/openapi.json" "v$1"
}

case "${1:?usage: bump-engine.sh <version> | --schema <version> | --local <checkout>}" in
--local)
    gen_schema "$(realpath "${2:?checkout path}")/openapi.json" local
    exit 0
    ;;
--schema)
    release_schema "${2#v}"
    exit 0
    ;;
esac

v="${1#v}"
gh release download "v$v" -R fliks-app/engine -p 'fliks-engine-*.sha256' -D "$tmp"

{
    echo "# fliks-app/engine release consumed by the image and the desktop bundles. Bump: scripts/bump-engine.sh"
    echo "version=$v"
    for p in linux-x64 linux-arm64 darwin-arm64 windows-x64; do
        f="$tmp/fliks-engine-$p"; [ "$p" = windows-x64 ] && f="$f.exe"
        echo "sha256_${p//-/_}=$(awk '{print $1}' "$f.sha256")"
    done
} > engine.lock.new
mv engine.lock.new engine.lock
cat engine.lock
release_schema "$v"
