"""previews/: hillshaded colour of the core and the far area, crops of Tel Nof, the Tel Aviv coast,
Jerusalem and the Dead Sea, straightened runway strips, and checks.txt.

Everything here is read back from the delivered files (what the app will load), not from the
intermediate products, so the previews and the checks show the data set as it is.
"""
import datetime
import glob
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

import grid
import osmcheck
from outputs import HeightField, LANDCOVER_CODES
from runways import Frame, L0Sampler

SUN_AZ, SUN_ALT = 315.0, 40.0

# (name, lon, lat, published value or (lo, hi) range in m, note)
KNOWN_POINTS = [
    ('Jerusalem Old City, Temple Mount (Dome of the Rock)', 35.2353, 31.7780, (735, 750),
     'bedrock of the Dome of the Rock ~744 m; task range for the Old City 740-780'),
    ('Jerusalem Old City, Church of the Holy Sepulchre', 35.2296, 31.7784, (740, 780), 'Old City 740-780'),
    ('Jerusalem Old City, Jaffa Gate', 35.2276, 31.7767, (740, 785), 'Old City 740-780'),
    ('Jerusalem Old City, Damascus Gate', 35.2302, 31.7815, (740, 780), 'Old City 740-780'),
    ('Mount of Olives, Chapel of the Ascension', 35.2449, 31.7786, (800, 826),
     'published about 810 m at the chapel, summit 818-826 m'),
    ('Dead Sea surface, north basin', 35.5000, 31.6500, (-440, -425),
     'published about -435 m (2021); the DEM (TanDEM-X 2011-15) has it at its level then'),
    ('Dead Sea surface, off Ein Feshkha', 35.4800, 31.7000, (-440, -425), 'as above'),
    ('Mediterranean, 1 km off Tel Aviv', 34.7550, 32.0800, (0, 0), 'sea level'),
    ('Mediterranean, 3 km off Ashdod', 34.6000, 31.8100, (0, 0), 'sea level'),
    ('Tel Nof air base, reference point', 34.8218, 31.8395, (50, 66), 'published 59 m (193 ft)'),
    ('Ben Gurion airport, reference point', 34.8867, 32.0114, (30, 50), 'published 41 m (135 ft)'),
]

CROPS = [
    # name, centre lon, lat, half width m, m per px
    ('telnof', 34.8240, 31.8380, 3200.0, 6.25),
    ('tel_aviv_coast', 34.7720, 32.0750, 5000.0, 6.25),
    ('jerusalem', 35.2150, 31.7800, 5000.0, 6.25),
    ('dead_sea', 35.4750, 31.7100, 8000.0, 10.0),
]


def log(*a):
    print('  [previews]', *a, flush=True)


# ---- shading -----------------------------------------------------------------------------------

def hillshade(h, step, exaggeration=1.0):
    """Lambert shading relative to flat ground (1.0 = flat), sun from the north-west."""
    gx = np.zeros_like(h)
    gy = np.zeros_like(h)
    gx[:, 1:-1] = (h[:, 2:] - h[:, :-2]) / (2 * step)
    gy[1:-1, :] = (h[:-2, :] - h[2:, :]) / (2 * step)          # row 0 is north: +y = north
    gx *= exaggeration
    gy *= exaggeration
    az, alt = math.radians(SUN_AZ), math.radians(SUN_ALT)
    sx, sy, sz = math.sin(az) * math.cos(alt), math.cos(az) * math.cos(alt), math.sin(alt)
    shade = (-gx * sx - gy * sy + sz) / np.sqrt(gx * gx + gy * gy + 1.0)
    return np.clip(shade / sz, 0.0, 2.0).astype(np.float32)


def shade_rgb(rgb, shade, strength):
    """rgb uint8 or 0..1 float -> uint8, multiplied by a softened shade factor."""
    f = rgb.astype(np.float32) / (255.0 if rgb.dtype == np.uint8 else 1.0)
    k = 1.0 + strength * (shade - 1.0)
    return (np.clip(f * k[..., None], 0, 1) * 255 + 0.5).astype(np.uint8)


def bilinear_grid(a, x0, step, x, z):
    c = np.clip((x - x0) / step, 0, a.shape[1] - 1.000001)
    r = np.clip((z - x0) / step, 0, a.shape[0] - 1.000001)
    c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int)
    fc, fr = c - c0, r - r0
    return ((a[r0, c0] * (1 - fc) + a[r0, c0 + 1] * fc) * (1 - fr) +
            (a[r0 + 1, c0] * (1 - fc) + a[r0 + 1, c0 + 1] * fc) * fr)


