"""airports.json, spawns.json and manifest.json (sim/DESIGN.md, "Data: data/terrain/").

Every height written here (runway ends, spawns) is read back from the delivered height tiles,
bilinearly, exactly as Terrain.heightAt does in the app.
"""
import datetime
import json
import math
import os

import numpy as np

import grid

FT = 0.3048
KT = 0.514444

ATTRIBUTION = (
    'Terrain: Copernicus DEM GLO-30, produced using Copernicus WorldDEM-30 '
    '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under '
    'COPERNICUS by the European Union and ESA; all rights reserved. '
    'Imagery and land cover: © ESA WorldCover project 2021 / Contains modified Copernicus '
    'Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0). '
    'Airports: OurAirports (public domain).')

SOURCES = [
    dict(name='Copernicus DEM GLO-30 (2021 release, COG)', provider='ESA / DLR / Airbus, via the AWS Open Data registry',
         url='https://copernicus-dem-30m.s3.amazonaws.com/',
         licence='Copernicus DEM licence (free use with attribution)',
         use='heights: GLO-30 tiles for the core and its ring, their 4x internal overviews (~120 m) for the far area',
         vertical='EGM2008 geoid (m above mean sea level)',
         attribution='produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and '
                     'Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved'),
    dict(name='ESA WorldCover 10 m 2021 v200 Sentinel-2 RGBNIR composite', provider='ESA WorldCover consortium',
         url='https://esa-worldcover-s2.s3.amazonaws.com/', licence='CC BY 4.0',
         use='colour: median summer-season Sentinel-2 L2A reflectance (B4, B3, B2, B8) graded to sRGB; '
             '8x internal overviews for the far area',
         attribution='© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) '
                     'processed by ESA WorldCover consortium'),
    dict(name='ESA WorldCover 10 m 2021 v200 land cover map', provider='ESA WorldCover consortium',
         url='https://esa-worldcover.s3.amazonaws.com/', licence='CC BY 4.0',
         use='land cover tiles, the water masks (sea, Dead Sea, inland water), the building / tree clamp',
         attribution='© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) '
                     'processed by ESA WorldCover consortium'),
    dict(name='OurAirports airports.csv and runways.csv', provider='OurAirports (David Megginson et al.)',
         url='https://davidmegginson.github.io/ourairports-data/', licence='Public domain',
         use='airports and runways (each checked and, where needed, corrected against the imagery)',
         attribution='OurAirports'),
]

LANDCOVER_CODES = {
    0: 'no data', 10: 'tree cover', 20: 'shrubland', 30: 'grassland', 40: 'cropland', 50: 'built-up',
    60: 'bare / sparse vegetation', 70: 'snow and ice', 80: 'permanent water bodies', 90: 'herbaceous wetland',
    95: 'mangroves', 100: 'moss and lichen'}

SURFACES = {'asp': 'asphalt', 'asphalt': 'asphalt', 'bit': 'asphalt', 'con': 'concrete', 'concrete': 'concrete',
            'pem': 'asphalt', 'grv': 'gravel', 'gvl': 'gravel', 'gravel': 'gravel', 'grs': 'grass', 'grass': 'grass',
            'turf': 'grass', 'dirt': 'dirt', 'san': 'sand', 'unk': 'unknown'}

PREVAILING_WIND_FROM_DEG = 290.0   # summer afternoon sea breeze over the coastal plain (WNW)


def log(*a):
    print('  [json]', *a, flush=True)


def surface_name(s):
    s0 = (s or '').strip().lower()
    return SURFACES.get(s0, SURFACES.get(s0[:3], s0 or 'unknown'))


# ---- the delivered height field --------------------------------------------------------------

