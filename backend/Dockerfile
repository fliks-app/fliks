# --- Build libplacebo with Dolby Vision (libdovi), ABI-matched to jellyfin-ffmpeg ---
# jellyfin-ffmpeg bundles libplacebo but WITHOUT libdovi (their build has no
# -Dlibdovi), so `apply_dolbyvision` is a no-op and DV Profile 5 renders wrong
# (#636). Rebuild libplacebo at the SAME commit jellyfin uses — identical soname
# (.so.360), so it's a drop-in for the bundled ffmpeg — with libdovi enabled, and
# overlay it below. Keep LIBPLACEBO_COMMIT in sync with jellyfin-ffmpeg's
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

FROM ubuntu:24.04

# jellyfin-ffmpeg release to bundle. Same build as the Windows server (unified).
ARG JELLYFIN_FFMPEG_VERSION=8.1.2-1

# Install Node.js 24
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get purge -y curl gnupg \
  && rm -rf /var/lib/apt/lists/*

# Install runtime dependencies + FFmpeg (jellyfin-ffmpeg). jellyfin-ffmpeg bundles
# the VAAPI/QSV stack (libva, iHD, oneVPL/libmfx), so the apt ffmpeg and Intel VA
# drivers are gone. It does NOT bundle: intel-opencl-icd (the Intel OpenCL compute
# runtime for tonemap_opencl) or the Vulkan driver (libplacebo's DV path needs it)
# — kept here — nor libdovi (overlaid below).
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  postgresql-client \
  procps \
  python3 \
  python3-pip \
  python3-venv \
  libchromaprint-tools \
  tesseract-ocr \
  tesseract-ocr-all \
  intel-opencl-icd \
  libvulkan1 \
  libshaderc1 \
  liblcms2-2 \
  mesa-vulkan-drivers \
  wget \
  ca-certificates \
  gcc \
  python3-dev \
  libc6-dev \
  && python3 -m pip install --no-cache-dir --break-system-packages ffsubsync pgsrip \
  && wget -q -O /usr/local/bin/alass https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64 \
  && chmod +x /usr/local/bin/alass \
  && wget -q -O /tmp/jellyfin-ffmpeg.deb "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${JELLYFIN_FFMPEG_VERSION}/jellyfin-ffmpeg8_${JELLYFIN_FFMPEG_VERSION}-noble_amd64.deb" \
  && apt-get install -y --no-install-recommends /tmp/jellyfin-ffmpeg.deb \
  && ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
  && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
  && rm -f /tmp/jellyfin-ffmpeg.deb \
  && apt-get purge -y wget gcc python3-dev libc6-dev \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Overlay the libdovi-enabled libplacebo (built at jellyfin's commit) over the
# bundled one, which ships without libdovi — restores DV Profile 5 (#636).
# libplacebo goes into jellyfin's lib dir (loaded via ffmpeg's rpath); libdovi
# goes into the system path + ldconfig (libplacebo resolves it transitively there,
# not via ffmpeg's rpath). libplacebo's other deps (vulkan, shaderc, lcms2) are
# the apt packages above.
COPY --from=libplacebo-dovi-build /opt/dvlibs/lib/ /tmp/dvlibs/
COPY --from=libplacebo-dovi-build /opt/plbo/lib/ /tmp/dvlibs/
RUN cp -a /tmp/dvlibs/libplacebo.so* /usr/lib/jellyfin-ffmpeg/lib/ \
  && cp -a /tmp/dvlibs/libdovi.so* /usr/lib/x86_64-linux-gnu/ \
  && ldconfig \
  && rm -rf /tmp/dvlibs

WORKDIR /app

ENV NODE_ENV=development
ENV CHOKIDAR_USEPOLLING=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 4848

CMD ["npm", "run", "start:dev"]
