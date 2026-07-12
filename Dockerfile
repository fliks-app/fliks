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

# --- Stage 2c: Build libplacebo with Dolby Vision (libdovi) ---
# The apt libplacebo isn't built with libdovi, so ffmpeg's `apply_dolbyvision`
# is a silent no-op there and a DV Profile 5 source renders wrong. Rebuild the
# SAME libplacebo version (identical soname → drop-in for the apt ffmpeg) with
# libdovi so P5 can be RPU-tonemapped. Pin LIBPLACEBO_TAG to the runtime's apt
# libplacebo version (check `apt-cache policy libplacebo338`) so the ABI matches.
FROM ubuntu:24.04 AS libplacebo-dovi-build
ARG LIBPLACEBO_TAG=v6.338.2
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential pkg-config \
    meson ninja-build glslang-dev libvulkan-dev liblcms2-dev python3-mako \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
  && . "$HOME/.cargo/env" \
  && cargo install cargo-c \
  && git clone --depth 1 https://github.com/quietvoid/dovi_tool /tmp/dovi_tool \
  && cd /tmp/dovi_tool/dolby_vision \
  && cargo cinstall --release --prefix=/opt/dvlibs --libdir=/opt/dvlibs/lib \
  && git clone --depth 1 --branch "$LIBPLACEBO_TAG" \
       https://code.videolan.org/videolan/libplacebo.git /tmp/libplacebo \
  && cd /tmp/libplacebo \
  && PKG_CONFIG_PATH=/opt/dvlibs/lib/pkgconfig meson setup build \
       -Dlibdovi=enabled -Dvulkan=enabled -Dglslang=enabled \
       -Ddemos=false -Dtests=false --buildtype=release --prefix=/opt/plbo --libdir=lib \
  && ninja -C build && ninja -C build install \
  && rm -rf /var/lib/apt/lists/* "$HOME/.cargo/registry" "$HOME/.rustup" \
       /tmp/dovi_tool /tmp/libplacebo

# --- Stage 3: Production runtime ---
FROM ubuntu:24.04

# Populated by Docker buildx with the target platform's arch (amd64,
# arm64, ...). Used below to skip x86-only packages on arm64 builds.
ARG TARGETARCH

# Install Node.js 24
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get purge -y curl gnupg \
  && rm -rf /var/lib/apt/lists/*

# Install runtime dependencies + FFmpeg. Intel GPU stack and the alass
# binary are amd64-only — on arm64 (Apple Silicon Docker, ARM NAS, Pi)
# the image falls back to CPU transcoding (libx264) and subtitle sync
# via ffsubsync alone. ffmpeg apt package is arch-aware on both.
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  postgresql-client \
  procps \
  python3 \
  python3-pip \
  python3-venv \
  ffmpeg \
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
         intel-media-va-driver-non-free \
         intel-opencl-icd \
         libmfx-gen1.2 \
         libvpl2 \
         libvulkan1 \
         mesa-vulkan-drivers \
         vainfo; \
     fi \
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

# libdovi + the libdovi-enabled libplacebo, dropped in over the apt libplacebo
# so the apt ffmpeg can RPU-tonemap DV Profile 5. amd64 only — it's paired with
# the Intel Vulkan stack above; arm64 keeps the stock libplacebo (the DV probe
# fails closed there and P5 falls back to the standard transcode).
COPY --from=libplacebo-dovi-build /opt/dvlibs/lib/ /tmp/dvlibs/
COPY --from=libplacebo-dovi-build /opt/plbo/lib/ /tmp/dvlibs/
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      cp -a /tmp/dvlibs/libdovi.so* /usr/lib/x86_64-linux-gnu/ \
      && cp -a /tmp/dvlibs/libplacebo.so* /usr/lib/x86_64-linux-gnu/ \
      && ldconfig; \
    fi \
  && rm -rf /tmp/dvlibs

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