class HeightField:
    """The delivered heights (core tiles + far.bin), sampled like Terrain.heightAt (bilinear)."""

    def __init__(self, out):
        n = grid.H_TILE_N - 1
        N = grid.NTILES * n + 1
        core = np.zeros((N, N), np.float32)
        for iz in range(grid.NTILES):
            for ix in range(grid.NTILES):
                v = np.fromfile(os.path.join(out, 'height', f'tile_{ix}_{iz}.bin'), dtype='<u2')
                core[iz * n: iz * n + n + 1, ix * n: ix * n + n + 1] = \
                    grid.decode_height(v.reshape(grid.H_TILE_N, grid.H_TILE_N))
        self.core = core
        far = np.fromfile(os.path.join(out, 'height', 'far.bin'), dtype='<u2')
        self.far = grid.decode_height(far.reshape(grid.FAR_H_N, grid.FAR_H_N)).astype(np.float32)

    @staticmethod
    def _bilinear(a, x0, step, x, z):
        c = np.clip((np.asarray(x, np.float64) - x0) / step, 0, a.shape[1] - 1.000001)
        r = np.clip((np.asarray(z, np.float64) - x0) / step, 0, a.shape[0] - 1.000001)
        c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int)
        fc, fr = c - c0, r - r0
        return ((a[r0, c0] * (1 - fc) + a[r0, c0 + 1] * fc) * (1 - fr) +
                (a[r0 + 1, c0] * (1 - fc) + a[r0 + 1, c0 + 1] * fc) * fr)

    def at(self, x, z):
        x, z = np.asarray(x, np.float64), np.asarray(z, np.float64)
        inside = (np.abs(x) <= grid.CORE_HALF) & (np.abs(z) <= grid.CORE_HALF)
        h = np.where(inside, self._bilinear(self.core, -grid.CORE_HALF, grid.H_STEP, x, z),
                     self._bilinear(self.far, -grid.FAR_HALF, grid.FAR_H_STEP, x, z))
        return float(h) if h.ndim == 0 else h


def heading_deg(dx, dz):
    """World heading: 0 = north (-Z), 90 = east (+X)."""
    return (math.degrees(math.atan2(dx, -dz)) + 360.0) % 360.0


def r2(v, n=2):
    return float(round(float(v), n))


# ---- airports.json ---------------------------------------------------------------------------

def build_airports(rw_airports, H):
    out = []
    for ap in rw_airports:
        runways = []
        for r in ap['runways']:
            ends = []
            for e in r['ends']:
                ends.append(dict(id=e['id'], x=r2(e['x']), z=r2(e['z']), y=r2(H.at(e['x'], e['z'])),
                                 heading_deg=r2(e['heading_deg']), lon=e['lon'], lat=e['lat'],
                                 overrun_m=r2(e['overrun_m'], 1),
                                 displaced_threshold_m=r2(e.get('displaced_threshold_m', 0.0), 1)))
            chk = r.get('check', {})
            runways.append(dict(ids=list(r['ids']), width_m=r2(r['width_m'], 1), length_m=r2(r['length_m'], 1),
                                surface=surface_name(r['surface']), lighted=bool(r.get('lighted', False)),
                                ends=ends, length_published_m=r.get('length_csv_m'),
                                position_source=('OurAirports, confirmed / corrected in the imagery'
                                                 if chk.get('fit_ok') else
                                                 ('imagery' if str(r.get('source', '')).startswith('imagery')
                                                  else 'OurAirports (imagery not conclusive)'))))
        if not runways:
            continue
        end_ys = [e['y'] for r in runways for e in r['ends']]
        x, z = grid.lonlat_to_xz(ap['lon'], ap['lat'])
        elev_pub = ap.get('elev_ft')
        out.append(dict(icao=ap['icao'], name=ap['name'],
                        elev_m=r2(elev_pub * FT, 1) if elev_pub is not None else r2(max(end_ys), 1),
                        elev_terrain_m=r2(max(end_ys), 1),
                        full_name=ap.get('full_name', ap['name']), closed=bool(ap.get('closed', False)),
                        lon=ap['lon'], lat=ap['lat'], x=r2(x, 1), z=r2(z, 1), runways=runways))
    out.sort(key=lambda a: (a['closed'], -max(r['length_m'] for r in a['runways'])))
    return out


