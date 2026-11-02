#!/usr/bin/env python3
"""Field data for the terrain's near ground materials: per 10 m texel of every core tile the
land cover class, the row direction and a random number of the field it lies in
(js/terrain/fieldAnalysis.js has the 16-bit layout; the terrain shader draws crop rows,
orchards, vineyards, greenhouses and street grids from it).

    python3 sim/tools/terrain/fields.py [--data sim/data/terrain] [--out DIR] [--cache DIR]
                                        [--stages fetch,prepare,segment,check]

Reads the built terrain data set (never writes it) and writes DIR (default
<data>/../terrain_extra/fields/): tile_{ix}_{iz}.u16.gz (640 x 640 little-endian uint16, row 0 =
north, gzip) and index.json. The app loads them from data/terrain_extra/fields/ and, where they
are missing, analyses each tile on its own in the tile worker (slower, and fields cut by a tile
edge then change their rows at the edge).

Stages:
  fetch    OpenStreetMap land use for the core via Overture Maps (base/land_use: orchards,
           vineyards, greenhouses, farmland and nurseries; anonymous HTTPS range requests,
           a few tens of MB) -> <cache>/land_use.pkl
  prepare  mosaics of the whole core in <cache> (~0.5 GB): the L0 imagery at 12.5 m (box
           filtered), the WorldCover codes at 10 m, the mapped classes at 10 m (orchard 1,
           vineyard 2, greenhouses 3) and the mapped polygons' ids at 12.5 m (field outlines)
  segment  fields_segment.mjs (node): one segmentation of the whole core in tile windows with
           800 m of context, stitched into regions across the tile edges; per region the row
           direction and a random number from its world position; writes DIR
  check    the seam statistics (texel pairs across tile edges against pairs inside tiles) and a
           preview of the row directions -> DIR/check.txt, DIR/preview_*.jpg

Licences: the land use is (c) OpenStreetMap contributors, ODbL 1.0, via Overture Maps
Foundation (base theme); the imagery and land cover are ESA WorldCover 2021 (CC BY 4.0).
"""
import argparse
import gzip
import json
import os
import pickle
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

CORE = 51200.0
TILE = 6400.0
NT = 16
SEG_PX = 512          # analysis pixels per tile (12.5 m)
LC_PX = 640           # land cover / output texels per tile (10 m)

# mapped land use classes -> mask value (drawn in this order: later ones win)
MASK = {'orchard': 1, 'vineyard': 2, 'greenhouse_horticulture': 3}
# polygons whose outlines help the segmentation (field edges a map knows)
OUTLINE = ('orchard', 'vineyard', 'greenhouse_horticulture', 'farmland', 'plant_nursery', 'farmyard', 'allotments')
ATTRIBUTION = ('Field outlines, orchards, vineyards and greenhouses: (c) OpenStreetMap contributors, ODbL 1.0, '
               'via Overture Maps Foundation (base theme, land use)')


def log(*a):
    print('  [fields]', *a, flush=True)


def fetch(cache):
    out = os.path.join(cache, 'land_use.pkl')
    if os.path.exists(out):
        log(f'{out} exists: fetch skipped (delete it to fetch again)')
        return
    import grid
    import osmcheck
    feats = osmcheck.fetch_features('base', 'land_use', osmcheck.CORE_BBOX)
    polys = []
    for f in feats:
        if f['cls'] not in OUTLINE:
            continue
        rings = []
        for r in osmcheck.rings_of(osmcheck.parse_wkb(f['wkb'])[0]):
            x, z = grid.lonlat_to_xz(r[:, 0], r[:, 1])
            rings.append(np.stack([np.asarray(x), np.asarray(z)], 1).astype(np.float32))
        if rings:
            polys.append((f['cls'], rings))
    with open(out + '.tmp', 'wb') as fh:
        pickle.dump(dict(release=osmcheck.RELEASE, polys=polys), fh)
    os.replace(out + '.tmp', out)
    log(f'{len(polys)} polygons -> {out}')


def _draw_rings(draw, rings, px, value, hole=0):
    """Outer ring with value, inner rings (holes) with hole; rings in world metres."""
    for k, r in enumerate(rings):
        pts = [((x + CORE) / px, (z + CORE) / px) for x, z in r]
        if len(pts) >= 3:
            draw.polygon(pts, fill=value if k == 0 else hole)


