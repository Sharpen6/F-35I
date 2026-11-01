#!/usr/bin/env python3
"""Air base structures for buildings.py.

The buildings inside Israel's air bases are not in OpenStreetMap or in the Microsoft ML footprints,
so Tel Nof, Hatzor and Palmachim would stand empty beside their runways. Their roofs are visible in
the terrain's own L0 imagery (the ESA WorldCover Sentinel-2 composite, CC BY 4.0, 6.25 m / px): inside a hand-drawn outline of each base
(airbases.json) bright, compact roofs that stand out of their surroundings become oriented boxes of
1-3 floors, large ones halls or vaulted hangars, and a few structures are added by hand (control
towers). Approximate by nature (10 m imagery: small buildings merge, dark roofs are missed), but the
boxes stand exactly on the roofs the imagery shows, so the ground texture and the 3D agree.

Nothing is placed on runways (with overruns, +25 m), taxiways and aprons (from the airfield data of
sim/tools/world/airfields.py when present, +8 m) or where a footprint already exists.

    python3 sim/tools/world/airbases.py --plot DIR     # review: the boxes over the imagery
"""
import argparse
import json
import math
import os
import sys
import zlib

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', 'terrain')))
import grid  # noqa: E402

PX = grid.TILE_SIZE / 1024.0             # L0 imagery: 6.25 m / px
DATASET = 'ESA WorldCover Sentinel-2 imagery (air base roofs traced by sim/tools/world/airbases.py)'
LICENSE = 'CC-BY-4.0'
# wall colours of base buildings: sand and cream plaster, off-white, concrete grey (sRGB hex)
WALLS = ['#d6c8aa', '#e2d6bc', '#e8e4da', '#beb9ae', '#cfc6b2', '#d9d2c2']


def _u(*v):
    """Deterministic 0..1 from numbers (positions), stable across runs and machines."""
    return (zlib.crc32(','.join(f'{x:.1f}' for x in v).encode()) & 0xffffff) / float(0x1000000)