# ---- spawns.json -----------------------------------------------------------------------------

def _find_airport(airports, icao):
    for ap in airports:
        if ap['icao'] == icao:
            return ap
    raise KeyError(icao)


def _end_and_dir(rw, end_id):
    a, b = rw['ends']
    e, o = (a, b) if a['id'] == end_id else (b, a)
    dx, dz = o['x'] - e['x'], o['z'] - e['z']
    L = math.hypot(dx, dz)
    return e, (dx / L, dz / L)


def best_end(rw, prefer='33'):
    """The end id `prefer` if the runway has it, otherwise the end most into the prevailing wind."""
    for e in rw['ends']:
        if e['id'] == prefer:
            return e['id']
    score = lambda e: math.cos(math.radians(e['heading_deg'] - PREVAILING_WIND_FROM_DEG))
    return max(rw['ends'], key=score)['id']


def runway_start(H, ap, rw, end_id, label):
    """Ready for takeoff: on the centreline 25 m past the threshold, pointing along the runway."""
    e, d = _end_and_dir(rw, end_id)
    x, z = e['x'] + 25.0 * d[0], e['z'] + 25.0 * d[1]
    return dict(label=label, x=r2(x), y=r2(H.at(x, z)), z=r2(z), heading_deg=r2(heading_deg(*d)),
                on_ground=True, speed_ms=0.0, gear=1, throttle=0.0,
                airport=ap['icao'], runway=end_id)


def final_approach(H, ap, rw, end_id, dist_m, speed_ms, label, glide_deg=3.0, tch_m=15.0):
    """On the extended centreline `dist_m` before the threshold, on a `glide_deg` glide path."""
    e, d = _end_and_dir(rw, end_id)
    x, z = e['x'] - dist_m * d[0], e['z'] - dist_m * d[1]
    y = H.at(e['x'], e['z']) + tch_m + dist_m * math.tan(math.radians(glide_deg))
    return dict(label=label, x=r2(x), y=r2(y, 1), z=r2(z), heading_deg=r2(heading_deg(*d)),
                on_ground=False, speed_ms=r2(speed_ms), gear=1, throttle=0.5,
                flight_path_deg=-glide_deg, ground_y=r2(H.at(x, z), 1), airport=ap['icao'], runway=end_id)


def airborne(H, lon, lat, alt_m, hdg, speed_ms, label, throttle, **extra):
    x, z = grid.lonlat_to_xz(lon, lat)
    s = dict(label=label, x=r2(x), y=r2(alt_m, 1), z=r2(z), heading_deg=r2(hdg), on_ground=False,
             speed_ms=r2(speed_ms), gear=0, throttle=throttle, ground_y=r2(H.at(x, z), 1))
    s.update(extra)
    return s