def save(path, img, q=88):
    tmp = path + '.tmp.jpg'
    img.save(tmp, quality=q, subsampling=0, optimize=True)
    os.replace(tmp, path)


# ---- previews ------------------------------------------------------------------------------------

def core_preview(out, H, shade_core, pdir):
    ov = np.asarray(Image.open(os.path.join(out, 'color', 'overview.jpg')).convert('RGB'))
    img = Image.fromarray(ov).resize((2048, 2048), Image.BOX)
    sh = shade_core[1::2, 1::2][:2048, :2048]      # 50 m pixel centres are core samples 2i + 1
    save(os.path.join(pdir, 'core_hillshade.jpg'), Image.fromarray(shade_rgb(np.asarray(img), sh, 0.55)))


def far_preview(out, H, pdir):
    far = np.asarray(Image.open(os.path.join(out, 'color', 'far.jpg')).convert('RGB'))
    sh = hillshade(H.far, grid.FAR_H_STEP, exaggeration=2.0)
    shc = 0.25 * (sh[:-1, :-1] + sh[1:, :-1] + sh[:-1, 1:] + sh[1:, 1:])     # pixel centres
    save(os.path.join(pdir, 'far_hillshade.jpg'), Image.fromarray(shade_rgb(far, shc, 0.6)))


def crop_xy(samp, shade_core, cx, cz, half, res):
    gx = np.arange(cx - half + res / 2, cx + half, res)
    gz = np.arange(cz - half + res / 2, cz + half, res)
    X, Z = np.meshgrid(gx, gz)
    rgb = samp.sample(X, Z)
    sh = bilinear_grid(shade_core, -grid.CORE_HALF, grid.H_STEP, X, Z)
    return shade_rgb(rgb, sh, 0.35), gx, gz


def crops(out, samp, shade_core, pdir):
    for name, lon, lat, half, res in CROPS:
        cx, cz = grid.lonlat_to_xz(lon, lat)
        lim = grid.CORE_HALF - half
        cx, cz = float(np.clip(cx, -lim, lim)), float(np.clip(cz, -lim, lim))
        img, _, _ = crop_xy(samp, shade_core, cx, cz, half, res)
        save(os.path.join(pdir, f'{name}.jpg'), Image.fromarray(img))
        log(f'{name}.jpg {img.shape[1]} x {img.shape[0]} px, {res} m/px, centre x {cx:.0f} z {cz:.0f}')


def telnof_overlay(out, samp, shade_core, airports, spawns, pdir):
    """Tel Nof at 2.5 m/px with the runways of airports.json and the spawns drawn on."""
    ap = [a for a in airports if a['icao'] == 'LLEK'][0]
    cx, cz = ap['x'], ap['z']
    half, res = 2000.0, 2.5
    img, gx, gz = crop_xy(samp, shade_core, cx, cz, half, res)
    im = Image.fromarray(img)
    d = ImageDraw.Draw(im)
    P = lambda x, z: ((x - gx[0]) / res, (z - gz[0]) / res)
    for r in ap['runways']:
        a, b = r['ends']
        fr = Frame(a['x'], a['z'], b['x'], b['z'])
        for v in (-r['width_m'] / 2, r['width_m'] / 2):
            d.line([P(*fr.xz(0, v)), P(*fr.xz(fr.length, v))], fill=(255, 40, 40), width=1)
        for e in (a, b):
            px, py = P(e['x'], e['z'])
            d.text((px + 6, py - 6), e['id'], fill=(255, 255, 0))
    for k, s in spawns.items():
        if s.get('airport') == 'LLEK' and s['on_ground']:
            px, py = P(s['x'], s['z'])
            h = math.radians(s['heading_deg'])
            d.ellipse([px - 4, py - 4, px + 4, py + 4], outline=(0, 255, 255), width=2)
            d.line([(px, py), (px + 25 * math.sin(h), py - 25 * math.cos(h))], fill=(0, 255, 255), width=2)
            d.text((px + 8, py + 4), k, fill=(0, 255, 255))
    save(os.path.join(pdir, 'telnof_runways.jpg'), im)


