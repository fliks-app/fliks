#!/usr/bin/env bash
# Self-test of route-retention.sh on two inline documents.
cd "$(dirname "$0")" || exit 1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo '{"paths":{"/a":{"get":{},"parameters":[]},"/b":{"post":{}}}}' > "$tmp/old.json"
echo '{"paths":{"/a":{"get":{}},"/b":{"post":{}},"/c":{"get":{}}}}' > "$tmp/added.json"
echo '{"paths":{"/a":{"get":{}},"/b":{"put":{}}}}' > "$tmp/removed.json"
printf '# deliberate\nPOST /b\n' > "$tmp/allowed.txt"
: > "$tmp/none.txt"
printf 'GET /gone\n' > "$tmp/stale.txt"
n=0
./route-retention.sh "$tmp/old.json" "$tmp/added.json" "$tmp/none.txt" 2>/dev/null || { echo "FAIL: an added route must pass"; n=1; }
./route-retention.sh "$tmp/old.json" "$tmp/removed.json" "$tmp/none.txt" 2>/dev/null && { echo "FAIL: a removed operation must fail"; n=1; }
./route-retention.sh "$tmp/old.json" "$tmp/removed.json" "$tmp/allowed.txt" 2>/dev/null || { echo "FAIL: a listed removal must pass"; n=1; }
./route-retention.sh "$tmp/added.json" "$tmp/added.json" "$tmp/stale.txt" 2>/dev/null && { echo "FAIL: a stale line must fail"; n=1; }
exit $n
