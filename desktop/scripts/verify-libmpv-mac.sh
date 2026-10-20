#!/usr/bin/env bash
# Checks the vendored libmpv.dylib is self-contained (no _av_ exports, no stray deps).
set -euo pipefail
cd "$(dirname "$0")/../.."
f=desktop/native/vendor/libmpv.dylib
test -f "$f" || { echo "::error::vendored libmpv.dylib missing at $f"; exit 1; }
# libmpv must export no FFmpeg symbols (else it clashes with Electron's
# bundled libffmpeg.dylib) — the macOS analogue of the Linux av_* check.
test -z "$(nm -gU "$f" 2>/dev/null | grep ' _av_')" \
  || { echo "::error::libmpv exports _av_ — not self-contained"; exit 1; }
# nothing in the tree may point outside @loader_path + the system dirs.
stray=$(otool -L desktop/native/vendor/*.dylib | grep -E '/opt/homebrew|/usr/local' || true)
test -z "$stray" || { echo "::error::stray non-bundled deps:"; echo "$stray"; exit 1; }
echo "vendored libmpv OK: $(du -sh desktop/native/vendor | cut -f1)"
