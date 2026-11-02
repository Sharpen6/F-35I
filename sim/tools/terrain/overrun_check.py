"""Check of the paved overruns in a built data set (not a build stage; reads, never writes the set).

For every paved runway end in airports.json the L0 colour tiles are sampled along the runway's
centreline beyond the end: the strip counts as continuing while its centre (+-20 % of the width)
is at least 18 grey levels brighter than the ground 30 m beside it (gaps up to 30 m allowed).
Ends where that strip runs more than 60 m past the painted overrun (`overrun_m`) are flagged, and
a contact sheet of them is written (red: runway end, yellow: painted overrun end, cyan: end of the
strip) so a person can decide; the confirmed ones go into runways.py OVERRUN_CONFIRMED_M (applied
by the build) and sim/js/terrain/Surface.js OVERRUN_FIX (fallback for data sets built before).

    python3 sim/tools/terrain/overrun_check.py [--data sim/data/terrain] [--sheet FILE.jpg]

The measure is luminance only: it also follows taxiways and sand in line with a runway, hence
the look at the sheet. In the 2021 imagery it confirmed Tel Nof 36 and 15R (~390 m) and
Palmachim 21 (~300 m); Ben Gurion 08, Palmachim 03 and Rishon 36 were sand or dirt, Atarot 30
a road junction.
"""
import argparse
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw

TILE, CORE, PX = 6400.0, 51200.0, 6.25


class Imagery:
    def __init__(self, data):
        self.data = data
        self.cache = {}

    def tile(self, ix, iz):
        if (ix, iz) not in self.cache:
            p = os.path.join(self.data, 'color', 'L0', f'tile_{ix}_{iz}.jpg')
            self.cache[(ix, iz)] = np.asarray(Image.open(p).convert('RGB'), dtype=np.float32) if os.path.exists(p) else None
        return self.cache[(ix, iz)]

    def lum(self, x, z):
        ix, iz = int((x + CORE) // TILE), int((z + CORE) // TILE)
        t = self.tile(ix, iz)
        if t is None:
            return float('nan')
        c = (x + CORE - TILE * ix) / PX - 0.5
        r = (z + CORE - TILE * iz) / PX - 0.5
        i, j = min(max(int(c), 0), 1022), min(max(int(r), 0), 1022)
        fc, fr = c - i, r - j
        v = (t[j, i] * (1 - fc) + t[j, i + 1] * fc) * (1 - fr) + (t[j + 1, i] * (1 - fc) + t[j + 1, i + 1] * fc) * fr
        return float(v @ np.array([0.2126, 0.7152, 0.0722]))

    def mosaic(self, x0, z0, size):
        n = int(size / PX)
        out = Image.new('RGB', (n, n))
        for ix in range(int((x0 + CORE) // TILE), int((x0 + size + CORE) // TILE) + 1):
            for iz in range(int((z0 + CORE) // TILE), int((z0 + size + CORE) // TILE) + 1):
                t = self.tile(ix, iz)
                if t is not None:
                    out.paste(Image.fromarray(t.astype(np.uint8)),
                              (round((ix * TILE - CORE - x0) / PX), round((iz * TILE - CORE - z0) / PX)))
        return out


def strip_end(img, e, ux, uz, w):
    """Metres past the end where the bright strip in line with the runway stops."""
    end_s, gap = 0.0, 0.0
    for s in np.arange(0.0, 800.0, 10.0):
        x, z = e['x'] + s * ux, e['z'] + s * uz
        c = np.mean([img.lum(x - t * uz, z + t * ux) for t in (-0.2 * w, 0.0, 0.2 * w)])
        side = np.mean([img.lum(x - t * uz, z + t * ux) for t in (-(w / 2 + 30), w / 2 + 30)])
        if c - side > 18:
            end_s, gap = s, 0.0
        else:
            gap += 10
            if gap > 30:
                break
    return end_s


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=os.path.join(here, '..', '..', 'data', 'terrain'))
    ap.add_argument('--sheet', default='/home/claude/simdata/terrain_extra/overrun_check.jpg')
    a = ap.parse_args()
    img = Imagery(a.data)
    airports = json.load(open(os.path.join(a.data, 'airports.json')))
    airports = airports if isinstance(airports, list) else airports['airports']
    flagged = []
    for apt in airports:
        for rw in apt.get('runways', []):
            if len(rw.get('ends') or []) < 2 or any(k in (rw.get('surface') or '') for k in ('grass', 'turf', 'dirt', 'gravel', 'sand')):
                continue
            ea, eb = rw['ends']
            L = math.hypot(eb['x'] - ea['x'], eb['z'] - ea['z'])
            for e, sgn in ((ea, -1.0), (eb, 1.0)):
                ux, uz = sgn * (eb['x'] - ea['x']) / L, sgn * (eb['z'] - ea['z']) / L
                ov = e.get('overrun_m') or 0.0
                s = strip_end(img, e, ux, uz, rw.get('width_m', 45))
                flag = s > ov + 60
                print(f"{apt['icao']:8s} {e['id']:4s} painted overrun {ov:5.0f} m, strip to {s:5.0f} m{'  <-- check' if flag else ''}")
                if flag:
                    flagged.append((apt['icao'], e, ux, uz, ov, s))
    if not flagged:
        return
    tiles = []
    for icao, e, ux, uz, ov, s in flagged:
        S = 1000.0
        cx, cz = e['x'] + 250 * ux, e['z'] + 250 * uz
        im = img.mosaic(cx - S / 2, cz - S / 2, S).resize((480, 480), Image.LANCZOS)
        d = ImageDraw.Draw(im)
        for dist, col in ((0.0, (255, 0, 0)), (ov, (255, 255, 0)), (s, (0, 255, 255))):
            x = (e['x'] + dist * ux - cx + S / 2) * 480 / S
            y = (e['z'] + dist * uz - cz + S / 2) * 480 / S
            d.ellipse((x - 5, y - 5, x + 5, y + 5), outline=col, width=2)
        d.text((5, 5), f"{icao} {e['id']}: painted {ov:.0f} m, strip {s:.0f} m", fill=(255, 255, 255))
        tiles.append(im)
    cols = 3
    sheet = Image.new('RGB', (cols * 480, ((len(tiles) + cols - 1) // cols) * 480))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 480, (i // cols) * 480))
    os.makedirs(os.path.dirname(a.sheet), exist_ok=True)
    sheet.save(a.sheet, quality=90)
    print('contact sheet:', a.sheet)


if __name__ == '__main__':
    main()
