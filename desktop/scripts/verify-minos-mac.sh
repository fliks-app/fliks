#!/usr/bin/env bash
# Fails when a bundled Mach-O needs a newer macOS than the app declares: dyld
# refuses such a dylib at load, so playback breaks on the older systems.
# Usage: verify-minos-mac.sh <dir>...   (default: the vendored libs + the addon)
set -euo pipefail
cd "$(dirname "$0")/../.."
floor=$(sed -n 's/^ *minimumSystemVersion: *"\{0,1\}\([0-9.]*\)"\{0,1\}.*/\1/p' desktop/electron-builder.yml | head -1)
test -n "$floor" || { echo "::error::mac.minimumSystemVersion missing in electron-builder.yml"; exit 1; }
dirs=("$@")
[ ${#dirs[@]} -gt 0 ] || dirs=(desktop/native/vendor desktop/native/build/Release)

bad=0 n=0
while IFS= read -r f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  n=$((n + 1))
  max=$(otool -l "$f" | awk '
    $1 == "cmd" { cmd = $2 }
    cmd == "LC_BUILD_VERSION" && $1 == "minos" { print $2 }
    cmd == "LC_VERSION_MIN_MACOSX" && $1 == "version" { print $2 }' | sort -V | tail -1)
  [ -n "$max" ] || continue
  if [ "$(printf '%s\n%s\n' "$max" "$floor" | sort -V | tail -1)" != "$floor" ]; then
    echo "::error file=$f::minos $max > $floor (LSMinimumSystemVersion)"
    bad=1
  fi
done < <(find "${dirs[@]}" -type f \( -name '*.dylib' -o -name '*.node' -o -name '*.so' \) 2>/dev/null)
[ "$n" -gt 0 ] || { echo "::error::no Mach-O found under ${dirs[*]}"; exit 1; }
[ "$bad" = 0 ] || exit 1
echo "minos OK: $n Mach-O <= $floor"
