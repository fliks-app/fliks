# ============================================================
# Fliks — production image (backend + client)
# ============================================================

# --- Stage 1: Build client ---
FROM node:24-alpine AS client-build
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ .
RUN npx ng build --configuration=production

# --- Stage 2: Build backend ---
FROM node:24-alpine AS backend-build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ .
RUN npm run build

# --- Stage 2b: Build subtile-ocr (VobSub → SRT) ---
# No prebuilt binary is published, so compile it against the same tesseract /
# leptonica the runtime ships (same ubuntu:24.04 base → matching lib ABI).
# buildx runs this per target arch, so it works on amd64 and arm64 alike.
FROM ubuntu:24.04 AS vobsub-ocr-build
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl build-essential pkg-config clang libclang-dev \
  libtesseract-dev libleptonica-dev \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
  && . "$HOME/.cargo/env" \
  && cargo install subtile-ocr --version 0.2.6 --root /opt/subtile-ocr \
  && rm -rf /var/lib/apt/lists/* "$HOME/.cargo/registry" "$HOME/.rustup"

# --- Stage 2c: Build libplacebo with Dolby Vision (libdovi), ABI-matched to
#     jellyfin-ffmpeg ---
# jellyfin-ffmpeg bundles libplacebo but WITHOUT libdovi (their build has no
# -Dlibdovi), so `apply_dolbyvision` is a no-op and DV Profile 5 renders wrong
# (#636). Rebuild libplacebo at the SAME commit jellyfin uses — identical soname
# (.so.360), a drop-in for the bundled ffmpeg — with libdovi enabled, and overlay
# it in the runtime stage. Keep LIBPLACEBO_COMMIT in sync with jellyfin-ffmpeg's
# builder/scripts.d/50-libplacebo.sh (SCRIPT_COMMIT) for the pinned version.
FROM ubuntu:24.04 AS libplacebo-dovi-build
ARG LIBPLACEBO_COMMIT=cee9b076f2c63104ccfd497fa79c39a867293ec4
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential pkg-config libssl-dev \
    meson ninja-build libshaderc-dev libvulkan-dev liblcms2-dev python3-mako python3-jinja2 \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
  && . "$HOME/.cargo/env" \
  && cargo install cargo-c \
  && git clone --depth 1 https://github.com/quietvoid/dovi_tool /tmp/dovi_tool \
  && cd /tmp/dovi_tool/dolby_vision \
  && cargo cinstall --release --prefix=/opt/dvlibs --libdir=/opt/dvlibs/lib \
  && git clone https://code.videolan.org/videolan/libplacebo.git /tmp/libplacebo \
  && cd /tmp/libplacebo \
  && git checkout "$LIBPLACEBO_COMMIT" \
  && git submodule update --init --recursive \
  && PKG_CONFIG_PATH=/opt/dvlibs/lib/pkgconfig meson setup build \
       -Dlibdovi=enabled -Dvulkan=enabled -Dvk-proc-addr=enabled -Dshaderc=enabled \
       -Dglslang=disabled -Dopengl=disabled -Dd3d11=disabled \
       -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false \
       --default-library=shared --buildtype=release --prefix=/opt/plbo --libdir=lib \
  && ninja -C build && ninja -C build install \
  && rm -rf /var/lib/apt/lists/* "$HOME/.cargo/registry" "$HOME/.rustup" \
       /tmp/dovi_tool /tmp/libplacebo

# --- Stage 3: Production runtime ---
FROM ubuntu:24.04

# Populated by Docker buildx with the target platform's arch (amd64,
# arm64, ...). Used below to skip x86-only packages on arm64 builds.
ARG TARGETARCH

# jellyfin-ffmpeg release to bundle. Same build as the Windows server (unified).
ARG JELLYFIN_FFMPEG_VERSION=8.1.2-1

# Install Node.js 24
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get purge -y curl gnupg \
  && rm -rf /var/lib/apt/lists/*

# Install runtime dependencies + FFmpeg (jellyfin-ffmpeg — self-contained
# VAAPI/QSV stack). jellyfin-ffmpeg bundles libva, iHD and oneVPL/libmfx, so the
# apt ffmpeg and Intel VA drivers are gone. It does NOT bundle intel-opencl-icd
# (tonemap_opencl), the Vulkan driver, lcms2 (libplacebo deps) or libdovi
# (overlaid below) — those stay, amd64-only. The jellyfin-ffmpeg deb is per-arch;
# on arm64 there's no Intel HW so the image is CPU-only (libx264) + ffsubsync.
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  postgresql-client \
  procps \
  python3 \
  python3-pip \
  python3-venv \
  libchromaprint-tools \
  mkvtoolnix \
  tesseract-ocr \
  tesseract-ocr-all \
  wget \
  ca-certificates \
  gcc \
  python3-dev \
  libc6-dev \
  && if [ "$TARGETARCH" = "amd64" ]; then \
       apt-get install -y --no-install-recommends \
         intel-opencl-icd \
         libvulkan1 \
         libshaderc1 \
         liblcms2-2 \
         mesa-vulkan-drivers; \
     fi \
  && wget -q -O /tmp/jellyfin-ffmpeg.deb "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${JELLYFIN_FFMPEG_VERSION}/jellyfin-ffmpeg8_${JELLYFIN_FFMPEG_VERSION}-noble_${TARGETARCH}.deb" \
  && apt-get install -y --no-install-recommends /tmp/jellyfin-ffmpeg.deb \
  && ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
  && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
  && rm -f /tmp/jellyfin-ffmpeg.deb \
  && python3 -m pip install --no-cache-dir --break-system-packages ffsubsync pgsrip \
  && if [ "$TARGETARCH" = "amd64" ]; then \
       wget -q -O /usr/local/bin/alass https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64 \
       && chmod +x /usr/local/bin/alass; \
     fi \
  && apt-get purge -y wget gcc python3-dev libc6-dev \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# VobSub OCR binary (links against the tesseract/leptonica installed above).
COPY --from=vobsub-ocr-build /opt/subtile-ocr/bin/subtile-ocr /usr/local/bin/subtile-ocr

# Overlay the libdovi-enabled libplacebo (built at jellyfin's commit) over the
# bundled one, which ships without libdovi — restores DV Profile 5 (#636).
# libplacebo → jellyfin's lib dir (loaded via ffmpeg's rpath); libdovi → the
# system path + ldconfig (libplacebo resolves it transitively there). amd64 only —
# arm64 keeps the bundled libplacebo (no HW transcode; P5 falls back to standard).
COPY --from=libplacebo-dovi-build /opt/dvlibs/lib/ /tmp/dvlibs/
COPY --from=libplacebo-dovi-build /opt/plbo/lib/ /tmp/dvlibs/
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      cp -a /tmp/dvlibs/libplacebo.so* /usr/lib/jellyfin-ffmpeg/lib/ \
      && cp -a /tmp/dvlibs/libdovi.so* /usr/lib/x86_64-linux-gnu/ \
      && ldconfig; \
    fi \
  && rm -rf /tmp/dvlibs

# Register the NVIDIA OpenCL ICD so tonemap_opencl can run HDR→SDR on the GPU
# on NVENC hosts. The container toolkit mounts libnvidia-opencl.so with the
# `compute` capability (same path as CUDA/NVENC, no Vulkan/GLX needed) but
# doesn't create the ICD entry — without it the OpenCL loader reports no
# NVIDIA platform. Arch-agnostic: the entry is just the soname, resolved
# per-arch by the loader, and harmless on non-NVIDIA hosts (the loader skips
# an ICD whose library is absent), so it runs for amd64 and arm64 alike (the
# latter covers NVIDIA-on-ARM hosts like Jetson / Grace).
RUN mkdir -p /etc/OpenCL/vendors \
  && echo 'libnvidia-opencl.so.1' > /etc/OpenCL/vendors/nvidia.icd

WORKDIR /app

# Copy backend production dependencies
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built backend
COPY --from=backend-build /app/dist ./dist

# Copy built client into a static folder served by the backend
COPY --from=client-build /app/dist/client/browser ./client

ENV NODE_ENV=production
ENV SERVE_STATIC_PATH=/app/client

# Provider API keys baked at build time from CI secrets. Empty in local
# builds unless `--build-arg TMDB_API_KEY=… --build-arg TVDB_API_KEY=…`
# is passed; the published image carries the keys configured in the
# repo's GitHub Actions secrets.
ARG TMDB_API_KEY=""
ARG TVDB_API_KEY=""
ENV TMDB_API_KEY=${TMDB_API_KEY}
ENV TVDB_API_KEY=${TVDB_API_KEY}

# Persistent conf dir for auto-generated server-side secrets (JWT
# signing key, future encryption keys, etc.). Mount this as a Docker
# volume so the secret survives container restarts and image
# rebuilds. Permissions stay 0700; the secret files inside are 0600.
RUN mkdir -p /app/conf && chmod 700 /app/conf
VOLUME /app/conf

EXPOSE 4848

CMD ["node", "dist/main"]
