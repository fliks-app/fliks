#!/usr/bin/env bash
# Self-test of client-route-gates.py on inline documents.
cd "$(dirname "$0")" || exit 1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/src"
echo '{"paths":{"/api/a/{id}":{"get":{}},"/api/b":{"get":{}}}}' > "$tmp/old.json"
: > "$tmp/none.txt"
printf '/api/new\n' > "$tmp/allow.txt"
cat > "$tmp/src/ok.ts" <<'T'
const a = `/api/a/${id}`; const b = '/api/b';
T
n=0
./client-route-gates.py "$tmp/old.json" "$tmp/none.txt" "$tmp/src" 2>/dev/null || { echo "FAIL: served and prefix URLs must pass"; n=1; }
echo "const u = \`/api/new/\${id}\`;" > "$tmp/src/new.ts"
./client-route-gates.py "$tmp/old.json" "$tmp/none.txt" "$tmp/src" 2>/dev/null && { echo "FAIL: an unserved URL must fail"; n=1; }
echo "const u = \`/api/new\`;" > "$tmp/src/new.ts"
./client-route-gates.py "$tmp/old.json" "$tmp/allow.txt" "$tmp/src" 2>/dev/null || { echo "FAIL: an allowlisted URL must pass"; n=1; }
echo "const u = \`/api/new\`; SERVER_SINCE.x;" > "$tmp/src/new.ts"
./client-route-gates.py "$tmp/old.json" "$tmp/none.txt" "$tmp/src" 2>/dev/null || { echo "FAIL: a gated file must pass"; n=1; }
exit $n
