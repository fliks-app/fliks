#!/usr/bin/env bash
# Usage: scripts/bump-providers.sh [<id>@<version> ...]   rewrite server/providers.lock from the signed catalog
#        scripts/bump-providers.sh --check                 verify the lock against the catalog and the archives (CI)
# The catalog signature is checked with the keys compiled into trust.rs; no hash is computed
# here for the lock, the catalog's sha256 and zipUrl are copied.
set -euo pipefail
cd "$(dirname "$0")/.."
lock=server/providers.lock
catalog_url="${CATALOG_URL:-https://fliks-app.github.io/fliks-plugin-catalog}"
providers=(fliks.tmdb fliks.tvdb fliks.openlibrary fliks.bnf fliks.googlebooks fliks.audible fliks.audnexus)
api="$(sed -n 's/^pub const SUPPORTED_PLUGIN_API_VERSIONS: \[u32; [0-9]*\] = \[\([0-9]*\)\];/\1/p' server/crates/server/src/plugins/manifest.rs)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "error: $*" >&2; exit 1; }

# verify <data> <base64 signature file>: succeeds when one compiled-in key signed the data.
verify() {
    base64 -d "$2" > "$tmp/sig" 2>/dev/null || base64 -d <(tr -d ' \n' < "$2" | sed 's/=*$//') > "$tmp/sig" 2>/dev/null || return 1
    local b64
    for b64 in $(sed -n '/OFFICIAL_KEYS/,/;$/p' server/crates/server/src/plugins/trust.rs | grep -o '"[A-Za-z0-9+/]\{43\}="' | tr -d '"'); do
        { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; echo "$b64" | base64 -d; } > "$tmp/key.der"
        openssl pkey -pubin -inform DER -in "$tmp/key.der" -out "$tmp/key.pem" 2>/dev/null || continue
        openssl pkeyutl -verify -pubin -inkey "$tmp/key.pem" -rawin -in "$1" -sigfile "$tmp/sig" >/dev/null 2>&1 && return 0
    done
    return 1
}

curl -fsSL "$catalog_url/catalog.json" -o "$tmp/catalog.json"
curl -fsSL "$catalog_url/catalog.json.sig" -o "$tmp/catalog.json.sig"
verify "$tmp/catalog.json" "$tmp/catalog.json.sig" || fail "catalog.json signature is not valid for a compiled-in key"

# entry <id> <version>: "version sha256 zipUrl" of that catalog entry, empty when it is not installable.
entry() {
    jq -r --arg id "$1" --arg v "$2" --argjson api "$api" '
        .plugins[] | select(.id == $id) | .versions[]
        | select(.pluginApi == $api and (.sha256 | test("^0+$") | not) and ($v == "" or .version == $v))
        | "\(.version) \(.sha256) \(.zipUrl)"' "$tmp/catalog.json"
}

if [ "${1:-}" = "--check" ]; then
    [ -s "$lock" ] || fail "$lock is empty"
    while read -r id version sha url; do
        [ "$(entry "$id" "$version")" = "$version $sha $url" ] || fail "$id $version: the signed catalog does not carry this sha256 and zipUrl"
        curl -fsSL "$url" -o "$tmp/a.zip"
        [ "$(sha256sum "$tmp/a.zip" | cut -d' ' -f1)" = "$sha" ] || fail "$id $version: the archive's sha256 differs from the lock"
        unzip -p "$tmp/a.zip" plugin.json > "$tmp/plugin.json"
        unzip -p "$tmp/a.zip" plugin.json.sig > "$tmp/plugin.json.sig"
        verify "$tmp/plugin.json" "$tmp/plugin.json.sig" || fail "$id $version: plugin.json.sig is not valid for a compiled-in key"
        echo "ok $id $version"
    done < <(grep -v '^#' "$lock" | grep .)
    exit 0
fi

declare -A want
for a in "$@"; do want["${a%@*}"]="${a#*@}"; done
for id in "${!want[@]}"; do [[ " ${providers[*]} " == *" $id "* ]] || fail "$id is not a bundled provider"; done
declare -A old
[ -f "$lock" ] && while read -r id rest; do old[$id]="$id $rest"; done < <(grep -v '^#' "$lock" | grep .)
{
    echo "# Bundled provider archives embedded by server/crates/server/build.rs: id version sha256 zipUrl. Bump: scripts/bump-providers.sh"
    for id in "${providers[@]}"; do
        if [ $# -gt 0 ] && [ -z "${want[$id]:-}" ] && [ -n "${old[$id]:-}" ]; then
            echo "${old[$id]}"
            continue
        fi
        line="$(entry "$id" "${want[$id]:-}" | sort -V | tail -n1)"
        [ -n "$line" ] || fail "$id${want[$id]:+@${want[$id]}}: no installable version for pluginApi $api in the signed catalog"
        echo "$id $line"
    done
} > "$tmp/lock"
mv "$tmp/lock" "$lock"
cat "$lock"
