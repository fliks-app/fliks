#!/usr/bin/env python3
"""Loopback stand-in for TMDB, TVDB and image.tmdb.org (docs/spec/metadata.md Vectors/parity).

Usage: stub.py PORT. Routes: /tmdb/3/*, /tvdb/v4/*, /img/t/p/<size>/<file>, /tvdb-art/* (artworks.thetvdb.com, 403).
Fixture of a GET: <dir>/<path with / as _>.<query value>.json, else <path>.json, else 404.
Subtitles (docs/spec/subtitle-providers.md): GET /subdl/api/v1/subtitles (releases by `type`/`languages`), GET /subtitle/<n>.zip.
Control (used by scenario steps with "stub": true): POST /__reset, POST /__fail {prefix,status|"hang"},
GET /__hits?prefix=, GET /__last?prefix= (query of the last request), GET /__inflight (requests being served).
"""
import io, json, os, sys, threading, time, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
IMG_DIR = os.path.join(HERE, "img")  # committed bytes: the poster hash must not depend on the local ffmpeg
LOCK = threading.Lock()
STATE = {"hits": [], "fail": {}, "inflight": 0}


def fixture(kind, rest, query):
    name = rest.strip("/").replace("/", "_")
    for key in ("query", "q"):
        for v in query.get(key, []):
            safe = "".join(c for c in v.lower() if c.isalnum())
            p = os.path.join(HERE, kind, f"{name}.{safe}.json")
            if os.path.exists(p):
                return p
    p = os.path.join(HERE, kind, f"{name}.json")
    return p if os.path.exists(p) else None


SUBDL = {
    "movie": [(101, "Work.Movie.2020.1080p.BluRay.x264-GRP", False), (102, "Work.Movie.2020.720p.WEB-DL.x264-OTHER", False), (103, "Work.Movie.2020.1080p.BluRay.x264-GRP.HI", True)],
    "tv": [(201, "Work.Show.S01E01.1080p.WEB-DL.x264-GRP", False), (202, "Work.Show.S01E02.1080p.WEB-DL.x264-GRP", False), (203, "Work.Show.S01.COMPLETE.720p.BluRay-PACK", False)],
}


def subdl_search(query):
    kind = (query.get("type") or ["movie"])[-1]
    lang = (query.get("languages") or ["EN"])[-1].upper()
    if lang == "ZZ":
        return {"status": True, "subtitles": []}
    subs = [{"sd_id": n, "release_name": name, "language": lang, "hi": hi, "url": f"/subtitle/{n}.zip", "rating": 0} for n, name, hi in SUBDL.get(kind, [])]
    return {"status": True, "subtitles": subs}


def subdl_zip(n):
    cue = f"1\n00:00:01,000 --> 00:00:03,000\nStub subtitle {n}.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line.\n"
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("subtitle.srt", (2026, 1, 1, 0, 0, 0)), cue)
    return out.getvalue()


def local_images(body):
    """Absolute image hosts in fixtures point back here; the runner maps them back in response bodies."""
    base = f"http://127.0.0.1:{sys.argv[1]}".encode()
    return body.replace(b"https://image.tmdb.org/t/p", base + b"/img/t/p").replace(b"https://artworks.thetvdb.com", base + b"/tvdb-art")


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self, method):
        with LOCK:
            STATE["inflight"] += 1
        try:
            self.route(method)
        finally:
            with LOCK:
                STATE["inflight"] -= 1

    def route(self, method):
        u = urlparse(self.path)
        query = parse_qs(u.query, keep_blank_values=True)
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        if u.path.startswith("/__"):
            return self.control(method, u.path, query, raw)
        if u.path.startswith("/tmdb/3/") and not query.get("api_key", [""])[-1]:
            # a keyless run (no provider keys) sees what api.themoviedb.org answers
            return self.send(401, {"status_code": 7, "status_message": "Invalid API key: You must be granted a valid key.", "success": False})
        with LOCK:
            STATE["hits"].append({"method": method, "path": u.path, "query": {k: v[-1] for k, v in query.items()}})
            fail = next((f for p, f in STATE["fail"].items() if u.path.startswith(p)), None)
        if fail == "hang":
            time.sleep(60)
            return self.send(504, {})
        if fail:
            return self.send(int(fail), {"status_message": "scripted failure", "message": "scripted failure"})
        if u.path == "/subdl/api/v1/subtitles":
            return self.send(200, subdl_search(query))
        if u.path.startswith("/subtitle/") and u.path.endswith(".zip"):
            return self.send(200, subdl_zip(u.path[len("/subtitle/"):-4]), "application/zip")
        if u.path.startswith("/tvdb-art/"):
            return self.send(403, b"Forbidden", "text/plain")  # what artworks.thetvdb.com answers for these names
        if u.path.startswith("/img/t/p/"):
            f = os.path.join(IMG_DIR, u.path.rsplit("/", 1)[-1])
            if os.path.isfile(f):
                return self.send(200, open(f, "rb").read(), "image/jpeg")
            return self.send(404, b"not found", "text/plain")
        if u.path == "/tvdb/v4/login" and method == "POST":
            return self.send(200, {"status": "success", "data": {"token": "parity-token"}})
        for prefix, kind in (("/tmdb/3", "tmdb"), ("/tvdb/v4", "tvdb")):
            if u.path.startswith(prefix + "/"):
                p = fixture(kind, u.path[len(prefix):], query)
                if p:
                    return self.send(200, local_images(open(p, "rb").read()))
                return self.send(404, {"status_code": 34, "status_message": "The resource you requested could not be found.", "message": "not found"})
        self.send(404, {})

    def control(self, method, path, query, raw):
        with LOCK:
            if path == "/__reset":
                STATE["hits"].clear()
                STATE["fail"].clear()
                return self.send(200, {"ok": True})
            if path == "/__fail":
                b = json.loads(raw or b"{}")
                STATE["fail"][b["prefix"]] = b.get("status", 500)
                return self.send(200, {"ok": True})
            if path == "/__inflight":
                # the control request itself is counted
                return self.send(200, {"inflight": STATE["inflight"] - 1})
            prefix = query.get("prefix", [""])[0]
            hits = [h for h in STATE["hits"] if h["path"].startswith(prefix)]
        if path == "/__hits":
            return self.send(200, {"hits": len(hits)})
        if path == "/__last":
            return self.send(200, hits[-1]["query"] if hits else {})
        self.send(404, {})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
