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
        check(cache, os.path.abspath(args.out))


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


class LandCover:
    """ESA WorldCover codes of the core at 25 m (data/terrain/landcover/overview.png)."""

    def __init__(self, terrain_dir):
        from PIL import Image
        from scipy.ndimage import uniform_filter
        self.codes = np.asarray(Image.open(os.path.join(terrain_dir, 'landcover', 'overview.png')))
        self.n = self.codes.shape[0]
        built = (self.codes == 50).astype(np.float32)
        # built-up share within ~300 m: decides street lighting on main roads
        self.near = uniform_filter(built, size=13, mode='nearest')

    def _idx(self, x, z):
        px = 2 * grid.CORE_HALF / self.n
        i = np.clip(((np.asarray(x) + grid.CORE_HALF) / px).astype(int), 0, self.n - 1)
        j = np.clip(((np.asarray(z) + grid.CORE_HALF) / px).astype(int), 0, self.n - 1)
        return j, i

    def built_share(self, p):
        """Share of points along polyline p (sampled every ~20 m) in built-up land cover."""
        s = cumlen(p)
        n = max(2, int(s[-1] / 20) + 1)
        t = np.linspace(0, s[-1], n)
        x, z = np.interp(t, s, p[:, 0]), np.interp(t, s, p[:, 1])
        j, i = self._idx(x, z)
        return float(np.mean(self.codes[j, i] == 50)), float(np.mean(self.near[j, i]))


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
    lc = LandCover(terrain_dir)
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

    # ---- pass 2: pieces (tunnels out, bridges and levels split), junctions, cross-sections ----
    pieces = []
    halfw_at = {}            # connector -> widest half-width of the roads meeting there
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
        built, near = lc.built_share(p)
        urban = built > 0.5
        if rc in ('rail', 'light_rail'):
            cw, ml = RAIL_SECTION[rc]
            lanes, left, right = 1, ml, ml
        else:
            lanes, cw, left, right = section_for(rc, oneway, name, urban)
        lit = (urban and rc not in ('track', 'rail', 'light_rail')) or (rc in ('motorway', 'motorway_link', 'trunk', 'trunk_link') and near > 0.25)
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
    log(f'{len(pieces)} pieces ({time.time() - t0:.0f} s)')

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
                                                            right=pc_['right'], level=pc_['level'], breaks=br))
    log(f'simplified {npts_in} -> {npts_out} points; {sum(len(v) for v in tiles.values())} polylines in '
        f'{len(tiles)} tiles ({time.time() - t0:.0f} s)')

    # ---- write ----
    odir = os.path.join(out, 'roads')
    os.makedirs(odir, exist_ok=True)
    for fn in os.listdir(odir):
        if fn.startswith('tile_') and fn.endswith('.bin'):
            os.remove(os.path.join(odir, fn))
    index = {}
    counts = {name: 0 for name in CLS}
    km = {name: 0.0 for name in CLS}
    total = 0
    for (ix, iz), pls in sorted(tiles.items()):
        data = write_tile(pls, ix, iz)
        fn = f'tile_{ix}_{iz}.bin'
        with open(os.path.join(odir, fn), 'wb') as f:
            f.write(data)
        total += len(data)
        index[f'{ix},{iz}'] = dict(bytes=len(data), polylines=len(pls), points=sum(len(p['pts']) for p in pls))
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
        built=time.strftime('%Y-%m-%d %H:%M:%S'),
    )
    with open(os.path.join(odir, 'index.json'), 'w') as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)
    log(f'{len(index)} tiles, {total / 1e6:.1f} MB -> {odir} ({time.time() - t0:.0f} s)')
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
    """Tile bytes (ROADS.md): header, 24-byte polyline records, uint16 points, float32 breaks."""
    x0, z0 = grid.tile_origin(ix, iz)
    recs = bytearray()
    pts = []
    brs = []
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
        recs += struct.pack('<BBBbHBBHHIIf', CLS[p['rc']], p['flags'], min(255, p['lanes']), p['level'],
                            int(round(p['cw'] * 100)), int(round(p['left'] * 10)), int(round(p['right'] * 10)),
                            len(q), nb, npts, len(brs) // 2, float(p['u0']))
        pts.append(q.tobytes())
        npts += len(q)
        for u, r in p['breaks']:
            brs += [u, r]
    n = len(recs) // 24
    head = struct.pack('<4sIII', b'RDS1', n, npts, len(brs) // 2)
    return head + bytes(recs) + b''.join(pts) + np.array(brs, '<f4').tobytes()


def check(cache, out):
    raise NotImplementedError('check stage: see below')


if __name__ == '__main__':
    main()
