# Third-party notices

Fliks itself is licensed under the **GNU Affero General Public License v3.0**
(see [`LICENSE`](./LICENSE)).

Each Fliks distribution bundles unmodified third-party programs, each under its
own license. Their corresponding source is publicly available from the upstream
projects and archives linked below.

## Server: Docker image

Built `FROM` the **fliks-engine** image (`ghcr.io/fliks-app/engine`, version pinned in
`engine.lock`), itself built on **Ubuntu 24.04**, whose packages keep their own licenses (see
`/usr/share/doc/*/copyright` in the image). The engine starts `fliks-server` and invokes the
programs below as **separate processes**, so they are aggregated alongside
Fliks rather than linked into it.

| Component | License | Source |
|---|---|---|
| fliks-engine (the video and streaming engine, built from the engine repository) | AGPL-3.0-or-later | https://github.com/fliks-app/engine |
| jellyfin-ffmpeg (ffmpeg / ffprobe, bundles libva, Intel iHD driver, oneVPL) | GPL-3.0-or-later | https://github.com/jellyfin/jellyfin-ffmpeg |
| intel-opencl-icd (amd64 only, Ubuntu archive) | MIT | https://github.com/intel/compute-runtime |
| MKVToolNix (`mkvmerge`, `mkvextract`) | GPL-2.0-or-later | https://mkvtoolnix.download |
| Chromaprint (`libchromaprint-tools`, `fpcalc`) | LGPL-2.1-or-later | https://github.com/acoustid/chromaprint |
| Tesseract OCR | Apache-2.0 | https://github.com/tesseract-ocr/tesseract |
| Tesseract trained data (`tesseract-ocr-*` language packs) | Apache-2.0 | https://github.com/tesseract-ocr/tessdata |
| subtile-ocr (compiled from crates.io) | GPL-3.0 | https://github.com/gwen-lg/subtile-ocr |
| pgsrip (PyPI) | MIT | https://github.com/ratoaq2/pgsrip |
| pysrt (PyPI, pgsrip dependency) | GPL-3.0 | https://github.com/byroot/pysrt |
| opencv-python-headless (PyPI, bundles an LGPL FFmpeg) | Apache-2.0 | https://github.com/opencv/opencv-python |
| ffsubsync (PyPI) | MIT | https://github.com/smacke/ffsubsync |
| libarchive (built into `fliks-server` on Linux through `libarchive2-sys`, reads CB7 and CBR) | BSD-2-Clause | https://www.libarchive.org |
| PostgreSQL client (PGDG archive, `pg_dump` for the backup before a migration) | PostgreSQL License | https://www.postgresql.org |

## Server: provider plugins

`fliks-server` embeds the provider plugin archives pinned in `server/providers.lock` (`fliks.tmdb`,
`fliks.tvdb`, `fliks.openlibrary`, `fliks.bnf`, `fliks.googlebooks`, `fliks.audible`,
`fliks.audnexus`, `fliks.thexem`) at build time. They are built from
https://github.com/fliks-app/plugins and licensed **AGPL-3.0-or-later**, like Fliks; each plugin
folder there holds its own `LICENSE`.

## Server: Windows and macOS apps

Both bundle the programs below; `fliks-engine` starts `fliks-server`, and the other programs run as
separate processes.

| Component | License | Source |
|---|---|---|
| fliks-engine (release binary pinned in `engine.lock`) | AGPL-3.0-or-later | https://github.com/fliks-app/engine |
| jellyfin-ffmpeg (portable build) | GPL-3.0-or-later | https://github.com/jellyfin/jellyfin-ffmpeg |
| PostgreSQL (Windows: EDB binaries; macOS: Homebrew bottle) | PostgreSQL License | https://www.postgresql.org |
| Microsoft Visual C++ runtime DLLs (Windows only) | Microsoft redistributable license | https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist |

## Desktop client

The desktop client plays media through **mpv**. On Linux and macOS, libmpv is
loaded **into the Fliks process**; mpv's GPL-2.0-or-later terms are compatible
with Fliks' AGPL-3.0. Every build below links an FFmpeg configured with
`--enable-gpl --enable-version3`, so each is distributed under GPL-3.0.

