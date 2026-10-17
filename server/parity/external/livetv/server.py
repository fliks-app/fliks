#!/usr/bin/env python3
"""Loopback provider for the live TV parity scenarios: M3U and Xtream lineups, XMLTV guides, live streams.

usage: server.py <port>; times in the guides are relative to the request (titles are fixed).
"""
import gzip
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4921
BASE = f"http://127.0.0.1:{PORT}"
ETAG = '"v1"'
# set by `POST /_mode`: `shrunk` serves the short playlist, `delay` holds playlists and guides back.
MODE = {"shrunk": False, "delay": 0.0}
# requests being served, read by the runner's idle wait (`GET /__inflight`)
INFLIGHT = [0]
LOCK = threading.Lock()
ENTRY = '#EXTINF:-1 tvg-id="{tvg}" tvg-name="{name}" tvg-logo="{base}/logo/{n}.png" tvg-chno="{n}" group-title="{group}",{name}'
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082"
)


def playlist():
    def entry(n, name, tvg, group, url):
        return [ENTRY.format(tvg=tvg, name=name, n=n, group=group, base=BASE), url]

    lines = [f'#EXTM3U x-tvg-url="{BASE}/guide.xml" max-conn="2"']
    lines += entry(1, "One HD", "one.fr", "News", f"{BASE}/live/u/p/101.ts")
    lines += entry(1, "One FHD", "one.fr", "News", f"{BASE}/live/u/p/102.ts")
    lines += entry(2, "Two", "two.fr", "Sport", f"{BASE}/live/u/p/103.ts")
    lines += [
        '#EXTINF:-1 tvg-id="three.fr" tvg-shift="-0.5" group-title="Movies",Three',
        "#EXTVLCOPT:http-user-agent=EntryAgent/1.0",
        f"{BASE}/live/u/p/104.ts",
        '#EXTINF:-1 group-title="",No Group',
        f"{BASE}/live/u/p/105.ts",
        '#EXTINF:-1 group-title="Films",A Film',
        f"{BASE}/movie/u/p/200.mp4",
        '#EXTINF:-1 group-title="Series",An Episode',
        f"{BASE}/series/u/p/300.mkv",
        '#EXTINF:-1 group-title="News",One again',
        f"{BASE}/live/u/p/101.ts",
    ]
    return "\n".join(lines) + "\n"


def shrunk():
    lines = ['#EXTM3U max-conn="2"']
    for n, name in ((101, "One HD"), (103, "Two")):
        lines += [f'#EXTINF:-1 group-title="News",{name}', f"{BASE}/live/u/p/{n}.ts"]
    return "\n".join(lines) + "\n"


def live_gate():
    """A and B on one source, C with a dead first url, D all dead (`livetv-sessions.md`)."""
    lines = ['#EXTM3U max-conn="1"']
    for name, urls in (("A", ["a.ts"]), ("B", ["b.ts"]), ("C", ["dead/c1.ts", "c2.ts"]), ("D", ["dead/d1.ts", "dead/d2.ts"])):
        for u in urls:
            lines += [f'#EXTINF:-1 tvg-id="{name.lower()}" group-title="Live",{name}', f"{BASE}/stream/{u}"]
    return "\n".join(lines) + "\n"


def stamp(t):
    return time.strftime("%Y%m%d%H%M%S +0000", time.gmtime(t))


def guide(encoding="UTF-8", dup=False):
    now = time.time()
    out = [f'<?xml version="1.0" encoding="{encoding}"?>', "<tv>"]
    for cid, names in (("one.fr", ["One", "One HD"]), ("two.fr", ["Two"]), ("three.fr", ["Three"]), ("lonely.fr", ["Lonely"])):
        out.append(f'<channel id="{cid}">' + "".join(f"<display-name>{n}</display-name>" for n in names) + f'<icon src="{BASE}/logo/9.png"/></channel>')
    if dup:
        out.append('<channel id="one.fr"><display-name>One again</display-name></channel>')
    blocks = [(-5400, -1800, "Before"), (-1800, 5400, "Now"), (5400, 12600, "Later")]
    for cid in ("one.fr", "two.fr", "three.fr", "lonely.fr"):
        for a, b, title in blocks:
            t = f'<title lang="en">{title} EN</title><title lang="fr">{title} FR</title>' if cid == "one.fr" else f"<title>{title}</title>"
            if encoding != "UTF-8" and cid == "two.fr" and title == "Now":
                t = "<title>Café</title>"
            out.append(
                f'<programme start="{stamp(now + a)}" stop="{stamp(now + b)}" channel="{cid}">{t}'
                f'<desc>About {title}</desc><category>Cat</category><episode-num system="xmltv_ns">0.1.</episode-num></programme>'
            )
    out.append("</tv>")
    return "\n".join(out).encode(encoding)


