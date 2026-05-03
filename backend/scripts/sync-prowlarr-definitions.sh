#!/usr/bin/env bash
# Télécharge les définitions Prowlarr v11 (source: https://github.com/Prowlarr/Indexers/tree/master/definitions/v11 )
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/assets/prowlarr-definitions/v11"
TMP="${TMPDIR:-/tmp}/Prowlarr-Indexers-$$"
mkdir -p "$DEST"
rm -rf "$TMP"
git clone --depth 1 https://github.com/Prowlarr/Indexers.git "$TMP"
cp "$TMP/definitions/v11/"*.yml "$DEST/"
rm -rf "$TMP"
echo "Copied $(ls -1 "$DEST"/*.yml 2>/dev/null | wc -l) definitions into $DEST"
