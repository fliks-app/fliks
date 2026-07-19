# Third-party notices

Fliks itself is licensed under the **GNU Affero General Public License v3.0**
(see [`LICENSE`](./LICENSE)).

The distributed Docker image bundles unmodified third-party programs. Fliks
invokes them as **separate processes** (e.g. via `execFile`), so they are
aggregated alongside Fliks rather than linked into it — each keeps its own
license. The copyleft components below are shipped as-is from the Ubuntu and
PyPI archives; their corresponding source is publicly available from those
archives and the upstream projects linked here.

| Component | License | Source |
|---|---|---|
| FFmpeg / ffprobe | GPL-2.0-or-later (Ubuntu build) | https://ffmpeg.org |
| Tesseract OCR | Apache-2.0 | https://github.com/tesseract-ocr/tesseract |
| Tesseract trained data (`tesseract-ocr-*` language packs) | Apache-2.0 | https://github.com/tesseract-ocr/tessdata |
| pgsrip | MIT (pulls `pysrt`, GPL-3.0, at runtime) | https://github.com/ratoaq2/pgsrip |
| alass | GPL-3.0 | https://github.com/kaegi/alass |
| ffsubsync | MIT | https://github.com/smacke/ffsubsync |
| Chromaprint (`libchromaprint-tools`) | LGPL-2.1-or-later | https://github.com/acoustid/chromaprint |
| Intel Media Driver / oneVPL / intel-opencl-icd (amd64 only) | MIT / permissive | https://github.com/intel/media-driver |
| Node.js runtime | MIT-style | https://github.com/nodejs/node |
| PostgreSQL client | PostgreSQL License | https://www.postgresql.org |

The macOS server app bundles **jellyfin-ffmpeg** (GPL-2.0-or-later,
https://github.com/jellyfin/jellyfin-ffmpeg — FFmpeg with VideoToolbox + OpenCL)
in place of the FFmpeg row above, plus PostgreSQL and Node.js.

Node/npm package dependencies declare their own licenses in their respective
`package.json` and `node_modules`; this file covers the non-npm programs
embedded in the runtime image.
