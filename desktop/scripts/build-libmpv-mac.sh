#!/usr/bin/env bash
#
# Build desktop/native/vendor/libmpv.dylib — the runtime libmpv for the macOS
# desktop client. Counterpart of build-libmpv-linux.sh (same FFmpeg / mpv /
# libass / libplacebo pins).
#
# Everything is built from source into one prefix and linked statically into a
# single dylib that depends on system libraries and frameworks only:
#   • LGPL: FFmpeg without --enable-gpl / --enable-version3, mpv with -Dgpl=false,
#     TLS through OpenSSL 3 (Apache-2.0; accepted by FFmpeg in a non-GPL build, keeps TLS 1.3).
#   • FFmpeg's symbols stay hidden (only mpv_* is exported): Electron ships its
#     own libffmpeg.dylib and a libmpv exporting av_* would clash with it.
#   • -mmacosx-version-min follows MACOSX_DEPLOYMENT_TARGET (verify-minos-mac.sh holds the result to it).
#
# Needs Xcode command line tools, meson, ninja, pkg-config (or pkgconf), git, curl.
# Homebrew is never consulted: pkg-config only sees $PREFIX.
#
# Usage:  desktop/scripts/build-libmpv-mac.sh
# Env:    WORK (default ~/.cache/fliks-libmpv-mac), JOBS
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/desktop/native/vendor"
WORK="${WORK:-$HOME/.cache/fliks-libmpv-mac}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu)}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"

OPENSSL_VERSION=3.5.9
FREETYPE_VERSION=2.14.3
HARFBUZZ_VERSION=15.2.0
FRIBIDI_VERSION=1.0.18
LCMS2_VERSION=2.20
DAV1D_VERSION=1.5.5
UNIBREAK_VERSION=6.1
LIBASS_VERSION=0.17.4
FFMPEG_VERSION=8.1.2
LIBPLACEBO_VERSION=v7.351.0
LIBPLACEBO_COMMIT=3188549fba13bbdf3a5a98de2a38c2e71f04e21e
MPV_VERSION=0.41.0

PREFIX="$WORK/prefix"
SRC="$WORK/src"
BUILD="$WORK/build"
mkdir -p "$PREFIX" "$SRC" "$BUILD" "$OUT"

# Only $PREFIX is visible to pkg-config; --static pulls the Libs.private of the archives.
printf '#!/bin/sh\nexec "%s" --static "$@"\n' "$(command -v pkg-config || command -v pkgconf)" > "$WORK/pkg-config"
chmod +x "$WORK/pkg-config"
export PKG_CONFIG="$WORK/pkg-config"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
unset PKG_CONFIG_PATH
export PATH="$PREFIX/bin:$PATH"
export CFLAGS="-O2 -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -I$PREFIX/include"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -L$PREFIX/lib"

step() { echo "==> $*"; }

# fetch <url> <sha256> <file> — verified tarball, extracted to $SRC/<dir>
fetch() {
  local url=$1 sha=$2 file=$SRC/${3}
  [ -f "$file" ] || curl -fsSL -o "$file" "$url"
  echo "$sha  $file" | shasum -a 256 -c - >/dev/null || { echo "sha256 mismatch: $file" >&2; rm -f "$file"; exit 1; }
}
unpack() { [ -d "$SRC/$2" ] || tar -xf "$SRC/$1" -C "$SRC"; }

