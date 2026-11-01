#!/usr/bin/env python3
"""Build data/world/buildings/ for the F-35I flight sim: 3D buildings of the 102.4 km core from
Overture Maps (OpenStreetMap and Microsoft ML footprints), see README.md in this folder.

    python3 sim/tools/world/buildings.py [--cache DIR] [--out sim/data/world/buildings]
                                         [--terrain sim/data/terrain] [--stages fetch,tiles]

Stages:
    fetch   Overture buildings/building and buildings/building_part inside the core (network, ~1 min,
            ~0.6 GB read, ~100 MB cached; overture.py)
    tiles   footprints -> world frame (grid.py), cleaned, simplified (0.5 m) and filtered (runways,
            sea, Dead Sea, slivers, underground); ground height under each footprint from the
            terrain's height tiles (exactly as HeightField.heightAt); roof colour from the L0
            imagery; heights from the tags, tagged neighbours and context; wall style, palette and
            roof shape by region and class; written as one binary per terrain tile + index.json.

The binary format is documented in README.md and read by sim/js/world/BuildingsWorker.js.
"""
import argparse
import collections
import gzip
import json
import math
import os
import struct
import sys
import time
import zlib

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', 'terrain')))

import grid  # noqa: E402
import geom  # noqa: E402
import overture  # noqa: E402

COLUMNS = ['id', 'geometry', 'bbox', 'names', 'sources', 'level', 'height', 'min_height', 'is_underground',
           'num_floors', 'num_floors_underground', 'min_floor', 'subtype', 'class', 'facade_color',
           'facade_material', 'roof_material', 'roof_shape', 'roof_direction', 'roof_orientation',
           'roof_color', 'roof_height', 'has_parts']
PART_COLUMNS = COLUMNS[:-1] + ['building_id']

# ---- tiles (aligned with the terrain's L0 tiles, sim/DESIGN.md) ----------------------------------
TILE = grid.TILE_SIZE                  # 6400 m
NT = grid.NTILES                       # 16 x 16
CHUNKS = 8                             # 8 x 8 chunks of 800 m per tile (the runtime's detail unit)
CHUNK = TILE / CHUNKS
QUANT = 0.125                          # m per unit of the quantised x / z (uint16)
MARGIN = 896.0                         # quantised range: tile edge - 896 m .. + 7296 m (65536 units)
MAGIC = b'F35B'
VERSION = 1

# ---- styles shared with sim/js/world (buildingShaders.js) ----------------------------------------
WALL = dict(plaster=0, stone=1, glass=2, office=3, industrial=4, house=5, greenhouse=6, concrete=7,
            public=8, tower=9, oldstone=10)
WALL_FLAG_PILOTIS = 16                 # ground floor on columns (open, in shadow)
WALL_FLAG_SHOPS = 32                   # shop windows on the ground floor
WALL_FLAG_BALCONY = 64                 # balconies on the upper floors
ROOF = dict(flat_res=0, flat=1, industrial=2, tiles=3, metal=4, greenhouse=5, dome=6, concrete=7, solar=8)
SHAPE = dict(flat=0, gabled=1, hipped=2, pyramidal=3, skillion=4, dome=5, round=6)
SHAPE_TAGS = {'flat': 'flat', 'gabled': 'gabled', 'hipped': 'hipped', 'pyramidal': 'pyramidal',
              'skillion': 'skillion', 'dome': 'dome', 'onion': 'dome', 'round': 'round', 'saltbox': 'gabled',
              'gambrel': 'gabled', 'mansard': 'hipped', 'half-hipped': 'hipped', 'half_hipped': 'hipped',
              'sawtooth': 'flat', 'cone': 'pyramidal', 'quadruple_saltbox': 'hipped'}

# OSM building classes -> (kind, default floors, floor height m)
KIND = {
    'house': 'house', 'detached': 'house', 'semidetached_house': 'house', 'bungalow': 'house', 'cabin': 'house',
    'farm': 'house', 'terrace': 'house', 'villa': 'house', 'hut': 'shed', 'static_caravan': 'shed',
    'apartments': 'apartments', 'residential': 'apartments', 'dormitory': 'apartments', 'hotel': 'apartments',
    'garage': 'shed', 'garages': 'shed', 'shed': 'shed', 'carport': 'roof', 'kiosk': 'shed', 'toilets': 'shed',
    'service': 'shed', 'transformer_tower': 'shed', 'outbuilding': 'shed', 'boathouse': 'shed', 'guardhouse': 'shed',
    'roof': 'roof', 'industrial': 'industrial', 'warehouse': 'industrial', 'manufacture': 'industrial',
    'factory': 'industrial', 'storage_tank': 'tank', 'silo': 'tank', 'hangar': 'hangar', 'greenhouse': 'greenhouse',
    'retail': 'commercial', 'commercial': 'commercial', 'supermarket': 'commercial', 'office': 'office',
    'school': 'school', 'kindergarten': 'kindergarten', 'college': 'school', 'university': 'school',
    'hospital': 'hospital', 'synagogue': 'religious', 'mosque': 'religious', 'church': 'religious',
    'chapel': 'religious', 'cathedral': 'religious', 'religious': 'religious', 'monastery': 'religious',
    'temple': 'religious', 'shrine': 'religious', 'public': 'public', 'civic': 'public', 'government': 'public',
    'fire_station': 'public', 'police': 'public', 'train_station': 'public', 'transportation': 'public',
    'shelter': 'shelter', 'bunker': 'shelter', 'military': 'military', 'barn': 'farm', 'cowshed': 'farm',
    'stable': 'farm', 'farm_auxiliary': 'farm', 'sty': 'farm', 'chicken_coop': 'farm', 'parking': 'parking',
    'stadium': 'stadium', 'grandstand': 'stadium', 'sports_hall': 'stadium', 'sports_centre': 'stadium',
    'pavilion': 'shed', 'bridge': 'roof', 'tower': 'tower', 'water_tower': 'tower', 'stilt_house': 'house',
}

# named places (lon, lat, radius km): settlement character the footprints alone do not tell
REGIONS = {
    'tlv_center': (34.774, 32.074, 3.0),      # the White City and the centre: white plaster, 3-5 floors
    'gush_dan': (34.800, 32.065, 9.5),        # Tel Aviv, Ramat Gan, Givatayim, Bnei Brak, Holon, Bat Yam
    'bnei_brak': (34.834, 32.084, 1.8),       # dense 5-8 floor blocks
    'jaffa_old': (34.7525, 32.0545, 0.45),    # old Jaffa: stone, 2-3 floors
    'jerusalem': (35.205, 31.780, 7.5),       # the stone law: facades of Jerusalem stone
    'jlm_old_city': (35.2320, 31.7770, 0.62),  # the Old City: stone, 2-3 floors, domes
    'ramallah': (35.205, 31.905, 3.5),
    'bethlehem': (35.205, 31.705, 3.0),
    'hebron': (35.100, 31.530, 4.0),
    'modiin': (35.010, 31.900, 4.0),          # stone-clad apartment blocks
    'beit_shemesh': (34.990, 31.735, 3.5),
}


