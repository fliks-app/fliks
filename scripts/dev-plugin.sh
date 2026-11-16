#!/usr/bin/env bash
# Build a plugin from a local checkout and import it on the dev stack (docs/plugins.md).
set -euo pipefail

repo=${1:?usage: dev-plugin.sh <plugin-repo-dir> [<plugin-folder>]}
folder=${2:-.}
url=${FLIKS_URL:-http://localhost:4500}
user=${FLIKS_USER:-admin}
pass=${FLIKS_PASSWORD:-password}

case $url in
  http://localhost[:/]* | http://localhost | http://127.0.0.1[:/]* | http://127.0.0.1) ;;
  *) [ "${FLIKS_ALLOW_REMOTE:-}" = 1 ] || { echo "refusing non-local $url (FLIKS_ALLOW_REMOTE=1 to force)" >&2; exit 1; } ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export CARGO_TARGET_DIR=$HOME/.cache/fliks-targets/dev-plugin
echo "target dir: $CARGO_TARGET_DIR (delete it when done)" >&2
(cd "$repo" && fliks-heavy cargo xtask package "$folder" --max-mib 12 --out "$tmp/dist") >&2
archive=$(ls "$tmp"/dist/*.fkplugin)

jar=$tmp/jar
curl -sS --fail-with-body -c "$jar" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$user" --arg p "$pass" '{username:$u,password:$p}')" "$url/api/auth/login" >&2
inspected=$(curl -sS --fail-with-body -b "$jar" -c "$jar" -F "file=@$archive" "$url/api/plugins/import/inspect")
curl -sS --fail-with-body -b "$jar" -c "$jar" -H 'Content-Type: application/json' \
  -d "$(jq '{stagingId, sha256}' <<<"$inspected")" "$url/api/plugins/import/confirm" |
  jq '{pluginId, version, status}'
