# Fliks desktop client (Linux) — rebuild / run / test

Native desktop client (macOS/Windows/Linux target; Linux is the dev platform).
A **thin client**: it connects to a remote Fliks server like the mobile apps —
it is NOT the menu-bar server host under `macos/`.

## Architecture (why the build has three parts)

- **Electron** loads the Angular client **offscreen** (`offscreen: true,
  transparent: true`) and paints it to a BGRA bitmap.
- A **native N-API addon** (`native/compositor/addon.cc`, SDL2 + GLES 3.2) owns
  the single visible window. It composites **mpv video** (rendered into a GL FBO
  via libmpv's render API) under the **Angular UI bitmap**.
- Embedded **mpv** comes from a self-contained static **libmpv** (render API).
- ⚠️ **Two mpv backends — know which one you're debugging.** On **Linux**, mpv
  runs **inside the native C++ addon** (libmpv render API); its property/event
  plumbing (`time-pos`, `demuxer-cache-time`, `paused-for-cache`, `timeUpdate`,
  `stateChanged`) lives in `native/compositor/addon.cc` + the `addon.onEvent` /
  `emitPosition` wiring in `src/main/index.ts`. The `MpvPlayer` subprocess class
  in `src/main/mpv/mpv-player.ts` is the **other** backend (Windows/macOS embed,
  JSON-IPC) and is **NOT used on Linux** — editing it has no effect on the Linux
  client. Both share `src/main/mpv/subtitle-style.ts` (`mpvSubtitleProps`).
- This single-window compositor is the only model that works under **Mutter/X11**:
  an embedded mpv child window can't be composited beneath a sibling transparent
  overlay there, so we composite ourselves.
- Consequence: **HDR is SDR-tonemapped on Linux** (render API uses `vo_gpu`, not
  gpu-next). Video plays; it just isn't true-HDR on screen.

The three buildable units: **native addon** (C++), **main/preload bundle**
(esbuild), **Angular client** (`../client`).

## Dependencies (first-time setup)

System packages (Debian/Ubuntu) — the C++ addon compiles against these via
`pkg-config` and node-gyp needs a C++17 toolchain:
```bash
sudo apt install -y build-essential python3 pkg-config \
  libsdl2-dev libgles2-mesa-dev libegl1-mesa-dev libmpv-dev
```
- `build-essential` + `python3` → node-gyp.
- `pkg-config` + `libsdl2-dev` + `libgles2-mesa-dev` + `libegl1-mesa-dev` →
  the addon links SDL2 / GLESv2 / EGL.
- `libmpv-dev` → addon **compiles** against mpv's headers (`client.h`,
  `render_gl.h`). Runtime uses the vendored self-contained libmpv below, not the
  system one.

Node packages (Node ≥ 20):
```bash
cd desktop && npm install
```

## Prerequisite: vendored libmpv (gitignored)

