#!/usr/bin/env python3
"""Contact sheets for the demo reel: one tile every 0.5 s (frames extracted by record.mjs with ffmpeg
fps=2), labelled with the time and the shot id from the cue sheet.

    python3 showcase/sheets.py <framesDir> <cue.json> <outPrefix> [fromSeconds] [cols] [rows]
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

frames_dir, cue_path, out_prefix = sys.argv[1], sys.argv[2], sys.argv[3]
t0 = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
cols = int(sys.argv[5]) if len(sys.argv) > 5 else 6
rows = int(sys.argv[6]) if len(sys.argv) > 6 else 4
cue = json.load(open(cue_path))
shots = cue["shots"]
files = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
if not files:
    sys.exit("no frames")


def shot_at(t):
    for s in shots:
        if s["start"] <= t < s["end"] - 1e-6:
            return s
    return shots[-1]


try:
    font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 13)
except Exception:  # noqa: BLE001
    font = ImageFont.load_default()
first = Image.open(os.path.join(frames_dir, files[0]))
tw, th = first.size
lab = 18
per = cols * rows
out = []
for sheet in range((len(files) + per - 1) // per):
    img = Image.new("RGB", (cols * tw + (cols + 1) * 4, rows * (th + lab) + (rows + 1) * 4), (16, 14, 12))
    d = ImageDraw.Draw(img)
    for k in range(per):
        i = sheet * per + k
        if i >= len(files):
            break
        t = t0 + i * 0.5
        s = shot_at(t)
        x = 4 + (k % cols) * (tw + 4)
        y = 4 + (k // cols) * (th + lab + 4)
        img.paste(Image.open(os.path.join(frames_dir, files[i])).convert("RGB"), (x, y + lab))
        cut = any(abs(t - x["start"]) < 0.26 for x in shots)
        d.text((x + 2, y + 2), f"{t:6.1f}s  {s['n']:02d} {s['id']}", fill=(240, 180, 70) if cut else (225, 215, 200), font=font)
    path = f"{out_prefix}-{sheet + 1:02d}.png"
    img.save(path)
    out.append(path)
print("sheets:", " ".join(out))
