#!/usr/bin/env bash
# Bundle the shared libraries the committed libmpv.so.2 links against but a
# stock Ubuntu desktop has no package for, and point every RUNPATH at $ORIGIN.
#
# Only FFmpeg is static inside that libmpv (av_* hidden); it still carries 50
# DT_NEEDED entries. Shipping the gap as deb `depends:` is not an option: the
# lib is built on noble, and four of its SONAMEs (unibreak.so.5, rubberband.so.2,
# bluray.so.2, display-info.so.1) are packaged by no later Ubuntu.
#
# Runs on the Linux CI job before electron-builder (desktop-release.yml). The
# copies are gitignored (native/vendor/* minus libmpv.so.2) and shipped by
# electron-builder's native/vendor/** glob + asarUnpack.
#
# Requires patchelf and the libs themselves (libmpv-dev pulls them all in).
# LD_LIBRARY_PATH, when set, is searched before the ld cache.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-$here/native/vendor}"

NEEDED_SHA256=3c2b1487fd5105b0c02ec86fc2847cedae584574c1469866ec8ab7562ccbe804

# Direct DT_NEEDED of libmpv.so.2 that a stock desktop lacks, plus what those
# drag in (dvdnav to dvdread to udfread, bluray to xml2 to icu, rubberband to
# fftw3). Regenerate on a clean machine: ldd libmpv.so.2 | grep 'not found',
# install the providers, repeat until it comes back empty.
SONAMES=(
  libunibreak.so.5 libva-x11.so.2 libvdpau.so.1 libdvdnav.so.4
  libsndio.so.7 libbluray.so.2 librubberband.so.2 libzimg.so.2
  libjack.so.0 libdisplay-info.so.1 libsixel.so.1 libXpresent.so.1
  libdvdread.so.8 libudfread.so.0 libxml2.so.2 libfftw3.so.3
  libicuuc.so.74 libicudata.so.74
)

command -v patchelf >/dev/null || { echo "::error::patchelf missing (apt-get install patchelf)"; exit 1; }
test -f "$dest/libmpv.so.2" || { echo "::error::vendored libmpv missing at $dest/libmpv.so.2"; exit 1; }

# SONAMES was derived by hand from this exact libmpv, so a different one must
# not silently reuse it.
needed="$(patchelf --print-needed "$dest/libmpv.so.2" | LC_ALL=C sort)"
if [ "$(printf '%s\n' "$needed" | sha256sum | cut -d' ' -f1)" != "$NEEDED_SHA256" ]; then
  echo "::error::libmpv.so.2 links a different set of libraries, re-derive SONAMES below"
  printf '%s\n' "$needed"
  exit 1
fi

resolve() {
  local so=$1 d dirs
  IFS=: read -ra dirs <<<"${LD_LIBRARY_PATH:-}"
  for d in "${dirs[@]}"; do
    [ -n "$d" ] && [ -e "$d/$so" ] && { readlink -f "$d/$so"; return; }
  done
  ldconfig -p | awk -v s="$so" '$1 == s && index($0, "x86-64") { print $NF; exit }'
}

for so in "${SONAMES[@]}"; do
  src="$(resolve "$so")"
  [ -n "$src" ] && [ -f "$src" ] || { echo "::error::$so not found, install the package providing it"; exit 1; }
  cp -fL "$src" "$dest/$so"
  chmod u+w "$dest/$so"
  patchelf --set-rpath '$ORIGIN' "$dest/$so"
done
patchelf --set-rpath '$ORIGIN' "$dest/libmpv.so.2"

# The bundle has to win over the host's copies and leave nothing dangling.
# LD_LIBRARY_PATH outranks DT_RUNPATH, so drop it or the check proves nothing.
resolved="$(env -u LD_LIBRARY_PATH ldd "$dest/libmpv.so.2")"
unresolved="$(printf '%s\n' "$resolved" | grep 'not found' || true)"
[ -z "$unresolved" ] || { echo "::error::unresolved after bundling:"; echo "$unresolved"; exit 1; }
for so in "${SONAMES[@]}"; do
  printf '%s\n' "$resolved" | grep -q "$dest/$so" \
    || { echo "::error::$so resolves outside the bundle, RUNPATH not applied"; exit 1; }
done

echo "Bundled ${#SONAMES[@]} runtime libs ($(du -shc "$dest"/*.so* | tail -1 | cut -f1) total) into $dest"
