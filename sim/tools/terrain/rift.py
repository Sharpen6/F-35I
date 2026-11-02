#!/usr/bin/env python3
"""Rift strip: 50 m heights and colour for the Dead Sea rift where the core (25 m) does not reach.

    python3 sim/tools/terrain/rift.py --data sim/data --out sim/data/landscape [--cache DIR]
                                      [--stage heights|color|all]

The core stops at 35.56 E and 31.34 N. East of it the Moab escarpment (1,300-1,500 m above the
lake within 10 km, Wadi Mujib, Zarqa Ma'in) and south of it Masada, Ein Bokek, Mount Sodom, the
evaporation ponds and the south basin's walls were the far grid's 200 m box averages: a soft
ramp where the real walls stand in cliff bands cut by gorges. This strip is GLO-30 again, at
50 m, over 102.4 x 102.35 km:

    X 15000 .. 117400 m (35.18 .. 36.28 E), Z -13000 .. 89350 m (31.92 .. 30.99 N)
    2049 x 2048 samples, row 0 = north, sample (r, c) at X = X0 + 50 c, Z = Z0 + 50 r

It fills the free corner of the terrain's packed height texture (x 4097.., y 2049..; textures.js).
The rest of the far area stays 200 m: west of the core is the sea, north and south of the strip
the rift is far away from the places the sim flies.

Steps:
  1. the GLO-30 1 x 1 deg tiles (fetch.py's cache, missing ones downloaded into --cache)
     mosaicked and reprojected to the strip with cubic resampling (heights.py, as for the core);
  2. the Dead Sea flat at exactly -427.0 (the level of the core and far grids; DeadSea.js and
     the terrain shader take the lake from that height): the samples within 0.6 m of the DEM's
     lake surface connected to the open lake;
  3. where the strip overlaps the core, the core's own samples (so both agree at the core edge),
     and over its outer 2 km a blend to the far grid's bilinear surface, exactly the far grid at
     the edge (no step where the strip ends);
  4. rift.bin (uint16 LE, h = v * 0.05 - 500, the core's encoding) and rift.json.

Colour (rift_color.jpg, 2049 x 2048, one pixel per height sample): the far image (far.jpg) is
200 m per pixel, so at 5-20 km the walls were a few soft beige blobs per screen inch, and the
evaporation ponds south of the Lisan blurred turquoise smudges without their dikes. This is the
same Sentinel-2 composite graded the same way (colorgrade.py), from its 4x overviews (~35 m),
averaged to 50 m; a smooth correction field (2 km) keeps its large-scale colour equal to far.jpg's,
so only the detail is new and the strip has no edge. The lake keeps far.jpg's colour (the lake
pass draws the water there; DeadSea.js).

Data: Copernicus DEM GLO-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH
2014-2018, provided under COPERNICUS by the European Union and ESA (the terrain's own source);
ESA WorldCover 2021 Sentinel-2 RGBNIR composite, (c) ESA WorldCover project 2021 / contains modified
Copernicus Sentinel data (2021) processed by the ESA WorldCover consortium, CC BY 4.0.
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import Resampling, reproject
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import colorgrade as cg  # noqa: E402
import fetch  # noqa: E402
import grid  # noqa: E402
from heights import mosaic_dem, reproject_to, smoothstep  # noqa: E402

X0, Z0 = 15000.0, -13000.0
STEP = 50.0
NX, NZ = 2049, 2048
LAKE_LEVEL = -427.0
BLEND_M = 2000.0
# a point in the open north basin (lon, lat) to seed the lake's connected component
LAKE_SEED = (35.50, 31.55)
COLOR_LEVEL = 1          # the S2 composite's 4x overview (1/3000 deg: ~37 m N-S, ~32 m E-W)
COLOR_MATCH_M = 2000.0   # scale of the correction field toward far.jpg's colour
JPEG_Q = 90


def log(*a):
    print('[rift]', *a, flush=True)


def dem_tiles(caches, dl_cache):
    """The GLO-30 tiles under the strip: from the caches, else downloaded into dl_cache."""
    g = grid.PointGrid(X0, Z0, STEP, NX, NZ)
    w, s, e, n = grid.lonlat_bounds(X0, Z0, X0 + STEP * (NX - 1), Z0 + STEP * (NZ - 1), pad_deg=0.01)
    paths, tiles = [], []
    for lat in range(math.floor(s), math.floor(n) + 1):
        for lon in range(math.floor(w), math.floor(e) + 1):
            name = fetch.dem_name(lat, lon) + '.tif'
            found = next((os.path.join(c, name) for c in caches if os.path.exists(os.path.join(c, name))), None)
            if not found:
                found = os.path.join(dl_cache, name)
                log('download', name)
                if not fetch.download(fetch.dem_url(lat, lon), found):
                    log('  not on the server (sea or outside the DEM): left to the far grid')
                    continue
            paths.append(found)
            tiles.append((lat, lon))
    return g, paths, tiles


def read_core(data):
    """The built core heights (4097 x 4097, m) from data/terrain/height/tile_*.bin."""
    n = grid.H_TILE_N - 1
    N = grid.NTILES * n + 1
    core = np.zeros((N, N), np.float32)
    for iz in range(grid.NTILES):
        for ix in range(grid.NTILES):
            p = os.path.join(data, 'terrain', 'height', f'tile_{ix}_{iz}.bin')
            t = grid.decode_height(np.fromfile(p, '<u2').reshape(grid.H_TILE_N, grid.H_TILE_N))
            core[iz * n: iz * n + n + 1, ix * n: ix * n + n + 1] = t
    return core


def far_bilinear(far, xs, zs):
    """The far grid's bilinear surface (HeightField.farHeightAt) at world points."""
    gx = np.clip((xs + grid.FAR_HALF) / grid.FAR_H_STEP, 0, grid.FAR_H_N - 1)
    gz = np.clip((zs + grid.FAR_HALF) / grid.FAR_H_STEP, 0, grid.FAR_H_N - 1)
    i = np.minimum(np.floor(gx).astype(np.int64), grid.FAR_H_N - 2)
    j = np.minimum(np.floor(gz).astype(np.int64), grid.FAR_H_N - 2)
    fx, fz = gx - i, gz - j
    h00, h10 = far[j, i], far[j, i + 1]
    h01, h11 = far[j + 1, i], far[j + 1, i + 1]
    return (h00 + (h10 - h00) * fx) * (1 - fz) + (h01 + (h11 - h01) * fx) * fz


