#!/usr/bin/env bash
# Downloads the Fliks-vendored mpv build and checks it against MPV_VENDOR_SHA256 (env from the workflow).
set -euo pipefail
cd "$(dirname "$0")/../.."
dest=desktop/native/vendor
mkdir -p "$dest"
url="https://github.com/$GITHUB_REPOSITORY/releases/download/${MPV_VENDOR_TAG}/${MPV_VENDOR_ASSET}"
echo "Downloading mpv (Fliks-vendored): $url"
curl -fsSL -o "$RUNNER_TEMP/mpv.7z" "$url"
echo "${MPV_VENDOR_SHA256}  $RUNNER_TEMP/mpv.7z" | sha256sum -c -
7z x -y -o"$dest" "$RUNNER_TEMP/mpv.7z" >/dev/null
if [ ! -f "$dest/mpv.exe" ]; then
  sub=$(find "$dest" -name mpv.exe -printf '%h\n' | head -1)
  [ -n "$sub" ] && cp -rf "$sub"/. "$dest"/
fi
test -f "$dest/mpv.exe" || { echo "::error::mpv.exe missing after extract"; find "$dest" -maxdepth 2; exit 1; }
rm -f "$dest/libmpv.so.2"  # the committed Linux lib isn't used on Windows
echo "vendored mpv.exe ($(du -h "$dest/mpv.exe" | cut -f1)) + $(ls "$dest"/*.dll 2>/dev/null | wc -l) DLLs"