def log(*a):
    print('  [buildings]', *a, flush=True)


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, np.float64) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def hash_u32(x):
    """Integer hash (lowbias32) of a uint32 array."""
    x = np.asarray(x, np.uint64) & 0xFFFFFFFF
    x ^= x >> 16
    x = (x * 0x7FEB352D) & 0xFFFFFFFF
    x ^= x >> 15
    x = (x * 0x846CA68B) & 0xFFFFFFFF
    x ^= x >> 16
    return x


def rand01(seed, k):
    """k-th uniform random number in [0, 1) per element of the uint32 seed array."""
    return hash_u32(np.asarray(seed, np.uint64) * 2654435761 + k * 40503 + 7).astype(np.float64) / 4294967296.0


def hex_rgb(s):
    try:
        s = s.strip().lstrip('#')
        if len(s) == 3:
            s = ''.join(c * 2 for c in s)
        v = int(s[:6], 16)
        return ((v >> 16) & 255, (v >> 8) & 255, v & 255)
    except (ValueError, AttributeError):
        return None


# ---- terrain data (read only) -------------------------------------------------------------------

class Ground:
    """Core heights exactly as js/terrain/HeightField.js: 25 m grid, cells split along NW-SE."""

    def __init__(self, terrain):
        n = grid.NTILES * (grid.H_TILE_N - 1) + 1
        core = np.zeros((n, n), np.uint16)
        for iz in range(grid.NTILES):
            for ix in range(grid.NTILES):
                a = np.fromfile(os.path.join(terrain, 'height', f'tile_{ix}_{iz}.bin'), '<u2').reshape(257, 257)
                core[iz * 256: iz * 256 + 257, ix * 256: ix * 256 + 257] = a
        self.h = core.astype(np.float64) * grid.H_ENC_SCALE + grid.H_ENC_OFFSET
        self.n = n

    def at(self, x, z):
        h = self.h
        gx = (np.asarray(x, np.float64) + grid.CORE_HALF) / grid.H_STEP
        gz = (np.asarray(z, np.float64) + grid.CORE_HALF) / grid.H_STEP
        gx = np.clip(gx, 0, self.n - 1)
        gz = np.clip(gz, 0, self.n - 1)
        i = np.minimum(np.floor(gx).astype(np.int64), self.n - 2)
        j = np.minimum(np.floor(gz).astype(np.int64), self.n - 2)
        fx, fz = gx - i, gz - j
        ha, hd = h[j, i], h[j + 1, i + 1]
        hb, hc = h[j, i + 1], h[j + 1, i]
        up = fx >= fz
        return np.where(up, ha + fx * (hb - ha) + fz * (hd - hb), ha + fz * (hc - ha) + fx * (hd - hc))


class TileImages:
    """L0 colour (6.25 m / px) and land cover (10 m / px) of one terrain tile."""

    def __init__(self, terrain):
        self.terrain = terrain

    def color(self, ix, iz):
        return np.asarray(Image.open(os.path.join(self.terrain, 'color', 'L0', f'tile_{ix}_{iz}.jpg')).convert('RGB'))

    def landcover(self, ix, iz):
        return np.asarray(Image.open(os.path.join(self.terrain, 'landcover', f'tile_{ix}_{iz}.png')))


# ---- load and project ---------------------------------------------------------------------------

def dataset_of(sources):
    """The data set of the geometry (first source with property '' or geometry)."""
    if not sources:
        return 'unknown', 'unknown'
    geo = [e for e in sources if e.get('property') in (None, '', 'geometry')]
    e = geo[0] if geo else sources[0]
    return e.get('dataset') or 'unknown', e.get('license') or 'unknown'


def load_footprints(table, is_part=False):
    """One record per polygon (a MultiPolygon gives several): attributes + rings (lon / lat)."""
    d = table.to_pydict()
    n = table.num_rows
    for c in PART_COLUMNS + COLUMNS:             # columns a type does not have (parts: class, subtype)
        if c not in d:
            d[c] = [None] * n
    recs = []
    for i in range(n):
        polys = geom.wkb_polygons(d['geometry'][i])
        if not polys:
            continue
        ds, lic = dataset_of(d['sources'][i])
        nm = d['names'][i]
        base = dict(
            id=d['id'][i], name=(nm or {}).get('primary') if nm else None, dataset=ds, license=lic,
            level=d['level'][i], height=d['height'][i], min_height=d['min_height'][i],
            underground=bool(d['is_underground'][i]), floors=d['num_floors'][i], min_floor=d['min_floor'][i],
            subtype=d['subtype'][i], cls=d['class'][i], facade_color=d['facade_color'][i],
            facade_material=d['facade_material'][i], roof_material=d['roof_material'][i],
            roof_shape=d['roof_shape'][i], roof_direction=d['roof_direction'][i], roof_color=d['roof_color'][i],
            roof_height=d['roof_height'][i], has_parts=bool(d['has_parts'][i]) if 'has_parts' in d else False,
            building_id=d['building_id'][i] if is_part else None, part=is_part,
        )
        for rings in polys:
            r = dict(base)
            r['rings_ll'] = rings
            recs.append(r)
    return recs


def project(recs):
    """lon / lat rings -> world X / Z rings, all at once (pyproj is fast on big arrays)."""
    sizes = [len(r) for rec in recs for r in rec['rings_ll']]
    allp = np.concatenate([r for rec in recs for r in rec['rings_ll']])
    x, z = grid.lonlat_to_xz(allp[:, 0], allp[:, 1])
    xz = np.stack([np.asarray(x), np.asarray(z)], 1)
    k = 0
    for rec in recs:
        out = []
        for r in rec['rings_ll']:
            out.append(xz[k:k + len(r)])
            k += len(r)
        rec['rings'] = out
        del rec['rings_ll']
    assert k == sum(sizes)


def clean(rec):
    """Clean / simplify the rings, orient them (outer A < 0, holes A > 0); False if degenerate."""
    rings = []
    for j, r in enumerate(rec['rings']):
        c = geom.clean_ring(np.ascontiguousarray(r, np.float64), tol=0.5)
        if c is None:
            if j == 0:
                return False
            continue
        a = geom.signed_area(c)
        if j == 0:
            if a > 0:
                c = c[::-1].copy()
        else:
            if a < 0:
                c = c[::-1].copy()
            if abs(a) < 4.0:      # tiny courtyards / light wells: not worth a hole
                continue
        rings.append(c)
    if len(rings[0]) > 1500:
        return False
    rec['rings'] = rings
    outer = abs(geom.signed_area(rings[0]))
    holes = sum(abs(geom.signed_area(h)) for h in rings[1:])
    rec['area'] = outer - holes
    rec['cx'], rec['cz'] = geom.centroid(rings[0])
    rec['obb'] = geom.obb(rings[0])
    rec['perimeter'] = float(np.hypot(*(np.roll(rings[0], -1, 0) - rings[0]).T).sum())
    return True


