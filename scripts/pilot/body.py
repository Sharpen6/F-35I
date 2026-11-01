"""The pilot's body in the flight suit: lofted torso, arms and legs plus a few bone-attached solids.

Every station and solid is given in its bone's frame (skeleton.frames): x = towards the pilot's
left, y = along the bone (as a fraction t of its length), z = to the front.  Left side parts are
mirrored onto the right side (x -> -x).  Because everything rides on the bones, the same tables
build the standing pilot and the seated one, each meshed directly (no skinning artefacts).

The torso, each arm and each leg is one Loft (sdf.Loft): superelliptic cross-sections swept
along the bones, mitred where the bones bend, so the silhouette is set directly by the section
sizes below rather than by overlapping blobs.

Sizes are of the DRESSED body: a loose flight suit over a ~1.78 m, 80 kg pilot (chest ~1.06 m
round, waist ~0.94 m, hips ~1.0 m, upper arm ~0.34 m, forearm ~0.30 m, thigh ~0.60 m, calf
~0.39 m).  Gear (G-suit, harness, vest, boots, gloves, helmet) goes on top.
"""
import numpy as np

from . import sdf
from .skeleton import BONE

# ------------------------------------------------------------------ lofts: (bone, t, section)
# section keys: w half width (x), f / b half depth to the front / back (z), n exponent,
# x0 / z0 shift of the section centre (x0 is mirrored: + = outwards for limbs)
TORSO = [
    ("pelvis", -0.70, dict(w=0.110, f=0.070, b=0.080, n=2.2, z0=-0.004)),   # crotch
    ("pelvis", -0.30, dict(w=0.166, f=0.092, b=0.112, n=2.3, z0=-0.008)),
    ("pelvis", 0.05, dict(w=0.180, f=0.098, b=0.122, n=2.3, z0=-0.008)),    # hips, buttocks
    ("pelvis", 0.65, dict(w=0.170, f=0.104, b=0.104, n=2.3)),               # belt line
    ("spine", 0.45, dict(w=0.162, f=0.108, b=0.098, n=2.3)),                # waist
    ("chest", 0.08, dict(w=0.170, f=0.118, b=0.104, n=2.3)),                # chest at the nipples
    ("chest", 0.45, dict(w=0.176, f=0.114, b=0.110, n=2.4)),                # armpits
    ("chest", 0.90, dict(w=0.164, f=0.094, b=0.100, n=2.6)),                # shoulder line
    ("neck", 0.30, dict(w=0.084, f=0.050, b=0.066, n=2.3)),                 # base of the neck
]
ARM = [
    ("upperarm", -0.12, dict(w=0.054, f=0.054, b=0.056, x0=0.004)),
    ("upperarm", 0.16, dict(w=0.058, f=0.055, b=0.057, x0=0.006)),          # deltoid
    ("upperarm", 0.45, dict(w=0.048, f=0.049, b=0.051)),
    ("upperarm", 0.80, dict(w=0.044, f=0.044, b=0.047)),
    ("upperarm", 1.00, dict(w=0.043, f=0.042, b=0.046)),                    # elbow
    ("forearm", 0.25, dict(w=0.044, f=0.046, b=0.044)),
    ("forearm", 0.60, dict(w=0.036, f=0.040, b=0.040)),
    ("forearm", 0.96, dict(w=0.027, f=0.033, b=0.033)),                     # wrist (in the cuff)
]
LEG = [
    ("thigh", -0.08, dict(w=0.088, f=0.086, b=0.096)),
    ("thigh", 0.12, dict(w=0.092, f=0.086, b=0.094, x0=0.010)),
    ("thigh", 0.42, dict(w=0.080, f=0.080, b=0.078, x0=0.004)),
    ("thigh", 0.78, dict(w=0.064, f=0.064, b=0.062)),
    ("thigh", 1.00, dict(w=0.058, f=0.062, b=0.058)),                       # knee
    ("shin", 0.22, dict(w=0.056, f=0.050, b=0.066, z0=-0.006)),             # calf
    ("shin", 0.55, dict(w=0.050, f=0.048, b=0.052)),
    ("shin", 0.80, dict(w=0.056, f=0.058, b=0.062)),                        # trouser leg over the boot
    ("shin", 0.90, dict(w=0.058, f=0.060, b=0.064)),                        # cuff (flat cut)
]
LOFT_ROUND = {"arm": (0.05, 0.02), "leg": (0.06, 0.0), "torso": (0.06, 0.0)}

