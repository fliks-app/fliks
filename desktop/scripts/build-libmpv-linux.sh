#!/usr/bin/env bash
#
# Build desktop/native/vendor/libmpv.so.2 — the runtime libmpv for the Linux
# desktop client. Counterpart of vendor-libmpv-mac.sh.
#
# The build itself is mpv-build, the mpv project's own out-of-tree builder.
# Two constraints drive what we ask of it:
#   • FFmpeg is linked statically with its symbols hidden. Electron ships its own
#     libffmpeg.so; a libmpv that resolves av_* through the process would bind to
#     Chromium's networkless build ("Protocol not found" on every https stream).
#   • Everything whose soname churns between distro releases (libass, libplacebo,
#     libunibreak) is linked statically too, and the features that dragged in the
#     rest (bluray, rubberband, drm/wayland EDID) are off. What stays dynamic is
#     the stable base only: glibc, X11/GL, libva/libdrm, GnuTLS, freetype,
#     fribidi, harfbuzz, alsa, pulse.
#
# Builds in a container, so the host needs nothing but docker. The base image
# sets the glibc floor every user of the .deb / AppImage then needs, which is why
# it is an LTS rather than the newest release; everything that matters is built
# from source on top of it.
#
# Usage:
#   desktop/scripts/build-libmpv-linux.sh
#   BASE=ubuntu:22.04 desktop/scripts/build-libmpv-linux.sh   # lower the floor
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/desktop/native/vendor"
BASE="${BASE:-ubuntu:24.04}"

UNIBREAK_VERSION=6.1
LIBASS_VERSION=0.17.4
LIBPLACEBO_VERSION=v7.351.0
FFMPEG_VERSION=n7.1.1
MPV_VERSION=v0.41.0

echo "==> building libmpv (mpv $MPV_VERSION, ffmpeg $FFMPEG_VERSION) on $BASE"
docker build \
  --file "$ROOT/desktop/scripts/libmpv-linux.Dockerfile" \
  --tag "fliks-libmpv:${MPV_VERSION}-${BASE//[:.]/-}" \
  --build-arg "BASE=$BASE" \
  --build-arg "JOBS=$(nproc)" \
  --build-arg "UNIBREAK_VERSION=$UNIBREAK_VERSION" \
  --build-arg "LIBASS_VERSION=$LIBASS_VERSION" \
  --build-arg "LIBPLACEBO_VERSION=$LIBPLACEBO_VERSION" \
  --build-arg "FFMPEG_VERSION=$FFMPEG_VERSION" \
  --build-arg "MPV_VERSION=$MPV_VERSION" \
  "$ROOT/desktop/scripts"

mkdir -p "$OUT"
cid="$(docker create "fliks-libmpv:${MPV_VERSION}-${BASE//[:.]/-}")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker cp "$cid:/libmpv.so.2" "$OUT/libmpv.so.2.new"

echo "==> verifying"
fail=0
if nm -D "$OUT/libmpv.so.2.new" | grep -q ' av_'; then
  echo "REJECTED: exports FFmpeg symbols — they would clash with Electron's libffmpeg" >&2; fail=1
fi
if ldd "$OUT/libmpv.so.2.new" | grep -q 'not found'; then
  echo "REJECTED: unresolved dependencies on this host:" >&2
  ldd "$OUT/libmpv.so.2.new" | grep 'not found' >&2; fail=1
fi
[ "$fail" = 0 ] || { rm -f "$OUT/libmpv.so.2.new"; exit 1; }

mv "$OUT/libmpv.so.2.new" "$OUT/libmpv.so.2"
chmod 755 "$OUT/libmpv.so.2"
echo "==> $OUT/libmpv.so.2 ($(du -h "$OUT/libmpv.so.2" | cut -f1)), dynamic deps:"
objdump -p "$OUT/libmpv.so.2" | awk '/NEEDED/ {print "    " $2}'