def xtream_streams(user="u"):
    """`dup` repeats a stream id; `touch` files "One FHD" under another group than the channel it folds onto."""
    def s(sid, name, cat, direct=""):
        row = {"num": sid, "name": name, "stream_id": sid, "stream_icon": f"{BASE}/logo/{sid}.png", "epg_channel_id": f"x{sid}.fr", "category_id": str(cat)}
        if direct:
            row["direct_source"] = direct
        return row

    rows = [
        s(1, "Xone", 1), s(2, "Xtwo", 1), s(3, "Xthree", 2, f"{BASE}/direct/3.ts"), s(5, "Xfive", 3),
        s(7, "Two", 1), s(8, "One FHD", 2 if user == "touch" else 4),
    ]
    if user == "dup":
        rows.insert(3, s(1, "Xone duplicate", 1))
    return rows


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body=b"", headers=None):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def text(self, s, extra=None):
        self.reply(200, s.encode(), {"Content-Type": "text/plain; charset=utf-8", **(extra or {})})

    def as_json(self, v):
        self.reply(200, json.dumps(v).encode(), {"Content-Type": "application/json"})

    def counted(self, handle):
        with LOCK:
            INFLIGHT[0] += 1
        try:
            handle()
        finally:
            with LOCK:
                INFLIGHT[0] -= 1

    def do_POST(self):
        self.counted(self.post)

    def do_GET(self):
        if self.path == "/__inflight":
            return self.as_json({"inflight": INFLIGHT[0]})
        self.counted(self.get)

    def post(self):
        """`/_mode`: the scenarios flip the provider between steps."""
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        MODE.update({"shrunk": False, "delay": 0.0, **body})
        self.as_json(MODE)

    def get(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        if p in ("/playlist.m3u", "/get.php"):
            time.sleep(MODE["delay"])
            return self.text(shrunk() if MODE["shrunk"] else playlist())
        if p == "/playlist-etag.m3u":
            if self.headers.get("If-None-Match") == ETAG:
                return self.reply(304, b"", {"ETag": ETAG})
            return self.text(playlist(), {"ETag": ETAG})
        if p == "/playlist-shrunk.m3u":
            return self.text(shrunk())
        if p == "/test.m3u":
            return self.text(live_gate())
        if p == "/player_api.php":
            if q.get("username") not in ("u", "dup", "touch") or q.get("password") != "p":
                return self.as_json({"user_info": {"auth": 0}})
            action = q.get("action")
            if action == "get_live_categories":
                return self.as_json([{"category_id": "1", "category_name": "XNews"}, {"category_id": "2", "category_name": "XSport"}, {"category_id": "3", "category_name": "  XXX  "}, {"category_id": "4", "category_name": "Old News"}])
            if action == "get_live_streams":
                return self.as_json(xtream_streams(q.get("username")))
            return self.as_json({"user_info": {"auth": 1, "status": "Active", "exp_date": "4102444800", "max_connections": "2", "allowed_output_formats": ["m3u8", "ts"]}})
        if p in ("/guide.xml", "/xmltv.php"):
            time.sleep(MODE["delay"])
            return self.reply(200, guide(), {"Content-Type": "application/xml"})
        if p == "/guide.xml.gz":
            return self.reply(200, gzip.compress(guide()), {"Content-Type": "application/gzip"})
        if p == "/guide-etag.xml":
            if self.headers.get("If-None-Match") == ETAG:
                return self.reply(304, b"", {"ETag": ETAG})
            return self.reply(200, guide(), {"ETag": ETAG, "Content-Type": "application/xml"})
        if p == "/guide-empty.xml":
            return self.reply(200, b"<tv></tv>", {"Content-Type": "application/xml"})
        if p == "/guide-latin1.xml":
            return self.reply(200, guide("ISO-8859-1"), {"Content-Type": "application/xml"})
        if p == "/guide-dup.xml":
            return self.reply(200, guide(dup=True), {"Content-Type": "application/xml"})
        if p.startswith("/logo/"):
            return self.reply(200, PNG, {"Content-Type": "image/png"})
        if p.startswith("/stream/"):
            return self.stream(p[len("/stream/"):])
        if p == "/ua-only.ts":
            if self.headers.get("User-Agent") != "EntryAgent/1.0":
                return self.reply(403, b"forbidden")
            return self.stream("a.ts")
        return self.reply(404, b"not found")

    def stream(self, name):
        """A live MPEG-TS at real time for as long as the client reads (ffmpeg's testsrc)."""
        if name.startswith("dead/"):
            return self.reply(404, b"dead")
        self.send_response(200)
        self.send_header("Content-Type", "video/mp2t")
        self.end_headers()
        ff = subprocess.Popen(
            [
                "ffmpeg", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
                "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "mpegts", "-",
            ],
            stdout=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
        )
        try:
            while True:
                chunk = ff.stdout.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            ff.kill()
            ff.wait()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