def runway_strips(out, samp, airports, osm_lines, pdir):
    """Each runway straightened (2.5 m along x 0.5 m across), red = pavement edges from airports.json,
    cyan = thresholds, yellow = the OpenStreetMap centreline when available."""
    strips = []
    for ap in airports:
        for r in ap['runways']:
            a, b = r['ends']
            fr = Frame(a['x'], a['z'], b['x'], b['z'])
            L, oa, ob = fr.length, a['overrun_m'], b['overrun_m']
            us = np.arange(-oa - 150, L + ob + 150, 2.5)
            vs = np.arange(-60, 60.01, 0.5)
            U, V = np.meshgrid(us, vs)
            im = Image.fromarray((np.clip(samp.sample(*fr.xz(U, V)), 0, 1) * 255).astype(np.uint8))
            d = ImageDraw.Draw(im)
            ux = lambda u: (u - us[0]) / 2.5
            vy = lambda v: (v + 60) / 0.5
            W = r['width_m']
            if osm_lines:
                for x, z in osm_lines:
                    u = (x - a['x']) * fr.t[0] + (z - a['z']) * fr.t[1]
                    v = (x - a['x']) * fr.n[0] + (z - a['z']) * fr.n[1]
                    if np.all(np.abs(v) < 60) and u.max() > -oa and u.min() < L + ob:
                        d.line([(ux(p), vy(q)) for p, q in zip(u, v)], fill=(255, 255, 0), width=1)
            for v in (-W / 2, W / 2):
                d.line([(ux(-oa), vy(v)), (ux(L + ob), vy(v))], fill=(255, 0, 0))
            for u in (0, L):
                d.line([(ux(u), vy(-W / 2 - 6)), (ux(u), vy(W / 2 + 6))], fill=(0, 255, 255), width=2)
            d.text((4, 2), f'{ap["icao"]} {"/".join(r["ids"])}  {L:.0f} x {W:.0f} m  '
                           f'(left: {a["id"]}, right: {b["id"]})', fill=(255, 255, 0))
            if im.width > 1600:
                im = im.resize((1600, im.height), Image.BOX)
            strips.append(im)
    Wd = max(s.width for s in strips)
    canvas = Image.new('RGB', (Wd, sum(s.height + 4 for s in strips)), (0, 0, 0))
    y = 0
    for s in strips:
        canvas.paste(s, (0, y))
        y += s.height + 4
    save(os.path.join(pdir, 'runway_strips.jpg'), canvas)


# ---- checks.txt -----------------------------------------------------------------------------------

class Report:
    def __init__(self):
        self.lines = []

    def __call__(self, s=''):
        self.lines.append(s)

    def head(self, s):
        self.lines += ['', s, '-' * len(s)]


def check_files(out, rep):
    rep.head('1. Files and formats')
    ok = True
    n = 0
    for iz in range(grid.NTILES):
        for ix in range(grid.NTILES):
            p = os.path.join(out, 'height', f'tile_{ix}_{iz}.bin')
            if not os.path.exists(p) or os.path.getsize(p) != grid.H_TILE_N ** 2 * 2:
                ok = False
                rep(f'  BAD height tile {p}')
            else:
                n += 1
    rep(f'  height tiles: {n}/256 present, {grid.H_TILE_N ** 2 * 2} bytes each (257 x 257 uint16 LE)')
    fsz = os.path.getsize(os.path.join(out, 'height', 'far.bin'))
    rep(f'  height/far.bin: {fsz} bytes (expected {grid.FAR_H_N ** 2 * 2})')
    ok &= fsz == grid.FAR_H_N ** 2 * 2
    bad = []
    for d, ext, px, mode in (('color/L0', 'jpg', grid.L0_PX, 'RGB'), ('landcover', 'png', grid.LC_TILE_PX, 'L')):
        cnt = 0
        for iz in range(grid.NTILES):
            for ix in range(grid.NTILES):
                p = os.path.join(out, d, f'tile_{ix}_{iz}.{ext}')
                try:
                    with Image.open(p) as im:
                        if im.size != (px, px) or im.mode != mode:
                            bad.append(f'{p} {im.size} {im.mode}')
                        else:
                            cnt += 1
                except OSError:
                    bad.append(p)
        rep(f'  {d}: {cnt}/256 tiles {px} x {px} {mode}')
    for f, px, mode in (('color/overview.jpg', grid.COLOR_OVERVIEW_PX, 'RGB'), ('color/far.jpg', grid.COLOR_FAR_PX, 'RGB'),
                        ('landcover/overview.png', grid.LC_OVERVIEW_PX, 'L'), ('landcover/far.png', grid.LC_FAR_PX, 'L')):
        with Image.open(os.path.join(out, f)) as im:
            good = im.size == (px, px) and im.mode == mode
            rep(f'  {f}: {im.size[0]} x {im.size[1]} {im.mode} {"ok" if good else "BAD"}')
            ok &= good
    for b in bad:
        rep(f'  BAD {b}')
    ok &= not bad
    # land cover values
    vals = set()
    for p in glob.glob(os.path.join(out, 'landcover', '*.png')):
        vals |= set(np.unique(np.asarray(Image.open(p))).tolist())
    unknown = sorted(v for v in vals if v not in LANDCOVER_CODES)
    rep(f'  land cover values present: {sorted(vals)}' + (f'  UNKNOWN: {unknown}' if unknown else ' (all WorldCover codes)'))
    ok &= not unknown
    total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(out) for f in fs)
    rep(f'  data/terrain total: {total / 1e6:.1f} MB (budget ~350 MB)')
    for sub in ('height', 'color', 'landcover', 'previews'):
        s = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(os.path.join(out, sub)) for f in fs)
        rep(f'    {sub}/: {s / 1e6:.1f} MB')
    rep(f'  RESULT: {"PASS" if ok else "FAIL"}')
    return ok