# ---- filters ------------------------------------------------------------------------------------

def runway_boxes(terrain):
    """Runway rectangles (with overruns and 15 m shoulders): centre, unit dir, half length, half width."""
    with open(os.path.join(terrain, 'airports.json')) as f:
        aps = json.load(f)
    out = []
    for ap in aps:
        for rw in ap['runways']:
            a, b = rw['ends']
            dx, dz = b['x'] - a['x'], b['z'] - a['z']
            L = math.hypot(dx, dz)
            ux, uz = dx / L, dz / L
            o0, o1 = a.get('overrun_m', 0) or 0, b.get('overrun_m', 0) or 0
            # centre of the paved length including the overruns
            s0, s1 = -o0, L + o1
            cx, cz = a['x'] + ux * 0.5 * (s0 + s1), a['z'] + uz * 0.5 * (s0 + s1)
            out.append((cx, cz, ux, uz, 0.5 * (s1 - s0) + 10.0, 0.5 * rw['width_m'] + 15.0, ap['icao']))
    return out


def on_runway(rec, boxes):
    pts = np.vstack([rec['rings'][0], [[rec['cx'], rec['cz']]]])
    for cx, cz, ux, uz, hl, hw, _ in boxes:
        s = (pts[:, 0] - cx) * ux + (pts[:, 1] - cz) * uz
        t = -(pts[:, 0] - cx) * uz + (pts[:, 1] - cz) * ux
        if np.any((np.abs(s) < hl) & (np.abs(t) < hw)):
            return True
    return False


# ---- per-tile rasters: imagery colour, land cover, ground ---------------------------------------

def sample_tile_rasters(recs, idx, ix, iz, imgs, ground):
    """Imagery colour under each footprint, land cover at its centroid, ground min / max / mean."""
    x0, z0 = grid.tile_origin(ix, iz)
    col = imgs.color(ix, iz).astype(np.float32)
    lc = imgs.landcover(ix, iz)
    n = col.shape[0]
    px = TILE / n
    # label image: footprint polygons drawn with their index (pixels whose centre is inside)
    lab = Image.new('I', (n, n), 0)
    dr = ImageDraw.Draw(lab)
    for k, i in enumerate(idx):
        r = recs[i]['rings'][0]
        poly = [((p[0] - x0) / px - 0.5, (p[1] - z0) / px - 0.5) for p in r]
        if len(poly) >= 3:
            dr.polygon(poly, fill=k + 1)
    la = np.asarray(lab, np.int64).ravel()
    m = la > 0
    cnt = np.bincount(la[m], minlength=len(idx) + 1)
    sums = [np.bincount(la[m], weights=col.reshape(-1, 3)[m, c], minlength=len(idx) + 1) for c in range(3)]
    for k, i in enumerate(idx):
        rec = recs[i]
        if cnt[k + 1] > 0:
            rgb = [sums[c][k + 1] / cnt[k + 1] for c in range(3)]
            rec['img_px'] = int(cnt[k + 1])
        else:   # smaller than a pixel: bilinear at the centroid
            u = np.clip((rec['cx'] - x0) / px - 0.5, 0, n - 1.001)
            v = np.clip((rec['cz'] - z0) / px - 0.5, 0, n - 1.001)
            i0, j0 = int(u), int(v)
            fu, fv = u - i0, v - j0
            c = (col[j0, i0] * (1 - fu) * (1 - fv) + col[j0, i0 + 1] * fu * (1 - fv)
                 + col[j0 + 1, i0] * (1 - fu) * fv + col[j0 + 1, i0 + 1] * fu * fv)
            rgb = [float(c[0]), float(c[1]), float(c[2])]
            rec['img_px'] = 0
        rec['img'] = rgb
        li = int(np.clip((rec['cx'] - x0) / (TILE / lc.shape[1]), 0, lc.shape[1] - 1))
        lj = int(np.clip((rec['cz'] - z0) / (TILE / lc.shape[0]), 0, lc.shape[0] - 1))
        rec['lc'] = int(lc[lj, li])
    # ground under each footprint: vertices, centroid and a 12.5 m grid inside larger footprints
    pxs, pzs, owner = [], [], []
    for k, i in enumerate(idx):
        rec = recs[i]
        r = rec['rings'][0]
        pxs.append(r[:, 0]); pzs.append(r[:, 1]); owner.append(np.full(len(r), k))
        pxs.append(np.array([rec['cx']])); pzs.append(np.array([rec['cz']])); owner.append(np.array([k]))
        if rec['area'] > 300:
            mn, mx = r.min(0), r.max(0)
            gx, gz = np.meshgrid(np.arange(mn[0] + 6.25, mx[0], 12.5), np.arange(mn[1] + 6.25, mx[1], 12.5))
            gx, gz = gx.ravel(), gz.ravel()
            if gx.size:
                ins = geom.points_in_ring(gx, gz, r)
                pxs.append(gx[ins]); pzs.append(gz[ins]); owner.append(np.full(int(ins.sum()), k))
    pxs, pzs, owner = np.concatenate(pxs), np.concatenate(pzs), np.concatenate(owner)
    h = ground.at(pxs, pzs)
    gmin = np.full(len(idx), np.inf); gmax = np.full(len(idx), -np.inf)
    np.minimum.at(gmin, owner, h)
    np.maximum.at(gmax, owner, h)
    gsum = np.bincount(owner, weights=h, minlength=len(idx))
    gcnt = np.bincount(owner, minlength=len(idx))
    for k, i in enumerate(idx):
        recs[i]['gmin'] = float(gmin[k])
        recs[i]['gmax'] = float(gmax[k])
        recs[i]['gmean'] = float(gsum[k] / max(1, gcnt[k]))


# ---- context ------------------------------------------------------------------------------------

def box_blur(a, r):
    """Mean over a (2r+1)^2 window (edges: mean of what is inside)."""
    k = 2 * r + 1
    pad = np.pad(a, r, mode='constant')
    one = np.pad(np.ones_like(a), r, mode='constant')
    c = np.cumsum(np.cumsum(pad, 0), 1)
    c1 = np.cumsum(np.cumsum(one, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0)))
    c1 = np.pad(c1, ((1, 0), (1, 0)))
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    s1 = c1[k:, k:] - c1[:-k, k:] - c1[k:, :-k] + c1[:-k, :-k]
    return s / np.maximum(s1, 1)


