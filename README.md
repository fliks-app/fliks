# Fliks

Self-hosted media server for the videos you already own — point Fliks at
a folder on your NAS or PC and it gives you a clean player, on every
screen in the house, with adaptive streaming, multi-audio and
multi-subtitle support, and fast Cast-to-TV.

NestJS backend, Angular client (web + iOS + Android + Android TV via
Capacitor; Samsung Tizen and LG webOS targets in progress), custom
Chromecast receiver, FFmpeg / Shaka transcoding pipeline.

## What you get

### Player
- Adaptive HLS streaming with Shaka Player — quality switches on the
  fly without unloading, no playback hiccup on bandwidth changes.
- Per-quality manual lock when you want to pin a specific bitrate.
- Smart resume across devices: pick a movie back up on the TV after
  starting on your phone, with the position synced live.
- Skip-intro / next-episode prompts, chapter markers on the seekbar,
  and sprite-sheet thumbnail previews on seek hover.
- Full-track switching at runtime: every embedded audio rendition is
  selectable, every embedded subtitle (and external `.srt` / `.ass`)
  is loaded on demand, and the player remembers your per-show
  preferences.
- Subtitle appearance settings: size, colour, shadow style, background
  opacity, top / bottom margin — saved per user.
- HDR → SDR tonemapping when the receiver can't render HDR; HDR
  auto-brightness on devices that expose the API.
- 10-foot TV UI with D-pad spatial navigation; one-handed phone UI
  with a long-press contextual menu.

### Streaming engine
- FFmpeg-driven HLS / fMP4 transcoder. Hardware acceleration on Intel
  QSV / VAAPI and NVIDIA NVENC; CPU fallback otherwise.
- Smart-remux when codec / container is already client-compatible —
  copies the video stream and only transcodes audio when needed.
- Per-segment, per-quality session cache so seeks land on already-
  encoded segments instantly.
- Burn-in path for image-based subtitles (PGS, VOBSUB, DVD) on devices
  that can't render them natively.
- Live transcode dashboard for admins: which user is watching what at
  which quality, with HW accel state and the reason a transcode was
  triggered (codec, resolution, audio container, bandwidth lock).

### Cast (Chromecast)
- Custom CAF receiver running Shaka — the same engine the web and
  Android paths use, so all three clients buffer and adapt the same
  way.
- Multi-audio rendition switching from the sender (sender-side picker
  drives the receiver via the standard EditTracksInfoRequest bus).
- Subtitle styling roundtripped from the user's preferences.

### Cross-platform
- Web (PWA-installable).
- Native iOS and Android via Capacitor.
- Native Android TV with D-pad navigation and Leanback launcher
  integration.
- Samsung Tizen `.wgt` and LG webOS `.ipk` build pipelines in CI
  (sideloadable in developer mode; store-publication signing comes
  next).

### Server-side
- Multi-user with per-user playback state and preferences.
- Pairing flow for TV / Cast — scan a QR code or type a short code on
  the phone, the TV picks up the session.
- TMDB metadata enrichment with locally-cached posters / fanart /
  thumbnails (no external image hotlinking at runtime).
- Sprite-sheet generator for seekbar previews, computed lazily.

## Self-hosting with Docker

The recommended way to run Fliks is via the published image on GitHub
Container Registry (`ghcr.io/fliks-app/fliks`). It bundles the backend,
the built Angular client served as static assets, and the FFmpeg /
hardware-acceleration stack.

```bash
# 1. Grab the example Compose
curl -LO https://raw.githubusercontent.com/fliks-app/fliks/main/docker-compose.example.yml
mv docker-compose.example.yml docker-compose.yml

# 2. Edit:
#    - `POSTGRES_PASSWORD` + `DB_PASSWORD` (set a real password)
#    - the `/path/to/your/media:/medias:ro` mount → point at the folder
#      that holds your video files
#    - `PORT` if 4848 collides on the host

# 3. Run
docker compose up -d
```

UI at `http://<host>:4848`.

### Pinning a version

`:latest` follows the most recent stable release. To pin, replace with a
specific tag (e.g. `:1.2.3`) — full list at
https://github.com/fliks-app/fliks/pkgs/container/fliks.

### Hardware-accelerated transcoding

Intel QSV / VAAPI works out of the box if you uncomment the `/dev/dri`
device mount in the example Compose. NVIDIA NVENC requires the host to
have `nvidia-container-toolkit` installed and a different Compose
snippet — the [transcoding docs](docs/transcoding-pipelines.md) cover
both paths.

## Layout

- **`backend/`** — NestJS + TypeORM + PostgreSQL + FFmpeg.
- **`client/`** — Angular + DaisyUI / Tailwind + Shaka Player. Same
  codebase ships as web app and as Capacitor-wrapped iOS / Android /
  Android TV apps. Tizen and webOS builds live under `client/tizen/`
  and `client/webos/`.
- **`cast-receiver/`** — custom CAF receiver hosted on GitHub Pages.

## License

[AGPL-3.0-or-later](LICENSE) — anyone running a modified version of Fliks on
a network must make the modified source available to its users.
