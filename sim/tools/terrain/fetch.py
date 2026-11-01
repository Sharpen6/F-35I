"""Download / cache the public source data (only the parts the build needs).

Everything lands in the --cache directory, so a second run (or a run on another machine with a
copied cache) does not touch the network. Large COGs are never downloaded whole: windows and
overview levels are read over HTTP with GDAL's /vsicurl/.

Sources (all open data):
  * Copernicus DEM GLO-30 (1 arc-second, 1 x 1 deg COGs), s3://copernicus-dem-30m
  * ESA WorldCover 2021 v200 land cover map (10 m, 3 x 3 deg COGs), s3://esa-worldcover
  * ESA WorldCover 2021 Sentinel-2 RGBNIR yearly median composite (10 m, 1 x 1 deg COGs),
    s3://esa-worldcover-s2
  * OurAirports airports.csv / runways.csv (public domain), GitHub mirror
"""
import json
import math
import os
import re
import time
import urllib.error
import urllib.request

import rasterio
from rasterio.windows import Window

import grid

DEM_BUCKET = 'https://copernicus-dem-30m.s3.amazonaws.com'
S2_BUCKET = 'https://esa-worldcover-s2.s3.eu-central-1.amazonaws.com'
WC_BUCKET = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com'
OURAIRPORTS = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/'

# GDAL settings for efficient COG access over HTTP
GDAL_ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif,.TIF,.tiff',
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES='YES',
    GDAL_HTTP_MULTIPLEX='YES',
    GDAL_HTTP_MAX_RETRY='6',
    GDAL_HTTP_RETRY_DELAY='3',
    VSI_CACHE='TRUE',
    VSI_CACHE_SIZE=str(128 * 1024 * 1024),
    GDAL_CACHEMAX=512,
)

S2_PER_DEG = 12000      # the WorldCover products are on a 1/12000 deg grid
GTIFF_OPTS = dict(driver='GTiff', tiled=True, blockxsize=512, blockysize=512, compress='deflate',
                  predictor=2, BIGTIFF='IF_SAFER')


def log(*a):
    print('[fetch]', *a, flush=True)


# ---- plain HTTP ---------------------------------------------------------------------------

def http_get(url, retries=5):
    """GET a URL (honours HTTPS_PROXY and the CA bundle env vars). Returns bytes, None on 404."""
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None
            err = e
        except Exception as e:  # network hiccup: retry
            err = e
        time.sleep(2 + 3 * attempt)
    raise RuntimeError(f'GET failed after {retries} tries: {url}: {err}')


def download(url, dest):
    """Download url -> dest (atomic). Returns False if the remote file does not exist."""
    if os.path.exists(dest):
        return True
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    data = http_get(url)
    if data is None:
        return False
    tmp = dest + '.part'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, dest)
    return True


def s3_list(bucket_url, prefix):
    """Keys under a prefix of a public S3 bucket (ListObjectsV2)."""
    keys, token = [], None
    while True:
        q = f'{bucket_url}/?list-type=2&prefix={urllib.request.quote(prefix)}'
        if token:
            q += '&continuation-token=' + urllib.request.quote(token)
        xml = http_get(q).decode('utf-8')
        keys += re.findall(r'<Key>([^<]+)</Key>', xml)
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', xml)
        if not m:
            return keys
        token = m.group(1)


# ---- names ------------------------------------------------------------------------------

def _ns(lat):
    return f'N{lat:02d}' if lat >= 0 else f'S{-lat:02d}'


def _ew(lon):
    return f'E{lon:03d}' if lon >= 0 else f'W{-lon:03d}'


def dem_name(lat, lon):
    return f'Copernicus_DSM_COG_10_{_ns(lat)}_00_{_ew(lon)}_00_DEM'


def dem_url(lat, lon):
    n = dem_name(lat, lon)
    return f'{DEM_BUCKET}/{n}/{n}.tif'


def s2_name(lat, lon):
    return f'ESA_WorldCover_10m_2021_v200_{_ns(lat)}{_ew(lon)}_S2RGBNIR'


def s2_url(lat, lon):
    return f'{S2_BUCKET}/rgbnir/2021/{_ns(lat)}/{s2_name(lat, lon)}.tif'


def wc_name(lat3, lon3):
    return f'ESA_WorldCover_10m_2021_v200_{_ns(lat3)}{_ew(lon3)}_Map'


def wc_url(lat3, lon3):
    return f'{WC_BUCKET}/v200/2021/map/{wc_name(lat3, lon3)}.tif'


