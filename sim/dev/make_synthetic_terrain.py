#!/usr/bin/env python3
"""Synthetic stand-in for data/terrain/ in the exact format of sim/DESIGN.md.

Lets the terrain renderer (and anyone else) run without the real data pipeline:
a rough caricature of central Israel (sea in the west, coastal plain with fields and
towns, Shephelah, Judean hills, the drop to a Dead Sea at -430 m, highlands beyond),
with a few airports at their real positions and flattened runways.

    python3 sim/dev/make_synthetic_terrain.py [--out /tmp/terrain/synth] [--quick]

--quick writes only the 4 x 4 L0 colour / land cover tiles around Tel Nof (the
renderer falls back to the overview for missing tiles); heights are always complete.
Everything is a function of world (x, z), evaluated at each product's own pixel
centres, so the overviews are consistent with the tiles.
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CORE_HALF = 51200.0
FAR_HALF = 204800.0
TILE_M = 6400.0
NT = 16

# ----------------------------------------------------------------------------------------
# projection (same as js/world/coords.js; pyproj when available, else spherical approx)

def make_lonlat_to_xz():
    try:
        from pyproj import Transformer
        t = Transformer.from_crs('EPSG:4326', '+proj=tmerc +lat_0=31.80 +lon_0=35.025 +k=1 +x_0=0 +y_0=0 '
                                 '+ellps=WGS84 +units=m +no_defs', always_xy=True)

        def f(lon, lat):
            e, n = t.transform(lon, lat)
            return e, -n
        return f
    except Exception:  # pragma: no cover
        def f(lon, lat):
            r = 6371000.0
            return (math.radians(lon - 35.025) * r * math.cos(math.radians(lat)),
                    -math.radians(lat - 31.80) * r)
        return f


LL2XZ = make_lonlat_to_xz()

# ----------------------------------------------------------------------------------------
# noise

def _hash(ix, iz, seed):
    h = (ix.astype(np.int64) * 374761393 + iz.astype(np.int64) * 668265263 + seed * 144269504) & 0xffffffff
    h = ((h ^ (h >> 13)) * 1274126177) & 0xffffffff
    h = h ^ (h >> 16)
    return (h & 0xffffff).astype(np.float64) / 16777216.0


def vnoise(x, z, scale, seed):
    fx = x / scale
    fz = z / scale
    ix = np.floor(fx)
    iz = np.floor(fz)
    tx = fx - ix
    tz = fz - iz
    tx = tx * tx * (3 - 2 * tx)
    tz = tz * tz * (3 - 2 * tz)
    ix = ix.astype(np.int64)
    iz = iz.astype(np.int64)
    a = _hash(ix, iz, seed)
    b = _hash(ix + 1, iz, seed)
    c = _hash(ix, iz + 1, seed)
    d = _hash(ix + 1, iz + 1, seed)
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz


def fbm(x, z, scale, octaves, seed, gain=0.5):
    s = np.zeros_like(x)
    amp = 1.0
    norm = 0.0
    for o in range(octaves):
        s += amp * vnoise(x, z, scale, seed + 17 * o)
        norm += amp
        amp *= gain
        scale *= 0.5
    return s / norm


def smoothstep(a, b, t):
    t = np.clip((t - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)

# ----------------------------------------------------------------------------------------
# the caricature

def coast_x(z):
    """x of the shoreline: Tel Aviv at about (-24 km, -31.7 km), Ashdod at about (-36.4 km, 0)."""
    return -36400.0 - 0.39 * z


CITIES = [  # name, lon, lat, radius_m
    ('Tel Aviv', 34.785, 32.08, 6500), ('Bat Yam', 34.75, 32.02, 2600), ('Rishon', 34.80, 31.965, 3500),
    ('Holon', 34.78, 32.015, 2600), ('Petah Tikva', 34.885, 32.09, 3200), ('Ramla', 34.87, 31.93, 2500),
    ('Rehovot', 34.81, 31.895, 2800), ('Ashdod', 34.655, 31.80, 4200), ('Yavne', 34.74, 31.875, 1800),
    ('Modiin', 35.01, 31.90, 2600), ('Beit Shemesh', 34.99, 31.745, 2200), ('Jerusalem', 35.21, 31.78, 6500),
    ('Kiryat Gat', 34.765, 31.61, 2000), ('Gedera', 34.78, 31.81, 1300), ('Kiryat Malakhi', 34.745, 31.73, 1300),
]
CITY_XZ = [(LL2XZ(lon, lat), r) for _, lon, lat, r in CITIES]

DEAD_SEA_LEVEL = -430.0


def dead_sea_mask(x, z):
    # north tip near 35.52 E, 31.76 N; a lens about 15 km wide reaching south out of the core
    (cx, cz) = LL2XZ(35.50, 31.55)
    dx = (x - cx) / 7500.0
    dz = (z - cz) / 30000.0
    wob = (vnoise(x, z, 4000.0, 99) - 0.5) * 0.25
    return (dx * dx + dz * dz) < (1.0 + wob)


def height_fn(x, z):
    """Terrain height (m MSL) before runway flattening; sea at exactly 0."""
    xc = coast_x(z)
    u = x - xc  # distance inland from the shoreline (m)
    n1 = fbm(x, z, 9000.0, 6, 11)
    n2 = fbm(x, z, 1500.0, 5, 23)
    # coastal plain 0..80 m, dunes near the beach
    plain = 3 + u * 0.0016 + (n2 - 0.5) * 12 + smoothstep(0, 800, u) * (1 - smoothstep(1500, 4000, u)) * 12 * n2
    # Shephelah 100..400 m from about 25 km inland
    shep = smoothstep(22000, 40000, u) * (150 + 260 * n1)
    # Judean hills to ~1000 m around 52..70 km inland
    hills = smoothstep(42000, 58000, u) * (420 + 380 * fbm(x, z, 5000.0, 6, 37))
    h = plain + shep + hills
    # the rift: steep drop to the Dead Sea basin 75..85 km inland
    rift = smoothstep(68000, 82000, u)
    h = h * (1 - rift) + rift * (DEAD_SEA_LEVEL + 40 + 60 * n2)
    # highlands east of the rift
    east = smoothstep(95000, 110000, u)
    h = h * (1 - east) + east * (700 + 300 * n1)
    # valleys: carve with ridged noise in the hills
    ridge = 1 - np.abs(2 * fbm(x, z, 3000.0, 4, 51) - 1)
    h -= smoothstep(30000, 60000, u) * (1 - smoothstep(70000, 80000, u)) * ridge ** 3 * 120
    h = np.where(u < 0, 0.0, np.maximum(h, 0.3))
    ds = dead_sea_mask(x, z)
    h = np.where(ds, DEAD_SEA_LEVEL, np.where(rift > 0.5, np.maximum(h, DEAD_SEA_LEVEL + 2), h))
    return h


def landcover_fn(x, z, h):
    """ESA WorldCover codes."""
    xc = coast_x(z)
    u = x - xc
    lc = np.full(x.shape, 40, np.uint8)  # crops by default on the plain
    nat = fbm(x, z, 2500.0, 4, 61)
    lc = np.where(nat > 0.62, 30, lc)
    lc = np.where((u > 30000) & (nat > 0.45), 20, lc)
    lc = np.where((u > 38000) & (fbm(x, z, 1800.0, 4, 71) > 0.6), 10, lc)  # hill forests
    lc = np.where((u > 64000) & (u < 98000), np.where(nat > 0.7, 20, 60), lc)  # desert slopes
    lc = np.where(u > 98000, np.where(nat > 0.55, 40, 60), lc)
    lc = np.where((u > 0) & (u < 600), 60, lc)  # beach / dunes
    for (cx, cz), r in CITY_XZ:
        d = np.hypot(x - cx, z - cz) / r
        d += (fbm(x, z, 900.0, 3, 81) - 0.5) * 0.5
        lc = np.where(d < 1.0, 50, lc)
    # fish ponds / reservoirs: small rectangles here and there on the plain
    fp = (vnoise(x, z, 700.0, 91) > 0.93) & (u > 2000) & (u < 25000)
    lc = np.where(fp, 80, lc)
    lc = np.where(u < 0, 80, lc)
    lc = np.where(dead_sea_mask(x, z), 80, lc)
    return lc.astype(np.uint8)


PALETTE = {  # base sRGB colour per class (satellite-ish)
    10: (52, 70, 40), 20: (118, 112, 78), 30: (140, 138, 92), 40: (128, 120, 80), 50: (150, 146, 138),
    60: (190, 172, 138), 80: (24, 52, 78), 90: (70, 90, 70),
}


def color_fn(x, z, h, lc, px_m):
    """sRGB uint8 image of shape (..., 3) for pixel centres x, z."""
    out = np.zeros(x.shape + (3,), np.float64)
    for code, rgb in PALETTE.items():
        m = lc == code
        if m.any():
            out[m] = rgb
    var = fbm(x, z, 600.0, 4, 101) - 0.5
    out *= (1 + 0.25 * var)[..., None]
    # crop patchwork: rotated rectangles with different greens / browns
    ang = 0.35 + 0.6 * vnoise(x, z, 20000.0, 111)
    ca, sa = np.cos(ang), np.sin(ang)
    fu = x * ca + z * sa
    fv = -x * sa + z * ca
    fid_u = np.floor(fu / 180.0)
    fid_v = np.floor(fv / 320.0)
    f = _hash(fid_u.astype(np.int64), fid_v.astype(np.int64), 7)
    crop = np.stack([110 + 70 * f, 105 + 55 * (1 - f) + 30 * f, 60 + 30 * f], -1)
    crop = np.where((f > 0.66)[..., None], np.array([70, 100, 50]), crop)
    if px_m < 30:
        edge = (np.abs(fu / 180.0 - np.round(fu / 180.0)) < 3.0 / 180.0) | (np.abs(fv / 320.0 - np.round(fv / 320.0)) < 3.0 / 320.0)
        crop = np.where(edge[..., None], crop * 0.8, crop)
    out = np.where((lc == 40)[..., None], crop * (1 + 0.15 * var)[..., None], out)
    # town texture: street grid + roof variation
    if px_m < 30:
        g = (np.abs(((x / 90.0) % 1) - 0.5) > 0.44) | (np.abs(((z / 110.0) % 1) - 0.5) > 0.44)
        roof = _hash(np.floor(x / 22).astype(np.int64), np.floor(z / 26).astype(np.int64), 5)
        town = np.stack([140 + 70 * roof, 135 + 60 * roof, 125 + 50 * roof], -1)
        town = np.where(g[..., None], np.array([95, 95, 98]), town)
        out = np.where((lc == 50)[..., None], town, out)
    # sea: deeper is darker, shallow strip lighter
    u = x - coast_x(z)
    sea = np.stack([18 + 20 * smoothstep(-1200, 0, u), 45 + 40 * smoothstep(-1200, 0, u), 70 + 40 * smoothstep(-1200, 0, u)], -1)
    out = np.where((u < 0)[..., None], sea, out)
    return np.clip(out, 0, 255).astype(np.uint8)


# ----------------------------------------------------------------------------------------
# airports (real positions, approximate runway geometry) and spawns

AIRPORTS = [
    # icao, name, lon, lat, runways [(id_lo, id_hi, heading_lo_deg, length, width)]
    ('LLEK', 'Tel Nof', 34.8186, 31.8394, [('15', '33', 151.0, 2400, 45), ('11', '29', 112.0, 2100, 45)]),
    ('LLHS', 'Hatzor', 34.7272, 31.7625, [('11', '29', 112.0, 2450, 45), ('05', '23', 52.0, 2000, 45)]),
    ('LLBG', 'Ben Gurion', 34.8867, 32.0114, [('08', '26', 83.0, 3650, 45), ('12', '30', 123.0, 3100, 45), ('03', '21', 28.0, 2770, 45)]),
]


def build_airports(hfun):
    out = []
    for icao, name, lon, lat, rws in AIRPORTS:
        cx, cz = LL2XZ(lon, lat)
        elev = float(hfun(np.array([cx]), np.array([cz]))[0])
        runways = []
        for k, (a, b, hdg, length, width) in enumerate(rws):
            off = (k - (len(rws) - 1) / 2) * 900.0
            hr = math.radians(hdg)
            dx, dz = math.sin(hr), -math.cos(hr)
            ox, oz = cx + off * -dz, cz + off * dx
            e1 = (ox - dx * length / 2, oz - dz * length / 2)
            e2 = (ox + dx * length / 2, oz + dz * length / 2)
            y1 = float(hfun(np.array([e1[0]]), np.array([e1[1]]))[0])
            y2 = float(hfun(np.array([e2[0]]), np.array([e2[1]]))[0])
            # gentle slope at most 0.5 %
            ym = (y1 + y2) / 2
            dy = max(-0.005 * length, min(0.005 * length, y2 - y1))
            y1, y2 = ym - dy / 2, ym + dy / 2
            runways.append({
                'ids': [a, b], 'width_m': width, 'length_m': length, 'surface': 'asphalt',
                'ends': [
                    {'id': a, 'x': round(e1[0], 2), 'z': round(e1[1], 2), 'y': round(y1, 2), 'heading_deg': hdg},
                    {'id': b, 'x': round(e2[0], 2), 'z': round(e2[1], 2), 'y': round(y2, 2), 'heading_deg': (hdg + 180) % 360},
                ]})
        out.append({'icao': icao, 'name': name, 'elev_m': round(elev), 'runways': runways})
    return out


def flatten_runways(xs, zs, h, airports):
    """Level across, linear along each runway (plus a 75 m blended shoulder)."""
    for ap in airports:
        for rw in ap['runways']:
            a, b = rw['ends']
            ax, az, bx, bz = a['x'], a['z'], b['x'], b['z']
            L = math.hypot(bx - ax, bz - az)
            ux, uz = (bx - ax) / L, (bz - az) / L
            px, pz = xs - ax, zs - az
            s = px * ux + pz * uz
            t = np.abs(-px * uz + pz * ux)
            sc = np.clip(s, 0, L)
            y = a['y'] + (b['y'] - a['y']) * sc / L
            half = rw['width_m'] / 2 + 15
            d = np.maximum(t - half, 0) + np.maximum(np.maximum(-s, s - L), 0)
            w = 1 - smoothstep(0, 75, d)
            h = h * (1 - w) + y * w
    return h


def build_spawns(airports, hfun):
    ap = airports[0]
    rw = ap['runways'][0]
    a, b = rw['ends']  # a = '15' end (north-west), b = '33' end
    hdg33 = b['heading_deg']
    hr = math.radians(hdg33)
    dx, dz = math.sin(hr), -math.cos(hr)
    sx, sz = b['x'] + dx * 60, b['z'] + dz * 60  # 60 m in from the 33 threshold
    gy = float(b['y'])
    fx, fz = b['x'] - dx * 10000, b['z'] - dz * 10000
    tlv = LL2XZ(34.78, 32.07)
    jer = LL2XZ(35.21, 31.78)
    dsea = LL2XZ(35.50, 31.70)

    def air(label, x, z, alt, hdg, v):
        # airborne spawn: y is the altitude MSL
        return {'label': label, 'x': round(x, 2), 'y': float(alt), 'z': round(z, 2), 'heading_deg': hdg,
                'on_ground': False, 'speed_ms': v}
    return {
        'telnof_33': {'label': 'Tel Nof, runway 33, ready for takeoff', 'x': round(sx, 2), 'y': round(gy, 2), 'z': round(sz, 2),
                      'heading_deg': hdg33, 'on_ground': True, 'speed_ms': 0},
        'telnof_final': air('Tel Nof, 10 km final runway 33', fx, fz, round(gy + 560, 1), hdg33, 75),
        'tlv_3000': air('Over Tel Aviv, 3,000 m', tlv[0], tlv[1], 3000, 0, 200),
        'jerusalem_1500': air('Jerusalem hills, 1,500 m', jer[0] - 8000, jer[1], 1500, 90, 180),
        'deadsea_2000': air('Dead Sea, 2,000 m', dsea[0] - 12000, dsea[1], 2000, 100, 200),
    }

# ----------------------------------------------------------------------------------------

def enc_height(h):
    return np.clip(np.round((h + 500.0) / 0.05), 0, 65535).astype('<u2')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/tmp/terrain/synth')
    ap.add_argument('--quick', action='store_true')
    args = ap.parse_args()
    out = args.out
    for d in ('height', 'color/L0', 'landcover'):
        os.makedirs(os.path.join(out, d), exist_ok=True)
    t0 = time.time()

    airports = build_airports(height_fn)

    def hfun(x, z):
        return flatten_runways(x, z, height_fn(x, z), airports)

    # heights: core tiles
    print('heights ...', flush=True)
    g = np.arange(257) * 25.0
    for iz in range(NT):
        for ix in range(NT):
            x0 = -CORE_HALF + TILE_M * ix
            z0 = -CORE_HALF + TILE_M * iz
            xs, zs = np.meshgrid(x0 + g, z0 + g)
            enc_height(hfun(xs, zs)).tofile(os.path.join(out, 'height', f'tile_{ix}_{iz}.bin'))
    gf = -FAR_HALF + np.arange(2049) * 200.0
    xs, zs = np.meshgrid(gf, gf)
    enc_height(hfun(xs, zs)).tofile(os.path.join(out, 'height', 'far.bin'))
    print(f'  {time.time() - t0:.1f} s', flush=True)

    def centres(x0, z0, n, px):
        c = (np.arange(n) + 0.5) * px
        return np.meshgrid(x0 + c, z0 + c)

    # overview + far colour and land cover
    print('overviews ...', flush=True)
    for name, half, n in (('overview', CORE_HALF, 4096), ('far', FAR_HALF, 2048)):
        xs, zs = centres(-half, -half, n, 2 * half / n)
        h = hfun(xs, zs)
        lc = landcover_fn(xs, zs, h)
        Image.fromarray(lc, 'L').save(os.path.join(out, 'landcover', f'{name}.png'), optimize=True)
        Image.fromarray(color_fn(xs, zs, h, lc, 2 * half / n), 'RGB').save(os.path.join(out, 'color', f'{name}.jpg'), quality=88)
    print(f'  {time.time() - t0:.1f} s', flush=True)

    # L0 tiles
    tel = LL2XZ(34.8186, 31.8394)
    tix = int((tel[0] + CORE_HALF) // TILE_M)
    tiz = int((tel[1] + CORE_HALF) // TILE_M)
    print('L0 tiles ...', flush=True)
    for iz in range(NT):
        for ix in range(NT):
            if args.quick and not (abs(ix - tix) <= 2 and abs(iz - tiz) <= 2):
                continue
            x0 = -CORE_HALF + TILE_M * ix
            z0 = -CORE_HALF + TILE_M * iz
            xs, zs = centres(x0, z0, 640, 10.0)
            lc = landcover_fn(xs, zs, hfun(xs, zs))
            Image.fromarray(lc, 'L').save(os.path.join(out, 'landcover', f'tile_{ix}_{iz}.png'), optimize=True)
            xs, zs = centres(x0, z0, 1024, 6.25)
            h = hfun(xs, zs)
            lc = landcover_fn(xs, zs, h)
            Image.fromarray(color_fn(xs, zs, h, lc, 6.25), 'RGB').save(os.path.join(out, 'color', 'L0', f'tile_{ix}_{iz}.jpg'), quality=85)
        print(f'  row {iz}  {time.time() - t0:.1f} s', flush=True)

    spawns = build_spawns(airports, hfun)
    # spawns: y is the ground height under the spawn; airborne ones carry alt_m too
    with open(os.path.join(out, 'airports.json'), 'w') as f:
        json.dump(airports, f, indent=1)
    with open(os.path.join(out, 'spawns.json'), 'w') as f:
        json.dump(spawns, f, indent=1)

    files = {}
    for root, _, names in os.walk(out):
        for nm in names:
            p = os.path.join(root, nm)
            files[os.path.relpath(p, out)] = os.path.getsize(p)
    manifest = {
        'format': 'f35i-terrain/1',
        'synthetic': True,
        'projection': '+proj=tmerc +lat_0=31.80 +lon_0=35.025 +k=1 +x_0=0 +y_0=0 +ellps=WGS84',
        'core': {'half_m': CORE_HALF, 'tiles': NT, 'tile_m': TILE_M, 'samples': 257, 'spacing_m': 25},
        'far': {'half_m': FAR_HALF, 'samples': 2049, 'spacing_m': 200},
        'height': {'encoding': 'uint16le', 'scale': 0.05, 'offset': -500, 'tiles': 'height/tile_{ix}_{iz}.bin', 'far': 'height/far.bin'},
        'color': {'L0': 'color/L0/tile_{ix}_{iz}.jpg', 'L0_px': 1024, 'overview': 'color/overview.jpg', 'overview_px': 4096,
                  'far': 'color/far.jpg', 'far_px': 2048},
        'landcover': {'tiles': 'landcover/tile_{ix}_{iz}.png', 'tile_px': 640, 'overview': 'landcover/overview.png',
                      'overview_px': 4096, 'far': 'landcover/far.png', 'far_px': 2048},
        'airports': 'airports.json', 'spawns': 'spawns.json',
        'attribution': 'Synthetic test terrain (sim/dev/make_synthetic_terrain.py), not real data',
        'files': files,
    }
    with open(os.path.join(out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    print(f'done in {time.time() - t0:.1f} s -> {out}')


if __name__ == '__main__':
    main()