def prepare(data, cache):
    t0 = time.time()
    with open(os.path.join(cache, 'land_use.pkl'), 'rb') as fh:
        polys = pickle.load(fh)['polys']
    n12, n10 = NT * SEG_PX, NT * LC_PX
    # imagery at 12.5 m (2 x 2 box of the 6.25 m tiles) and WorldCover codes at 10 m
    rgb = np.lib.format.open_memmap(os.path.join(cache, 'rgb12.npy'), 'w+', np.uint8, (n12, n12, 3))
    lc = np.lib.format.open_memmap(os.path.join(cache, 'lc10.npy'), 'w+', np.uint8, (n10, n10))
    for iz in range(NT):
        for ix in range(NT):
            im = Image.open(os.path.join(data, 'color', 'L0', f'tile_{ix}_{iz}.jpg')).convert('RGB')
            a = np.asarray(im, np.uint16).reshape(SEG_PX, 2, SEG_PX, 2, 3).sum(axis=(1, 3))
            rgb[iz * SEG_PX:(iz + 1) * SEG_PX, ix * SEG_PX:(ix + 1) * SEG_PX] = ((a + 2) // 4).astype(np.uint8)
            c = np.asarray(Image.open(os.path.join(data, 'landcover', f'tile_{ix}_{iz}.png')))
            lc[iz * LC_PX:(iz + 1) * LC_PX, ix * LC_PX:(ix + 1) * LC_PX] = c
    rgb.flush()
    lc.flush()
    del rgb, lc
    log(f'imagery and land cover mosaics ({time.time() - t0:.0f} s)')
    # mapped classes at 10 m
    m = Image.new('L', (n10, n10), 0)
    d = ImageDraw.Draw(m)
    for cls in MASK:
        for c, rings in polys:
            if c == cls:
                _draw_rings(d, rings, 10.0, MASK[cls])
    np.save(os.path.join(cache, 'mask10.npy'), np.asarray(m, np.uint8))
    del m, d
    # polygon ids at 12.5 m (outlines for the segmentation); small ones last so they stay whole
    order = sorted(range(len(polys)), key=lambda i: -_area(polys[i][1][0]))
    o = Image.new('I', (n12, n12), 0)
    d = ImageDraw.Draw(o)
    for k, i in enumerate(order):
        _draw_rings(d, polys[i][1], 12.5, (k % 65535) + 1)
    np.save(os.path.join(cache, 'poly12.npy'), np.asarray(o, np.int32).astype(np.uint16))
    del o, d
    counts = {c: sum(1 for p in polys if p[0] == c) for c in OUTLINE}
    log(f'mapped masks and outlines: {counts} ({time.time() - t0:.0f} s)')


def _area(r):
    x, z = r[:, 0].astype(np.float64), r[:, 1].astype(np.float64)
    return 0.5 * abs(np.dot(x, np.roll(z, 1)) - np.dot(z, np.roll(x, 1)))


def segment(cache, out):
    os.makedirs(out, exist_ok=True)
    node = os.environ.get('NODE', 'node')
    cmd = [node, os.path.join(HERE, 'fields_segment.mjs'), '--cache', cache, '--out', out]
    log(' '.join(cmd))
    subprocess.run(cmd, check=True)
    with open(os.path.join(out, 'index.json')) as fh:
        idx = json.load(fh)
    idx['attribution'] = ATTRIBUTION
    with open(os.path.join(cache, 'land_use.pkl'), 'rb') as fh:
        idx['overture_release'] = pickle.load(fh)['release']
    with open(os.path.join(out, 'index.json'), 'w') as fh:
        json.dump(idx, fh, indent=1)


def _tile(out, ix, iz):
    with open(os.path.join(out, f'tile_{ix}_{iz}.u16.gz'), 'rb') as fh:
        return np.frombuffer(gzip.decompress(fh.read()), '<u2').reshape(LC_PX, LC_PX)


def check(out):
    """Texel pairs across every tile edge against pairs inside the tiles: same field (row
    direction within 15 deg and the same random number) for crops and trees."""
    lines = []
    tiles = {(ix, iz): _tile(out, ix, iz) for iz in range(NT) for ix in range(NT)}

    def stats(a, b):
        ca, cb = a & 15, b & 15
        keep = (ca == cb) & np.isin(ca, (1, 4, 12, 13))
        ta, tb = ((a >> 4) & 127) * (180 / 128), ((b >> 4) & 127) * (180 / 128)
        dt = np.abs(ta - tb) % 180
        dt = np.minimum(dt, 180 - dt)
        same = (dt <= 15) & ((a >> 11) == (b >> 11))
        return int(keep.sum()), int((same & keep).sum())

    edge = [0, 0]
    inner = [0, 0]
    for (ix, iz), t in tiles.items():
        if ix + 1 < NT:
            n, s = stats(t[:, -1], tiles[(ix + 1, iz)][:, 0])
            edge[0] += n; edge[1] += s
        if iz + 1 < NT:
            n, s = stats(t[-1, :], tiles[(ix, iz + 1)][0, :])
            edge[0] += n; edge[1] += s
        for k in (159, 319, 479):
            n, s = stats(t[:, k], t[:, k + 1])
            inner[0] += n; inner[1] += s
            n, s = stats(t[k, :], t[k + 1, :])
            inner[0] += n; inner[1] += s
    fe, fi = edge[1] / max(1, edge[0]), inner[1] / max(1, inner[0])
    lines.append(f'crop / tree / orchard / vineyard texel pairs in the same field: across tile edges '
                 f'{100 * fe:.1f} % of {edge[0]}, inside tiles {100 * fi:.1f} % of {inner[0]}')
    cls = np.zeros(15, np.int64)
    for t in tiles.values():
        cls += np.bincount((t & 15).ravel(), minlength=15)[:15]
    names = ['no data', 'tree', 'shrub', 'grass', 'crop', 'built-up', 'bare', 'snow', 'water', 'wetland',
             'mangrove', 'moss', 'orchard', 'vineyard', 'greenhouses']
    lines.append('classes: ' + ', '.join(f'{names[i]} {100 * cls[i] / cls.sum():.2f} %' for i in range(15) if cls[i]))
    # preview: row direction as hue on the imagery's land cover, 1/4 scale
    for name, (x0, z0, nt) in {'telnof': (4, 8, 2), 'core': (0, 0, 16)}.items():
        step = 4 if nt <= 2 else 16
        n = LC_PX // step
        img = np.zeros((nt * n, nt * n, 3), np.uint8)
        for dz in range(nt):
            for dx in range(nt):
                t = tiles[(x0 + dx, z0 + dz)][::step, ::step]
                th = ((t >> 4) & 127) * (np.pi / 64)
                rnd = (t >> 11) / 31
                c = t & 15
                rgb = np.stack([0.5 + 0.5 * np.cos(th), 0.5 + 0.5 * np.cos(th + 2.09), 0.5 + 0.5 * np.cos(th + 4.19)], -1)
                rgb *= (0.55 + 0.45 * rnd)[..., None]
                rgb[c == 12] = (0.1, 0.5, 0.1)
                rgb[c == 13] = (0.5, 0.1, 0.5)
                rgb[c == 14] = (1.0, 1.0, 1.0)
                rgb[~np.isin(c, (1, 4, 12, 13, 14))] *= 0.25
                img[dz * n:(dz + 1) * n, dx * n:(dx + 1) * n] = (rgb * 255).astype(np.uint8)
        Image.fromarray(img).save(os.path.join(out, f'preview_{name}.jpg'), quality=88)
    with open(os.path.join(out, 'check.txt'), 'w') as fh:
        fh.write('\n'.join(lines) + '\n')
    for ln in lines:
        log(ln)
    return fe, fi


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data', default=os.path.normpath(os.path.join(HERE, '..', '..', 'data', 'terrain')))
    ap.add_argument('--out', default=None, help='default <data>/../terrain_extra/fields')
    ap.add_argument('--cache', default=None, help='default <out>/../_cache/fields')
    ap.add_argument('--stages', default='fetch,prepare,segment,check')
    args = ap.parse_args()
    data = os.path.abspath(args.data)
    out = os.path.abspath(args.out or os.path.join(data, '..', 'terrain_extra', 'fields'))
    cache = os.path.abspath(args.cache or os.path.join(out, '..', '_cache', 'fields'))
    os.makedirs(cache, exist_ok=True)
    for s in [x.strip() for x in args.stages.split(',') if x.strip()]:
        t0 = time.time()
        log(f'stage {s}')
        if s == 'fetch':
            fetch(cache)
        elif s == 'prepare':
            prepare(data, cache)
        elif s == 'segment':
            segment(cache, out)
        elif s == 'check':
            check(out)
        else:
            ap.error(f'unknown stage {s}')
        log(f'stage {s} done in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