def region_weight(lon, lat, name):
    """1 inside a named region, falling to 0 over its outer quarter."""
    clon, clat, rkm = REGIONS[name]
    dx = (lon - clon) * 111.32 * math.cos(math.radians(clat))
    dy = (lat - clat) * 110.57
    d = np.hypot(dx, dy)
    return 1.0 - smoothstep(0.75 * rkm, rkm, d)


# ---- the main estimate --------------------------------------------------------------------------

def estimate(recs):
    """Heights, roof shapes, styles and colours for every footprint (vectorised)."""
    N = len(recs)
    A = np.array([r['area'] for r in recs])
    cx = np.array([r['cx'] for r in recs]); cz = np.array([r['cz'] for r in recs])
    ha = np.array([r['obb'][2] for r in recs]); hb = np.array([r['obb'][3] for r in recs])
    seed = np.array([zlib.crc32(r['id'].encode()) for r in recs], np.uint64)
    R = lambda k: rand01(seed, k)  # noqa: E731
    kind = np.array([KIND.get(r['cls'] or '', '') for r in recs], object)
    sub = np.array([r['subtype'] or '' for r in recs], object)
    ml = np.array([r['dataset'].startswith('Microsoft') for r in recs])
    lon, lat = grid.xz_to_lonlat(cx, cz)
    lon, lat = np.asarray(lon), np.asarray(lat)
    img = np.array([r['img'] for r in recs]) / 255.0
    lc = np.array([r['lc'] for r in recs])
    gmin = np.array([r['gmin'] for r in recs]); gmax = np.array([r['gmax'] for r in recs])

    # coverage: building footprint share of the land in 100 m cells, averaged over ~300 m
    cell = 100.0
    nC = int(2 * grid.CORE_HALF / cell)
    ci = np.clip(((cx + grid.CORE_HALF) / cell).astype(int), 0, nC - 1)
    cj = np.clip(((cz + grid.CORE_HALF) / cell).astype(int), 0, nC - 1)
    cov = np.zeros((nC, nC)); np.add.at(cov, (cj, ci), A)
    cov = box_blur(cov / (cell * cell), 1)
    c = np.clip(cov[cj, ci], 0, 0.8)
    cnt = np.zeros((nC, nC)); np.add.at(cnt, (cj, ci), 1)
    cnt = box_blur(cnt, 2)
    dens = cnt[cj, ci]                       # buildings per hectare (~500 m window)

    # tagged floors of the neighbours (200 m cells, ~1 km window), towers excluded from the median
    fl = np.array([r['floors'] if r['floors'] is not None else (r['height'] / 3.2 if r['height'] else np.nan) for r in recs], np.float64)
    tagged = np.isfinite(fl) & (fl >= 1) & (fl <= 22)
    tc = 200.0
    nT = int(2 * grid.CORE_HALF / tc)
    ti = np.clip(((cx + grid.CORE_HALF) / tc).astype(int), 0, nT - 1)
    tj = np.clip(((cz + grid.CORE_HALF) / tc).astype(int), 0, nT - 1)
    fsum = np.zeros((nT, nT)); fn = np.zeros((nT, nT)); asum = np.zeros((nT, nT))
    np.add.at(fsum, (tj[tagged], ti[tagged]), fl[tagged])
    np.add.at(fn, (tj[tagged], ti[tagged]), 1)
    np.add.at(asum, (tj[tagged], ti[tagged]), np.log(np.maximum(A[tagged], 10)))
    fs, fnn, las = box_blur(fsum, 2) * 25, box_blur(fn, 2) * 25, box_blur(asum, 2) * 25
    nb_n = fnn[tj, ti]
    nb_floors = fs[tj, ti] / np.maximum(nb_n, 1)
    nb_area = np.exp(las[tj, ti] / np.maximum(nb_n, 1))

    # region weights
    W = {k: region_weight(lon, lat, k) for k in REGIONS}
    hills = smoothstep(150.0, 520.0, gmin)                 # Judean / Samarian hills
    urban = smoothstep(0.10, 0.24, c)                       # town fabric
    stone_p = np.maximum.reduce([0.95 * W['jerusalem'], 0.9 * W['jlm_old_city'], 0.85 * W['jaffa_old'],
                                 0.8 * W['ramallah'], 0.85 * W['bethlehem'], 0.75 * W['hebron'],
                                 0.75 * W['modiin'], 0.7 * W['beit_shemesh'], 0.15 + 0.65 * hills])

    # ---- floors by rules (used where nothing is tagged) ----
    f_urban = np.select([A < 45, A < 110, A < 220, A < 450, A < 1100], [1, 2, 3, 4.5, 6], 4)
    f_sub = np.select([A < 45, A < 260, A < 600], [1, 1.6, 2.6], 1)
    f_rule = f_sub + (f_urban - f_sub) * urban
    f_rule = f_rule * (1 + 0.25 * W['gush_dan'] * urban) + 2.0 * W['bnei_brak'] * urban * (A > 150)
    f_rule = f_rule + 1.2 * W['jerusalem'] * urban * (A > 200) + 1.0 * W['ramallah'] * (A > 150)
    f_rule = np.where(W['jaffa_old'] + W['jlm_old_city'] > 0.5, np.minimum(f_rule, 3), f_rule)
    # tagged neighbours: their median floors, scaled a little by footprint size
    scale = np.clip((A / np.maximum(nb_area, 20)) ** 0.25, 0.6, 1.5)
    f_nb = np.clip(nb_floors * scale, 1, 14)
    w_nb = smoothstep(3, 12, nb_n) * (A > 40)
    floors = f_rule * (1 - w_nb) + f_nb * w_nb
    floors = floors * (0.8 + 0.4 * R(1))                   # +-20 % jitter
    floors = np.maximum(1, np.round(floors))

    # ---- kinds for untagged footprints ----
    bright = img.mean(1)
    sat = img.max(1) - img.min(1)
    reddish = (img[:, 0] - img[:, 2] > 0.10) & (img[:, 0] > img[:, 1] * 1.08)
    elong = ha / np.maximum(hb, 0.5)
    rural = c < 0.10
    green_house = (kind == '') & rural & (A > 250) & (bright > 0.60) & (sat < 0.16) & np.isin(lc, [40, 30, 60, 20, 50]) \
        & ((elong > 1.6) | (A > 1500))
    kind = np.where(green_house, 'greenhouse', kind)
    big_low = (kind == '') & ((A > 2500) | ((A > 700) & rural))
    kind = np.where(big_low, 'industrial', kind)
    small = (kind == '') & (A < 30)
    kind = np.where(small, 'shed', kind)
    houses = (kind == '') & (A < 260) & (c < 0.20) & (floors <= 2)
    kind = np.where(houses, 'house', kind)
    kind = np.where(kind == '', 'apartments', kind)
    kind = np.where((sub == 'military') & (kind == 'apartments'), 'military', kind)

    # ---- heights (m above the ground): tags first ----
    floor_h = np.select([kind == 'office', kind == 'commercial', kind == 'school', kind == 'hospital', kind == 'public',
                         kind == 'religious', kind == 'industrial', kind == 'hangar', kind == 'farm', kind == 'greenhouse',
                         kind == 'stadium', kind == 'parking'],
                        [3.7, 4.2, 3.6, 3.8, 3.8, 5.0, 5.0, 6.0, 4.0, 4.6, 5.0, 2.9], 3.05)
    est = floors * floor_h + 1.0
    kind_h = np.select([kind == 'shed', kind == 'roof', kind == 'greenhouse', kind == 'industrial', kind == 'hangar',
                        kind == 'farm', kind == 'tank', kind == 'shelter', kind == 'kindergarten', kind == 'religious',
                        kind == 'stadium', kind == 'house', kind == 'military'],
                       [2.8 + 0.6 * R(2), 4.5, 4.2 + 0.8 * R(2), 7.5 + 5 * R(2), 11 + 4 * R(2), 5.5 + 2 * R(2),
                        8 + 6 * R(2), 2.6, 4.2, 9 + 5 * R(2), 14 + 6 * R(2), np.minimum(est, 3.1 * np.clip(floors, 1, 2) + 0.6),
                        4 + 3 * R(2)], est)
    tagged_h = np.array([r['height'] if (r['height'] or 0) > 1.5 else np.nan for r in recs])
    tagged_f = np.array([r['floors'] if (r['floors'] or 0) >= 1 else np.nan for r in recs], np.float64)
    roof_h_tag = np.array([r['roof_height'] if (r['roof_height'] or 0) > 0 else np.nan for r in recs], np.float64)
    height = np.where(np.isfinite(tagged_h), tagged_h,
                      np.where(np.isfinite(tagged_f), tagged_f * floor_h + 1.0 + np.nan_to_num(roof_h_tag), kind_h))
    height = np.clip(height, 2.2, 420.0)
    floors_out = np.where(np.isfinite(tagged_f), tagged_f, np.maximum(1, np.round((height - 1.0) / floor_h)))
    min_h = np.array([max(0.0, r['min_height'] or 0.0) if r['min_height'] else
                      (max(0.0, (r['min_floor'] or 0) * 3.05) if (r['min_floor'] or 0) > 0 else 0.0) for r in recs])
    min_h = np.where(kind == 'roof', np.maximum(min_h, height - 0.6), min_h)
    min_h = np.minimum(min_h, height - 0.4)

    # ---- roof shape ----
    tag_shape = np.array([SHAPE_TAGS.get((r['roof_shape'] or '').lower(), '') for r in recs], object)
    tiles_mat = np.array([(r['roof_material'] or '') == 'roof_tiles' for r in recs])
    pitched_guess = (kind == 'house') & (reddish | (R(3) < 0.12)) & (A < 400)
    shape = np.where(tag_shape != '', tag_shape,
                     np.where(pitched_guess | (tiles_mat & (A < 600)), np.where(R(4) < 0.6, 'hipped', 'gabled'),
                              np.where((kind == 'hangar') & (A > 250), 'round', 'flat')))
    # pitched roofs on huge or very complex footprints are not plausible here: flat instead
    shape = np.where((shape != 'flat') & (shape != 'dome') & (A > 3000) & (kind != 'hangar'), 'flat', shape)
    rise = np.where(shape == 'round', np.clip(hb * 0.45, 1.0, 9.0),
                    np.where(shape == 'dome', np.clip(hb * 0.9, 1.5, 25.0),
                             np.where(shape == 'flat', 0.0, np.clip(hb * np.tan(np.radians(28 + 8 * R(5))), 0.8, 8.0))))
    rise = np.where(np.isfinite(roof_h_tag), np.clip(roof_h_tag, 0, 40), rise)
    rise = np.where(shape == 'flat', 0.0, rise)
    # 'height' is the top of the roof: estimated heights are the walls, so a pitched roof adds its rise
    # (hangar heights are the whole arch already); tagged heights include the roof
    height = np.where(np.isfinite(tagged_h) | (kind == 'hangar'), height, height + rise)
    rise = np.minimum(rise, 0.7 * height)

    # ---- wall style ----
    fm = np.array([(r['facade_material'] or '') for r in recs], object)
    tall = height > 55
    glass_p = np.where(np.isin(kind, ['office', 'commercial']), 0.85, np.where(kind == 'apartments', 0.35, 0.5))
    glass_p = glass_p * (1 - 0.7 * W['jerusalem'])
    st_glass = (fm == 'glass') | (tall & (R(6) < glass_p))
    is_stone = (fm == 'stone') | ((fm == '') & (R(7) < stone_p))
    style = np.select([
        kind == 'greenhouse', kind == 'hangar', np.isin(kind, ['shed', 'tank', 'shelter', 'roof', 'military']),
        st_glass, (W['jaffa_old'] + W['jlm_old_city'] > 0.5),
        kind == 'industrial', kind == 'farm', kind == 'house',
        np.isin(kind, ['school', 'hospital', 'public', 'religious', 'stadium', 'kindergarten']),
        kind == 'office', tall, is_stone],
        [WALL['greenhouse'], WALL['concrete'], WALL['concrete'],
         WALL['glass'], WALL['oldstone'],
         WALL['industrial'], WALL['industrial'], WALL['house'],
         WALL['public'],
         WALL['office'], WALL['tower'], WALL['stone']], WALL['plaster'])
    # stone-clad houses and public buildings keep their style but take the stone palette below
    flags = np.zeros(N, np.int64)
    resid = np.isin(style, [WALL['plaster'], WALL['stone'], WALL['tower']])
    flags |= np.where(resid & (floors_out >= 3) & (R(8) < 0.55), WALL_FLAG_PILOTIS, 0)
    flags |= np.where(resid & (floors_out >= 2) & (R(9) < 0.35 * urban + 0.1), WALL_FLAG_SHOPS, 0)
    flags &= ~np.where((flags & WALL_FLAG_PILOTIS) & (flags & WALL_FLAG_SHOPS) & (R(10) < 0.5), WALL_FLAG_PILOTIS, 0)
    flags |= np.where(resid & (floors_out >= 2) & (R(11) < 0.75), WALL_FLAG_BALCONY, 0)

    # ---- wall colours (sRGB) ----
    pal = {
        'white': [(238, 236, 229), (232, 229, 219), (241, 239, 233), (226, 223, 214), (218, 216, 209)],
        'cream': [(234, 222, 197), (228, 214, 186), (238, 228, 205), (222, 207, 180)],
        'grey': [(196, 194, 188), (182, 181, 176), (206, 203, 196), (170, 168, 163)],
        'pastel': [(236, 212, 188), (228, 222, 192), (214, 218, 216), (232, 206, 196), (222, 214, 200)],
        'stone': [(226, 211, 178), (234, 222, 196), (216, 198, 163), (206, 188, 152), (238, 228, 206), (221, 204, 168)],
        'oldstone': [(212, 193, 155), (200, 182, 146), (220, 204, 168), (190, 172, 138)],
        'concrete': [(178, 174, 164), (164, 160, 150), (190, 186, 176), (156, 154, 148)],
        'industrial': [(212, 214, 214), (226, 226, 222), (190, 194, 198), (176, 182, 188), (160, 168, 178), (200, 196, 186)],
        'glass': [(96, 124, 136), (78, 94, 110), (118, 126, 128), (104, 126, 118), (88, 104, 124), (130, 140, 146)],
        'greenhouse': [(226, 231, 228), (218, 224, 222), (232, 234, 230)],
        'hangar': [(176, 168, 150), (164, 158, 142), (186, 180, 166)],
        'brick': [(178, 96, 70), (166, 88, 66)],
    }

    def pick(name, k):
        p = np.array(pal[name], np.float64)
        return p[np.minimum((R(k) * len(p)).astype(int), len(p) - 1)]

    u = R(12)
    plaster = np.where((u < 0.55)[:, None], pick('white', 13),
                       np.where((u < 0.78)[:, None], pick('cream', 14),
                                np.where((u < 0.93)[:, None], pick('grey', 15), pick('pastel', 16))))
    plaster = np.where((W['tlv_center'] > 0.5)[:, None] & (R(17) < 0.75)[:, None], pick('white', 18), plaster)
    wall = plaster
    wall = np.where((style == WALL['stone'])[:, None] | (is_stone & np.isin(style, [WALL['house'], WALL['public'], WALL['tower']]))[:, None],
                    pick('stone', 19), wall)
    wall = np.where((style == WALL['oldstone'])[:, None], pick('oldstone', 20), wall)
    wall = np.where((style == WALL['concrete'])[:, None], np.where((kind == 'hangar')[:, None], pick('hangar', 21), pick('concrete', 21)), wall)
    wall = np.where((style == WALL['industrial'])[:, None], pick('industrial', 22), wall)
    wall = np.where((style == WALL['glass'])[:, None], pick('glass', 23), wall)
    wall = np.where((style == WALL['greenhouse'])[:, None], pick('greenhouse', 24), wall)
    wall = np.where((style == WALL['office'])[:, None] & (R(25) < 0.5)[:, None], pick('grey', 26), wall)
    fcol = [hex_rgb(r['facade_color']) if r['facade_color'] else None for r in recs]
    for i, v in enumerate(fcol):
        if v is not None:
            wall[i] = v

    # ---- roof colours: the imagery under the footprint, made plausible ----
    lin = img ** 2.2
    lum = lin @ np.array([0.2126, 0.7152, 0.0722])
    # green from trees around small roofs: pull towards a neutral of the same brightness
    greenish = np.clip((img[:, 1] - np.maximum(img[:, 0], img[:, 2])) * 6, 0, 1)
    grey = np.repeat(lum[:, None] ** (1 / 2.2), 3, 1)
    roof = img * (1 - 0.8 * greenish[:, None]) + grey * 0.8 * greenish[:, None]
    # 10 m imagery mixes roofs with streets, yards and shadow: small roofs are lifted a little
    lift = np.clip(1.0 + 0.25 * (1 - smoothstep(60, 600, A)), 1.0, 1.25)
    roof = np.clip(roof * lift[:, None], 0, 1)
    roof = roof * 0.85 + grey * 0.15                        # slightly desaturated
    terracotta = np.array([0.66, 0.33, 0.24]) * (0.85 + 0.3 * R(27))[:, None]
    tiles = np.isin(shape, ['gabled', 'hipped', 'pyramidal']) & (reddish | tiles_mat | (R(28) < 0.7))
    roof = np.where(tiles[:, None], 0.35 * roof + 0.65 * terracotta, roof)
    rcol = [hex_rgb(r['roof_color']) if r['roof_color'] else None for r in recs]
    roof = roof * 255
    for i, v in enumerate(rcol):
        if v is not None:
            roof[i] = v

    roof_style = np.select([
        kind == 'greenhouse', shape == 'dome', tiles, np.isin(shape, ['gabled', 'hipped', 'pyramidal', 'skillion', 'round']),
        kind == 'hangar', np.isin(kind, ['industrial', 'commercial', 'farm']) & (R(29) < 0.35),
        np.isin(kind, ['industrial', 'commercial', 'farm', 'stadium']),
        np.isin(kind, ['apartments', 'house']) | (style == WALL['plaster']) | (style == WALL['stone'])],
        [ROOF['greenhouse'], ROOF['dome'], ROOF['tiles'], ROOF['metal'], ROOF['concrete'], ROOF['solar'],
         ROOF['industrial'], ROOF['flat_res']], ROOF['flat'])

    # window bay width and floor height for the facade shader
    bay = np.select([style == WALL['glass'], style == WALL['office'], style == WALL['industrial'], style == WALL['house'],
                     style == WALL['public'], style == WALL['oldstone']],
                    [1.5 + 0.3 * R(30), 2.7 + 0.8 * R(30), 6 + 3 * R(30), 3.2 + 1.2 * R(30), 3.6 + 1.0 * R(30),
                     2.6 + 1.0 * R(30)], 3.0 + 1.0 * R(30))
    fh_out = np.where(np.isfinite(tagged_f) & (tagged_f > 0) & np.isfinite(tagged_h),
                      np.clip((tagged_h - 1.0) / np.maximum(tagged_f, 1), 2.6, 6.0), floor_h)
    # visibility size (m): what a viewer far away sees of the building
    vsize = np.maximum(np.sqrt(A) * 0.7, height * 1.2)

    for i, r in enumerate(recs):
        r['kind'] = kind[i]
        r['height_m'] = float(height[i])
        r['min_h'] = float(min_h[i])
        r['floors_out'] = float(floors_out[i])
        r['shape'] = SHAPE[shape[i]] if shape[i] in SHAPE else 0
        r['rise'] = float(rise[i])
        r['style'] = int(style[i]) | int(flags[i])
        r['roof_style'] = int(roof_style[i])
        r['wall_rgb'] = tuple(int(round(v)) for v in np.clip(wall[i], 0, 255))
        r['roof_rgb'] = tuple(int(round(v)) for v in np.clip(roof[i], 0, 255))
        r['floor_h'] = float(fh_out[i])
        r['bay'] = float(bay[i])
        r['vsize'] = float(vsize[i])
        r['seed'] = int(seed[i] & 255)
        r['tagged'] = bool(np.isfinite(tagged_h[i]) or np.isfinite(tagged_f[i]))
        r['cov'] = float(c[i])
        r['dens'] = float(dens[i])
    return dict(kinds=collections.Counter(kind.tolist()), styles=collections.Counter(style.tolist()),
                shapes=collections.Counter(shape.tolist()))


