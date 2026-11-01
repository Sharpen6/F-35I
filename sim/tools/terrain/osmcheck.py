"""Independent cross-check of the runways and the coastline against OpenStreetMap (via Overture Maps).

Verification only: nothing from OpenStreetMap goes into the data set. Needs pyarrow; without it,
or without network, the stage is skipped and checks.txt says so.

  runways:   Overture base/infrastructure, subtype airport, class runway (OSM aeroway=runway lines)
  coastline: Overture base/water, subtype ocean (OSM coastline polygons)

Only the parquet footers and the row groups whose bbox statistics touch the core are read
(HTTP range requests), a few MB in all.
"""
import io
import json
import math
import os
import re
import struct
import time
import urllib.parse
import urllib.request

import numpy as np

import grid

RELEASE = 'release/2026-10-21.0'
BASE = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com'
CORE_BBOX = (34.40, 31.30, 35.65, 32.30)
COAST_LATS = (31.70, 31.80, 31.90, 32.02, 32.05, 32.08, 32.11, 32.14, 32.20)
PERSIST_M = 50.0


def log(*a):
    print('  [osmcheck]', *a, flush=True)


# ---- reading Overture parquet over HTTP ------------------------------------------------------

def list_keys(prefix):
    out, token = [], None
    while True:
        q = f'{BASE}/?list-type=2&prefix={urllib.parse.quote(prefix)}'
        if token:
            q += '&continuation-token=' + urllib.parse.quote(token)
        xml = urllib.request.urlopen(q, timeout=60).read().decode()
        out += re.findall(r'<Key>([^<]+)</Key>', xml)
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', xml)
        if not m:
            return out
        token = m.group(1)


class RangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests."""

    def __init__(self, url):
        super().__init__()
        self.url, self.pos, self.nbytes = url, 0, 0
        req = urllib.request.Request(url, method='HEAD')
        self.size = int(urllib.request.urlopen(req, timeout=60).headers['Content-Length'])

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
        for k in range(4):
            try:
                req = urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{self.pos + n - 1}'})
                data = urllib.request.urlopen(req, timeout=120).read()
                break
            except OSError:
                if k == 3:
                    raise
                time.sleep(2 + 3 * k)
        self.pos += len(data)
        self.nbytes += len(data)
        return data

    def readinto(self, buf):
        d = self.read(len(buf))
        buf[:len(d)] = d
        return len(d)


def fetch_features(theme, typ, bbox, subtype=None):
    """[(class, name, geometry WKB, surface)] of an Overture type inside bbox (W, S, E, N)."""
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    W, S, E, N = bbox
    feats, nbytes = [], 0
    for key in list_keys(f'{RELEASE}/theme={theme}/type={typ}/'):
        if not key.endswith('.parquet'):
            continue
        f = RangeFile(f'{BASE}/{key}')
        pf = pq.ParquetFile(f)
        md = pf.metadata
        ix = {md.schema.column(i).path: i for i in range(md.num_columns)}
        keep = []
        for rg in range(md.num_row_groups):
            g = md.row_group(rg)
            st = {k: g.column(ix['bbox.' + k]).statistics for k in ('xmin', 'xmax', 'ymin', 'ymax')}
            if all(s is not None and s.has_min_max for s in st.values()) and (
                    st['xmax'].max < W or st['xmin'].min > E or st['ymax'].max < S or st['ymin'].min > N):
                continue
            keep.append(rg)
        if keep:
            cols = [c for c in ('subtype', 'class', 'names', 'geometry', 'bbox', 'surface') if c in pf.schema_arrow.names]
            t = pf.read_row_groups(keep, columns=cols)
            bb = t.column('bbox')
            m = pc.and_(pc.and_(pc.greater_equal(pc.struct_field(bb, 'xmax'), W),
                                pc.less_equal(pc.struct_field(bb, 'xmin'), E)),
                        pc.and_(pc.greater_equal(pc.struct_field(bb, 'ymax'), S),
                                pc.less_equal(pc.struct_field(bb, 'ymin'), N)))
            if subtype is not None:
                m = pc.and_(m, pc.equal(t.column('subtype'), subtype))
            d = t.filter(m).to_pydict()
            for i in range(len(d['geometry'])):
                nm = d['names'][i].get('primary') if d.get('names') and d['names'][i] else None
                feats.append(dict(cls=d['class'][i], name=nm, wkb=d['geometry'][i],
                                  surface=d['surface'][i] if 'surface' in d else None))
        nbytes += f.nbytes
    log(f'{theme}/{typ}: {len(feats)} features ({nbytes / 1e6:.1f} MB read)')
    return feats


def parse_wkb(b, o=0):
    """Minimal 2D WKB: ('Point'|'LineString'|'Polygon'|'Multi', data), next offset."""
    bo = '<' if b[o] == 1 else '>'
    t = struct.unpack_from(bo + 'I', b, o + 1)[0] % 1000
    o += 5
    if t == 1:
        return ('Point', np.array(struct.unpack_from(bo + '2d', b, o))), o + 16
    if t == 2:
        n = struct.unpack_from(bo + 'I', b, o)[0]
        return ('LineString', np.frombuffer(b, bo + 'f8', 2 * n, o + 4).reshape(n, 2)), o + 4 + 16 * n
    if t == 3:
        nr = struct.unpack_from(bo + 'I', b, o)[0]
        o += 4
        rings = []
        for _ in range(nr):
            n = struct.unpack_from(bo + 'I', b, o)[0]
            rings.append(np.frombuffer(b, bo + 'f8', 2 * n, o + 4).reshape(n, 2))
            o += 4 + 16 * n
        return ('Polygon', rings), o
    if t in (4, 5, 6, 7):
        n = struct.unpack_from(bo + 'I', b, o)[0]
        o += 4
        parts = []
        for _ in range(n):
            g, o = parse_wkb(b, o)
            parts.append(g)
        return ('Multi', parts), o
    raise ValueError(f'WKB type {t}')


def rings_of(g):
    if g[0] == 'Polygon':
        return list(g[1])
    if g[0] == 'Multi':
        return [r for p in g[1] for r in rings_of(p)]
    return []


def line_points(g):
    if g[0] == 'LineString':
        return g[1]
    if g[0] == 'Polygon':
        return g[1][0]
    return None


# ---- comparisons ---------------------------------------------------------------------------

def compare_runways(osm, airports):
    """Fit each of our runways to the OSM runway lines lying along it."""
    lines = []
    for f in osm:
        if f['cls'] != 'runway':
            continue
        pts = line_points(parse_wkb(f['wkb'])[0])
        if pts is None or len(pts) < 2:
            continue
        x, z = grid.lonlat_to_xz(pts[:, 0], pts[:, 1])
        lines.append(dict(x=np.asarray(x), z=np.asarray(z), name=f['name'], surface=f['surface'], used=False))
    results = []
    for ap in airports:
        for r in ap['runways']:
            a, b = r['ends']
            L = math.hypot(b['x'] - a['x'], b['z'] - a['z'])
            t = np.array([(b['x'] - a['x']) / L, (b['z'] - a['z']) / L])
            n = np.array([-t[1], t[0]])
            us, vs = [], []
            for ln in lines:
                u = (ln['x'] - a['x']) * t[0] + (ln['z'] - a['z']) * t[1]
                v = (ln['x'] - a['x']) * n[0] + (ln['z'] - a['z']) * n[1]
                du, dv = u[-1] - u[0], v[-1] - v[0]
                ang = abs(math.degrees(math.atan2(dv, du)))
                ang = min(ang, 180 - ang)
                if np.all(np.abs(v) < 40) and ang < 3 and u.min() > -a['overrun_m'] - 400 \
                        and u.max() < L + b['overrun_m'] + 400:
                    ln['used'] = True
                    # densify along the line so long segments weigh by length
                    for k in range(len(u) - 1):
                        m = max(2, int(math.hypot(u[k + 1] - u[k], v[k + 1] - v[k]) / 25))
                        s = np.linspace(0, 1, m, endpoint=False)
                        us.append(u[k] + s * (u[k + 1] - u[k]))
                        vs.append(v[k] + s * (v[k + 1] - v[k]))
            key = f'{ap["icao"]} {"/".join(r["ids"])}'
            if not us:
                results.append(dict(runway=key, matched=False))
                continue
            us, vs = np.concatenate(us), np.concatenate(vs)
            if us.max() - us.min() > 300:
                c1, c0 = np.polyfit(us, vs, 1)
            else:
                c1, c0 = 0.0, float(np.median(vs))
            results.append(dict(runway=key, matched=True, osm_extent_m=[round(float(us.min()), 0), round(float(us.max() - L), 0)],
                                offset_at_end_m={a['id']: round(float(c0), 1), b['id']: round(float(c0 + c1 * L), 1)},
                                angle_deg=round(math.degrees(math.atan(c1)), 2),
                                rms_m=round(float(np.sqrt(np.mean((vs - (c0 + c1 * us)) ** 2))), 1)))
    others = []
    for ln in lines:
        if ln['used']:
            continue
        lon, lat = grid.xz_to_lonlat(float(ln['x'].mean()), float(ln['z'].mean()))
        Lx = float(np.sum(np.hypot(np.diff(ln['x']), np.diff(ln['z']))))
        inside = abs(float(ln['x'].mean())) < grid.CORE_HALF and abs(float(ln['z'].mean())) < grid.CORE_HALF
        if inside:
            others.append(dict(name=ln['name'], surface=ln['surface'], length_m=round(Lx), lon=round(float(lon), 4),
                               lat=round(float(lat), 4)))
    return results, others


def osm_shoreline_lon(rings, lat):
    """Longitude of the eastern edge of the ocean polygons along the parallel `lat` (the shoreline)."""
    best = None
    for ring in rings:
        x, y = ring[:, 0], ring[:, 1]
        x0, y0, x1, y1 = x[:-1], y[:-1], x[1:], y[1:]
        cross = (y0 - lat) * (y1 - lat) < 0
        if not cross.any():
            continue
        xc = x0[cross] + (lat - y0[cross]) * (x1[cross] - x0[cross]) / (y1[cross] - y0[cross])
        xc = xc[xc < 34.99]
        if xc.size and (best is None or xc.max() > best):
            best = float(xc.max())
    return best


def lc_shoreline_lon(out, lat):
    """Shoreline of the delivered land cover along the parallel: the first land (non-water for at
    least PERSIST_M) east of the open sea."""
    from PIL import Image
    lons = np.arange(34.30, 34.95, 0.00002)
    x, z = grid.lonlat_to_xz(lons, np.full_like(lons, lat))
    ok = (np.abs(x) < grid.CORE_HALF) & (np.abs(z) < grid.CORE_HALF)
    lons, x, z = lons[ok], x[ok], z[ok]
    px = grid.TILE_SIZE / grid.LC_TILE_PX
    ix = np.floor((x + grid.CORE_HALF) / grid.TILE_SIZE).astype(int)
    iz = np.floor((z + grid.CORE_HALF) / grid.TILE_SIZE).astype(int)
    cls = np.zeros(lons.size, np.uint8)
    cache = {}
    for k in np.unique(ix * 100 + iz):
        a, b = k // 100, k % 100
        if (a, b) not in cache:
            cache[(a, b)] = np.asarray(Image.open(os.path.join(out, 'landcover', f'tile_{a}_{b}.png')))
        sel = (ix == a) & (iz == b)
        c = np.floor((x[sel] - (-grid.CORE_HALF + grid.TILE_SIZE * a)) / px).astype(int).clip(0, grid.LC_TILE_PX - 1)
        r = np.floor((z[sel] - (-grid.CORE_HALF + grid.TILE_SIZE * b)) / px).astype(int).clip(0, grid.LC_TILE_PX - 1)
        cls[sel] = cache[(a, b)][r, c]
    land = cls != 80
    step_m = float(np.median(np.diff(x)))
    need = max(1, int(PERSIST_M / step_m))
    if land[0]:
        return None
    run = np.convolve(land.astype(int), np.ones(need, int), 'full')[need - 1:]
    idx = np.nonzero(run >= need)[0]
    return float(lons[idx[0]]) if idx.size else None


def compare_coast(osm, out):
    rings = [r for f in osm for r in rings_of(parse_wkb(f['wkb'])[0])]
    res = []
    for lat in COAST_LATS:
        lo = osm_shoreline_lon(rings, lat)
        lc = lc_shoreline_lon(out, lat)
        if lo is None or lc is None:
            res.append(dict(lat=lat, osm_lon=lo, ours_lon=lc))
            continue
        x0, _ = grid.lonlat_to_xz(lo, lat)
        x1, _ = grid.lonlat_to_xz(lc, lat)
        res.append(dict(lat=lat, osm_lon=round(lo, 5), ours_lon=round(lc, 5), ours_minus_osm_m=round(float(x1 - x0), 1)))
    return res


def cached(cache, name, fn):
    """Features from <cache>/osm/<name>.json, fetched once."""
    path = os.path.join(cache, 'osm', name + '.json')
    if os.path.exists(path):
        with open(path) as f:
            feats = json.load(f)
        for ft in feats:
            ft['wkb'] = bytes.fromhex(ft['wkb'])
        return feats
    feats = fn()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + '.tmp', 'w') as f:
        json.dump([dict(ft, wkb=ft['wkb'].hex()) for ft in feats], f)
    os.replace(path + '.tmp', path)
    return feats


def run(cache, out):
    work = os.path.join(cache, 'work')
    res_path = os.path.join(work, 'osm_check.json')
    try:
        import pyarrow  # noqa: F401
    except ImportError:
        log('pyarrow not installed: skipped (pip install pyarrow to enable)')
        with open(res_path, 'w') as f:
            json.dump(dict(skipped='pyarrow not installed'), f)
        return
    try:
        rwy = cached(cache, 'airport_infrastructure',
                     lambda: fetch_features('base', 'infrastructure', CORE_BBOX, subtype='airport'))
        sea = cached(cache, 'ocean', lambda: fetch_features('base', 'water', (34.40, 31.60, 34.85, 32.30), subtype='ocean'))
    except OSError as e:
        log(f'Overture not reachable ({e}): skipped')
        with open(res_path, 'w') as f:
            json.dump(dict(skipped=f'Overture not reachable: {e}'), f)
        return
    with open(os.path.join(work, 'runways.json')) as f:
        airports = json.load(f)['airports']
    runways, others = compare_runways(rwy, airports)
    coast = compare_coast(sea, out)
    for r in runways:
        log(r)
    for c in coast:
        log(c)
    with open(res_path, 'w') as f:
        json.dump(dict(release=RELEASE, runways=runways, osm_runways_not_in_ourairports=others, coast=coast), f, indent=1)
