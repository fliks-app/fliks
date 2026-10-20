#!/usr/bin/env bash
# Checks the vendored libmpv.so.2 is self-contained (no av_* exports, bundled SONAMEs resolve on a clean box).
set -euo pipefail
cd "$(dirname "$0")/../.."
f=desktop/native/vendor/libmpv.so.2
test -f "$f" || { echo "::error::vendored libmpv missing at $f"; exit 1; }
test -z "$(nm -D "$f" 2>/dev/null | grep ' av_')" \
  || { echo "::error::libmpv exports av_*, will clash with Electron's libffmpeg"; exit 1; }
# The bundled copies only prove themselves where the host has none
# of them: here a non-bundled dep (libarchive) pulls the host's
# libxml2 in under the same SONAME. A bare container resolves them
# through $ORIGIN or not at all; its X11, GL and audio entries dangle
# by design, so only the bundled SONAMEs are read.
bash desktop/scripts/vendor-libmpv-linux.sh --print-sonames > /tmp/bundled
docker run --rm -v "$PWD/desktop/native/vendor:/v:ro" ubuntu:24.04 \
  sh -c 'ldd /v/libmpv.so.2' | awk '/not found/ {print $1}' > /tmp/dangling
ours=$(grep -Fxf /tmp/bundled /tmp/dangling || true)
test -z "$ours" || { echo "::error::bundled libs unresolved on a clean box:"; echo "$ours"; exit 1; }
echo "vendored libmpv OK: $(du -sh desktop/native/vendor | cut -f1)"
