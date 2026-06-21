#!/usr/bin/env bash
# Produce a self-contained, relocatable libmpv.dylib (+ its non-system dylib
# dependencies) under desktop/native/vendor for the macOS Electron client.
#
# Homebrew's libmpv dynamically links FFmpeg / libass / libplacebo / … under
# /opt/homebrew (paths that won't exist on a user's machine) but already hides
# its own av_* symbols. dylibbundler copies every non-system dependency into
# vendor/ and rewrites all load commands + ids to @loader_path, so the addon's
# dlopen("…/native/vendor/libmpv.dylib") resolves a fully self-contained tree.
# macOS's two-level namespace keeps the bundled FFmpeg distinct from Electron's
# own libffmpeg.dylib, so there's no symbol clash (the macOS analogue of the
# Linux self-contained .so).
#
# Used by both local dev and CI (.github/workflows/desktop-release.yml). The
# vendored tree is gitignored (it's large + reproducible), like the Windows
# mpv.exe — only Linux's libmpv.so.2 is committed.
#
# Requires: brew install mpv dylibbundler
# Override the source dylib with FLIKS_LIBMPV_SRC.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$here/native/vendor"
src="${FLIKS_LIBMPV_SRC:-$(brew --prefix mpv 2>/dev/null)/lib/libmpv.dylib}"

command -v dylibbundler >/dev/null || { echo "::error::dylibbundler missing (brew install dylibbundler)"; exit 1; }
test -f "$src" || { echo "::error::libmpv not found at $src (brew install mpv, or set FLIKS_LIBMPV_SRC)"; exit 1; }

mkdir -p "$dest"
# Resolve the symlink to the real versioned dylib.
real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$src")"

# dylibbundler must NOT fix a file that lives inside its own dest-dir (it clobbers
# it while relocating deps). Fix a copy in a temp dir, then move it into vendor/:
# its deps reference @loader_path/<dep>, which resolves relative to libmpv's FINAL
# location (vendor/), where dylibbundler has placed all the deps.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -f "$real" "$tmp/libmpv.dylib"
chmod u+w "$tmp/libmpv.dylib"

dylibbundler \
  --fix-file "$tmp/libmpv.dylib" \
  --dest-dir "$dest" \
  --install-path "@loader_path/" \
  --bundle-deps --overwrite-files --overwrite-dir

mv -f "$tmp/libmpv.dylib" "$dest/libmpv.dylib"
install_name_tool -id "@loader_path/libmpv.dylib" "$dest/libmpv.dylib"

# dylibbundler (and Homebrew) can leave a SECOND `LC_RPATH @loader_path/`, which
# dyld rejects at load time ("duplicate LC_RPATH"). Deps are referenced as
# @loader_path/<name> directly, so collapse any duplicates to a single rpath per
# dylib, then ad-hoc re-sign (install_name_tool invalidates the signature; the
# build is unsigned for now anyway).
for lib in "$dest"/*.dylib; do
  n=$(otool -l "$lib" | grep -c 'path @loader_path/ (offset' || true)
  while [ "${n:-0}" -gt 1 ]; do
    install_name_tool -delete_rpath "@loader_path/" "$lib"
    n=$((n - 1))
  done
  codesign --force --sign - "$lib"
done

# The Linux lib isn't used on macOS — keep it out of the .dmg.
rm -f "$dest/libmpv.so.2"

echo "Vendored libmpv.dylib + $(ls "$dest"/*.dylib 2>/dev/null | wc -l | tr -d ' ') dylibs into $dest"
