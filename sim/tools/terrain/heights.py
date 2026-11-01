"""Heights: Copernicus DEM GLO-30 -> height/ (core tiles) and height/far.bin.

Core (25 m, plus a 12.8 km ring so the far area joins seamlessly):
  1. the 1 x 1 deg GLO-30 tiles are mosaicked and reprojected to the TM grid with cubic resampling;
  2. water is made flat: the Mediterranean at exactly 0.0 m, the Dead Sea at its DEM level (the
     median of the DEM over the lake), small lakes / ponds at their median; land next to the
     water rises gently from just above the water level (the 2021 shoreline of the water mask
     and the 2011-2015 DEM disagree where ports were built and where the Dead Sea receded);
  3. the DEM is a surface model: buildings and trees are cut down to the local ground plus a
     little. Objects are samples of built-up / tree cover that stand more than 2.5 m above a
     225 m morphological opening; their ground is interpolated (normalised convolution, multi
     scale) from the surrounding non-object samples;
  4. runways are flattened over their paved length (incl. overruns): level across the runway,
     its 15 m shoulders and one grid cell more (so every bilinear cell touching the pavement is
     level), smooth along the length (median DEM profile, Gaussian smoothed), blended back to
     the terrain over 60 m.
Far (200 m): GLO-30 4x overviews box-averaged to 200 m, sea at 0; inside the core the core
heights box-filtered to 200 m, blended into the far data across the 12.8 km ring (no seam).
"""
import json
import math
import os

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject
from scipy import ndimage

import fetch
import grid
import landcover as lcm

STEP = grid.H_STEP
TREE, BUILT = 10, 50
SHOULDER_M = 15.0          # runway shoulders flattened with the runway
GRID_TOL_M = 26.0          # one 25 m cell more, so the bilinear surface is level over the pavement
BLEND_M = 60.0
END_PAD_M = 40.0           # flat beyond the last pavement


def log(*a):
    print('[heights]', *a, flush=True)


def work_grid():
    n = int(round(2 * grid.WORK_HALF / STEP)) + 1
    return grid.PointGrid(-grid.WORK_HALF, -grid.WORK_HALF, STEP, n)


# ---- sources --------------------------------------------------------------------------------------

def mosaic_dem(paths):
    """Mosaic same-resolution GLO tiles (lon/lat) into one array + transform; missing area = 0 (sea)."""
    infos = []
    for p in paths:
        with rasterio.open(p) as src:
            infos.append((p, src.transform, src.width, src.height))
    res_x = infos[0][1].a
    res_y = -infos[0][1].e
    west = min(t.c for _, t, w, h in infos)
    north = max(t.f for _, t, w, h in infos)
    east = max(t.c + w * res_x for _, t, w, h in infos)
    south = min(t.f - h * res_y for _, t, w, h in infos)
    W = int(round((east - west) / res_x))
    H = int(round((north - south) / res_y))
    out = np.zeros((H, W), np.float32)
    for p, t, w, h in infos:
        c0 = int(round((t.c - west) / res_x))
        r0 = int(round((north - t.f) / res_y))
        with rasterio.open(p) as src:
            a = src.read(1).astype(np.float32)
        if a.shape != (h, w):
            raise RuntimeError(f'unexpected tile shape {p}')
        out[r0:r0 + h, c0:c0 + w] = a
    tr = rasterio.transform.from_origin(west, north, res_x, res_y)
    return out, tr


def reproject_to(src_arr, src_tr, g, resampling):
    dst = np.zeros(g.shape, np.float32)
    reproject(src_arr, dst, src_transform=src_tr, src_crs=grid.WGS84, dst_transform=g.transform,
              dst_crs=grid.TM, resampling=resampling, num_threads=2, warp_mem_limit=512)
    return dst


def classes_to_points(arr10, g10, g, resampling=Resampling.mode):
    """A 10 m class raster (area grid g10, TM) resampled onto a point grid g."""
    dst = np.zeros(g.shape, np.uint8)
    reproject(np.ascontiguousarray(arr10), dst, src_transform=g10.transform, src_crs=grid.TM,
              dst_transform=g.transform, dst_crs=grid.TM, resampling=resampling, src_nodata=None,
              dst_nodata=None, num_threads=2)
    return dst


# ---- processing -----------------------------------------------------------------------------------

