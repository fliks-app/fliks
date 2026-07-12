# --- Build libplacebo with Dolby Vision (libdovi) ---
# The apt libplacebo isn't built with libdovi, so ffmpeg's apply_dolbyvision is
# a no-op and DV Profile 5 renders wrong. Rebuild the same libplacebo version
# (identical soname → drop-in for the apt ffmpeg) with libdovi. Keep
# LIBPLACEBO_TAG in sync with the runtime's apt libplacebo (apt-cache policy
# libplacebo338) and with the production Dockerfile.
FROM ubuntu:24.04 AS libplacebo-dovi-build
ARG LIBPLACEBO_TAG=v6.338.2
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential pkg-config libssl-dev \
    meson ninja-build libshaderc-dev libvulkan-dev liblcms2-dev python3-mako python3-jinja2 \
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
       -Dlibdovi=enabled -Dvulkan=enabled -Dshaderc=enabled -Dglslang=disabled \
       -Dopengl=disabled -Dd3d11=disabled \
       -Ddemos=false -Dtests=false --buildtype=release --prefix=/opt/plbo --libdir=lib \
  && ninja -C build && ninja -C build install \
  && rm -rf /var/lib/apt/lists/* "$HOME/.cargo/registry" "$HOME/.rustup" \
       /tmp/dovi_tool /tmp/libplacebo

FROM ubuntu:24.04

# Install Node.js 24
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get purge -y curl gnupg \
  && rm -rf /var/lib/apt/lists/*

# Install runtime dependencies + Intel GPU drivers + FFmpeg
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
  intel-media-va-driver-non-free \
  intel-opencl-icd \
  libmfx-gen1.2 \
  libvpl2 \
  libvulkan1 \
  mesa-vulkan-drivers \
  vainfo \
  wget \
  ca-certificates \
  gcc \
  python3-dev \
  libc6-dev \
  && python3 -m pip install --no-cache-dir --break-system-packages ffsubsync pgsrip \
  && wget -q -O /usr/local/bin/alass https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64 \
  && chmod +x /usr/local/bin/alass \
  && apt-get purge -y wget gcc python3-dev libc6-dev \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# libdovi + the libdovi-enabled libplacebo, dropped in over the apt libplacebo
# so ffmpeg can RPU-tonemap DV Profile 5 (the DV probe stays disabled otherwise).
COPY --from=libplacebo-dovi-build /opt/dvlibs/lib/ /tmp/dvlibs/
COPY --from=libplacebo-dovi-build /opt/plbo/lib/ /tmp/dvlibs/
RUN cp -a /tmp/dvlibs/libdovi.so* /usr/lib/x86_64-linux-gnu/ \
  && cp -a /tmp/dvlibs/libplacebo.so* /usr/lib/x86_64-linux-gnu/ \
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
