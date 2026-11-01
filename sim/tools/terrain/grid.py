"""World frame and raster grids of the F-35I sim terrain (see sim/DESIGN.md).

World (three.js, right-handed, Y up): X = easting, Y = height above mean sea level,
Z = -northing. The projection is a transverse Mercator centred on central Israel.

Raster conventions used everywhere in this pipeline:
  * "point" grids hold samples AT X = x0 + step * c, Z = z0 + step * r (heights);
  * "area" grids hold pixels COVERING [x0 + px * i, x0 + px * (i + 1)] (textures, land cover).
Row 0 is always the north edge (smallest Z, largest northing).
"""
import math

import numpy as np
from affine import Affine
from pyproj import CRS, Transformer

PROJ4 = ('+proj=tmerc +lat_0=31.80 +lon_0=35.025 +k=1 +x_0=0 +y_0=0 '
         '+ellps=WGS84 +towgs84=0,0,0 +units=m +no_defs')
TM = CRS.from_proj4(PROJ4)
WGS84 = CRS.from_epsg(4326)
_FWD = Transformer.from_crs(WGS84, TM, always_xy=True)
_INV = Transformer.from_crs(TM, WGS84, always_xy=True)

# ---- the contract (sim/DESIGN.md) -------------------------------------------------------
CORE_HALF = 51200.0          # core: X, Z in [-51200, +51200]
TILE_SIZE = 6400.0           # 16 x 16 core tiles
NTILES = 16
FAR_HALF = 204800.0          # far: X, Z in [-204800, +204800]

H_STEP = 25.0                # core heights: 257 x 257 per tile, 25 m, shared edges
H_TILE_N = 257
FAR_H_STEP = 200.0           # far.bin: 2049 x 2049, 200 m
FAR_H_N = 2049

L0_PX = 1024                 # colour L0: 1024 px per tile (6.25 m)
COLOR_OVERVIEW_PX = 4096     # 25 m
COLOR_FAR_PX = 2048          # 200 m
LC_TILE_PX = 640             # land cover: 640 px per tile (10 m)
LC_OVERVIEW_PX = 4096        # 25 m
LC_FAR_PX = 2048             # 200 m

H_ENC_SCALE = 0.05           # h_m = v * 0.05 - 500
H_ENC_OFFSET = -500.0

# ---- pipeline-internal ----------------------------------------------------------------
MARGIN = 12800.0             # processing ring around the core (two tiles), for a seamless far area
WORK_HALF = CORE_HALF + MARGIN   # 64000


def lonlat_to_xz(lon, lat):
    """lon/lat (deg, WGS84) -> world X, Z (m). Works on scalars and numpy arrays."""
    e, n = _FWD.transform(lon, lat)
    return e, -np.asarray(n) if np.ndim(n) else -n


def xz_to_lonlat(x, z):
    """World X, Z (m) -> lon, lat (deg)."""
    zz = -np.asarray(z) if np.ndim(z) else -z
    lon, lat = _INV.transform(x, zz)
    return lon, lat


def encode_height(h):
    """Heights in m -> the contract's little-endian uint16 (h = v * 0.05 - 500)."""
    v = np.rint((np.asarray(h, np.float64) - H_ENC_OFFSET) / H_ENC_SCALE)
    return np.clip(v, 0, 65535).astype('<u2')


def decode_height(v):
    return np.asarray(v, np.float32) * H_ENC_SCALE + H_ENC_OFFSET


class PointGrid:
    """Samples at X = x0 + step * c (c < ncols), Z = z0 + step * r (r < nrows)."""

    def __init__(self, x0, z0, step, ncols, nrows=None):
        self.x0, self.z0, self.step = float(x0), float(z0), float(step)
        self.ncols, self.nrows = int(ncols), int(nrows if nrows is not None else ncols)

    @property
    def shape(self):
        return (self.nrows, self.ncols)

    @property
    def transform(self):
        # rasterio treats a value as the centre of its pixel: shift by half a step
        s = self.step
        return Affine(s, 0.0, self.x0 - s / 2, 0.0, -s, -self.z0 + s / 2)

    def xs(self):
        return self.x0 + self.step * np.arange(self.ncols)

    def zs(self):
        return self.z0 + self.step * np.arange(self.nrows)


class AreaGrid:
    """Pixels covering [x0 + px i, x0 + px (i + 1)] x [z0 + px j, z0 + px (j + 1)], row 0 north."""

    def __init__(self, x0, z0, px, ncols, nrows=None):
        self.x0, self.z0, self.px = float(x0), float(z0), float(px)
        self.ncols, self.nrows = int(ncols), int(nrows if nrows is not None else ncols)

    @property
    def shape(self):
        return (self.nrows, self.ncols)

    @property
    def transform(self):
        p = self.px
        return Affine(p, 0.0, self.x0, 0.0, -p, -self.z0)

    def xs(self):
        """Pixel-centre X of each column."""
        return self.x0 + self.px * (np.arange(self.ncols) + 0.5)

    def zs(self):
        return self.z0 + self.px * (np.arange(self.nrows) + 0.5)


def tile_origin(ix, iz):
    """World X0, Z0 (north-west corner) of core tile (ix, iz)."""
    return -CORE_HALF + TILE_SIZE * ix, -CORE_HALF + TILE_SIZE * iz


def lonlat_bounds(x0, z0, x1, z1, pad_deg=0.0, n=64):
    """lon/lat bounding box (west, south, east, north) of the world rectangle [x0,x1] x [z0,z1]."""
    t = np.linspace(0.0, 1.0, n)
    xs = np.concatenate([x0 + (x1 - x0) * t, np.full(n, x1), x1 - (x1 - x0) * t, np.full(n, x0)])
    zs = np.concatenate([np.full(n, z0), z0 + (z1 - z0) * t, np.full(n, z1), z1 - (z1 - z0) * t])
    lon, lat = xz_to_lonlat(xs, zs)
    return (float(np.min(lon)) - pad_deg, float(np.min(lat)) - pad_deg,
            float(np.max(lon)) + pad_deg, float(np.max(lat)) + pad_deg)


def deg_tiles(bounds):
    """1 x 1 degree tiles (lat, lon of the SW corner) intersecting a lon/lat box."""
    w, s, e, n = bounds
    return [(lat, lon) for lat in range(math.floor(s), math.floor(n) + 1)
            for lon in range(math.floor(w), math.floor(e) + 1)]


def grid_convergence_deg(x, z):
    """Angle (deg) from world grid north (-Z) to true north at (x, z), positive = true north is east of grid north."""
    lon, lat = xz_to_lonlat(x, z)
    x2, z2 = lonlat_to_xz(lon, lat + 0.01)
    return math.degrees(math.atan2(x2 - x, -(z2 - z)))


# Named places used by several stages (lon, lat)
PLACES = {
    'tel_nof': (34.8218, 31.8395),
    'tel_aviv': (34.7800, 32.0800),
    'jerusalem_old_city': (35.2340, 31.7780),
    'dead_sea': (35.5000, 31.5500),
}
