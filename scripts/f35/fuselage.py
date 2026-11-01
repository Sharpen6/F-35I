"""Fuselage outer mould line, DSI inlets and cockpit opening.

Shapes are driven by tables measured from the public 3-view drawing
(Wikimedia Commons "Lockheed Martin F-35I Adir 3-view drawing", CC BY-SA 4.0)
scaled to the published 15.67 m length - see docs/research.md.

Construction (all solids, combined with exact booleans)
-------------------------------------------------------
F  forebody  - upper dome + lower V / canted sides meeting at a sharp chine, nose -> s=6.
M  main body - 8-control-point sections (spine, shoulder, strake/chine edge,
               lower cowl side, flat belly, keel) from s=3.9 -> 14.3; aft of
               s ~12.8 the centre is drawn onto the nozzle shroud circle.
   F carries the diverterless (DSI) bumps: a broad bulge on each side below
   the chine, ahead of and inside the inlet (dsi_bump).
M -= front wedges   : three planes per side give the raked "<" inlet lip
U  = F + M
U -= duct cutters   : the aperture traced from the front-view drawings; the
                      inboard wall is the bump itself, the duct curves
                      inboard to the engine face
U -= cockpit tub cutter
U -= nozzle well    : sawtooth shroud edge round the nozzle; the stabilator
                      booms carry on beside it
"""
import math
import bmesh
import bpy
from mathutils import Vector

from .geom import P, Pchip, Table, mesh_object, loft_rings, boolean, Y0
from . import materials as M
from . import normals

# ---------------------------------------------------------------------------
# F: forebody sections with a sharp chine
#   s, zt (top centre), zb (keel), wc (chine half width), zc (chine z),
#   au  angle of the upper surface where it meets the chine (deg below horizontal)
#   xu, zu  a point the upper curve passes through, as fractions of wc and of
#           (zt - zc) above the chine; along the cockpit this is the canopy sill
#   xk, zk  lower corner (fractions of wc and of (zc - zb) above the keel):
#           on the chine-keel line at the radome (V underside), at keel level
#           further aft (canted side + flat belly)
#   fk  corner fillet (fraction of the shorter adjacent edge)
# Photos (head-on and 3/4 views, camera-matched) show the radome as an upper
# dome over a V-shaped underside, meeting at a sharp chine that rises from the
# tip and runs back into the inlet / strake edge.  Behind the canopy (s 4.6-6)
# the dome narrows to a ridge: the head-on photo shows no body above ~0.83 m
# at 0.6 m half-width there (edge overlay, data/camera_matches/c29.json).
# ---------------------------------------------------------------------------
FORE = Table(
    ["zt", "zb", "wc", "zc", "au", "xu", "zu", "xk", "zk", "fk"],
    [
        (0.000, 0.080, 0.080, 0.004, 0.080, 70.0, 0.700, 0.720, 0.53, 0.50, 0.60),
        (0.100, 0.128, 0.030, 0.065, 0.090, 70.0, 0.700, 0.720, 0.53, 0.50, 0.60),
        (0.200, 0.172, -0.017, 0.122, 0.100, 70.0, 0.700, 0.720, 0.53, 0.50, 0.60),
        (0.400, 0.245, -0.106, 0.212, 0.115, 70.0, 0.700, 0.720, 0.53, 0.50, 0.60),
        (0.600, 0.308, -0.195, 0.312, 0.130, 70.0, 0.700, 0.720, 0.53, 0.50, 0.60),
        (0.800, 0.351, -0.271, 0.388, 0.145, 70.0, 0.700, 0.720, 0.53, 0.50, 0.60),
        (1.000, 0.392, -0.345, 0.448, 0.160, 70.0, 0.700, 0.720, 0.53, 0.50, 0.60),
        (1.200, 0.430, -0.405, 0.497, 0.178, 70.0, 0.700, 0.720, 0.54, 0.48, 0.60),
        (1.400, 0.480, -0.460, 0.522, 0.194, 70.0, 0.700, 0.720, 0.57, 0.40, 0.70),
        (1.600, 0.552, -0.499, 0.542, 0.210, 70.0, 0.700, 0.720, 0.62, 0.30, 0.75),
        (1.850, 0.630, -0.534, 0.566, 0.235, 68.6, 0.700, 0.720, 0.67, 0.17, 0.70),
        (2.200, 0.680, -0.548, 0.610, 0.275, 64.9, 0.700, 0.720, 0.71, 0.06, 0.60),
        (2.600, 0.720, -0.560, 0.676, 0.320, 55.8, 0.612, 0.778, 0.72, 0.00, 0.45),
        (3.000, 0.765, -0.585, 0.722, 0.365, 56.0, 0.671, 0.708, 0.72, 0.00, 0.45),
        (3.400, 0.810, -0.605, 0.762, 0.405, 54.6, 0.681, 0.681, 0.72, 0.00, 0.45),
        (3.800, 0.860, -0.625, 0.812, 0.435, 53.3, 0.647, 0.732, 0.72, 0.00, 0.45),
        (4.200, 0.930, -0.645, 0.868, 0.455, 53.5, 0.599, 0.798, 0.72, 0.00, 0.45),
        (4.600, 1.040, -0.625, 0.890, 0.465, 42.0, 0.420, 0.870, 0.72, 0.00, 0.45),
        (5.000, 1.195, -0.640, 0.900, 0.470, 36.0, 0.280, 0.940, 0.72, 0.00, 0.45),
        (5.500, 1.150, -0.665, 0.860, 0.470, 36.0, 0.280, 0.890, 0.72, 0.00, 0.45),
        (6.000, 1.050, -0.700, 0.780, 0.470, 42.0, 0.320, 0.850, 0.72, 0.00, 0.45),
    ])
