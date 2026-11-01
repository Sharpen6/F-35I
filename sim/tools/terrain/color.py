"""Colour: ESA WorldCover 2021 Sentinel-2 composite -> color/ (L0 tiles, overview, far).

L0 tiles are reprojected from the 10 m composite with cubic interpolation (upsampling to 6.25 m),
graded (colorgrade.py), and the water is recoloured:
  * Mediterranean: a clean natural blue by distance from the shore (shallow turquoise near the
    beach, deep blue offshore), blended in over a soft shoreline taken from the WorldCover water
    mask, so the beach, surf line and harbour moles of the imagery stay;
  * Dead Sea: turquoise blue, lighter over the shallow salt shelf; the white salt pans and
    mud flats around it are land in WorldCover and keep their imagery colour.
The overview (25 m) and the core part of far.jpg (200 m) are box-filtered (in linear light) from the
L0 tiles. Outside the core far.jpg comes from the composite's 8x overviews graded the same way; a
smooth correction field fades any residual brightness difference out over 8 km so there is no seam.
"""
import math
import os

import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import Resampling, reproject
from rasterio.windows import from_bounds
from scipy import ndimage

import colorgrade as cg
import fetch
import grid
import landcover as lcm

JPEG_Q_L0 = 87
JPEG_Q_OVERVIEW = 90
JPEG_Q_FAR = 90

# Typical reflectance of open water, used to fill composite no-data before resampling (replaced anyway)
SEA_REFL = np.array([0.012, 0.025, 0.040, 0.010], np.float32)

# Water palettes (sRGB) - mixed in linear light
SEA_SHORE = (96, 160, 166)      # breaking-wave / very shallow turquoise right at the beach
SEA_SHALLOW = (52, 120, 142)    # sandy bottom, first few hundred metres
SEA_MID = (28, 84, 122)         # 0.5 - 3 km
SEA_DEEP = (17, 55, 96)         # offshore Mediterranean blue
DEAD_SHORE = (118, 186, 184)    # salt shelf, very shallow
DEAD_SHALLOW = (64, 150, 166)
DEAD_DEEP = (34, 104, 140)      # the Dead Sea's deep turquoise blue


def log(*a):
    print('[color]', *a, flush=True)


def _lin(c):
    return cg.srgb_to_lin(np.array(c, np.float32) / 255.0)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def world_noise(x, z, scale=1.0):
    """Smooth, seamless low-frequency variation (about +-1) from a few rotated sinusoids in world metres."""
    n = np.zeros(np.broadcast(x, z).shape, np.float32)
    for k, (wl, ang, ph) in enumerate(((5200, 0.3, 0.0), (2300, 1.4, 1.7), (1100, 2.3, 4.1), (640, 0.9, 2.2))):
        u = (x * math.cos(ang) + z * math.sin(ang)) / (wl * scale)
        n += np.sin(2 * math.pi * u + ph).astype(np.float32) * (0.5 ** k)
    return n / 1.875


def sea_lin(d, x, z):
    """Mediterranean colour (linear RGB, (..., 3)) at distance d (m) from the shore."""
    d = d[..., None]
    c = _lin(SEA_SHORE) + (_lin(SEA_SHALLOW) - _lin(SEA_SHORE)) * smoothstep(0, 60, d)
    c = c + (_lin(SEA_MID) - c) * smoothstep(80, 900, d)
    c = c + (_lin(SEA_DEEP) - c) * smoothstep(700, 6000, d)
    var = 1.0 + 0.04 * world_noise(x, z)[..., None]
    return c * var


def dead_lin(d, x, z):
    d = d[..., None]
    c = _lin(DEAD_SHORE) + (_lin(DEAD_SHALLOW) - _lin(DEAD_SHORE)) * smoothstep(0, 50, d)
    c = c + (_lin(DEAD_DEEP) - c) * smoothstep(60, 1500, d)
    var = 1.0 + 0.03 * world_noise(x + 7000, z - 3000, 0.7)[..., None]
    return c * var


def sample_grid(arr, g, x, z, order=1, pad_value=0.0):
    """Sample a raster on area grid g at world points (x, z) (bilinear by default)."""
    cols = (x - g.x0) / g.px - 0.5
    rows = (z - g.z0) / g.px - 0.5
    return ndimage.map_coordinates(arr, [rows, cols], order=order, mode='nearest', cval=pad_value)


