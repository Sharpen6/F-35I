"""Canted twin vertical tails with rudders, all-moving horizontal stabilators."""
import math

from .geom import Pchip, get_collection, Y0
from .surfaces import Frame, lifting_surface, split_surface, set_hinge
from . import materials as M

FIN_CANT = math.radians(20.0)      # outward cant from vertical (measured 20.2-20.3)
FIN_ROOT = (1.42, 0.35)            # (half width, z) of the fin root line (buried)
FIN_SPAN = 2.395                   # along the canted plane -> tip (2.24, 2.60)
FIN_LE = (11.40, 13.48)            # root / tip leading edge station
FIN_TE = (13.90, 14.90)            # root / tip trailing edge station
RUD_HINGE = (13.42, 14.45)         # rudder hinge station at root / tip

STAB_ROOT = (0.80, 0.22)
STAB_TIP_HW = 3.43                 # official span 6.86 m (3-view is ~5 % oversize)
STAB_DIHEDRAL = math.radians(4.5)  # tips at z ~0.43, level with the fin TE root (3-view side and
                                   # front views, photos c14, c20, c26; the root stays put)
_STAB_LE = Pchip([0.80, 1.30, 1.95, 2.20, 2.90, 3.66],
                 [12.70, 12.80, 12.92, 13.15, 13.62, 14.14])
_STAB_TE = Pchip([0.80, 1.00, 2.30, 3.66], [15.64, 15.69, 15.37, 15.03])
STAB_PIVOT_S = 14.25


def _lin(a, b, f):
    return a + (b - a) * f


def build(ctx):
    root = ctx["root"]
    helpers = ctx["helpers"]
    coll = get_collection("Tails", root)
    objs = {}
    # ------------------------------------------------------------------ fins
    us = [-0.22, -0.1, 0.0] + [FIN_SPAN * i / 14 for i in range(1, 15)]
    for side, tag in ((1, "L"), (-1, "R")):
        span_dir = (math.sin(FIN_CANT), 0, math.cos(FIN_CANT))
        normal = (math.cos(FIN_CANT), 0, -math.sin(FIN_CANT))
        fr = Frame(FIN_ROOT, span_dir, normal, mirror=(side < 0))
        le = lambda u: _lin(FIN_LE[0], FIN_LE[1], u / FIN_SPAN)
        te = lambda u: _lin(FIN_TE[0], FIN_TE[1], u / FIN_SPAN)
        tcf = lambda u: 0.046 - 0.010 * max(0.0, u) / FIN_SPAN
        fin = lifting_surface(f"Fin_{tag}", coll, fr, us, le, te, tcf,
                              M.get("skin"), n_chord=36)
        hinge = lambda u: _lin(RUD_HINGE[0], RUD_HINGE[1], u / FIN_SPAN)
        a, b = 0.12, FIN_SPAN - 0.06
        poly = [(a, hinge(a)), (b, hinge(b)), (b, te(b) + 0.4), (a, te(a) + 0.4)]
        rud = split_surface(fin, poly, fr, helpers, f"Rudder_{tag}", gap=0.008)
        set_hinge(rud, fr.world(a, hinge(a), 0), fr.world(b, hinge(b), 0),
                  "rudder", (-30.0, 30.0), {"side": side})
        objs[f"Fin_{tag}"] = fin
        objs[f"Rudder_{tag}"] = rud
    # ----------------------------------------------------------- stabilators
    cd, sd = math.cos(STAB_DIHEDRAL), math.sin(STAB_DIHEDRAL)
    span = (STAB_TIP_HW - STAB_ROOT[0]) / cd           # along the tilted span
    us = [span * i / 20 for i in range(21)]
    for side, tag in ((1, "L"), (-1, "R")):
        fr = Frame(STAB_ROOT, (cd, 0, sd), (-sd, 0, cd), mirror=(side < 0))
        # the planform is given in plan view (half width x)
        le = lambda u: _STAB_LE(STAB_ROOT[0] + u * cd)
        te = lambda u: _STAB_TE(STAB_ROOT[0] + u * cd)
        tcf = lambda u: 0.045 - 0.010 * u / span
        stab = lifting_surface(f"Stabilator_{tag}", coll, fr, us, le, te, tcf,
                               M.get("skin"), n_chord=40)
        p0 = fr.world(0.0, STAB_PIVOT_S, 0.0)
        p1 = fr.world(1.0, STAB_PIVOT_S, 0.0)
        set_hinge(stab, p0, p1, "stabilator", (-21.0, 21.0), {"side": side})
        objs[f"Stabilator_{tag}"] = stab
    ctx["objects"].update(objs)
    return objs