F_END = 6.0
# Behind the canopy the forebody's upper side sinks into the main body (it
# would otherwise stand ~0.1 m proud of it as a lobe with a crisp edge; the
# photos, e.g. c53, show the side behind the canopy flowing smoothly into the
# shoulder).  Between these stations it is blended toward the main-body
# surface, outboard of the canopy sill, and ends SINK_IN inside it.
SINK_S = (4.62, 5.30)
SINK_IN = 0.012
# ... and the main body, which is narrower there, is lifted to just inside the
# forebody's upper side as far aft as LIFT_S[0], relaxing to its own shape by
# LIFT_S[1]: so behind the canopy the side surface carries on aft and eases
# down into the shoulder instead of dropping off a ledge.
LIFT_S = (5.0, 5.8)
LIFT_GAP = 0.010
LIFT_K = 0.03                   # blend width of the smooth max (m)
CANOPY_SILL = ([4.40, 4.70, 4.97], [0.51, 0.48, 0.44])     # canopy.SILL_W aft end

# DSI bump.  The inboard side of each inlet aperture is no wall but the bump
# itself: a broad bulge on the forebody side below the chine, swelling from
# about s 3.0 to its crest just ahead of the lip and running on into the duct
# as its inboard wall (the cowl joins the body only above and below it).
# Front view (front drawings c25 / ref09 registered on an orthographic
# render, tools: review.ortho): the bump fills the inboard ~40 % of the
# aperture, its outline running from the top-inboard corner (~1.02, 0.42)
# out to x ~1.09 at z ~0.1-0.28 and back in to (~0.69, -0.40); photo c20
# shows it as one smooth swelling under the chine.
#   lateral offset (m) added to the forebody side by depth below the chine
BUMP_DEPTH = Pchip([0.0, 0.045, 0.066, 0.116, 0.186, 0.266, 0.366, 0.466, 0.566,
                    0.666, 0.766, 0.866, 0.94],
                   [0.0, 0.07, 0.10, 0.165, 0.22, 0.258, 0.285, 0.28, 0.255,
                    0.205, 0.11, 0.025, 0.0])
BUMP_S = (3.00, 4.40, 4.95, 5.80)       # rises from / full from / full to / gone by (in the duct)


def bump_extent(s):
    """0..1 how much of the bump the forebody section at s carries."""
    a, b, c, d = BUMP_S
    return _smooth(a, b, s) * (1.0 - _smooth(c, d, s))


def dsi_bump(s, depth):
    """Lateral offset of the forebody side at station s, `depth` m below the chine."""
    f = bump_extent(s)
    if f <= 0.0 or depth <= 0.0 or depth >= 0.94:
        return 0.0
    return f * BUMP_DEPTH(depth)


def _with_bump(s, lo):
    """Lower half-section (chine -> keel) with the bump added."""
    if bump_extent(s) <= 0.0:
        return lo
    zc = lo[0][1]
    pts = []
    for (x0, z0), (x1, z1) in zip(lo, lo[1:]):
        n = max(1, int(math.hypot(x1 - x0, z1 - z0) / 0.015))
        for i in range(n):
            t = i / n
            pts.append((x0 + (x1 - x0) * t, z0 + (z1 - z0) * t))
    pts.append(lo[-1])
    return [(x + dsi_bump(s, zc - z), z) for x, z in pts]

N_UP = 30               # samples on the upper half-section
N_LO = 26               # samples on the lower half-section

_HALF_CACHE = {}


def _filleted(pts, frac, n=24):
    """Polyline C -> K -> B with the corner at K rounded (quadratic Bezier)."""
    c, k, b = (Vector(p) for p in pts)
    d1, d2 = k - c, b - k
    t = frac * min(d1.length, d2.length)
    if t < 1e-6:
        return [tuple(c), tuple(k), tuple(b)]
    a0 = k - d1.normalized() * t
    a1 = k + d2.normalized() * t
    out = [tuple(c)]
    for i in range(n + 1):
        u = i / n
        q = a0 * (1 - u) ** 2 + k * 2 * u * (1 - u) + a1 * u * u
        out.append(tuple(q))
    out.append(tuple(b))
    return out


def fore_half(s):
    """Half-section of the forebody at station s.

    Returns (upper, lower): upper runs from the top centre to the chine,
    lower from the chine to the keel; both lists of (x, z) with x >= 0."""
    key = round(min(max(s, 0.0), F_END), 4)
    hit = _HALF_CACHE.get(key)
    if hit is not None:
        return hit
    up, lo, zt, zb = _fore_raw(key)
    up = _sink_into_main(key, up)
    up[0] = (0.0, zt)
    lo = _with_bump(key, lo)
    _HALF_CACHE[key] = (up, lo)
    return up, lo


_RAW_CACHE = {}


