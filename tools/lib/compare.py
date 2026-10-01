#!/usr/bin/env python3
# Side-by-side sheet: render | photo [| photo with the render's silhouette outline].
#   python3 compare.py spec.json
# spec: { render, key (silhouette render on pure green), photo, out, label, bbox?: [x0,y0,x1,y1] (animal in
#         the photo, pixels), flip?: bool (mirror the photo), overlay?: bool, height?: int }
# With a photo bbox the render is scaled and cropped so its silhouette box matches the photo box (same
# height, same centre), making proportions directly comparable; without one both images are shown at
# the same height and the overlay aligns the render silhouette box to the photo frame inset by 6 %.
import json, sys
from PIL import Image, ImageDraw, ImageOps, ImageFilter, ImageChops

s = json.load(open(sys.argv[1]))
R = Image.open(s['render']).convert('RGB')
K = Image.open(s['key']).convert('RGB')
P = Image.open(s['photo']).convert('RGB')
if s.get('flip'):
    P = ImageOps.mirror(P)
Hout = int(s.get('height', 360))

# silhouette mask: anything not close to pure green
px = K.load()
mask = Image.new('L', K.size, 0)
mp = mask.load()
for y in range(K.height):
    for x in range(K.width):
        r, g, b = px[x, y]
        if not (g > 200 and r < 90 and b < 90):
            mp[x, y] = 255
mb = mask.getbbox() or (0, 0, K.width, K.height)

pb = s.get('bbox')
if pb:
    if s.get('flip'):
        pb = [P.width - pb[2], pb[1], P.width - pb[0], pb[3]]
    # scale render so silhouette height == photo bbox height, then place so centres coincide on a photo-sized canvas
    k = (pb[3] - pb[1]) / max(1, mb[3] - mb[1])
    Rs = R.resize((max(1, int(R.width * k)), max(1, int(R.height * k))), Image.LANCZOS)
    Ms = mask.resize(Rs.size, Image.NEAREST)
    cx_r, cy_r = (mb[0] + mb[2]) / 2 * k, (mb[1] + mb[3]) / 2 * k
    cx_p, cy_p = (pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2
    ox, oy = int(round(cx_p - cx_r)), int(round(cy_p - cy_r))
    Ra = Image.new('RGB', P.size, (40, 40, 44))
    Ra.paste(Rs, (ox, oy))
    Ma = Image.new('L', P.size, 0)
    Ma.paste(Ms, (ox, oy))
    note = 'aligned to photo bbox (height match)'
else:
    # fit render silhouette box into the photo frame inset 6 % (overlay only); show render uncropped
    ix, iy = P.width * 0.06, P.height * 0.06
    k = min((P.width - 2 * ix) / max(1, mb[2] - mb[0]), (P.height - 2 * iy) / max(1, mb[3] - mb[1]))
    Rs = R.resize((max(1, int(R.width * k)), max(1, int(R.height * k))), Image.LANCZOS)
    Ms = mask.resize(Rs.size, Image.NEAREST)
    ox = int(P.width / 2 - (mb[0] + mb[2]) / 2 * k)
    oy = int(P.height / 2 - (mb[1] + mb[3]) / 2 * k)
    Ra = Image.new('RGB', P.size, (40, 40, 44))
    Ra.paste(Rs, (ox, oy))
    Ma = Image.new('L', P.size, 0)
    Ma.paste(Ms, (ox, oy))
    note = 'no photo bbox: framing approximate'

panels = [Ra, P]
if s.get('overlay', True):
    edge = Ma.filter(ImageFilter.FIND_EDGES).point(lambda v: 255 if v > 40 else 0).filter(ImageFilter.MaxFilter(3))
    O = P.copy()
    O.paste((255, 40, 40), (0, 0), edge)
    panels.append(O)

sc = Hout / P.height
panels = [p.resize((max(1, int(p.width * sc)), Hout), Image.LANCZOS) for p in panels]
W = sum(p.width for p in panels) + 6 * (len(panels) - 1)
sheet = Image.new('RGB', (W, Hout + 20), (30, 30, 34))
d = ImageDraw.Draw(sheet)
d.text((4, 3), f"{s.get('label', '')}   [render | photo{' | silhouette overlay' if s.get('overlay', True) else ''}]   {note}", fill=(255, 220, 140))
x = 0
for p in panels:
    sheet.paste(p, (x, 20))
    x += p.width + 6
sheet.save(s['out'])
print(json.dumps({'out': s['out'], 'renderBox': mb, 'scale': k}))
