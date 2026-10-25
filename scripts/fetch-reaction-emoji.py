#!/usr/bin/env python3
"""Fetch the animated Noto emoji of the reaction catalog into server/public/emoji/<code>.webp.

The animated set is the `ANIMATED_REACTIONS` block of server/crates/domain/src/party.rs. Each asset is the
512 px animated WebP from fonts.gstatic.com, resized to 72 px. Run: python3 -I scripts/fetch-reaction-emoji.py
"""
import io
import re
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "server/crates/domain/src/party.rs"
OUT = ROOT / "server/public/emoji"
URL = "https://fonts.gstatic.com/s/e/notoemoji/latest/{code}/512.webp"
SIZE = 72


def catalog_codes():
    block = re.search(r"pub const ANIMATED_REACTIONS:.*?= \[(.*?)\n\];", SOURCE.read_text(encoding="utf-8"), re.S)
    animated = re.findall(r'"([^"]+)"', block.group(1))
    return ["_".join(f"{ord(c):x}" for c in emoji) for emoji in animated]


def resize(data):
    src = Image.open(io.BytesIO(data))
    frames, durations = [], []
    for i in range(src.n_frames):
        src.seek(i)
        frames.append(src.convert("RGBA").resize((SIZE, SIZE), Image.LANCZOS))
        durations.append(src.info.get("duration", 40))
    out = io.BytesIO()
    frames[0].save(
        out, "WEBP", save_all=True, append_images=frames[1:], duration=durations,
        loop=0, quality=60, method=6, minimize_size=True, allow_mixed=True,
    )
    return out.getvalue(), len(frames)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for code in catalog_codes():
        with urllib.request.urlopen(URL.format(code=code)) as r:
            webp, frames = resize(r.read())
        (OUT / f"{code}.webp").write_bytes(webp)
        print(f"{code}: {frames} frames, {len(webp) // 1024} KB")


if __name__ == "__main__":
    main()
