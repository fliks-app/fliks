# Builds the vendored Linux libmpv with mpv-build, the mpv project's own
# out-of-tree builder: it links FFmpeg, libass and libplacebo statically into
# libmpv, which is what keeps Electron's libffmpeg from hijacking av_*.
# Driven by vendor-libmpv-linux.sh, which explains why.
ARG BASE=ubuntu:24.04
FROM ${BASE}

ARG JOBS=4
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      build-essential autoconf automake libtool ca-certificates curl git \
      pkg-config python3-pip nasm \
      libfreetype-dev libfribidi-dev libharfbuzz-dev libfontconfig-dev \
      libgnutls28-dev libx11-dev libxext-dev libxrandr-dev libxpresent-dev \
      libxss-dev libgl-dev libegl-dev libva-dev libdrm-dev zlib1g-dev \
      libasound2-dev libpulse-dev \
 && rm -rf /var/lib/apt/lists/*

# --break-system-packages is unknown to pip < 23 and mandatory from 24.04 on.
RUN pip3 install --quiet --upgrade --break-system-packages meson ninja \
 || pip3 install --quiet --upgrade meson ninja

# libass and libplacebo are built static, and a plain `pkg-config --libs` hides
# the Libs.private they need (libunibreak, stdc++): libmpv would otherwise link
# with those symbols left undefined.
RUN printf '#!/bin/sh\nexec /usr/bin/pkg-config --static "$@"\n' > /usr/local/bin/pkg-config-static \
 && chmod +x /usr/local/bin/pkg-config-static
ENV PKG_CONFIG=/usr/local/bin/pkg-config-static \
    PKG_CONFIG_PATH=/build/deps/lib/pkgconfig

# The one dependency mpv-build leaves to the distro, and the one whose soname
# bumped between LTS releases. Its own prefix: mpv-build wipes build_libs.
ARG UNIBREAK_VERSION
RUN mkdir -p /build/src && cd /build/src \
 && curl -sL "https://github.com/adah1972/libunibreak/releases/download/libunibreak_$(echo "$UNIBREAK_VERSION" | tr . _)/libunibreak-$UNIBREAK_VERSION.tar.gz" | tar xz \
 && cd "libunibreak-$UNIBREAK_VERSION" \
 && ./configure --prefix=/build/deps --enable-static --disable-shared --with-pic \
 && make -j"$JOBS" && make install

RUN git clone -q https://github.com/mpv-player/mpv-build.git /build/mpv-build
WORKDIR /build/mpv-build
ARG FFMPEG_VERSION
ARG LIBASS_VERSION
ARG LIBPLACEBO_VERSION
ARG MPV_VERSION
RUN ./use-ffmpeg-custom "$FFMPEG_VERSION" \
 && ./use-libass-custom "$LIBASS_VERSION" \
 && ./use-libplacebo-custom "$LIBPLACEBO_VERSION" \
 && ./use-mpv-custom "$MPV_VERSION"

# FFmpeg: lean on purpose — every codec library would add a dynamic dependency
# whose soname can churn. VAAPI and libdrm are the exceptions (hwdec), both
# stable, and GnuTLS carries https (OpenSSL would force --enable-nonfree here).
RUN printf '%s\n' \
      --disable-programs --disable-autodetect --enable-version3 \
      --enable-gnutls --enable-zlib --enable-vaapi --enable-libdrm \
      > ffmpeg_options \
 && printf '%s\n' \
      -Dlibmpv=true -Dcplayer=false -Dgpl=true \
      -Dlibbluray=disabled -Drubberband=disabled -Ddrm=disabled -Dwayland=disabled \
      -Dlua=disabled -Djavascript=disabled -Dlibarchive=disabled -Duchardet=disabled \
      -Dvapoursynth=disabled -Dzimg=disabled -Djpeg=disabled \
      -Dx11=enabled -Degl=enabled -Dgl=enabled -Dvaapi=enabled \
      -Dalsa=enabled -Dpulse=enabled \
      > mpv_options

RUN ./rebuild -j"$JOBS" && cp -L mpv/build/libmpv.so.2 /libmpv.so.2