def vsi(url):
    return '/vsicurl/' + url


# ---- tile inventories (missing tiles = open sea) ----------------------------------------------

def dem_inventory(cache):
    path = os.path.join(cache, 'dem30', 'tileList.txt')
    download(f'{DEM_BUCKET}/tileList.txt', path)
    with open(path) as f:
        return set(line.strip() for line in f if line.strip())


def s2_inventory(cache, lats):
    path = os.path.join(cache, 's2', 'inventory.json')
    inv = {}
    if os.path.exists(path):
        with open(path) as f:
            inv = json.load(f)
    changed = False
    for lat in lats:
        k = _ns(lat)
        if k not in inv:
            inv[k] = [os.path.basename(x) for x in s3_list(S2_BUCKET, f'rgbnir/2021/{k}/')]
            changed = True
    if changed:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            json.dump(inv, f)
    return set(n for v in inv.values() for n in v)


def wc_inventory(cache):
    path = os.path.join(cache, 'wc', 'inventory.json')
    if not os.path.exists(path):
        keys = [os.path.basename(k) for k in s3_list(WC_BUCKET, 'v200/2021/map/')]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            json.dump(keys, f)
    with open(path) as f:
        return set(json.load(f))


# ---- windows on the 1/12000 deg WorldCover grid ---------------------------------------------

def snap_bounds(bounds, per_deg):
    w, s, e, n = bounds
    return (math.floor(w * per_deg) / per_deg, math.floor(s * per_deg) / per_deg,
            math.ceil(e * per_deg) / per_deg, math.ceil(n * per_deg) / per_deg)


def build_mosaic(dest, bounds, sources, per_deg, count, dtype, nodata, label):
    """Read the window `bounds` from several same-grid COGs into one local GeoTIFF.

    sources: list of (url, (w, s, e, n) of that file) on the same lon/lat grid (per_deg px/deg).
    """
    if os.path.exists(dest):
        return
    w, s, e, n = snap_bounds(bounds, per_deg)
    width = int(round((e - w) * per_deg))
    height = int(round((n - s) * per_deg))
    tr = rasterio.transform.from_origin(w, n, 1.0 / per_deg, 1.0 / per_deg)
    tmp = dest + '.part.tif'
    prof = dict(GTIFF_OPTS, width=width, height=height, count=count, dtype=dtype, crs=grid.WGS84,
                transform=tr, nodata=nodata)
    if dtype == 'uint8':
        prof.pop('predictor')
    t0 = time.time()
    with rasterio.Env(**GDAL_ENV), rasterio.open(tmp, 'w', **prof) as dst:
        for url, (sw, ss, se, sn) in sources:
            # intersection in lon/lat, then in pixels of the mosaic and of the source
            iw, is_, ie, in_ = max(w, sw), max(s, ss), min(e, se), min(n, sn)
            if iw >= ie or is_ >= in_:
                continue
            with rasterio.open(vsi(url)) as src:
                c0 = int(round((iw - sw) * per_deg))
                r0 = int(round((sn - in_) * per_deg))
                ncol = int(round((ie - iw) * per_deg))
                nrow = int(round((in_ - is_) * per_deg))
                dc0 = int(round((iw - w) * per_deg))
                dr0 = int(round((n - in_) * per_deg))
                step = 1024
                # read block-aligned strips to bound memory
                start = r0 - (r0 % step)
                for rr in range(start, r0 + nrow, step):
                    a0, a1 = max(rr, r0), min(rr + step, r0 + nrow)
                    data = src.read(window=Window(c0, a0, ncol, a1 - a0))
                    dst.write(data, window=Window(dc0, dr0 + (a0 - r0), ncol, a1 - a0))
                log(f'{label}: {os.path.basename(url)} {ncol}x{nrow} px read ({time.time() - t0:.0f}s)')
    os.replace(tmp, dest)


def fetch_overview(dest, url, level):
    """Save one overview level of a remote COG as a local GeoTIFF (level 0 = 2x, 1 = 4x, ...)."""
    if os.path.exists(dest):
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with rasterio.Env(**GDAL_ENV), rasterio.open(vsi(url), overview_level=level) as src:
        data = src.read()
        prof = dict(GTIFF_OPTS, width=src.width, height=src.height, count=src.count, dtype=src.dtypes[0],
                    crs=src.crs, transform=src.transform, nodata=src.nodata)
        if prof['dtype'] == 'uint8':
            prof.pop('predictor')
        tags = src.tags()
    tmp = dest + '.part.tif'
    with rasterio.open(tmp, 'w', **prof) as dst:
        dst.write(data)
        dst.update_tags(**tags)
    os.replace(tmp, dest)


