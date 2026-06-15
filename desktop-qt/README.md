# Fliks desktop — Qt + QtWebEngine + libmpv (spike)

Feasibility spike for replacing the Electron+SDL/GLES compositor shell. Proves
the Plex/Jellyfin Media Player architecture: a transparent `WebEngineView`
composited **over** libmpv video in one Qt Quick GL scene — no OSR, so it runs
on **native Wayland** (where Electron's X11-only offscreen renderer segfaults).

## Why
- The Angular client renders inside QtWebEngine (Chromium) — same web app.
- libmpv renders into a `QQuickFramebufferObject` (`MpvObject`) at the back of
  the scene; the `WebEngineView` (transparent) sits on top. Qt composites them.
- Qt owns windowing + GL cross-platform → no ANGLE/SDL porting for mac/win, and
  native Wayland on Linux.

## Build deps (Ubuntu 24.04, Qt 6.4)
```
sudo apt install -y qt6-webengine-dev qt6-webengine-dev-tools \
  qt6-declarative-dev qt6-declarative-dev-tools qt6-wayland
# (qt6-base-dev + libmpv-dev are already present)
```

## Build & run
```
cd desktop-qt
cmake -B build -G Ninja .       # or: cmake -B build .
cmake --build build
# native Wayland (the point of the spike):
QT_QPA_PLATFORM=wayland ./build/fliks_qt_spike
# X11/XWayland for comparison:
QT_QPA_PLATFORM=xcb     ./build/fliks_qt_spike
```
The spike loads `/tmp/wid-spike/test.mp4` (generated during the --wid spike;
regenerate with `ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30 -t 120 ...`).

## Spike pass criteria
Video (test pattern) visible, the violet centre panel + bottom bar + green log
visible **over** it, the button click increments — on `QT_QPA_PLATFORM=wayland`.

## Not in the spike (the real port, later)
- QtWebChannel JS↔native bridge replacing Electron preload/IPC (the player
  control contract the Angular `DesktopEngine` expects).
- Input/lifecycle, server-setup, packaging (.deb/.dmg/.exe via Qt's deploy).
