#!/usr/bin/env bash
# Runs ON THE MAC (invoked over SSH by the ./appletv wrapper).
# cwd is set to the synced project root ($HOME/fliks-appletv-build).
set -euo pipefail

# Non-login SSH shells miss Homebrew's path; xcodegen lives there on Apple Silicon.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

PROJECT="FliksTV.xcodeproj"
SCHEME="FliksTV"
BUNDLE_ID="${BUNDLE_ID:-media.fliks.tv}"
APP_NAME="${APP_NAME:-Fliks}"
DERIVED=".build"
SIM_NAME="${SIM_NAME:-Apple TV 4K (3rd generation)}"

find_xcodegen() {
  if command -v xcodegen >/dev/null 2>&1; then command -v xcodegen
  elif [ -x "$HOME/tools/XcodeGen/.build/release/xcodegen" ]; then echo "$HOME/tools/XcodeGen/.build/release/xcodegen"
  else echo ""; fi
}

generate() {
  local xg; xg="$(find_xcodegen)"
  [ -z "$xg" ] && { echo "XcodeGen not found — run: brew install xcodegen (or ./appletv install-xcodegen)" >&2; exit 3; }
  "$xg" generate --spec project.yml
}

app_path() {
  find "$DERIVED/Build/Products" -maxdepth 3 -name '*.app' 2>/dev/null | head -1
}

build_sim() {
  generate
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Debug \
    -destination "platform=tvOS Simulator,name=$SIM_NAME" \
    -derivedDataPath "$DERIVED" \
    PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" INFOPLIST_KEY_CFBundleDisplayName="$APP_NAME" \
    CODE_SIGNING_ALLOWED=NO \
    build
}

run_sim() {
  build_sim
  local app; app="$(app_path)"
  echo "app: $app"
  xcrun simctl boot "$SIM_NAME" 2>/dev/null || true
  xcrun simctl bootstatus "$SIM_NAME" || true
  xcrun simctl install "$SIM_NAME" "$app"
  xcrun simctl terminate "$SIM_NAME" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl launch "$SIM_NAME" "$BUNDLE_ID" || true
  sleep 6
  xcrun simctl io "$SIM_NAME" screenshot "$HERE/last-shot.png" && echo "screenshot: last-shot.png" || echo "screenshot failed"
}

detect_team() {
  if [ -n "${DEVELOPMENT_TEAM:-}" ]; then echo "$DEVELOPMENT_TEAM"; return; fi
  if [ -f "$HOME/.config/appletv/team" ]; then tr -d '[:space:]' < "$HOME/.config/appletv/team"; return; fi
  local prof
  prof="$(ls -t "$HOME/Library/MobileDevice/Provisioning Profiles/"*.mobileprovision 2>/dev/null | head -1)"
  if [ -n "$prof" ]; then
    security cms -D -i "$prof" 2>/dev/null | plutil -extract TeamIdentifier.0 raw -o - - 2>/dev/null
  fi
}

build_device() {
  generate
  local team; team="$(detect_team)"
  if [ -z "$team" ]; then
    echo "No signing team detected. In Xcode: Settings > Accounts (add an Apple ID)," >&2
    echo "then ./appletv open, target FliksTV > Signing & Capabilities > check" >&2
    echo "'Automatically manage signing' and pick your team." >&2
    exit 4
  fi
  echo "DEVELOPMENT_TEAM=$team"
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Debug \
    -destination "generic/platform=tvOS" \
    -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
    DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic \
    PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" INFOPLIST_KEY_CFBundleDisplayName="$APP_NAME" \
    build
}

run_device() {
  build_device
  local app; app="$(app_path)"
  echo "app: $app"
  : "${TV_UDID:?set TV_UDID to the paired Apple TV device UDID}"
  xcrun devicectl device install app --device "$TV_UDID" "$app"
  xcrun devicectl device process launch --device "$TV_UDID" "$BUNDLE_ID"
}

logs() {
  xcrun simctl spawn "$SIM_NAME" log stream --level debug \
    --predicate 'senderImagePath CONTAINS "FliksTV"'
}

install_xcodegen() {
  mkdir -p "$HOME/tools"
  [ -d "$HOME/tools/XcodeGen/.git" ] || git clone --depth 1 https://github.com/yonaskolb/XcodeGen "$HOME/tools/XcodeGen"
  ( cd "$HOME/tools/XcodeGen" && swift build -c release )
  echo "xcodegen: $HOME/tools/XcodeGen/.build/release/xcodegen"
}

open_xcode() { generate; open "$PROJECT"; }

case "${1:-}" in
  generate)         generate ;;
  build-sim)        build_sim ;;
  run-sim)          run_sim ;;
  build-device)     build_device ;;
  run-device)       run_device ;;
  logs)             logs ;;
  install-xcodegen) install_xcodegen ;;
  detect-team)      detect_team ;;
  open)             open_xcode ;;
  *) echo "remote-build.sh: unknown command '${1:-}'" >&2; exit 1 ;;
esac
