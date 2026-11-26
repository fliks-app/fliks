#!/usr/bin/env bash
#
# Regenerate the README header assets: the stacked logo (light + dark) and the
# device collage. Sources: the *.webp in .github/readme (phone.webp is a phone
# capture cropped below its status bar).
#
# Headless Chrome lays out both: CSS frames and shadows beat ImageMagick.
# CHROME picks the binary; a snap Chromium needs TMPDIR outside /tmp.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
shots="$repo/.github/readme"
chrome=${CHROME:-google-chrome}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- stacked logo -----------------------------------------------------------
#
# The mark sits above the wordmark, as on the tvOS top shelf. There is no
# wordmark-only source: both live side by side in one SVG, so render it wide
# and split it — the mark occupies the left 39% of the artwork.
stacked() { # $1 source svg, $2 output name
  cp "$repo/client/public/$1" "$work/logo.svg"
  cat > "$work/logo.html" <<'HTML'
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:transparent;
  display:flex;align-items:center;justify-content:center}
img{width:1200px;height:auto}</style>
<img src="logo.svg">
HTML
  "$chrome" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=1400,800 --default-background-color=00000000 \
    --screenshot="$work/wide.png" "file://$work/logo.html" 2>/dev/null

  convert "$work/wide.png" -trim +repage "$work/logo-trim.png"
  convert "$work/logo-trim.png" -gravity West -crop 39%x100%+0+0 +repage \
    -trim +repage -resize x300 "$work/mark.png"
  convert "$work/logo-trim.png" -gravity East -crop 61%x100%+0+0 +repage \
    -trim +repage -resize 560x "$work/word.png"
  convert -size 1x54 xc:none "$work/gap.png"
  convert -background none "$work/mark.png" "$work/gap.png" "$work/word.png" \
    -gravity center -append -quality 90 "$shots/$2"
}

stacked fliks-logo.svg        logo-stacked-light.webp
stacked fliks-logo-ondark.svg logo-stacked-dark.webp

# --- device collage ---------------------------------------------------------

cat > "$work/collage.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;width:2400px;height:1600px;background:transparent;overflow:hidden}
  .stage{position:relative;width:100%;height:100%}
  .stage>*{position:absolute;box-shadow:0 40px 80px rgba(0,0,0,.55),0 8px 20px rgba(0,0,0,.4)}
  img{display:block;width:100%}
  .desktop{left:350px;top:60px;width:1700px;border-radius:20px;
           border:2px solid rgba(255,255,255,.11)}
  .device{background:#121216;border:3px solid #464650}
  .tablet{left:80px;top:720px;width:784px;padding:18px;border-radius:36px}
  .tablet img{border-radius:22px}
  .phone{left:1850px;top:560px;width:376px;padding:12px;border-radius:60px}
  .phone img{border-radius:48px}
  .island{position:absolute;top:26px;left:50%;width:104px;height:30px;margin-left:-52px;
          border-radius:15px;background:#000}
</style>
<div class="stage">
  <img class="desktop" src="file://$shots/home.webp">
  <div class="device tablet"><img src="file://$shots/detail.webp"></div>
  <div class="device phone"><img src="file://$shots/phone.webp"><i class="island"></i></div>
</div>
HTML

"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=2400,1600 --default-background-color=00000000 \
  --screenshot="$work/collage.png" "file://$work/collage.html" 2>/dev/null

# Trim the transparent margin the shadows don't reach, then keep a little air.
convert "$work/collage.png" -trim +repage -bordercolor none -border 48 \
  -resize 2200x -quality 92 "$shots/collage.webp"

identify -format '%f  %wx%h  %[channels]  %b\n' \
  "$shots/logo-stacked-light.webp" "$shots/logo-stacked-dark.webp" \
  "$shots/collage.webp"