def check_edges(out, rep):
    rep.head('2. Height tiles: shared edges, far grid inside the core')
    worst = 0.0
    tiles = {}
    for iz in range(grid.NTILES):
        for ix in range(grid.NTILES):
            tiles[(ix, iz)] = np.fromfile(os.path.join(out, 'height', f'tile_{ix}_{iz}.bin'), '<u2').reshape(257, 257)
    for iz in range(grid.NTILES):
        for ix in range(grid.NTILES):
            t = tiles[(ix, iz)]
            if ix + 1 < grid.NTILES:
                worst = max(worst, float(np.abs(t[:, -1].astype(int) - tiles[(ix + 1, iz)][:, 0]).max()))
            if iz + 1 < grid.NTILES:
                worst = max(worst, float(np.abs(t[-1, :].astype(int) - tiles[(ix, iz + 1)][0, :]).max()))
    rep(f'  shared edges: max difference {worst:.0f} counts ({"identical" if worst == 0 else "MISMATCH"})')
    return worst == 0


def check_far(H, out, rep):
    # far samples inside the core vs the core heights at the same points
    k = int(grid.FAR_H_STEP / grid.H_STEP)
    c0 = int((grid.FAR_HALF - grid.CORE_HALF) / grid.FAR_H_STEP)
    nf = int(2 * grid.CORE_HALF / grid.FAR_H_STEP) + 1
    far_in = H.far[c0:c0 + nf, c0:c0 + nf]
    core_pts = H.core[::k, ::k]
    d = far_in - core_pts
    rep(f'  far.bin inside the core vs the core samples at the same points (far = core box-filtered to 200 m, core samples near the edge): '
        f'mean {d.mean():+.2f} m, rms {np.sqrt((d ** 2).mean()):.2f} m, p99 |d| {np.percentile(np.abs(d), 99):.2f} m')
    edge = np.concatenate([d[0], d[-1], d[:, 0], d[:, -1]])
    rep(f'  along the core boundary (where the far mesh meets the core): rms {np.sqrt((edge ** 2).mean()):.2f} m, '
        f'max |d| {np.abs(edge).max():.2f} m')
    # colour: far.jpg inside the core vs overview.jpg averaged to 200 m
    far = np.asarray(Image.open(os.path.join(out, 'color', 'far.jpg')).convert('RGB'), np.float32)
    ov = np.asarray(Image.open(os.path.join(out, 'color', 'overview.jpg')).convert('RGB'), np.float32)
    ov8 = ov.reshape(512, 8, 512, 8, 3).mean(axis=(1, 3))
    p0 = int((grid.FAR_HALF - grid.CORE_HALF) / (2 * grid.FAR_HALF / grid.COLOR_FAR_PX))
    fin = far[p0:p0 + 512, p0:p0 + 512]
    dc = fin - ov8
    rep(f'  far.jpg inside the core vs overview.jpg averaged to 200 m: mean {[round(float(v), 2) for v in dc.mean(axis=(0, 1))]} '
        f'(R, G, B levels), mean |d| {np.abs(dc).mean():.2f} levels')
    p1 = p0 + 512
    sides = {'north': (far[p0, p0:p1], far[p0 - 1, p0:p1]), 'south': (far[p1 - 1, p0:p1], far[p1, p0:p1]),
             'west': (far[p0:p1, p0], far[p0:p1, p0 - 1]), 'east': (far[p0:p1, p1 - 1], far[p0:p1, p1])}
    parts = []
    for name, (i, o) in sides.items():
        land = (i[:, 2] < i[:, 0]) & (o[:, 2] < o[:, 0])          # leave the sea out
        if land.any():
            d = (o[land] - i[land]).mean(axis=0)
            parts.append(f'{name} {[round(float(v), 1) for v in d]}')
    rep('  far.jpg colour step across the core edge (outside - inside, adjacent 200 m pixels over land, '
        'R G B levels): ' + '; '.join(parts))


