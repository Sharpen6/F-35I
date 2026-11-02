"""Airfield surfaces and lights for the F-35I sim: Overture aeroways -> data/world/airfields/airfields.json.

    python3 sim/tools/world/airfields.py [--cache DIR] [--out sim/data/world] [--stages fetch,build]

Stages:
  fetch   reads the base theme (type=infrastructure, subtype=airport: taxiways, aprons, ...) of the
          Overture release used by roads.py around the airfields below (anonymous HTTPS range reads of
          the row groups whose bbox statistics touch them) into <cache>/aeroways.parquet.
  build   projects the taxiway centrelines and apron polygons into the world frame (sim/DESIGN.md),
          cuts them out of the runways of data/terrain/airports.json (the terrain paints those),
          places the runway holding positions (ICAO pattern A, at the holding distance of each
          airfield from the runway centreline), triangulates the aprons, clips everything to the
          terrain's L0 tiles and adds the light layouts: blue taxiway edge lights, apron floodlight
          masts, and per runway end the approach, centreline, touchdown zone and PAPI configuration
          that js/world/AirportLights.js lays out on the runways of airports.json.

Data: OpenStreetMap contributors (ODbL 1.0), via Overture Maps Foundation (base theme). The lighting
configuration is a standard ICAO Annex 14 layout per runway (see ROADS.md): approach lights where the
runway has an instrument approach, PAPI on the left, centreline and touchdown zone lights at Ben
Gurion's main instrument runways. Format: ROADS.md ("airfields.json").
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'terrain'))
import grid  # noqa: E402
from roads import BASE, RELEASE, RangeFile, list_keys, cumlen, cut, simplify, rect_intervals  # noqa: E402

ATTRIBUTION = ('Airfield surfaces: (c) OpenStreetMap contributors, ODbL 1.0, via Overture Maps Foundation '
               f'(base theme, {RELEASE.split("/")[1]})')
VERSION = 1

# The airfields with surfaces and lights. taxi_w: full-strength taxiway width (m) where OSM has no
# width; shoulder: paved shoulder each side; hold_m: runway holding position from the runway
# centreline (ICAO Annex 14 table 3-2: 90 m for a code 4 instrument runway, 75 m code 3/4
# non-precision / military practice, 40 m code 1/2); flood: apron floodlights (lux at a mast's foot).
AIRFIELDS = {
    'LLBG': dict(taxi_w=23.0, shoulder=5.0, hold_m=90.0, edge_marks=True, flood=80.0, mast_h=30.0, taxi_lights=True),
    'LLEK': dict(taxi_w=20.0, shoulder=2.0, hold_m=75.0, edge_marks=False, flood=45.0, mast_h=22.0, taxi_lights=True),
    'LLHS': dict(taxi_w=20.0, shoulder=2.0, hold_m=75.0, edge_marks=False, flood=45.0, mast_h=22.0, taxi_lights=True),
    'LL59': dict(taxi_w=18.0, shoulder=2.0, hold_m=75.0, edge_marks=False, flood=40.0, mast_h=22.0, taxi_lights=True),
    'LLHZ': dict(taxi_w=10.5, shoulder=0.0, hold_m=40.0, edge_marks=False, flood=0.0, mast_h=0.0, taxi_lights=False),
}

# Runway lights per runway end (the end you land on). als: approach lights ('calvert900': CAT I,
# 900 m centreline with crossbars every 150 m and the 300 m bar; 'simple420': 420 m centreline with
# a crossbar at 300 m, a common military layout; None), cl: centreline lights, tdz: touchdown zone
# barrettes, papi: 'L' / 'R' / None (3 deg), inst: instrument runway (yellow caution zone in the
# last 600 m), flash: sequenced flashers on the approach lights. Ends not listed: edge, threshold
# and end lights only. Unlit runways (airports.json lighted = false) get nothing.
RUNWAY_LIGHTS = {
    'LLBG': {
        '26': dict(als='calvert900', cl=True, tdz=True, papi='L', inst=True, flash=True),
        '08': dict(als='calvert900', cl=True, tdz=False, papi='L', inst=True, flash=True),
        '12': dict(als='calvert900', cl=True, tdz=True, papi='L', inst=True, flash=True),
        '30': dict(als='calvert900', cl=True, tdz=False, papi='L', inst=True, flash=False),
        '21': dict(als='calvert900', cl=True, tdz=False, papi='L', inst=True, flash=False),
        '03': dict(als=None, cl=True, tdz=False, papi='L', inst=False, flash=False),
    },
    'LLEK': {
        '36': dict(als='simple420', cl=False, tdz=False, papi='L', inst=True, flash=False),
        '18': dict(als='simple420', cl=False, tdz=False, papi='L', inst=True, flash=False),
        '33R': dict(als='simple420', cl=False, tdz=False, papi='L', inst=True, flash=False),
        '33L': dict(als=None, cl=False, tdz=False, papi='L', inst=False, flash=False),
        '15L': dict(als=None, cl=False, tdz=False, papi='L', inst=False, flash=False),
        '15R': dict(als=None, cl=False, tdz=False, papi='L', inst=False, flash=False),
    },
    'LLHS': {
        '29R': dict(als='simple420', cl=False, tdz=False, papi='L', inst=True, flash=False),
        '11L': dict(als='simple420', cl=False, tdz=False, papi='L', inst=True, flash=False),
        '23': dict(als='simple420', cl=False, tdz=False, papi='L', inst=True, flash=False),
        '05': dict(als=None, cl=False, tdz=False, papi='L', inst=False, flash=False),
    },
    'LL59': {
        '21': dict(als='simple420', cl=False, tdz=False, papi='L', inst=True, flash=False),
        '03': dict(als=None, cl=False, tdz=False, papi='L', inst=False, flash=False),
    },
}


def log(*a):
    print('  [airfields]', *a, flush=True)


# ---------------------------------------------------------------------------------------------
# fetch

COLUMNS = ['id', 'subtype', 'class', 'names', 'source_tags', 'surface', 'geometry', 'bbox']


def airfield_boxes(airports, margin=2500.0):
    """lon/lat boxes (W, S, E, N) around the runways of each airfield in AIRFIELDS."""
    boxes = {}
    for ap in airports:
        if ap['icao'] not in AIRFIELDS:
            continue
        xs = [e['x'] for r in ap['runways'] for e in r['ends']]
        zs = [e['z'] for r in ap['runways'] for e in r['ends']]
        x0, x1, z0, z1 = min(xs) - margin, max(xs) + margin, min(zs) - margin, max(zs) + margin
        lon, lat = grid.xz_to_lonlat(np.array([x0, x1, x0, x1]), np.array([z0, z0, z1, z1]))
        boxes[ap['icao']] = (float(np.min(lon)), float(np.min(lat)), float(np.max(lon)), float(np.max(lat)))
    return boxes


def fetch(cache, airports):
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    out = os.path.join(cache, 'aeroways.parquet')
    if os.path.exists(out):
        log(f'{out} exists: fetch skipped (delete it to fetch again)')
        return out
    boxes = list(airfield_boxes(airports).values())
    prefix = f'{RELEASE}/theme=base/type=infrastructure/'
    keys = [k for k in list_keys(prefix) if k.endswith('.parquet')]
    tables, t0 = [], time.time()
    for key in keys:
        f = RangeFile(f'{BASE}/{key}')
        pf = pq.ParquetFile(f)
        md = pf.metadata
        ix = {md.schema.column(c).path: c for c in range(md.num_columns)}
        rgs = []
        for rg in range(md.num_row_groups):
            g = md.row_group(rg)
            st = {k: g.column(ix['bbox.' + k]).statistics for k in ('xmin', 'xmax', 'ymin', 'ymax')}
            if not all(s is not None and s.has_min_max for s in st.values()):
                rgs.append(rg)
                continue
            if any(not (st['xmax'].max < W or st['xmin'].min > E or st['ymax'].max < S or st['ymin'].min > N)
                   for W, S, E, N in boxes):
                rgs.append(rg)
        cols = [c for c in COLUMNS if c in pf.schema_arrow.names]
        for rg in rgs:
            t = pf.read_row_group(rg, columns=cols)
            t = t.filter(pc.equal(t.column('subtype'), 'airport'))
            if t.num_rows:
                bb = t.column('bbox')
                m = None
                for W, S, E, N in boxes:
                    mk = pc.and_(pc.and_(pc.greater_equal(pc.struct_field(bb, 'xmax'), W), pc.less_equal(pc.struct_field(bb, 'xmin'), E)),
                                 pc.and_(pc.greater_equal(pc.struct_field(bb, 'ymax'), S), pc.less_equal(pc.struct_field(bb, 'ymin'), N)))
                    m = mk if m is None else pc.or_(m, mk)
                t = t.filter(m)
            if t.num_rows:
                tables.append(t)
        log(f'{key.split("/")[-1][:14]}: {len(rgs)} row groups, {sum(x.num_rows for x in tables)} rows so far '
            f'({f.nbytes / 1e6:.0f} MB, {time.time() - t0:.0f} s)')
    table = pa.concat_tables(tables, promote_options='permissive')
    pq.write_table(table, out + '.tmp', compression='zstd')
    os.replace(out + '.tmp', out)
    log(f'{table.num_rows} aeroway features -> {out}')
    return out


# ---------------------------------------------------------------------------------------------
# geometry

def parse_wkb(wkb):
    """WKB -> ('line', [(N, 2)]) or ('polygon', [[outer, hole, ...], ...]) in lon/lat, or (None, None)."""
    import struct

    def rd(off):
        bo = '<' if wkb[off] == 1 else '>'
        t = struct.unpack_from(bo + 'I', wkb, off + 1)[0] % 1000
        return bo, t, off + 5

    def ring(bo, off):
        n = struct.unpack_from(bo + 'I', wkb, off)[0]
        a = np.frombuffer(wkb, bo + 'f8', 2 * n, off + 4).reshape(n, 2)
        return a, off + 4 + 16 * n

    def geom(off):
        bo, t, off = rd(off)
        if t == 2:
            a, off = ring(bo, off)
            return ('line', [a]), off
        if t == 3:
            nr = struct.unpack_from(bo + 'I', wkb, off)[0]
            off += 4
            rings = []
            for _ in range(nr):
                a, off = ring(bo, off)
                rings.append(a)
            return ('polygon', [rings]), off
        if t in (5, 6):
            n = struct.unpack_from(bo + 'I', wkb, off)[0]
            off += 4
            parts, kind = [], None
            for _ in range(n):
                (k, p), off = geom(off)
                kind = k
                parts += p
            return (kind, parts), off
        return (None, None), off

    return geom(0)[0]


def area2(p):
    x, z = p[:, 0], p[:, 1]
    return float(np.sum(x * np.roll(z, -1) - np.roll(x, -1) * z))


def eliminate_holes(outer, holes):
    """One simple ring from an outer ring and its holes, by bridging each hole to a visible outer
    vertex (Eberly, "Triangulation by ear clipping"); outer counter-clockwise, holes clockwise."""
    ring = [tuple(p) for p in outer]
    for h in sorted(holes, key=lambda h: -float(np.max(h[:, 0]))):
        hl = [tuple(p) for p in h]
        mi = max(range(len(hl)), key=lambda i: hl[i][0])
        mx, mz = hl[mi]
        # nearest edge of the ring hit by the ray +x from M
        best, bi, bp = 1e18, -1, None
        n = len(ring)
        for i in range(n):
            ax, az = ring[i]
            bx, bz = ring[(i + 1) % n]
            if (az - mz) * (bz - mz) > 0 or az == bz:
                continue
            t = (mz - az) / (bz - az)
            x = ax + t * (bx - ax)
            if x >= mx and x - mx < best:
                best, bi = x - mx, i
                bp = (x, mz)
        if bi < 0:
            continue
        # the endpoint of that edge with the larger x, unless a ring vertex lies in the triangle
        ia, ib = bi, (bi + 1) % n
        cand = ia if ring[ia][0] > ring[ib][0] else ib
        P = ring[cand]
        tri = (np.array([mx, mz]), np.array(bp), np.array(P))

        def inside(q):
            def s(a, b, c):
                return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            d1, d2, d3 = s(tri[0], tri[1], q), s(tri[1], tri[2], q), s(tri[2], tri[0], q)
            neg = d1 < 0 or d2 < 0 or d3 < 0
            pos = d1 > 0 or d2 > 0 or d3 > 0
            return not (neg and pos)
        bestang, choice = 1e18, cand
        for i in range(n):
            if i == cand:
                continue
            q = ring[i]
            if q[0] >= mx and inside(np.array(q)):
                ang = abs(math.atan2(q[1] - mz, q[0] - mx))
                if ang < bestang:
                    bestang, choice = ang, i
        # splice: ..., ring[choice], hole from M around back to M, ring[choice], ...
        hole_seq = hl[mi:] + hl[:mi] + [hl[mi]]
        ring = ring[:choice + 1] + hole_seq + ring[choice:]
    return np.array(ring)


def ear_clip(ring):
    """Triangles (list of 3x2 arrays) of a simple polygon ring (either winding)."""
    pts = [tuple(p) for p in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    n = len(pts)
    if n < 3:
        return []
    P = np.array(pts)
    ccw = area2(P) > 0
    idx = list(range(n))
    tris = []

    def cross(a, b, c):
        return (P[b, 0] - P[a, 0]) * (P[c, 1] - P[a, 1]) - (P[b, 1] - P[a, 1]) * (P[c, 0] - P[a, 0])

    guard = 0
    while len(idx) > 3 and guard < 100000:
        guard += 1
        cut_done = False
        m = len(idx)
        for k in range(m):
            a, b, c = idx[(k - 1) % m], idx[k], idx[(k + 1) % m]
            cr = cross(a, b, c)
            if (cr <= 1e-12) if ccw else (cr >= -1e-12):
                continue
            ok = True
            for q in idx:
                if q in (a, b, c) or (P[q] == P[a]).all() or (P[q] == P[b]).all() or (P[q] == P[c]).all():
                    continue
                d1, d2, d3 = cross(a, b, q), cross(b, c, q), cross(c, a, q)
                if (d1 >= 0 and d2 >= 0 and d3 >= 0) if ccw else (d1 <= 0 and d2 <= 0 and d3 <= 0):
                    ok = False
                    break
            if ok:
                tris.append(P[[a, b, c]].copy())
                del idx[k]
                cut_done = True
                break
        if not cut_done:
            break
    if len(idx) == 3:
        tris.append(P[idx].copy())
    return tris


def clip_poly(p, a, b, c):
    """Part of convex polygon p (N, 2) where a * x + b * z + c >= 0."""
    out = []
    n = len(p)
    for k in range(n):
        P, Q = p[k - 1], p[k]
        dp, dq = a * P[0] + b * P[1] + c, a * Q[0] + b * Q[1] + c
        if dq >= 0:
            if dp < 0:
                out.append(P + (Q - P) * (dp / (dp - dq)))
            out.append(Q)
        elif dp >= 0:
            out.append(P + (Q - P) * (dp / (dp - dq)))
    return np.array(out) if len(out) >= 3 else None


def minus_rect(poly, rect):
    """Convex polygon minus an oriented rectangle (cx, cz, ux, uz, hl, hw) -> list of convex pieces."""
    cx, cz, ux, uz, hl, hw = rect
    # half-planes of the rectangle, inside >= 0: s <= hl, -s <= hl, t <= hw, -t <= hw
    planes = []
    for sgn in (1, -1):
        planes.append((-sgn * ux, -sgn * uz, hl + sgn * (cx * ux + cz * uz)))
        planes.append((sgn * uz, -sgn * ux, hw - sgn * (-cx * uz + cz * ux)))
    out, rest = [], poly
    for a, b, c in planes:
        if rest is None:
            break
        outside = clip_poly(rest, -a, -b, -c)
        if outside is not None and abs(area2(outside)) > 1e-3:
            out.append(outside)
        rest = clip_poly(rest, a, b, c)
    return out


# ---------------------------------------------------------------------------------------------
# build

def runway_frames(ap):
    """Runway rectangles of an airport (centre, unit direction, half length incl. overruns, half width)."""
    out = []
    for r in ap['runways']:
        a, b = r['ends']
        dx, dz = b['x'] - a['x'], b['z'] - a['z']
        L = math.hypot(dx, dz)
        ux, uz = dx / L, dz / L
        oa, ob = a.get('overrun_m', 0) or 0, b.get('overrun_m', 0) or 0
        c = ((a['x'] - ux * oa + b['x'] + ux * ob) / 2, (a['z'] - uz * oa + b['z'] + uz * ob) / 2)
        out.append(dict(rect=(c[0], c[1], ux, uz, (L + oa + ob) / 2, r['width_m'] / 2), ux=ux, uz=uz,
                        mid=((a['x'] + b['x']) / 2, (a['z'] + b['z']) / 2), hl=L / 2, hw=r['width_m'] / 2))
    return out


def tag(row, k):
    st = row.get('source_tags') or {}
    if isinstance(st, list):
        st = dict(st)
    return st.get(k)


def to_float(s):
    try:
        return float(str(s).split()[0].replace(',', '.'))
    except (ValueError, IndexError, TypeError):
        return None


def build(cache, out):
    import pyarrow.parquet as pq
    t0 = time.time()
    terrain_dir = os.path.join(out, '..', 'terrain') if os.path.isdir(os.path.join(out, '..', 'terrain')) \
        else os.path.join(HERE, '..', '..', 'data', 'terrain')
    with open(os.path.join(terrain_dir, 'airports.json')) as f:
        airports = json.load(f)
    aps = {ap['icao']: ap for ap in airports if ap['icao'] in AIRFIELDS}
    rows = pq.read_table(os.path.join(cache, 'aeroways.parquet')).to_pylist()
    log(f'{len(rows)} aeroway features ({time.time() - t0:.1f} s)')
    from collections import Counter
    log('classes: ' + ', '.join(f'{k} {v}' for k, v in Counter(r['class'] for r in rows).most_common()))

    T = grid.TILE_SIZE
    tiles = {}
    masts, taxi_lights = [], []
    summary = {}
    for icao, ap in aps.items():
        cfg = AIRFIELDS[icao]
        rws = runway_frames(ap)
        ax, az = ap['x'], ap['z']
        R = max(math.hypot(e['x'] - ax, e['z'] - az) for r in ap['runways'] for e in r['ends']) + 2500

        def near(p):
            return np.min(np.hypot(p[:, 0] - ax, p[:, 1] - az)) < R

        taxi, aprons = [], []
        for row in rows:
            kind, parts = parse_wkb(row['geometry'])
            if kind is None:
                continue
            if row['class'] == 'taxiway' and kind == 'line':
                for ll in parts:
                    x, z = grid.lonlat_to_xz(ll[:, 0], ll[:, 1])
                    p = np.column_stack([x, z])
                    if len(p) >= 2 and near(p):
                        w = to_float(tag(row, 'width'))
                        taxi.append((p, w if w and 6 <= w <= 40 else None))
            elif row['class'] == 'apron' and kind == 'polygon':
                for rings in parts:
                    xy = []
                    for ll in rings:
                        x, z = grid.lonlat_to_xz(ll[:, 0], ll[:, 1])
                        xy.append(np.column_stack([x, z]))
                    if near(xy[0]):
                        aprons.append(xy)

        # ---- taxiways: cut out of the runways, holding positions, clip to tiles ----
        pieces = []
        for p, w in taxi:
            s = cumlen(p)
            if s[-1] < 5:
                continue
            keep = [(0.0, s[-1])]
            for rw in rws:
                rect = rw['rect']
                for ia, ib in rect_intervals(p, s, (rect[0], rect[1], rect[2], rect[3], rect[4], rect[5])):
                    nk = []
                    for ka, kb in keep:
                        if ib <= ka or ia >= kb:
                            nk.append((ka, kb))
                            continue
                        if ia > ka:
                            nk.append((ka, ia))
                        if ib < kb:
                            nk.append((ib, kb))
                    keep = nk
            for ka, kb in keep:
                if kb - ka < 3:
                    continue
                q = cut(p, s, ka, kb)
                if q is None:
                    continue
                q = simplify(q, 0.1)
                pieces.append(dict(p=q, u0=ka, w=w or cfg['taxi_w']))
        n_holds = 0
        for pc in pieces:
            q = pc['p']
            qs = cumlen(q)
            holds = []
            for rw in rws:
                ux, uz = rw['ux'], rw['uz']
                mx, mz = rw['mid']
                along = (q[:, 0] - mx) * ux + (q[:, 1] - mz) * uz
                lat = np.abs(-(q[:, 0] - mx) * uz + (q[:, 1] - mz) * ux)
                f = lat - cfg['hold_m']
                for k in range(len(q) - 1):
                    if f[k] * f[k + 1] >= 0 or f[k] == f[k + 1]:
                        continue
                    t = f[k] / (f[k] - f[k + 1])
                    if abs(along[k] + t * (along[k + 1] - along[k])) > rw['hl'] + 150:
                        continue
                    seg = q[k + 1] - q[k]
                    L = math.hypot(seg[0], seg[1])
                    cosang = abs(seg[0] * ux + seg[1] * uz) / max(L, 1e-9)
                    if cosang > math.cos(math.radians(25)):
                        continue                      # parallel to the runway: not a runway entry
                    u = qs[k] + t * (qs[k + 1] - qs[k])
                    holds.append((float(u), 1 if f[k + 1] < f[k] else -1))
            pc['holds'] = holds
            n_holds += len(holds)

        flags = 64 if cfg['edge_marks'] else 0
        km = 0.0
        for pc in pieces:
            q, u0, w = pc['p'], pc['u0'], pc['w']
            km += cumlen(q)[-1] / 1000
            for ix, iz, part, pu0 in clip_parts(q, u0):
                if not (0 <= ix < grid.NTILES and 0 <= iz < grid.NTILES):
                    continue
                x0, z0 = grid.tile_origin(ix, iz)
                pl = cumlen(part)
                lo = pu0 - u0
                hs = [[round(u - lo, 2), d] for u, d in pc['holds'] if lo - 60 < u < lo + pl[-1] + 60]
                rec = dict(cls=12, flags=flags, lanes=1, cw=round(w, 2), left=cfg['shoulder'], right=cfg['shoulder'],
                           u0=round(pu0, 2), pts=[round(float(v), 2) for v in (part - (x0, z0)).ravel()], holds=hs)
                tiles.setdefault(f'{ix},{iz}', dict(taxiways=[], aprons=[]))['taxiways'].append(rec)
            # blue edge lights along both edges every 30 m, away from the runways and other taxiways
            if cfg['taxi_lights']:
                off = w / 2 + cfg['shoulder'] + 0.6
                qs = cumlen(q)
                n = max(1, int(qs[-1] / 30))
                for k in range(n + 1):
                    sk = qs[-1] * k / n
                    i = min(int(np.searchsorted(qs, sk, 'right')) - 1, len(q) - 2)
                    d = q[i + 1] - q[i]
                    L = math.hypot(d[0], d[1]) or 1
                    t = (sk - qs[i]) / L
                    c = q[i] + d * t
                    rx, rz = -d[1] / L, d[0] / L
                    for sgn in (1, -1):
                        lx, lz = c[0] + sgn * rx * off, c[1] + sgn * rz * off
                        if any(abs(-(lx - rw['mid'][0]) * rw['uz'] + (lz - rw['mid'][1]) * rw['ux']) < rw['hw'] + 35
                               and abs((lx - rw['mid'][0]) * rw['ux'] + (lz - rw['mid'][1]) * rw['uz']) < rw['hl'] + 300 for rw in rws):
                            continue
                        if on_other_taxiway(lx, lz, pc, pieces):
                            continue
                        taxi_lights.append([round(lx, 2), round(lz, 2)])

        # ---- aprons: holes bridged, ear clipped, runways cut out, clipped to tiles; floodlight masts ----
        n_tris, area = 0, 0.0
        for rings in aprons:
            outer = rings[0][:-1] if (rings[0][0] == rings[0][-1]).all() else rings[0]
            if area2(outer) < 0:
                outer = outer[::-1]
            holes = []
            for h in rings[1:]:
                h = h[:-1] if (h[0] == h[-1]).all() else h
                holes.append(h if area2(h) < 0 else h[::-1])
            ring = eliminate_holes(outer, holes) if holes else outer
            tris = ear_clip(ring)
            a_tot = abs(area2(outer)) / 2 - sum(abs(area2(h)) / 2 for h in holes)
            area += a_tot
            # main axis: the longest edge of the outer ring (slab joints follow it)
            e = np.diff(np.vstack([outer, outer[:1]]), axis=0)
            k = int(np.argmax(np.hypot(e[:, 0], e[:, 1])))
            axis = e[k] / (np.hypot(e[k, 0], e[k, 1]) or 1)
            for tri in tris:
                parts = [tri]
                for rw in rws:
                    rect = rw['rect']
                    nxt = []
                    for pp in parts:
                        nxt += minus_rect(pp, rect)
                    parts = nxt
                for pp in parts:
                    for ix, iz, piece in clip_tiles_poly(pp):
                        x0, z0 = grid.tile_origin(ix, iz)
                        loc = piece - (x0, z0)
                        tl = []
                        for m in range(1, len(loc) - 1):
                            tl += [loc[0], loc[m], loc[m + 1]]
                        if not tl:
                            continue
                        n_tris += len(tl) // 3
                        flat = [round(float(v), 2) for v in np.array(tl).ravel()]
                        t_ = tiles.setdefault(f'{ix},{iz}', dict(taxiways=[], aprons=[]))
                        t_['aprons'].append(dict(cls=13, flags=0, tris=flat, axis=[round(float(axis[0]), 5), round(float(axis[1]), 5)]))
            if cfg['flood'] > 0 and a_tot > 12000:
                per = np.vstack([outer, outer[:1]])
                ps = cumlen(per)
                n = max(2, int(ps[-1] / 110))
                for kk in range(n):
                    sk = ps[-1] * kk / n
                    i = min(int(np.searchsorted(ps, sk, 'right')) - 1, len(per) - 2)
                    d = per[i + 1] - per[i]
                    L = math.hypot(d[0], d[1]) or 1
                    c = per[i] + d * ((sk - ps[i]) / L)
                    # just outside the apron (the outer ring is counter-clockwise: outward is the right)
                    mx, mz = c[0] - d[1] / L * 6, c[1] + d[0] / L * 6
                    masts.append([round(float(mx), 1), round(float(mz), 1), cfg['mast_h'], cfg['flood']])
        summary[icao] = dict(taxiways=len(pieces), taxiway_km=round(km, 1), holds=n_holds, aprons=len(aprons),
                             apron_m2=round(area), apron_triangles=n_tris)
        log(f'{icao}: {summary[icao]}')

    # runway light configuration, lighted runways only (AirportLights lays them out on airports.json)
    rl = {}
    for icao, ends in RUNWAY_LIGHTS.items():
        ap = aps.get(icao)
        if not ap:
            continue
        lit_ids = {e['id'] for r in ap['runways'] if r.get('lighted', True) for e in r['ends']}
        rl[icao] = {k: v for k, v in ends.items() if k in lit_ids}
    odir = os.path.join(out, 'airfields')
    os.makedirs(odir, exist_ok=True)
    doc = dict(version=VERSION, format='ROADS.md', release=RELEASE, attribution=ATTRIBUTION, tile_m=T,
               origin=[-grid.CORE_HALF, -grid.CORE_HALF], tiles=tiles, masts=masts, taxiLights=taxi_lights,
               runwayLights=rl, airfields=summary, built=time.strftime('%Y-%m-%d %H:%M:%S'))
    path = os.path.join(odir, 'airfields.json')
    with open(path + '.tmp', 'w') as f:
        json.dump(doc, f, separators=(',', ':'), ensure_ascii=False)
    os.replace(path + '.tmp', path)
    log(f'{len(tiles)} tiles, {len(masts)} masts, {len(taxi_lights)} taxiway lights -> {path} '
        f'({os.path.getsize(path) / 1e6:.2f} MB, {time.time() - t0:.1f} s)')


def on_other_taxiway(x, z, me, pieces):
    """Is (x, z) on the pavement of another taxiway piece (a junction)?"""
    for pc in pieces:
        if pc is me:
            continue
        q = pc['p']
        if x < q[:, 0].min() - 40 or x > q[:, 0].max() + 40 or z < q[:, 1].min() - 40 or z > q[:, 1].max() + 40:
            continue
        a, b = q[:-1], q[1:]
        d = b - a
        L2 = np.maximum((d ** 2).sum(1), 1e-9)
        t = np.clip(((x - a[:, 0]) * d[:, 0] + (z - a[:, 1]) * d[:, 1]) / L2, 0, 1)
        dist = np.hypot(a[:, 0] + t * d[:, 0] - x, a[:, 1] + t * d[:, 1] - z)
        if dist.min() < pc['w'] / 2 + 2.0:
            return True
    return False


def clip_parts(p, u0):
    """Split polyline p at the L0 tile lines; yields (ix, iz, part, u0 of the part)."""
    from roads import clip_tiles
    yield from clip_tiles(p, u0)


def clip_tiles_poly(poly):
    """Convex polygon -> (ix, iz, convex piece) per L0 tile it touches."""
    T, H = grid.TILE_SIZE, grid.CORE_HALF
    i0, i1 = int(math.floor((poly[:, 0].min() + H) / T)), int(math.floor((poly[:, 0].max() + H) / T))
    j0, j1 = int(math.floor((poly[:, 1].min() + H) / T)), int(math.floor((poly[:, 1].max() + H) / T))
    for iz in range(j0, j1 + 1):
        for ix in range(i0, i1 + 1):
            if not (0 <= ix < grid.NTILES and 0 <= iz < grid.NTILES):
                continue
            x0, z0 = grid.tile_origin(ix, iz)
            q = poly
            for a, b, c in ((1, 0, -x0), (-1, 0, x0 + T), (0, 1, -z0), (0, -1, z0 + T)):
                q = clip_poly(q, a, b, c) if q is not None else None
            if q is not None and abs(area2(q)) > 1e-4:
                yield ix, iz, q


# ---------------------------------------------------------------------------------------------
# runways: the paved runway surfaces of js/world/Runways.js (ROADS.md "runways.json")
#
# Built from the terrain's data alone (airports.json, the L0 imagery) and the taxiways of
# airfields.json when it is there, so this stage runs without the Overture download.

# Per airfield: military (arresting gear near both ends of the runways of 2000 m and more,
# distance-remaining signs every 1000 ft), paved shoulder each side of the runways 30 m wide or
# more (ICAO Annex 14 3.2.9: 60 m overall for a 45 m runway, 7.5 m each side), and how worn
# the paint is (0 fresh .. 1 faded: a closed field).
RUNWAY_SURFACE = {
    'LLBG': dict(military=False, shoulder=7.5, wear=0.3),
    'LLEK': dict(military=True, shoulder=7.5, wear=0.5),
    'LLHS': dict(military=True, shoulder=7.5, wear=0.5),
    'LL59': dict(military=False, shoulder=3.0, wear=0.55),
    'LLHZ': dict(military=False, shoulder=0.0, wear=0.6),
    'LLRS': dict(military=False, shoulder=0.0, wear=0.6),
    'IL-0023': dict(military=False, shoulder=3.0, wear=1.0),
}
# paved overruns the terrain data measured too short (js/terrain/Surface.js OVERRUN_FIX, the same
# table: the runtime draws the larger of the two)
OVERRUN_FIX = {'LLEK 36': 390.0, 'LLEK 15R': 390.0, 'LL59 21': 300.0}
STRIP_S, STRIP_T = 1024, 32          # imagery strip of a runway: samples along, rows across
STRIP_END = 12.0                     # m of strip beyond each pavement end
STRIP_SIDE = 4.0                     # and beyond each shoulder
CABLE_FROM_THR = 460.0               # arresting gear (BAK-12): cable this far past each threshold (m)
RUBBER_DARK = 0.3                    # rubber deposit / clean pavement albedo (Runways.js the same)
CONCRETE_RATIO = 1.10                # an end this much lighter than the middle is concrete
CONCRETE_MAX = 330.0                 # concrete end sections reach at most this far past the threshold (m)


class L0Mosaic:
    """Bilinear samples (sRGB 0..255) of the terrain's L0 imagery (color/L0, 6.25 m / px) at world x, z."""

    def __init__(self, folder):
        self.folder, self.cache = folder, {}

    def tile(self, ix, iz):
        from PIL import Image
        k = (ix, iz)
        if k not in self.cache:
            p = os.path.join(self.folder, f'tile_{ix}_{iz}.jpg')
            self.cache[k] = np.asarray(Image.open(p).convert('RGB'), np.float32) if os.path.exists(p) else None
        return self.cache[k]

    def sample(self, x, z):
        n = grid.NTILES * 1024
        px = grid.TILE_SIZE / 1024.0
        gx, gz = (x + grid.CORE_HALF) / px - 0.5, (z + grid.CORE_HALF) / px - 0.5
        i0, j0 = np.floor(gx).astype(np.int64), np.floor(gz).astype(np.int64)
        fx, fz = gx - i0, gz - j0
        out = np.zeros(x.shape + (3,), np.float32)
        for dj in (0, 1):
            for di in (0, 1):
                ii, jj = np.clip(i0 + di, 0, n - 1), np.clip(j0 + dj, 0, n - 1)
                w = (fx if di else 1 - fx) * (fz if dj else 1 - fz)
                tx, tz = ii // 1024, jj // 1024
                vals = np.zeros(x.shape + (3,), np.float32)
                for a, b in set(zip(tx.ravel().tolist(), tz.ravel().tolist())):
                    m = (tx == a) & (tz == b)
                    im = self.tile(a, b)
                    if im is not None:
                        vals[m] = im[jj[m] - b * 1024, ii[m] - a * 1024]
                out += vals * w[..., None]
        return out


