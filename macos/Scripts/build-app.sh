#!/usr/bin/env bash
#
# Build a self-contained Fliks Server.app bundle with all dependencies.
#
# Prerequisites:
#   1. brew install xcodegen postgresql@18
#   2. ./Scripts/fetch-vendored.sh  (Node.js 24 + jellyfin-ffmpeg, arm64)
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

if ! command -v psql &>/dev/null; then
    echo "Error: psql not found. Run: brew install postgresql@18"
    exit 1
fi
if [ ! -x "$VENDORED/ffmpeg/bin/ffmpeg" ]; then
    echo "Error: Vendored ffmpeg not found. Run ./Scripts/fetch-vendored.sh first."
    exit 1
fi

PG_PREFIX="$(brew --prefix postgresql@18)"

echo "==> Build configuration"
echo "    Node.js:    $VENDORED/node/bin/node ($($VENDORED/node/bin/node --version))"
echo "    PostgreSQL: $PG_PREFIX ($($PG_PREFIX/bin/postgres --version | awk '{print $NF}'))"
echo "    FFmpeg:     $VENDORED/ffmpeg/bin/ffmpeg ($("$VENDORED/ffmpeg/bin/ffmpeg" -version 2>&1 | head -1 | awk '{print $3}'))"
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
    echo "==> Building Fliks Server.app (Release)..."
    cd "$MACOS_DIR"
    xcodebuild \
        -project Fliks.xcodeproj \
        -scheme Fliks \
        -configuration Release \
        -derivedDataPath "$BUILD_DIR" \
        ONLY_ACTIVE_ARCH=YES \
        TMDB_API_KEY="${TMDB_API_KEY:-}" \
        TVDB_API_KEY="${TVDB_API_KEY:-}" \
        build 2>&1 | tail -3
fi

APP_BUNDLE="$(find "$BUILD_DIR" -name "Fliks Server.app" -type d | head -1)"
if [ -z "$APP_BUNDLE" ]; then
    echo "Error: Fliks Server.app not found in build output"
    exit 1
fi

RESOURCES="$APP_BUNDLE/Contents/Resources"
echo "==> Populating $APP_BUNDLE"

# Wipe previously-populated trees before re-copying. macOS `cp` refuses
# to overwrite codesigned binaries from a prior build with "Permission
# denied" even when the user owns the file — the signature triggers a
# protected-write check. Without this, an incremental xcodebuild leaves
# the old Resources in place and the script aborts on the first cp,
# silently shipping a DMG with a stale backend / Postgres / FFmpeg.
rm -rf "$RESOURCES/node" "$RESOURCES/postgres" "$RESOURCES/ffmpeg" "$RESOURCES/backend" "$RESOURCES/client"

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
# Preserve the postgresql/ subdirectory so initdb -L finds it.
mkdir -p "$RESOURCES/postgres/share/postgresql"
cp -R "$PG_PREFIX/share/postgresql@18/"* "$RESOURCES/postgres/share/postgresql/" 2>/dev/null || \
    cp -R "$PG_PREFIX/share/postgresql/"* "$RESOURCES/postgres/share/postgresql/" 2>/dev/null || true

