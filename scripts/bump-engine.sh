#!/usr/bin/env bash
# Usage: scripts/bump-engine.sh <version>          rewrite engine.lock, the Dockerfile engine image (tag + digest) and the server's engine tag (e.g. 0.4.1)
#        scripts/bump-engine.sh --local <checkout> patch the server's engine crate to <checkout> (untracked server/.cargo/config.toml)
#                                          (needs `cargo update -p fliks-engine-core`; never commit the patched Cargo.lock)
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

case "${1:?usage: bump-engine.sh <version> | --local <checkout>}" in
--local)
    co="$(realpath "${2:?checkout path}")"
    mkdir -p server/.cargo
    cat > server/.cargo/config.toml <<EOT
[patch."https://github.com/fliks-app/engine"]
fliks-engine-core = { path = "$co/crates/core" }
EOT
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
digest="$(docker buildx imagetools inspect "ghcr.io/fliks-app/engine:$v" --format '{{.Manifest.Digest}}')"
sed -i "s|^ARG ENGINE_IMAGE=.*|ARG ENGINE_IMAGE=ghcr.io/fliks-app/engine:$v@$digest|" Dockerfile
sed -i -E "s|(fliks-engine-core = \{ git = [^}]*tag = )\"v[^\"]*\"|\1\"v$v\"|" server/crates/server/Cargo.toml
(cd server && cargo update -p fliks-engine-core)
(cd server/crates/plugin-sdk && cargo update -p fliks-engine-core)
cat engine.lock
