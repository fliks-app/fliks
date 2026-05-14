#!/usr/bin/env bash
#
# Create a distributable DMG from the built Fliks.app.
#
# Prerequisites: ./build-app.sh must have been run first.
#
# Usage: ./make-dmg.sh
#
# Output: macos/build/Fliks-<version>-arm64.dmg

set -euo pipefail
cd "$(dirname "$0")/.."

BUILD_DIR="$(pwd)/build"
APP_BUNDLE="$(find "$BUILD_DIR" -name "Fliks.app" -type d 2>/dev/null | head -1)"

if [ -z "$APP_BUNDLE" ] || [ ! -d "$APP_BUNDLE" ]; then
    echo "Error: Fliks.app not found. Run ./Scripts/build-app.sh first."
    exit 1
fi

# Extract version from Info.plist.
VERSION="$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || echo "1.0.0")"
DMG_NAME="Fliks-${VERSION}-arm64"
DMG_PATH="$BUILD_DIR/$DMG_NAME.dmg"

# Remove previous DMG if it exists.
rm -f "$DMG_PATH"

echo "==> Creating DMG: $DMG_NAME.dmg"

make_dmg_hdiutil() {
    local staging="$BUILD_DIR/dmg-staging"
    rm -rf "$staging"
    mkdir -p "$staging"
    cp -R "$APP_BUNDLE" "$staging/"
    ln -s /Applications "$staging/Applications"
    hdiutil create \
        -volname "Fliks" \
        -srcfolder "$staging" \
        -ov -format UDZO \
        "$DMG_PATH"
    rm -rf "$staging"
}

if command -v create-dmg &>/dev/null; then
    # create-dmg produces a nice DMG with icon layout and
    # a symlink to /Applications for drag-and-drop install.
    create-dmg \
        --volname "Fliks" \
        --window-pos 200 120 \
        --window-size 600 400 \
        --icon-size 100 \
        --icon "Fliks.app" 150 190 \
        --app-drop-link 450 190 \
        --no-internet-enable \
        "$DMG_PATH" \
        "$APP_BUNDLE" \
        2>&1 || {
            # create-dmg exits non-zero when it can't set icons.
            # If the DMG wasn't actually created, fallback.
            if [ ! -f "$DMG_PATH" ]; then
                echo "    create-dmg failed, falling back to hdiutil..."
                make_dmg_hdiutil
            fi
        }
else
    echo "    create-dmg not found, using hdiutil..."
    make_dmg_hdiutil
fi

if [ -f "$DMG_PATH" ]; then
    SIZE="$(du -h "$DMG_PATH" | awk '{print $1}')"
    echo ""
    echo "==> DMG created: $DMG_PATH ($SIZE)"
    echo "    To install: open the DMG and drag Fliks to Applications"
else
    echo "Error: DMG creation failed"
    exit 1
fi
