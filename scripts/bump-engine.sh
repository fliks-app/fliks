#!/usr/bin/env bash
# Usage: scripts/bump-engine.sh <version>   (e.g. 0.1.1) — rewrites engine.lock from the release's .sha256 assets.
set -euo pipefail
v="${1:?usage: bump-engine.sh <version>}"
v="${v#v}"
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

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
