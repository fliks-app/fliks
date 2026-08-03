#!/usr/bin/env bash
#
# Sign the staged Tizen bundle for TV Seller Office, which rejects any package
# without an author signature.
#
# Run through `dbus-run-session`: the signing engine keeps certificate
# passwords in a Freedesktop keyring, and `security-profiles add` and
# `tizen package` only round-trip them within one session bus. Split across
# two sessions, the second command finds no password and blocks on a prompt.
set -euo pipefail

: "${TIZEN_AUTHOR_P12:?base64 of the author certificate}"
: "${TIZEN_AUTHOR_PASSWORD:?password of the author certificate}"

echo "" | gnome-keyring-daemon --unlock --components=secrets > /dev/null 2>&1 || true

client=$(cd "$(dirname "$0")/.." && pwd)
certs=$(mktemp -d)
trap 'rm -rf "$certs"' EXIT
echo "$TIZEN_AUTHOR_P12" | base64 -d > "$certs/author.p12"

# Samsung replaces the distributor signature when the app is published, so the
# certificate bundled with the SDK is enough and holds no secret.
distributor="$HOME/tizen-studio/tools/certificate-generator/certificates/distributor/sdk-public/tizen-distributor-signer.p12"

tizen cli-config "profiles.path=$HOME/tizen-studio-data/profile/profiles.xml"
tizen security-profiles add -n store \
  -a "$certs/author.p12" -p "$TIZEN_AUTHOR_PASSWORD" \
  -d "$distributor" -dp tizenpkcs12passfordsigner

# Both paths must be absolute: the CLI resolves relative ones against its own
# bin directory.
out="$client/dist/store"
mkdir -p "$out"
tizen package -t wgt -s store -o "$out" -- "$client/dist/tizen-stage"

version=$(node -p "require('$client/package.json').version")
signed="$client/dist/Fliks-$version-store.wgt"
mv "$out/Fliks.wgt" "$signed"
unzip -l "$signed" | grep -q author-signature.xml
echo "signed $(basename "$signed")"
