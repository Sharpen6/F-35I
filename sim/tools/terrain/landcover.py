"""Land cover: ESA WorldCover 2021 v200 -> landcover/ (+ water masks used by the colour and height stages).

Output codes are the WorldCover codes (10 tree, 20 shrub, 30 grass, 40 crop, 50 built-up, 60 bare,
70 snow, 80 water, 90 wetland, 95 mangrove, 100 moss, 0 no data). WorldCover leaves the open sea
far from the coast as 0 (no data); here the open sea is always 80.

Work products in <cache>/work/:
  lc10_work.npy        uint8, 12800 x 12800, 10 m area grid over the work square (core + 12.8 km ring)
  water10_work.npy     uint8, same grid: 0 land, 1 Mediterranean, 2 Dead Sea, 3 other water
  shore20_core.npy     float32, 5120 x 5120, 20 m area grid over the core: distance (m) from a
                       sea / Dead Sea pixel to the nearest shore (0 on land)
  lc_far.npy           uint8, 2048 x 2048, the far land cover (also written as far.png)
"""
import os

import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import Resampling, reproject
from scipy import ndimage

import fetch
import grid

WATER = 80
CODES = (10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100)
SEA, DEAD_SEA, OTHER_WATER = 1, 2, 3


def log(*a):
    print('[landcover]', *a, flush=True)


def work_grid10():
    n = int(round(2 * grid.WORK_HALF / 10.0))
    return grid.AreaGrid(-grid.WORK_HALF, -grid.WORK_HALF, 10.0, n)


def core_slice10():
    m = int(round(grid.MARGIN / 10.0))
    n = int(round(2 * grid.CORE_HALF / 10.0))
    return slice(m, m + n)


def save_png(path, a):
    tmp = path + '.tmp.png'
    Image.fromarray(np.ascontiguousarray(a), 'L').save(tmp, optimize=True)
    os.replace(tmp, path)


