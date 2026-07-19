#!/usr/bin/env bash
#
# Fetch arm64 macOS binaries for bundling into Fliks Server.app.
#
# Usage: ./fetch-vendored.sh
#
# Downloads to ../Vendored/{node,postgresql,ffmpeg}/.
# Idempotent — skips already-downloaded components.

set -euo pipefail
cd "$(dirname "$0")/.."

VENDORED="$(pwd)/Vendored"
mkdir -p "$VENDORED"

# ── Versions ──
NODE_VERSION="24.2.0"
PG_VERSION="18"
ARCH="arm64"
# jellyfin-ffmpeg (GPL) — same FFmpeg 8.1 base and version as the Linux/Windows
# servers (unified). Replaces the Homebrew bottle so macOS gets the same
# libplacebo + HW tonemap filters (tonemap_opencl/videotoolbox with the DV RPU
# `apply_dovi` path), so Dolby Vision Profile 5 tone-maps correctly instead of
# rendering green/purple through the stock tonemap. Pin the exact tag.
FFMPEG_VERSION="8.1.2-1"

echo "==> Fetching vendored binaries to $VENDORED"

# ─────────────────────────────────────────────────────────────
# Node.js 24 arm64
# ─────────────────────────────────────────────────────────────
if [ -x "$VENDORED/node/bin/node" ]; then
    echo "    [skip] Node.js already present"
else
    echo "    [fetch] Node.js v${NODE_VERSION} (${ARCH})..."
    NODE_TAR="node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
    NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}"
    TMP_NODE="$(mktemp -d)"

    curl -fSL "$NODE_URL" -o "$TMP_NODE/$NODE_TAR"
    mkdir -p "$VENDORED/node"
    tar xzf "$TMP_NODE/$NODE_TAR" -C "$VENDORED/node" --strip-components=1
    rm -rf "$TMP_NODE"
    echo "    [done] Node.js v${NODE_VERSION}"
fi

# ─────────────────────────────────────────────────────────────
# PostgreSQL 18 — extract from Homebrew bottle
# ─────────────────────────────────────────────────────────────
if [ -x "$VENDORED/postgresql/bin/postgres" ]; then
    echo "    [skip] PostgreSQL already present"
else
    echo "    [fetch] PostgreSQL ${PG_VERSION} via Homebrew bottle..."
    TMP_PG="$(mktemp -d)"

    # Fetch the bottle (brew picks the right tag for the current macOS).
    brew fetch "postgresql@${PG_VERSION}" 2>/dev/null

    # brew --cache may return a path that doesn't exist yet if brew picked
    # a different bottle tag. Find the actual downloaded file.
    BOTTLE_PATH="$(find "$(brew --cache)" -name "postgresql@${PG_VERSION}--*.tar.gz" -type f 2>/dev/null | sort -t- -k3 -rV | head -1)"
    if [ -z "$BOTTLE_PATH" ] || [ ! -f "$BOTTLE_PATH" ]; then
        BOTTLE_PATH="$(brew --cache "postgresql@${PG_VERSION}")"
    fi
    mkdir -p "$VENDORED/postgresql"
    tar xzf "$BOTTLE_PATH" -C "$TMP_PG"

    # Bottle extracts to postgresql@18/<version>/. Find it.
    PG_EXTRACTED="$(find "$TMP_PG" -name "bin" -type d -path "*/postgresql@*" | head -1 | xargs dirname)"

    if [ -z "$PG_EXTRACTED" ]; then
        echo "    [error] Could not locate PostgreSQL in extracted bottle"
        rm -rf "$TMP_PG"
        exit 1
    fi

    cp -R "$PG_EXTRACTED/bin" "$VENDORED/postgresql/"
    cp -R "$PG_EXTRACTED/lib" "$VENDORED/postgresql/"
    cp -R "$PG_EXTRACTED/share" "$VENDORED/postgresql/"
    rm -rf "$TMP_PG"

    echo "    [done] PostgreSQL ${PG_VERSION}"
fi

# ─────────────────────────────────────────────────────────────
# FFmpeg — jellyfin-ffmpeg (VideoToolbox + libplacebo + DV tonemap)
# ─────────────────────────────────────────────────────────────
if [ -x "$VENDORED/ffmpeg/bin/ffmpeg" ]; then
    echo "    [skip] FFmpeg already present"
else
    echo "    [fetch] FFmpeg (jellyfin-ffmpeg ${FFMPEG_VERSION}, ${ARCH})..."
    TMP_FF="$(mktemp -d)"

    # portable_macarm64 / portable_mac64 tarball ships self-contained ffmpeg +
    # ffprobe binaries (no external dylib closure).
    FF_SLUG="$([ "$ARCH" = "arm64" ] && echo macarm64 || echo mac64)"
    FF_URL="https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${FFMPEG_VERSION}/jellyfin-ffmpeg_${FFMPEG_VERSION}_portable_${FF_SLUG}-gpl.tar.xz"
    echo "    [fetch] ${FF_URL}"
    curl -fsSL "$FF_URL" -o "$TMP_FF/ffmpeg.tar.xz"
    tar xJf "$TMP_FF/ffmpeg.tar.xz" -C "$TMP_FF"

    FF_BIN="$(find "$TMP_FF" -name ffmpeg -type f | head -1)"
    if [ -z "$FF_BIN" ]; then
        echo "    [error] ffmpeg not found in $FF_URL"
        rm -rf "$TMP_FF"
        exit 1
    fi
    # Copy the whole binary dir (ffmpeg/ffprobe + any bundled dylibs).
    mkdir -p "$VENDORED/ffmpeg/bin"
    cp -R "$(dirname "$FF_BIN")/"* "$VENDORED/ffmpeg/bin/"
    chmod +x "$VENDORED/ffmpeg/bin/ffmpeg" "$VENDORED/ffmpeg/bin/ffprobe" 2>/dev/null || true

    rm -rf "$TMP_FF"
    echo "    [done] FFmpeg (jellyfin-ffmpeg gpl)"
fi

echo ""
echo "==> All vendored binaries ready in $VENDORED"
echo "    node:       $(${VENDORED}/node/bin/node --version 2>/dev/null || echo 'not found')"
echo "    postgres:   $($VENDORED/postgresql/bin/postgres --version 2>/dev/null || echo 'not found')"
echo "    ffmpeg:     $($VENDORED/ffmpeg/bin/ffmpeg -version 2>/dev/null | head -1 || echo 'not found')"
