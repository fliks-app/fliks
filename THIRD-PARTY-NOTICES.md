# Third-party notices

Fliks itself is licensed under the **GNU Affero General Public License v3.0**
(see [`LICENSE`](./LICENSE)).

Each Fliks distribution bundles unmodified third-party programs, each under its
own license. Their corresponding source is publicly available from the upstream
projects and archives linked below.

## Server: Docker image

Built on **Ubuntu 24.04**, whose packages keep their own licenses (see
`/usr/share/doc/*/copyright` in the image). Fliks invokes the programs below as
**separate processes** (e.g. via `execFile`), so they are aggregated alongside
Fliks rather than linked into it.

| Component | License | Source |
|---|---|---|
| jellyfin-ffmpeg (ffmpeg / ffprobe, bundles libva, Intel iHD driver, oneVPL) | GPL-3.0-or-later | https://github.com/jellyfin/jellyfin-ffmpeg |
| intel-opencl-icd (amd64 only, Ubuntu archive) | MIT | https://github.com/intel/compute-runtime |
| MKVToolNix (`mkvextract`) | GPL-2.0 | https://mkvtoolnix.download |
| Tesseract OCR | Apache-2.0 | https://github.com/tesseract-ocr/tesseract |
| Tesseract trained data (`tesseract-ocr-*` language packs) | Apache-2.0 | https://github.com/tesseract-ocr/tessdata |
| subtile-ocr (compiled from crates.io) | GPL-3.0 | https://github.com/gwen-lg/subtile-ocr |
| pgsrip (PyPI) | MIT | https://github.com/ratoaq2/pgsrip |
| pysrt (PyPI, pgsrip dependency) | GPL-3.0 | https://github.com/byroot/pysrt |
| opencv-python-headless (PyPI, bundles an LGPL FFmpeg) | Apache-2.0 | https://github.com/opencv/opencv-python |
| ffsubsync (PyPI) | MIT | https://github.com/smacke/ffsubsync |
| alass (amd64 only, upstream release binary) | GPL-3.0 | https://github.com/kaegi/alass |
| Chromaprint (`libchromaprint-tools`) | LGPL-2.1-or-later | https://github.com/acoustid/chromaprint |
| Node.js runtime (NodeSource) | MIT | https://github.com/nodejs/node |
| PostgreSQL client (PGDG archive) | PostgreSQL License | https://www.postgresql.org |

## Server: Windows and macOS apps

Both bundle the programs below, also run as separate processes.

| Component | License | Source |
|---|---|---|
| jellyfin-ffmpeg (portable build) | GPL-3.0-or-later | https://github.com/jellyfin/jellyfin-ffmpeg |
| PostgreSQL (Windows: EDB binaries; macOS: Homebrew bottle) | PostgreSQL License | https://www.postgresql.org |
| Node.js runtime | MIT | https://github.com/nodejs/node |
| Microsoft Visual C++ runtime DLLs (Windows only) | Microsoft redistributable license | https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist |

## Desktop client

The desktop client plays media through **mpv**. On Linux and macOS, libmpv is
loaded **into the Fliks process**; mpv's GPL-2.0-or-later terms are compatible
with Fliks' AGPL-3.0. The Linux build enables FFmpeg's `version3`, so that
library is distributed under GPL-3.0.

| Component | License | Source |
|---|---|---|
| libmpv (Linux: built with `-Dgpl=true`, FFmpeg, libass, libplacebo and libunibreak linked statically) | GPL-3.0 | https://github.com/mpv-player/mpv |
| libmpv and its dylibs (macOS, from Homebrew) | GPL-2.0-or-later | https://github.com/mpv-player/mpv |
| mpv.exe and its DLLs (Windows, zhongfly/mpv-winbuild) | GPL-2.0-or-later | https://github.com/zhongfly/mpv-winbuild |
| Electron (bundles Chromium) | MIT (Chromium: BSD-3-Clause and others) | https://github.com/electron/electron |

## Package-manager dependencies

npm, Gradle, CocoaPods and Swift packages declare their own licenses in their
respective manifests; this file covers the programs embedded outside them.
