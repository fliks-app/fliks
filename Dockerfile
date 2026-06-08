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
