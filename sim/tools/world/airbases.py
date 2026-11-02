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
sim/tools/world/airfields.py when present, +8 m) or where a footprint already exists. The boxes
traced from the imagery are then held clear of the paved areas exactly (Paved): 75 m from a runway
centre line (the graded strip), 7.5 m beyond a taxiway's shoulders, off the aprons; a box reaching
in is cut back from that side, or dropped. buildings.py asserts that none is left.

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


RUNWAY_STRIP = 75.0         # m from a runway centre line (with overruns): no buildings
TAXI_CLEAR = 7.5            # m beyond the outer edge of a taxiway's shoulders
APRON_CLEAR = 1.0           # m: hangars and shelters front onto their aprons


def load_airfields(path):
    if path and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return None


def _seg_dist(px, pz, s):
    """Distance from points (k) to segments (n, [ax, az, bx, bz, ...]): (k, n)."""
    ax, az, bx, bz = s[:, 0], s[:, 1], s[:, 2], s[:, 3]
    dx, dz = bx - ax, bz - az
    L2 = np.maximum(dx * dx + dz * dz, 1e-9)
    t = np.clip(((px[:, None] - ax) * dx + (pz[:, None] - az) * dz) / L2, 0, 1)
    ex, ez = ax + t * dx - px[:, None], az + t * dz - pz[:, None]
    return np.sqrt(ex * ex + ez * ez)


def _inside_convex(px, pz, poly):
    """Points (k) inside a convex polygon (either orientation): bool (k)."""
    e = np.roll(poly, -1, 0) - poly
    c = e[:, 0][None, :] * (pz[:, None] - poly[:, 1]) - e[:, 1][None, :] * (px[:, None] - poly[:, 0])
    return np.all(c >= 0, 1) | np.all(c <= 0, 1)


def _cross(a, b, c, d):
    """Segments a-b (k, 2) and c-d (n, 2) properly crossing: (k, n)."""
    def orient(p, q, r):
        return (q[..., 0] - p[..., 0]) * (r[..., 1] - p[..., 1]) - (q[..., 1] - p[..., 1]) * (r[..., 0] - p[..., 0])
    A, B = a[:, None, :], b[:, None, :]
    C, D = c[None, :, :], d[None, :, :]
    return (orient(A, B, C) * orient(A, B, D) < 0) & (orient(C, D, A) * orient(C, D, B) < 0)


def poly_seg_dist(poly, segs):
    """Distance (m) from a convex polygon to each segment; 0 where they touch or cross."""
    if not len(segs):
        return np.zeros(0)
    d = _seg_dist(poly[:, 0], poly[:, 1], segs).min(0)
    e = np.stack([poly[:, 0], poly[:, 1], np.roll(poly[:, 0], -1), np.roll(poly[:, 1], -1)], 1)
    ends = np.vstack([segs[:, 0:2], segs[:, 2:4]])
    d2 = _seg_dist(ends[:, 0], ends[:, 1], e).min(1).reshape(2, -1).min(0)
    d = np.minimum(d, d2)
    inside = _inside_convex(segs[:, 0], segs[:, 1], poly) | _inside_convex(segs[:, 2], segs[:, 3], poly)
    crosses = _cross(e[:, 0:2], e[:, 2:4], segs[:, 0:2], segs[:, 2:4]).any(0)
    return np.where(inside | crosses, 0.0, d)


