# ============================================================
# Fliks — production image (backend + client)
# ============================================================

# Engine image (ffmpeg, mkvmerge, fpcalc, OpenCL, the fliks-engine binary): bump with scripts/bump-engine.sh.
ARG ENGINE_IMAGE=ghcr.io/fliks-app/engine:0.4.1

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

# --- Stage 2c: Build fliks-server (Rust) ---
FROM rust:1-bookworm AS server-build
WORKDIR /server
COPY server/ .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/server/target \
    SQLX_OFFLINE=true cargo build --release -p fliks-server \
    && cp target/release/fliks-server /usr/local/bin/fliks-server

# --- Stage 3: Production runtime ---
# Runtime toolchain: the engine image plus node and the subtitle/OCR/backup tools node still runs.
# Split out so the dev compose can build it as-is with `target: runtime-base`.
FROM ${ENGINE_IMAGE} AS runtime-base
ENTRYPOINT []

# Populated by Docker buildx with the target platform's arch (amd64,
# arm64, ...). Used below to skip x86-only packages on arm64 builds.
ARG TARGETARCH

# Install Node.js 24
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get purge -y curl gnupg \
  && rm -rf /var/lib/apt/lists/*

# Host-only tools (ffmpeg, mkvmerge, fpcalc and OpenCL come from the engine image).
RUN apt-get update && apt-get install -y --no-install-recommends \
  procps \
  python3 \
  python3-pip \
  tesseract-ocr \
  tesseract-ocr-all \
  wget \
  ca-certificates \
  gcc \
  python3-dev \
  libc6-dev \
  # postgres client tools from PGDG: Ubuntu ships 16 and pg_dump refuses a
  # server newer than itself, which is every supported deployment.
  && wget -q -O /usr/share/keyrings/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] http://apt.postgresql.org/pub/repos/apt noble-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && python3 -m pip install --no-cache-dir --break-system-packages ffsubsync pgsrip \
  # pgsrip pulls opencv-python (GUI build, needs libGL.so.1, missing here) —
  # remove it first so its files don't collide with the headless build below.
  && python3 -m pip uninstall -y --break-system-packages opencv-python \
  && python3 -m pip install --no-cache-dir --break-system-packages opencv-python-headless \
  && if [ "$TARGETARCH" = "amd64" ]; then \
       wget -q -O /usr/local/bin/alass https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64 \
       && chmod +x /usr/local/bin/alass; \
     fi \
  && apt-get purge -y wget gcc python3-dev libc6-dev \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# VobSub OCR binary (links against the tesseract/leptonica installed above).
COPY --from=vobsub-ocr-build /opt/subtile-ocr/bin/subtile-ocr /usr/local/bin/subtile-ocr

# Dev stage for docker-compose: deps in the image at /src, sources bind-mounted
# at /src/backend. Rebuild the image when package.json changes.
FROM runtime-base AS dev
WORKDIR /src
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
WORKDIR /src/backend

# Dev stage for the engine compose service: the engine image + a Rust toolchain, the
# engine checkout is bind-mounted and rebuilt by cargo-watch.
FROM ${ENGINE_IMAGE} AS engine-dev
ENTRYPOINT []
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends curl gcc libc6-dev \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
  && cargo install cargo-watch --locked \
  && rm -rf /var/lib/apt/lists/* "$CARGO_HOME/registry"

# Dev stage for the server compose service: a Rust toolchain on the engine image's base, sources
# bind-mounted and rebuilt by cargo-watch.
FROM ${ENGINE_IMAGE} AS server-dev
ENTRYPOINT []
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends curl gcc libc6-dev pkg-config libssl-dev \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
  && cargo install cargo-watch sqlx-cli --locked --no-default-features --features rustls,postgres \
  && rm -rf /var/lib/apt/lists/* "$CARGO_HOME/registry"

FROM runtime-base AS runtime

WORKDIR /app

# Copy backend production dependencies
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built backend
COPY --from=backend-build /app/dist ./dist

# Cast receiver page, served at /cast by fliks-server (default FLIKS_CAST_DIR=public)
COPY server/public ./public

# Copy fliks-server, the process the engine forwards to
COPY --from=server-build /usr/local/bin/fliks-server /usr/local/bin/fliks-server

# Copy built client into a static folder served by the backend
COPY --from=client-build /app/dist/client/browser ./client

ENV NODE_ENV=production
ENV SERVE_STATIC_PATH=/app/client
ENV FLIKS_NEST_CMD="node dist/main"
ENV FLIKS_TRANSCODE_DIR=/app/transcode

# Provider API keys baked at build time from CI secrets. Empty in local
# builds unless `--build-arg TMDB_API_KEY=… --build-arg TVDB_API_KEY=…`
# is passed; the published image carries the keys configured in the
# repo's GitHub Actions secrets.
ARG TMDB_API_KEY=""
ARG TVDB_API_KEY=""
ENV TMDB_API_KEY=${TMDB_API_KEY}
ENV TVDB_API_KEY=${TVDB_API_KEY}

# Persistent dirs, group=root + g=u: writable by root, by an arbitrary uid
# with gid 0, or via `--user <uid> --group-add 0` — no USER directive needed.
RUN mkdir -p /app/conf /app/data /app/transcode \
 && chgrp -R 0 /app/conf /app/data /app/transcode \
 && chmod -R g=u /app/conf /app/data /app/transcode
VOLUME /app/conf /app/data /app/transcode

EXPOSE 4848

# Generous: a scan saturates a low-power CPU with ffmpeg probes, and an
# orchestrator that restarts unhealthy containers would kill the scan it caused.
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
  CMD ["fliks-server", "healthcheck"]

# The engine owns the public port and forwards non-media routes to fliks-server on 4849, which spawns Nest.
CMD ["fliks-engine", "--supervise", "--upstream", "http://127.0.0.1:4849", "--", "fliks-server"]
