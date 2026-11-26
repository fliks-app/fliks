#!/usr/bin/env bash
# Runs nextest on every archive of $ARCHIVE_DIR with the given arguments. A filter may match tests in
# one archive only; matching none at all fails like a single run would (exit 4).
rc=0 ran=0
for archive in "$ARCHIVE_DIR"/*.tar.zst; do
  cargo-nextest nextest run --archive-file "$archive" --workspace-remap "$GITHUB_WORKSPACE/server" \
    --no-fail-fast --no-tests=fail "$@"
  case $? in
    0) ran=1 ;;
    4) ;;
    *) rc=1 ;;
  esac
done
[ "$rc" = 0 ] && [ "$ran" = 1 ]