def soft_mask(classes, value, g, x, z, blur_px=0.6, near_m=0.0):
    """Anti-aliased mask (0..1) of classes == value from a class raster on grid g, sampled at (x, z).

    With near_m > 0 also returns a 0/1 mask of "within near_m metres of that class".
    Only a window around the sample points is processed (classes may be a big memmap)."""
    pad = 8 + int(math.ceil(near_m / g.px))
    c0 = int(max(0, math.floor((x.min() - g.x0) / g.px) - pad))
    c1 = int(min(classes.shape[1], math.ceil((x.max() - g.x0) / g.px) + pad))
    r0 = int(max(0, math.floor((z.min() - g.z0) / g.px) - pad))
    r1 = int(min(classes.shape[0], math.ceil((z.max() - g.z0) / g.px) + pad))
    m = (np.asarray(classes[r0:r1, c0:c1]) == value).astype(np.float32)
    if not m.any():
        z0 = np.zeros(x.shape, np.float32)
        return (z0, z0) if near_m > 0 else z0
    sub = grid.AreaGrid(g.x0 + c0 * g.px, g.z0 + r0 * g.px, g.px, c1 - c0, r1 - r0)
    near = None
    if near_m > 0:
        k = 2 * int(math.ceil(near_m / g.px)) + 1
        near = sample_grid(ndimage.maximum_filter(m, size=k), sub, x, z, order=0)
    if blur_px > 0:
        m = ndimage.gaussian_filter(m, blur_px)
    v = sample_grid(m, sub, x, z)
    # sharpen the 0..1 ramp a little: crisp but anti-aliased shoreline
    v = smoothstep(0.2, 0.8, v)
    return (v, near) if near_m > 0 else v


def imagery_water(refl):
    """0..1 'looks like open water' from reflectance (4, H, W): dark in NIR and greener than NIR (NDWI)."""
    g, nir = refl[1], refl[3]
    ndwi = (g - nir) / np.maximum(g + nir, 1e-4)
    return (smoothstep(0.05, 0.25, ndwi) * (1.0 - smoothstep(0.035, 0.07, nir))).astype(np.float32)


def compose_water(lin, x, z, sea_m, dead_m, dist):
    """Blend the water palettes into linear RGB `lin` (H, W, 3) using soft masks and shore distance."""
    if sea_m.any():
        w = sea_m[..., None]
        lin = lin * (1 - w) + sea_lin(dist, x, z) * w
    if dead_m.any():
        w = dead_m[..., None]
        lin = lin * (1 - w) + dead_lin(dist, x, z) * w
    return lin


def save_jpeg(path, rgb8, q):
    tmp = path + '.tmp.jpg'
    # 4:4:4: no chroma subsampling (sharper colour edges, no overshoot past the gamut limit)
    Image.fromarray(rgb8, 'RGB').save(tmp, quality=q, subsampling=0, optimize=True)
    os.replace(tmp, path)


def fill_nodata(refl, nod, sigma=4.0):
    """Fill composite no-data pixels: from nearby valid pixels (normalised Gaussian), else open-water reflectance.

    The open sea far from the coast is no-data in the composite and is recoloured later anyway; this
    keeps small holes on land and along the shore from turning black."""
    if not nod.any():
        return refl
    valid = (~nod).astype(np.float32)
    wsum = ndimage.gaussian_filter(valid, sigma)
    out = refl.copy()
    for b in range(refl.shape[0]):
        avg = ndimage.gaussian_filter(refl[b] * valid, sigma) / np.maximum(wsum, 1e-6)
        k = np.clip(wsum / 0.05, 0.0, 1.0)     # confidence of the neighbourhood average
        out[b][nod] = (avg * k + SEA_REFL[b] * (1 - k))[nod]
    return out


