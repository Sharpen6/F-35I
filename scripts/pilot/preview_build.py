"""Build the standing pilot's meshes in plain numpy for software previews (see preview.py)."""
import numpy as np

from . import parts as P
from . import skeleton as S

# rough display colours (sRGB 0..1) per material key
COLORS = {
    "suit": (0.37, 0.40, 0.31), "gsuit": (0.42, 0.42, 0.32), "webbing": (0.23, 0.24, 0.20),
    "vest": (0.34, 0.36, 0.29), "glove": (0.49, 0.48, 0.38), "boot": (0.17, 0.15, 0.13),
    "sole": (0.10, 0.10, 0.10), "helmet": (0.17, 0.18, 0.19), "helmet_trim": (0.08, 0.09, 0.09),
    "visor": (0.05, 0.05, 0.06), "mask": (0.29, 0.30, 0.30), "mask_seal": (0.42, 0.43, 0.42),
    "hose": (0.33, 0.35, 0.31), "metal": (0.60, 0.60, 0.59), "dark_metal": (0.23, 0.23, 0.24),
    "skin": (0.72, 0.55, 0.45), "black": (0.07, 0.07, 0.07), "zip": (0.23, 0.24, 0.20),
    "patch": (0.31, 0.33, 0.27), "leather": (0.16, 0.14, 0.12), "clear_cover": (0.55, 0.58, 0.62),
    "rubber": (0.06, 0.06, 0.06), "lens": (0.25, 0.20, 0.55), "black_gloss": (0.04, 0.04, 0.04),
    "webbing_black": (0.08, 0.08, 0.08), "hose_olive": (0.20, 0.25, 0.22), "cable": (0.06, 0.06, 0.06),
    "olive_metal": (0.37, 0.36, 0.27), "kneeboard": (0.15, 0.15, 0.16), "paper": (0.85, 0.85, 0.82),
    "watch_face": (0.05, 0.05, 0.06), "cuff": (0.40, 0.42, 0.44), "steel": (0.75, 0.75, 0.76),
    "steel_brushed": (0.70, 0.71, 0.72), "screen": (0.10, 0.20, 0.25), "flag": (0.85, 0.87, 0.95),
    "unit_patch": (0.35, 0.50, 0.75), "tshirt": (0.9, 0.9, 0.9), "glove_leather": (0.45, 0.44, 0.40),
}


def to_srgb_lin(c):
    return tuple(x ** 2.2 for x in c)


def standing_objects(h=0.004, only=None, timings=None):
    j = S.standing()
    F = S.frames(j)
    parts = P.build(j, F, h=h, only=only, timings=timings)
    return [(p["v"], p["q"], to_srgb_lin(COLORS.get(p["mat"], (0.5, 0.5, 0.5)))) for p in parts]
