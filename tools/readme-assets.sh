#!/usr/bin/env bash
#
# Regenerate the README header assets: the stacked logo (light + dark) and the
# screenshot deck. Screenshot sources are the *.webp already in .github/readme.
#
# Headless Chrome lays out both — CSS transforms and shadows beat scripting the
# same stack of rotations in ImageMagick.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
shots="$repo/.github/readme"
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
  google-chrome --headless=new --disable-gpu --hide-scrollbars \
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

# --- screenshot deck --------------------------------------------------------

cat > "$work/collage.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;width:2000px;height:1600px;background:transparent;overflow:hidden}
  .stage{position:relative;width:100%;height:100%}
  img{position:absolute;border-radius:14px;border:1px solid rgba(255,255,255,.10);
      box-shadow:0 40px 80px rgba(0,0,0,.62),0 8px 20px rgba(0,0,0,.45)}
  /* Deck cascading down-right. Each rotated bounding box stays inside the
     canvas, so no pane is clipped and -trim sets the final aspect ratio. */
  .library {width:1240px;left:50px;top:80px;transform:rotate(-7deg)}
  .discover{width:1240px;left:715px;top:130px;transform:rotate(6deg)}
  .home    {width:1320px;left:240px;top:470px;transform:rotate(-2.5deg)}
  .detail  {width:1240px;left:640px;top:750px;transform:rotate(4deg)}
</style>
<div class="stage">
  <img class="library"  src="file://$shots/library.webp">
  <img class="discover" src="file://$shots/discover.webp">
  <img class="home"     src="file://$shots/home.webp">
  <img class="detail"   src="file://$shots/detail.webp">
</div>
HTML

google-chrome --headless=new --disable-gpu --hide-scrollbars \
  --window-size=2000,1600 --default-background-color=00000000 \
  --screenshot="$work/collage.png" "file://$work/collage.html" 2>/dev/null

# Trim the transparent margin the shadows don't reach, then keep a little air.
convert "$work/collage.png" -trim +repage -bordercolor none -border 24 \
  -resize 1500x -quality 86 "$shots/collage.webp"

identify -format '%f  %wx%h  %[channels]  %b\n' \
  "$shots/logo-stacked-light.webp" "$shots/logo-stacked-dark.webp" \
  "$shots/collage.webp"