def srgb_to_linear(c):
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v):
    v = np.clip(np.asarray(v, np.float64), 0, 1)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055) * 255.0


def paint_mask(S, Tt, L, hw, disp):
    """Strip samples where the imagery shows paint (Sentinel-2's 10 m pixels spread it over ~12 m):
    the threshold stripes and designation, the aiming points and touchdown zone stripes, the arrows
    before a displaced threshold (js/world/runwayShaders.js lays them out the same way)."""
    m = np.zeros(S.shape, bool)
    at = np.abs(Tt)
    for end in (0, 1):
        e = S if end == 0 else L - S
        ed = e - disp[end]
        m |= (ed > -14) & (ed < 86) & (at < hw + 6)
        m |= (ed > 388) & (ed < 462) & (at > 3) & (at < hw)
        for e0 in (150, 300, 600, 750, 900):
            m |= (ed > e0 - 12) & (ed < e0 + 34.5) & (at > 3) & (at < hw - 2)
        if disp[end] > 0:
            m |= (e > -2) & (ed < 0) & (at < 8)
    return m


def inpaint_rows(V, M):
    """Masked samples of each row (along s) filled by linear interpolation between the kept ones."""
    out = V.copy()
    idx = np.arange(V.shape[1])
    for r in range(V.shape[0]):
        ok = ~M[r]
        if ok.sum() >= 2 and (~ok).any():
            out[r, ~ok] = np.interp(idx[~ok], idx[ok], V[r, ok])
    return out


