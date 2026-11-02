"""Roads and railways for the F-35I sim: Overture Maps transportation segments -> compact tiles.

    python3 sim/tools/world/roads.py [--cache DIR] [--out sim/data/world] [--stages fetch,build,check]

Stages:
  fetch   reads the transportation theme (type=segment, subtypes road and rail) of an Overture
          release for the core from the public bucket s3://overturemaps-us-west-2 (anonymous HTTPS
          range requests: only the parquet footers and the row groups whose bbox statistics touch
          the core, ~100 MB) and keeps the rows in <cache>/segments.parquet.
  build   classifies every segment (sim/tools/world/ROADS.md), projects it into the world frame
          of sim/DESIGN.md (sim/tools/terrain/grid.py), cuts tunnels out, finds the junctions
          (shared connectors) and clips the polylines to the terrain's L0 tiles (6400 m). Writes
          <out>/roads/tile_<ix>_<iz>.bin and <out>/roads/index.json.
  check   rasterises the paved roads of a few tiles and measures their offset against the L0
          imagery (cross-correlation of the road mask with the darkness of the imagery), so a
          systematic shift between OpenStreetMap and the Sentinel-2 composite would show.

Data: OpenStreetMap contributors (ODbL 1.0), via Overture Maps Foundation (transportation theme).
Tile format: see ROADS.md.
"""
import argparse
import io
import json
import math
import os
import re
import shutil
import struct
import sys
import time
import urllib.parse
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'terrain'))
import grid  # noqa: E402  (the terrain tools' projection and tile layout)

RELEASE = 'release/2026-10-21.0'
BASE = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com'
# lon/lat box around the 102.4 km core (with ~2 km to spare)
CORE_BBOX = (34.43, 31.32, 35.62, 32.28)
ATTRIBUTION = ('Roads and railways: (c) OpenStreetMap contributors, ODbL 1.0, via Overture Maps Foundation '
               f'(transportation theme, {RELEASE.split("/")[1]})')
TILE_VERSION = 1


def log(*a):
    print('  [roads]', *a, flush=True)


# ---------------------------------------------------------------------------------------------
# Overture over HTTP (anonymous range requests, no AWS SDK needed)

def urlopen(req, timeout=120, tries=6):
    """urllib.request.urlopen with retries: the proxy and S3 drop a connection now and then."""
    for k in range(tries):
        try:
            r = urllib.request.urlopen(req, timeout=timeout)
            return r, r.read()
        except OSError:
            if k == tries - 1:
                raise
            time.sleep(2 + 4 * k)


def list_keys(prefix):
    out, token = [], None
    while True:
        q = f'{BASE}/?list-type=2&prefix={urllib.parse.quote(prefix)}'
        if token:
            q += '&continuation-token=' + urllib.parse.quote(token)
        xml = urlopen(q, timeout=60)[1].decode()
        out += re.findall(r'<Key>([^<]+)</Key>', xml)
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', xml)
        if not m:
            return out
        token = m.group(1)


class RangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests (what pyarrow needs for a parquet file)."""

    def __init__(self, url):
        super().__init__()
        self.url, self.pos, self.nbytes = url, 0, 0
        r, _ = urlopen(urllib.request.Request(url, method='HEAD'), timeout=60)
        self.size = int(r.headers['Content-Length'])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        if n == 0:
            return b''
        req = urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{self.pos + n - 1}'})
        data = urlopen(req, timeout=180)[1]
        self.pos += len(data)
        self.nbytes += len(data)
        return data

    def readinto(self, buf):
        d = self.read(len(buf))
        buf[:len(d)] = d
        return len(d)


def row_groups_in_bbox(prefix, bbox, cache_json):
    """[(key, [row group indices])] of the parquet files under prefix whose bbox statistics touch
    bbox. The footer scan (all files, ~260 MB of footers for the segments) is cached."""
    import pyarrow.parquet as pq
    if os.path.exists(cache_json):
        with open(cache_json) as f:
            d = json.load(f)
        if d.get('prefix') == prefix and d.get('bbox') == list(bbox):
            return [(k, rgs) for k, rgs in d['hits']]
    W, S, E, N = bbox
    hits, nbytes, t0 = [], 0, time.time()
    keys = [k for k in list_keys(prefix) if k.endswith('.parquet')]
    for i, key in enumerate(keys):
        f = RangeFile(f'{BASE}/{key}')
        md = pq.ParquetFile(f).metadata
        ix = {md.schema.column(c).path: c for c in range(md.num_columns)}
        keep = []
        for rg in range(md.num_row_groups):
            g = md.row_group(rg)
            st = {k: g.column(ix['bbox.' + k]).statistics for k in ('xmin', 'xmax', 'ymin', 'ymax')}
            if all(s is not None and s.has_min_max for s in st.values()) and (
                    st['xmax'].max < W or st['xmin'].min > E or st['ymax'].max < S or st['ymin'].min > N):
                continue
            keep.append(rg)
        if keep:
            hits.append((key, keep))
        nbytes += f.nbytes
        if i % 16 == 15:
            log(f'footers {i + 1}/{len(keys)} ({nbytes / 1e6:.0f} MB, {time.time() - t0:.0f} s)')
    with open(cache_json, 'w') as f:
        json.dump(dict(prefix=prefix, bbox=list(bbox), hits=hits), f)
    return hits


SEGMENT_COLUMNS = ['id', 'subtype', 'class', 'subclass', 'names.primary', 'road_surface', 'road_flags', 'rail_flags',
                   'width_rules', 'level_rules', 'access_restrictions', 'routes', 'connectors', 'geometry', 'bbox']


def fetch(cache):
    """Overture segments (roads and railways) of the core -> <cache>/segments.parquet."""
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    out = os.path.join(cache, 'segments.parquet')
    if os.path.exists(out):
        log(f'{out} exists: fetch skipped (delete it to fetch again)')
        return out
    prefix = f'{RELEASE}/theme=transportation/type=segment/'
    hits = row_groups_in_bbox(prefix, CORE_BBOX, os.path.join(cache, 'segment_rowgroups.json'))
    W, S, E, N = CORE_BBOX
    tables, nbytes, t0 = [], 0, time.time()
    for key, rgs in hits:
        f = RangeFile(f'{BASE}/{key}')
        pf = pq.ParquetFile(f)
        cols = [c for c in SEGMENT_COLUMNS if c.split('.')[0] in pf.schema_arrow.names]
        for rg in rgs:
            t = pf.read_row_group(rg, columns=cols)
            bb = t.column('bbox')
            m = pc.and_(pc.and_(pc.greater_equal(pc.struct_field(bb, 'xmax'), W), pc.less_equal(pc.struct_field(bb, 'xmin'), E)),
                        pc.and_(pc.greater_equal(pc.struct_field(bb, 'ymax'), S), pc.less_equal(pc.struct_field(bb, 'ymin'), N)))
            m = pc.and_(m, pc.is_in(t.column('subtype'), pa.array(['road', 'rail'])))
            t = t.filter(m)
            if t.num_rows:
                tables.append(t)
            log(f'{key.split("/")[-1][:14]} rg {rg}: {t.num_rows} rows ({(nbytes + f.nbytes) / 1e6:.0f} MB, {time.time() - t0:.0f} s)')
        nbytes += f.nbytes
    table = pa.concat_tables(tables, promote_options='permissive')
    pq.write_table(table, out + '.tmp', compression='zstd')
    os.replace(out + '.tmp', out)
    log(f'{table.num_rows} segments, {nbytes / 1e6:.0f} MB read -> {out}')
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cache', default=os.path.join(HERE, '_cache', 'roads'), help='download cache (git-ignored)')
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', 'data', 'world'), help='data folder (roads/ goes in it)')
    ap.add_argument('--stages', default='fetch,build', help='comma list: fetch,build,check')
    ap.add_argument('--terrain', default=None, help='terrain data folder for check (default <out>/../terrain)')
    args = ap.parse_args()
    cache = os.path.abspath(args.cache)
    os.makedirs(cache, exist_ok=True)
    # the cache ignores itself, so a default cache inside the repository never shows up in git
    gi = os.path.join(cache, '.gitignore')
    if not os.path.exists(gi):
        with open(gi, 'w') as f:
            f.write('*\n')
    stages = [s.strip() for s in args.stages.split(',') if s.strip()]
    if 'fetch' in stages:
        fetch(cache)
    if 'build' in stages:
        build(cache, os.path.abspath(args.out))
    if 'check' in stages:
        check(cache, os.path.abspath(args.out), args.terrain and os.path.abspath(args.terrain))


# ---------------------------------------------------------------------------------------------
# classification: Overture class -> render class and cross-section (ROADS.md has the table)

# Render classes. The ids are in the tiles and in js/world/Roads.js (CLASS); keep them in step.
CLS = dict(motorway=0, motorway_link=1, trunk=2, trunk_link=3, primary=4, secondary=5, tertiary=6,
           residential=7, service=8, track=9, rail=10, light_rail=11, taxiway=12)

# flags (u8) in the tiles
F_ONEWAY, F_BRIDGE, F_URBAN, F_UNPAVED, F_SOLID_CENTRE, F_LIT = 1, 2, 4, 8, 16, 32

# Cross-sections: lanes (oneway carriageway, two-way road), lane width (m), shoulder outside the
# edge line on the right / left of a oneway carriageway (a two-way road has the right one on both
# sides), sidewalk in built-up areas (instead of the shoulder). Israeli practice (Netivei Israel
# design guide): 3.6-3.75 m motorway lanes with a 2.5-3 m right shoulder, 3.3-3.5 m on main roads,
# 2.75-3 m on residential streets, 2-3 m sidewalks.
SECTION = {
    #                 lanes1 lanes2 laneW  shR   shL   walk
    'motorway':      (3,     6,     3.6,   2.5,  1.0,  0.0),
    'motorway_link': (1,     2,     3.8,   2.0,  0.8,  0.0),
    'trunk':         (2,     2,     3.5,   1.5,  0.6,  0.0),
    'trunk_link':    (1,     2,     3.6,   1.5,  0.6,  0.0),
    'primary':       (2,     2,     3.4,   1.0,  0.4,  2.6),
    'secondary':     (2,     2,     3.3,   0.8,  0.3,  2.3),
    'tertiary':      (1,     2,     3.2,   0.5,  0.3,  2.0),
    'residential':   (1,     2,     2.9,   0.0,  0.0,  1.8),
    'service':       (1,     1,     3.5,   0.0,  0.0,  0.0),
    'track':         (1,     1,     3.0,   0.0,  0.0,  0.0),
}
# lanes per direction of named motorways and trunks (OSM names; Overture has no lane counts)
NAMED_LANES = {
    'איילון': 4,                 # Ayalon (Highway 20): 4 lanes and more through Tel Aviv
    'כביש ירושלים תל אביב': 3,    # Highway 1
    'כביש תל אביב ירושלים': 3,
    'כביש החוף': 3,               # Highway 2
    'חוצה ישראל': 3,              # Highway 6
    'מנחם בגין': 3,               # Begin (Jerusalem)
    'כביש גהה': 3,                # Highway 4 through Gush Dan
}
SKIP_ROAD = {'footway', 'steps', 'path', 'cycleway', 'bridleway', 'pedestrian', 'unknown'}
SKIP_SUBCLASS = {'sidewalk', 'crosswalk', 'parking_aisle', 'driveway', 'cycle_crossing'}
RAIL_KEEP = {'standard_gauge': 'rail', 'narrow_gauge': 'rail', 'unknown': 'rail', 'light_rail': 'light_rail', 'tram': 'light_rail'}
UNPAVED = {'unpaved', 'dirt', 'gravel', 'ground', 'sand', 'grass', 'compacted', 'fine_gravel'}

# rail: one track per OSM way; ballast top 3.0 m with 0.7 m slopes, light rail on a 2.8 m bed
RAIL_SECTION = {'rail': (3.0, 0.7), 'light_rail': (2.8, 0.3)}


def classify(subtype, cls, subclass):
    """Overture (subtype, class, subclass) -> render class name, or None to leave it out."""
    if subtype == 'rail':
        return RAIL_KEEP.get(cls)
    if cls in SKIP_ROAD or subclass in SKIP_SUBCLASS:
        return None
    link = subclass == 'link'
    if cls == 'motorway':
        return 'motorway_link' if link else 'motorway'
    if cls == 'trunk':
        return 'trunk_link' if link else 'trunk'
    if cls in ('primary', 'secondary', 'tertiary'):
        # links of the main roads are one-lane ramps
        return 'trunk_link' if link else cls
    if cls in ('residential', 'living_street', 'unclassified'):
        return 'residential'
    if cls == 'service':
        return 'service'
    if cls == 'track':
        return 'track'
    return None


def is_oneway(ar):
    """Overture access_restrictions -> True for a plain one-way road (denied backward, no conditions)."""
    for e in ar or ():
        w = e.get('when') or {}
        if (e.get('access_type') == 'denied' and w.get('heading') == 'backward' and not w.get('mode')
                and not w.get('using') and not w.get('vehicle') and not w.get('during') and not e.get('between')):
            return True
    return False


def ranges(rules, key='values'):
    """[(a, b, value)] from an Overture rule list with optional 'between' [a, b] (fractions)."""
    out = []
    for e in rules or ():
        b = e.get('between')
        a0, a1 = (b[0], b[1]) if b else (0.0, 1.0)
        out.append((float(a0), float(a1), e.get(key)))
    return out


# ---------------------------------------------------------------------------------------------
# geometry helpers (world X / Z in metres)

def parse_line(wkb):
    """WKB LineString (or the first part of a multi) -> (N, 2) lon/lat array, or None."""
    bo = '<' if wkb[0] == 1 else '>'
    t = struct.unpack_from(bo + 'I', wkb, 1)[0] % 1000
    if t == 2:
        n = struct.unpack_from(bo + 'I', wkb, 5)[0]
        return np.frombuffer(wkb, bo + 'f8', 2 * n, 9).reshape(n, 2)
    if t == 5:      # MultiLineString: the parts are separate segments in practice, take the first
        return parse_line(wkb[9:])
    return None


def cumlen(p):
    d = np.hypot(np.diff(p[:, 0]), np.diff(p[:, 1]))
    return np.concatenate([[0.0], np.cumsum(d)])


def cut(p, s, a, b):
    """The part of polyline p (cumulative lengths s) between arc lengths a < b, end points interpolated."""
    a, b = max(a, 0.0), min(b, s[-1])
    if b - a < 1e-6:
        return None
    i0 = int(np.searchsorted(s, a, 'right'))
    i1 = int(np.searchsorted(s, b, 'left'))
    pa = np.array([np.interp(a, s, p[:, 0]), np.interp(a, s, p[:, 1])])
    pb = np.array([np.interp(b, s, p[:, 0]), np.interp(b, s, p[:, 1])])
    mid = p[i0:i1]
    q = np.vstack([pa[None], mid, pb[None]])
    # drop duplicates (a cut exactly on a vertex)
    keep = np.concatenate([[True], np.hypot(np.diff(q[:, 0]), np.diff(q[:, 1])) > 1e-4])
    q = q[keep]
    return q if len(q) >= 2 else None


def simplify(p, tol, keep_idx=()):
    """Douglas-Peucker in metres; vertices in keep_idx (junctions) always stay."""
    n = len(p)
    if n <= 2:
        return p
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    for k in keep_idx:
        if 0 <= k < n:
            keep[k] = True
    anchors = np.nonzero(keep)[0]
    stack = [(int(anchors[i]), int(anchors[i + 1])) for i in range(len(anchors) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        a, b = p[i], p[j]
        ab = b - a
        L = math.hypot(ab[0], ab[1])
        seg = p[i + 1:j] - a
        if L < 1e-9:
            d = np.hypot(seg[:, 0], seg[:, 1])
        else:
            d = np.abs(seg[:, 0] * ab[1] - seg[:, 1] * ab[0]) / L
        k = int(np.argmax(d))
        if d[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return p[keep]


def rect_intervals(p, s, rect):
    """Arc-length intervals of polyline p inside the oriented rectangle rect = (cx, cz, ux, uz, hl, hw)."""
    cx, cz, ux, uz, hl, hw = rect
    out = []
    for k in range(len(p) - 1):
        x0, z0 = p[k] - (cx, cz)
        x1, z1 = p[k + 1] - (cx, cz)
        # into the runway frame (along, across)
        a0, c0 = x0 * ux + z0 * uz, -x0 * uz + z0 * ux
        a1, c1 = x1 * ux + z1 * uz, -x1 * uz + z1 * ux
        t0, t1 = 0.0, 1.0
        ok = True
        for (q0, q1, lim) in ((a0, a1, hl), (c0, c1, hw)):
            dq = q1 - q0
            for sgn in (1, -1):
                # sgn * q <= lim
                num, den = lim - sgn * q0, sgn * dq
                if abs(den) < 1e-12:
                    if num < 0:
                        ok = False
                else:
                    t = num / den
                    if den > 0:
                        t1 = min(t1, t)
                    else:
                        t0 = max(t0, t)
        if ok and t1 > t0:
            L = s[k + 1] - s[k]
            out.append((s[k] + t0 * L, s[k] + t1 * L))
    # merge touching intervals
    out.sort()
    merged = []
    for a, b in out:
        if merged and a <= merged[-1][1] + 1e-6:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def runway_rects(airports, margin=4.0):
    """Paved runway rectangles (with overruns) from airports.json, roads are kept out of them."""
    rects = []
    for ap in airports:
        for r in ap['runways']:
            a, b = r['ends']
            dx, dz = b['x'] - a['x'], b['z'] - a['z']
            L = math.hypot(dx, dz)
            ux, uz = dx / L, dz / L
            oa, ob = a.get('overrun_m', 0) or 0, b.get('overrun_m', 0) or 0
            # centre shifted so the overruns are included
            c = ((a['x'] - ux * oa + b['x'] + ux * ob) / 2, (a['z'] - uz * oa + b['z'] + uz * ob) / 2)
            hl = (L + oa + ob) / 2 + margin
            rects.append((c[0], c[1], ux, uz, hl, r['width_m'] / 2 + margin))
    return rects


class BuiltUp:
    """Built-up land beside the roads: ESA WorldCover class 50 at 10 m (data/terrain/landcover/tile_*.png).

    WorldCover maps a paved road as built-up land wherever it is wider than about a pixel (a
    motorway with its shoulders is 3 - 4 pixels), so sampling a road's own centreline called 98 %
    of the motorways and 91 % of the trunk roads "urban" (zebra crossings and sidewalks on the
    Ayalon). So the road corridors are rasterised first (half the paved width plus 6 m) and taken
    out of the mask: a road is urban when the land beside it, 15 - 120 m beyond its edges on both
    sides, is mostly built-up. Water, no-data and the other roads' corridors count neither way.
    """
    PX = 10.0                                   # m per pixel (the land cover tiles)
    OFFSETS = (15.0, 35.0, 60.0, 90.0, 120.0)   # m beyond the road's edge, both sides

    def __init__(self, terrain_dir):
        from PIL import Image
        t, m = grid.NTILES, grid.LC_TILE_PX
        self.n = t * m
        codes = np.zeros((self.n, self.n), np.uint8)
        for iz in range(t):
            for ix in range(t):
                fn = os.path.join(terrain_dir, 'landcover', f'tile_{ix}_{iz}.png')
                codes[iz * m:(iz + 1) * m, ix * m:(ix + 1) * m] = np.asarray(Image.open(fn))
        self.codes = codes
        self.road = None
        self.near = None

    def set_roads(self, corridors):
        """corridors: [(p (n, 2) world m, half width m)]. Builds the road mask, then the built-up
        share within ~300 m without the roads (40 m grid) that decides street lighting."""
        from PIL import Image, ImageDraw
        from scipy.ndimage import uniform_filter
        img = Image.new('L', (self.n, self.n), 0)
        draw = ImageDraw.Draw(img)
        H, px = grid.CORE_HALF, self.PX
        for p, hw in corridors:
            xy = [(float(x), float(z)) for x, z in zip((p[:, 0] + H) / px - 0.5, (p[:, 1] + H) / px - 0.5)]
            draw.line(xy, fill=1, width=max(1, int(round(2 * hw / px))), joint='curve')
        self.road = np.asarray(img) > 0
        del img, draw
        c = self.codes
        valid = ~self.road & (c != 0) & (c != 80)
        built = valid & (c == 50)
        k = 4                                    # 40 m cells
        m = self.n // k
        vb = valid.reshape(m, k, m, k).mean(axis=(1, 3), dtype=np.float32)
        bb = built.reshape(m, k, m, k).mean(axis=(1, 3), dtype=np.float32)
        fv = uniform_filter(vb, size=7, mode='nearest')
        fb = uniform_filter(bb, size=7, mode='nearest')
        self.near = np.where(fv > 0.02, fb / np.maximum(fv, 1e-6), 0.0).astype(np.float32)
        self._k = k

    def beside(self, p, hw):
        """(built-up share of the land beside polyline p with half width hw, share within ~300 m)."""
        H, px, n = grid.CORE_HALF, self.PX, self.n
        s = cumlen(p)
        L = s[-1]
        m = max(2, int(L / 20) + 1)
        t = np.linspace(0, L, m)
        x, z = np.interp(t, s, p[:, 0]), np.interp(t, s, p[:, 1])
        k = np.clip(np.searchsorted(s, t, 'right') - 1, 0, len(p) - 2)
        dx, dz = p[k + 1, 0] - p[k, 0], p[k + 1, 1] - p[k, 1]
        dl = np.hypot(dx, dz) + 1e-9
        rx, rz = -dz / dl, dx / dl
        off = hw + np.array(self.OFFSETS)
        off = np.concatenate([off, -off])
        X = x[:, None] + rx[:, None] * off[None, :]
        Z = z[:, None] + rz[:, None] * off[None, :]
        i = np.clip(((X + H) / px).astype(int), 0, n - 1)
        j = np.clip(((Z + H) / px).astype(int), 0, n - 1)
        c = self.codes[j, i]
        valid = ~self.road[j, i] & (c != 0) & (c != 80)
        nv = int(valid.sum())
        kk = self._k * px
        ni = np.clip(((x + H) / kk).astype(int), 0, self.near.shape[1] - 1)
        nj = np.clip(((z + H) / kk).astype(int), 0, self.near.shape[0] - 1)
        near = float(np.mean(self.near[nj, ni]))
        if nv < 4:                               # all water, roads or no data around: the wider share
            return near, near
        return float((valid & (c == 50)).sum()) / nv, near


class CoreHeights:
    """The core height tiles (data/terrain/height) as one 4097 x 4097 grid, sampled exactly as the
    terrain renders them (js/terrain/HeightField.js: 25 m cells split along the NW-SE diagonal)."""

    def __init__(self, terrain_dir):
        n = grid.NTILES * (grid.H_TILE_N - 1) + 1
        h = np.zeros((n, n), np.float32)
        m = grid.H_TILE_N - 1
        for iz in range(grid.NTILES):
            for ix in range(grid.NTILES):
                fn = os.path.join(terrain_dir, 'height', f'tile_{ix}_{iz}.bin')
                a = np.fromfile(fn, '<u2').reshape(grid.H_TILE_N, grid.H_TILE_N)
                h[iz * m:iz * m + grid.H_TILE_N, ix * m:ix * m + grid.H_TILE_N] = grid.decode_height(a)
        self.h = h
        self.n = n

    def at(self, x, z):
        gx = (np.asarray(x, np.float64) + grid.CORE_HALF) / grid.H_STEP
        gz = (np.asarray(z, np.float64) + grid.CORE_HALF) / grid.H_STEP
        i = np.clip(np.floor(gx).astype(int), 0, self.n - 2)
        j = np.clip(np.floor(gz).astype(int), 0, self.n - 2)
        fx, fz = np.clip(gx - i, 0, 1), np.clip(gz - j, 0, 1)
        h = self.h
        ha, hb, hc, hd = h[j, i], h[j, i + 1], h[j + 1, i], h[j + 1, i + 1]
        return np.where(fx >= fz, ha + fx * (hb - ha) + fz * (hd - hb), ha + fz * (hc - ha) + fx * (hd - hc))


def bridge_decks(pieces, hts, min_sag=2.0):
    """Deck profiles of the bridges that span a dip in the terrain.

    Bridges come as pieces of segments (Overture splits a viaduct wherever an attribute changes);
    the pieces that share end points form one bridge. Its ends on the ground (where a non-bridge
    road meets it, or a dead end) take the terrain height; the joints in between are interpolated
    along the bridge (harmonic over the joints: linear along a chain), so each piece gets a straight
    deck from height ha at its start to hb at its end. Where the elevation model (a surface model
    at 30 m: the valley under a viaduct, rarely the deck itself) sags more than min_sag below that
    line, the bridge is a deck: js/world/roadMesh.js draws the surface at max(terrain, deck) and adds
    the deck's sides, parapets, underside and piers. Smaller dips stay draped on the terrain.
    Sets piece['deck'] = (ha, hb, structure depth); returns statistics.
    """
    key = lambda x, z: (int(round(x * 10)), int(round(z * 10)))
    road_keys, nodes = set(), {}
    br = []
    for k, pc in enumerate(pieces):
        p, s = pc['p'], pc['s']
        e = [(float(np.interp(u, s, p[:, 0])), float(np.interp(u, s, p[:, 1]))) for u in (pc['a'], pc['b'])]
        if pc['flags'] & F_BRIDGE:
            ka, kb = key(*e[0]), key(*e[1])
            br.append((k, ka, kb))
            for kk, xz in ((ka, e[0]), (kb, e[1])):
                nodes.setdefault(kk, dict(xz=xz, edges=[]))
        else:
            road_keys.add(key(*e[0]))
            road_keys.add(key(*e[1]))
    for k, ka, kb in br:
        L = max(pieces[k]['b'] - pieces[k]['a'], 0.1)
        nodes[ka]['edges'].append((kb, L))
        nodes[kb]['edges'].append((ka, L))
    # joint heights: anchors on the ground, the rest relaxed (Gauss-Seidel on 1 / length weights)
    h = {}
    for kk, nd in nodes.items():
        if kk in road_keys or len(nd['edges']) == 1:
            h[kk] = float(hts.at(*nd['xz']))
    free = [kk for kk in nodes if kk not in h]
    for kk in free:
        h[kk] = float(hts.at(*nodes[kk]['xz']))
    for _ in range(200):
        delta = 0.0
        for kk in free:
            ws = sum(1 / L for _, L in nodes[kk]['edges'])
            v = sum(h[o] / L for o, L in nodes[kk]['edges']) / ws
            delta = max(delta, abs(v - h[kk]))
            h[kk] = v
        if delta < 1e-3:
            break
    # components (union-find over the bridge pieces' joints) and their largest dip
    parent = {kk: kk for kk in nodes}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for _, ka, kb in br:
        parent[find(ka)] = find(kb)
    sag = {}
    for k, ka, kb in br:
        pc = pieces[k]
        p, s, a, b = pc['p'], pc['s'], pc['a'], pc['b']
        t = np.linspace(a, b, max(2, int((b - a) / 5) + 1))
        x, z = np.interp(t, s, p[:, 0]), np.interp(t, s, p[:, 1])
        line = h[ka] + (h[kb] - h[ka]) * (t - a) / max(b - a, 1e-6)
        d = float(np.max(line - hts.at(x, z)))
        r = find(ka)
        sag[r] = max(sag.get(r, -1e9), d)
    n = km = 0
    worst = 0.0
    for k, ka, kb in br:
        if sag[find(ka)] >= min_sag:
            # structure depth under the deck surface: a slab on a low overpass, a deep girder on a
            # tall viaduct (its spans are longer: js/world/roadMesh.js spaces the piers by height)
            depth = float(np.clip(1.2 + 0.04 * sag[find(ka)], 1.6, 4.5))
            pieces[k]['deck'] = (h[ka], h[kb], depth)
            n += 1
            km += (pieces[k]['b'] - pieces[k]['a']) / 1000
            worst = max(worst, sag[find(ka)])
    comps = sum(1 for r, v in sag.items() if v >= min_sag)
    return dict(pieces=n, bridges=comps, km=round(float(km), 2), worst_sag_m=round(float(worst), 1),
                bridge_pieces=len(br), dips_over_10m=sum(1 for v in sag.values() if v >= 10))


# ---------------------------------------------------------------------------------------------
# build

def section_for(rc, oneway, name, urban):
    """(lanes, carriageway width m, left margin m, right margin m) for a road of render class rc."""
    l1, l2, lw, shr, shl, walk = SECTION[rc]
    lanes = l1 if oneway else l2
    if name and rc in ('motorway', 'trunk', 'motorway_link'):
        for key, n in NAMED_LANES.items():
            if key in name and rc != 'motorway_link':
                lanes = n if oneway else 2 * n
    w = lanes * lw
    if urban and walk > 0:
        return lanes, w, walk, walk
    if oneway:
        return lanes, w, shl, shr
    return lanes, w, shr, shr


def build(cache, out):
    import pyarrow.parquet as pq
    t0 = time.time()
    terrain_dir = os.path.join(out, '..', 'terrain') if os.path.isdir(os.path.join(out, '..', 'terrain')) \
        else os.path.join(HERE, '..', '..', 'data', 'terrain')
    with open(os.path.join(terrain_dir, 'airports.json')) as f:
        airports = json.load(f)
    rects = runway_rects(airports)
    lc = BuiltUp(terrain_dir)
    table = pq.read_table(os.path.join(cache, 'segments.parquet'))
    cols = table.to_pydict()
    n = table.num_rows
    log(f'{n} segments read ({time.time() - t0:.0f} s)')

    # ---- pass 1: classify, project, oneway; connector use counts for the junctions ----
    segs = []
    conn_deg = {}
    all_ll = []
    for i in range(n):
        rc = classify(cols['subtype'][i], cols['class'][i], cols['subclass'][i])
        if rc is None:
            continue
        flags_r = ranges(cols['road_flags'][i]) + ranges(cols['rail_flags'][i])
        # whole segment under construction / abandoned / disused: leave out
        dead = [(a, b) for a, b, v in flags_r if v and set(v) & {'is_under_construction', 'is_abandoned', 'is_disused'}]
        if any(a <= 0.0 and b >= 1.0 for a, b in dead):
            continue
        ll = parse_line(cols['geometry'][i])
        if ll is None or len(ll) < 2:
            continue
        segs.append(dict(i=i, rc=rc, ll=ll, flags=flags_r))
        all_ll.append(ll)
        for c in cols['connectors'][i] or ():
            at = c['at']
            end = at <= 1e-6 or at >= 1 - 1e-6
            conn_deg[c['connector_id']] = conn_deg.get(c['connector_id'], 0) + (1 if end else 2)
    lens = np.array([len(a) for a in all_ll])
    cat = np.concatenate(all_ll)
    X, Z = grid.lonlat_to_xz(cat[:, 0], cat[:, 1])
    offs = np.concatenate([[0], np.cumsum(lens)])
    log(f'{len(segs)} segments kept, {len(cat)} points projected ({time.time() - t0:.0f} s)')

    # ---- pass 2a: geometry, class, carriageway; the road corridors for the built-up mask ----
    base = []
    corridors = []
    for k, sg in enumerate(segs):
        i = sg['i']
        p = np.column_stack([X[offs[k]:offs[k + 1]], Z[offs[k]:offs[k + 1]]])
        if np.all(np.abs(p) > grid.CORE_HALF + 500):
            continue
        s = cumlen(p)
        L = s[-1]
        if L < 0.5:
            continue
        rc = sg['rc']
        name = (cols['names'][i] or {}).get('primary') if cols['names'][i] else None
        oneway = is_oneway(cols['access_restrictions'][i]) if rc not in ('rail', 'light_rail') else True
        surf = ranges(cols['road_surface'][i], 'value')
        unpaved = rc == 'track' or any(v in UNPAVED and a <= 0.5 <= b for a, b, v in surf)
        if rc == 'track' and any(v in ('paved', 'asphalt', 'concrete', 'paving_stones') and a <= 0.5 <= b for a, b, v in surf):
            unpaved = False
        if rc in ('rail', 'light_rail'):
            cw, ml = RAIL_SECTION[rc]
            hw = cw / 2 + ml
        else:
            _, cw, ml, mr = section_for(rc, oneway, name, False)
            hw = cw / 2 + max(ml, mr, SECTION[rc][5])
        base.append((k, p, s, L, rc, name, oneway, unpaved, hw))
        if not unpaved:
            corridors.append((p, hw + 6.0))
    lc.set_roads(corridors)
    del corridors
    log(f'built-up mask without the {len(base)} road corridors ({time.time() - t0:.0f} s)')

    # ---- pass 2: pieces (tunnels out, bridges and levels split), junctions, cross-sections ----
    pieces = []
    halfw_at = {}            # connector -> widest half-width of the roads meeting there
    for k, p, s, L, rc, name, oneway, unpaved, hw in base:
        sg = segs[k]
        i = sg['i']
        built, near = lc.beside(p, hw)
        # Motorways and their ramps are never "urban" (no kerbs, sidewalks or zebra crossings on
        # the Ayalon); other roads are when the land beside them is mostly built-up, residential
        # streets and service roads from a lower share (gardens, parks and school yards between
        # the houses of a town are not class 50)
        urban = rc not in ('motorway', 'motorway_link') and built > (0.35 if rc in ('residential', 'service') else 0.5)
        if rc in ('rail', 'light_rail'):
            cw, ml = RAIL_SECTION[rc]
            lanes, left, right = 1, ml, ml
        else:
            lanes, cw, left, right = section_for(rc, oneway, name, urban)
        # street lights: roads in town and roads near built-up land (motorways and trunk roads
        # through or beside towns are lit, the stretches between them mostly not)
        lit = rc not in ('track', 'rail', 'light_rail') and (urban or near > (0.3 if rc != 'service' else 0.6))
        flags = (F_ONEWAY if oneway else 0) | (F_URBAN if urban else 0) | (F_UNPAVED if unpaved else 0) | (F_LIT if lit else 0)
        if rc in ('trunk', 'primary') and not oneway and not urban:
            flags |= F_SOLID_CENTRE
        half = cw / 2 + max(left, right)
        # cut points: flag range boundaries
        cuts = {0.0, L}
        for a, b, v in sg['flags']:
            cuts.add(min(max(a, 0), 1) * L)
            cuts.add(min(max(b, 0), 1) * L)
        levels = ranges(cols['level_rules'][i], 'value')
        for a, b, v in levels:
            cuts.add(min(max(a, 0), 1) * L)
            cuts.add(min(max(b, 0), 1) * L)
        cuts = sorted(cuts)
        # junction connectors along the segment (arc length), and their ids
        conns = []
        for c in cols['connectors'][i] or ():
            if conn_deg.get(c['connector_id'], 0) >= 3:
                conns.append((c['at'] * L, c['connector_id']))
                halfw_at[c['connector_id']] = max(halfw_at.get(c['connector_id'], 0), half)
        for a, b in zip(cuts[:-1], cuts[1:]):
            if b - a < 0.2:
                continue
            m = (a + b) / 2 / L
            fl = set()
            for ra, rb, v in sg['flags']:
                if ra <= m <= rb and v:
                    fl |= set(v)
            if fl & {'is_tunnel', 'is_under_construction', 'is_abandoned', 'is_disused', 'is_covered', 'is_indoor'}:
                continue
            lev = 0
            for ra, rb, v in levels:
                if ra <= m <= rb and v is not None:
                    lev = int(max(-9, min(9, v)))
            pf = flags | (F_BRIDGE if 'is_bridge' in fl else 0)
            pieces.append(dict(p=p, s=s, a=a, b=b, rc=rc, flags=pf, lanes=lanes, cw=cw, left=left, right=right,
                               level=lev, conns=conns))
    del lc, base
    log(f'{len(pieces)} pieces ({time.time() - t0:.0f} s)')
    hts = CoreHeights(terrain_dir)
    deck_stats = bridge_decks(pieces, hts)        # (hts kept for the street lamps' heights)
    log(f'bridge decks: {deck_stats} ({time.time() - t0:.0f} s)')

    # ---- pass 3: cut, keep out of runways, simplify, clip to tiles ----
    T = grid.TILE_SIZE
    tiles = {}
    npts_in = npts_out = 0
    for pc_ in pieces:
        q = cut(pc_['p'], pc_['s'], pc_['a'], pc_['b'])
        if q is None:
            continue
        qs = cumlen(q)
        # junctions on this piece: (arc length from the piece start, radius)
        breaks = []
        for at, cid in pc_['conns']:
            u = at - pc_['a']
            r = halfw_at.get(cid, 0) + 1.0
            if -r < u < qs[-1] + r:
                breaks.append((u, r))
        # keep out of the runways (perimeter roads, taxiing data errors)
        keep = [(0.0, qs[-1])]
        bb = (q[:, 0].min(), q[:, 0].max(), q[:, 1].min(), q[:, 1].max())
        for rect in rects:
            R = rect[4] + rect[5]
            if bb[1] < rect[0] - R or bb[0] > rect[0] + R or bb[3] < rect[1] - R or bb[2] > rect[1] + R:
                continue
            for ia, ib in rect_intervals(q, qs, rect):
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
            sub = cut(q, qs, ka, kb) if (ka > 0 or kb < qs[-1]) else q
            if sub is None:
                continue
            # junction vertices stay through the simplification
            ss = cumlen(sub)
            kidx = [int(np.argmin(np.abs(ss - (u - ka)))) for u, r in breaks if 0 <= u - ka <= ss[-1]]
            npts_in += len(sub)
            sub = simplify(sub, 0.15, kidx)
            npts_out += len(sub)
            u0 = pc_['a'] + ka
            for ix, iz, part, pu0 in clip_tiles(sub, u0):
                if not (0 <= ix < grid.NTILES and 0 <= iz < grid.NTILES):
                    continue
                pl = cumlen(part)
                lo, hi = pu0 - pc_['a'], pu0 - pc_['a'] + pl[-1]
                br = [(u - (pu0 - pc_['a']), r) for u, r in breaks if lo - r < u < hi + r]
                tiles.setdefault((ix, iz), []).append(dict(pts=part, u0=pu0, rc=pc_['rc'], flags=pc_['flags'],
                                                            lanes=pc_['lanes'], cw=pc_['cw'], left=pc_['left'],
                                                            right=pc_['right'], level=pc_['level'], breaks=br,
                                                            deck=pc_.get('deck'), span=(pc_['a'], pc_['b'])))
    log(f'simplified {npts_in} -> {npts_out} points; {sum(len(v) for v in tiles.values())} polylines in '
        f'{len(tiles)} tiles ({time.time() - t0:.0f} s)')

    # ---- write (into roads.new/, then swapped in: the app may be reading the old tiles) ----
    final = os.path.join(out, 'roads')
    odir = final + '.new'
    if os.path.isdir(odir):
        shutil.rmtree(odir)
    os.makedirs(odir)
    index = {}
    lamp_index = {}
    decks = 0
    counts = {name: 0 for name in CLS}
    km = {name: 0.0 for name in CLS}
    total = 0
    for (ix, iz), pls in sorted(tiles.items()):
        data = write_tile(pls, ix, iz)
        fn = f'tile_{ix}_{iz}.bin'
        with open(os.path.join(odir, fn), 'wb') as f:
            f.write(data)
        total += len(data)
        nd = sum(1 for p in pls if p.get('deck'))
        decks += nd
        index[f'{ix},{iz}'] = dict(bytes=len(data), polylines=len(pls), points=sum(len(p['pts']) for p in pls), decks=nd)
        lamps = [r for p in pls for r in street_lamps(p, hts)]
        if lamps:
            with open(os.path.join(odir, f'lamps_{ix}_{iz}.bin'), 'wb') as f:
                f.write(write_lamps(lamps, ix, iz))
            lamp_index[f'{ix},{iz}'] = len(lamps)
        for p in pls:
            nm = next(k for k, v in CLS.items() if v == CLS[p['rc']])
            counts[nm] += 1
            km[nm] += float(cumlen(p['pts'])[-1]) / 1000
    meta = dict(
        version=TILE_VERSION, format='ROADS.md', release=RELEASE, attribution=ATTRIBUTION,
        tile_m=T, tiles=grid.NTILES, origin=[-grid.CORE_HALF, -grid.CORE_HALF], point_unit_m=0.1,
        classes=CLS, flags=dict(oneway=F_ONEWAY, bridge=F_BRIDGE, urban=F_URBAN, unpaved=F_UNPAVED,
                                solid_centre=F_SOLID_CENTRE, lit=F_LIT),
        km={k: round(v, 1) for k, v in km.items()}, polylines=counts, bytes=total, files=index,
        decks=dict(polylines=decks, **deck_stats),
        lamps=dict(total=sum(lamp_index.values()), files=lamp_index),
        built=time.strftime('%Y-%m-%d %H:%M:%S'),
    )
    with open(os.path.join(odir, 'index.json'), 'w') as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)
    if os.path.exists(os.path.join(final, 'check.txt')):
        shutil.copy(os.path.join(final, 'check.txt'), os.path.join(odir, 'check.txt'))
    if os.path.isdir(final):
        os.rename(final, final + '.old')
    os.rename(odir, final)
    shutil.rmtree(final + '.old', ignore_errors=True)
    del hts
    log(f'{len(index)} tiles, {total / 1e6:.1f} MB, {decks} deck polylines, {sum(lamp_index.values())} street lamps '
        f'-> {final} ({time.time() - t0:.0f} s)')
    log('km by class: ' + ', '.join(f'{k} {v:.0f}' for k, v in km.items() if v))


def clip_tiles(p, u0):
    """Split polyline p at the L0 tile lines; yields (ix, iz, part, u0 of the part)."""
    T, H = grid.TILE_SIZE, grid.CORE_HALF
    pts = [p[0]]
    for k in range(len(p) - 1):
        a, b = p[k], p[k + 1]
        ts = []
        for axis in (0, 1):
            ga, gb = (a[axis] + H) / T, (b[axis] + H) / T
            lo, hi = (ga, gb) if ga < gb else (gb, ga)
            for g in range(math.floor(lo) + 1, math.ceil(hi)):
                ts.append((g - ga) / (gb - ga))
        for t in sorted(ts):
            if 1e-9 < t < 1 - 1e-9:
                q = a + (b - a) * t
                # exactly on the line (no float drift across the tile edge)
                for axis in (0, 1):
                    g = (q[axis] + H) / T
                    if abs(g - round(g)) < 1e-7:
                        q[axis] = round(g) * T - H
                pts.append(q)
        pts.append(b)
    pts = np.array(pts)
    s = cumlen(pts)
    cur, cur_key, cur_u = [pts[0]], None, 0.0
    for k in range(len(pts) - 1):
        m = (pts[k] + pts[k + 1]) / 2
        key = (math.floor((m[0] + H) / T), math.floor((m[1] + H) / T))
        if cur_key is None:
            cur_key, cur_u = key, s[k]
        if key != cur_key:
            if len(cur) >= 2:
                yield cur_key[0], cur_key[1], np.array(cur), u0 + cur_u
            cur, cur_key, cur_u = [pts[k]], key, s[k]
        cur.append(pts[k + 1])
    if len(cur) >= 2 and cur_key is not None:
        yield cur_key[0], cur_key[1], np.array(cur), u0 + cur_u


def write_tile(pls, ix, iz):
    """Tile bytes (ROADS.md): header, 24-byte polyline records, uint16 points, float32 breaks, and
    the optional deck section (bridge deck heights per point; readers of the first version stop
    before it)."""
    x0, z0 = grid.tile_origin(ix, iz)
    recs = bytearray()
    pts = []
    brs = []
    deck = bytearray()
    ndeck = 0
    npts = 0
    for p in pls:
        q = np.rint((p['pts'] - (x0, z0)) / 0.1)
        q = np.clip(q, 0, 64000).astype('<u2')
        # drop points that collapsed onto their predecessor in the quantisation
        keep = np.concatenate([[True], np.any(q[1:] != q[:-1], axis=1)])
        q = q[keep]
        if len(q) < 2:
            continue
        nb = len(p['breaks'])
        if p.get('deck'):
            # the deck's straight profile between its ends, at every point's arc length
            (ha, hb, depth), (a, b) = p['deck'], p['span']
            u = p['u0'] + cumlen(p['pts'])[keep]
            hgt = ha + (hb - ha) * np.clip((u - a) / max(b - a, 1e-6), 0, 1)
            deck += struct.pack('<If', len(recs) // 24, depth) + hgt.astype('<f4').tobytes()
            ndeck += 1
        recs += struct.pack('<BBBbHBBHHIIf', CLS[p['rc']], p['flags'], min(255, p['lanes']), p['level'],
                            int(round(p['cw'] * 100)), int(round(p['left'] * 10)), int(round(p['right'] * 10)),
                            len(q), nb, npts, len(brs) // 2, float(p['u0']))
        pts.append(q.tobytes())
        npts += len(q)
        for u, r in p['breaks']:
            brs += [u, r]
    n = len(recs) // 24
    head = struct.pack('<4sIII', b'RDS1', n, npts, len(brs) // 2)
    tail = struct.pack('<4sI', b'DCK1', ndeck) + bytes(deck) if ndeck else b''
    return head + bytes(recs) + b''.join(pts) + np.array(brs, '<f4').tobytes() + tail


def street_lamps(p, hts):
    """Street lamps of one tile polyline p (world coordinates), exactly where js/world/roadShaders.js
    puts the pools of light on the road: every 42 m on main roads (sodium, 12 m poles) and 33 m
    elsewhere (LED, 9 m), from u = S / 2 on (the polyline's u, continuous across tiles); in the
    median of a one-way carriageway, staggered on both sides of a two-way road, beyond the kerb
    in town (0.7 m) or the shoulder (1 m). Returns rows (x, z, y of the lamp head, flags, rank):
    flags bit 0 LED, bit 1 a minor road (class group 1); rank a hash 0..255 (thinning by distance).
    """
    cls = CLS[p['rc']]
    f = p['flags']
    if not (f & F_LIT) or (f & F_UNPAVED) or cls > CLS['service']:
        return []
    S, hl = (42.0, 12.0) if cls <= 3 else (33.0, 9.0)
    hc = p['cw'] / 2
    kerbs = (f & F_URBAN) and (p['left'] > 0.5 or p['right'] > 0.5) and 2 <= cls <= 7
    side = hc + (0.7 if kerbs else 1.0)
    pts = p['pts']
    s = cumlen(pts)
    u0 = p['u0']
    k0, k1 = math.ceil(u0 / S - 0.5), math.floor((u0 + s[-1]) / S - 0.5)
    out = []
    for kk in range(k0, k1 + 1):
        u = (kk + 0.5) * S
        a = u - u0
        j = int(min(max(np.searchsorted(s, a, side='right') - 1, 0), len(s) - 2))
        L = max(s[j + 1] - s[j], 1e-9)
        t = (a - s[j]) / L
        tx, tz = (pts[j + 1] - pts[j]) / L
        v = (-hc - p['left'] + 0.4) if (f & F_ONEWAY) else (-side if kk % 2 == 0 else side)
        x = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t - tz * v
        z = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t + tx * v
        y = float(hts.at(x, z))
        if p.get('deck'):
            (ha, hb, _), (sa, sb) = p['deck'], p['span']
            y = max(y, ha + (hb - ha) * min(max((u - sa) / max(sb - sa, 1e-6), 0), 1))
        flags = (1 if cls > 3 else 0) | (2 if 7 <= cls <= 9 else 0)
        rank = (int(round(x * 10)) * 73856093 ^ int(round(z * 10)) * 19349663) & 255
        out.append((x, z, y + hl, flags, rank))
    return out


def write_lamps(lamps, ix, iz):
    """Lamp tile bytes (ROADS.md): 'LMP1', count, then 8 bytes a lamp: x, z (uint16, 0.1 m from the
    tile's NW corner), head height (uint16, 0.05 m above -500 m), flags, rank."""
    x0, z0 = grid.tile_origin(ix, iz)
    a = np.array(lamps, np.float64).reshape(-1, 5)
    rec = np.zeros(len(a), dtype=[('x', '<u2'), ('z', '<u2'), ('y', '<u2'), ('f', 'u1'), ('r', 'u1')])
    rec['x'] = np.clip(np.rint((a[:, 0] - x0) / 0.1), 0, 65535)
    rec['z'] = np.clip(np.rint((a[:, 1] - z0) / 0.1), 0, 65535)
    rec['y'] = np.clip(np.rint((a[:, 2] + 500) / 0.05), 0, 65535)
    rec['f'] = a[:, 3]
    rec['r'] = a[:, 4]
    return struct.pack('<4sI', b'LMP1', len(a)) + rec.tobytes()


def read_tile(path):
    """A tile written by tile_bytes(): list of (cls, flags, cw_m, left_m, right_m, points (n, 2) tile-local m)."""
    buf = open(path, 'rb').read()
    magic, n, npts, nb = struct.unpack_from('<4sIII', buf, 0)
    assert magic == b'RDS1', path
    pts = np.frombuffer(buf, '<u2', npts * 2, 16 + n * 24).reshape(-1, 2).astype(np.float64) * 0.1
    out = []
    for k in range(n):
        cls, flags, lanes, level, cw, left, right, m, nbk, first, fb, u0 = struct.unpack_from('<BBBbHBBHHIIf', buf, 16 + k * 24)
        out.append((cls, flags, cw / 100.0, left / 10.0, right / 10.0, pts[first:first + m]))
    return out


def road_mask(lines, px, size, classes):
    """Coverage (size x size, row 0 north) of the paved width of the given classes, px m per pixel."""
    mask = np.zeros((size, size), np.float32)
    yy, xx = np.mgrid[0:size, 0:size]
    cx, cz = (xx + 0.5) * px, (yy + 0.5) * px
    for cls, flags, cw, left, right, p in lines:
        if cls not in classes or flags & 2 or len(p) < 2:      # no bridges: their deck is not on the ground
            continue
        hw = 0.5 * cw + 0.5 * (left + right)
        for a, b in zip(p[:-1], p[1:]):
            x0, x1 = sorted((a[0], b[0]))
            z0, z1 = sorted((a[1], b[1]))
            i0, i1 = max(int((x0 - hw) / px) - 1, 0), min(int((x1 + hw) / px) + 2, size)
            j0, j1 = max(int((z0 - hw) / px) - 1, 0), min(int((z1 + hw) / px) + 2, size)
            if i0 >= i1 or j0 >= j1:
                continue
            X, Z = cx[j0:j1, i0:i1], cz[j0:j1, i0:i1]
            d = b - a
            L2 = max(float(d @ d), 1e-9)
            t = np.clip(((X - a[0]) * d[0] + (Z - a[1]) * d[1]) / L2, 0, 1)
            dist = np.hypot(X - a[0] - t * d[0], Z - a[1] - t * d[1])
            cov = np.clip(hw / px + 0.5 - dist / px, 0, 1)        # antialiased: a pixel half covered at the edge
            np.maximum(mask[j0:j1, i0:i1], cov, out=mask[j0:j1, i0:i1])
    return mask


def box_blur(a, r):
    """Mean over a (2r+1)^2 box (edges clamped), by cumulative sums."""
    p = np.pad(a, r + 1, mode='edge')
    c = p.cumsum(0).cumsum(1)
    n = 2 * r + 1
    s = c[n:, n:] - c[:-n, n:] - c[n:, :-n] + c[:-n, :-n]
    return s[:a.shape[0], :a.shape[1]] / (n * n)


def check(cache, out, terrain=None, ntiles=8, shift=4):
    """Offset of the main roads against the L0 imagery, per tile (cross-correlation in pixels).

    The asphalt of motorways, trunk and primary roads differs from the land around it in the
    Sentinel-2 composite: darker than fields and bare soil, often lighter than roofs and trees in
    town. The shift of the road mask that best matches the local contrast of the imagery (the
    extremum of the correlation, whichever its sign) is the misregistration between OpenStreetMap
    and the imagery, which are georeferenced independently; sub-pixel by a parabola through the
    peak. Reports per tile and for all tiles together; writes <out>/roads/check.txt.
    """
    from PIL import Image
    terrain = terrain or os.path.join(out, '..', 'terrain')
    rdir = os.path.join(out, 'roads')
    idx = json.load(open(os.path.join(rdir, 'index.json')))
    size, px = grid.L0_PX, grid.TILE_SIZE / grid.L0_PX
    major = {CLS['motorway'], CLS['trunk'], CLS['primary']}
    # the tiles with the most main road
    scored = []
    for key in idx['files']:
        ix, iz = map(int, key.split(','))
        lines = read_tile(os.path.join(rdir, f'tile_{ix}_{iz}.bin'))
        km = sum(np.hypot(*np.diff(p, axis=0).T).sum() for c, f, *_r, p in lines if c in major and len(p) > 1) / 1000
        scored.append((km, ix, iz, lines))
    scored.sort(key=lambda t: -t[0])
    rows = []
    for km, ix, iz, lines in scored[:ntiles]:
        img = os.path.join(terrain, 'color', 'L0', f'tile_{ix}_{iz}.jpg')
        if not os.path.exists(img):
            continue
        rgb = np.asarray(Image.open(img).convert('RGB'), np.float32) / 255
        lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        dark = box_blur(lum, 6) - lum                     # contrast against the surroundings (75 m box)
        m = road_mask(lines, px, size, major)
        m -= m.mean()
        dark -= dark.mean()
        S = shift
        corr = np.zeros((2 * S + 1, 2 * S + 1))
        core = (slice(S, size - S), slice(S, size - S))
        for dj in range(-S, S + 1):
            for di in range(-S, S + 1):
                # road mask moved by (di, dj) pixels (east, south) against the imagery
                shifted = m[S - dj:size - S - dj, S - di:size - S - di]
                corr[dj + S, di + S] = float((shifted * dark[core]).sum())
        k = np.unravel_index(np.argmax(np.abs(corr)), corr.shape)
        sign = 1.0 if corr[k] > 0 else -1.0                # dark roads (+) or light roads (-)
        corr *= sign / max(abs(corr[k]), 1e-9)
        dx, dz = peak_offset(corr, S, px)
        rows.append((ix, iz, km, sign, dx, dz, corr[S, S]))
        tone = 'darker' if sign > 0 else 'lighter'
        log(f'tile {ix},{iz}: {km:5.1f} km of main road ({tone} than around), '
            f'best shift east {dx:+5.1f} m, south {dz:+5.1f} m (correlation at 0: {corr[S, S]:.2f} of the peak)')
    # In town the contrast of the main roads is weak and other lines (rows of roofs, field edges)
    # pull the peak around: the summary is the median of the tiles whose peak lies inside the
    # search window and already shows at zero shift (half the peak or more).
    good = [r for r in rows if r[6] >= 0.5 and abs(r[4]) < shift * px - 1 and abs(r[5]) < shift * px - 1]
    if good:
        dx, dz = float(np.median([r[4] for r in good])), float(np.median([r[5] for r in good]))
        total = (f'{len(good)} of {len(rows)} tiles with a clear peak: median shift east {dx:+.1f} m, '
                 f'south {dz:+.1f} m (one L0 pixel is {px:.2f} m)')
    else:
        total = f'no clear peak in {len(rows)} tiles'
    log(total)
    with open(os.path.join(rdir, 'check.txt'), 'w') as f:
        f.write('Main roads (OpenStreetMap via Overture) against the L0 imagery (6.25 m pixels):\n'
                'shift of the road mask that best matches the contrast of the imagery, per tile.\n\n')
        for ix, iz, km, sign, dx, dz, c0 in rows:
            tone = 'dark ' if sign > 0 else 'light'
            f.write(f'tile {ix:2d},{iz:2d}  {km:6.1f} km  {tone}  east {dx:+6.2f} m  '
                    f'south {dz:+6.2f} m  corr(0) {c0:.2f}\n')
        f.write(f'\n{total}\n')
    return rows


def peak_offset(corr, S, px):
    """Sub-pixel position (m east, m south) of the maximum of a (2S+1)^2 correlation surface."""
    j, i = np.unravel_index(np.argmax(corr), corr.shape)

    def sub(a, b, c):
        d = a - 2 * b + c
        return 0.0 if d >= 0 else 0.5 * (a - c) / d
    fi = sub(corr[j, i - 1], corr[j, i], corr[j, i + 1]) if 0 < i < 2 * S else 0.0
    fj = sub(corr[j - 1, i], corr[j, i], corr[j + 1, i]) if 0 < j < 2 * S else 0.0
    return (i - S + fi) * px, (j - S + fj) * px


if __name__ == '__main__':
    main()