def block_mode(a, k):
    """Mode of non-overlapping k x k blocks of a class raster (ties -> smaller code)."""
    h, w = a.shape
    b = a.reshape(h // k, k, w // k, k)
    best = np.zeros((h // k, w // k), np.uint8)
    best_n = np.full((h // k, w // k), -1, np.int32)
    for c in (0,) + CODES:
        n = (b == c).sum(axis=(1, 3), dtype=np.int32)
        if c == 0:
            n = n - 1  # prefer any real class over "no data" on ties
        better = n > best_n
        best[better] = c
        best_n[better] = n[better]
    return best


def reproject_lc(src_path_or_list, dst_grid, resampling):
    """Reproject WorldCover file(s) (lon/lat) to a TM area grid."""
    dst = np.zeros(dst_grid.shape, np.uint8)
    paths = src_path_or_list if isinstance(src_path_or_list, list) else [src_path_or_list]
    for p in paths:
        with rasterio.open(p) as src:
            tmp = np.zeros(dst_grid.shape, np.uint8)
            reproject(rasterio.band(src, 1), tmp, dst_transform=dst_grid.transform, dst_crs=grid.TM,
                      resampling=resampling, src_nodata=0, dst_nodata=0, num_threads=2,
                      warp_mem_limit=512)
            dst = np.where(dst == 0, tmp, dst)
    return dst


def open_sea_components(water, cell_px, edge='west', seed=None, min_cells=50):
    """Connected water components (4-connected, found on a coarse grid of cell_px pixels).

    edge='west': components touching the west edge (the open Mediterranean);
    seed=(row, col): the component containing that pixel. Returns a bool mask on the fine grid.
    """
    h, w = water.shape
    hc, wc = h // cell_px, w // cell_px
    coarse = water[:hc * cell_px, :wc * cell_px].reshape(hc, cell_px, wc, cell_px).max(axis=(1, 3))
    lab, n = ndimage.label(coarse)
    keep = np.zeros(n + 1, bool)
    if seed is not None:
        r, c = seed[0] // cell_px, seed[1] // cell_px
        if lab[r, c]:
            keep[lab[r, c]] = True
    else:
        sizes = np.bincount(lab.ravel(), minlength=n + 1)
        for l in np.unique(lab[:, 0]):
            if l and sizes[l] >= min_cells:
                keep[l] = True
    sel = keep[lab]
    full = np.zeros_like(water, dtype=bool)
    full[:hc * cell_px, :wc * cell_px] = np.repeat(np.repeat(sel, cell_px, 0), cell_px, 1)
    return full & water


def square_opening(mask, k):
    """Binary opening with a k x k square (removes channels narrower than k px), fast separable filters."""
    m = mask.astype(np.uint8)
    m = ndimage.minimum_filter(m, size=k, mode='nearest')
    m = ndimage.maximum_filter(m, size=k, mode='nearest')
    return m.astype(bool) & mask


def water_classes(lc, g):
    """Classify water pixels of a land-cover raster on area grid g: 1 sea, 2 Dead Sea, 3 other water."""
    water = (lc == WATER) | (lc == 0)
    # the open sea: water connected to the west edge, without channels narrower than ~110 m
    # (rivers and narrow canals keep their own colour and heights)
    k = max(3, int(round(110.0 / g.px)) | 1)
    wide = square_opening(water, k)
    cell = max(1, int(round(40.0 / g.px)))
    sea = open_sea_components(wide, cell, edge='west')
    # the Dead Sea: the wide water component containing a point in its northern basin
    x, z = grid.lonlat_to_xz(*grid.PLACES['dead_sea'])
    r, c = int((z - g.z0) / g.px), int((x - g.x0) / g.px)
    dead = np.zeros_like(water)
    if 0 <= r < lc.shape[0] and 0 <= c < lc.shape[1]:
        dead = open_sea_components(wide, cell, seed=(r, c)) & ~sea
    out = np.zeros(lc.shape, np.uint8)
    out[water] = OTHER_WATER
    out[sea] = SEA
    out[dead] = DEAD_SEA
    # no-data pixels that are not part of the open sea stay "other water" only if WorldCover said water
    out[(lc == 0) & (out == OTHER_WATER)] = 0
    return out


def run(cache, out):
    work = os.path.join(cache, 'work')
    os.makedirs(os.path.join(out, 'landcover'), exist_ok=True)

    # ---- core + ring at 10 m ----
    g10 = work_grid10()
    p_lc = os.path.join(work, 'lc10_work.npy')
    if not os.path.exists(p_lc):
        log('reprojecting WorldCover to the 10 m TM grid', g10.shape)
        lc = reproject_lc(os.path.join(cache, 'wc', 'wc_work.tif'), g10, Resampling.mode)
        np.save(p_lc, lc)
    lc = np.load(p_lc)
    log('classes', dict(zip(*[v.tolist() for v in np.unique(lc, return_counts=True)])))

    wcls = water_classes(lc, g10)
    lc[(wcls == SEA) | (wcls == DEAD_SEA)] = WATER     # the open sea is water, never "no data"
    np.save(p_lc, lc)
    np.save(os.path.join(work, 'water10_work.npy'), wcls)
    log('water px: sea', int((wcls == SEA).sum()), 'dead sea', int((wcls == DEAD_SEA).sum()),
        'other', int((wcls == OTHER_WATER).sum()))

    # distance to the shore inside the sea / Dead Sea, 20 m grid over the core (for the water colour)
    cs = core_slice10()
    wc_core = wcls[cs, cs]
    big = ((wc_core == SEA) | (wc_core == DEAD_SEA)).reshape(5120, 2, 5120, 2).mean(axis=(1, 3)) >= 0.5
    dist = ndimage.distance_transform_edt(big).astype(np.float32) * 20.0
    np.save(os.path.join(work, 'shore20_core.npy'), dist)

    # ---- tiles ----
    core = lc[cs, cs]
    n = grid.LC_TILE_PX
    for iz in range(grid.NTILES):
        for ix in range(grid.NTILES):
            save_png(os.path.join(out, 'landcover', f'tile_{ix}_{iz}.png'), core[iz * n:(iz + 1) * n, ix * n:(ix + 1) * n])
    log('tiles written')

    # ---- overview (25 m, mode) ----
    core_g = grid.AreaGrid(-grid.CORE_HALF, -grid.CORE_HALF, 10.0, core.shape[1])
    ov_g = grid.AreaGrid(-grid.CORE_HALF, -grid.CORE_HALF, 2 * grid.CORE_HALF / grid.LC_OVERVIEW_PX, grid.LC_OVERVIEW_PX)
    ov = np.zeros(ov_g.shape, np.uint8)
    reproject(np.ascontiguousarray(core), ov, src_transform=core_g.transform, src_crs=grid.TM,
              dst_transform=ov_g.transform, dst_crs=grid.TM, resampling=Resampling.mode,
              src_nodata=None, dst_nodata=None)
    save_png(os.path.join(out, 'landcover', 'overview.png'), ov)

    # ---- far (200 m, mode); the core part is the exact 20 x 20 block mode of the 10 m core ----
    far_g = grid.AreaGrid(-grid.FAR_HALF, -grid.FAR_HALF, 2 * grid.FAR_HALF / grid.LC_FAR_PX, grid.LC_FAR_PX)
    log('far land cover from', len(fetch.far_files(cache, 'wc_far')), 'WorldCover overviews')
    far = reproject_lc(fetch.far_files(cache, 'wc_far'), far_g, Resampling.mode)
    k = int(round(far_g.px / 10.0))
    c0 = int(round((grid.FAR_HALF - grid.CORE_HALF) / far_g.px))
    nc = core.shape[0] // k
    far[c0:c0 + nc, c0:c0 + nc] = block_mode(core, k)
    fcls = water_classes(far, far_g)
    far[(fcls == SEA) | (fcls == DEAD_SEA)] = WATER
    far[far == 0] = WATER        # beyond WorldCover's coastal strip: open sea
    np.save(os.path.join(work, 'lc_far.npy'), far)
    np.save(os.path.join(work, 'water_far.npy'), fcls)
    save_png(os.path.join(out, 'landcover', 'far.png'), far)
    log('done')
