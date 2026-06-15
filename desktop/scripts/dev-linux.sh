#!/usr/bin/env bash
#
# Build + launch the Fliks Linux desktop client (Electron + embedded mpv).
#
# Rebuilds the Angular client and the desktop main/preload bundle, kills any
# running instance, then relaunches Electron under XWayland. See
# desktop/CLAUDE.md for the architecture and first-time prerequisites
# (vendored libmpv, native compositor addon, system build deps).
#
# Usage (run from anywhere — paths resolve from the script location):
#   desktop/scripts/dev-linux.sh              # rebuild client + desktop, relaunch
#   desktop/scripts/dev-linux.sh --no-client  # skip the Angular build (desktop-only edits)
#   desktop/scripts/dev-linux.sh --addon      # also rebuild the native C++ compositor addon
#
# Background it (keep the terminal + accumulate logs):
#   desktop/scripts/dev-linux.sh &
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# ng build output-path; Electron reads the client from "$OUT/browser". Lives
# under /tmp because client/dist/ has root-owned PWA assets (EACCES on rebuild).
OUT="/tmp/fliks-verify"

build_client=1
build_addon=0
for arg in "$@"; do
  case "$arg" in
    --no-client) build_client=0 ;;
    --addon)     build_addon=1 ;;
    -h|--help)
      cat >&2 <<'USAGE'
dev-linux.sh — build + launch the Fliks Linux desktop client.

  dev-linux.sh              rebuild client + desktop, then relaunch
  dev-linux.sh --no-client  skip the Angular build (desktop-only edits)
  dev-linux.sh --addon      also rebuild the native C++ compositor addon

Append '&' to background it and keep the logs flowing.
USAGE
      exit 0 ;;
    *) echo "dev-linux: unknown option '$arg'" >&2; exit 2 ;;
  esac
done

# Fail fast on missing native bits — otherwise Electron crashes cryptically.
[ -f "$ROOT/desktop/native/vendor/libmpv.so.2" ] || {
  echo "dev-linux: missing desktop/native/vendor/libmpv.so.2 (vendored, gitignored) — see desktop/CLAUDE.md" >&2; exit 1; }
[ -f "$ROOT/desktop/native/build/Release/fliks_compositor.node" ] || {
  echo "dev-linux: missing native addon — re-run with --addon (or see desktop/CLAUDE.md)" >&2; exit 1; }

if [ "$build_client" = 1 ]; then
  echo "==> [1/3] Angular client → $OUT"
  ( cd "$ROOT/client" && npx ng build --configuration development --output-path "$OUT" )
fi

if [ "$build_addon" = 1 ]; then
  echo "==> native compositor addon (Electron 42 ABI)"
  ( cd "$ROOT/desktop/native" && ../node_modules/.bin/node-gyp rebuild \
      --target=42.4.0 --dist-url=https://electronjs.org/headers --arch=x64 )
fi

# ALWAYS the full build (main AND preload). Building only `build:main` leaves a
# stale preload — `subAdd` goes missing and subtitles silently break on Linux.
echo "==> [2/3] desktop main + preload"
( cd "$ROOT/desktop" && npm run build )

echo "==> [3/3] relaunch Electron"
pkill -x electron 2>/dev/null || true

cd "$ROOT/desktop"
# DISPLAY=:0 forces XWayland — the OSR compositor doesn't run on native Wayland.
FLIKS_WEB_DIR="$OUT/browser" DISPLAY="${DISPLAY:-:0}" \
  exec ./node_modules/.bin/electron . --no-sandbox
