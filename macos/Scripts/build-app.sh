#!/usr/bin/env bash
#
# Build a self-contained Fliks.app bundle with all dependencies.
#
# Prerequisites:
#   1. brew install xcodegen postgresql@18 ffmpeg
#   2. ./Scripts/fetch-vendored.sh  (for Node.js 24 arm64)
#   3. Xcode 16+ with command line tools
#
# Usage: ./build-app.sh [--skip-web] [--skip-xcode]
#
# --skip-web    Skip rebuilding client + backend
# --skip-xcode  Skip xcodebuild (reuse existing .app, just re-bundle resources)

set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT="$(cd .. && pwd)"
MACOS_DIR="$(pwd)"
VENDORED="$MACOS_DIR/Vendored"
BUILD_DIR="$MACOS_DIR/build"
SCRIPTS_DIR="$MACOS_DIR/Scripts"
SKIP_WEB=false
SKIP_XCODE=false

for arg in "$@"; do
    case $arg in
        --skip-web) SKIP_WEB=true ;;
        --skip-xcode) SKIP_XCODE=true ;;
    esac
done

# ── Verify prerequisites ──
if [ ! -x "$VENDORED/node/bin/node" ]; then
    echo "Error: Vendored Node.js not found. Run ./Scripts/fetch-vendored.sh first."
    exit 1
fi

for tool in ffmpeg psql; do
    if ! command -v $tool &>/dev/null; then
        echo "Error: $tool not found. Run: brew install postgresql@18 ffmpeg"
        exit 1
    fi
done

PG_PREFIX="$(brew --prefix postgresql@18)"
FF_PREFIX="$(brew --prefix ffmpeg)"

echo "==> Build configuration"
echo "    Node.js:    $VENDORED/node/bin/node ($($VENDORED/node/bin/node --version))"
echo "    PostgreSQL: $PG_PREFIX ($($PG_PREFIX/bin/postgres --version | awk '{print $NF}'))"
echo "    FFmpeg:     $FF_PREFIX ($(ffmpeg -version 2>&1 | head -1 | awk '{print $3}'))"
echo ""

# ── Build web apps ──
if [ "$SKIP_WEB" = false ]; then
    echo "==> Building Angular client..."
    cd "$REPO_ROOT/client"
    npm ci --silent
    npx ng build --configuration=production
    echo "    [done]"

    echo "==> Building NestJS backend..."
    cd "$REPO_ROOT/backend"
    npm ci --silent
    npm run build
    npm ci --omit=dev --silent
    echo "    [done]"
fi

# ── Build Swift app ──
if [ "$SKIP_XCODE" = false ]; then
    echo "==> Building Fliks.app (Release)..."
    cd "$MACOS_DIR"
    xcodebuild \
        -project Fliks.xcodeproj \
        -scheme Fliks \
        -configuration Release \
        -derivedDataPath "$BUILD_DIR" \
        ONLY_ACTIVE_ARCH=YES \
        build 2>&1 | tail -3
fi

APP_BUNDLE="$(find "$BUILD_DIR" -name "Fliks.app" -type d | head -1)"
if [ -z "$APP_BUNDLE" ]; then
    echo "Error: Fliks.app not found in build output"
    exit 1
fi

RESOURCES="$APP_BUNDLE/Contents/Resources"
echo "==> Populating $APP_BUNDLE"

# ── Node.js (statically linked, no dylib fixup needed) ──
echo "    [node] Copying Node.js 24..."
mkdir -p "$RESOURCES/node/bin"
cp "$VENDORED/node/bin/node" "$RESOURCES/node/bin/"

# ── PostgreSQL (from Homebrew installed, needs dylib bundling) ──
echo "    [postgres] Copying PostgreSQL..."
mkdir -p "$RESOURCES/postgres/bin" "$RESOURCES/postgres/lib" "$RESOURCES/postgres/share"

# Only copy the binaries we actually use.
for pgbin in initdb pg_ctl postgres pg_isready createdb psql; do
    cp "$PG_PREFIX/bin/$pgbin" "$RESOURCES/postgres/bin/"
done

