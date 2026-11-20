#!/usr/bin/env bash
# Checks the vendored libmpv.dylib is self-contained and exports only mpv_*.
set -euo pipefail
cd "$(dirname "$0")/../.."
f=desktop/native/vendor/libmpv.dylib
test -f "$f" || { echo "::error::vendored libmpv.dylib missing at $f"; exit 1; }
# Electron bundles its own libffmpeg.dylib: libmpv must export nothing but mpv_*.
other=$(nm -gU "$f" | awk '$2 ~ /^[TDSBR]$/ && $3 !~ /^_mpv_/' || true)
test -z "$other" || { echo "::error::libmpv exports non-mpv symbols:"; echo "$other" | head; exit 1; }
# The dylib links system libraries and frameworks only.
stray=$(otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/|@loader_path/libmpv\.dylib)' || true)
test -z "$stray" || { echo "::error::non-system dependencies:"; echo "$stray"; exit 1; }
# FFmpeg must be the LGPL build (no x264/x265/GPL-only code).
if strings "$f" | grep -E -- '--enable-(gpl|nonfree|version3)' >/dev/null; then
  echo "::error::libmpv's FFmpeg is not an LGPL-2.1 build"; exit 1
fi
echo "vendored libmpv OK: $(du -sh "$f" | cut -f1)"