def build_spawns(airports, H, dead_sea_level):
    sp = {}
    notes = []
    # Tel Nof: the longest runway; its end "33" if it has one, otherwise the best end (key renamed)
    llek = _find_airport(airports, 'LLEK')
    longest = max(llek['runways'], key=lambda r: r['length_m'])
    end = best_end(longest, '33')
    key = 'telnof_' + end.lower()
    sp[key] = runway_start(H, llek, longest, end, f'Tel Nof, runway {end}, ready for takeoff')
    notes.append(f'{key}: Tel Nof\'s longest runway is {"/".join(longest["ids"])} '
                 f'({longest["length_m"]:.0f} m threshold to threshold, published {longest["length_published_m"]} m); '
                 f'it has no end "33", so its end {end} (into the prevailing west-north-westerly wind) is used')
    # the 33 runway the design example had in mind: the longer of 15L/33R and 15R/33L (by paved length)
    r33 = [r for r in llek['runways'] if any(e['id'].startswith('33') for e in r['ends'])]
    if r33:
        r = max(r33, key=lambda r: r['length_m'] + sum(e['overrun_m'] for e in r['ends']))
        e33 = [e['id'] for e in r['ends'] if e['id'].startswith('33')][0]
        k33 = 'telnof_' + e33.lower()
        if k33 not in sp:
            sp[k33] = runway_start(H, llek, r, e33, f'Tel Nof, runway {e33}, ready for takeoff')
    sp['telnof_final'] = final_approach(H, llek, longest, end, 10000.0, 140 * KT,
                                        f'Tel Nof, 10 km final runway {end}, 140 kt, gear down')
    sp['tlv_3000'] = airborne(H, 34.7800, 32.0800, 3000.0, 180.0, 200.0, 'Over Tel Aviv, 3,000 m', 0.7)
    sp['jerusalem_sunset'] = airborne(H, 35.1200, 31.7850, 1500.0, 90.0, 160.0,
                                      'Jerusalem hills at sunset, 1,500 m, heading east', 0.6,
                                      time_h=18.75, day_of_year=172)
    llbg = _find_airport(airports, 'LLBG')
    rb = max(llbg['runways'], key=lambda r: r['length_m'])
    eb = best_end(rb, '26')
    sp['bengurion_' + eb.lower()] = runway_start(H, llbg, rb, eb, f'Ben Gurion, runway {eb}, ready for takeoff')
    sp['deadsea_low'] = airborne(H, 35.5050, 31.7300, dead_sea_level + 300.0, 180.0, 150.0,
                                 'Dead Sea, 300 m above the water, heading south', 0.6)
    sp['coast_low'] = airborne(H, 34.5800, 31.7600, 300.0, 20.0, 180.0,
                               'Along the coast from Ashdod to Tel Aviv, 300 m', 0.65)
    return sp, notes


def run_json(cache, out):
    work = os.path.join(cache, 'work')
    with open(os.path.join(work, 'runways.json')) as f:
        rw = json.load(f)
    with open(os.path.join(work, 'heights_info.json')) as f:
        levels = json.load(f)['levels']
    H = HeightField(out)
    airports = build_airports(rw['airports'], H)
    write_json(os.path.join(out, 'airports.json'), airports)
    nrw = sum(len(a['runways']) for a in airports)
    log(f'airports.json: {len(airports)} airports, {nrw} runways')
    spawns, notes = build_spawns(airports, H, levels['dead_sea_m'])
    write_json(os.path.join(out, 'spawns.json'), spawns)
    for k, s in spawns.items():
        log(f'spawn {k}: x {s["x"]:.0f} y {s["y"]:.1f} z {s["z"]:.0f} hdg {s["heading_deg"]:.1f} '
            f'{"ground" if s["on_ground"] else "air"} {s["speed_ms"]} m/s - {s["label"]}')
    for n in notes:
        log(n)
    with open(os.path.join(work, 'spawn_notes.json'), 'w') as f:
        json.dump(notes, f, indent=1)


def write_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)


# ---- manifest.json ---------------------------------------------------------------------------