def block_mean(a, k):
    h, w = a.shape[:2]
    return a.reshape(h // k, k, w // k, k, -1).mean(axis=(1, 3))


# ---- core -----------------------------------------------------------------------------------

def render_tile(src, ix, iz, water10, g10, shore, gs):
    """One L0 tile: returns (sRGB uint8 (1024, 1024, 3), linear float32 (1024, 1024, 3))."""
    x0, z0 = grid.tile_origin(ix, iz)
    n = grid.L0_PX
    tg = grid.AreaGrid(x0, z0, grid.TILE_SIZE / n, n)
    b = grid.lonlat_bounds(x0 - 60, z0 - 60, x0 + grid.TILE_SIZE + 60, z0 + grid.TILE_SIZE + 60)
    win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
    raw = src.read(window=win, boundless=True, fill_value=0)
    refl = fill_nodata(raw.astype(np.float32) * 1e-4, raw[0] == 0)
    dst = np.zeros((4, n, n), np.float32)
    reproject(refl, dst, src_transform=src.window_transform(win), src_crs=grid.WGS84,
              dst_transform=tg.transform, dst_crs=grid.TM, resampling=Resampling.cubic)
    dst = np.maximum(dst, 0.0)
    s = cg.grade(dst)
    lin = cg.srgb_to_lin(s)

    xs, zs = np.meshgrid(tg.xs(), tg.zs())
    sea_m, sea_near = soft_mask(water10, lcm.SEA, g10, xs, zs, near_m=400.0)
    dead_m, dead_near = soft_mask(water10, lcm.DEAD_SEA, g10, xs, zs, near_m=300.0)
    if sea_near.any() or dead_near.any():
        # water that the 2021 land-cover map calls land (new port basins, the receding Dead Sea
        # shore): if the imagery itself is clearly open water next to the sea, recolour it too
        iw = ndimage.gaussian_filter(imagery_water(dst), 0.8)
        sea_m = np.maximum(sea_m, iw * sea_near)
        dead_m = np.maximum(dead_m, iw * dead_near * (1.0 - sea_near))
    if sea_m.any() or dead_m.any():
        dist = sample_grid(shore, gs, xs, zs).astype(np.float32)
        lin = compose_water(lin, xs, zs, sea_m, dead_m, dist)
    s = cg.lin_to_srgb(lin)
    return cg.to_u8(s), lin.astype(np.float32)


def run_core(cache, out):
    work = os.path.join(cache, 'work')
    water10 = np.load(os.path.join(work, 'water10_work.npy'), mmap_mode='r')
    g10 = lcm.work_grid10()
    shore = np.load(os.path.join(work, 'shore20_core.npy'))
    gs = grid.AreaGrid(-grid.CORE_HALF, -grid.CORE_HALF, 20.0, shore.shape[1])
    os.makedirs(os.path.join(out, 'color', 'L0'), exist_ok=True)
    ov_n = grid.COLOR_OVERVIEW_PX // grid.NTILES          # 256 px of the overview per tile
    far_n = int(round(grid.TILE_SIZE / (2 * grid.FAR_HALF / grid.COLOR_FAR_PX)))   # 32 px of far per tile
    ov = np.zeros((grid.COLOR_OVERVIEW_PX, grid.COLOR_OVERVIEW_PX, 3), np.float32)
    farc = np.zeros((far_n * grid.NTILES, far_n * grid.NTILES, 3), np.float32)
    with rasterio.open(os.path.join(cache, 's2', 's2_core.tif')) as src:
        for iz in range(grid.NTILES):
            for ix in range(grid.NTILES):
                rgb8, lin = render_tile(src, ix, iz, water10, g10, shore, gs)
                save_jpeg(os.path.join(out, 'color', 'L0', f'tile_{ix}_{iz}.jpg'), rgb8, JPEG_Q_L0)
                ov[iz * ov_n:(iz + 1) * ov_n, ix * ov_n:(ix + 1) * ov_n] = block_mean(lin, grid.L0_PX // ov_n)
                farc[iz * far_n:(iz + 1) * far_n, ix * far_n:(ix + 1) * far_n] = block_mean(lin, grid.L0_PX // far_n)
            log(f'L0 row {iz + 1}/{grid.NTILES}')
    save_jpeg(os.path.join(out, 'color', 'overview.jpg'), cg.to_u8(cg.lin_to_srgb(ov)), JPEG_Q_OVERVIEW)
    np.save(os.path.join(work, 'color_core_far_lin.npy'), farc)
    np.save(os.path.join(work, 'color_overview_lin.npy'), ov.astype(np.float16))


# ---- far ------------------------------------------------------------------------------------

def far_grid():
    return grid.AreaGrid(-grid.FAR_HALF, -grid.FAR_HALF, 2 * grid.FAR_HALF / grid.COLOR_FAR_PX, grid.COLOR_FAR_PX)


def far_imagery(cache, fg):
    """Graded linear RGB of the far area from the composite's 8x overviews (NaN where no data)."""
    acc = np.zeros(fg.shape + (3,), np.float64)
    cnt = np.zeros(fg.shape, np.float64)
    for p in fetch.far_files(cache, 's2_far'):
        with rasterio.open(p) as src:
            raw = src.read()
            tr = src.transform
        nod = raw[0] == 0
        lin = cg.srgb_to_lin(cg.grade(raw.astype(np.float32) * 1e-4))       # (H, W, 3)
        lin[nod] = np.nan
        for c in range(3):
            dst = np.full(fg.shape, np.nan, np.float32)
            reproject(np.ascontiguousarray(lin[..., c]), dst, src_transform=tr, src_crs=grid.WGS84,
                      dst_transform=fg.transform, dst_crs=grid.TM, resampling=Resampling.average,
                      src_nodata=np.nan, dst_nodata=np.nan)
            ok = ~np.isnan(dst)
            acc[..., c][ok] += dst[ok]
            if c == 0:
                cnt[ok] += 1
        log('far imagery', os.path.basename(p))
    with np.errstate(invalid='ignore', divide='ignore'):
        img = (acc / cnt[..., None]).astype(np.float32)
    img[cnt == 0] = np.nan
    return img


def water_fraction_far(cache, fg, water_far):
    """Fractional (anti-aliased) Mediterranean / Dead Sea masks of the far grid from WorldCover 8x overviews."""
    frac = np.zeros(fg.shape, np.float32)
    have = np.zeros(fg.shape, bool)
    for p in fetch.far_files(cache, 'wc_far'):
        with rasterio.open(p) as src:
            a = src.read(1)
            tr = src.transform
        ind = ((a == lcm.WATER) | (a == 0)).astype(np.float32)
        dst = np.full(fg.shape, np.nan, np.float32)
        reproject(ind, dst, src_transform=tr, src_crs=grid.WGS84, dst_transform=fg.transform,
                  dst_crs=grid.TM, resampling=Resampling.average, src_nodata=None, dst_nodata=np.nan)
        ok = ~np.isnan(dst)
        frac[ok] = np.maximum(frac[ok], dst[ok])
        have |= ok
    frac[~have] = 1.0   # outside every WorldCover tile: open sea
    near = lambda cls: ndimage.binary_dilation(water_far == cls, iterations=1)
    sea = np.where(near(lcm.SEA), frac, 0.0)
    dead = np.where(near(lcm.DEAD_SEA), frac, 0.0)
    return smoothstep(0.15, 0.85, sea).astype(np.float32), smoothstep(0.15, 0.85, dead).astype(np.float32)


def run_far(cache, out):
    work = os.path.join(cache, 'work')
    fg = far_grid()
    water_far = np.load(os.path.join(work, 'water_far.npy'))
    img = far_imagery(cache, fg)
    sea_m, dead_m = water_fraction_far(cache, fg, water_far)
    dist = ndimage.distance_transform_edt((water_far == lcm.SEA) | (water_far == lcm.DEAD_SEA)).astype(np.float32) * fg.px
    xs, zs = np.meshgrid(fg.xs(), fg.zs())
    missing = np.isnan(img[..., 0])
    img[missing] = sea_lin(np.full(int(missing.sum()), 8000.0, np.float32), xs[missing], zs[missing])
    lin = compose_water(img, xs, zs, sea_m, dead_m, dist)

    # the core: exactly the L0 tiles box-filtered to 200 m
    core = np.load(os.path.join(work, 'color_core_far_lin.npy'))
    c0 = int(round((grid.FAR_HALF - grid.CORE_HALF) / fg.px))
    nc = core.shape[0]
    derived = lin[c0:c0 + nc, c0:c0 + nc].copy()
    # seam correction: smooth log-ratio core / far-derived, carried outward from the core edge, fading over 8 km
    eps = 1e-3
    d = np.log(core + eps) - np.log(derived + eps)
    d = np.stack([ndimage.gaussian_filter(d[..., c], 6.0, mode='nearest') for c in range(3)], axis=-1)
    pad = c0
    ext = np.pad(d, ((pad, pad), (pad, pad), (0, 0)), mode='edge')
    r = np.arange(fg.nrows)
    dz = np.maximum(np.maximum(c0 - r, r - (c0 + nc - 1)), 0)
    dxy = np.maximum(dz[:, None], dz[None, :]).astype(np.float32) * fg.px
    fade = 1.0 - smoothstep(0.0, 8000.0, dxy)
    lin = lin * np.exp(ext * fade[..., None])
    lin[c0:c0 + nc, c0:c0 + nc] = core
    log('seam: mean |log ratio| at the core edge %.4f, rgb mean ratio %s' % (
        float(np.abs(d[[0, -1], :]).mean()), np.round(np.exp(d.mean(axis=(0, 1))), 3).tolist()))
    save_jpeg(os.path.join(out, 'color', 'far.jpg'), cg.to_u8(cg.lin_to_srgb(lin)), JPEG_Q_FAR)
    np.save(os.path.join(work, 'color_far_lin.npy'), lin.astype(np.float16))


def run(cache, out):
    run_core(cache, out)
    run_far(cache, out)
    log('done')
