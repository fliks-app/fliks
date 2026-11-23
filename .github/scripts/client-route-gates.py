#!/usr/bin/env python3
"""Fails when the web client builds an /api URL that the oldest release of the support window does not serve,
in a file that never reads SERVER_SINCE (server/docs/spec/compatibility.md, rule 5).
usage: client-route-gates.py <oldest-release openapi.json> <allowlist> [client-src-dir]"""
import json, pathlib, re, sys

served = {re.sub(r"\{[^}]*\}", "{}", p) for p in json.load(open(sys.argv[1]))["paths"]}
allowed = {l.strip() for l in open(sys.argv[2]) if l.strip() and not l.startswith("#")}
root = pathlib.Path(sys.argv[3] if len(sys.argv) > 3 else "client/src")
LITERAL = re.compile(
    r"`(/api/(?:[^`$]|\$\{(?:[^{}`]|\{[^{}]*\})*\})*)`|'(/api/[^'\s]*)'|\"(/api/[^\"\s]*)\""
)


def served_by_release(url):
    # A URL cut before a dynamic tail is the prefix of a served route.
    return url in served or any(s.startswith(url + "/") for s in served)


bad = set()
for f in root.rglob("*.ts"):
    if f.name.endswith(".spec.ts"):
        continue
    text = f.read_text()
    if "SERVER_SINCE" in text:
        continue
    for m in LITERAL.finditer(text):
        raw = next(g for g in m.groups() if g)
        url = re.sub(r"\$\{(?:[^{}]|\{[^{}]*\})*\}", "{}", raw).split("?")[0].rstrip("/")
        if url in ("/api", "") or url.endswith("...") or served_by_release(url) or url in allowed:
            continue
        bad.add(f"{f} {url}")
if bad:
    print("Client URLs the oldest supported release does not serve, in a file without SERVER_SINCE:", file=sys.stderr)
    print("\n".join(sorted(bad)), file=sys.stderr)
    sys.exit(1)