def _fore_raw(key):
    """Forebody half-section from the FORE table alone (no blending)."""
    hit = _RAW_CACHE.get(key)
    if hit is not None:
        return hit
    p = FORE(key)
    zt, zb, wc, zc = p["zt"], p["zb"], max(p["wc"], 1e-4), p["zc"]
    zt = max(zt, zc + 1e-4)
    zb = min(zb, zc - 1e-4)
    au = math.radians(p["au"])
    hu, hl = zt - zc, zc - zb
    up = hermite_spline([(0.0, zt), (p["xu"] * wc, zc + p["zu"] * hu), (wc, zc)], 40,
                        start_tangent=Vector((1.0, 0.0)),
                        end_tangent=Vector((math.cos(au), -math.sin(au))))
    lo = _filleted([(wc, zc), (p["xk"] * wc, zb + p["zk"] * hl), (0.0, zb)], p["fk"])
    up = [(max(0.0, v.x), v.y) for v in up]
    lo = [(max(0.0, x), z) for x, z in lo]
    up[0] = (0.0, zt)
    lo[-1] = (0.0, zb)
    _RAW_CACHE[key] = (up, lo, zt, zb)
    return _RAW_CACHE[key]


def _smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def _sill_half_width(s):
    ss, ws = CANOPY_SILL
    if s <= ss[0]:
        return ws[0]
    for (s0, w0), (s1, w1) in zip(zip(ss, ws), zip(ss[1:], ws[1:])):
        if s <= s1:
            return w0 + (w1 - w0) * (s - s0) / (s1 - s0)
    return ws[-1] * (1.0 - _smooth(ss[-1], ss[-1] + 0.28, s))


def _sink_into_main(s, up):
    """Blend the forebody upper curve toward the main body (see SINK_S)."""
    w = _smooth(SINK_S[0], SINK_S[1], s)
    if w <= 0.0:
        return up
    mu = main_upper(s)
    xs = _sill_half_width(s)
    out = []
    xt, st, zt = TIP
    for x, z in up:
        zm = _z_at_x(mu, x)
        if zm is None:
            out.append((x, z))
            continue
        g = _smooth(xs + 0.03, xs + 0.15, x)          # leave the canopy sill alone
        # outboard of x 0.55 the upper inlet-lip cutter removes the main body
        # ahead of its plane, so the forebody must stay on top until past it
        s_lip = st + LIP_A * (xt - x) + LIP_B * (z - zt)
        k = _smooth(0.50, 0.58, x)
        wl = w * (1.0 - k + k * _smooth(s_lip, s_lip + 0.10, s))
        tgt = min(z, zm - SINK_IN)
        out.append((x, z + (tgt - z) * wl * g))
    return out


def _z_at_x(poly, x):
    best = None
    for (x0, z0), (x1, z1) in zip(poly, poly[1:]):
        if (x0 - x) * (x1 - x) <= 0 and abs(x1 - x0) > 1e-9:
            z = z0 + (x - x0) / (x1 - x0) * (z1 - z0)
            best = z if best is None else max(best, z)
    return best


def _x_at_z(poly, z):
    best = None
    for (x0, z0), (x1, z1) in zip(poly, poly[1:]):
        if (z0 - z) * (z1 - z) <= 0 and abs(z1 - z0) > 1e-9:
            x = x0 + (z - z0) / (z1 - z0) * (x1 - x0)
            best = x if best is None else max(best, x)
    return best


def fore_x_at(s, z):
    """Forebody half width at height z."""
    up, lo = fore_half(min(s, F_END))
    zt, zc, zb = up[0][1], up[-1][1], lo[-1][1]
    if z >= zt or z <= zb:
        return 0.0
    x = _x_at_z(up if z >= zc else lo, z)
    return 0.0 if x is None else x


def fore_upper_z(s, x):
    """Height of the forebody upper surface at half width x."""
    up, _ = fore_half(min(s, F_END))
    best = None
    for (x0, z0), (x1, z1) in zip(up, up[1:]):
        if (x0 - x) * (x1 - x) <= 0 and abs(x1 - x0) > 1e-9:
            z = z0 + (x - x0) / (x1 - x0) * (z1 - z0)
            best = z if best is None else max(best, z)
    return up[-1][1] if best is None else best


