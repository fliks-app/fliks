# Fliks desktop client

Native desktop client for macOS / Windows / Linux. A **thin client** that
connects to a remote Fliks server like the mobile apps (not the menu-bar server
host under `macos/`). Linux is the current dev platform.

## Architecture

```
Electron main
  ├─ OSR BrowserWindow (offscreen, transparent)  → built Angular app, painted to a BGRA bitmap
  └─ native addon (SDL2 + GLES 3.2)              → the single visible window:
        mpv video (libmpv render API → GL FBO)  composited under  the Angular UI bitmap
```

- `native/compositor/addon.cc` — owns the visible SDL/GLES window; runs mpv via
  the **render API**, uploads the UI bitmap as a GL texture, composites the two,
  and forwards SDL input + mpv events to the main process (N-API).
- `src/main/index.ts` — Electron main: the offscreen UI window, loads the addon,
  routes player IPC (`window.fliksDesktop`) and mpv events to/from the renderer.
- `src/preload/index.ts` — exposes `window.fliksDesktop`, consumed by the Angular
  `DesktopEngine` (`client/src/app/core/services/playback-engine/`).
- `src/main/{protocol,cors}.ts` — `fliks://` SPA protocol + CORS bypass.
- `src/shared/contract.ts` — the IPC contract.

We composite ourselves (rather than embedding an mpv child window) because under
**Mutter/X11** an embedded child can't be stacked beneath a sibling transparent
overlay. mpv runs from a self-contained static **libmpv**, so on Linux HDR is
**SDR tone-mapped** (render API uses `vo_gpu`).

## Develop

### Dependencies

System packages (Debian/Ubuntu) — for compiling the native addon:
```bash
sudo apt install -y build-essential python3 pkg-config \
  libsdl2-dev libgles2-mesa-dev libegl1-mesa-dev libmpv-dev
```
Node packages (Node ≥ 20):
```bash
npm install
```
A self-contained `native/vendor/libmpv.so.2` is also required at runtime (it is
gitignored — see `CLAUDE.md`).

### Build & run

```bash
# 1. native addon (Electron 42 ABI)
cd native && ../node_modules/.bin/node-gyp rebuild \
  --target=42.4.0 --dist-url=https://electronjs.org/headers --arch=x64 && cd ..

# 2. main + preload bundle
npm run build            # → dist/main/index.cjs, dist/preload/index.cjs

# 3. Angular client (from repo root) + copy to a writable dir
cd ../client && npx ng build --configuration=development && cd ../desktop
rm -rf /tmp/fliks-verify/browser && mkdir -p /tmp/fliks-verify/browser \
  && cp -r ../client/dist/client/browser/. /tmp/fliks-verify/browser/

# run (dev box needs --no-sandbox)
FLIKS_WEB_DIR=/tmp/fliks-verify/browser DISPLAY=:0 \
  ./node_modules/.bin/electron . --no-sandbox

npm run typecheck        # tsc --noEmit
```

See **`CLAUDE.md`** for which unit to rebuild per edit, env vars
(`FLIKS_MPV_PATH`, `FLIKS_HWDEC`, `FLIKS_MPV_LOGLEVEL`), logs, process
management, and testing against a local backend.
