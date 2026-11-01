"""Sentinel-2 surface reflectance -> display sRGB ("summer aerial photo of central Israel").

The ESA WorldCover S2 composite holds the 2021 per-pixel median of cloud-free Sentinel-2 L2A
observations: band 1 B04 red, band 2 B03 green, band 3 B02 blue, band 4 B08 NIR, uint16,
reflectance = value * 1e-4 (file metadata: scales 0.0001, nodata 0).

Grading, all in one place so the core tiles and the far area use exactly the same look:
  1. subtract a small per-band offset (residual path radiance that makes S2 true colour look milky),
  2. exposure (linear gain) and a gentle white balance,
  3. a smooth highlight shoulder so bright desert, salt and roofs never clip,
  4. sRGB encoding, a mild S-curve for contrast and a small saturation boost, then a
     hue-preserving gamut limit (no channel is clipped),
  5. a light NDVI-driven push of vegetation towards a fresh deep green (orchards, pines).
Water is handled by the colour stage (the composite's sea is replaced).
"""
import numpy as np

# tuned by eye against aerial photos of the coastal plain, the Judean hills and the desert
DARK = np.array([0.006, 0.012, 0.022], np.float32)     # R, G, B reflectance offsets
GAIN = np.array([2.55, 2.62, 2.78], np.float32)        # exposure x white balance
KNEE = 0.72                                            # start of the highlight shoulder (linear)
CONTRAST = 0.22                                        # 0 = none, 1 = full smoothstep S-curve
SATURATION = 1.08
VEG_BOOST = 0.20                                       # strength of the NDVI vegetation push
TOP, BOTTOM = 0.965, 0.012                             # channel range kept without clipping (sRGB)

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0.0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def shoulder(x, knee=KNEE):
    """Identity below the knee, then an exponential roll-off approaching 1 (C1 continuous)."""
    k = knee
    over = np.maximum(x - k, 0.0)
    return np.where(x < k, x, k + (1 - k) * (1 - np.exp(-over / (1 - k))))


def grade(refl):
    """refl: float32 array (4, H, W) or (3, H, W) reflectance (R, G, B[, NIR]) -> sRGB float (H, W, 3) in [0, 1]."""
    r, g, b = refl[0], refl[1], refl[2]
    lin = np.stack([np.maximum(r - DARK[0], 0) * GAIN[0],
                    np.maximum(g - DARK[1], 0) * GAIN[1],
                    np.maximum(b - DARK[2], 0) * GAIN[2]], axis=-1)
    if refl.shape[0] >= 4 and VEG_BOOST > 0:
        nir = refl[3]
        ndvi = (nir - r) / np.maximum(nir + r, 1e-4)
        v = np.clip((ndvi - 0.25) / 0.35, 0.0, 1.0)[..., None] * VEG_BOOST
        # towards a greener, slightly darker version of the same luminance
        y = lin @ LUMA
        green = np.stack([0.70 * y, 1.18 * y, 0.62 * y], axis=-1)
        lin = lin * (1 - v) + green * v
    lin = shoulder(lin)
    s = lin_to_srgb(lin)
    # mild S-curve (blend with smoothstep), then saturation around luma
    s = np.clip(s, 0.0, 1.0)
    s = s + CONTRAST * (s * s * (3 - 2 * s) - s)
    y = (s @ LUMA)[..., None]
    s = y + (s - y) * SATURATION
    return limit_gamut(s)


def limit_gamut(s, top=TOP, bottom=BOTTOM):
    """Keep every channel inside [bottom, top] without changing luminance or hue: the chroma of
    the few pixels that would leave the range (bright chalk and sand in the red channel, mostly)
    is scaled down instead of clipping a single channel."""
    y = (s @ LUMA)[..., None]
    d = s - y
    hi = np.maximum(d.max(axis=-1, keepdims=True), 1e-6)
    lo = np.minimum(d.min(axis=-1, keepdims=True), -1e-6)
    k = np.minimum(1.0, np.minimum(np.maximum(top - y, 0.0) / hi, np.maximum(y - bottom, 0.0) / -lo))
    return np.clip(y + d * k, 0.0, 1.0)


def to_u8(s):
    return (np.clip(s, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