# (bone, kind, params, blend k, mirror)
#   kind "ell": centre (x, t, z), radii (rx, ry, rz)            -> Ellipsoid in the bone frame
#   kind "cone": a (x, t, z), b (x, t, z), ra, rb               -> RoundCone
#   kind "sel": centre (x, t, z), r (x, y-, y+, z-, z+), n       -> SuperEllipsoid
SOLIDS = [
    # ----------------------------------------------------------------- neck and head
    ("neck", "cone", ((0.0, -0.05, -0.004), (0.0, 0.95, 0.0), 0.061, 0.055), 0.03, False),
    ("head", "ell", ((0.0, 0.46, -0.008), (0.077, 0.100, 0.098)), 0.03, False),           # skull
    ("head", "ell", ((0.0, 0.02, 0.046), (0.054, 0.064, 0.048)), 0.03, False),            # jaw
    ("head", "ell", ((0.0, 0.25, 0.094), (0.016, 0.032, 0.020)), 0.012, False),           # nose
    ("head", "ell", ((0.050, 0.34, 0.058), (0.030, 0.030, 0.030)), 0.02, True),           # cheek
    ("head", "ell", ((0.074, 0.36, -0.004), (0.012, 0.030, 0.018)), 0.01, True),          # ear
    # ----------------------------------------------------------------- shoulders
    ("upperarm", "ell", ((0.010, 0.10, 0.000), (0.052, 0.090, 0.056)), 0.045, True),      # deltoid
    ("chest", "cone", ((0.040, 1.02, -0.012), (0.150, 0.90, -0.012), 0.032, 0.030), 0.04, True),  # trapezius
    # ----------------------------------------------------------------- knees (seated: rounder)
    ("thigh", "ell", ((0.0, 0.99, -0.004), (0.050, 0.052, 0.050)), 0.02, True),
    ("thigh", "ell", ((0.0, 0.96, 0.044), (0.026, 0.030, 0.014)), 0.02, True),            # kneecap
]


def _place(j, F, bone, p):
    """Bone-local (x, t, z) -> world (t = fraction of the bone length)."""
    _n, h, t, _par = BONE[bone]
    a, b = j[h], j[t]
    L = np.linalg.norm(b - a)
    x, tt, z = p
    return a + F[bone][0] * x + F[bone][1] * (tt * L) + F[bone][2] * z


def loft(j, F, table, side=None, rounds=(0.0, 0.0), band=0.05):
    """sdf.Loft through the stations of `table` (bones suffixed with side, x0 mirrored).  Its
    distances are exact up to about `band` off the surface (garments built far over it need more)."""
    sg = -1.0 if side == "R" else 1.0
    st = []
    for bone, t, sec in table:
        bn = f"{bone}.{side}" if side else bone
        d = dict(sec)
        d["x0"] = d.get("x0", 0.0) * sg
        d["p"] = _place(j, F, bn, (0.0, t, 0.0))
        d["Z"] = F[bn][2]
        st.append(d)
    left = F["pelvis"][0]
    return sdf.Loft(st, round0=rounds[0], round1=rounds[1], left=left, band=band)


def solids(j, F, table=None):
    """World-space sdf solids with their blend radii for joints j and frames F."""
    out = [(loft(j, F, TORSO, rounds=LOFT_ROUND["torso"]), 0.0)]
    for s in ("L", "R"):
        out.append((loft(j, F, ARM, s, LOFT_ROUND["arm"]), 0.035))
        out.append((loft(j, F, LEG, s, LOFT_ROUND["leg"]), 0.04))
    for bone, kind, prm, k, mirror in (table or SOLIDS):
        sides = [("L", 1.0), ("R", -1.0)] if mirror else [(None, 1.0)]
        for side, sg in sides:
            bn = f"{bone}.{side}" if side else bone
            if bn not in F:
                continue
            R = F[bn]

            def loc(p):
                return _place(j, F, bn, (p[0] * sg, p[1], p[2]))
            if kind == "ell":
                c, r = prm
                out.append((sdf.Ellipsoid(loc(c), r, R), k))
            elif kind == "cone":
                a, b, ra, rb = prm
                out.append((sdf.RoundCone(loc(a), loc(b), ra, rb), k))
            elif kind == "sel":
                c, r, n = prm
                out.append((sdf.SuperEllipsoid(loc(c), r, n, R), k))
            else:
                raise ValueError(kind)
    return out


def bounds(j, pad=0.16):
    P = np.array(list(j.values()))
    return P.min(0) - pad, P.max(0) + pad


def body_field(j, F, h=0.004, extra=()):
    """Field of the dressed body.  `extra`: more (solid, k, op) to combine afterwards."""
    lo, hi = bounds(j)
    f = sdf.Field(lo, hi, h)
    for s, k in solids(j, F):
        f.add(s, k)
    for s, k, op in extra:
        f.add(s, k, op)
    return f