class Paved:
    """Runway strips, taxiways and aprons as segments and triangles with their clearances."""

    def __init__(self, airports, airfields):
        segs = []                                   # ax, az, bx, bz, clearance
        for ap in airports:
            for rw in ap['runways']:
                a, b = rw['ends']
                dx, dz = b['x'] - a['x'], b['z'] - a['z']
                L = math.hypot(dx, dz)
                ux, uz = dx / L, dz / L
                # the strip runs 60 m past the overruns (ICAO Annex 14)
                o0, o1 = (a.get('overrun_m') or 0) + 60, (b.get('overrun_m') or 0) + 60
                segs.append((a['x'] - ux * o0, a['z'] - uz * o0, b['x'] + ux * o1, b['z'] + uz * o1, RUNWAY_STRIP))
        tris = []
        if airfields:
            O = -grid.CORE_HALF
            for key, t in airfields.get('tiles', {}).items():
                tx, tz = (int(v) for v in key.split(','))
                bx, bz = O + tx * grid.TILE_SIZE, O + tz * grid.TILE_SIZE
                for tw in t.get('taxiways', []):
                    p = np.asarray(tw['pts'], np.float64).reshape(-1, 2) + (bx, bz)
                    c = tw.get('cw', 20) / 2 + max(tw.get('left', 0), tw.get('right', 0)) + TAXI_CLEAR
                    for q0, q1 in zip(p[:-1], p[1:]):
                        segs.append((q0[0], q0[1], q1[0], q1[1], c))
                for apn in t.get('aprons', []):
                    p = np.asarray(apn['tris'], np.float64).reshape(-1, 3, 2) + (bx, bz)
                    tris.append(p)
        self.segs = np.asarray(segs, np.float64).reshape(-1, 5)
        self.tris = np.concatenate(tris) if tris else np.zeros((0, 3, 2))
        self.tri_edges = np.concatenate([np.concatenate([self.tris[:, k], self.tris[:, (k + 1) % 3]], 1)
                                         for k in range(3)]) if len(self.tris) else np.zeros((0, 4))
        self.tri_of_edge = np.tile(np.arange(len(self.tris)), 3)

    def depth(self, poly):
        """How far (m) a convex polygon reaches into the clearances (<= 0: clear) and what it hits."""
        poly = np.asarray(poly, np.float64)
        (x0, z0), (x1, z1) = poly.min(0), poly.max(0)
        worst, what = -1e9, ''
        s = self.segs
        m = ((np.minimum(s[:, 0], s[:, 2]) - s[:, 4] < x1) & (np.maximum(s[:, 0], s[:, 2]) + s[:, 4] > x0)
             & (np.minimum(s[:, 1], s[:, 3]) - s[:, 4] < z1) & (np.maximum(s[:, 1], s[:, 3]) + s[:, 4] > z0))
        if m.any():
            d = s[m, 4] - poly_seg_dist(poly, s[m])
            k = int(np.argmax(d))
            worst, what = float(d[k]), ('runway strip' if s[m][k, 4] == RUNWAY_STRIP else 'taxiway')
        if len(self.tris):
            t = self.tris
            mt = ((t[:, :, 0].min(1) - APRON_CLEAR < x1) & (t[:, :, 0].max(1) + APRON_CLEAR > x0)
                  & (t[:, :, 1].min(1) - APRON_CLEAR < z1) & (t[:, :, 1].max(1) + APRON_CLEAR > z0))
            if mt.any():
                em = mt[self.tri_of_edge]
                d = APRON_CLEAR - poly_seg_dist(poly, self.tri_edges[em]).min()
                # a box wholly inside a triangle touches no edge: test its corners too
                for tri in t[mt]:
                    if _inside_convex(poly[:, 0], poly[:, 1], tri).any():
                        d = max(d, APRON_CLEAR + 1.0)
                if d > worst:
                    worst, what = float(d), 'apron'
        return worst, what