def flatten_water(h, water, step):
    """Flat water: sea 0.0, Dead Sea at its DEM level, small lakes at their median. Returns levels."""
    levels = {}
    sea = water == lcm.SEA
    h[sea & (h < 5.0)] = 0.0
    levels['mediterranean_m'] = 0.0
    dead = water == lcm.DEAD_SEA
    if dead.any():
        lvl = float(np.round(np.median(h[dead]), 2))
        h[dead & (h < lvl + 5.0)] = lvl
        levels['dead_sea_m'] = lvl
    other = water == lcm.OTHER_WATER
    lab, n = ndimage.label(other)
    if n:
        idx = np.arange(1, n + 1)
        med = ndimage.median(h, lab, idx)
        p10 = ndimage.labeled_comprehension(h, lab, idx, lambda v: np.percentile(v, 10), np.float32, 0)
        p90 = ndimage.labeled_comprehension(h, lab, idx, lambda v: np.percentile(v, 90), np.float32, 0)
        flat = np.zeros(n + 1, bool)
        flat[1:] = (p90 - p10) < 3.0
        lv = np.zeros(n + 1, np.float32)
        lv[1:] = med
        sel = flat[lab]
        h[sel] = lv[lab][sel]
        levels['small_water_bodies_flattened'] = int(flat.sum())
    # land next to the sea / Dead Sea rises from just above the water level
    for mask, lvl, reach in ((sea, 0.0, 120.0), (dead, levels.get('dead_sea_m'), 1500.0)):
        if lvl is None or not mask.any():
            continue
        d = ndimage.distance_transform_edt(~mask, sampling=step)
        near = (~mask) & (d < reach)
        floor = lvl + 0.4 + d * (0.012 if lvl == 0.0 else 0.004)
        h[near] = np.maximum(h[near], floor[near])
    return levels


def _gauss(a, s):
    """Gaussian blur; large sigmas are done on a 4x decimated grid (same result for smooth fields)."""
    if s < 6:
        return ndimage.gaussian_filter(a, s, mode='nearest')
    H, W = a.shape
    k = 4
    Hc, Wc = (H + k - 1) // k, (W + k - 1) // k
    pad = np.pad(a, ((0, Hc * k - H), (0, Wc * k - W)), mode='edge')
    small = pad.reshape(Hc, k, Wc, k).mean(axis=(1, 3))
    small = ndimage.gaussian_filter(small, s / k, mode='nearest')
    big = ndimage.zoom(small, k, order=1, mode='nearest', grid_mode=True)
    return big[:H, :W]


def normalized_fill(h, w, sigmas):
    """Interpolate h where w == 0 from samples with w == 1 (multi-scale normalised convolution)."""
    out = h.copy()
    todo = w < 0.5
    for s in sigmas:
        if not todo.any():
            break
        num = _gauss(h * w, s)
        den = _gauss(w, s)
        ok = todo & (den > 0.08)
        out[ok] = num[ok] / den[ok]
        todo &= ~ok
    if todo.any():
        out[todo] = h[todo]
    return out


def clamp_objects(h, lc, water):
    """Cut buildings and trees of the surface model down to the local ground plus a little.

    Objects are built-up / tree samples standing more than 2.5 m above a 225 m grey opening of the
    surface. An opening also lowers convex terrain (hill tops, ridges), so the threshold is raised by
    the amount the same opening lowers a smoothed (75 m) copy of the surface: Jerusalem's built-up
    hill tops keep their height while buildings and trees on flat or evenly sloping ground go."""
    cand = np.isin(lc, (TREE, BUILT))
    cand = ndimage.binary_dilation(cand, iterations=1) & (water == 0)
    opening = ndimage.grey_opening(h, size=(9, 9), mode='nearest')
    smooth = ndimage.gaussian_filter(h, 3.0, mode='nearest')
    relief = np.maximum(smooth - ndimage.grey_opening(smooth, size=(9, 9), mode='nearest'), 0.0)
    objects = cand & (h > opening + 2.5 + relief)
    w = ((~objects) & (water == 0)).astype(np.float32)
    ground = normalized_fill(h, w, (1.5, 4.0, 12.0, 40.0))
    allow = np.where(lc == TREE, 2.0, 1.5).astype(np.float32)
    clamped = np.minimum(h, ground + allow)
    n = int(objects.sum())
    removed = float(np.percentile((h - clamped)[objects], 99)) if n else 0.0
    h[objects] = clamped[objects]
    return n, removed


def bilinear(h, g, x, z):
    c = (np.asarray(x) - g.x0) / g.step
    r = (np.asarray(z) - g.z0) / g.step
    return ndimage.map_coordinates(h, [r, c], order=1, mode='nearest')


def runway_profile(us, raw, u0, u1):
    """Smooth longitudinal profile: a robust low-order polynomial through the DEM's centreline
    profile (quadratic up to 1.5 km, cubic above), as real runways have gentle, even grades."""
    L = max(u1 - u0, 1.0)
    deg = 2 if L < 1500 else 3
    s = (us - 0.5 * (u0 + u1)) / L
    inside = (us >= u0) & (us <= u1)
    w = inside.astype(np.float64)
    coef = None
    for _ in range(5):          # iteratively reweighted: buildings / ditches beside the pavement do not pull it
        coef = np.polyfit(s, raw, deg, w=w + 1e-6)
        res = raw - np.polyval(coef, s)
        mad = np.median(np.abs(res[inside])) + 0.3
        w = inside / (1.0 + (res / (2.5 * mad)) ** 2)
    return np.polyval(coef, s).astype(np.float32)