# ---- writing ------------------------------------------------------------------------------------

def vsize_code(v):
    """log scale: 2 m .. 2000 m in 0..255."""
    return int(np.clip(round(math.log(max(v, 2.0) / 2.0) / math.log(1000.0) * 255), 0, 255))


def write_tile(path, ix, iz, recs):
    """One tile: header, chunk table, per-building arrays, ring sizes, vertices (README.md)."""
    x0, z0 = grid.tile_origin(ix, iz)
    ox, oz = x0 - MARGIN, z0 - MARGIN

    def chunk_of(r):
        a = int(np.clip((r['cx'] - x0) // CHUNK, 0, CHUNKS - 1))
        b = int(np.clip((r['cz'] - z0) // CHUNK, 0, CHUNKS - 1))
        return b * CHUNKS + a

    recs = sorted(recs, key=lambda r: (chunk_of(r), -r['vsize']))
    N = len(recs)
    starts = np.zeros(CHUNKS * CHUNKS + 1, np.uint32)
    for r in recs:
        starts[chunk_of(r) + 1] += 1
    starts = np.cumsum(starts).astype(np.uint32)

    def q(v):
        return np.clip(np.round((np.asarray(v) - 0.0) / QUANT), 0, 65535).astype('<u2')

    cx = q([r['obb'][0] - ox for r in recs]); cz = q([r['obb'][1] - oz for r in recs])
    oa = np.clip(np.round([r['obb'][2] / 0.05 for r in recs]), 0, 65535).astype('<u2')
    ob = np.clip(np.round([r['obb'][3] / 0.05 for r in recs]), 0, 65535).astype('<u2')
    yaw = np.clip(np.round([r['obb'][4] / math.pi * 65536 for r in recs]), 0, 65535).astype('<u2')
    # ground level of the facade (floor 0) and how far the walls reach below it
    g0 = np.array([r['gmin'] for r in recs])
    base = np.clip(np.round(g0 / 0.1), -32768, 32767).astype('<i2')
    # walls reach below floor 0 by more on rough ground (the coarser terrain LODs far away)
    sink = np.clip(np.round([(0.6 + 0.25 * (r['gmax'] - r['gmin'])) / 0.1 for r in recs]), 0, 255).astype('u1')
    # top of the walls above floor 0: on a slope the height counts from the middle of the slope
    tops = []
    for r in recs:
        mid = 0.5 * (r['gmin'] + r['gmax'])
        top = (mid - r['gmin']) + r['height_m']
        top = max(top, (r['gmax'] - r['gmin']) + min(r['height_m'], 2.5))
        tops.append(top)
    top = np.clip(np.round(np.array(tops) / 0.1), 1, 65535).astype('<u2')
    minh = np.clip(np.round([r['min_h'] / 0.1 for r in recs]), 0, 65535).astype('<u2')
    rise = np.clip(np.round([r['rise'] / 0.2 for r in recs]), 0, 255).astype('u1')
    shape = np.array([r['shape'] for r in recs], 'u1')
    style = np.array([r['style'] for r in recs], 'u1')
    rstyle = np.array([r['roof_style'] for r in recs], 'u1')
    floorh = np.clip(np.round([r['floor_h'] / 0.05 for r in recs]), 1, 255).astype('u1')
    bay = np.clip(np.round([r['bay'] / 0.05 for r in recs]), 1, 255).astype('u1')
    vs = np.array([vsize_code(r['vsize']) for r in recs], 'u1')
    seed = np.array([r['seed'] for r in recs], 'u1')
    floors = np.clip(np.round([r['floors_out'] for r in recs]), 0, 255).astype('u1')
    wall = np.array([r['wall_rgb'] for r in recs], 'u1').reshape(-1)
    roof = np.array([r['roof_rgb'] for r in recs], 'u1').reshape(-1)
    nrings = np.array([len(r['rings']) for r in recs], 'u1')
    ring_n = np.array([len(rg) for r in recs for rg in r['rings']], '<u2')
    allv = np.concatenate([rg for r in recs for rg in r['rings']])
    vx = q(allv[:, 0] - ox); vz = q(allv[:, 1] - oz)
    maxtop = float(max((r['gmin'] + t * 0.1 for r, t in zip(recs, top)), default=0))
    minbase = float(min((r['gmin'] for r in recs), default=0))

    hdr = struct.pack('<4sHHBBBBfffIIIffI', MAGIC, VERSION, 64, ix, iz, CHUNKS, 0, ox, oz, QUANT,
                      N, len(ring_n), len(allv), maxtop, minbase, 0)
    hdr += b'\0' * (64 - len(hdr))
    parts = [hdr, starts.astype('<u4').tobytes()]
    # arrays in a fixed order; each starts on a 4-byte boundary
    for a in (cx, cz, oa, ob, yaw, base, top, minh, ring_n, vx, vz,
              sink, rise, shape, style, rstyle, floorh, bay, vs, seed, floors, nrings, wall, roof):
        b = a.tobytes()
        parts.append(b)
        pad = (-len(b)) % 4
        if pad:
            parts.append(b'\0' * pad)
    raw = b''.join(parts)
    data = gzip.compress(raw, 6, mtime=0)
    with open(path + '.tmp', 'wb') as f:
        f.write(data)
    os.replace(path + '.tmp', path)
    return dict(count=N, vertices=int(len(allv)), raw=len(raw), bytes=len(data), maxTop=round(maxtop, 1),
                minBase=round(minbase, 1), maxVsize=round(max((r['vsize'] for r in recs), default=0), 1))


# ---- stages -------------------------------------------------------------------------------------

def stage_fetch(cache, release):
    overture.fetch('buildings', 'building', cache, release=release, columns=COLUMNS, threads=8)
    overture.fetch('buildings', 'building_part', cache, release=release, columns=PART_COLUMNS, threads=2)


def stage_tiles(cache, out, terrain, release, only=None):
    t0 = time.time()
    if release == 'latest':
        rels = sorted(os.listdir(os.path.join(cache, 'overture')))
        release = rels[-1]
    fb = os.path.join(cache, 'overture', release, 'buildings', 'building')
    fp = os.path.join(cache, 'overture', release, 'buildings', 'building_part')
    tb = overture.read_cached(fb, COLUMNS)
    recs = load_footprints(tb)
    parts = load_footprints(overture.read_cached(fp, PART_COLUMNS), is_part=True) if os.path.isdir(fp) else []
    log(f'{tb.num_rows} buildings ({len(recs)} polygons), {len(parts)} building parts; {time.time() - t0:.0f} s')
    # building parts replace the outline of their building (OpenStreetMap's 3D convention)
    with_parts = {p['building_id'] for p in parts}
    parent = {r['id']: r for r in recs if r['id'] in with_parts}
    for p in parts:
        b = parent.get(p['building_id'])
        if b:
            for k in ('cls', 'subtype', 'facade_color', 'facade_material', 'roof_color', 'roof_material', 'name'):
                if p.get(k) is None:
                    p[k] = b.get(k)
            p['dataset'], p['license'] = b['dataset'], b['license']
    drop = collections.Counter()
    recs = [r for r in recs if not (r['id'] in with_parts and r['id'] in parent)]
    drop['outline replaced by its parts'] = sum(1 for _ in parent)
    recs += [p for p in parts if p['building_id'] in parent]
    project(recs)
    log(f'projected; {time.time() - t0:.0f} s')
    keep = []
    boxes = runway_boxes(terrain)
    H = grid.CORE_HALF
    for r in recs:
        if r['underground'] or (r['level'] is not None and r['level'] < 0 and not r['part']):
            drop['underground'] += 1
            continue
        if not clean(r):
            drop['degenerate'] += 1
            continue
        if not (-H <= r['cx'] < H and -H <= r['cz'] < H):
            drop['outside the core'] += 1
            continue
        if r['area'] < 6.0 or r['obb'][3] < 0.7:
            drop['sliver or tiny'] += 1
            continue
        if r['obb'][3] < 1.6 and r['obb'][2] > 12:
            drop['wall-like sliver'] += 1
            continue
        if on_runway(r, boxes):
            drop['on a runway'] += 1
            continue
        keep.append(r)
    recs = keep
    log(f'{len(recs)} footprints kept; dropped {dict(drop)}; {time.time() - t0:.0f} s')

    # rasters per tile
    ground = Ground(terrain)
    imgs = TileImages(terrain)
    by_tile = collections.defaultdict(list)
    for i, r in enumerate(recs):
        ix = int((r['cx'] + H) // TILE); iz = int((r['cz'] + H) // TILE)
        r['tile'] = (ix, iz)
        by_tile[(ix, iz)].append(i)
    for k, ((ix, iz), idx) in enumerate(sorted(by_tile.items())):
        sample_tile_rasters(recs, idx, ix, iz, imgs, ground)
        if k % 32 == 0:
            log(f'rasters: tile {k + 1}/{len(by_tile)}; {time.time() - t0:.0f} s')
    # water: the sea (0 m) and the Dead Sea; OpenStreetMap buildings with a class or a name stay
    keep = []
    for r in recs:
        water = r['lc'] == 80 or (r['lc'] == 0 and abs(r['gmean']) < 0.5)
        sea_level = abs(r['gmax']) < 0.6 or r['gmax'] < -420
        if water and sea_level and not (r['dataset'] == 'OpenStreetMap' and (r['cls'] or r['name'])):
            drop['in the sea or the Dead Sea'] += 1
            continue
        keep.append(r)
    recs = keep
    stats = estimate(recs)
    log(f'estimated; kinds {dict(stats["kinds"].most_common(12))}; {time.time() - t0:.0f} s')

    os.makedirs(out, exist_ok=True)
    by_tile = collections.defaultdict(list)
    for r in recs:
        by_tile[r['tile']].append(r)
    tiles = []
    for (ix, iz), rs in sorted(by_tile.items()):
        if only and (ix, iz) not in only:
            continue
        name = f'tile_{ix}_{iz}.bin'
        info = write_tile(os.path.join(out, name), ix, iz, rs)
        tiles.append(dict(ix=ix, iz=iz, file=name, **info))
    datasets = collections.Counter((r['dataset'], r['license']) for r in recs)
    total = sum(t['count'] for t in tiles)
    tall = sorted((r for r in recs if r['height_m'] > 120), key=lambda r: -r['height_m'])
    try:
        with open(os.path.join(terrain, 'manifest.json')) as f:
            tman = json.load(f)
    except OSError:
        tman = {}
    sources = [dict(dataset=d, license=lic, buildings=n) for (d, lic), n in datasets.most_common()]
    att = ('Buildings: (c) OpenStreetMap contributors (ODbL) and Microsoft ML Buildings (ODbL), '
           f'via Overture Maps Foundation (release {release}, ODbL)')
    index = dict(
        format='f35i-buildings', version=VERSION, generated_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        generator='sim/tools/world/buildings.py', attribution=att,
        source=dict(name='Overture Maps Foundation', theme='buildings', types=['building', 'building_part'],
                    release=release, url='https://docs.overturemaps.org/', license='ODbL-1.0',
                    datasets=sources),
        terrain=dict(generated_utc=tman.get('generated_utc')),
        tile_m=TILE, tiles_per_side=NT, chunks=CHUNKS, quantum_m=QUANT, margin_m=MARGIN,
        count=total, vertices=sum(t['vertices'] for t in tiles), bytes=sum(t['bytes'] for t in tiles),
        dropped=dict(drop), kinds=dict(stats['kinds']), styles={k: int(v) for k, v in stats['styles'].items()},
        shapes=dict(stats['shapes']),
        tagged=dict(height_or_floors=int(sum(r['tagged'] for r in recs))),
        tallest=[dict(name=r['name'], height_m=round(r['height_m'], 1), x=round(r['cx']), z=round(r['cz']))
                 for r in tall[:40]],
        tiles=tiles,
    )
    with open(os.path.join(out, 'index.json.tmp'), 'w') as f:
        json.dump(index, f, indent=1, ensure_ascii=False)
    os.replace(os.path.join(out, 'index.json.tmp'), os.path.join(out, 'index.json'))
    log(f'{total} buildings in {len(tiles)} tiles, {index["bytes"] / 1e6:.1f} MB '
        f'({sum(t["raw"] for t in tiles) / 1e6:.1f} MB unpacked); {time.time() - t0:.0f} s')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cache', default=os.path.join(HERE, '_cache'))
    ap.add_argument('--out', default=os.path.normpath(os.path.join(HERE, '..', '..', 'data', 'world', 'buildings')))
    ap.add_argument('--terrain', default=os.path.normpath(os.path.join(HERE, '..', '..', 'data', 'terrain')))
    ap.add_argument('--release', default='latest')
    ap.add_argument('--stages', default='fetch,tiles')
    ap.add_argument('--only', default='', help='write only these tiles, e.g. "4,3;5,3" (testing)')
    a = ap.parse_args()
    only = {tuple(int(v) for v in s.split(',')) for s in a.only.split(';') if s.strip()} or None
    stages = a.stages.split(',')
    if 'fetch' in stages:
        stage_fetch(a.cache, a.release)
    if 'tiles' in stages:
        stage_tiles(a.cache, a.out, a.terrain, a.release, only)


if __name__ == '__main__':
    main()