def build(data, out, caches, dl_cache):
    t0 = time.time()
    g, paths, tiles = dem_tiles(caches, dl_cache)
    log(f'strip {NX} x {NZ} at {STEP:.0f} m; DEM tiles: {[os.path.basename(p) for p in paths]}')
    src, tr = mosaic_dem(paths)
    h = reproject_to(src, tr, g, Resampling.cubic)
    del src
    xs = g.xs()[None, :].astype(np.float64)
    zs = g.zs()[:, None].astype(np.float64)
    X = np.broadcast_to(xs, g.shape)
    Z = np.broadcast_to(zs, g.shape)

    far = grid.decode_height(np.fromfile(os.path.join(data, 'terrain', 'height', 'far.bin'), '<u2')
                             .reshape(grid.FAR_H_N, grid.FAR_H_N)).astype(np.float64)
    farS = far_bilinear(far, X, Z)
    # no DEM: mosaic_dem leaves 0 (sea) where a tile is missing; the far grid takes over there
    hole = ~np.isfinite(h) | (h < -1000)
    lon, lat = grid.xz_to_lonlat(X.ravel(), Z.ravel())
    have = np.zeros(X.size, bool)
    for la, lo in tiles:
        have |= (lon >= lo) & (lon < lo + 1) & (lat >= la) & (lat < la + 1)
    hole |= ~have.reshape(g.shape)
    del lon, lat
    h = np.where(hole, farS, h).astype(np.float64)
    log(f'reprojected ({hole.sum()} samples from the far grid), {time.time() - t0:.0f} s')

    # ---- the Dead Sea: flat at LAKE_LEVEL ----
    sx, sz = grid.lonlat_to_xz(*LAKE_SEED)
    si, sj = int(round((sx - X0) / STEP)), int(round((sz - Z0) / STEP))
    dem_level = float(np.median(h[max(sj - 20, 0):sj + 20, max(si - 20, 0):si + 20]))
    cand = h <= dem_level + 0.6
    lab, _ = ndimage.label(cand)
    lake = lab == lab[sj, si]
    # the far grid's lake too (the DEM's shore of 2011-2015 is the data set's shore everywhere)
    lake |= (farS <= LAKE_LEVEL + 0.05) & (h <= LAKE_LEVEL + 3.0)
    h[lake] = LAKE_LEVEL
    # land never at or below the lake next to it (the lake pass takes everything at the level)
    h[~lake & (h < LAKE_LEVEL + 0.3)] = LAKE_LEVEL + 0.3
    log(f'Dead Sea: DEM level {dem_level:.2f} m -> {LAKE_LEVEL}, {lake.sum() * STEP * STEP / 1e6:.0f} km2')

    # ---- the core where they overlap: the core's own samples ----
    core = read_core(data)
    c = grid.CORE_HALF
    inc = (X >= -c) & (X <= c) & (Z >= -c) & (Z <= c)
    ci = np.clip(np.round((X + c) / grid.H_STEP).astype(np.int64), 0, core.shape[1] - 1)
    cj = np.clip(np.round((Z + c) / grid.H_STEP).astype(np.int64), 0, core.shape[0] - 1)
    h = np.where(inc, core[cj, ci], h)
    log(f'core overlap: {inc.sum()} samples from the core tiles')

    # ---- the outer edge: blend to the far grid ----
    d_edge = np.minimum.reduce([X - X0, X0 + STEP * (NX - 1) - X, Z - Z0, Z0 + STEP * (NZ - 1) - Z])
    w = smoothstep(0.0, BLEND_M, d_edge)
    h = np.where(inc, h, farS + (h - farS) * w)
    h[lake & ~inc] = np.where(w[lake & ~inc] > 0.999, LAKE_LEVEL, h[lake & ~inc])

    lo, hi = float(h.min()), float(h.max())
    diff = np.abs(h - farS)[~inc]
    log(f'heights {lo:.1f} .. {hi:.1f} m; differs from the far grid by {np.mean(diff):.1f} m on average, '
        f'{np.percentile(diff, 99):.0f} m at the 99th percentile')

    os.makedirs(out, exist_ok=True)
    enc = grid.encode_height(h.astype(np.float32))
    tmp = os.path.join(out, 'rift.bin.tmp')
    enc.astype('<u2').tofile(tmp)
    os.replace(tmp, os.path.join(out, 'rift.bin'))
    w_, s_, e_, n_ = grid.lonlat_bounds(X0, Z0, X0 + STEP * (NX - 1), Z0 + STEP * (NZ - 1))
    meta = dict(
        format='f35i-rift', version=1, generator='sim/tools/terrain/rift.py',
        generated_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        x0=X0, z0=Z0, spacing_m=STEP, ncols=NX, nrows=NZ, blend_m=BLEND_M, lake_level_m=LAKE_LEVEL,
        bounds_lonlat=[round(w_, 5), round(s_, 5), round(e_, 5), round(n_, 5)],
        encoding='uint16 little-endian, h_m = v * 0.05 - 500, row-major, row 0 = north',
        layout='sample (r, c) at X = x0 + spacing_m * c, Z = z0 + spacing_m * r (sim world metres)',
        height_range_m=[round(lo, 2), round(hi, 2)],
        attribution='Rift heights: Copernicus DEM GLO-30, (c) DLR e.V. 2010-2014 and (c) Airbus Defence and '
                    'Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA',
    )
    with open(os.path.join(out, 'rift.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    log(f'wrote {out}/rift.bin ({enc.nbytes / 1e6:.1f} MB) and rift.json in {time.time() - t0:.0f} s')
    return h


def s2_tiles(cache):
    """The composite's 4x overviews of the 1 x 1 deg tiles under the strip (downloaded once)."""
    w, s, e, n = grid.lonlat_bounds(X0, Z0, X0 + STEP * (NX - 1), Z0 + STEP * (NZ - 1), pad_deg=0.01)
    paths = []
    for lat in range(math.floor(s), math.floor(n) + 1):
        for lon in range(math.floor(w), math.floor(e) + 1):
            p = os.path.join(cache, 's2_rift', f'{fetch.s2_name(lat, lon)}_ovr{COLOR_LEVEL}.tif')
            if not os.path.exists(p):
                log('download', os.path.basename(p))
                try:
                    fetch.fetch_overview(p, fetch.s2_url(lat, lon), COLOR_LEVEL)
                except Exception as e:  # noqa: BLE001  (no such tile: sea, or outside the product)
                    log(f'  not available ({e}): far.jpg there')
                    continue
            paths.append(p)
    return paths


def far_color_at(data, xs, zs):
    """far.jpg (2048 x 2048 pixels of 200 m from the far area's corner), linear, bilinear at xs x zs."""
    far = cg.srgb_to_lin(np.asarray(Image.open(os.path.join(data, 'terrain', 'color', 'far.jpg')).convert('RGB'),
                                    np.float32) / 255.0)
    fx = np.clip((xs + grid.FAR_HALF) / 200.0 - 0.5, 0, far.shape[1] - 1.001)
    fz = np.clip((zs + grid.FAR_HALF) / 200.0 - 0.5, 0, far.shape[0] - 1.001)
    i0, j0 = np.floor(fx).astype(int), np.floor(fz).astype(int)
    ax, az = (fx - i0)[None, :, None], (fz - j0)[:, None, None]
    top = far[j0][:, i0] * (1 - ax) + far[j0][:, i0 + 1] * ax
    bot = far[j0 + 1][:, i0] * (1 - ax) + far[j0 + 1][:, i0 + 1] * ax
    return (top * (1 - az) + bot * az).astype(np.float32)


def build_color(data, out, cache):
    """rift_color.jpg: the strip's 50 m colour (pixel (r, c) centred on height sample (r, c))."""
    t0 = time.time()
    g = grid.AreaGrid(X0 - STEP / 2, Z0 - STEP / 2, STEP, NX, NZ)
    acc = np.zeros(g.shape + (3,), np.float64)
    cnt = np.zeros(g.shape, np.float64)
    for p in s2_tiles(cache):
        with rasterio.open(p) as src:
            raw = src.read()
            tr = src.transform
        nod = raw[0] == 0
        lin = cg.srgb_to_lin(cg.grade(raw.astype(np.float32) * 1e-4))
        lin[nod] = np.nan
        for c in range(3):
            dst = np.full(g.shape, np.nan, np.float32)
            reproject(np.ascontiguousarray(lin[..., c]), dst, src_transform=tr, src_crs=grid.WGS84,
                      dst_transform=g.transform, dst_crs=grid.TM, resampling=Resampling.average,
                      src_nodata=np.nan, dst_nodata=np.nan)
            ok = ~np.isnan(dst)
            acc[..., c][ok] += dst[ok]
            if c == 0:
                cnt[ok] += 1
        log('colour', os.path.basename(p), f'{time.time() - t0:.0f} s')
    with np.errstate(invalid='ignore', divide='ignore'):
        img = (acc / cnt[..., None]).astype(np.float32)
    have = cnt > 0
    farS = far_color_at(data, g.xs(), g.zs())
    img[~have] = farS[~have]

    # the lake (rift.bin at the lake level): far.jpg's water colour (the lake pass draws it)
    hb = np.fromfile(os.path.join(out, 'rift.bin'), '<u2').reshape(NZ, NX)
    lake = ndimage.binary_erosion(grid.decode_height(hb) <= LAKE_LEVEL + 0.05, iterations=2)
    img[lake] = farS[lake]

    # large-scale colour from far.jpg: log ratio of the 200 m means, smoothed over COLOR_MATCH_M
    eps = 2e-3
    k = 4                                              # 4 x 50 m = far.jpg's 200 m

    def box(a):
        return ndimage.uniform_filter(a, size=(k, k, 1), mode='nearest')

    d = np.log(box(farS) + eps) - np.log(box(img) + eps)
    sig = COLOR_MATCH_M / STEP
    d = np.stack([ndimage.gaussian_filter(d[..., c], sig, mode='nearest') for c in range(3)], axis=-1)
    log(f'colour match: mean |log ratio| {float(np.abs(d).mean()):.3f}, rgb mean ratio '
        f'{np.round(np.exp(d.mean(axis=(0, 1))), 3).tolist()}')
    img = img * np.exp(d)
    img[lake] = farS[lake]

    os.makedirs(out, exist_ok=True)
    srgb = cg.to_u8(cg.lin_to_srgb(img))
    tmp = os.path.join(out, 'rift_color.tmp.jpg')
    # 4:4:4 like far.jpg (sharp colour edges: pond dikes, shore lines)
    Image.fromarray(srgb, 'RGB').save(tmp, quality=JPEG_Q, subsampling=0, optimize=True)
    os.replace(tmp, os.path.join(out, 'rift_color.jpg'))
    meta_p = os.path.join(out, 'rift.json')
    with open(meta_p) as f:
        meta = json.load(f)
    meta['color'] = dict(file='rift_color.jpg', width=NX, height=NZ,
                         layout='pixel (r, c) centred on height sample (r, c), sRGB',
                         source=f'ESA WorldCover 2021 S2 RGBNIR composite, overview level {COLOR_LEVEL}, '
                                'graded with colorgrade.py, matched to far.jpg over 2 km')
    meta['attribution'] = ('Rift heights: Copernicus DEM GLO-30, (c) DLR e.V. 2010-2014 and (c) Airbus Defence and '
                           'Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; '
                           'rift colour: ESA WorldCover 2021 Sentinel-2 composite (CC BY 4.0), contains modified '
                           'Copernicus Sentinel data (2021)')
    with open(meta_p + '.tmp', 'w') as f:
        json.dump(meta, f, indent=1)
    os.replace(meta_p + '.tmp', meta_p)
    log(f'wrote {out}/rift_color.jpg ({os.path.getsize(os.path.join(out, "rift_color.jpg")) / 1e6:.1f} MB) '
        f'in {time.time() - t0:.0f} s')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data', required=True, help='the sim data folder (reads terrain/height/, terrain/color/)')
    ap.add_argument('--out', required=True, help='output folder (the app reads <data>/landscape/)')
    ap.add_argument('--dem-cache', action='append', default=[],
                    help='folders with GLO-30 tiles (fetch.py: <cache>/dem30); several allowed')
    ap.add_argument('--cache', default=os.path.join(HERE, '_cache'), help='downloads (DEM tiles, S2 overviews)')
    ap.add_argument('--stage', choices=['heights', 'color', 'all'], default='all')
    a = ap.parse_args()
    dl = os.path.join(a.cache, 'dem30')
    os.makedirs(dl, exist_ok=True)
    if a.stage in ('heights', 'all'):
        build(a.data, a.out, a.dem_cache + [dl], dl)
    if a.stage in ('color', 'all'):
        build_color(a.data, a.out, a.cache)


if __name__ == '__main__':
    main()