def flatten_runways(h, g, airports):
    """Flatten every runway (longest first). Returns {(icao, ids): profile info}."""
    rws = [(ap, r) for ap in airports for r in ap['runways']]
    rws.sort(key=lambda t: -t[1]['length_m'])
    info = {}
    for ap, r in rws:
        a, b = r['ends']
        ax, az, bx, bz = a['x'], a['z'], b['x'], b['z']
        L = math.hypot(bx - ax, bz - az)
        t = np.array([(bx - ax) / L, (bz - az) / L])
        n = np.array([-t[1], t[0]])
        W = r['width_m']
        u0, u1 = -a['overrun_m'], L + b['overrun_m']
        # robust centreline profile along the paved length
        us = np.arange(u0 - 50.0, u1 + 50.01, 12.5)
        vs = np.linspace(-W / 2, W / 2, 5)
        U, V = np.meshgrid(us, vs, indexing='ij')
        px = ax + U * t[0] + V * n[0]
        pz = az + U * t[1] + V * n[1]
        prof = np.median(bilinear(h, g, px, pz), axis=1)
        prof = runway_profile(us, prof, u0, u1)
        # grid samples around the runway
        half_core = W / 2 + SHOULDER_M + GRID_TOL_M
        reach = half_core + BLEND_M
        corners_x = [ax + uu * t[0] + vv * n[0] for uu in (u0 - reach, u1 + reach) for vv in (-reach, reach)]
        corners_z = [az + uu * t[1] + vv * n[1] for uu in (u0 - reach, u1 + reach) for vv in (-reach, reach)]
        c0 = max(0, int(math.floor((min(corners_x) - g.x0) / g.step)))
        c1 = min(g.ncols - 1, int(math.ceil((max(corners_x) - g.x0) / g.step)))
        r0 = max(0, int(math.floor((min(corners_z) - g.z0) / g.step)))
        r1 = min(g.nrows - 1, int(math.ceil((max(corners_z) - g.z0) / g.step)))
        gx = g.x0 + g.step * np.arange(c0, c1 + 1)
        gz = g.z0 + g.step * np.arange(r0, r1 + 1)
        GX, GZ = np.meshgrid(gx, gz)
        du = (GX - ax) * t[0] + (GZ - az) * t[1]
        dv = (GX - ax) * n[0] + (GZ - az) * n[1]
        uc = np.clip(du, u0, u1)
        target = np.interp(uc, us, prof)
        # distance outside the flat core zone (in the runway frame)
        out_v = np.maximum(np.abs(dv) - half_core, 0.0)
        out_u = np.maximum(np.maximum(u0 - END_PAD_M - du, du - u1 - END_PAD_M), 0.0)
        dist = np.hypot(out_v, out_u)
        wgt = 1.0 - np.clip(dist / BLEND_M, 0.0, 1.0)
        wgt = wgt * wgt * (3 - 2 * wgt)
        sub = h[r0:r1 + 1, c0:c1 + 1]
        h[r0:r1 + 1, c0:c1 + 1] = sub * (1 - wgt) + target * wgt
        key = f'{ap["icao"]} {"/".join(r["ids"])}'
        paved = (us >= u0) & (us <= u1)
        pp = prof[paved]
        info[key] = dict(min=float(pp.min()), max=float(pp.max()),
                         slope_max_pct=float(np.max(np.abs(np.diff(pp))) / 12.5 * 100),
                         grade_mean_pct=float((pp[-1] - pp[0]) / max(u1 - u0, 1.0) * 100))
    return info


def box200(h):
    """Separable 200 m box filter (9 taps at 25 m, half-weight ends) - the far grid's antialiasing."""
    k = np.array([0.5, 1, 1, 1, 1, 1, 1, 1, 0.5], np.float32) / 8.0
    a = ndimage.convolve1d(h, k, axis=0, mode='nearest')
    return ndimage.convolve1d(a, k, axis=1, mode='nearest')


def write_bin(path, h):
    tmp = path + '.tmp'
    grid.encode_height(h).tofile(tmp)
    os.replace(tmp, path)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ---- the stage -----------------------------------------------------------------------------------