# ---------------------------------------------------------------------------
# M: main body control points  station -> (x, z)
# ---------------------------------------------------------------------------
M_START, M_END = 3.90, 14.30
Q_ROWS = {
    # Q0 top centre / spine (kept inside F ahead of the canopy rear frame)
    0: [(3.90, (0.0, 0.50)), (4.30, (0.0, 0.66)), (4.60, (0.0, 0.86)),
        (4.85, (0.0, 1.13)), (5.10, (0.0, 1.245)), (5.40, (0.0, 1.26)),
        (6.00, (0.0, 1.215)), (6.60, (0.0, 1.16)), (7.50, (0.0, 1.14)),
        (8.50, (0.0, 1.11)), (9.50, (0.0, 1.08)), (10.5, (0.0, 1.05)),
        (11.5, (0.0, 1.02)), (12.2, (0.0, 0.99)), (12.8, (0.0, 0.90)),
        (13.05, (0.0, 0.82)), (13.3, (0.0, 0.73)), (13.6, (0.0, 0.725)),
        (14.3, (0.0, 0.725))],
    # Q1 spine shoulder: a narrow ridge behind the canopy (photo-matched
    # head-on view: nothing of the spine shows outside the canopy outline)
    1: [(3.90, (0.32, 0.46)), (4.30, (0.32, 0.60)), (4.60, (0.30, 0.80)),
        (5.10, (0.27, 1.15)), (5.40, (0.26, 1.16)), (6.00, (0.26, 1.12)),
        (7.00, (0.29, 1.07)), (9.00, (0.34, 1.02)), (11.0, (0.38, 0.96)),
        (12.2, (0.40, 0.93)), (12.8, (0.38, 0.84)), (13.05, (0.35, 0.78)),
        (13.3, (0.30, 0.65)), (13.6, (0.29, 0.645)), (14.3, (0.29, 0.645))],
    # Q2 foot of the spine; nearly flat out to the inlet shoulder.  ~0.1 m
    # lower than the 3-view: the camera-matched head-on photo shows the
    # upper body beside the canopy that much lower
    2: [(3.90, (0.58, 0.44)), (4.30, (0.60, 0.60)), (4.60, (0.62, 0.69)),
        (5.10, (0.63, 0.71)), (5.60, (0.68, 0.70)), (6.50, (0.74, 0.68)),
        (8.00, (0.80, 0.68)), (10.0, (0.84, 0.67)), (11.5, (0.84, 0.665)),
        (12.4, (0.80, 0.64)), (13.0, (0.74, 0.61)), (13.3, (0.64, 0.53)),
        (13.6, (0.54, 0.40)), (14.0, (0.52, 0.36)), (14.3, (0.52, 0.30))],
    # Aft of s ~12.8 the body converges onto the nozzle shroud (s 13.3): above
    # and below the nozzle the section is drawn onto the shroud circle
    # (_shroud_blend) and cut away behind the teeth; beside the nozzle only
    # the stabilator booms carry on (Q2-Q6), their inner faces hugging the
    # nozzle, as in the JASDF F-35A rear photos (references/nozzle).  The boom
    # ends taper (s 14.0-14.3) to a thin edge round the stabilator root.
    # Near the inlet lip the cowl hugs the aperture (lips ~4 cm thick, as on
    # the front drawings and photo c29) and flares out behind it: the cowl's
    # top, outboard side and lower corner ramp out to the full body by s ~5.6
    # (Q3-Q6), so its outer faces show from the front around the lip.
    # Q3 shoulder top above the inlet
    #    (back to full height by s 5.05: the gun lies under it, details.build_gun)
    3: [(3.90, (1.25, 0.33)), (4.45, (1.27, 0.335)), (4.75, (1.29, 0.45)),
        (5.05, (1.32, 0.52)), (5.20, (1.33, 0.53)), (6.00, (1.40, 0.565)), (7.00, (1.44, 0.59)), (7.50, (1.45, 0.60)), (9.50, (1.44, 0.585)),
        (11.0, (1.40, 0.575)), (12.0, (1.40, 0.565)), (13.0, (1.37, 0.54)), (13.6, (1.32, 0.47)),
        (14.0, (1.30, 0.43)), (14.3, (1.22, 0.31))],
    # Q4 strake / chine edge (sharp)
    #    (forward-most at the lip tip TIP: side drawing and photo c28 put it
    #    ~0.1 m above the nose tip)
    4: [(3.90, (1.49, 0.195)), (4.28, (1.50, 0.20)), (4.70, (1.55, 0.235)),
        (5.20, (1.625, 0.28)), (5.80, (1.70, 0.31)), (6.60, (1.76, 0.32)), (7.50, (1.80, 0.31)), (9.00, (1.82, 0.30)), (12.0, (1.86, 0.27)),
        (12.5, (1.74, 0.26)), (13.0, (1.60, 0.25)), (13.5, (1.49, 0.24)),
        (14.0, (1.42, 0.23)), (14.3, (1.33, 0.22))],
    # Q5 lower outboard side of the cowl
    5: [(3.90, (1.20, -0.50)), (4.65, (1.22, -0.51)), (5.20, (1.36, -0.47)),
        (5.60, (1.45, -0.445)), (6.20, (1.54, -0.43)), (7.00, (1.59, -0.42)),
        (9.50, (1.59, -0.41)), (11.5, (1.52, -0.39)), (12.4, (1.32, -0.35)),
        (12.8, (1.22, -0.27)), (13.3, (1.16, -0.12)), (13.6, (1.14, 0.03)),
        (14.0, (1.10, 0.08)), (14.3, (1.05, 0.15))],
    # Q6 bottom outboard corner of the flat belly.  Belly ~0.08 m higher than
    # the 3-view: camera-matched side and head-on photos show more daylight
    # between belly and wheels
    6: [(3.90, (1.15, -0.60)), (4.65, (1.16, -0.60)), (5.20, (1.29, -0.625)),
        (5.60, (1.30, -0.665)),
        (6.20, (1.24, -0.73)), (6.80, (1.20, -0.77)), (10.5, (1.19, -0.775)),
        (11.5, (1.14, -0.78)), (12.2, (1.08, -0.745)), (12.6, (0.92, -0.62)),
        (13.0, (0.68, -0.43)), (13.3, (0.46, -0.27)), (13.6, (0.50, -0.05)),
        (14.0, (0.52, 0.0)), (14.3, (0.52, 0.14))],
    # Q7 keel (inside F ahead of s~5.1)
    7: [(3.90, (0.0, -0.565)), (4.60, (0.0, -0.60)), (5.40, (0.0, -0.655)),
        (6.20, (0.0, -0.725)), (6.80, (0.0, -0.78)), (10.4, (0.0, -0.785)),
        (11.0, (0.0, -0.85)), (11.4, (0.0, -0.875)), (11.9, (0.0, -0.835)),
        (12.4, (0.0, -0.75)), (12.9, (0.0, -0.62)), (13.3, (0.0, -0.485)),
        (13.6, (0.0, -0.48)), (14.3, (0.0, -0.48))],
}