def run_manifest(cache, out):
    work = os.path.join(cache, 'work')
    with open(os.path.join(work, 'heights_info.json')) as f:
        hinfo = json.load(f)
    files, total = [], 0
    for root, _, names in os.walk(out):
        for n in sorted(names):
            p = os.path.join(root, n)
            rel = os.path.relpath(p, out).replace(os.sep, '/')
            if rel == 'manifest.json' or n.endswith('.tmp'):
                continue
            b = os.path.getsize(p)
            files.append(dict(path=rel, bytes=b))
            total += b
    files.sort(key=lambda f: f['path'])

    def corner(x, z):
        lon, lat = grid.xz_to_lonlat(x, z)
        return [round(float(lon), 5), round(float(lat), 5)]

    C, F = grid.CORE_HALF, grid.FAR_HALF
    man = dict(
        format='f35i-terrain', version=1,
        generated_utc=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        generator='sim/tools/terrain/build.py',
        attribution=ATTRIBUTION,
        projection=dict(proj4='+proj=tmerc +lat_0=31.80 +lon_0=35.025 +k=1 +x_0=0 +y_0=0 +datum=WGS84',
                        world='X = easting, Y = height above mean sea level (EGM2008), Z = -northing; '
                              'heading 0 = north (-Z), 90 = east (+X)'),
        core=dict(min=-C, max=C, nw_lonlat=corner(-C, -C), se_lonlat=corner(C, C)),
        far=dict(min=-F, max=F, nw_lonlat=corner(-F, -F), se_lonlat=corner(F, F)),
        height=dict(
            encoding='uint16 little-endian', formula='h_m = v * 0.05 - 500', scale=grid.H_ENC_SCALE,
            offset=grid.H_ENC_OFFSET, range_m=[-500.0, 2776.75],
            tiles=dict(pattern='height/tile_{ix}_{iz}.bin', nx=grid.NTILES, nz=grid.NTILES,
                       tile_m=grid.TILE_SIZE, samples=grid.H_TILE_N, spacing_m=grid.H_STEP,
                       layout='row-major, row 0 = north edge, edges shared with the neighbours; '
                              'sample (r, c) at X = -51200 + 6400 ix + 25 c, Z = -51200 + 6400 iz + 25 r',
                       bytes_each=grid.H_TILE_N * grid.H_TILE_N * 2),
            far=dict(file='height/far.bin', samples=grid.FAR_H_N, spacing_m=grid.FAR_H_STEP, origin=-F,
                     bytes=grid.FAR_H_N * grid.FAR_H_N * 2,
                     note='inside the core: the core heights box-filtered to 200 m; blended to the far DEM '
                          'across 51.2-63.2 km'),
            water_levels_m=dict(mediterranean=hinfo['levels']['mediterranean_m'],
                                dead_sea=hinfo['levels']['dead_sea_m']),
            processing='Copernicus DEM (a surface model) reprojected with cubic resampling; buildings and '
                       'trees cut down to the local ground + 1.5-2 m; water flat; runways flattened (level '
                       'across, smooth along, 15 m shoulders, blended out over 60 m)'),
        color=dict(
            format='JPEG, sRGB, row 0 = north edge; pixel i covers X0 + px * [i, i + 1)',
            L0=dict(pattern='color/L0/tile_{ix}_{iz}.jpg', px=grid.L0_PX, m_per_px=grid.TILE_SIZE / grid.L0_PX,
                    covers='one core tile each'),
            overview=dict(file='color/overview.jpg', px=grid.COLOR_OVERVIEW_PX,
                          m_per_px=2 * C / grid.COLOR_OVERVIEW_PX, covers='core'),
            far=dict(file='color/far.jpg', px=grid.COLOR_FAR_PX, m_per_px=2 * F / grid.COLOR_FAR_PX,
                     covers='far area (inside the core: the core colour downsampled)')),
        landcover=dict(
            format='PNG, 8-bit grey, values = ESA WorldCover classes, row 0 = north edge',
            codes={str(k): v for k, v in LANDCOVER_CODES.items()},
            tiles=dict(pattern='landcover/tile_{ix}_{iz}.png', px=grid.LC_TILE_PX,
                       m_per_px=grid.TILE_SIZE / grid.LC_TILE_PX),
            overview=dict(file='landcover/overview.png', px=grid.LC_OVERVIEW_PX,
                          m_per_px=2 * C / grid.LC_OVERVIEW_PX, covers='core'),
            far=dict(file='landcover/far.png', px=grid.LC_FAR_PX, m_per_px=2 * F / grid.LC_FAR_PX,
                     covers='far area')),
        airports='airports.json', spawns='spawns.json',
        spawn_y='on_ground spawns: y = the ground height (wheels on it); airborne: y = altitude MSL and '
                'ground_y = the ground height below',
        previews='previews/ (hillshaded colour, crops, checks.txt; not used by the app)',
        sources=SOURCES,
        files=files, total_bytes=total)
    write_json(os.path.join(out, 'manifest.json'), man)
    print(f'  [manifest] {len(files)} files, {total / 1e6:.1f} MB', flush=True)
