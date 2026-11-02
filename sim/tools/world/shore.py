#!/usr/bin/env python3
"""Shore structures along the Mediterranean coast: breakwaters, piers, quays and container cranes.

    python3 sim/tools/world/shore.py --out sim/data/landscape [--cache DIR] [--release latest]

The terrain draws the coast from imagery and a 25 m height grid, so the rubble-mound
breakwaters of Ashdod, Jaffa, the Tel Aviv marina and Herzliya were flat smudges at best (the
colour stage recolours open water, and a 15 m wide breakwater 800 m out to sea went with it),
the detached breakwaters off the Tel Aviv beaches with their sand tombolos were gone, and the
container port had no cranes. This builds them as small 3D data for js/world/Shore.js:

  * breakwaters (Overture base/infrastructure class breakwater, from OpenStreetMap): the
    mapped outline is the footprint at sea level; the crest is the outline inset along the
    vertex bisectors by the slope run (1 : 1.5), never more than 42 % of the local width, at a
    height by size (detached beach breakwaters ~1.8 m, marinas ~4.5 m, the Ashdod main
    breakwater 6.5 m). Lines (a few are mapped as lines) become 8-12 m wide mounds. Each
    footprint edge carries its exposure to the swell (exp, 0-100: faces the west-north-west
    and no other structure within 1.5 km in between), where the waves break white;
  * piers and quays (class pier / quay): polygons become decks 1.2-2 m above the sea with
    vertical sides; lines become 2.5-4 m wide jetties and marina pontoons;
  * ship-to-shore container cranes at Ashdod: placed along hand-picked container quays (edges
    of the OSM coastline, which follows the quay walls, picked against the Sentinel-2 imagery
    where the container stacks are), spaced 65-110 m, the boom over the water side; about a
    third with the boom raised. Their size follows the port's published figures (44 m lift
    height, 60 m outreach).

Output: <out>/shore.json, world metres (sim/DESIGN.md), rings counter-clockwise on a north-up
map (signed area < 0, geom.py). The app runs without it.

Data: Overture Maps Foundation base theme (ODbL, derived from OpenStreetMap: (c) OpenStreetMap
contributors).
"""
import argparse
import json
import math
import os
import struct
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', 'terrain')))

import geom  # noqa: E402
import grid  # noqa: E402
import overture  # noqa: E402

# Ashkelon .. Herzliya / Apollonia: the core's coast
BBOX = (34.40, 31.55, 34.95, 32.30)
COLUMNS = ['id', 'geometry', 'bbox', 'subtype', 'class', 'names']

# container quays at Ashdod, by the world X, Z of their ends (edges of the OSM coastline, see the
# module docstring) and the number of cranes on each
CRANE_QUAYS = [
    ((-35469, -3857), (-36071, -3852), 6),     # the container yard's south face (old port)
    ((-36071, -3852), (-36072, -4062), 2),     # its west face
    ((-35399, -4805), (-36201, -4805), 6),     # the new (south port) terminal's south face
    ((-36201, -4805), (-36201, -5300), 4),     # and its west face
    ((-36150, -2504), (-36453, -2817), 4),     # the southern pier, south-west face
    ((-36405, -2913), (-35977, -2704), 3),     # and its north-east face
]
SLOPE = 1.5                     # rubble mound: horizontal run per metre of height
MAX_INSET_SHARE = 0.42          # crest inset never more than this share of the local width
# the swell on this coast comes mostly from the west-north-west (the storms' fetch is the open
# Mediterranean): faces turned that way get the breaking waves, unless another structure
# within SHELTER_M lies in between (the inner faces of a port)
WAVES_FROM_DEG = 285.0
SHELTER_M = 1500.0


def log(*a):
    print('[shore]', *a, flush=True)