def runway_turnoffs(af_doc, frames):
    """Where the taxiways of airfields.json meet each runway's side: [runway index, s, side, ds, dt]
    (s along the runway from end 0, side +1 right / -1 left of end 0 -> end 1, (ds, dt) the
    taxiway's direction there, away from the runway). The aircraft's tyres leave curved marks
    between the centreline and these (js/world/runwayShaders.js turn-off marks)."""
    out = []
    if not af_doc:
        return out
    ox, oz = af_doc.get('origin', [-grid.CORE_HALF, -grid.CORE_HALF])
    T = af_doc.get('tile_m', grid.TILE_SIZE)
    for key, tile in af_doc.get('tiles', {}).items():
        ix, iz = (int(v) for v in key.split(','))
        x0, z0 = ox + ix * T, oz + iz * T
        for tw in tile.get('taxiways', []):
            p = np.array(tw['pts'], np.float64).reshape(-1, 2) + (x0, z0)
            if len(p) < 2:
                continue
            for P, Q in ((p[0], p[1]), (p[-1], p[-2])):
                for k, fr in enumerate(frames):
                    d = P - fr['a']
                    s = d[0] * fr['u'][0] + d[1] * fr['u'][1]
                    t = -d[0] * fr['u'][1] + d[1] * fr['u'][0]
                    if abs(abs(t) - fr['hw']) > 3.0 or not (40 < s < fr['L'] - 40):
                        continue
                    v = Q - P
                    lv = math.hypot(v[0], v[1])
                    if lv < 1e-6:
                        continue
                    ds = (v[0] * fr['u'][0] + v[1] * fr['u'][1]) / lv
                    dt = (-v[0] * fr['u'][1] + v[1] * fr['u'][0]) / lv
                    if dt * t <= 0.2 * abs(t):     # must lead away from the runway
                        continue
                    out.append([k, round(float(s), 1), 1 if t > 0 else -1, round(float(ds), 3), round(float(dt), 3)])
    # one per junction (taxiway pieces are cut at L0 tile lines and at each other)
    out.sort()
    uniq = []
    for r in out:
        if uniq and uniq[-1][0] == r[0] and uniq[-1][2] == r[2] and abs(uniq[-1][1] - r[1]) < 15:
            continue
        uniq.append(r)
    return uniq


