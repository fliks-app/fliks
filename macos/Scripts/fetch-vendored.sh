#!/usr/bin/env bash
#
# Fetch arm64 macOS binaries for bundling into Fliks.app.
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
# FFmpeg — with VideoToolbox support
# ─────────────────────────────────────────────────────────────
if [ -x "$VENDORED/ffmpeg/bin/ffmpeg" ]; then
    echo "    [skip] FFmpeg already present"
else
    echo "    [fetch] FFmpeg via Homebrew..."
    TMP_FF="$(mktemp -d)"

    brew fetch ffmpeg 2>/dev/null

    BOTTLE_PATH="$(find "$(brew --cache)" -name "ffmpeg--*.tar.gz" -type f 2>/dev/null | sort -t- -k3 -rV | head -1)"
    if [ -z "$BOTTLE_PATH" ] || [ ! -f "$BOTTLE_PATH" ]; then
        BOTTLE_PATH="$(brew --cache ffmpeg)"
    fi
    mkdir -p "$VENDORED/ffmpeg/bin"
    tar xzf "$BOTTLE_PATH" -C "$TMP_FF"

    FF_BIN="$(find "$TMP_FF" -name "ffmpeg" -type f | head -1)"
    if [ -z "$FF_BIN" ]; then
        echo "    [error] Could not locate ffmpeg binary in bottle"
        rm -rf "$TMP_FF"
        exit 1
    fi

    cp "$FF_BIN" "$VENDORED/ffmpeg/bin/ffmpeg"
    chmod +x "$VENDORED/ffmpeg/bin/ffmpeg"

    # Also grab ffprobe if present.
    FF_PROBE="$(find "$TMP_FF" -name "ffprobe" -type f | head -1)"
    if [ -n "$FF_PROBE" ]; then
        cp "$FF_PROBE" "$VENDORED/ffmpeg/bin/ffprobe"
        chmod +x "$VENDORED/ffmpeg/bin/ffprobe"
    fi

    # Copy shared libraries that ffmpeg needs.
    FF_LIB_DIR="$(dirname "$FF_BIN")/../lib"
    if [ -d "$FF_LIB_DIR" ]; then
        mkdir -p "$VENDORED/ffmpeg/lib"
        cp -R "$FF_LIB_DIR/"* "$VENDORED/ffmpeg/lib/" 2>/dev/null || true
    fi

    rm -rf "$TMP_FF"
    echo "    [done] FFmpeg"
fi

echo ""
echo "==> All vendored binaries ready in $VENDORED"
echo "    node:       $(${VENDORED}/node/bin/node --version 2>/dev/null || echo 'not found')"
echo "    postgres:   $($VENDORED/postgresql/bin/postgres --version 2>/dev/null || echo 'not found')"
echo "    ffmpeg:     $($VENDORED/ffmpeg/bin/ffmpeg -version 2>/dev/null | head -1 || echo 'not found')"