def wkb_lines(b):
    """Lines of a 2D WKB LineString / MultiLineString (other types: []): [(n, 2) lon/lat, ...]."""
    out = []

    def rd(o):
        bo = '<' if b[o] == 1 else '>'
        t = struct.unpack_from(bo + 'I', b, o + 1)[0]
        dim = 2 + (1 if t & 0x80000000 else 0) + (1 if t & 0x40000000 else 0)
        t &= 0x0FFFFFFF
        dim += {0: 0, 1: 1, 2: 1, 3: 2}.get(t // 1000, 0)
        t %= 1000
        o += 5
        if t == 2:
            n = struct.unpack_from(bo + 'I', b, o)[0]
            out.append(np.frombuffer(b, bo + 'f8', dim * n, o + 4).reshape(n, dim)[:, :2])
            return o + 4 + 8 * dim * n
        if t == 5:
            n = struct.unpack_from(bo + 'I', b, o)[0]
            o += 4
            for _ in range(n):
                o = rd(o)
            return o
        return len(b)

    rd(0)
    return out


def to_xz(ll):
    x, z = grid.lonlat_to_xz(ll[:, 0], ll[:, 1])
    return np.stack([x, z], 1)


def ccw(r):
    """Outer ring orientation of geom.py (signed area < 0)."""
    return r if geom.signed_area(r) < 0 else r[::-1].copy()


def local_width(r):
    """Per vertex: the distance to the nearest edge that does not touch it (the polygon's width there)."""
    n = len(r)
    a, b = r, np.roll(r, -1, axis=0)
    ab = b - a
    L2 = np.maximum(np.sum(ab * ab, axis=1), 1e-9)
    w = np.full(n, np.inf)
    for i in range(n):
        t = np.clip(np.sum((r[i] - a) * ab, axis=1) / L2, 0.0, 1.0)
        d = np.linalg.norm(a + ab * t[:, None] - r[i], axis=1)
        d[[i, (i - 1) % n]] = np.inf
        w[i] = d.min()
    return w


def inset(r, dist):
    """Ring r (signed area < 0) moved inward by dist[i] along each vertex bisector (miter, capped)."""
    n = len(r)
    prv, nxt = np.roll(r, 1, axis=0), np.roll(r, -1, axis=0)
    e0 = r - prv
    e1 = nxt - r
    e0 /= np.maximum(np.linalg.norm(e0, axis=1, keepdims=True), 1e-9)
    e1 /= np.maximum(np.linalg.norm(e1, axis=1, keepdims=True), 1e-9)
    # inward normal of an edge (dx, dz) of a ring with signed area < 0: (dz, -dx)
    n0 = np.stack([e0[:, 1], -e0[:, 0]], 1)
    n1 = np.stack([e1[:, 1], -e1[:, 0]], 1)
    m = n0 + n1
    ml = np.linalg.norm(m, axis=1, keepdims=True)
    m = np.where(ml > 1e-6, m / np.maximum(ml, 1e-9), n1)
    cos_h = np.clip(np.sum(m * n1, axis=1), 0.5, 1.0)          # miter length 1 / cos, capped at 2
    return r + m * (dist / cos_h)[:, None]


def mound(ring_xz, crest):
    """Footprint ring at sea level -> (footprint, crest ring) of a rubble mound."""
    r = ccw(geom.clean_ring(ring_xz, tol=0.4, min_edge=0.5))
    if len(r) < 3:
        return None
    run = crest * SLOPE
    w = local_width(r)
    d = np.minimum(run, MAX_INSET_SHARE * w)
    return r, inset(r, d)


def strip_ring(line_xz, width):
    """A line buffered to a ring of half width width / 2 (flat ends, mitred joints)."""
    p = line_xz
    if len(p) < 2:
        return None
    seg = np.diff(p, axis=0)
    L = np.linalg.norm(seg, axis=1)
    keep = np.concatenate([[True], L > 0.2])
    p = p[keep]
    if len(p) < 2:
        return None
    t = np.diff(p, axis=0)
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    tv = np.concatenate([t[:1], t[:-1] + t[1:], t[-1:]], 0)
    tv /= np.maximum(np.linalg.norm(tv, axis=1, keepdims=True), 1e-9)
    nv = np.stack([-tv[:, 1], tv[:, 0]], 1)
    # miter: scale by 1 / cos of half the turn (capped)
    tn = np.concatenate([t[:1], t, t[-1:]], 0)
    c = np.clip(np.sum(nv * np.stack([-tn[1:, 1], tn[1:, 0]], 1), axis=1), 0.5, 1.0)
    off = nv * (width / 2 / c)[:, None]
    return np.concatenate([p + off, (p - off)[::-1]], 0)


def r1(a):
    return [[round(float(x), 1), round(float(z), 1)] for x, z in a]


def crest_for(length, kind):
    if kind == 'line':
        return 3.0
    if length > 1500:
        return 6.5
    if length > 600:
        return 5.0
    if length > 260:
        return 4.0
    return 1.8          # the short detached breakwaters off the beaches sit low


def exposure(rings, blockers):
    """Per ring edge: how much it faces the swell (0..100), 0 where a blocker edge lies in between.

    rings: footprints (signed area < 0); blockers: (m, 4) segments ax, az, bx, bz of every
    structure. The ray leaves the edge's middle 1 m outside it, toward the waves."""
    a = math.radians(WAVES_FROM_DEG)
    w = np.array([math.sin(a), -math.cos(a)])        # toward where the waves come from (x east, z south)
    ax, az, bx, bz = blockers.T
    sx, sz = bx - ax, bz - az
    out = []
    for r in rings:
        e = np.roll(r, -1, axis=0) - r
        L = np.maximum(np.linalg.norm(e, axis=1), 1e-9)
        n = np.stack([-e[:, 1], e[:, 0]], 1) / L[:, None]       # outward (signed area < 0)
        f = np.clip((n @ w) * 1.25, 0.0, 1.0)
        mid = r + e * 0.5 + n * 1.0
        for i in np.nonzero(f > 0)[0]:
            # ray mid + t w (0 < t < SHELTER_M) against every blocker segment a + u s (0 <= u <= 1)
            den = w[0] * sz - w[1] * sx
            ok = np.abs(den) > 1e-9
            qx, qz = ax - mid[i, 0], az - mid[i, 1]
            t = np.where(ok, (qx * sz - qz * sx) / np.where(ok, den, 1.0), -1.0)
            u = np.where(ok, (qx * w[1] - qz * w[0]) / np.where(ok, den, 1.0), -1.0)
            if np.any((t > 0.5) & (t < SHELTER_M) & (u >= 0.0) & (u <= 1.0)):
                f[i] = 0.0
        out.append([int(round(v * 100)) for v in f])
    return out


def segments(rings):
    s = [np.concatenate([r, np.roll(r, -1, axis=0)], 1) for r in rings]
    return np.concatenate(s, 0) if s else np.zeros((0, 4))


def cranes(ocean_rings):
    """Crane positions along CRANE_QUAYS; the boom toward the side where the ocean polygon is."""
    out = []
    rng = np.random.default_rng(7)
    for (a, b, n) in CRANE_QUAYS:
        a, b = np.array(a, float), np.array(b, float)
        d = b - a
        L = float(np.linalg.norm(d))
        t = d / L
        nrm = np.array([-t[1], t[0]])
        mid = (a + b) / 2
        side = 1.0
        for s in (1.0, -1.0):
            px, pz = mid + nrm * s * 40.0
            if geom.points_in_polygon(np.array([px]), np.array([pz]), ocean_rings)[0]:
                side = s
                break
        water = nrm * side
        # spaced along the quay, clustered as ships need them, not on the corners
        span = L - 60.0
        k = np.sort(rng.uniform(0, 1, n)) * 0.25 + (np.arange(n) + 0.5) / n * 0.75
        for f in k:
            p = a + t * (30.0 + span * f) - water * 3.0     # the waterside rail 3 m behind the quay edge
            out.append(dict(x=round(float(p[0]), 1), z=round(float(p[1]), 1),
                            heading=round(math.atan2(water[0], -water[1]), 4),     # boom direction, rad from north (-Z) toward east (+X)
                            boom_up=bool(rng.uniform() < 0.33), variant=int(rng.integers(0, 2))))
    return out


def build(out, cache, release):
    t0 = time.time()
    inf = overture.read_cached(overture.fetch('base', 'infrastructure', cache, bbox=BBOX, release=release, columns=COLUMNS))
    wat = overture.read_cached(overture.fetch('base', 'water', cache, bbox=BBOX, release=release, columns=COLUMNS))
    breakwaters, decks, ids = [], [], set()
    stats = dict(breakwaters=0, breakwater_lines=0, decks=0, jetties=0)
    for row in inf.to_pylist():
        k = row.get('class')
        if k not in ('breakwater', 'pier', 'quay', 'groyne') or row['id'] in ids:
            continue
        ids.add(row['id'])
        g = row['geometry']
        polys = geom.wkb_polygons(g)
        lines = wkb_lines(g) if not polys else []
        for poly in polys:
            ring = to_xz(poly[0])
            ext = float(np.max(np.ptp(ring, axis=0)))
            if k in ('breakwater', 'groyne'):
                c = crest_for(ext, 'poly')
                m = mound(ring, c)
                if m:
                    breakwaters.append(dict(foot=m[0], crest=m[1], h=c))
                    stats['breakwaters'] += 1
            else:
                r = ccw(geom.clean_ring(ring, tol=0.3, min_edge=0.3))
                if len(r) >= 3:
                    decks.append(dict(ring=r, h=2.0 if k == 'quay' else 1.2))
                    stats['decks'] += 1
        for ln in lines:
            p = to_xz(ln)
            L = float(np.sum(np.linalg.norm(np.diff(p, axis=0), axis=1)))
            if L < 8:
                continue
            if k in ('breakwater', 'groyne'):
                ring = strip_ring(p, 12.0 if L > 300 else 8.0)
                m = mound(ring, 3.0) if ring is not None else None
                if m:
                    breakwaters.append(dict(foot=m[0], crest=m[1], h=3.0))
                    stats['breakwater_lines'] += 1
            else:
                # marina pontoons and jetties: narrow, low
                ring = strip_ring(p, 4.0 if L > 150 else 2.5)
                if ring is not None:
                    decks.append(dict(ring=ccw(ring), h=0.9 if L <= 150 else 1.5))
                    stats['jetties'] += 1
    ocean = []
    for row in wat.to_pylist():
        if row.get('subtype') == 'ocean':
            for poly in geom.wkb_polygons(row['geometry']):
                ocean += [to_xz(r) for r in poly]
    cr = cranes(ocean)
    # the breaking waves: per footprint edge, how much it faces the swell (js/world/Shore.js foam)
    blockers = segments([b['foot'] for b in breakwaters] + [d['ring'] for d in decks])
    for b, e in zip(breakwaters, exposure([b['foot'] for b in breakwaters], blockers)):
        b['exp'] = e
    for b in breakwaters:
        b['foot'], b['crest'] = r1(b['foot']), r1(b['crest'])
    for d in decks:
        d['ring'] = r1(d['ring'])
    os.makedirs(out, exist_ok=True)
    doc = dict(format='f35i-shore', version=1, generator='sim/tools/world/shore.py',
               generated_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               units='world metres (sim/DESIGN.md: X east, Z = -north), heights above sea level',
               breakwaters=breakwaters, decks=decks, cranes=cr,
               attribution='Shore structures: Overture Maps Foundation (ODbL), (c) OpenStreetMap contributors')
    tmp = os.path.join(out, 'shore.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    os.replace(tmp, os.path.join(out, 'shore.json'))
    log(f'{stats}, {len(cr)} cranes -> {out}/shore.json '
        f'({os.path.getsize(os.path.join(out, "shore.json")) / 1e3:.0f} kB) in {time.time() - t0:.0f} s')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True, help='output folder (the app reads <data>/landscape/)')
    ap.add_argument('--cache', default=os.path.join(HERE, '_cache'))
    ap.add_argument('--release', default='latest')
    a = ap.parse_args()
    build(a.out, a.cache, a.release)


if __name__ == '__main__':
    main()