_QT = None


def _q_tables():
    global _QT
    if _QT is None:
        _QT = []
        for k in range(8):
            rows = Q_ROWS[k]
            st = [r[0] for r in rows]
            _QT.append((Pchip(st, [r[1][0] for r in rows]),
                        Pchip(st, [r[1][1] for r in rows])))
    return _QT


def q_points(s):
    pts = [(fx(s), fz(s)) for fx, fz in _q_tables()]
    pts[0] = (0.0, pts[0][1])
    pts[7] = (0.0, pts[7][1])
    return pts


def body_half_width(s, z):
    """Approximate outer half-width of the main body at (s, z) (for fitting)."""
    q = q_points(s)
    best = 0.0
    for i in range(7):
        (x0, z0), (x1, z1) = q[i], q[i + 1]
        if (z0 - z) * (z1 - z) <= 0 and abs(z1 - z0) > 1e-6:
            t = (z - z0) / (z1 - z0)
            best = max(best, x0 + t * (x1 - x0))
    return best


# ---------------------------------------------------------------------------
# Curve sampling helpers
# ---------------------------------------------------------------------------
def hermite_spline(points, samples_per_seg=12, start_tangent=None, end_tangent=None):
    pts = [Vector((p[0], p[1])) for p in points]
    n = len(pts)
    tans = []
    for i in range(n):
        if i == 0:
            t = start_tangent if start_tangent is not None else (pts[1] - pts[0])
        elif i == n - 1:
            t = end_tangent if end_tangent is not None else (pts[-1] - pts[-2])
        else:
            a = (pts[i] - pts[i - 1])
            b = (pts[i + 1] - pts[i])
            t = a.normalized() * b.length + b.normalized() * a.length if a.length > 1e-9 and b.length > 1e-9 else (pts[i + 1] - pts[i - 1])
        tans.append(Vector(t))
    out = []
    for i in range(n - 1):
        p0, p1 = pts[i], pts[i + 1]
        seg = (p1 - p0).length
        m0 = tans[i].normalized() * seg if tans[i].length > 1e-9 else Vector((0, 0))
        m1 = tans[i + 1].normalized() * seg if tans[i + 1].length > 1e-9 else Vector((0, 0))
        for j in range(samples_per_seg):
            t = j / samples_per_seg
            t2, t3 = t * t, t * t * t
            out.append(p0 * (2 * t3 - 3 * t2 + 1) + m0 * (t3 - 2 * t2 + t)
                       + p1 * (-2 * t3 + 3 * t2) + m1 * (t3 - t2))
    out.append(pts[-1])
    return out


def resample(poly, n):
    d = [0.0]
    for i in range(1, len(poly)):
        d.append(d[-1] + (poly[i] - poly[i - 1]).length)
    total = d[-1]
    if total < 1e-9:
        return [poly[0].copy() for _ in range(n)]
    out, j = [], 0
    for i in range(n):
        target = total * i / (n - 1)
        while j < len(d) - 2 and d[j + 1] < target:
            j += 1
        seg = d[j + 1] - d[j]
        t = 0 if seg < 1e-12 else (target - d[j]) / seg
        out.append(poly[j].lerp(poly[j + 1], t))
    return out


def _ring_from_half(s, up, lo):
    half = up + lo[1:]
    ring = [P(s, v.x, v.y) for v in half]
    mirror = [P(s, -v.x, v.y) for v in reversed(half[1:-1])]
    return ring + mirror


def fore_ring(s):
    up, lo = fore_half(s)
    up = [Vector(p) for p in up]
    lo = [Vector(p) for p in lo]
    return _ring_from_half(s, resample(up, N_UP + 1), resample(lo, N_LO + 1))


def main_upper(s):
    """Upper half of the main-body section at s: (x, z) from the top centre
    out to the strake edge (the same curve main_ring lofts)."""
    q = q_points(s)
    pts = [(v.x, v.y) for v in hermite_spline(q[0:5], 16, start_tangent=Vector((1, 0)))]
    w = 1.0 - _smooth(LIFT_S[0], LIFT_S[1], s)
    if w > 0.0 and s <= F_END:
        fu = _fore_raw(round(min(max(s, 0.0), F_END), 4))[0]
        wc = fu[-1][0]
        lifted = []
        for x, z in pts:
            zf = _z_at_x(fu, x)
            if zf is None:
                lifted.append((x, z))
                continue
            a, b = z, zf - LIFT_GAP
            smax = 0.5 * (a + b + math.sqrt((a - b) ** 2 + LIFT_K ** 2))   # smooth max: no crease
            fade = 1.0 - _smooth(wc - 0.20, wc - 0.02, x)                  # none at the chine
            lifted.append((x, z + (smax - z) * w * fade))
        pts = lifted
    return pts


