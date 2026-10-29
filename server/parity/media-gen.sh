#!/usr/bin/env bash
# Generates the tiny synthetic library under $FLIKS_PARITY_ROOT (default /tmp/fliks-parity, idempotent). Layout is mirrored by seed/build.sh.
set -euo pipefail
cd "$(dirname "$0")"
root=${FLIKS_PARITY_ROOT:-/tmp/fliks-parity}
mkdir -p "$root/assets" "$root/media/movies" "$root/media/series"

# Copies <src> to <dst> unless already identical: a root from an earlier run is brought up to date.
put() { cmp -s "$1" "$2" || { mkdir -p "$(dirname "$2")" && cp "$1" "$2"; }; }

# media/ is committed: bytes generated here would follow the host's ffmpeg and CPU count.
put media/avatar.jpg "$root/assets/avatar.jpg"
# 2 s 160x90 h264 + aac
put media/base.mkv "$root/base.mkv"
put media/base.mp4 "$root/base.mp4"
for n in $(seq -w 1 17); do
  d="$root/media/movies/Parity Movie $n (2020)"
  mkdir -p "$d"
  ext=mkv; [ $((10#$n % 2)) -eq 0 ] && ext=mp4
  put "$root/base.$ext" "$d/Parity Movie $n (2020).$ext"
done
for s in A B C; do
  for se in 01 02; do
    for ep in 01 02; do
      f="$root/media/series/Parity Series $s/Season $se/Parity Series $s - S${se}E${ep}.mkv"
      put "$root/base.mkv" "$f"
    done
  done
done

# Artwork read by /api/images (`FLIKS_DATA_DIR=$root/data`).
img="$root/data"
mkdir -p "$img"
put media/art.jpg "$root/assets/art.jpg"
put media/art.png "$root/assets/art.png"
for f in media/1/{poster,poster-thumb,fanart,fanart-1}.jpg media/2/poster.jpg persons/5.jpg episodes/3.jpg seasons/2.jpg \
  requests/movie-603/poster.jpg; do
  put "$root/assets/art.jpg" "$img/$f"
done
put "$root/assets/art.png" "$img/media/1/logo.png"
# live TV upload scenarios (scenarios/livetv/sources-playlist-upload*, sources-test-suggestion)
lt="$root/s7"
mkdir -p "$lt"
python3 -c 'import sys; sys.path.insert(0, "external/livetv"); import server; sys.stdout.write(server.playlist())' > "$lt/playlist.m3u"
printf '#EXTM3U\n#EXTINF:-1 group-title="Live",One\nhttp://panel.example:8080/live/joe/s3cret/1.ts\n#EXTINF:-1 group-title="Live",Two\nhttp://panel.example:8080/live/joe/s3cret/2.ts\n' > "$lt/playlist-xtream.m3u"
printf 'hello\n' > "$lt/not-a-playlist.txt"
: > "$lt/empty.m3u"
