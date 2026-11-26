#!/usr/bin/env bash
# Self-test of nextest-archives.sh with a stub cargo-nextest that exits with the code its archive holds.
cd "$(dirname "$0")" || exit 1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
printf '#!/bin/sh\nexit "$(cat "$4")"\n' > "$tmp/bin/cargo-nextest"
chmod +x "$tmp/bin/cargo-nextest"
run() {
  rm -f "$tmp"/*.tar.zst
  echo "$1" > "$tmp/it.tar.zst"
  echo "$2" > "$tmp/lib.tar.zst"
  PATH="$tmp/bin:$PATH" ARCHIVE_DIR=$tmp GITHUB_WORKSPACE=$tmp ./nextest-archives.sh
}
n=0
run 0 0 || { echo "FAIL: two green archives must pass"; n=1; }
run 0 4 || { echo "FAIL: a filter matching one archive only must pass"; n=1; }
run 4 4 && { echo "FAIL: a filter matching nothing must fail"; n=1; }
run 100 0 && { echo "FAIL: a red first archive must fail"; n=1; }
run 4 100 && { echo "FAIL: a red second archive must fail"; n=1; }
exit $n