def main_ring(s):
    q = q_points(s)
    up = _shroud_blend(s, main_upper(s))
    lo = _shroud_blend(s, hermite_spline(q[4:8], 16, end_tangent=Vector((-1, 0))))
    up = [Vector(p) for p in up]
    lo = [Vector(p) for p in lo]
    return _ring_from_half(s, resample(up, N_UP + 1), resample(lo, N_LO + 1))


def _stations(a, b, spacing):
    st, s = [], a
    while s < b - 1e-6:
        st.append(s)
        s += spacing(s)
    st.append(b)
    return st


def _fix_normals(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()


def build_forebody(collection):
    def sp(s):
        return 0.02 if s < 0.3 else (0.05 if s < 4.0 else 0.06)
    st = _stations(0.0, F_END, sp)
    rings = [fore_ring(s) for s in st[1:]]
    n = len(rings[0])
    verts, faces = loft_rings(rings, True, False, True)
    tip = len(verts)
    verts.append(P(0.0, 0.0, FORE(0.0)["zc"]))
    for j in range(n):
        faces.append((tip, (j + 1) % n, j))
    ob = mesh_object("Fuselage", verts, faces, collection, M.get("skin"))
    _fix_normals(ob)
    return ob


def build_main(collection):
    def sp(s):
        return 0.05 if s < 7.5 else (0.09 if s < 12.0 else 0.05)
    st = _stations(M_START, M_END, sp)
    rings = [main_ring(s) for s in st]
    verts, faces = loft_rings(rings, True, True, True)
    ob = mesh_object("MainBody", verts, faces, collection, M.get("skin"))
    _fix_normals(ob)
    return ob


# ---------------------------------------------------------------------------
# Raked inlet lip: three planes per side  (s = station, x = |half-width|)
# ---------------------------------------------------------------------------
TIP = (1.495, 4.28, 0.20)           # forward-most point of the cowl (x, s, z): top-outboard corner
LIP_A, LIP_B = 0.69, 0.168          # upper lip plane slopes (lip meets the chine at s~4.75)
LIP_C, LIP_D = 0.20, 0.45           # lower lip plane slopes (outer edge sweeps back going down)
LIP_E = 1.58                        # outboard cowl flare


def lip_station(x, z):
    xt, st, zt = TIP
    su = st + LIP_A * (xt - x) + LIP_B * (z - zt)
    sl = st + LIP_C * (xt - x) + LIP_D * (zt - z)
    so = st + LIP_E * (x - xt)
    return max(su if z >= zt else -1e9, sl if z < zt else -1e9, so)


def _clipped_box(name, collection, planes, xr):
    """Box clipped by several half-spaces (keeps the side behind each normal).

    planes: list of (normal, point) in (x, s, z) station space.
    """
    s0, s1 = 2.0, 7.5
    z0, z1 = -1.6, 2.2
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x = xr[0] if v.co.x < 0 else xr[1]
        v.co.y = (s0 if v.co.y < 0 else s1) - Y0
        v.co.z = z0 if v.co.z < 0 else z1
    for normal, point in planes:
        pco = Vector((point[0], point[1] - Y0, point[2]))
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=pco,
                               plane_no=Vector(normal), clear_outer=True)
        edges = [e for e in bm.edges if e.is_boundary]
        if edges:
            bmesh.ops.contextual_create(bm, geom=edges)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    me.materials.append(M.get("skin"))
    return ob


def lip_cutters(collection):
    xt, st, zt = TIP
    out = []
    for side in (1, -1):
        xr = (0.55, 3.2) if side > 0 else (-3.2, -0.55)
        # upper plane:  s + a x - b z = const  -> normal (a, 1, -b)
        out.append(_clipped_box(f"LipU_{side}", collection,
                                [((LIP_A * side, 1.0, -LIP_B), (xt * side, st, zt))], xr))
        # outboard flare: s - e x = const -> normal (-e, 1, 0)
        out.append(_clipped_box(f"LipO_{side}", collection,
                                [((-LIP_E * side, 1.0, 0.0), (xt * side, st, zt))], xr))
    # lower plane, both sides in one convex "V" piece (continues across the
    # belly between the two inlets)
    out.append(_clipped_box("LipL", collection,
                            [((LIP_C, 1.0, LIP_D), (xt, st, zt)),
                             ((-LIP_C, 1.0, LIP_D), (-xt, st, zt))], (-3.2, 3.2)))
    return out


# ---------------------------------------------------------------------------
# Duct cutter: the aperture, its inboard wall on the bump
# ---------------------------------------------------------------------------
# Aperture traced from the front drawings (c25 / ref09: dark region, model
# coordinates): the top edge falls from the bump (1.02, 0.42) to the
# top-outboard corner (1.46, 0.19); the outboard wall cants in along
# x = 1.387 + 0.44 z to (1.18, -0.475); the floor is flat.
APERTURE = [
    (1.000, 0.430), (1.100, 0.380), (1.200, 0.330), (1.300, 0.280), (1.400, 0.230),
    (1.440, 0.208), (1.461, 0.186), (1.463, 0.160), (1.444, 0.110), (1.387, 0.000),
    (1.343, -0.100), (1.299, -0.200), (1.255, -0.300), (1.211, -0.400), (1.192, -0.445),
    (1.172, -0.471), (1.140, -0.482), (1.000, -0.482), (0.800, -0.482),
]
DUCT_GAP = 0.006        # inboard wall just outside the forebody: the bump runs on into the duct
DUCT_WALL_Z = [-0.482, -0.45, -0.40, -0.35, -0.30, -0.25, -0.20, -0.15, -0.10, -0.05,
               0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.39, 0.43]


