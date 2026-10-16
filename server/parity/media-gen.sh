#!/usr/bin/env bash
# Generates the tiny synthetic library under /tmp/fliks-parity (idempotent). Layout is mirrored by seed/build.sh.
set -euo pipefail
root=/tmp/fliks-parity
mkdir -p "$root/assets" "$root/media/movies" "$root/media/series"

mk() { # mk <out> : 2 s 160x90 h264 + aac, container by extension
  [ -s "$1" ] && return
  mkdir -p "$(dirname "$1")"
  ffmpeg -v error -y -f lavfi -i "testsrc=size=160x90:rate=24:duration=2" -f lavfi -i "sine=frequency=440:duration=2" \
    -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$1"
}

[ -s "$root/assets/avatar.jpg" ] ||
  ffmpeg -v error -y -f lavfi -i "testsrc=size=64x64:rate=1" -frames:v 1 "$root/assets/avatar.jpg"

mk "$root/base.mkv"
mk "$root/base.mp4"
for n in $(seq -w 1 17); do
  d="$root/media/movies/Parity Movie $n (2020)"
  mkdir -p "$d"
  ext=mkv; [ $((10#$n % 2)) -eq 0 ] && ext=mp4
  [ -s "$d/Parity Movie $n (2020).$ext" ] || cp "$root/base.$ext" "$d/Parity Movie $n (2020).$ext"
done
for s in A B C; do
  for se in 01 02; do
    for ep in 01 02; do
      f="$root/media/series/Parity Series $s/Season $se/Parity Series $s - S${se}E${ep}.mkv"
      mkdir -p "$(dirname "$f")"
      [ -s "$f" ] || cp "$root/base.mkv" "$f"
    done
  done
done

# Artwork read by /api/images (`FLIKS_DATA_DIR=$root/data`).
img="$root/data"
mkdir -p "$img"
[ -s "$root/assets/art.jpg" ] || ffmpeg -v error -y -f lavfi -i "color=c=red:s=2x2" -frames:v 1 "$root/assets/art.jpg"
[ -s "$root/assets/art.png" ] || ffmpeg -v error -y -f lavfi -i "color=c=blue:s=2x2" -frames:v 1 "$root/assets/art.png"
for f in media/1/{poster,poster-thumb,fanart,fanart-1}.jpg media/2/poster.jpg persons/5.jpg episodes/3.jpg seasons/2.jpg \
  requests/movie-603/poster.jpg; do
  mkdir -p "$img/$(dirname "$f")"
  [ -s "$img/$f" ] || cp "$root/assets/art.jpg" "$img/$f"
done
mkdir -p "$img/media/1"
[ -s "$img/media/1/logo.png" ] || cp "$root/assets/art.png" "$img/media/1/logo.png"
