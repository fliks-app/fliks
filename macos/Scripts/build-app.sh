#!/usr/bin/env bash
#
# Build the complete Fliks.app bundle.
#
# Prerequisites:
#   1. Run ./fetch-vendored.sh first
#   2. Xcode command line tools installed
#
# Usage: ./build-app.sh [--skip-web]
#
# --skip-web  Skip rebuilding client + backend (use existing build artifacts)

set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT="$(cd .. && pwd)"
MACOS_DIR="$(pwd)"
VENDORED="$MACOS_DIR/Vendored"
BUILD_DIR="$MACOS_DIR/build"
SKIP_WEB=false

for arg in "$@"; do
    case $arg in
        --skip-web) SKIP_WEB=true ;;
    esac
done

# Verify vendored binaries exist.
for bin in "$VENDORED/node/bin/node" "$VENDORED/postgresql/bin/postgres" "$VENDORED/ffmpeg/bin/ffmpeg"; do
    if [ ! -x "$bin" ]; then
        echo "Error: $bin not found. Run ./Scripts/fetch-vendored.sh first."
        exit 1
    fi
done

NODE="$VENDORED/node/bin/node"
NPM="$NODE $(which npm 2>/dev/null || echo "$VENDORED/node/bin/npm")"

if [ "$SKIP_WEB" = false ]; then
    # ── Build Angular client ──
    echo "==> Building Angular client..."
    cd "$REPO_ROOT/client"
    npm ci
    npx ng build --configuration=production
    echo "    [done] Client built"

    # ── Build NestJS backend ──
    echo "==> Building NestJS backend..."
    cd "$REPO_ROOT/backend"
    npm ci
    npm run build

    # Prune to production dependencies using the vendored Node
    # so native addons (bcrypt) are compiled for the right arch/version.
    echo "==> Pruning backend to production dependencies..."
    npm ci --omit=dev
    echo "    [done] Backend built"
fi

# ── Build Swift app ──
echo "==> Building Fliks.app..."
cd "$MACOS_DIR"

xcodebuild \
    -project Fliks.xcodeproj \
    -scheme Fliks \
    -configuration Release \
    -derivedDataPath "$BUILD_DIR" \
    ONLY_ACTIVE_ARCH=YES \
    build 2>&1 | tail -5

APP_BUNDLE="$(find "$BUILD_DIR" -name "Fliks.app" -type d | head -1)"
if [ -z "$APP_BUNDLE" ]; then
    echo "Error: Fliks.app not found in build output"
    exit 1
fi

RESOURCES="$APP_BUNDLE/Contents/Resources"

# ── Copy vendored binaries into app bundle ──
echo "==> Copying resources into app bundle..."

# Node.js
mkdir -p "$RESOURCES/node/bin"
cp "$VENDORED/node/bin/node" "$RESOURCES/node/bin/"

# PostgreSQL
cp -R "$VENDORED/postgresql" "$RESOURCES/postgres"

# FFmpeg
mkdir -p "$RESOURCES/ffmpeg/bin"
cp "$VENDORED/ffmpeg/bin/ffmpeg" "$RESOURCES/ffmpeg/bin/"
[ -f "$VENDORED/ffmpeg/bin/ffprobe" ] && cp "$VENDORED/ffmpeg/bin/ffprobe" "$RESOURCES/ffmpeg/bin/"
if [ -d "$VENDORED/ffmpeg/lib" ]; then
    cp -R "$VENDORED/ffmpeg/lib" "$RESOURCES/ffmpeg/"
fi

# Backend
mkdir -p "$RESOURCES/backend"
cp -R "$REPO_ROOT/backend/dist" "$RESOURCES/backend/"
cp -R "$REPO_ROOT/backend/node_modules" "$RESOURCES/backend/"
cp "$REPO_ROOT/backend/package.json" "$RESOURCES/backend/"
[ -d "$REPO_ROOT/backend/public" ] && cp -R "$REPO_ROOT/backend/public" "$RESOURCES/backend/"

# Client
mkdir -p "$RESOURCES/client"
cp -R "$REPO_ROOT/client/dist/client/browser/"* "$RESOURCES/client/"

echo "    [done] Resources copied"

# ── Ad-hoc code sign embedded binaries ──
echo "==> Code signing embedded binaries..."
codesign --force --sign - "$RESOURCES/node/bin/node"
find "$RESOURCES/postgres/bin" -type f -perm +111 -exec codesign --force --sign - {} \;
codesign --force --sign - "$RESOURCES/ffmpeg/bin/ffmpeg"
[ -f "$RESOURCES/ffmpeg/bin/ffprobe" ] && codesign --force --sign - "$RESOURCES/ffmpeg/bin/ffprobe"

# Re-sign the outer app bundle.
codesign --force --sign - "$APP_BUNDLE"

echo ""
echo "==> Build complete!"
echo "    $APP_BUNDLE"
echo ""
echo "    To run: open \"$APP_BUNDLE\""
echo "    To install: cp -R \"$APP_BUNDLE\" /Applications/"
