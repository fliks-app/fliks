#!/usr/bin/env bash
#
# Build a self-contained Fliks Server.app bundle with all dependencies.
#
# Prerequisites:
#   1. brew install xcodegen postgresql@18
#   2. ./Scripts/fetch-vendored.sh  (jellyfin-ffmpeg, arm64)
#   3. Xcode 16+ with command line tools
#   4. Rust toolchain (cargo) for fliks-server, npm for the client
#
# Usage: ./build-app.sh [--skip-web] [--skip-xcode]
#
# --skip-web    Skip rebuilding the client
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
# silently shipping a DMG with a stale server / Postgres / FFmpeg.
rm -rf "$RESOURCES/bin" "$RESOURCES/postgres" "$RESOURCES/ffmpeg" "$RESOURCES/cast" "$RESOURCES/client" \
    "$RESOURCES/node" "$RESOURCES/backend"  # 4.x layout, wiped for one release

mkdir -p "$RESOURCES/bin"

# ── fliks-engine (supervisor, pinned in engine.lock) ──
echo "    [engine] Fetching fliks-engine..."
ENGINE_VERSION="$(sed -n 's/^version=//p' "$REPO_ROOT/engine.lock")"
ENGINE_SHA="$(sed -n 's/^sha256_darwin_arm64=//p' "$REPO_ROOT/engine.lock")"
if [ -z "$ENGINE_SHA" ]; then
    echo "Error: engine.lock has no sha256_darwin_arm64 (run scripts/bump-engine.sh)." >&2
    exit 1
fi
curl -fsSL -o "$RESOURCES/bin/fliks-engine" \
    "https://github.com/fliks-app/engine/releases/download/v$ENGINE_VERSION/fliks-engine-darwin-arm64"
echo "$ENGINE_SHA  $RESOURCES/bin/fliks-engine" | shasum -a 256 -c -
chmod +x "$RESOURCES/bin/fliks-engine"

# ── fliks-server (Rust, built here; runs behind the engine) ──
echo "    [server] Building fliks-server..."
(cd "$REPO_ROOT/server" && cargo build --release --locked -p fliks-server)
cp "$REPO_ROOT/server/target/release/fliks-server" "$RESOURCES/bin/"

# ── PostgreSQL (from Homebrew installed, needs dylib bundling) ──
# The bottle hardcodes /opt/homebrew/share/postgresql@18 and lib/postgresql@18, and only
# resolves them relative to itself when run from <prefix>/Cellar/<formula>/<version>/bin.
# Mirror that layout under postgres/ so a Mac without Homebrew finds share/ and lib/.
echo "    [postgres] Copying PostgreSQL..."
PG_ROOT="$RESOURCES/postgres"
PG_KEG="Cellar/postgresql@18/$(basename "$(cd "$PG_PREFIX" && pwd -P)")"
PG_BIN="$PG_ROOT/$PG_KEG/bin"
mkdir -p "$PG_BIN" "$PG_ROOT/lib/postgresql" "$PG_ROOT/share/postgresql@18"
ln -s "$PG_KEG/bin" "$PG_ROOT/bin"
ln -s ../../../lib "$PG_ROOT/$PG_KEG/lib"
ln -s postgresql "$PG_ROOT/lib/postgresql@18"

# Only copy the binaries we actually use.
for pgbin in initdb pg_ctl postgres pg_isready createdb psql pg_dump; do
    cp "$PG_PREFIX/bin/$pgbin" "$PG_BIN/"
done

# Copy the PostgreSQL internal shared library.
cp "$PG_PREFIX/lib/postgresql/libpq.5.dylib" "$PG_ROOT/lib/"
install_name_tool -id "@loader_path/../lib/libpq.5.dylib" "$PG_ROOT/lib/libpq.5.dylib"

# Rewrite CELLAR references in pg binaries to bundled libpq.
for pgbin in "$PG_BIN/"*; do
    cellar_ref="$(otool -L "$pgbin" 2>/dev/null | awk '/libpq\.5\.dylib/ {print $1}' | grep -v '@' || true)"
    if [ -n "$cellar_ref" ]; then
        install_name_tool -change "$cellar_ref" "@executable_path/../lib/libpq.5.dylib" "$pgbin"
    fi
done

# Share directory: timezones, extension control files, SQL scripts needed by initdb.
cp -R "$PG_PREFIX/share/postgresql/"* "$PG_ROOT/share/postgresql@18/"
if [ ! -f "$PG_ROOT/share/postgresql@18/postgres.bki" ]; then
    echo "Error: postgres.bki not bundled; initdb would fail on first launch" >&2
    exit 1
fi