# Copy extension libraries (pg_trgm, plpgsql, etc.) so $libdir resolves
# to our bundled versions — not the host's Homebrew (which may be a
# different PG minor version with ABI-incompatible symbols).
PG_EXTLIB="$PG_PREFIX/lib/postgresql"
if [ -d "$PG_EXTLIB" ]; then
    mkdir -p "$RESOURCES/postgres/lib/postgresql"
    cp "$PG_EXTLIB"/*.dylib "$RESOURCES/postgres/lib/postgresql/" 2>/dev/null || true
    echo "    [copy] $(ls "$RESOURCES/postgres/lib/postgresql/"*.dylib 2>/dev/null | wc -l | tr -d ' ') extension libraries"
fi

# Bundle Homebrew dylib dependencies for postgres binaries.
bash "$SCRIPTS_DIR/bundle-dylibs.sh" "$RESOURCES/postgres/bin" "$RESOURCES/postgres/lib"

# Also fix libpq's own Homebrew dependencies.
bash "$SCRIPTS_DIR/bundle-dylibs.sh" "$RESOURCES/postgres/lib/libpq.5.dylib" "$RESOURCES/postgres/lib"

# And the extension libs. These are dlopen'd by the postgres server at runtime
# (plpgsql, pg_trgm, uuid-ossp, …) and pull the same Homebrew deps as the
# binaries — chiefly gettext's libintl. The bin/ and libpq passes above don't
# cover lib/postgresql/, so relocate their deps into the shared bundled lib/ too.
if [ -d "$RESOURCES/postgres/lib/postgresql" ]; then
    bash "$SCRIPTS_DIR/bundle-dylibs.sh" "$RESOURCES/postgres/lib/postgresql" "$RESOURCES/postgres/lib"
fi

# ── FFmpeg (vendored jellyfin-ffmpeg, statically linked — no dylib fixup) ──
echo "    [ffmpeg] Copying jellyfin-ffmpeg..."
mkdir -p "$RESOURCES/ffmpeg/bin"
cp -R "$VENDORED/ffmpeg/bin/"* "$RESOURCES/ffmpeg/bin/"

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
# Local dev signs ad-hoc ("-"). CI passes a Developer ID identity via
# MAC_SIGN_IDENTITY for a NOTARIZABLE build: hardened runtime + secure timestamp
# + entitlements. Sign inside-out — every nested Mach-O first, the .app last.
SIGN_ID="${MAC_SIGN_IDENTITY:--}"
ENTITLEMENTS="$MACOS_DIR/Fliks/Fliks.entitlements"
echo "==> Code signing (identity: $SIGN_ID)..."
sign() {
    if [ "$SIGN_ID" = "-" ]; then
        codesign --force --sign - "$1" 2>/dev/null || true
    else
        codesign --force --options runtime --timestamp \
            --entitlements "$ENTITLEMENTS" --sign "$SIGN_ID" "$1"
    fi
}

# Every Mach-O inside the bundle: dylibs, the node/postgres/ffmpeg helpers, AND
# native .node addons under backend/node_modules — notarization rejects any
# unsigned executable. `file` filters out the (many) non-binary files.
while IFS= read -r -d '' f; do
    if file "$f" 2>/dev/null | grep -q 'Mach-O'; then sign "$f"; fi
done < <(find "$RESOURCES" -type f -print0)

# Outer app bundle last (seals the signed contents).
sign "$APP_BUNDLE"
echo "    [done]"

# ── Verify the signed bundle ──
# Assert the actual on-disk result rather than trusting the steps above.
echo "==> Verifying bundle..."

# 1. Node must carry the JIT entitlement: under the hardened runtime V8 needs
#    com.apple.security.cs.allow-jit to allocate the executable memory for its
#    code range. Only meaningful for a Developer ID (hardened) build; ad-hoc
#    local builds run without the runtime.
if [ "$SIGN_ID" != "-" ]; then
    if ! codesign -d --entitlements :- "$RESOURCES/node/bin/node" 2>/dev/null \
        | grep -q 'com.apple.security.cs.allow-jit'; then
        echo "Error: bundled node is missing com.apple.security.cs.allow-jit (required under the hardened runtime)."
        exit 1
    fi
    echo "    [verify] node carries allow-jit"
fi

# 2. No vendored Mach-O may reference /opt/homebrew — those paths exist only on
#    the build host, so every dependency must be relocated into the bundle.
#    Scoped to the dirs this script relocates (node/postgres/ffmpeg);
#    backend/node_modules ships its own prebuilt addons and is out of scope here.
stray="$(find "$RESOURCES/node" "$RESOURCES/postgres" "$RESOURCES/ffmpeg" \
    -type f \( -perm +111 -o -name '*.dylib' \) -print0 2>/dev/null \
    | xargs -0 -I{} sh -c 'otool -L "$1" 2>/dev/null | grep -q "/opt/homebrew" && echo "$1"' _ {} \
    || true)"
if [ -n "$stray" ]; then
    echo "Error: these bundled binaries still link Homebrew paths (won't load on a clean machine):"
    echo "$stray"
    exit 1
fi
echo "    [verify] no bundled binary references /opt/homebrew"

# 3. ffmpeg must have zscale (libzimg) + the VideoToolbox tone-map — the HDR
#    paths (crop / burn-in / DV) depend on them.
for filt in zscale tonemap_videotoolbox; do
    if ! "$RESOURCES/ffmpeg/bin/ffmpeg" -hide_banner -filters 2>/dev/null | grep -qw "$filt"; then
        echo "Error: bundled ffmpeg is missing the '$filt' filter (expected jellyfin-ffmpeg)."
        exit 1
    fi
done
echo "    [verify] ffmpeg has zscale + tonemap_videotoolbox"

echo ""
echo "==> Build complete: $APP_BUNDLE"
echo "    To run:    open \"$APP_BUNDLE\""
echo "    To DMG:    ./Scripts/make-dmg.sh"
