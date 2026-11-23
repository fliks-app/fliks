# ============================================================
# Fliks — production image (fliks-server + client, behind the engine)
# ============================================================

# Engine image (ffmpeg, mkvmerge, fpcalc, OpenCL, the fliks-engine binary): bump with scripts/bump-engine.sh.
ARG ENGINE_IMAGE=ghcr.io/fliks-app/engine:1.30.0@sha256:583f1e14f30bd8ec8dcc8c571ffab34a077011e84570baa3ecad58f049f0fbb2

# --- Stage 1: Build client ---
FROM node:24.22.0-alpine AS client-build
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ .
# The client imports the shell's IPC types (tsconfig path `@fliks/desktop-contract`, `../desktop` from /app).
COPY desktop/src/shared/contract.ts /desktop/src/shared/contract.ts
# The build copies it into the served client folder next to the npm licenses (`../` from /app).
COPY THIRD-PARTY-NOTICES.md /
RUN npm run build
# Only this image ships the siblings: desktop, Capacitor and TV bundles keep plain files.
COPY scripts/precompress-client.mjs /tmp/precompress-client.mjs
RUN node /tmp/precompress-client.mjs dist/client/browser

# --- Stage 2: Build fliks-server (Rust) ---
# Dependencies build in their own layer, keyed on the manifests: CI's layer cache keeps it,
# while a BuildKit cache mount is lost with the runner.
FROM lukemathwalker/cargo-chef:0.1.78-rust-1.99.0-bookworm AS server-chef
WORKDIR /server
# libarchive2-sys builds libarchive with cmake, generates its bindings with libclang and links these libraries.
RUN apt-get update && apt-get install -y --no-install-recommends cmake libclang-dev liblz4-dev libacl1-dev \
  && rm -rf /var/lib/apt/lists/*

FROM server-chef AS server-plan
COPY server/ .
RUN cargo chef prepare --recipe-path recipe.json

FROM server-chef AS server-build
COPY --from=server-plan /server/recipe.json .
RUN cargo chef cook --release --locked -p fliks-server --recipe-path recipe.json
COPY server/ .
RUN SQLX_OFFLINE=true cargo build --release --locked -p fliks-server \
    && cp target/release/fliks-server /usr/local/bin/fliks-server

# --- Stage 3: Production runtime ---
# The engine image (ffmpeg, subtitle and OCR tools) plus the PostgreSQL client tools of backup and restore.
FROM ${ENGINE_IMAGE} AS runtime-base
ENTRYPOINT []

# postgres client tools from PGDG, pinned to 18 (system.md rule 18): Ubuntu ships 16 and pg_dump refuses a
# server newer than itself, which is every supported deployment.
# The shared libraries libarchive (built into fliks-server) links, whatever the engine image ships.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget \
    zlib1g libbz2-1.0 liblzma5 libzstd1 liblz4-1 libxml2 libssl3t64 libacl1 \
  && wget -q -O /usr/share/keyrings/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] http://apt.postgresql.org/pub/repos/apt noble-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y wget \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Dev stage for the engine compose service: the engine image + a Rust toolchain, the
# engine checkout is bind-mounted and rebuilt by cargo-watch.
FROM ${ENGINE_IMAGE} AS engine-dev
ENTRYPOINT []
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends curl gcc libc6-dev \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
  && cargo install cargo-watch --locked \
  && rm -rf /var/lib/apt/lists/* "$CARGO_HOME/registry"

# Dev stage for the server compose service: a Rust toolchain on the runtime base (pg_dump for the
# pre-migration backup), sources bind-mounted and rebuilt by cargo-watch.
FROM runtime-base AS server-dev
ENTRYPOINT []
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends curl gcc libc6-dev pkg-config libssl-dev \
    cmake make libclang-dev liblz4-dev libacl1-dev libxml2-dev libbz2-dev liblzma-dev libzstd-dev zlib1g-dev \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
  && cargo install cargo-watch --locked \
  && cargo install sqlx-cli --locked --no-default-features --features rustls,postgres \
  && rm -rf /var/lib/apt/lists/* "$CARGO_HOME/registry" \
  && mkdir -p "$CARGO_HOME/registry" /cargo-target \
  && chmod -R a+rwX "$CARGO_HOME" /cargo-target

FROM runtime-base AS runtime

WORKDIR /app

# Public assets (emoji), served by fliks-server (default FLIKS_CAST_DIR=public)
COPY server/public ./public

# Copy fliks-server, the process the engine forwards to
COPY --from=server-build /usr/local/bin/fliks-server /usr/local/bin/fliks-server

# Copy built client into a static folder served by fliks-server
COPY --from=client-build /app/dist/client/browser ./client

ENV SERVE_STATIC_PATH=/app/client
ENV FLIKS_TRANSCODE_DIR=/app/transcode
ENV FLIKS_DATA_DIR=/app/data

# Persistent dirs owned by 568:0 with g=u: a fresh named volume inherits it, and an arbitrary uid
# with gid 0 (`--user <uid>`) writes there. Files the server made earlier are 644/755 or private
# (0600/0700), so a volume that another uid has written needs `chown -R <uid>:0`; so does one made by an
# older image (root).
RUN mkdir -p /app/conf /app/data /app/transcode \
 && chown -R 568:0 /app/conf /app/data /app/transcode \
 && chmod -R g=u /app/conf /app/data /app/transcode
USER 568:0
VOLUME /app/conf /app/data /app/transcode

EXPOSE 4848

# Generous: a scan saturates a low-power CPU with ffmpeg probes, and an
# orchestrator that restarts unhealthy containers would kill the scan it caused.
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
  CMD ["fliks-server", "healthcheck"]

# The engine owns the public port (PORT) and forwards non-media routes to fliks-server on 4849.
# The server listens on loopback only: the login limiter trusts the gateway's X-Forwarded-For.
ENV FLIKS_BIND=127.0.0.1
CMD ["sh", "-c", "exec fliks-engine --supervise --upstream http://127.0.0.1:4849 --public-listen 0.0.0.0:${PORT:-4848} -- fliks-server"]
