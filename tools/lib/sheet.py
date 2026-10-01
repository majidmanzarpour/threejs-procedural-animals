#!/usr/bin/env python3
# Contact sheet composer for the procedural-animals tools.  python3 sheet.py spec.json
# spec: { "out": path, "title": str?, "rows": [{ "label": str, "tiles": [{ "file": path, "label": str?, "sub": str? }] }],
#         "cols": int? (wrap rows longer than this), "bg": [r,g,b]? }
import json, sys
from PIL import Image, ImageDraw, ImageFont

spec = json.load(open(sys.argv[1]))
bg = tuple(spec.get('bg', [34, 34, 38]))
try:
    font = ImageFont.load_default(size=12)
    big = ImageFont.load_default(size=15)
except TypeError:
    font = big = ImageFont.load_default()

rows = []
cols = spec.get('cols') or 0
for r in spec['rows']:
    tiles = r['tiles']
    if cols and len(tiles) > cols:
        for i in range(0, len(tiles), cols):
            rows.append({'label': r['label'] if i == 0 else '', 'tiles': tiles[i:i + cols]})
    else:
        rows.append(r)

ims = []
tw = th = 0
for r in rows:
    row = []
    for t in r['tiles']:
        im = Image.open(t['file']).convert('RGB')
        tw, th = max(tw, im.width), max(th, im.height)
        row.append((im, t))
    ims.append((r, row))

label_h = 18
title_h = 24 if spec.get('title') else 0
ncols = max(len(row) for _, row in ims) if ims else 1
W = tw * ncols + 4 * (ncols - 1)
H = title_h + sum(th + label_h + 4 for _ in ims)
sheet = Image.new('RGB', (max(W, 200), max(H, 40)), bg)
d = ImageDraw.Draw(sheet)
if title_h:
    d.text((6, 4), spec['title'], fill=(240, 240, 240), font=big)
y = title_h
for r, row in ims:
    d.text((4, y + 2), r.get('label', ''), fill=(255, 210, 120), font=font)
    y += label_h
    for i, (im, t) in enumerate(row):
        x = i * (tw + 4)
        sheet.paste(im, (x, y))
        lab = t.get('label')
        if lab:
            w = int(d.textlength(lab, font=font)) + 6
            d.rectangle([x, y, x + w, y + 15], fill=(0, 0, 0))
            d.text((x + 3, y + 1), lab, fill=(255, 230, 150), font=font)
        sub = t.get('sub')
        if sub:
            w = int(d.textlength(sub, font=font)) + 6
            d.rectangle([x, y + im.height - 16, x + w, y + im.height], fill=(0, 0, 0))
            d.text((x + 3, y + im.height - 15), sub, fill=(200, 220, 255), font=font)
    y += th + 4
sheet.save(spec['out'])
print(spec['out'], sheet.size)