def _duct_section(s, side):
    """Closed duct polygon (x, z) at station s (x positive = this side).

    The aperture as far aft as s 5.25, then the duct shrinks and turns
    inboard toward the engine face; the inboard wall is the forebody side
    with its bump (DUCT_GAP outside it)."""
    t = max(0.0, min(1.0, (s - 5.25) / 1.75))
    tt = t * t * (3 - 2 * t)
    zc, xc = 0.05, 1.10
    sc = 1.0 - 0.30 * tt
    shift = 0.38 * tt

    def place(x, z):
        return xc + (x - xc) * sc - shift, zc + (z - zc) * sc - 0.08 * tt
    pts = [place(x, z) for x, z in APERTURE]
    inner = [place(fore_x_at(min(s, 5.2), z) + DUCT_GAP, z) for z in DUCT_WALL_Z]
    # polygon: top-inboard -> aperture (top edge, outboard wall, floor) -> inboard wall up
    poly = [inner[-1]] + pts + inner[:-1]
    return [(x * side, z) for x, z in poly]


def build_duct_cutter(collection, side=1):
    # dense where the inboard wall follows the bump (it must stay outside the
    # forebody between stations, within DUCT_GAP)
    st = [round(3.2 + 0.1 * i, 2) for i in range(29)] + [6.2, 6.4, 6.6, 6.8, 7.0]
    rings = []
    for s in st:
        sec = _duct_section(s, side)
        rings.append([P(s, x, z) for x, z in sec])
    verts, faces = loft_rings(rings, True, False, False)
    ob = mesh_object(f"DuctCutter_{'L' if side > 0 else 'R'}", verts, faces,
                     collection, M.get("intake"), smooth=True)
    me = ob.data
    me.materials.append(M.get("intake_dark"))
    # end caps: the sections are not star-shaped round their centroid (the
    # bump bulges into them), so a centre fan would fold over itself and
    # break the exact boolean; fill them as n-gons and ear-clip instead
    bm = bmesh.new()
    bm.from_mesh(me)
    y0 = min(v.co.y for v in bm.verts)
    bnd = [e for e in bm.edges if e.is_boundary]
    start = [e for e in bnd if abs(e.verts[0].co.y - y0) < 1e-6]
    end = [e for e in bnd if abs(e.verts[0].co.y - y0) >= 1e-6]
    caps = bmesh.ops.contextual_create(bm, geom=start)["faces"]
    far = bmesh.ops.contextual_create(bm, geom=end)["faces"]
    for f in far:
        f.material_index = 1            # the far end (engine face, behind the S-bend) is dark
    bmesh.ops.triangulate(bm, faces=caps + far, quad_method='BEAUTY', ngon_method='EAR_CLIP')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    return ob


NOZ_Z = 0.12            # engine / nozzle axis height
NOZ_SHROUD_S = 13.30    # aft fuselage shroud edge (serrated): tooth roots
NOZ_TOOTH = 0.05        # tooth depth (photos: ~60 teeth round the nozzle, ~6 cm pitch)
NOZ_TEETH = 60          # teeth round the shroud
NOZ_SKIN_R = 0.596      # shroud skin radius about the nozzle axis (outer flap roots r 0.58-0.586)
NOZ_CUT_R = 0.606       # behind the teeth everything inside this radius is cut away
NOZ_CORE = (12.92, 0.555)              # engine bay opened from here (flame holder shows)
SHROUD_BLEND = (12.45, NOZ_SHROUD_S)   # the section centre is drawn onto the shroud circle
# angles about the nozzle axis left to the booms: from, to, lower ramp, upper ramp (deg).  The upper
# ramp is wide: a narrow one (48-62 deg) left a ridge on the deck ahead of the shroud, half a metre
# out from the centre line, where the centre was drawn down onto the shroud and the side was not.
BOOM_SECTOR = (-15.0, 30.0, 14.0, 30.0)


def _shroud_blend(s, pts):
    """Draw the centre of a main-body half-section (above and below the
    nozzle) onto the shroud circle round the nozzle axis; the boom sectors
    beside the nozzle are left alone.  Behind the teeth the centre is cut away
    (build_nozzle_well_cutter), so the skin ends in teeth just outside the
    nozzle flap roots, as on the real aircraft (references/nozzle)."""
    w = _smooth(SHROUD_BLEND[0], SHROUD_BLEND[1], s)
    out = []
    a0, a1, ramp_lo, ramp_up = BOOM_SECTOR
    for p in pts:
        x, z = p[0], p[1]
        dz = z - NOZ_Z
        r = math.hypot(x, dz)
        if w <= 0.0 or r < 1e-6:
            out.append((x, z))
            continue
        th = math.degrees(math.atan2(dz, x))
        m = max(_smooth(a1, a1 + ramp_up, th), 1.0 - _smooth(a0 - ramp_lo, a0, th))
        rn = r + (NOZ_SKIN_R - r) * w * m
        out.append((x * rn / r, NOZ_Z + dz * rn / r))
    return out