def _mosaic(terrain, x0, z0, x1, z1):
    """L0 colour of a world rectangle: float RGB, world x / z of its corner."""
    T, O = grid.TILE_SIZE, -grid.CORE_HALF
    ix0, iz0, ix1, iz1 = int((x0 - O) // T), int((z0 - O) // T), int((x1 - O) // T), int((z1 - O) // T)
    mos = Image.new('RGB', ((ix1 - ix0 + 1) * 1024, (iz1 - iz0 + 1) * 1024))
    for ix in range(ix0, ix1 + 1):
        for iz in range(iz0, iz1 + 1):
            p = os.path.join(terrain, 'color', 'L0', f'tile_{ix}_{iz}.jpg')
            if os.path.exists(p):
                mos.paste(Image.open(p).convert('RGB'), ((ix - ix0) * 1024, (iz - iz0) * 1024))
    mx0, mz0 = O + ix0 * T, O + iz0 * T
    c0, r0 = int((x0 - mx0) / PX), int((z0 - mz0) / PX)
    c1, r1 = int(math.ceil((x1 - mx0) / PX)), int(math.ceil((z1 - mz0) / PX))
    crop = mos.crop((c0, r0, c1, r1))
    return np.asarray(crop, np.float32) / 255.0, crop, mx0 + c0 * PX, mz0 + r0 * PX


def _landcover(terrain, gx0, gz0, W, H):
    """WorldCover class (10 m) at the centres of the imagery pixels of a mosaic."""
    T, O = grid.TILE_SIZE, -grid.CORE_HALF
    xs = gx0 + (np.arange(W) + 0.5) * PX
    zs = gz0 + (np.arange(H) + 0.5) * PX
    X, Z = np.meshgrid(xs, zs)
    ix = ((X - O) // T).astype(int)
    iz = ((Z - O) // T).astype(int)
    out = np.zeros((H, W), np.uint8)
    for tx, tz in set(zip(ix.ravel().tolist(), iz.ravel().tolist())):
        p = os.path.join(terrain, 'landcover', f'tile_{tx}_{tz}.png')
        if not os.path.exists(p):
            continue
        lc = np.asarray(Image.open(p))
        n = lc.shape[0]
        m = (ix == tx) & (iz == tz)
        li = np.clip(((X[m] - (O + tx * T)) / (T / n)).astype(int), 0, n - 1)
        lj = np.clip(((Z[m] - (O + tz * T)) / (T / n)).astype(int), 0, n - 1)
        out[m] = lc[lj, li]
    return out


def _record(rid, name, ring, cls, height, wall, min_height=None, roof_shape=None, facade_material=None):
    """A footprint record as buildings.load_footprints() + project() make them."""
    return dict(id=rid, name=name, dataset=DATASET, license=LICENSE, level=None, height=float(height),
                min_height=min_height, underground=False, floors=None, min_floor=None, subtype='military',
                cls=cls, facade_color=wall, facade_material=facade_material, roof_material=None,
                roof_shape=roof_shape, roof_direction=None, roof_color=None, roof_height=None, has_parts=False,
                building_id=None, part=False, synthetic=True, rings=[np.asarray(ring, np.float64)])


def _rect(x, z, ha, hb, yaw):
    c, s = math.cos(yaw), math.sin(yaw)
    return [(x + c * ha * a - s * hb * b, z + s * ha * a + c * hb * b) for a, b in ((1, 1), (-1, 1), (-1, -1), (1, -1))]


def detect(base, terrain, recs, airports, airfields, thr=0.06):
    """Boxes on the bright roofs inside the base outline: (records, debug dict)."""
    P = np.asarray(base['outline'], np.float64)
    x0, z0 = P.min(0) - 100
    x1, z1 = P.max(0) + 100
    img, crop, gx0, gz0 = _mosaic(terrain, x0, z0, x1, z1)
    H, W = img.shape[:2]

    def px(x, z):
        return ((x - gx0) / PX, (z - gz0) / PX)

    inside = Image.new('L', (W, H), 0)
    ImageDraw.Draw(inside).polygon([px(x, z) for x, z in P], fill=255)
    inside = np.asarray(inside) > 0
    excl = Image.new('L', (W, H), 0)
    de = ImageDraw.Draw(excl)
    for ap in airports:                                   # runways with overruns, +25 m
        for rw in ap['runways']:
            a, b = rw['ends']
            dx, dz = b['x'] - a['x'], b['z'] - a['z']
            L = math.hypot(dx, dz)
            ux, uz = dx / L, dz / L
            o0, o1 = a.get('overrun_m') or 0, b.get('overrun_m') or 0
            hw = rw['width_m'] / 2 + 25
            pa = (a['x'] - ux * o0, a['z'] - uz * o0)
            pb = (b['x'] + ux * o1, b['z'] + uz * o1)
            nx, nz = -uz * hw, ux * hw
            de.polygon([px(pa[0] + nx, pa[1] + nz), px(pb[0] + nx, pb[1] + nz),
                        px(pb[0] - nx, pb[1] - nz), px(pa[0] - nx, pa[1] - nz)], fill=255)
    if airfields:                                          # taxiways (+8 m) and aprons
        O = -grid.CORE_HALF
        for key, t in airfields.get('tiles', {}).items():
            tx, tz = (int(v) for v in key.split(','))
            bx, bz = O + tx * grid.TILE_SIZE, O + tz * grid.TILE_SIZE
            for tw in t.get('taxiways', []):
                p = tw['pts']
                pts = [px(bx + p[i], bz + p[i + 1]) for i in range(0, len(p), 2)]
                w = (tw.get('cw', 20) + tw.get('left', 0) + tw.get('right', 0) + 16) / PX
                de.line(pts, fill=255, width=max(2, int(round(w))))
            for apn in t.get('aprons', []):
                p = apn['tris']
                for i in range(0, len(p), 6):
                    de.polygon([px(bx + p[i], bz + p[i + 1]), px(bx + p[i + 2], bz + p[i + 3]),
                                px(bx + p[i + 4], bz + p[i + 5])], fill=255)
    for r in recs:                                         # footprints that exist already (+12 m)
        ring = r['rings'][0]
        if ring[:, 0].max() < x0 or ring[:, 0].min() > x1 or ring[:, 1].max() < z0 or ring[:, 1].min() > z1:
            continue
        de.polygon([px(x, z) for x, z in ring], fill=255)
    excl = ndimage.binary_dilation(np.asarray(excl) > 0, iterations=1)
    # roofs: brighter than their surroundings at two scales (small blocks, large halls), not
    # saturated (soil and fields are), not on paving; a 2 x 2 opening drops lanes and kerbs
    Lm = img @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    sat = img.max(2) - img.min(2)
    bg = np.minimum(ndimage.median_filter(Lm, size=9), ndimage.median_filter(Lm, size=21))
    cand = (Lm - bg > thr) & (Lm > 0.52) & (sat < 0.22) & inside & ~excl
    cand = ndimage.binary_opening(cand, structure=np.ones((2, 2)))
    lab, n = ndimage.label(cand, structure=np.ones((3, 3)))
    # bright soil, sand and stubble look like roofs too: keep what WorldCover calls built-up (50)
    built = ndimage.binary_dilation(_landcover(terrain, gx0, gz0, W, H) == 50, iterations=1)
    boxes = []
    for k, sl in enumerate(ndimage.find_objects(lab), 1):
        m = lab[sl] == k
        cnt = int(m.sum())
        area = cnt * PX * PX
        if area < 110 or area > 6000:
            continue
        if built[sl][m].mean() < 0.5:
            continue
        if area < 250 and float((Lm[sl] - bg[sl])[m].mean()) < 0.1:      # small and faint: likely ground
            continue
        rr, cc = np.nonzero(m)
        xs = gx0 + (cc + sl[1].start + 0.5) * PX
        zs = gz0 + (rr + sl[0].start + 0.5) * PX
        mx, mz = float(xs.mean()), float(zs.mean())
        cov = np.cov(np.vstack([xs - mx, zs - mz])) + np.eye(2) * (PX * PX / 12)
        ev, evec = np.linalg.eigh(cov)
        ha, hb = math.sqrt(3 * ev[1]), math.sqrt(3 * ev[0])       # a uniform rectangle: var = L^2 / 12
        yaw = math.atan2(evec[1, 1], evec[0, 1])
        fill = area / (4 * ha * hb)
        if hb < 3.5 or ha / hb > 5 or fill < 0.45:
            continue
        # the imagery blurs edges: the box is the component's moments, shrunk a little
        boxes.append(dict(x=mx, z=mz, ha=ha * 0.94, hb=hb * 0.94, yaw=yaw, area=4 * ha * hb * 0.94 ** 2, fill=fill))

    out = []
    keep = []
    for s in base.get('structures', []):
        if s['kind'] != 'tower':
            continue
        yaw = math.radians(s.get('yaw', 0))
        w, l, h = s['shaft']
        cw, cl, ch = s['cab']
        rid = f"airbase:{base['icao']}:tower"
        out.append(_record(rid, f"{base['name']} control tower", _rect(s['x'], s['z'], l / 2, w / 2, yaw),
                           'military', h, '#d2cab8'))
        out.append(_record(rid + ':cab', None, _rect(s['x'], s['z'], cl / 2, cw / 2, yaw), 'office', h + ch,
                           '#5e7480', min_height=h, facade_material='glass'))
        keep.append((s['x'], s['z'], max(cw, cl) / 2 + 12))
    for i, b in enumerate(boxes):
        if any(math.hypot(b['x'] - x, b['z'] - z) < r + b['ha'] for x, z, r in keep):
            continue
        u, u2 = _u(b['x'], b['z']), _u(b['z'], b['x'], 7)
        A, elong = b['area'], b['ha'] / b['hb']
        wall = WALLS[int(u2 * len(WALLS)) % len(WALLS)]
        shape = None
        if A >= 1800 and b['fill'] > 0.6 and elong < 2.6 and u < 0.6:
            cls, h, shape, wall = 'hangar', 11.0 + 5.0 * u2, 'round', None      # vaulted hangar (hangar palette)
        elif A >= 1800:
            cls, h = 'industrial', 8.0 + 4.0 * u2                               # hall
        elif A >= 700:
            cls, h = 'military', 6.5 + 4.0 * u2                                 # 2-3 floors
        elif A >= 150:
            cls, h = 'military', 4.0 + 4.0 * u2                                 # 1-2 floors
        else:
            cls, h = 'military', 3.2 + 1.2 * u2                                 # huts, guard posts
        out.append(_record(f"airbase:{base['icao']}:{i}", None, _rect(b['x'], b['z'], b['ha'], b['hb'], b['yaw']),
                           cls, h, wall, roof_shape=shape))
    dbg = dict(crop=crop, gx0=gx0, gz0=gz0, inside=inside, excl=excl, boxes=boxes)
    return out, dbg


def structures(terrain, recs, airfields_path=None, config=None, log=print):
    """Records of every base in airbases.json (projected rings: the world frame)."""
    with open(config or os.path.join(HERE, 'airbases.json')) as f:
        cfg = json.load(f)
    with open(os.path.join(terrain, 'airports.json')) as f:
        airports = json.load(f)
    airfields = None
    if airfields_path and os.path.exists(airfields_path):
        with open(airfields_path) as f:
            airfields = json.load(f)
    else:
        log(f'airbases: no airfield data ({airfields_path}): taxiways are not kept clear')
    out = []
    for base in cfg['bases']:
        rs, _ = detect(base, terrain, recs, airports, airfields)
        log(f"airbases: {base['name']}: {len(rs)} structures")
        out += rs
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root = os.path.normpath(os.path.join(HERE, '..', '..', 'data'))
    ap.add_argument('--terrain', default=os.path.join(root, 'terrain'))
    ap.add_argument('--airfields', default=os.path.join(root, 'world', 'airfields', 'airfields.json'))
    ap.add_argument('--plot', required=True, help='folder for one review image per base')
    a = ap.parse_args()
    with open(os.path.join(HERE, 'airbases.json')) as f:
        cfg = json.load(f)
    with open(os.path.join(a.terrain, 'airports.json')) as f:
        airports = json.load(f)
    airfields = json.load(open(a.airfields)) if os.path.exists(a.airfields) else None
    os.makedirs(a.plot, exist_ok=True)
    for base in cfg['bases']:
        rs, d = detect(base, a.terrain, [], airports, airfields)
        S = 3
        crop = d['crop']
        W, H = crop.size
        vis = crop.resize((W * S, H * S), Image.LANCZOS)
        ov = np.zeros((H, W, 4), np.uint8)
        ov[d['excl'] & d['inside']] = (255, 255, 0, 60)
        ov = Image.fromarray(ov).resize((W * S, H * S), Image.NEAREST)
        vis.paste(ov, (0, 0), ov)
        dr = ImageDraw.Draw(vis, 'RGBA')
        dr.polygon([((x - d['gx0']) / PX * S, (z - d['gz0']) / PX * S) for x, z in base['outline']],
                   outline=(0, 255, 255, 255))
        for r in rs:
            col = (255, 0, 255, 255) if 'tower' in r['id'] else (0, 120, 255, 255) if r['cls'] == 'hangar' else (255, 0, 0, 255)
            dr.polygon([((x - d['gx0']) / PX * S, (z - d['gz0']) / PX * S) for x, z in r['rings'][0]], outline=col)
        p = os.path.join(a.plot, f"airbase_{base['icao']}.png")
        vis.save(p)
        print(base['name'], len(rs), 'structures ->', p)


if __name__ == '__main__':
    main()
