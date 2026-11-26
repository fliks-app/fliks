#!/usr/bin/env bash
# Self-test of amazon-publish.sh against a fake Amazon API: a `curl` stub sends the Amazon hosts to a local
# server whose open edit is $STUB/edit ("<id> <status>", or absent) and which logs each call to $STUB/log.
cd "$(dirname "$0")" || exit 1
stub=$(mktemp -d)
cat > "$stub/fake.py" <<'PY'
import http.server, json, os, sys
stub = sys.argv[1]
edit_file = os.path.join(stub, "edit")

def edit():
    return open(edit_file).read().split() if os.path.exists(edit_file) else None

class Fake(http.server.BaseHTTPRequestHandler):
    def reply(self, code, body=b""):
        self.send_response(code)
        self.send_header("ETag", "tag")
        self.end_headers()
        self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())

    def handle_one(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        path = self.path.removeprefix("/api/appstore/v1/applications/app")
        with open(os.path.join(stub, "log"), "a") as log:
            log.write(f"{self.command} {path}\n")
        if path == "/auth/o2/token":
            return self.reply(200, {"access_token": "t"})
        if self.headers.get("Authorization") != "Bearer t":
            return self.reply(401)
        current = edit()
        if path == "/edits":
            if self.command == "GET":
                return self.reply(200, {"id": current[0], "status": current[1]} if current else b"")
            if current:
                return self.reply(412)
            open(edit_file, "w").write("new IN_PROGRESS")
            return self.reply(200, {"id": "new", "status": "IN_PROGRESS"})
        if not current or not path.startswith(f"/edits/{current[0]}"):
            return self.reply(404)
        rest = path.removeprefix(f"/edits/{current[0]}")
        if self.command in ("PUT", "POST") and current[1] != "IN_PROGRESS":
            return self.reply(400, {"errors": [{"errorCode": "error_apk_cannot_be_modified"}]})
        if rest == "/apks":
            return self.reply(200, [{"id": "a1"}])
        if rest == "/listings/fr-FR":
            return self.reply(404)
        if rest == "/commit":
            open(edit_file, "w").write(f"{current[0]} SUBMITTED")
        if rest in ("", "/apks/a1", "/apks/a1/replace", "/listings/en-US", "/validate", "/commit"):
            return self.reply(200, {"language": "en-US"} if rest == "/listings/en-US" else {})
        self.reply(404)

    do_GET = do_PUT = do_POST = handle_one
    def log_message(self, *_): pass

server = http.server.HTTPServer(("127.0.0.1", 0), Fake)
open(os.path.join(stub, "port.tmp"), "w").write(str(server.server_port))
os.rename(os.path.join(stub, "port.tmp"), os.path.join(stub, "port"))
server.serve_forever()
PY
python3 "$stub/fake.py" "$stub" &
server=$!
trap 'kill $server; rm -rf "$stub"' EXIT
for _ in $(seq 50); do [ -e "$stub/port" ] && break; sleep 0.1; done
cat > "$stub/curl" <<SH
#!/bin/bash
args=("\${@//https:\/\/api.amazon.com/http://127.0.0.1:$(cat "$stub/port")}")
exec $(command -v curl) "\${args[@]//https:\/\/developer.amazon.com/http://127.0.0.1:$(cat "$stub/port")}"
SH
chmod +x "$stub/curl"
echo apk > "$stub/fliks.apk"
n=0
# case_ <ok|bad> <name> <event> <open edit or ""> <regex the call log must match> <regex it must not match>
case_() {
  local want=$1 name=$2 event=$3 open=$4 has=$5 hasnt=$6 got=0
  rm -f "$stub/edit" "$stub/log"
  [ -z "$open" ] || echo "$open" > "$stub/edit"
  out=$(PATH="$stub:$PATH" GITHUB_EVENT_NAME=$event AMAZON_TAG=v9.9.9 CLIENT_ID=c CLIENT_SECRET=s \
    APP=https://developer.amazon.com/api/appstore/v1/applications/app ./amazon-publish.sh "$stub/fliks.apk" 2>&1) || got=1
  [[ $want == bad && $got == 1 || $want == ok && $got == 0 ]] \
    && grep -qE "$has" "$stub/log" && ! grep -qE "$hasnt" "$stub/log" \
    || { echo "FAIL ($want): $name"; echo "$out"; cat "$stub/log"; n=1; }
}
case_ ok "no open edit: creates and commits one" push "" '^POST /edits/new/commit$' '^POST /edits/e1'
case_ ok "edit left in progress: reuses it" push "e1 IN_PROGRESS" '^POST /edits/e1/commit$' '^POST /edits$'
case_ ok "tag during review: skipped" push "e1 SUBMITTED" '^GET /edits$' '^(PUT|POST) /edits'
case_ bad "dispatch during review: fails" workflow_dispatch "e1 SUBMITTED" '^GET /edits$' '^(PUT|POST) /edits'
case_ ok "dispatch with no review: publishes" workflow_dispatch "" '^POST /edits/new/commit$' '^$'
case_ bad "unknown edit status: fails" push "e1 SOMETHING" '^GET /edits$' '^(PUT|POST) /edits'
case_ ok "tag during review: warns" push "e1 SUBMITTED" '' '^(PUT|POST) /edits'
[[ $out == *'::warning::v9.9.9 not sent to Amazon'* ]] || { echo "FAIL: no warning: $out"; n=1; }
exit $n