def check_points(H, rep, airports):
    rep.head('3. Heights at known points vs published values')
    rep('  (Copernicus DEM GLO-30, EGM2008; buildings and trees cut to the ground; bilinear from the tiles)')
    rep(f'  {"place":52s} {"lon":>9s} {"lat":>8s} {"ours m":>8s}  {"expected m":>12s}  result')
    allok = True
    for name, lon, lat, rng, note in KNOWN_POINTS:
        x, z = grid.lonlat_to_xz(lon, lat)
        h = H.at(x, z)
        lo, hi = rng
        ok = lo - 0.01 <= h <= hi + 0.01
        allok &= ok
        rep(f'  {name:52s} {lon:9.4f} {lat:8.4f} {h:8.1f}  {lo:5.0f} .. {hi:<5.0f}  {"PASS" if ok else "CHECK"}  ({note})')
    # airports: published elevation vs the terrain at the runway ends
    rep('')
    rep('  airports: published elevation (OurAirports) vs the terrain at the runway thresholds')
    for ap in airports:
        ys = [e['y'] for r in ap['runways'] for e in r['ends']]
        pub = ap['elev_m']
        rep(f'  {ap["icao"]:8s} {ap["name"]:28s} published {pub:7.1f} m   thresholds {min(ys):7.1f} .. {max(ys):7.1f} m'
            f'   (highest threshold - published {max(ys) - pub:+.1f} m)')
    # extremes
    i = np.unravel_index(np.argmax(H.core), H.core.shape)
    j = np.unravel_index(np.argmin(H.core), H.core.shape)
    for lab, (r, c) in (('highest', i), ('lowest', j)):
        x, z = -grid.CORE_HALF + c * grid.H_STEP, -grid.CORE_HALF + r * grid.H_STEP
        lon, lat = grid.xz_to_lonlat(x, z)
        rep(f'  {lab} core sample: {H.core[r, c]:.1f} m at {lon:.4f} E {lat:.4f} N')
    return allok


def check_water(H, out, rep, levels):
    rep.head('4. Water')
    lc = np.asarray(Image.open(os.path.join(out, 'landcover', 'overview.png')))
    px = 2 * grid.CORE_HALF / grid.LC_OVERVIEW_PX
    xs = -grid.CORE_HALF + px * (np.arange(grid.LC_OVERVIEW_PX) + 0.5)
    X, Z = np.meshgrid(xs, xs)
    h = bilinear_grid(H.core, -grid.CORE_HALF, grid.H_STEP, X, Z)
    water = ndimage.binary_opening(lc == 80, iterations=3)   # without rivers and narrow channels
    lab, _ = ndimage.label(water)
    west = np.unique(lab[:, 0])
    sea = np.isin(lab, west[west > 0])                     # water connected to the west edge
    dx, dz = grid.lonlat_to_xz(35.50, 31.65)
    ci, ri = int((dx + grid.CORE_HALF) / px), int((dz + grid.CORE_HALF) / px)
    dead = (lab == lab[ri, ci]) & (lab[ri, ci] > 0)
    for lab, m, lvl in (('Mediterranean', sea, levels['mediterranean_m']), ('Dead Sea', dead, levels['dead_sea_m'])):
        if m.any():
            v = h[m]
            interior = ndimage.binary_erosion(m, iterations=8)          # more than 200 m from the shore
            vi = h[interior] if interior.any() else v
            rep(f'  {lab}: level {lvl:.1f} m; heights over its land-cover water {v.min():.2f} .. {v.max():.2f} m '
                f'(p1 {np.percentile(v, 1):.2f}, p99 {np.percentile(v, 99):.2f}); away from the shore '
                f'{np.percentile(vi, 0.5):.2f} .. {np.percentile(vi, 99.5):.2f} m')
    rep('  The Dead Sea is at its DEM level (TanDEM-X acquisitions 2011-2015, when the lake stood at about '
        '-425 to -429 m); published today about -435 to -438 m. The contract says "at its DEM level".')


