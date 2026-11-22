#!/usr/bin/env bash
# Self-test of route-retention.sh on two inline documents.
cd "$(dirname "$0")" || exit 1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo '{"paths":{"/a":{"get":{},"parameters":[]},"/b":{"post":{}}}}' > "$tmp/old.json"
echo '{"paths":{"/a":{"get":{}},"/b":{"post":{}},"/c":{"get":{}}}}' > "$tmp/added.json"
echo '{"paths":{"/a":{"get":{}},"/b":{"put":{}}}}' > "$tmp/removed.json"
n=0
./route-retention.sh "$tmp/old.json" "$tmp/added.json" 2>/dev/null || { echo "FAIL: an added route must pass"; n=1; }
./route-retention.sh "$tmp/old.json" "$tmp/removed.json" 2>/dev/null && { echo "FAIL: a removed operation must fail"; n=1; }
exit $n
