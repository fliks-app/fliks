#!/usr/bin/env bash
#
# Recursively bundle non-system dylibs into a target lib/ directory
# and rewrite all LC_LOAD_DYLIB paths to @loader_path-relative.
#
# Usage: ./bundle-dylibs.sh <binary_or_dir> <lib_dest_dir>
#
# Compatible with macOS system bash 3.2 (no associative arrays).

set -euo pipefail

TARGET="$1"    # binary file or directory of binaries
LIB_DIR="$2"   # destination lib/ directory

mkdir -p "$LIB_DIR"

# Track already-processed dylibs (one name per line in a temp file).
PROCESSED_FILE="$(mktemp)"
trap "rm -f $PROCESSED_FILE" EXIT

is_processed() {
    grep -qx "$1" "$PROCESSED_FILE" 2>/dev/null
}

mark_processed() {
    echo "$1" >> "$PROCESSED_FILE"
}

# Returns non-system dylib dependencies of a binary.
# Handles both absolute Homebrew paths and @loader_path/@rpath references.
get_brew_deps() {
    otool -L "$1" 2>/dev/null \
        | awk '/\/opt\/homebrew\// { print $1 }' \
        | sort -u
}

# Returns @loader_path dependency references (unresolved — caller resolves).
get_loader_path_deps() {
    otool -L "$1" 2>/dev/null \
        | awk '/@loader_path\// { print $1 }' \
        | sort -u
}

# Recursively copy a dylib and its dependencies into LIB_DIR,
# rewriting load paths to @loader_path.
bundle_one() {
    local dylib_path="$1"
    local dylib_name
    dylib_name="$(basename "$dylib_path")"

    # Skip if already processed.
    if is_processed "$dylib_name"; then return; fi
    mark_processed "$dylib_name"

    # Resolve symlinks to get the actual file.
    local real_path
    real_path="$(perl -MCwd -e 'print Cwd::realpath($ARGV[0])' "$dylib_path" 2>/dev/null || echo "$dylib_path")"

    if [ ! -f "$real_path" ]; then
        echo "    [warn] dylib not found: $dylib_path"
        return
    fi

    # Copy into lib dir if not already there.
    if [ ! -f "$LIB_DIR/$dylib_name" ]; then
        cp "$real_path" "$LIB_DIR/$dylib_name"
        chmod 644 "$LIB_DIR/$dylib_name"
        echo "    [copy] $dylib_name"
    fi

    # Change the dylib's own install name.
    install_name_tool -id "@loader_path/$dylib_name" "$LIB_DIR/$dylib_name" 2>/dev/null || true

    # Recurse into this dylib's own Homebrew dependencies.
    local dep dep_name
    for dep in $(get_brew_deps "$LIB_DIR/$dylib_name"); do
        dep_name="$(basename "$dep")"
        install_name_tool -change "$dep" "@loader_path/$dep_name" "$LIB_DIR/$dylib_name" 2>/dev/null || true
        bundle_one "$dep"
    done

    # Also handle @loader_path references — these point to sibling dylibs
    # at the original Homebrew location. We need to resolve them, copy the
    # target, and the reference is already correct (@loader_path/name).
    local orig_dir
    orig_dir="$(dirname "$dylib_path")"
    for ref in $(get_loader_path_deps "$LIB_DIR/$dylib_name"); do
        dep_name="$(basename "$ref")"
        # The actual file is relative to the ORIGINAL location, not LIB_DIR.
        local resolved="${ref/@loader_path/$orig_dir}"
        if [ -f "$resolved" ] && [ ! -f "$LIB_DIR/$dep_name" ]; then
            bundle_one "$resolved"
        fi
    done
}

# Collect all binaries to process. Match executables (-perm +111) AND *.dylib
# by name: the PostgreSQL extension libs (plpgsql, pg_trgm, …) ship as 0444
# (no exec bit), so a -perm-only scan silently skips them and leaves their
# Homebrew deps (gettext/libintl, …) unrelocated.
if [ -d "$TARGET" ]; then
    BINARIES="$(find "$TARGET" -type f \( -perm +111 -o -name '*.dylib' \) 2>/dev/null)"
else
    BINARIES="$TARGET"
fi

echo "==> Bundling dylibs into $LIB_DIR"

# Phase 1: Process each input binary — copy its Homebrew deps and rewrite paths.
echo "$BINARIES" | while IFS= read -r bin; do
    [ -z "$bin" ] && continue
    echo "    Processing $(basename "$bin")..."
    # A dylib carries its own install id (otool -D). For Homebrew's postgres
    # client libs (libpq, libecpg, libpgtypes) that id is an absolute
    # /opt/homebrew path, and -change below only touches DEPENDENCIES, not the
    # id — so the id would still resolve back to the build host. Rewrite it to
    # @loader_path, but only when it is actually a Homebrew path so we don't
    # clobber an id an earlier step deliberately set (e.g. libpq.5.dylib).
    cur_id="$(otool -D "$bin" 2>/dev/null | tail -1)"
    case "$cur_id" in
        /opt/homebrew/*)
            install_name_tool -id "@loader_path/$(basename "$bin")" "$bin" 2>/dev/null || true
            ;;
    esac
    for dep in $(get_brew_deps "$bin"); do
        dep_name="$(basename "$dep")"
        install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$bin" 2>/dev/null || true
        bundle_one "$dep"
    done
done

# Phase 2: Verify no remaining Homebrew references.
REMAINING=0
echo "$BINARIES" | while IFS= read -r bin; do
    [ -z "$bin" ] && continue
    bad="$(otool -L "$bin" 2>/dev/null | grep '/opt/homebrew' || true)"
    if [ -n "$bad" ]; then
        echo "    [warn] $(basename "$bin") still references Homebrew:"
        echo "$bad"
    fi
done

for lib in "$LIB_DIR"/*.dylib; do
    [ -f "$lib" ] || continue
    bad="$(otool -L "$lib" 2>/dev/null | grep '/opt/homebrew' || true)"
    if [ -n "$bad" ]; then
        echo "    [warn] $(basename "$lib") still references Homebrew:"
        echo "$bad"
    fi
done

COUNT="$(ls "$LIB_DIR"/*.dylib 2>/dev/null | wc -l | tr -d ' ')"
echo "==> Bundled $COUNT dylibs"
