# Fliks

**Your media, on every screen in the house.** Point Fliks at the folders
where your films and series live; it builds a browsable library with
posters and metadata, and streams them to phones, TVs, browsers and
Chromecast — transcoding on the fly when a device can't play the file
as-is.

Self-hosted, no account, no cloud: the server runs on your machine and
nothing leaves it.

- **Server** — Docker, a Windows tray app or a macOS menu-bar app
- **Clients** — web, iOS, Android, Android TV, Apple TV, Samsung, LG, desktop, Chromecast
- **License** — [AGPL-3.0-or-later](LICENSE)

---

## Get started

The quickest path is Docker. You need a folder with your video files and
about two minutes.

```bash
curl -LO https://raw.githubusercontent.com/fliks-app/fliks/main/docker-compose.example.yml
mv docker-compose.example.yml docker-compose.yml
```

Open the file and set three things:

1. `POSTGRES_PASSWORD` and `DB_PASSWORD` — the same real password
2. the `/path/to/your/media:/medias:ro` mount — where your files are
3. `PORT` — only if `4848` is taken on the host

```bash
docker compose up -d
```

Then open `http://<host>:4848` and create the first account. Add a
library pointing at `/medias`, and Fliks scans it.

Prefer to run it as a normal desktop app? See
[Windows](#windows) and [macOS](#macos) below.

---

## Server compatibility

| How you run it | Platforms | Hardware transcoding | Ships with |
|---|---|---|---|
| **Docker** *(recommended)* | `linux/amd64`, `linux/arm64` | Intel QSV · VAAPI · NVIDIA NVENC · AMD | backend, web client, FFmpeg |
| **Windows** — tray app, NSIS installer | Windows x64 | Intel QSV · AMD AMF · NVIDIA NVENC, auto-detected | everything, no dependencies |
| **macOS** — menu-bar app, `.dmg` | macOS 13 Ventura+, Apple Silicon | VideoToolbox | everything, no dependencies |
| **From source** | anywhere Node runs | whatever your FFmpeg exposes | — |

The image is a single container: NestJS backend, the built Angular
client served as static assets, and a self-contained
[jellyfin-ffmpeg](https://github.com/jellyfin/jellyfin-ffmpeg) build. A
PostgreSQL container sits beside it (the example Compose pins 18.3).

### Encoders

Which hardware path is available depends on the machine, not on Fliks —
it probes at startup and falls back to CPU when nothing else answers.

| Codec | CPU | Intel QSV | VAAPI | NVIDIA NVENC | AMD AMF | VideoToolbox |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| H.264 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| HEVC | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| AV1 | ✅ | ✅ | ✅ | ✅ | ✅ | — |

HDR10, HLG and Dolby Vision are tone-mapped to SDR when the receiving
device can't render them.

### Windows

A tray app that runs the server in the background; the UI stays in your
browser at `http://localhost:4848`. Grab the installer from the
[latest release](https://github.com/fliks-app/fliks/releases). Details in
[`windows/`](windows/).

### macOS

Same idea, in the menu bar, with VideoToolbox acceleration. `.dmg` on the
[latest release](https://github.com/fliks-app/fliks/releases), Apple
Silicon, macOS 13+. Details in [`macos/`](macos/).

---

## Client compatibility

One Angular codebase ships as the web app and as the mobile / TV apps,
so every screen gets the same features — adapted to its input (touch,
mouse, D-pad). Apple TV is the exception: tvOS has no WebView, so it has
its own native SwiftUI app talking to the same backend.

| Client | Where to get it | Minimum | Notes |
|---|---|---|---|
| **Web / PWA** | your browser, at the server URL | any current browser | installable to the home screen |
| **iOS · iPadOS** | App Store | iOS 14 | |
| **Android** | Play Store | Android 6 (API 23) | phone + tablet |
| **Android TV** | Play Store | Android 6 | 10-foot UI, D-pad navigation |
| **Samsung TV (Tizen)** | sideload for now | Tizen 5.5 — 2020 sets and newer | works fully, not yet on Samsung Apps |
| **LG TV (webOS)** | LG Content Store | built for Chromium 85 | submitted, under review |
| **Desktop** | release assets | macOS: Apple Silicon | Windows `.exe`, macOS `.dmg`, Linux `.deb` / AppImage |
| **Chromecast** | built in — cast from any client | — | custom receiver, same player engine |
| **Apple TV** | App Store — same app record as iOS | tvOS 17 | native SwiftUI app, not the web client |

The desktop app is a thin client with an mpv video pipeline — it
connects to your server like the mobile apps do, it doesn't host one.

---

## What you get

### Watching

- **Adaptive streaming** — quality follows the bandwidth without a
  hiccup, or lock a bitrate by hand when you'd rather decide.
- **Resume anywhere** — start on the phone, finish on the TV; the
  position syncs live.
- **Every track, switchable mid-playback** — all embedded audio
  renditions, all embedded and external subtitles (`.srt`, `.ass`), with
  your choice remembered per show.
- **Subtitle appearance** per user: size, colour, shadow, background
  opacity, margins.
- **Skip intro, next episode, chapter markers** and thumbnail previews
  when you scrub.

### Browsing

- **Several libraries side by side** — films, series, anime, kids —
  each pointed at its own folder.
- **Search across all of them**, filter and sort by status, date added,
  rating, runtime.
- **Metadata from TMDB / TVDB**: posters, fanart, genres, cast and crew.
  Every person is a page listing everything they worked on in your
  libraries; every genre is a filter.
- **Home rows** — Continue Watching, Recently Added, and
  recommendations weighted by what you've actually watched.
- **Calendar** of upcoming episodes for the series you follow.

### Running it

- **Multi-user**, each with their own history, progress and preferences.
- **Pairing by QR code or short code** — the TV picks up the session
  from your phone.
- **Live transcode dashboard** for admins: who's watching what, at which
  quality, on which hardware path, and why a transcode was needed.
- **Images cached locally** — no hotlinking to external services while
  you browse.

---

## Hosting notes

### Pinning a version

`:latest` follows the most recent stable release. Pin a specific tag
(`:1.2.3`) from the
[package list](https://github.com/fliks-app/fliks/pkgs/container/fliks).

### Hardware acceleration in Docker

Intel QSV and VAAPI work out of the box once you uncomment the
`/dev/dri` device mount in the example Compose. NVIDIA NVENC needs
`nvidia-container-toolkit` on the host and a slightly different Compose
snippet — the example Compose carries both, commented.

### Update checks

Fliks asks the **public GitHub releases API** whether a newer version
exists: the server does it to tell admins their install is behind, the
desktop app to offer in-app updates. One unauthenticated read, cached
for hours — no token, no telemetry, nothing sent about you.

Set `FLIKS_DISABLE_UPDATE_CHECK=1` to turn it off; `/api/system/update`
then always reports "up to date" and never contacts GitHub.

---

## Repository layout

| Path | What lives there |
|---|---|
| `backend/` | NestJS, TypeORM, PostgreSQL, the FFmpeg pipeline |
| `client/` | Angular + Tailwind / DaisyUI + Shaka Player — web, iOS, Android, Android TV (Capacitor), plus the Tizen and webOS packagers |
| `desktop/` | Electron + libmpv thin client for Windows / macOS / Linux |
| `windows/`, `macos/` | native server hosts (tray / menu bar) |
| `appletv/` | native tvOS app (SwiftUI) |
| `cast-receiver/` | custom Chromecast receiver |

## License

[AGPL-3.0-or-later](LICENSE) — run a modified version on a network and
you owe its users the modified source.