def build_runways(out, terrain_dir):
    """runways.json + runways.bin (ROADS.md): per paved runway its frame, shoulders, overruns,
    concrete ends, arresting gear, distance-remaining signs, crossings, turn-offs and lights,
    and a strip of the imagery with the paint taken out (RGB, sRGB) and the share of the pavement
    the imagery shows darkened by rubber and oil (A)."""
    from scipy import ndimage
    t0 = time.time()
    with open(os.path.join(terrain_dir, 'airports.json')) as f:
        airports = json.load(f)
    af_path = os.path.join(out, 'airfields', 'airfields.json')
    af_doc = None
    if os.path.exists(af_path):
        with open(af_path) as f:
            af_doc = json.load(f)
    mosaic = L0Mosaic(os.path.join(terrain_dir, 'color', 'L0'))
    lum_w = np.array([0.2126, 0.7152, 0.0722])
    recs, strips, frames = [], [], []
    for ap in airports:
        icao = ap['icao']
        cfg = RUNWAY_SURFACE.get(icao, dict(military=False, shoulder=0.0, wear=0.6))
        closed = bool(ap.get('closed'))
        lights = RUNWAY_LIGHTS.get(icao, {})
        for r in ap['runways']:
            surf = (r.get('surface') or 'asphalt').lower()
            if any(k in surf for k in ('grass', 'turf', 'dirt', 'gravel', 'sand')):
                continue
            a, b = r['ends']
            dx, dz = b['x'] - a['x'], b['z'] - a['z']
            L = math.hypot(dx, dz)
            if L < 10:
                continue
            ux, uz = dx / L, dz / L
            hw = (r.get('width_m') or 45.0) / 2
            ov = [min(max(float(a.get('overrun_m') or 0), OVERRUN_FIX.get(f"{icao} {a['id']}", 0.0)), 1000.0),
                  min(max(float(b.get('overrun_m') or 0), OVERRUN_FIX.get(f"{icao} {b['id']}", 0.0)), 1000.0)]
            disp = [float(a.get('displaced_threshold_m') or 0), float(b.get('displaced_threshold_m') or 0)]
            sh = cfg['shoulder'] if hw >= 15 else 0.0
            # the strip: samples at cell centres over s in [s0, s1] (from end 0), t in [-T, T]
            s0, s1 = -ov[0] - STRIP_END, L + ov[1] + STRIP_END
            T = hw + sh + STRIP_SIDE
            s = s0 + (np.arange(STRIP_S) + 0.5) * (s1 - s0) / STRIP_S
            t = -T + (np.arange(STRIP_T) + 0.5) * (2 * T) / STRIP_T
            S, Tt = np.meshgrid(s, t)
            ds = (s1 - s0) / STRIP_S
            rgb = mosaic.sample(a['x'] + S * ux - Tt * uz, a['z'] + S * uz + Tt * ux)
            lin = srgb_to_linear(rgb)
            # paint out: masked samples filled along each row from the unpainted ones
            M = paint_mask(S, Tt, L, hw, disp)
            for c in range(3):
                lin[..., c] = inpaint_rows(lin[..., c], M)
            # the pavement's edges and ends: the 10 m pixels there mix in the soil beyond, so the
            # outer rows and columns repeat the last ones fully on the pavement
            inner = np.abs(t) <= max(hw - 6.0, 1.0)
            rows = np.nonzero(inner)[0]
            for j in range(STRIP_T):
                if not inner[j]:
                    lin[j] = lin[rows[0] if t[j] < 0 else rows[-1]]
            c0 = int(np.searchsorted(s, -ov[0] + 6.0))
            c1 = int(np.searchsorted(s, L + ov[1] - 6.0)) - 1
            lin[:, :c0] = lin[:, c0:c0 + 1]
            lin[:, c1 + 1:] = lin[:, c1:c1 + 1]
            # smooth the 6.25 m pixels (~4 m along, ~2 m across)
            for c in range(3):
                lin[..., c] = ndimage.gaussian_filter(lin[..., c], (2.0 / (2 * T / STRIP_T), 4.0 / ds), mode='nearest')
            Y = lin @ lum_w
            # rubber and oil: how much darker than the clean pavement beside it (the 85th percentile
            # across the runway, over ~60 m along), as the share m of the surface covered by deposits
            # RUBBER_DARK as dark as the pavement: Y = P (1 - (1 - RUBBER_DARK) m)
            P = np.percentile(Y[inner], 85, axis=0)
            P = ndimage.maximum_filter1d(P, max(1, int(round(30 / ds))), mode='nearest')
            P = ndimage.uniform_filter1d(P, max(1, int(round(60 / ds))), mode='nearest')
            m = np.clip((1 - Y / np.maximum(P, 1e-4)) / (1 - RUBBER_DARK), 0, 0.9)
            m = np.where(m < 0.04, 0.0, m)
            m[~inner] = 0.0
            m = ndimage.gaussian_filter(m, (0.7, 3.0 / ds), mode='nearest')
            # concrete ends (military fields: rigid pavement where the jets hold, run up and take the
            # cables): the clean pavement clearly lighter than the runway's middle, from the pavement
            # end inwards, at most CONCRETE_MAX past the threshold
            prof = P
            mid = (s > 0.3 * L) & (s < 0.7 * L)
            ref = float(np.median(prof[mid]))
            ratio = ndimage.uniform_filter1d(prof, max(1, int(round(40 / ds))), mode='nearest') / max(ref, 1e-6)
            conc = [0.0, 0.0]
            for end in (0, 1):
                idx = np.nonzero((s >= -ov[0]) & (s <= L + ov[1]))[0]
                if end == 1:
                    idx = idx[::-1]
                bright = ratio[idx] > CONCRETE_RATIO
                if not cfg['military'] or bright[: max(1, int(round(60 / ds)))].mean() < 0.7:
                    continue
                k = 0
                while k < len(idx) and (bright[k] or bright[k:k + max(1, int(round(25 / ds)))].any()):
                    k += 1
                edge = float(s[idx[min(k, len(idx) - 1)]])
                lim = min(0.35 * L, CONCRETE_MAX + disp[end])
                conc[end] = round(min(edge + ov[0], lim + ov[0]) if end == 0 else min(L + ov[1] - edge, lim + ov[1]), 1)
            # rubber of each touchdown zone (its share of the landings): deposits 150..900 m past the threshold
            rub = []
            for end in (0, 1):
                ed = (s if end == 0 else L - s) - disp[end]
                zone = (ed > 150) & (ed < 900)
                rub.append(round(float(m[np.ix_(np.abs(t) < 0.3 * hw, zone)].mean()) if zone.any() else 0.0, 3))
            cables = []
            if cfg['military'] and L >= 2000 and not closed:
                cables = [round(disp[0] + CABLE_FROM_THR, 1), round(L - disp[1] - CABLE_FROM_THR, 1)]
            # distance-remaining signs every 1000 ft both sides (FAA AC 150/5340-18: the excess over
            # whole thousands split between the ends); [s, thousands of feet left towards end 1, to end 0]
            dtg = []
            if cfg['military'] and L >= 1500 and not closed:
                n = int(L / 304.8)
                first = (L - (n - 1) * 304.8) / 2
                for k in range(n):
                    sk = first + k * 304.8
                    dtg.append([round(sk, 1), int(round((L - sk) / 304.8)), int(round(sk / 304.8))])
            li = [lights.get(a['id']) or {}, lights.get(b['id']) or {}]
            lit = bool(r.get('lighted', True)) and not closed
            strip = np.zeros((STRIP_T, STRIP_S, 4), np.uint8)
            strip[..., :3] = np.clip(np.round(linear_to_srgb(lin)), 0, 255).astype(np.uint8)
            strip[..., 3] = np.clip(np.round(m * 255), 0, 255).astype(np.uint8)
            recs.append(dict(
                icao=icao, ids=[a['id'], b['id']], len=round(L, 2), hw=round(hw, 2), sh=sh, ov=ov, disp=disp,
                layer=len(strips), strip=[round(s0, 2), round(s1, 2), round(T, 2)], conc=conc, rubber=rub,
                tone=round(ref, 4), cables=cables, dtg=dtg, military=cfg['military'], wear=cfg['wear'],
                closed=closed, lit=lit, cl=[bool(lit and li[0].get('cl')), bool(lit and li[1].get('cl'))],
                tdzl=[bool(lit and li[0].get('tdz')), bool(lit and li[1].get('tdz'))], cross=[], turns=[]))
            frames.append(dict(a=np.array([a['x'], a['z']]), u=(ux, uz), L=L, hw=hw, ov=ov, sh=sh, icao=icao))
            strips.append(strip)
            log(f"runway {icao} {a['id']}/{b['id']}: pavement {ref:.3f}, concrete {conc[0]:.0f} / {conc[1]:.0f} m from the ends, "
                f"rubber {rub}, {len(cables)} cables, {len(dtg)} signs a side, overruns {ov[0]:.0f} / {ov[1]:.0f} m")
    # crossing runways: the longer (then wider) one keeps its surface and markings through the
    # crossing; the other gives way: [s, t of the other's end 0 in this frame, its direction (cos,
    # sin), its half width with shoulders, its pavement from / to (s along it)]
    for i, A in enumerate(recs):
        for j, B in enumerate(recs):
            if i == j or A['icao'] != B['icao'] or (B['len'], B['hw'], -j) <= (A['len'], A['hw'], -i):
                continue
            fa, fb = frames[i], frames[j]
            d = fb['a'] - fa['a']
            sB, tB = d[0] * fa['u'][0] + d[1] * fa['u'][1], -d[0] * fa['u'][1] + d[1] * fa['u'][0]
            cu = fb['u'][0] * fa['u'][0] + fb['u'][1] * fa['u'][1]
            cv = -fb['u'][0] * fa['u'][1] + fb['u'][1] * fa['u'][0]
            if abs(cv) < 0.05:
                continue
            k = -tB / cv
            sx = sB + cu * k
            if not (-A['ov'][0] - 80 < sx < A['len'] + A['ov'][1] + 80) or not (-B['ov'][0] - 80 < k < B['len'] + B['ov'][1] + 80):
                continue
            A['cross'].append([round(sB, 2), round(tB, 2), round(cu, 6), round(cv, 6), round(B['hw'] + B['sh'], 2),
                               round(-B['ov'][0], 1), round(B['len'] + B['ov'][1], 1)])
    for k, s_, side, ds_, dt_ in runway_turnoffs(af_doc, frames):
        recs[k]['turns'].append([s_, side, ds_, dt_])
    odir = os.path.join(out, 'airfields')
    os.makedirs(odir, exist_ok=True)
    data = np.stack(strips) if strips else np.zeros((0, STRIP_T, STRIP_S, 4), np.uint8)
    path = os.path.join(odir, 'runways.bin')
    with open(path + '.tmp', 'wb') as f:
        f.write(data.tobytes())
    os.replace(path + '.tmp', path)
    doc = dict(version=1, format='ROADS.md', attribution='Runway surfaces: the terrain\'s imagery (Sentinel-2, see the terrain credits) '
               'and airports.json; markings ICAO Annex 14', strip=dict(file='runways.bin', samples=STRIP_S, rows=STRIP_T,
               layers=len(strips), rubberDark=RUBBER_DARK), runways=recs, built=time.strftime('%Y-%m-%d %H:%M:%S'))
    jpath = os.path.join(odir, 'runways.json')
    with open(jpath + '.tmp', 'w') as f:
        json.dump(doc, f, separators=(',', ':'), ensure_ascii=False)
    os.replace(jpath + '.tmp', jpath)
    log(f'{len(recs)} runways ({sum(len(r["turns"]) for r in recs)} turn-offs, {sum(len(r["cross"]) for r in recs)} crossings) '
        f'-> {jpath}, strips {path} ({os.path.getsize(path) / 1e6:.2f} MB, {time.time() - t0:.1f} s)')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cache', default=os.path.join(HERE, '_cache', 'airfields'), help='download cache (git-ignored)')
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', 'data', 'world'), help='data folder (airfields/ goes in it)')
    ap.add_argument('--stages', default='fetch,build,runways', help='comma list: fetch,build,runways')
    ap.add_argument('--terrain', default=None, help='terrain data folder (airports.json, color/L0); default: beside --out')
    args = ap.parse_args()
    cache = os.path.abspath(args.cache)
    os.makedirs(cache, exist_ok=True)
    gi = os.path.join(cache, '.gitignore')
    if not os.path.exists(gi):
        with open(gi, 'w') as f:
            f.write('*\n')
    out = os.path.abspath(args.out)
    terrain_dir = os.path.join(out, '..', 'terrain') if os.path.isdir(os.path.join(out, '..', 'terrain')) \
        else os.path.join(HERE, '..', '..', 'data', 'terrain')
    if args.terrain:
        terrain_dir = os.path.abspath(args.terrain)
    with open(os.path.join(terrain_dir, 'airports.json')) as f:
        airports = json.load(f)
    stages = [s.strip() for s in args.stages.split(',') if s.strip()]
    if 'fetch' in stages:
        fetch(cache, airports)
    if 'build' in stages:
        build(cache, out)
    if 'runways' in stages:
        build_runways(out, terrain_dir)


if __name__ == '__main__':
    main()
