#!/usr/bin/env bash
# engine.lock, the Dockerfile image (tag and digest), the engine crate tag and both Cargo.lock files
# must name the same engine release, and engine.lock's checksums must be the release's.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "::error::$*"; exit 1; }

v="$(sed -n 's/^version=//p' engine.lock)"
t="$(sed -n 's/^fliks-engine-core = .*tag = "v\([^"]*\)".*/\1/p' server/crates/server/Cargo.toml)"
[ "$t" = "$v" ] || fail "fliks-engine-core tag is v$t, engine.lock says v$v"

img="$(sed -n 's|^ARG ENGINE_IMAGE=||p' Dockerfile)"
[[ "$img" =~ ^ghcr\.io/fliks-app/engine:([^@]+)@(sha256:[0-9a-f]{64})$ ]] \
    || fail "Dockerfile ENGINE_IMAGE must be ghcr.io/fliks-app/engine:<version>@sha256:<digest>, got $img"
[ "${BASH_REMATCH[1]}" = "$v" ] || fail "Dockerfile ENGINE_IMAGE is ${BASH_REMATCH[1]}, engine.lock says $v"
digest="${BASH_REMATCH[2]}"
actual="$(docker buildx imagetools inspect "ghcr.io/fliks-app/engine:$v" --format '{{.Manifest.Digest}}')"
[ "$actual" = "$digest" ] || fail "ghcr.io/fliks-app/engine:$v is $actual, Dockerfile pins $digest"

for lock in server/Cargo.lock server/crates/plugin-sdk/Cargo.lock; do
    grep -q "^source = \"git+https://github.com/fliks-app/engine?tag=v$v#" "$lock" \
        || fail "$lock does not resolve fliks-engine-core at v$v (cargo update -p fliks-engine-core)"
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh release download "v$v" -R fliks-app/engine -p 'fliks-engine-*.sha256' -D "$tmp"
for p in linux-x64 linux-arm64 darwin-arm64 windows-x64; do
    f="$tmp/fliks-engine-$p"; [ "$p" = windows-x64 ] && f="$f.exe"
    want="$(awk '{print $1}' "$f.sha256")"
    have="$(sed -n "s/^sha256_${p//-/_}=//p" engine.lock)"
    [ "$have" = "$want" ] || fail "engine.lock sha256_${p//-/_} is $have, the release has $want"
done