def run(cache, out):
    work = os.path.join(cache, 'work')
    os.makedirs(os.path.join(out, 'height'), exist_ok=True)
    g = work_grid()

    log('DEM mosaic -> TM 25 m', g.shape)
    dem_src, dem_tr = mosaic_dem(fetch.dem_core_files(cache))
    h = reproject_to(dem_src, dem_tr, g, Resampling.cubic)
    del dem_src
    np.save(os.path.join(work, 'dem25_raw.npy'), h)

    g10 = lcm.work_grid10()
    lc = classes_to_points(np.load(os.path.join(work, 'lc10_work.npy')), g10, g)
    water = classes_to_points(np.load(os.path.join(work, 'water10_work.npy')), g10, g)

    levels = flatten_water(h, water, STEP)
    log('water levels', levels)
    n_obj, removed = clamp_objects(h, lc, water)
    log(f'buildings / trees: {n_obj} samples clamped (99th percentile cut {removed:.1f} m)')
    with open(os.path.join(work, 'runways.json')) as f:
        airports = json.load(f)['airports']
    rinfo = flatten_runways(h, g, airports)
    for k, v in rinfo.items():
        log(f'runway {k}: {v["min"]:.1f} .. {v["max"]:.1f} m, max slope {v["slope_max_pct"]:.2f} %')
    np.save(os.path.join(work, 'dem25_final.npy'), h)
    with open(os.path.join(work, 'heights_info.json'), 'w') as f:
        json.dump(dict(levels=levels, objects_clamped=n_obj, object_cut_p99_m=removed, runways=rinfo), f, indent=1)

    # ---- core tiles ----
    off = int(round(grid.MARGIN / STEP))
    n = grid.H_TILE_N - 1
    for iz in range(grid.NTILES):
        for ix in range(grid.NTILES):
            t = h[off + iz * n: off + iz * n + n + 1, off + ix * n: off + ix * n + n + 1]
            assert t.shape == (grid.H_TILE_N, grid.H_TILE_N)
            write_bin(os.path.join(out, 'height', f'tile_{ix}_{iz}.bin'), t)
    log('core tiles written')

    # ---- far ----
    fg = grid.PointGrid(-grid.FAR_HALF, -grid.FAR_HALF, grid.FAR_H_STEP, grid.FAR_H_N)
    far_src, far_tr = mosaic_dem(fetch.far_files(cache, 'dem_far'))
    far = reproject_to(far_src, far_tr, fg, Resampling.average)
    del far_src
    # far water: sea at 0 (from the far land cover, sampled at the far points)
    wfar = np.load(os.path.join(work, 'water_far.npy'))
    fa = grid.AreaGrid(-grid.FAR_HALF, -grid.FAR_HALF, 2 * grid.FAR_HALF / grid.LC_FAR_PX, grid.LC_FAR_PX)
    xs, zs = np.meshgrid(fg.xs(), fg.zs())
    cols = (xs - fa.x0) / fa.px - 0.5
    rows = (zs - fa.z0) / fa.px - 0.5
    sea_f = ndimage.map_coordinates((wfar == lcm.SEA).astype(np.float32), [rows, cols], order=1, mode='nearest') > 0.5
    far[sea_f] = 0.0
    far[(~sea_f) & (far < 0.5) & ndimage.binary_dilation(sea_f, iterations=2)] = 0.5
    # the core and its ring, box-filtered to 200 m; within 1 km of the core edge the far samples
    # blend to the core's own samples, so the far mesh meets the core mesh at identical heights
    hb = box200(h)
    k = int(round(grid.FAR_H_STEP / STEP))
    c0 = int(round((grid.FAR_HALF - grid.WORK_HALF) / grid.FAR_H_STEP))
    nc = hb[::k, ::k].shape[0]
    X = np.abs(fg.xs()[c0:c0 + nc])
    R = np.maximum(X[None, :], X[:, None])
    w_pt = 1.0 - smoothstep(0.0, 1000.0, np.abs(R - grid.CORE_HALF))
    core_far = hb[::k, ::k] * (1 - w_pt) + h[::k, ::k] * w_pt
    wgt = smoothstep(grid.CORE_HALF, grid.WORK_HALF - 800.0, R)
    region = far[c0:c0 + nc, c0:c0 + nc]
    seam = core_far - region
    ring = (R > grid.CORE_HALF) & (R < grid.WORK_HALF - 800.0)
    log(f'far vs core in the blend ring: mean {seam[ring].mean():+.2f} m, rms {np.sqrt((seam[ring] ** 2).mean()):.2f} m')
    far[c0:c0 + nc, c0:c0 + nc] = core_far * (1 - wgt) + region * wgt
    np.save(os.path.join(work, 'far_final.npy'), far)
    write_bin(os.path.join(out, 'height', 'far.bin'), far)
    log('far.bin written', far.shape, f'{far.min():.1f} .. {far.max():.1f} m')