| Component | License | Source |
|---|---|---|
| libmpv (Linux: built with `-Dgpl=true`, FFmpeg, libass, libplacebo and libunibreak linked statically) | GPL-3.0 | https://github.com/mpv-player/mpv |
| libmpv and its dylibs (macOS, from Homebrew) | GPL-3.0 | https://github.com/mpv-player/mpv |
| mpv.exe and its DLLs (Windows, zhongfly/mpv-winbuild, GPL variant, re-hosted unmodified on the Fliks releases) | GPL-3.0 | https://github.com/zhongfly/mpv-winbuild |
| SDL3 (Linux, bundled with the compositor addon) | zlib | https://github.com/libsdl-org/SDL |
| libva-x11 and libXpresent (Linux .deb and AppImage, from the Ubuntu 24.04 archive, `libva-x11-2` and `libxpresent1`) | MIT | https://github.com/intel/libva and https://gitlab.freedesktop.org/xorg/lib/libxpresent |
| Electron (bundles Chromium) | MIT (Chromium: BSD-3-Clause and others) | https://github.com/electron/electron |

## Client: reader fonts and PDF viewer

The web and app clients copy the files below out of their npm packages at build time
(`client/angular.json` assets), so they ship as separate files.

| Component | License | Source | Use |
|---|---|---|---|
| Literata (`@fontsource-variable/literata`) | OFL-1.1 | https://github.com/googlefonts/literata | reader font; license text at `reader-fonts/literata/LICENSE` |
| Atkinson Hyperlegible (`@fontsource/atkinson-hyperlegible`) | OFL-1.1 | https://github.com/googlefonts/atkinson-hyperlegible | reader font; license text at `reader-fonts/atkinson-hyperlegible/LICENSE` |
| pdfjs-dist worker | Apache-2.0 | https://github.com/mozilla/pdf.js | PDF reader |
| OpenJPEG decoder (pdfjs-dist `openjpeg_nowasm_fallback.js`) | BSD-2-Clause | https://github.com/uclouvain/openjpeg | JPEG 2000 images in PDFs; license texts at `pdfjs/wasm/LICENSE_OPENJPEG` and `LICENSE_PDFJS_OPENJPEG` |
| JBIG2 decoder from PDFium (pdfjs-dist `jbig2_nowasm_fallback.js`) | BSD-3-Clause AND Apache-2.0 | https://pdfium.googlesource.com/pdfium | JBIG2 images in PDFs; license texts at `pdfjs/wasm/LICENSE_JBIG2` and `LICENSE_PDFJS_JBIG2` |

## Server: reaction emoji artwork

The watch-party reactions ship the animated artwork below, resized (see
`server/public/emoji/LICENSE.md`). It is the one modified third-party asset.

| Component | License | Source | Modification |
|---|---|---|---|
| Noto Emoji Animation (Google) | CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) | https://googlefonts.github.io/noto-emoji-animation/ | resized to 72 px animated WebP |

## Emoji data

The watch-party reaction picker uses the two datasets below. Both are compiled from the Unicode
Consortium's emoji and CLDR data (Unicode-3.0).

| Component | License | Source | Use |
|---|---|---|---|
| emojibase-data | MIT | https://github.com/milesj/emojibase | localized names and groups, bundled as one lazy chunk per UI language |
| emojis (Rust crate) | (MIT OR Apache-2.0) AND Unicode-3.0 | https://github.com/rossmacarthur/emojis | server-side check that a reaction is a standard emoji |

## Server: KEPUB conversion

The `kepub` crate (`server/crates/kepub`) is a Rust port of the transformations of
**kepubify** (https://github.com/pgaskin/kepubify), linked into every server build. kepubify's
license applies to the ported logic:

> MIT License
>
> Copyright (c) 2016 Patrick Gaskin
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Package-manager dependencies

npm, Cargo (the Rust crates linked into `fliks-server` and the provider plugins), Gradle, CocoaPods
and Swift packages declare their own licenses in their
respective manifests; this file covers the programs embedded outside them.