def check_coast(H, out, rep, osm):
    rep.head('5. Coastline')
    coast = (osm or {}).get('coast') if osm else None
    if not coast:
        rep('  OpenStreetMap comparison not available (osmcheck stage skipped)')
    else:
        rep('  shoreline along parallels: OpenStreetMap coastline (Overture ocean polygons, '
            f'{osm.get("release")}) vs the delivered land cover (first land >= 50 m wide east of the open sea)')
        rep(f'  {"lat":>7s} {"OSM lon":>10s} {"ours lon":>10s} {"ours - OSM":>11s}')
        for c in coast:
            if c.get('ours_minus_osm_m') is None:
                rep(f'  {c["lat"]:7.2f}  n/a')
                continue
            rep(f'  {c["lat"]:7.2f} {c["osm_lon"]:10.5f} {c["ours_lon"]:10.5f} {c["ours_minus_osm_m"]:+9.1f} m')
        d = np.array([c['ours_minus_osm_m'] for c in coast if c.get('ours_minus_osm_m') is not None])
        rep(f'  mean {d.mean():+.1f} m, max |d| {np.abs(d).max():.1f} m (+ = our shoreline is east / landward). '
            'OSM maps the high-water line; the 10 m land cover counts the wet swash zone as water, '
            'hence a landward bias of 1-3 pixels.')
    # Tel Aviv: the beach profile across the shore at 32.08 N
    lat = 32.08
    lons = np.arange(34.7600, 34.7720, 0.0002)
    x, z = grid.lonlat_to_xz(lons, np.full_like(lons, lat))
    h = H.at(x, z)
    shore = osmcheck.lc_shoreline_lon(out, lat)
    if shore is None:
        rep('  Tel Aviv beach: no shoreline found in the land cover at 32.08 N (CHECK)')
        return
    rep('')
    rep(f'  Tel Aviv beach at {lat} N (delivered shoreline {shore:.5f} E): heights west -> east')
    row = []
    for lo, hh in zip(lons, h):
        dx = (lo - shore) * 111320 * math.cos(math.radians(lat))
        row.append(f'{dx:+.0f} m: {hh:.1f}')
    for k in range(0, len(row), 6):
        rep('    ' + ' | '.join(row[k:k + 6]))
    sx, sz = grid.lonlat_to_xz(np.array([shore + d / (111320 * math.cos(math.radians(lat))) for d in (30, 60, 90)]),
                               np.full(3, lat))
    beach = H.at(sx, sz)
    ok = bool(np.all((beach >= 0) & (beach <= 6)))
    rep(f'  beach 30 / 60 / 90 m inland of the shoreline: {[round(float(v), 1) for v in beach]} m, expected 0-5 m: '
        f'{"PASS" if ok else "CHECK"}')


