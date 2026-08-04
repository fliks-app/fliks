#!/usr/bin/env bash
#
# Render the Play Console TV banner from the brand SVG over the tvOS App Store
# icon's background art, so both TV stores show the same gradient.
#
# Headless Chrome does the rasterising: ImageMagick's built-in SVG renderer
# mangles the logo's gradients and its saturation filter.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
out="$repo/store/android"
brand="$repo/appletv/Sources/Resources/Assets.xcassets/App Icon & Top Shelf Image.brandassets"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
cp "$repo/client/public/fliks-logo-ondark.svg" "$work/logo.svg"

# The launcher rounds the banner's corners and overlays a focus border, so the
# logo stays well inside the frame.
cat > "$work/logo.html" <<'HTML'
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;width:100%;overflow:hidden}
  body{display:flex;align-items:center;justify-content:center;background:transparent}
  img{display:block;width:52%}
</style>
<img src="logo.svg">
HTML

google-chrome --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1280,720 --default-background-color=00000000 \
  --screenshot="$work/logo.png" "file://$work/logo.html" 2>/dev/null

# 1280x768 App Store back layer → 1280x720, same gradient, no rescaling.
convert "$brand/App Icon - App Store.imagestack/Back.imagestacklayer/Content.imageset/store-back.png" \
  -gravity center -crop 1280x720+0+0 +repage "$work/bg.png"

# Play rejects alpha on this slot.
convert "$work/bg.png" "$work/logo.png" -composite \
  -background black -alpha remove -alpha off \
  PNG24:"$out/banner-tv-1280x720.png"

read -r w h ch bytes < <(identify -format '%w %h %[channels] %B\n' \
  "$out/banner-tv-1280x720.png")
[ "$w" = 1280 ] && [ "$h" = 720 ] || { echo "wrong size: ${w}x${h}"; exit 1; }
[ "$ch" = srgb ] || { echo "alpha not stripped: $ch"; exit 1; }
[ "$bytes" -le 8388608 ] || { echo "over the 8 MB limit: $bytes"; exit 1; }
identify -format '%f  %wx%h  %[channels]  %b\n' "$out/banner-tv-1280x720.png"