# Copy extension libraries (pg_trgm, plpgsql, etc.) so $libdir resolves
# to our bundled versions — not the host's Homebrew (which may be a
# different PG minor version with ABI-incompatible symbols).
cp "$PG_PREFIX/lib/postgresql"/*.dylib "$PG_ROOT/lib/postgresql/"
echo "    [copy] $(ls "$PG_ROOT/lib/postgresql/"*.dylib | wc -l | tr -d ' ') extension libraries"

# Bundle Homebrew dylib dependencies for postgres binaries.
bash "$SCRIPTS_DIR/bundle-dylibs.sh" "$PG_BIN" "$PG_ROOT/lib"

# Also fix libpq's own Homebrew dependencies.
bash "$SCRIPTS_DIR/bundle-dylibs.sh" "$PG_ROOT/lib/libpq.5.dylib" "$PG_ROOT/lib"

# And the extension libs. These are dlopen'd by the postgres server at runtime
# (plpgsql, pg_trgm, uuid-ossp, …) and pull the same Homebrew deps as the
# binaries — chiefly gettext's libintl. The bin/ and libpq passes above don't
# cover lib/postgresql/, so relocate their deps into the shared bundled lib/ too.
bash "$SCRIPTS_DIR/bundle-dylibs.sh" "$PG_ROOT/lib/postgresql" "$PG_ROOT/lib"

# ── FFmpeg (vendored jellyfin-ffmpeg, statically linked — no dylib fixup) ──
echo "    [ffmpeg] Copying jellyfin-ffmpeg..."
mkdir -p "$RESOURCES/ffmpeg/bin"
cp -R "$VENDORED/ffmpeg/bin/"* "$RESOURCES/ffmpeg/bin/"

# ── Cast receiver page ──
mkdir -p "$RESOURCES/cast"
cp -R "$REPO_ROOT/server/public/"* "$RESOURCES/cast/"

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
# Only fliks-server runs wasmtime, which maps plugin code writable then executable (no MAP_JIT).
SERVER_ENTITLEMENTS="$SCRIPTS_DIR/fliks-server.entitlements"
echo "==> Code signing (identity: $SIGN_ID)..."
sign() {
    if [ "$SIGN_ID" = "-" ]; then
        codesign --force --sign - "$1" 2>/dev/null || true
    else
        local ent="$ENTITLEMENTS"
        [ "$(basename "$1")" = fliks-server ] && ent="$SERVER_ENTITLEMENTS"
        codesign --force --options runtime --timestamp \
            --entitlements "$ent" --sign "$SIGN_ID" "$1"
    fi
}

# Every Mach-O inside the bundle: dylibs and the engine/server/postgres/ffmpeg
# binaries. `file -b` decides (name/perm would miss a .bundle);
# restricted to executable/shared-library/bundle so .o objects and dSYM
# companions, which codesign refuses, are skipped. Sign in parallel: each
# --timestamp is a network round-trip.
export -f sign
export SIGN_ID ENTITLEMENTS SERVER_ENTITLEMENTS
find "$RESOURCES" -type f -print0 \
    | xargs -0 -n1 -P "$(sysctl -n hw.ncpu)" bash -c \
        'if file -b "$1" 2>/dev/null | grep -qE "Mach-O.*(executable|shared library|bundle)"; then sign "$1"; fi' _

# Sparkle's helpers keep their own entitlements, innermost first.
SPARKLE="$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
for part in Versions/B/XPCServices/Installer.xpc Versions/B/XPCServices/Downloader.xpc \
    Versions/B/Autoupdate Versions/B/Updater.app ""; do
    if [ "$SIGN_ID" = "-" ]; then
        codesign --force --preserve-metadata=entitlements --sign - "$SPARKLE/$part"
    else
        codesign --force --options runtime --timestamp --preserve-metadata=entitlements \
            --sign "$SIGN_ID" "$SPARKLE/$part"
    fi
done

# Outer app bundle last (seals the signed contents).
sign "$APP_BUNDLE"
echo "    [done]"

# ── Verify the signed bundle ──
# Assert the actual on-disk result rather than trusting the steps above.
echo "==> Verifying bundle..."

# 1. Executable memory is granted to fliks-server only.
if [ "$SIGN_ID" != "-" ]; then
    ents() { codesign -d --entitlements :- "$1" 2>/dev/null; }
    if ! ents "$RESOURCES/bin/fliks-server" | grep -q 'allow-unsigned-executable-memory' \
        || ents "$APP_BUNDLE" | grep -q 'allow-unsigned-executable-memory' \
        || ents "$RESOURCES/bin/fliks-engine" | grep -q 'allow-unsigned-executable-memory'; then
        echo "Error: allow-unsigned-executable-memory must be on bin/fliks-server only."
        exit 1
    fi
    echo "    [verify] only fliks-server may map executable memory"
fi

# 2. No vendored Mach-O may reference /opt/homebrew — those paths exist only on
#    the build host, so every dependency must be relocated into the bundle.
#    Scoped to the dirs this script relocates (bin/postgres/ffmpeg).
stray="$(find "$RESOURCES/bin" "$RESOURCES/postgres" "$RESOURCES/ffmpeg" \
    -type f \( -perm +111 -o -name '*.dylib' \) -print0 2>/dev/null \
    | xargs -0 -I{} sh -c 'otool -L "$1" 2>/dev/null | grep -q "/opt/homebrew" && echo "$1"' _ {} \
    || true)"
if [ -n "$stray" ]; then
    echo "Error: these bundled binaries still link Homebrew paths (won't load on a clean machine):"
    echo "$stray"
    exit 1
fi
echo "    [verify] no bundled binary references /opt/homebrew"

pg_share="$("$PG_ROOT/bin/initdb" --show -D "$(mktemp -d)" 2>&1 | sed -n 's/^share_path=//p')"
if [ "$pg_share" != "$(cd "$PG_ROOT" && pwd -P)/share/postgresql@18" ]; then
    echo "Error: bundled initdb resolves its share dir to '$pg_share', not the bundle."
    exit 1
fi
echo "    [verify] postgres resolves share/ inside the bundle"

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
