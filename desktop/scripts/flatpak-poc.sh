#!/usr/bin/env bash
# Build the PoC flatpak from a released .deb and install it for the current
# user. With a second argument the build is also exported into an ostree repo,
# which is what a static host (GitHub Pages, any bucket) would serve as a
# flatpak remote.
#
# Requires: flatpak, flatpak-builder, and the flathub remote for the runtime,
# SDK and org.electronjs.Electron2.BaseApp.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
deb="${1:?usage: flatpak-poc.sh <path-to .deb> [repo-dir]}"
repo="${2:-}"

test -f "$deb" || { echo "no such .deb: $deb" >&2; exit 1; }
cp -f "$deb" "$here/flatpak/fliks.deb"

# rofiles-fuse needs /dev/fuse, which containers and restricted shells rarely have.
args=(--user --force-clean --disable-rofiles-fuse --install-deps-from=flathub --install)
[ -n "$repo" ] && args+=(--repo="$repo")

cd "$here/flatpak"
flatpak-builder "${args[@]}" build media.fliks.desktop.yml

echo
echo "installed: flatpak run media.fliks.desktop"
[ -n "$repo" ] && echo "exported to $repo (serve it over HTTP to use as a remote)"
