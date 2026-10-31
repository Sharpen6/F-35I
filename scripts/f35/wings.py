"""Main wings with leading-edge flaps and flaperons.

Planform measured from the public 3-view (span 10.7 m, LE sweep ~34 deg,
trailing edge forward-swept ~14 deg, tip chord ~1.6 m, wing area ~42.7 m^2).
"""
import math
from mathutils import Vector

from .geom import Pchip, get_collection, Y0
from .surfaces import Frame, lifting_surface, split_surface, set_hinge
from . import materials as M

HW_ROOT = 1.50          # wing root (inside the inlet cowl)
HW_TIP = 5.37           # half span
Z_WING = 0.26           # wing reference plane (z of mid-thickness)

_LE = Pchip([1.50, 1.62, 1.78, 1.94, 2.14, 2.40, 3.00, 4.00, 5.00, 5.37],
            [6.70, 6.86, 7.10, 7.37, 7.77, 8.03, 8.428, 9.091, 9.754, 10.00])
_TE = Pchip([1.50, 1.89, 3.60, 5.37], [12.56, 12.50, 12.083, 11.63])


def le(hw):
    return _LE(hw)


def te(hw):
    return _TE(hw)


def tc(hw):
    f = (hw - HW_ROOT) / (HW_TIP - HW_ROOT)
    return 0.052 - 0.017 * f


# moving surfaces (hw ranges, chord fractions)
LEF_HW = (2.45, 5.28)
LEF_FRAC = 0.17
FLAP_HW = (1.98, 4.25)
FLAP_FRAC = 0.78


def build(ctx):
    root = ctx["root"]
    helpers = ctx["helpers"]
    coll = get_collection("Wings", root)
    objs = {}
    us = [0.0, 0.06, 0.12, 0.2, 0.28, 0.36, 0.44, 0.52, 0.64, 0.76, 0.9]
    u = 1.0
    while u < HW_TIP - HW_ROOT - 1e-6:
        us.append(u)
        u += 0.12
    us.append(HW_TIP - HW_ROOT)
    for side, tag in ((1, "L"), (-1, "R")):
        fr = Frame((HW_ROOT, Z_WING), (1, 0, 0), (0, 0, 1), mirror=(side < 0))
        wing = lifting_surface(f"Wing_{tag}", coll, fr, us,
                               lambda u: le(HW_ROOT + u), lambda u: te(HW_ROOT + u),
                               lambda u: tc(HW_ROOT + u), M.get("skin"), n_chord=44)
        # leading-edge flap
        a, b = LEF_HW[0] - HW_ROOT, LEF_HW[1] - HW_ROOT

        def hinge_lef(uu):
            hw = HW_ROOT + uu
            return le(hw) + LEF_FRAC * (te(hw) - le(hw))
        poly = [(a, le(HW_ROOT + a) - 0.4), (b, le(HW_ROOT + b) - 0.4),
                (b, hinge_lef(b)), (a, hinge_lef(a))]
        lef = split_surface(wing, poly, fr, helpers, f"LEF_{tag}", gap=0.008)
        p0 = fr.world(a, hinge_lef(a), 0.0)
        p1 = fr.world(b, hinge_lef(b), 0.0)
        # LEF droops (leading edge down) positive
        set_hinge(lef, p0, p1, "lef", (-3.0, 30.0), {"side": side})
        # flaperon
        a, b = FLAP_HW[0] - HW_ROOT, FLAP_HW[1] - HW_ROOT

        def hinge_flap(uu):
            hw = HW_ROOT + uu
            return le(hw) + FLAP_FRAC * (te(hw) - le(hw))
        poly = [(a, hinge_flap(a)), (b, hinge_flap(b)),
                (b, te(HW_ROOT + b) + 0.4), (a, te(HW_ROOT + a) + 0.4)]
        flp = split_surface(wing, poly, fr, helpers, f"Flaperon_{tag}", gap=0.008)
        p0 = fr.world(a, hinge_flap(a), 0.0)
        p1 = fr.world(b, hinge_flap(b), 0.0)
        set_hinge(flp, p0, p1, "flaperon", (-30.0, 30.0), {"side": side})
        objs[f"Wing_{tag}"] = wing
        objs[f"LEF_{tag}"] = lef
        objs[f"Flaperon_{tag}"] = flp
    ctx["objects"].update(objs)
    return objs