def _clear_box(b, paved):
    """The largest box (one side cut back, or all shrunk) clear of the paved areas, or None."""
    def corners(x, z, ha, hb, yaw):
        return np.asarray(_rect(x, z, ha, hb, yaw))
    if paved.depth(corners(b['x'], b['z'], b['ha'], b['hb'], b['yaw']))[0] <= 0:
        return b
    ua = (math.cos(b['yaw']), math.sin(b['yaw']))
    ub = (-math.sin(b['yaw']), math.cos(b['yaw']))
    best = None
    for f in np.arange(0.05, 0.75, 0.05):
        for axis, sign in (('a', 1), ('a', -1), ('b', 1), ('b', -1), ('ab', 0)):
            ha, hb, x, z = b['ha'], b['hb'], b['x'], b['z']
            if axis == 'ab':
                ha, hb = ha * (1 - f) ** 0.5, hb * (1 - f) ** 0.5
            elif axis == 'a':
                cut = f * 2 * ha
                ha -= cut / 2
                x, z = x - sign * ua[0] * cut / 2, z - sign * ua[1] * cut / 2
            else:
                cut = f * 2 * hb
                hb -= cut / 2
                x, z = x - sign * ub[0] * cut / 2, z - sign * ub[1] * cut / 2
            if paved.depth(corners(x, z, ha, hb, b['yaw']))[0] > 0:
                continue
            area = 4 * ha * hb
            if best is None or area > best['area']:
                best = dict(b, x=x, z=z, ha=max(ha, hb), hb=min(ha, hb), area=area,
                            yaw=b['yaw'] if ha >= hb else (b['yaw'] + math.pi / 2) % math.pi)
        if best is not None:
            break
    if best is None or best['area'] < 110 or best['hb'] < 3.5:
        return None
    return best


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

    # exactly clear of the runway strips, taxiways and aprons (the raster above is a first pass)
    paved = Paved(airports, airfields)
    cleared = [_clear_box(b, paved) for b in boxes]
    n_cut = sum(1 for b, c in zip(boxes, cleared) if c is not b)
    boxes = [c for c in cleared if c is not None]

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
            cls, h, wall = 'hangar', 9.0 + 5.0 * u2, None                       # hall: maintenance hangar
        elif A >= 700:
            cls, h = 'military', 6.5 + 4.0 * u2                                 # 2-3 floors
        elif A >= 150:
            cls, h = 'military', 4.0 + 4.0 * u2                                 # 1-2 floors
        else:
            cls, h = 'military', 3.2 + 1.2 * u2                                 # huts, guard posts
        out.append(_record(f"airbase:{base['icao']}:{i}", None, _rect(b['x'], b['z'], b['ha'], b['hb'], b['yaw']),
                           cls, h, wall, roof_shape=shape))
    dbg = dict(crop=crop, gx0=gx0, gz0=gz0, inside=inside, excl=excl, boxes=boxes, cut=n_cut)
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
        rs, d = detect(base, terrain, recs, airports, airfields)
        log(f"airbases: {base['name']}: {len(rs)} structures ({d['cut']} cut back or dropped clear of paving)")
        out += rs
    return out


_PAVED = {}


def _paved(terrain, airfields_path):
    k = (terrain, airfields_path)
    if k not in _PAVED:
        with open(os.path.join(terrain, 'airports.json')) as f:
            airports = json.load(f)
        _PAVED[k] = Paved(airports, load_airfields(airfields_path))
    return _PAVED[k]


def intrusions(recs, terrain, airfields_path):
    """(id, depth m, what) of every record reaching into a runway strip, taxiway or apron."""
    paved = _paved(terrain, airfields_path)
    out = []
    for r in recs:
        d, what = paved.depth(r['rings'][0])
        if d > 0.05:
            out.append((r['id'], round(d, 1), what))
    return out


HANGAR = 12                  # buildings.WALL['hangar']
ROUND = 6                    # buildings.SHAPE['round']: a vault, its doors in an end wall
DOOR_NEG, DOOR_END = 16, 32  # hangar style flags: door on the - side; door in an end (a) wall, not a long (b) side


def hangar_doors(recs, terrain, airfields_path, log=print):
    """Which wall of each hangar holds the doors: the one facing the nearest apron or taxiway
    (style flags DOOR_NEG / DOOR_END, read by the facade shader)."""
    paved = _paved(terrain, airfields_path)
    segs = paved.segs[paved.segs[:, 4] != RUNWAY_STRIP]
    pts = np.vstack([segs[:, 0:2], segs[:, 2:4], 0.5 * (segs[:, 0:2] + segs[:, 2:4]),
                     paved.tris.mean(1) if len(paved.tris) else np.zeros((0, 2))])
    n = 0
    for r in recs:
        if (r['style'] & 15) != HANGAR:
            continue
        cx, cz, ha, hb, yaw = r['obb']
        end = r['shape'] == ROUND
        ax = (math.cos(yaw), math.sin(yaw)) if end else (-math.sin(yaw), math.cos(yaw))
        sign = 1.0
        if len(pts):
            d2 = (pts[:, 0] - cx) ** 2 + (pts[:, 1] - cz) ** 2
            k = int(np.argmin(d2))
            if d2[k] < 400.0 ** 2:
                sign = 1.0 if (pts[k, 0] - cx) * ax[0] + (pts[k, 1] - cz) * ax[1] >= 0 else -1.0
                n += 1
        r['style'] = (r['style'] & ~(DOOR_NEG | DOOR_END)) | (DOOR_END if end else 0) | (DOOR_NEG if sign < 0 else 0)
    log(f'hangars: doors of {n} turned towards their apron or taxiway')


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
