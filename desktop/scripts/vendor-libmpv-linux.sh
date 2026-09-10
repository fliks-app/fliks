#!/usr/bin/env bash
# Bundle the shared libraries the committed libmpv.so.2 links against but a
# stock Ubuntu desktop has no package for, and point every RUNPATH at $ORIGIN.
#
# FFmpeg, libass and libplacebo are static inside that libmpv (av_* hidden) and
# the features that pulled the rest in are off, so only two of its DT_NEEDED
# entries are missing from a stock desktop. See build-libmpv-linux.sh, which
# builds it.
#
# The .debs are downloaded and unpacked, never installed: libjack-jackd2-0
# displaces libjack0 on the runner and takes libmpv-dev out with it, which
# breaks the addon build. Nothing here touches the build machine's package set.
#
# Runs on the Linux CI job before electron-builder (desktop-release.yml). The
# copies are gitignored (native/vendor/* minus libmpv.so.2) and shipped by
# electron-builder's native/vendor/** glob + asarUnpack.
#
# `--print-sonames` lists what ends up bundled, so desktop-release.yml's
# container check and this script never hold two copies of the list.
# Requires patchelf. FLIKS_LIBS_DIR skips the download and resolves from there.
set -euo pipefail

NEEDED_SHA256=0c4cfe086268fa6c89c6907107bb4cb57b06a0faf08ce4a7058585b343a5e607

# Direct DT_NEEDED of libmpv.so.2 that a stock desktop lacks. Regenerate on a
# clean machine: ldd libmpv.so.2 | grep 'not found', unpack the providers,
# repeat until it comes back empty.
LIBS=(
  libva-x11.so.2=libva-x11-2
  libXpresent.so.1=libxpresent1
)

if [ "${1:-}" = "--print-sonames" ]; then
  printf '%s\n' "${LIBS[@]%%=*}"
  exit 0
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-$here/native/vendor}"

command -v patchelf >/dev/null || { echo "::error::patchelf missing (apt-get install patchelf)"; exit 1; }
test -f "$dest/libmpv.so.2" || { echo "::error::vendored libmpv missing at $dest/libmpv.so.2"; exit 1; }

# LIBS was derived by hand from this exact libmpv, so a different one must not
# silently reuse it.
needed="$(patchelf --print-needed "$dest/libmpv.so.2" | LC_ALL=C sort)"
if [ "$(printf '%s\n' "$needed" | sha256sum | cut -d' ' -f1)" != "$NEEDED_SHA256" ]; then
  echo "::error::libmpv.so.2 links a different set of libraries, re-derive LIBS below"
  printf '%s\n' "$needed"
  exit 1
fi

libs_dir="${FLIKS_LIBS_DIR:-}"
if [ -z "$libs_dir" ]; then
  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT
  ( cd "$staging" && apt-get download $(printf '%s\n' "${LIBS[@]#*=}" | sort -u) )
  for deb in "$staging"/*.deb; do dpkg-deb -x "$deb" "$staging/root"; done
  libs_dir="$staging/root/usr/lib/x86_64-linux-gnu"
fi

for entry in "${LIBS[@]}"; do
  so="${entry%%=*}"
  src="$libs_dir/$so"
  [ -e "$src" ] || { echo "::error::$so missing from ${entry#*=} under $libs_dir"; exit 1; }
  cp -fL "$src" "$dest/$so"
  chmod u+w "$dest/$so"
  patchelf --set-rpath '$ORIGIN' "$dest/$so"
done
patchelf --set-rpath '$ORIGIN' "$dest/libmpv.so.2"

# Whether a bundled copy actually wins at load time can only be judged where the
# host lacks these libs, and a non-bundled dep (libarchive) pulls the host's
# libxml2 in under the same SONAME. Assert what is host-independent here;
# desktop-release.yml runs the resolution check in a bare container.
unresolved="$(env -u LD_LIBRARY_PATH ldd "$dest/libmpv.so.2" | grep 'not found' || true)"
[ -z "$unresolved" ] || { echo "::error::unresolved after bundling:"; echo "$unresolved"; exit 1; }
for entry in "${LIBS[@]}"; do
  so="${entry%%=*}"
  [ "$(patchelf --print-rpath "$dest/$so")" = '$ORIGIN' ] \
    || { echo "::error::$so has no \$ORIGIN RUNPATH, it will not find its siblings"; exit 1; }
done

echo "Bundled ${#LIBS[@]} runtime libs ($(du -shc "$dest"/*.so* | tail -1 | cut -f1) total) into $dest"