# built <name>: skip a dependency already installed with these pins
built() { [ -f "$WORK/stamps/$1" ]; }
# mark <name>: record the dependency and drop its trees (the CI runner and small disks stay lean)
mark() {
  mkdir -p "$WORK/stamps"; touch "$WORK/stamps/$1"
  rm -rf "${BUILD:?}"/*; find "$SRC" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
}
meson_dep() { # <name> <srcdir> [meson args...]
  local name=$1 dir=$2; shift 2
  meson setup "$BUILD/$name" "$dir" --prefix="$PREFIX" --libdir=lib --buildtype=release \
    --default-library=static -Dc_args="$CFLAGS" -Dcpp_args="$CFLAGS" -Dc_link_args="$LDFLAGS" -Dcpp_link_args="$LDFLAGS" "$@"
  meson compile -C "$BUILD/$name" -j "$JOBS"
  meson install -C "$BUILD/$name"
}

if ! built openssl-$OPENSSL_VERSION; then
  step openssl
  fetch "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" \
    603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a openssl.tar.gz
  rm -rf "$SRC/openssl-$OPENSSL_VERSION"; tar -xf "$SRC/openssl.tar.gz" -C "$SRC"
  (cd "$SRC/openssl-$OPENSSL_VERSION" \
    && ./Configure darwin64-arm64-cc no-shared no-tests no-apps no-docs no-module \
         --prefix="$PREFIX" --libdir=lib "-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET" \
    && make -j"$JOBS" build_libs && make install_dev)
  mark openssl-$OPENSSL_VERSION
fi

if ! built freetype-$FREETYPE_VERSION; then
  step freetype
  fetch "https://download.savannah.gnu.org/releases/freetype/freetype-$FREETYPE_VERSION.tar.xz" \
    36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f freetype.tar.xz
  unpack freetype.tar.xz freetype-$FREETYPE_VERSION
  meson_dep freetype "$SRC/freetype-$FREETYPE_VERSION" -Dzlib=disabled -Dbzip2=disabled -Dpng=disabled \
    -Dharfbuzz=disabled -Dbrotli=disabled
  mark freetype-$FREETYPE_VERSION
fi

if ! built harfbuzz-$HARFBUZZ_VERSION; then
  step harfbuzz
  fetch "https://github.com/harfbuzz/harfbuzz/releases/download/$HARFBUZZ_VERSION/harfbuzz-$HARFBUZZ_VERSION.tar.xz" \
    e2ec49090744383cdbe7df808c1cedaafba06a97be8dc4211fe546ba585f12cb harfbuzz.tar.xz
  unpack harfbuzz.tar.xz harfbuzz-$HARFBUZZ_VERSION
  meson_dep harfbuzz "$SRC/harfbuzz-$HARFBUZZ_VERSION" -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled \
    -Dicu=disabled -Dcairo=disabled -Dcoretext=disabled -Dtests=disabled -Ddocs=disabled \
    -Dbenchmark=disabled -Dutilities=disabled -Dintrospection=disabled
  mark harfbuzz-$HARFBUZZ_VERSION
fi

if ! built fribidi-$FRIBIDI_VERSION; then
  step fribidi
  fetch "https://github.com/fribidi/fribidi/releases/download/v$FRIBIDI_VERSION/fribidi-$FRIBIDI_VERSION.tar.xz" \
    1de5e8073d035388b71d0b2d452b1da1f8caeea8a7702997b401fe1b6250727f fribidi.tar.xz
  unpack fribidi.tar.xz fribidi-$FRIBIDI_VERSION
  meson_dep fribidi "$SRC/fribidi-$FRIBIDI_VERSION" -Ddocs=false -Dtests=false -Dbin=false
  mark fribidi-$FRIBIDI_VERSION
fi

if ! built lcms2-$LCMS2_VERSION; then
  step lcms2
  fetch "https://github.com/mm2/Little-CMS/releases/download/lcms$LCMS2_VERSION/lcms2-$LCMS2_VERSION.tar.gz" \
    18ff5504fa9cc8a2b1f3591180d90ead16c8a2ea78e530523b46eab70e1ca6b9 lcms2.tar.gz
  unpack lcms2.tar.gz lcms2-$LCMS2_VERSION
  meson_dep lcms2 "$SRC/lcms2-$LCMS2_VERSION" -Djpeg=disabled -Dtiff=disabled -Dtests=disabled
  mark lcms2-$LCMS2_VERSION
fi

if ! built dav1d-$DAV1D_VERSION; then
  step dav1d
  fetch "https://downloads.videolan.org/pub/videolan/dav1d/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.xz" \
    ca96b1d0ba3f01f55de7231d775892b64994ba061aaeeaaa4f662a390b3abf9e dav1d.tar.xz
  unpack dav1d.tar.xz dav1d-$DAV1D_VERSION
  meson_dep dav1d "$SRC/dav1d-$DAV1D_VERSION" -Denable_tools=false -Denable_tests=false -Denable_examples=false
  mark dav1d-$DAV1D_VERSION
fi

if ! built unibreak-$UNIBREAK_VERSION; then
  step libunibreak
  fetch "https://github.com/adah1972/libunibreak/releases/download/libunibreak_${UNIBREAK_VERSION//./_}/libunibreak-$UNIBREAK_VERSION.tar.gz" \
    cc4de0099cf7ff05005ceabff4afed4c582a736abc38033e70fdac86335ce93f unibreak.tar.gz
  unpack unibreak.tar.gz libunibreak-$UNIBREAK_VERSION
  (cd "$SRC/libunibreak-$UNIBREAK_VERSION" \
    && ./configure --prefix="$PREFIX" --disable-shared --enable-static --with-pic \
    && make -j"$JOBS" && make install)
  mark unibreak-$UNIBREAK_VERSION
fi

if ! built libass-$LIBASS_VERSION; then
  step libass
  fetch "https://github.com/libass/libass/releases/download/$LIBASS_VERSION/libass-$LIBASS_VERSION.tar.xz" \
    78f1179b838d025e9c26e8fef33f8092f65611444ffa1bfc0cfac6a33511a05a libass.tar.xz
  unpack libass.tar.xz libass-$LIBASS_VERSION
  (cd "$SRC/libass-$LIBASS_VERSION" \
    && ./configure --prefix="$PREFIX" --disable-shared --enable-static --with-pic \
         --disable-fontconfig --disable-directwrite --enable-coretext --disable-require-system-font-provider \
    && make -j"$JOBS" && make install)
  mark libass-$LIBASS_VERSION
fi

if ! built ffmpeg-$FFMPEG_VERSION; then
  step ffmpeg
  fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
    464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c ffmpeg.tar.xz
  unpack ffmpeg.tar.xz ffmpeg-$FFMPEG_VERSION
  mkdir -p "$BUILD/ffmpeg" && (cd "$BUILD/ffmpeg" \
    && "$SRC/ffmpeg-$FFMPEG_VERSION/configure" --prefix="$PREFIX" --arch=arm64 --target-os=darwin \
         --enable-static --disable-shared --enable-pic --disable-programs --disable-doc --disable-debug \
         --disable-autodetect --disable-indevs --disable-outdevs \
         --enable-openssl --enable-zlib --enable-libdav1d --enable-videotoolbox --enable-audiotoolbox \
         "--extra-cflags=$CFLAGS" "--extra-ldflags=$LDFLAGS" \
    && make -j"$JOBS" && make install)
  grep -q '^#define CONFIG_GPL 0' "$BUILD/ffmpeg/config.h" && grep -q '^#define CONFIG_VERSION3 0' "$BUILD/ffmpeg/config.h" \
    || { echo "FFmpeg is not an LGPL-2.1 build" >&2; exit 1; }
  mark ffmpeg-$FFMPEG_VERSION
fi

if ! built libplacebo-$LIBPLACEBO_VERSION; then
  step libplacebo
  rm -rf "$SRC/libplacebo"
  git clone -q --depth 1 --branch "$LIBPLACEBO_VERSION" --recurse-submodules --shallow-submodules \
    https://code.videolan.org/videolan/libplacebo.git "$SRC/libplacebo"
  [ "$(git -C "$SRC/libplacebo" rev-parse HEAD)" = "$LIBPLACEBO_COMMIT" ] || { echo "libplacebo tag moved" >&2; exit 1; }
  meson_dep libplacebo "$SRC/libplacebo" -Dvulkan=disabled -Dopengl=enabled -Dd3d11=disabled -Dglslang=disabled \
    -Dshaderc=disabled -Dlcms=enabled -Ddovi=disabled -Dlibdovi=disabled -Ddemos=false -Dtests=false
  mark libplacebo-$LIBPLACEBO_VERSION
fi

step mpv
fetch "https://github.com/mpv-player/mpv/archive/refs/tags/v$MPV_VERSION.tar.gz" \
  ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209 mpv.tar.gz
rm -rf "$SRC/mpv-$MPV_VERSION" "$BUILD/mpv"; tar -xf "$SRC/mpv.tar.gz" -C "$SRC"
# gnu_symbol_visibility only covers mpv's own objects; the static FFmpeg, libass
# and libplacebo archives would re-export ~1400 symbols without this list.
printf '_mpv_*\n' > "$WORK/libmpv.exp"
sed -i '' "s|link_args: cc.get_supported_link_arguments(\['-Wl,-Bsymbolic'\]),|link_args: cc.get_supported_link_arguments(['-Wl,-Bsymbolic']) + ['-Wl,-exported_symbols_list,$WORK/libmpv.exp'],|" \
  "$SRC/mpv-$MPV_VERSION/meson.build"
grep -q exported_symbols_list "$SRC/mpv-$MPV_VERSION/meson.build"
meson setup "$BUILD/mpv" "$SRC/mpv-$MPV_VERSION" --prefix="$PREFIX" --libdir=lib --buildtype=release \
  -Dc_args="$CFLAGS" -Dc_link_args="$LDFLAGS" -Dobjc_args="$CFLAGS" -Dobjc_link_args="$LDFLAGS" \
  -Dlibmpv=true -Dcplayer=false -Dgpl=false -Dbuild-date=false \
  -Dlua=disabled -Djavascript=disabled -Dlibarchive=disabled -Dlibbluray=disabled -Drubberband=disabled \
  -Duchardet=disabled -Dvapoursynth=disabled -Dzimg=disabled -Djpeg=disabled -Dsdl2-gamepad=disabled \
  -Dvulkan=disabled -Dshaderc=disabled -Dspirv-cross=disabled -Dmanpage-build=disabled -Dhtml-build=disabled \
  -Dlcms2=enabled -Dgl=enabled -Dvideotoolbox-gl=enabled -Dcoreaudio=enabled \
  -Dcocoa=disabled -Dswift-build=disabled -Dmacos-cocoa-cb=disabled -Dmacos-media-player=disabled \
  -Dmacos-touchbar=disabled -Dgl-cocoa=disabled
meson compile -C "$BUILD/mpv" -j "$JOBS"
meson install -C "$BUILD/mpv"

step "vendoring into $OUT"
rm -f "$OUT"/*.dylib "$OUT"/libmpv.so.2
cp -L "$PREFIX/lib/libmpv.dylib" "$OUT/libmpv.dylib"
chmod u+w "$OUT/libmpv.dylib"
install_name_tool -id "@loader_path/libmpv.dylib" "$OUT/libmpv.dylib"
codesign --force --sign - "$OUT/libmpv.dylib"
echo "libmpv headers for the addon: FLIKS_MPV_INCLUDE=$PREFIX/include"
bash "$ROOT/desktop/scripts/verify-libmpv-mac.sh"
