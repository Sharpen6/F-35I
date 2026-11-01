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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cache', default=os.path.join(HERE, '_cache', 'airfields'), help='download cache (git-ignored)')
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', 'data', 'world'), help='data folder (airfields/ goes in it)')
    ap.add_argument('--stages', default='fetch,build', help='comma list: fetch,build')
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
    with open(os.path.join(terrain_dir, 'airports.json')) as f:
        airports = json.load(f)
    stages = [s.strip() for s in args.stages.split(',') if s.strip()]
    if 'fetch' in stages:
        fetch(cache, airports)
    if 'build' in stages:
        build(cache, out)


if __name__ == '__main__':
    main()