def build_nozzle_well_cutter(collection):
    """Opens the aft body round the nozzle so it stands free.

    A solid of revolution about the nozzle axis: everything inside NOZ_CUT_R
    behind a sawtooth face (NOZ_TEETH teeth round the axis, roots at
    NOZ_SHROUD_S) goes.  The skin drawn onto the shroud circle (inside that
    radius) so ends in aft-pointing teeth all round, while the booms beside
    the nozzle keep a concave inner face that hugs it (photos: the boom
    overhangs the nozzle side).  A narrower core (NOZ_CORE) reaches forward
    to the augmentor, so the flame holder and turbine show through the
    nozzle."""
    n = 2 * NOZ_TEETH
    s_core, r_core = NOZ_CORE
    s_back = 16.5
    bm = bmesh.new()
    a, b, c, d = [], [], [], []
    for j in range(n):
        th = 2.0 * math.pi * j / n
        ct, sn = math.cos(th), math.sin(th)
        sf = NOZ_SHROUD_S + (NOZ_TOOTH if j % 2 else 0.0)
        a.append(bm.verts.new(P(s_core, r_core * ct, NOZ_Z + r_core * sn)))
        b.append(bm.verts.new(P(sf, r_core * ct, NOZ_Z + r_core * sn)))
        c.append(bm.verts.new(P(sf, NOZ_CUT_R * ct, NOZ_Z + NOZ_CUT_R * sn)))
        d.append(bm.verts.new(P(s_back, NOZ_CUT_R * ct, NOZ_Z + NOZ_CUT_R * sn)))
    cf = bm.verts.new(P(s_core, 0.0, NOZ_Z))
    cb = bm.verts.new(P(s_back, 0.0, NOZ_Z))
    inner, teeth = [], []
    for j in range(n):
        k = (j + 1) % n
        inner.append(bm.faces.new((cf, a[k], a[j])))
        inner.append(bm.faces.new((a[j], a[k], b[k], b[j])))
        teeth.append(bm.faces.new((b[j], b[k], c[k], c[j])))
        bm.faces.new((c[j], c[k], d[k], d[j]))
        bm.faces.new((cb, d[j], d[k]))
    for f in inner:
        f.material_index = 1
    # the tooth flanks are twisted quads: split them so the cut is exact
    bmesh.ops.triangulate(bm, faces=teeth, quad_method='BEAUTY', ngon_method='BEAUTY')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("NozzleWellCutter")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("NozzleWellCutter", me)
    collection.objects.link(ob)
    me.materials.append(M.get("skin"))          # tooth edges and the booms' inner faces
    me.materials.append(M.get("nozzle_in"))     # inside the engine bay
    return ob


COCKPIT_FOOT = [(1.98, 0.04), (2.10, 0.16), (2.40, 0.31), (2.80, 0.41),     # (s, half-width)
                (3.20, 0.46), (3.60, 0.48), (4.00, 0.48), (4.40, 0.46),
                (4.75, 0.42), (4.92, 0.34)]


def cockpit_half_width(s):
    """Half-width of the cockpit opening at station s (linear in COCKPIT_FOOT)."""
    f = COCKPIT_FOOT
    if s <= f[0][0]:
        return f[0][1]
    for (s0, w0), (s1, w1) in zip(f, f[1:]):
        if s <= s1:
            return w0 + (w1 - w0) * (s - s0) / (s1 - s0)
    return f[-1][1]


def build_cockpit_cutter(collection):
    """Cockpit tub cutter: canopy footprint extruded down to the floor."""
    foot = COCKPIT_FOOT
    top = 1.8
    pts = [(s, w) for s, w in foot] + [(s, -w) for s, w in reversed(foot)]
    ring_top = [P(s, w, top) for s, w in pts]
    ring_bot = [P(s, w * 0.92, 0.0 + 0.06 * (s - 2.0)) for s, w in pts]
    verts, faces = loft_rings([ring_bot, ring_top], True, True, True)
    ob = mesh_object("CockpitCutter", verts, faces, collection,
                     M.get("cockpit"), smooth=False)
    _fix_normals(ob)
    return ob


def build(collection, helpers):
    fus = build_forebody(collection)
    main = build_main(collection)
    for c in lip_cutters(helpers):
        boolean(main, c, 'DIFFERENCE', apply=True)
        bpy.data.objects.remove(c)
    normals.capture("Fuselage", [fus, main])      # smooth source lofts (clean seam shading)
    boolean(fus, main, 'UNION', apply=True)
    bpy.data.objects.remove(main)
    for side in (1, -1):
        cut = build_duct_cutter(helpers, side)
        boolean(fus, cut, 'DIFFERENCE', apply=True)
        bpy.data.objects.remove(cut)
    ck = build_cockpit_cutter(helpers)
    boolean(fus, ck, 'DIFFERENCE', apply=True)
    bpy.data.objects.remove(ck)
    nw = build_nozzle_well_cutter(helpers)
    boolean(fus, nw, 'DIFFERENCE', apply=True)
    bpy.data.objects.remove(nw)
    normals.apply(fus, "Fuselage")                 # also redone after the bay cuts
    return fus