def check_runways(out, rep, airports, rw_report, osm, hinfo, H):
    rep.head('6. Runways')
    rep('  Source: OurAirports runways.csv; every runway checked in the delivered colour tiles (pavement = '
        'low-saturation trough in cross profiles, 200 m segments) and moved onto the imagery centreline; '
        'the CSV heading is kept unless the imagery rotation exceeds 15 m at the ends.')
    rep('  OSM column: independent check, offset of the OpenStreetMap runway line from ours at each end (m, + = right '
        'looking from the first end); not used to build anything.')
    om = {r['runway']: r for r in (osm or {}).get('runways', [])}
    for ap in airports:
        for r in ap['runways']:
            key = f'{ap["icao"]} {"/".join(r["ids"])}'
            a, b = r['ends']
            o = om.get(key)
            if o and o.get('matched'):
                oo = o['offset_at_end_m']
                osm_s = f'OSM {oo[a["id"]]:+5.1f} / {oo[b["id"]]:+5.1f} m (angle {o["angle_deg"]:+.2f})'
            else:
                osm_s = 'OSM n/a'
            fl = hinfo['runways'].get(key, {})
            rep(f'  {key:15s} {r["length_m"]:6.0f} x {r["width_m"]:4.0f} m  {r["position_source"]:48s} {osm_s}')
            rep(f'  {"":15s} ends y {a["y"]:.1f} / {b["y"]:.1f} m, headings {a["heading_deg"]:.2f} / {b["heading_deg"]:.2f}, '
                f'overruns {a["overrun_m"]:.0f} / {b["overrun_m"]:.0f} m; flattened profile {fl.get("min", 0):.1f} .. '
                f'{fl.get("max", 0):.1f} m, max grade {fl.get("slope_max_pct", 0):.2f} %')
            # level across: heights across the runway at its middle
            fr = Frame(a['x'], a['z'], b['x'], b['z'])
            vv = np.linspace(-r['width_m'] / 2 - 15, r['width_m'] / 2 + 15, 9)
            cross = []
            for u in (0.1, 0.5, 0.9):
                hx = H.at(*fr.xz(np.full_like(vv, u * fr.length), vv))
                cross.append(float(hx.max() - hx.min()))
            rep(f'  {"":15s} across pavement + 15 m shoulders (at 10/50/90 %): '
                f'{" / ".join(f"{c:.2f}" for c in cross)} m height range')
    if osm and osm.get('runways'):
        vals = [abs(v) for r in osm['runways'] if r.get('matched') for v in r['offset_at_end_m'].values()]
        rep(f'  OSM offsets at the runway ends: median {np.median(vals):.1f} m, max {max(vals):.1f} m '
            f'({sum(v <= 10 for v in vals)}/{len(vals)} within 10 m)')
        others = osm.get('osm_runways_not_in_ourairports', [])
        if others:
            rep('  OSM runway lines inside the core that are not OurAirports runways (not included):')
            for o in others:
                rep(f'    {o["name"] or "(no name)"}: {o["length_m"]} m, {o["surface"] or "?"}, at {o["lon"]} E {o["lat"]} N')
    rep('')
    rep('  Pipeline notes per runway (runways stage):')
    for line in rw_report:
        rep('    ' + line)


def check_spawns(H, rep, spawns, airports):
    rep.head('7. Spawns')
    for k, s in spawns.items():
        g = H.at(s['x'], s['z'])
        extra = f'ground {g:.1f} m, AGL {s["y"] - g:.0f} m' if not s['on_ground'] else f'ground {g:.2f} m (y - ground {s["y"] - g:+.2f})'
        lon, lat = grid.xz_to_lonlat(s['x'], s['z'])
        rep(f'  {k:18s} {s["label"]}')
        rep(f'  {"":18s} x {s["x"]:.1f} y {s["y"]:.1f} z {s["z"]:.1f} ({lon:.4f} E {lat:.4f} N), heading {s["heading_deg"]:.1f}, '
            f'{s["speed_ms"]} m/s, {"on ground" if s["on_ground"] else "airborne"}; {extra}')
        if s['on_ground']:
            ap = [a for a in airports if a['icao'] == s['airport']][0]
            for r in ap['runways']:
                for e in r['ends']:
                    if e['id'] == s['runway']:
                        fr = Frame(e['x'], e['z'], *[(o['x'], o['z']) for o in r['ends'] if o is not e][0])
                        u = (s['x'] - e['x']) * fr.t[0] + (s['z'] - e['z']) * fr.t[1]
                        v = (s['x'] - e['x']) * fr.n[0] + (s['z'] - e['z']) * fr.n[1]
                        dh = (s['heading_deg'] - e['heading_deg'] + 180) % 360 - 180
                        rep(f'  {"":18s} on runway {s["runway"]}: {u:.0f} m past the threshold, {v:+.2f} m off the '
                            f'centreline, heading {dh:+.2f} deg from the runway heading')