`native/vendor/libmpv.so.2` is required but **not in git** (`vendor/` is ignored;
it's a ~38 MB binary). It must be a *self-contained static* libmpv with hidden
FFmpeg symbols, or Electron's bundled `libffmpeg.so` (libav 58) clashes with
libmpv's libav 60 and crashes (`free(): invalid pointer` / abort).

Kill-switch check — this MUST print nothing:
```bash
nm -D native/vendor/libmpv.so.2 | grep ' av_'
```
If the file is missing, rebuild/obtain it before anything else. Override its path
with `FLIKS_MPV_PATH`.

## Build

Run from the repo root unless noted. Use **absolute paths** or `cd` inside one
compound command (a bare `cd` between tool calls can prompt for permission).

1. **Native addon** (after editing `native/compositor/addon.cc` or `binding.gyp`).
   Targets the Electron 42 ABI:
   ```bash
   cd desktop/native && ../node_modules/.bin/node-gyp rebuild \
     --target=42.4.0 --dist-url=https://electronjs.org/headers --arch=x64
   ```
   Output: `native/build/Release/fliks_compositor.node`.

2. **Main + preload bundle** (after editing `src/main/**` or `src/preload/**`):
   ```bash
   cd desktop && npm run build      # esbuild → dist/main/index.cjs + dist/preload/index.cjs
   # or just the main bundle: npm run build:main
   ```

3. **Angular client** (after editing `../client/**`):
   ```bash
   cd client && npx ng build --configuration=development
   ```
   - `--output-path` is overridden by `angular.json`; output always lands in
     `client/dist/client/browser`.
   - `client/dist/` has root-owned PWA assets (EACCES on overwrite), so the
     desktop app reads from a `/tmp` copy instead. After every client build:
     ```bash
     rm -rf /tmp/fliks-verify/browser && mkdir -p /tmp/fliks-verify/browser \
       && cp -r client/dist/client/browser/. /tmp/fliks-verify/browser/
     ```

**What to rebuild for a given edit:** addon.cc → step 1. `src/main`/`src/preload`
→ step 2. `client/**` → step 3 (+ the `/tmp` sync). Only the changed unit needs
rebuilding; the addon is reloaded fresh on each Electron start.

## Run

From `desktop/` (Electron resolves `.` and `node_modules` there):
```bash
cd desktop && FLIKS_WEB_DIR=/tmp/fliks-verify/browser DISPLAY=:0 \
  ./node_modules/.bin/electron . --no-sandbox
```
Launch it as a **background task** so its stdout (logs) accumulates and you keep
working. `app.disableHardwareAcceleration()` is set: Chromium's GPU process
can't init on this box, so OSR uses CPU readback.

### Env vars

| var | default | purpose |
|-----|---------|---------|
| `FLIKS_WEB_DIR` | packaged `web/` | dir of the built Angular `index.html` |
| `FLIKS_MPV_PATH` | `native/vendor/libmpv.so.2` | self-contained libmpv |
| `FLIKS_HWDEC` | `no` | mpv `hwdec` (e.g. `auto-copy`) |
| `FLIKS_MPV_LOGLEVEL` | `v` | libmpv log level (`warn` to quiet, `debug` for more) |

## Process management

Kill by **comm name**, never by `-f` path (that also matches your own shells):
```bash
pkill -x electron        # NOT  pkill -f .../desktop
```

## Logs (in the Electron stdout)

- `[compositor]` — native addon (GL/mpv init, fullscreen, resize).
- `[mpv]` — libmpv (verbose: every HLS segment URL + HTTP status; decode/render).
- `[renderer]` — Angular console.
- `[ipc]` / `[input]` — main process (load URLs, SDL input forwarding).

## Testing against a backend

- The server URL is chosen **in-app** on the native server-setup screen. Point it
  at a local backend or prod there.
- **Local backend** for backend iteration: docker `fliks-backend-1` on
  `localhost:3001`, bind-mounts `backend/src`, runs `npm run start:dev` (NestJS
  watch → edits hot-reload; watch for `Found 0 errors` / `Nest application
  successfully started`). JWT secret `change-me-in-production`, 7-day expiry.
- Prod (`fliks.delestre.me`) is a different machine — you can't inspect its files.

## Known constraints / gotchas

- **HDR** → SDR tonemap only (see Architecture). Expected, not a bug.
- **Resume into a transcode** (seek to a high segment): the backend produces
  seg-0/init a beat after the playlist. mpv's ffmpeg HLS demuxer is configured to
  **reconnect on HTTP 4xx/5xx** (`demuxer-lavf-o` in `addon.cc`) so it retries
  like Shaka instead of aborting on the first 404/503.
- `isNative` is true for Electron (the UA matches `\bElectron\/`), so the desktop
  resolves to the `DESKTOP` engine kind (`client/.../engine-traits.ts`), which
  sets `probesSegZero: true` (Shaka-like: backend pre-spawns the seg-0 companion).
