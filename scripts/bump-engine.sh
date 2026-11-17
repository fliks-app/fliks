#!/usr/bin/env bash
# Usage: scripts/bump-engine.sh <version>   rewrite engine.lock, the Dockerfile engine image (tag + digest) and the server's engine tag (e.g. 0.4.1)
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

v="${1:?usage: bump-engine.sh <version>}"
v="${v#v}"
gh release download "v$v" -R fliks-app/engine -p 'fliks-engine-*.sha256' -D "$tmp"

{
    echo "# fliks-app/engine release consumed by the image and the desktop bundles. Bump: scripts/bump-engine.sh"
    echo "version=$v"
    for p in linux-x64 linux-arm64 darwin-arm64 windows-x64; do
        f="$tmp/fliks-engine-$p"; [ "$p" = windows-x64 ] && f="$f.exe"
        echo "sha256_${p//-/_}=$(awk '{print $1}' "$f.sha256")"
    done
    for p in darwin-arm64 windows-x64; do
        echo "sha256_karaoke_${p//-/_}=$(awk '{print $1}' "$tmp/fliks-engine-karaoke-$p".*.sha256)"
    done
} > engine.lock.new
mv engine.lock.new engine.lock
digest="$(docker buildx imagetools inspect "ghcr.io/fliks-app/engine:$v" --format '{{.Manifest.Digest}}')"
sed -i "s|^ARG ENGINE_IMAGE=.*|ARG ENGINE_IMAGE=ghcr.io/fliks-app/engine:$v@$digest|" Dockerfile
sed -i -E "s|(fliks-engine-core = \{ git = [^}]*tag = )\"v[^\"]*\"|\1\"v$v\"|" server/crates/server/Cargo.toml
(cd server && cargo update -p fliks-engine-core)
(cd server/crates/plugin-sdk && cargo update -p fliks-engine-core)
cat engine.lock
