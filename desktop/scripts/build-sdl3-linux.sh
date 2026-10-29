#!/usr/bin/env bash
# Builds the SDL3 the compositor addon links: Ubuntu 24.04, the .deb's glibc floor, has none.
# Headers land in native/.sdl3 for node-gyp, libSDL3.so.0 in native/vendor (the addon's RUNPATH).
#
# Only the video subsystem: SDL dlopens X11, Wayland, EGL and D-Bus at runtime. Build deps:
# cmake libwayland-dev libxkbcommon-dev libegl-dev libgl-dev libdbus-1-dev and the libx11,
# libxext, libxcursor, libxi, libxfixes, libxrandr, libxrender, libxss -dev packages.
set -euo pipefail

VERSION=3.4.18
SHA256=9c75cf16330322c217dedd2e0609f1124f1b54b8633e763467b4684d0f4334a3

native="$(cd "$(dirname "$0")/../native" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/sdl.tar.gz" \
  "https://github.com/libsdl-org/SDL/releases/download/release-$VERSION/SDL3-$VERSION.tar.gz"
echo "$SHA256  $work/sdl.tar.gz" | sha256sum -c -
tar -xzf "$work/sdl.tar.gz" -C "$work"

off=(AUDIO GPU RENDER CAMERA JOYSTICK HAPTIC HIDAPI POWER SENSOR DIALOG TRAY
     KMSDRM OFFSCREEN VULKAN WAYLAND_LIBDECOR X11_XTEST LIBUDEV TESTS EXAMPLES TEST_LIBRARY STATIC)
cmake -S "$work/SDL3-$VERSION" -B "$work/build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$native/.sdl3" -DCMAKE_INSTALL_LIBDIR=lib \
  $(printf -- '-DSDL_%s=OFF ' "${off[@]}")
cmake --build "$work/build" -j"$(nproc)"
cmake --install "$work/build"

mkdir -p "$native/vendor"
cp -fL "$native/.sdl3/lib/libSDL3.so.0" "$native/vendor/libSDL3.so.0"
echo "SDL3 $VERSION → $native/vendor/libSDL3.so.0 (PKG_CONFIG_PATH=$native/.sdl3/lib/pkgconfig)"