# Copy the PostgreSQL internal shared library.
cp "$PG_PREFIX/lib/postgresql/libpq.5.dylib" "$RESOURCES/postgres/lib/"
install_name_tool -id "@loader_path/../lib/libpq.5.dylib" "$RESOURCES/postgres/lib/libpq.5.dylib"

# Rewrite CELLAR references in pg binaries to bundled libpq.
for pgbin in "$RESOURCES/postgres/bin/"*; do
    cellar_ref="$(otool -L "$pgbin" 2>/dev/null | awk '/libpq\.5\.dylib/ {print $1}' | grep -v '@' || true)"
    if [ -n "$cellar_ref" ]; then
        install_name_tool -change "$cellar_ref" "@executable_path/../lib/libpq.5.dylib" "$pgbin"
    fi
done

# Copy share directory (timezone data, SQL scripts needed by initdb).
cp -R "$PG_PREFIX/share/postgresql@18/"* "$RESOURCES/postgres/share/" 2>/dev/null || \
    cp -R "$PG_PREFIX/share/"* "$RESOURCES/postgres/share/" 2>/dev/null || true

# Bundle Homebrew dylib dependencies for postgres binaries.
bash "$SCRIPTS_DIR/bundle-dylibs.sh" "$RESOURCES/postgres/bin" "$RESOURCES/postgres/lib"

# Also fix libpq's own Homebrew dependencies.
bash "$SCRIPTS_DIR/bundle-dylibs.sh" "$RESOURCES/postgres/lib/libpq.5.dylib" "$RESOURCES/postgres/lib"

# ── FFmpeg (from Homebrew installed, needs dylib bundling) ──
echo "    [ffmpeg] Copying FFmpeg..."
mkdir -p "$RESOURCES/ffmpeg/bin" "$RESOURCES/ffmpeg/lib"
cp "$FF_PREFIX/bin/ffmpeg" "$RESOURCES/ffmpeg/bin/"
[ -f "$FF_PREFIX/bin/ffprobe" ] && cp "$FF_PREFIX/bin/ffprobe" "$RESOURCES/ffmpeg/bin/"

# Bundle Homebrew dylib dependencies for ffmpeg.
bash "$SCRIPTS_DIR/bundle-dylibs.sh" "$RESOURCES/ffmpeg/bin" "$RESOURCES/ffmpeg/lib"

# ── Backend ──
echo "    [backend] Copying NestJS backend..."
mkdir -p "$RESOURCES/backend"
cp -R "$REPO_ROOT/backend/dist" "$RESOURCES/backend/"
cp -R "$REPO_ROOT/backend/node_modules" "$RESOURCES/backend/"
cp "$REPO_ROOT/backend/package.json" "$RESOURCES/backend/"
[ -d "$REPO_ROOT/backend/public" ] && cp -R "$REPO_ROOT/backend/public" "$RESOURCES/backend/"

# ── Client ──
echo "    [client] Copying Angular client..."
mkdir -p "$RESOURCES/client"
cp -R "$REPO_ROOT/client/dist/client/browser/"* "$RESOURCES/client/"

echo "    [done] All resources copied"

# ── Code sign everything ──
echo "==> Code signing..."
# Sign all dylibs first.
find "$RESOURCES" -name "*.dylib" -exec codesign --force --sign - {} \; 2>/dev/null
# Sign binaries.
codesign --force --sign - "$RESOURCES/node/bin/node"
find "$RESOURCES/postgres/bin" -type f -perm +111 -exec codesign --force --sign - {} \;
codesign --force --sign - "$RESOURCES/ffmpeg/bin/ffmpeg"
[ -f "$RESOURCES/ffmpeg/bin/ffprobe" ] && codesign --force --sign - "$RESOURCES/ffmpeg/bin/ffprobe"
# Re-sign the outer app bundle.
codesign --force --sign - "$APP_BUNDLE"
echo "    [done]"

echo ""
echo "==> Build complete: $APP_BUNDLE"
echo "    To run:    open \"$APP_BUNDLE\""
echo "    To DMG:    ./Scripts/make-dmg.sh"