# ---- the stage --------------------------------------------------------------------------------

def run(cache):
    os.makedirs(cache, exist_ok=True)
    work_b = grid.lonlat_bounds(-grid.WORK_HALF, -grid.WORK_HALF, grid.WORK_HALF, grid.WORK_HALF, pad_deg=0.01)
    core_b = grid.lonlat_bounds(-grid.CORE_HALF, -grid.CORE_HALF, grid.CORE_HALF, grid.CORE_HALF, pad_deg=0.006)
    far_b = grid.lonlat_bounds(-grid.FAR_HALF, -grid.FAR_HALF, grid.FAR_HALF, grid.FAR_HALF, pad_deg=0.03)
    log('core lon/lat', [round(v, 4) for v in core_b], 'work', [round(v, 4) for v in work_b],
        'far', [round(v, 4) for v in far_b])

    # OurAirports
    for name in ('airports.csv', 'runways.csv'):
        download(OURAIRPORTS + name, os.path.join(cache, 'ourairports', name))

    # Copernicus DEM: whole 1 deg tiles for the work area, 4x overviews for the far area
    inv = dem_inventory(cache)
    for lat, lon in grid.deg_tiles(work_b):
        if dem_name(lat, lon) in inv:
            p = os.path.join(cache, 'dem30', dem_name(lat, lon) + '.tif')
            if not os.path.exists(p):
                log('DEM', dem_name(lat, lon))
                download(dem_url(lat, lon), p)
    for lat, lon in grid.deg_tiles(far_b):
        if dem_name(lat, lon) in inv:
            p = os.path.join(cache, 'dem_far', dem_name(lat, lon) + '_ovr4.tif')
            if not os.path.exists(p):
                log('DEM far', dem_name(lat, lon))
                fetch_overview(p, dem_url(lat, lon), 1)

    # Sentinel-2 composite: full resolution for the core, 8x overviews for the far area
    tiles = grid.deg_tiles(far_b)
    s2inv = s2_inventory(cache, sorted(set(t[0] for t in tiles)))
    core_src = [(s2_url(lat, lon), (lon, lat, lon + 1, lat + 1)) for lat, lon in grid.deg_tiles(core_b)
                if s2_name(lat, lon) + '.tif' in s2inv]
    build_mosaic(os.path.join(cache, 's2', 's2_core.tif'), core_b, core_src, S2_PER_DEG, 4, 'uint16', 0,
                 'S2 core')
    for lat, lon in tiles:
        if s2_name(lat, lon) + '.tif' in s2inv:
            p = os.path.join(cache, 's2_far', s2_name(lat, lon) + '_ovr8.tif')
            if not os.path.exists(p):
                log('S2 far', s2_name(lat, lon))
                fetch_overview(p, s2_url(lat, lon), 2)

    # WorldCover map: full resolution for the work area, 8x overviews for the far area
    wcinv = wc_inventory(cache)

    def wc_tiles(b):
        out = []
        for lat in range(math.floor(b[1] / 3) * 3, math.floor(b[3] / 3) * 3 + 1, 3):
            for lon in range(math.floor(b[0] / 3) * 3, math.floor(b[2] / 3) * 3 + 1, 3):
                if wc_name(lat, lon) + '.tif' in wcinv:
                    out.append((lat, lon))
        return out

    src = [(wc_url(lat, lon), (lon, lat, lon + 3, lat + 3)) for lat, lon in wc_tiles(work_b)]
    build_mosaic(os.path.join(cache, 'wc', 'wc_work.tif'), work_b, src, S2_PER_DEG, 1, 'uint8', 0, 'WorldCover')
    for lat, lon in wc_tiles(far_b):
        p = os.path.join(cache, 'wc_far', wc_name(lat, lon) + '_ovr8.tif')
        if not os.path.exists(p):
            log('WorldCover far', wc_name(lat, lon))
            fetch_overview(p, wc_url(lat, lon), 2)
    log('done')


def far_files(cache, sub):
    d = os.path.join(cache, sub)
    return sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith('.tif') and not f.endswith('.part.tif'))


def dem_core_files(cache):
    d = os.path.join(cache, 'dem30')
    return sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith('_DEM.tif'))
