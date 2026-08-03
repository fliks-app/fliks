#!/usr/bin/env bash
#
# Render the TV Seller Office icon assets from the brand SVGs.
#
# Headless Chrome does the rasterising: ImageMagick's built-in SVG renderer
# mangles the logo's gradients and its saturation filter.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
out="$repo/store/samsung/icons"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
cp "$repo/client/public/fliks-logo-ondark.svg" "$work/logo.svg"

# Brand background: surface colour with the accent glow behind the logo.
bg="background:#1d232a;background-image:radial-gradient(60% 90% at 50% 45%,rgba(122,63,242,.55),rgba(122,63,242,0) 70%)"

page() { # $1 file, $2 body style, $3 body content
  cat > "$work/$1" <<HTML
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;width:100%;overflow:hidden}
  body{display:flex;align-items:center;justify-content:center;$2}
  img{display:block}
</style>
$3
HTML
}

shot() { # $1 html, $2 png, $3 WxH, $4 extra chrome args
  google-chrome --headless=new --disable-gpu --hide-scrollbars \
    --window-size="${3/x/,}" --screenshot="$out/$2" ${4:-} "file://$work/$1" 2>/dev/null
}

page logo.html 'background:transparent' '<img src="logo.svg" style="width:46%">'
shot logo.html logo-1920x1080.png 1920x1080 --default-background-color=00000000

page background.html "$bg" ''
shot background.html background.png 1920x1080
# PNG lands over the 300 KB budget at this size; JPG is accepted for this slot.
convert "$out/background.png" -quality 92 -sampling-factor 4:4:4 "$out/background-1920x1080.jpg"
rm -f "$out/background.png"

page fullcolor.html "$bg" '<img src="logo.svg" style="width:78%">'
shot fullcolor.html fullcolor-512x423.png 512x423

for f in "$out"/*; do
  size=$(stat -c%s "$f")
  [ "$size" -le 307200 ] || { echo "over the 300 KB limit: $f ($size)"; exit 1; }
  identify -format '%f  %wx%h  %[channels]  %b\n' "$f"
done