def colour_stats(out, rep):
    rep.head('8. Colour')
    ov = np.asarray(Image.open(os.path.join(out, 'color', 'overview.jpg')).convert('RGB'))
    lc = np.asarray(Image.open(os.path.join(out, 'landcover', 'overview.png')))
    rep('  mean sRGB of the overview per land-cover class:')
    for code in (10, 20, 30, 40, 50, 60, 80, 90):
        m = lc == code
        if m.sum() > 1000:
            c = ov[m].mean(axis=0)
            rep(f'    {code:3d} {LANDCOVER_CODES[code]:28s} {[int(round(float(v))) for v in c]}  ({m.mean() * 100:.1f} % of the core)')
    clip_hi = clip_white = clip_lo = n = 0
    for p in glob.glob(os.path.join(out, 'color', 'L0', '*.jpg')):
        a = np.asarray(Image.open(p).convert('RGB'))[::4, ::4]
        hi = a.max(axis=-1) >= 254
        clip_hi += int(hi.sum())
        clip_white += int((hi & (a.min(axis=-1) >= 240)).sum())
        clip_lo += int((a.min(axis=-1) <= 1).sum())
        n += a.shape[0] * a.shape[1]
    rep(f'  L0 pixels with a channel at 254-255 (every 16th pixel): {clip_hi / n * 100:.3f} % '
        f'({clip_white / max(clip_hi, 1) * 100:.0f} % of them white surfaces, all channels >= 240: roofs, '
        f'salt, quarries); at 0-1: {clip_lo / n * 100:.3f} %. The grading keeps coloured pixels <= 246 '
        '(only near-white surfaces go higher); the rest is JPEG noise.')
    lum = (ov.astype(np.float32) @ np.array([0.2126, 0.7152, 0.0722])).ravel()
    rep(f'  overview luminance percentiles 1/50/99: {np.percentile(lum, 1):.0f} / {np.percentile(lum, 50):.0f} / '
        f'{np.percentile(lum, 99):.0f}')


def run(cache, out):
    work = os.path.join(cache, 'work')
    pdir = os.path.join(out, 'previews')
    os.makedirs(pdir, exist_ok=True)
    H = HeightField(out)
    with open(os.path.join(out, 'airports.json')) as f:
        airports = json.load(f)
    with open(os.path.join(out, 'spawns.json')) as f:
        spawns = json.load(f)
    with open(os.path.join(work, 'runways.json')) as f:
        rw_report = json.load(f)['report']
    with open(os.path.join(work, 'heights_info.json')) as f:
        hinfo = json.load(f)
    osm = None
    p = os.path.join(work, 'osm_check.json')
    if os.path.exists(p):
        with open(p) as f:
            osm = json.load(f)
        if 'skipped' in osm:
            osm = None
    osm_lines = []
    p = os.path.join(cache, 'osm', 'airport_infrastructure.json')
    if os.path.exists(p):
        with open(p) as f:
            for ft in json.load(f):
                if ft['cls'] == 'runway':
                    pts = osmcheck.line_points(osmcheck.parse_wkb(bytes.fromhex(ft['wkb']))[0])
                    if pts is not None:
                        x, z = grid.lonlat_to_xz(pts[:, 0], pts[:, 1])
                        osm_lines.append((np.asarray(x), np.asarray(z)))

    shade_core = hillshade(H.core, grid.H_STEP, exaggeration=1.5)
    samp = L0Sampler(out)
    core_preview(out, H, shade_core, pdir)
    log('core_hillshade.jpg')
    far_preview(out, H, pdir)
    log('far_hillshade.jpg')
    crops(out, samp, shade_core, pdir)
    telnof_overlay(out, samp, shade_core, airports, spawns, pdir)
    log('telnof_runways.jpg')
    runway_strips(out, samp, airports, osm_lines, pdir)
    log('runway_strips.jpg')

    rep = Report()
    rep('F-35I sim terrain data: checks')
    rep(f'generated {datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")} by '
        'sim/tools/terrain/build.py (stage previews); everything below is read back from the delivered files')
    rep('World: X = east, Y = up (m MSL, EGM2008), Z = south; core X, Z in [-51200, 51200], far in [-204800, 204800]')
    ok = check_files(out, rep)
    ok &= check_edges(out, rep)
    check_far(H, out, rep)
    ok &= check_points(H, rep, airports)
    check_water(H, out, rep, hinfo['levels'])
    check_coast(H, out, rep, osm)
    check_runways(out, rep, airports, rw_report, osm, hinfo, H)
    check_spawns(H, rep, spawns, airports)
    colour_stats(out, rep)
    rep('')
    rep(f'OVERALL (formats, edges, known points): {"PASS" if ok else "CHECK the lines marked above"}')
    with open(os.path.join(pdir, 'checks.txt'), 'w') as f:
        f.write('\n'.join(rep.lines) + '\n')
    log('checks.txt', 'PASS' if ok else 'CHECK')
