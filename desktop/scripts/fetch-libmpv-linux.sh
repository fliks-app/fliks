#!/usr/bin/env bash
# Downloads the Fliks-vendored Linux libmpv and checks it against LIBMPV_LINUX_SHA256 (env from the workflow).
set -euo pipefail
cd "$(dirname "$0")/../.."
dest=desktop/native/vendor
mkdir -p "$dest"
url="https://github.com/${GITHUB_REPOSITORY:-fliks-app/fliks}/releases/download/${LIBMPV_LINUX_TAG}/${LIBMPV_LINUX_ASSET}"
echo "Downloading libmpv (Fliks-vendored): $url"
curl -fsSL -o "$dest/libmpv.so.2" "$url"
echo "${LIBMPV_LINUX_SHA256}  $dest/libmpv.so.2" | sha256sum -c -
chmod 755 "$dest/libmpv.so.2"
