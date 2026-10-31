"""Fuselage outer mould line, DSI inlets and cockpit opening.

Shapes are driven by tables measured from the public 3-view drawing
(Wikimedia Commons "Lockheed Martin F-35I Adir 3-view drawing", CC BY-SA 4.0)
scaled to the published 15.67 m length - see docs/research.md.

Construction (all solids, combined with exact booleans)
-------------------------------------------------------
F  forebody  - super-ellipse sections with the F-35 nose chine, nose -> s=6.
M  main body - 8-control-point sections (spine, shoulder, strake/chine edge,
               lower cowl side, flat belly, keel) from s=3.9 -> 13.55.
M -= front wedges   : three planes per side give the raked "<" inlet lip
U  = F + M
U -= duct cutters   : trapezoidal aperture with a diverterless (DSI) bump on
                      the inboard wall, curving inboard to the engine face
U -= cockpit tub cutter
"""
import math
import bmesh
import bpy
from mathutils import Vector

from .geom import P, Pchip, Table, mesh_object, loft_rings, boolean, Y0
from . import materials as M

# ---------------------------------------------------------------------------
# F: forebody super-ellipse table
#   s, zt (top centre), zb (keel), wc (chine half width), zc (chine z),
#   mu, nu (upper exponents), ml, nl (lower exponents)
# ---------------------------------------------------------------------------
FORE = Table(
    ["zt", "zb", "wc", "zc", "mu", "nu", "ml", "nl"],
    [
        (0.00, 0.000, 0.000, 0.004, 0.00, 2.0, 1.10, 2.0, 1.20),
        (0.10, 0.050, -0.050, 0.065, 0.00, 2.0, 1.12, 2.0, 1.20),
        (0.20, 0.098, -0.095, 0.122, 0.00, 2.0, 1.15, 2.0, 1.25),
        (0.40, 0.186, -0.180, 0.212, 0.00, 2.0, 1.18, 2.0, 1.30),
        (0.60, 0.268, -0.262, 0.312, 0.00, 2.0, 1.20, 2.1, 1.35),
        (0.80, 0.330, -0.330, 0.388, 0.00, 2.1, 1.22, 2.2, 1.40),
        (1.00, 0.386, -0.395, 0.448, 0.01, 2.2, 1.25, 2.3, 1.45),
        (1.20, 0.430, -0.445, 0.497, 0.02, 2.3, 1.28, 2.4, 1.50),
        (1.40, 0.480, -0.490, 0.522, 0.03, 2.4, 1.30, 2.5, 1.55),
        (1.60, 0.552, -0.520, 0.542, 0.04, 2.5, 1.35, 2.6, 1.60),
        (1.85, 0.630, -0.545, 0.566, 0.05, 2.7, 1.45, 2.7, 1.65),
        (2.20, 0.680, -0.550, 0.610, 0.06, 3.0, 1.60, 2.8, 1.70),
        (2.60, 0.720, -0.560, 0.676, 0.08, 3.1, 1.65, 2.9, 1.75),
        (3.00, 0.765, -0.585, 0.722, 0.10, 3.2, 1.70, 3.0, 1.80),
        (3.40, 0.810, -0.605, 0.762, 0.11, 3.2, 1.70, 3.0, 1.80),
        (3.80, 0.860, -0.625, 0.812, 0.12, 3.2, 1.70, 3.1, 1.85),
        (4.20, 0.930, -0.645, 0.868, 0.13, 3.2, 1.70, 3.2, 1.90),
        (4.60, 1.040, -0.660, 0.890, 0.14, 3.2, 1.70, 3.2, 1.90),
        (5.00, 1.195, -0.675, 0.900, 0.15, 3.0, 1.70, 3.2, 1.90),
        (5.50, 1.150, -0.680, 0.860, 0.15, 2.8, 1.70, 3.2, 1.90),
        (6.00, 1.050, -0.690, 0.780, 0.15, 2.6, 1.70, 3.0, 1.90),
    ])
F_END = 6.0

N_UP = 30               # samples on the upper half-section
N_LO = 26               # samples on the lower half-section


def fore_point(s, theta):
    """Super-ellipse point on the forebody at parameter theta (0=top, pi=keel)."""
    p = FORE(s)
    if theta <= math.pi / 2:
        st, ct = math.sin(theta), math.cos(theta)
        x = p["wc"] * (max(st, 0) ** (2.0 / p["mu"]))
        z = p["zc"] + (p["zt"] - p["zc"]) * (max(ct, 0) ** (2.0 / p["nu"]))
    else:
        st, ct = math.sin(theta), -math.cos(theta)
        x = p["wc"] * (max(st, 0) ** (2.0 / p["ml"]))
        z = p["zc"] - (p["zc"] - p["zb"]) * (max(ct, 0) ** (2.0 / p["nl"]))
    return (x, z)


def fore_x_at(s, z):
    """Forebody half width at height z."""
    p = FORE(min(s, F_END))
    if z >= p["zc"]:
        t = min(1.0, (z - p["zc"]) / max(1e-6, p["zt"] - p["zc"]))
        return p["wc"] * max(0.0, 1 - t ** p["nu"]) ** (1 / p["mu"])
    t = min(1.0, (p["zc"] - z) / max(1e-6, p["zc"] - p["zb"]))
    return p["wc"] * max(0.0, 1 - t ** p["nl"]) ** (1 / p["ml"])


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
        (13.25, (0.0, 0.78)), (13.6, (0.0, 0.66)), (14.0, (0.0, 0.53)),
        (14.3, (0.0, 0.46))],
    # Q1 spine shoulder
    1: [(3.90, (0.36, 0.46)), (4.30, (0.36, 0.60)), (4.60, (0.36, 0.80)),
        (5.10, (0.36, 1.17)), (5.40, (0.36, 1.19)), (6.00, (0.36, 1.15)),
        (7.00, (0.38, 1.08)), (9.00, (0.40, 1.03)), (11.0, (0.40, 0.97)),
        (12.2, (0.40, 0.93)), (12.8, (0.38, 0.84)), (13.25, (0.37, 0.74)),
        (13.6, (0.38, 0.63)), (14.0, (0.42, 0.52)), (14.3, (0.46, 0.46))],
    # Q2 valley between the spine and the inlet shoulder
    2: [(3.90, (0.58, 0.44)), (4.30, (0.62, 0.62)), (4.60, (0.66, 0.78)),
        (5.10, (0.74, 0.86)), (5.60, (0.80, 0.86)), (6.50, (0.84, 0.82)),
        (8.00, (0.86, 0.79)), (10.0, (0.86, 0.76)), (11.5, (0.84, 0.73)),
        (12.4, (0.80, 0.68)), (13.0, (0.74, 0.63)), (13.6, (0.72, 0.57)),
        (14.3, (0.74, 0.47))],
    # Q3 shoulder top above the inlet
    3: [(3.90, (1.40, 0.675)), (5.20, (1.42, 0.705)), (6.00, (1.44, 0.70)),
        (7.50, (1.45, 0.67)), (9.50, (1.44, 0.64)), (11.0, (1.40, 0.62)),
        (12.0, (1.40, 0.60)), (13.0, (1.37, 0.56)), (13.6, (1.33, 0.51)),
        (14.0, (1.31, 0.47)), (14.3, (1.25, 0.42))],
    # Q4 strake / chine edge (sharp)
    4: [(3.90, (1.74, 0.345)), (5.20, (1.74, 0.35)), (6.00, (1.76, 0.34)),
        (7.00, (1.79, 0.33)), (9.00, (1.82, 0.30)), (12.0, (1.86, 0.27)),
        (12.5, (1.74, 0.26)), (13.0, (1.60, 0.25)), (13.5, (1.49, 0.24)),
        (14.0, (1.42, 0.23)), (14.3, (1.36, 0.22))],
    # Q5 lower outboard side of the cowl
    5: [(3.90, (1.60, -0.42)), (5.40, (1.60, -0.45)), (7.00, (1.60, -0.43)),
        (9.50, (1.59, -0.42)), (11.5, (1.52, -0.40)), (12.4, (1.32, -0.36)),
        (13.0, (1.18, -0.28)), (13.6, (1.08, -0.18)), (14.3, (0.98, -0.08))],
    # Q6 bottom outboard corner of the flat belly
    6: [(3.90, (1.36, -0.60)), (5.00, (1.36, -0.64)), (5.60, (1.30, -0.72)),
        (6.20, (1.24, -0.80)), (6.80, (1.20, -0.845)), (10.5, (1.19, -0.85)),
        (11.5, (1.14, -0.85)), (12.2, (1.08, -0.80)), (12.9, (0.95, -0.58)),
        (13.5, (0.86, -0.36)), (14.3, (0.78, -0.12))],
    # Q7 keel (inside F ahead of s~5.1)
    7: [(3.90, (0.0, -0.58)), (4.60, (0.0, -0.62)), (5.40, (0.0, -0.695)),
        (6.20, (0.0, -0.80)), (6.80, (0.0, -0.855)), (10.4, (0.0, -0.86)),
        (11.0, (0.0, -0.92)), (11.4, (0.0, -0.945)), (11.9, (0.0, -0.89)),
        (12.4, (0.0, -0.79)), (12.9, (0.0, -0.64)), (13.2, (0.0, -0.52)),
        (13.6, (0.0, -0.36)), (14.0, (0.0, -0.22)), (14.3, (0.0, -0.15))],
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
    up = [Vector(fore_point(s, math.pi / 2 * i / 200)) for i in range(201)]
    lo = [Vector(fore_point(s, math.pi / 2 + math.pi / 2 * i / 200)) for i in range(201)]
    return _ring_from_half(s, resample(up, N_UP + 1), resample(lo, N_LO + 1))


def main_ring(s):
    q = q_points(s)
    up = hermite_spline(q[0:5], 16, start_tangent=Vector((1, 0)))
    lo = hermite_spline(q[4:8], 16, end_tangent=Vector((-1, 0)))
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
    verts.append(P(0.0, 0.0, 0.0))
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
TIP = (1.48, 4.28, 0.18)            # forward-most point of the cowl (x, s, z)
LIP_A, LIP_B = 0.826, 0.168         # upper lip plane slopes
LIP_C, LIP_D = 0.4235, 0.7926       # lower lip plane slopes
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
# Duct cutter with the DSI bump on its inboard wall
# ---------------------------------------------------------------------------
def _bump(s, z):
    """Diverterless bump height (m) on the inboard duct wall."""
    fs = max(0.0, 1.0 - ((s - 4.75) / 0.85) ** 2)
    fz = max(0.0, 1.0 - ((z + 0.02) / 0.42) ** 2)
    return 0.11 * fs * fz


def _duct_section(s, side):
    """Closed duct polygon (x, z) at station s (x positive = this side)."""
    t = max(0.0, min(1.0, (s - 5.25) / 1.75))
    tt = t * t * (3 - 2 * t)
    # outboard walls of the aperture (front view trapezoid)
    outer = [
        (1.36, 0.585),
        (1.47, 0.55),
        (1.535, 0.45),
        (1.555, 0.10),
        (1.535, -0.34),
        (1.47, -0.455),
        (1.20, -0.47),
        (0.95, -0.47),
    ]
    zc, xc = 0.05, 1.10
    pts = []
    sc = 1.0 - 0.30 * tt
    shift = 0.38 * tt
    for x, z in outer:
        pts.append((xc + (x - xc) * sc - shift, zc + (z - zc) * sc - 0.08 * tt))
    # inboard wall follows the forebody side + bump (front), straight aft
    zs = [-0.47, -0.36, -0.22, -0.08, 0.06, 0.20, 0.33, 0.45]
    inner = []
    for z in zs:
        zz = zc + (z - zc) * sc - 0.08 * tt
        xw = fore_x_at(min(s, 5.2), z) + 0.025 + _bump(s, z)
        xw = xc + (xw - xc) * sc - shift
        inner.append((xw, zz))
    # polygon: top-inboard -> outboard walls (top..bottom) -> inboard wall up
    poly = [inner[-1]] + pts + inner[0:-1]
    return [(x * side, z) for x, z in poly]


def build_duct_cutter(collection, side=1):
    st = [3.2, 3.6, 4.0, 4.2, 4.4, 4.6, 4.8, 5.0, 5.2, 5.4, 5.6, 5.8, 6.0,
          6.2, 6.4, 6.6, 6.8, 7.0]
    rings = []
    for s in st:
        sec = _duct_section(s, side)
        rings.append([P(s, x, z) for x, z in sec])
    verts, faces = loft_rings(rings, True, True, True)
    ob = mesh_object(f"DuctCutter_{'L' if side > 0 else 'R'}", verts, faces,
                     collection, M.get("intake"), smooth=True)
    _fix_normals(ob)
    return ob


NOZ_Z = 0.12            # engine / nozzle axis height
NOZ_SHROUD_S = 13.25    # aft fuselage shroud edge (serrated)
NOZ_WELL_R = 0.585


def build_nozzle_well_cutter(collection, teeth=14, depth=0.16):
    """Cylinder removing the centre of the aft body behind the shroud edge.

    Its front face is serrated so the shroud gets the F-35 sawtooth edge."""
    n = teeth * 2
    rings = []
    front = []
    for i in range(n):
        a = 2 * math.pi * i / n
        s = NOZ_SHROUD_S + (depth if i % 2 else 0.0)
        front.append(P(s, NOZ_WELL_R * math.cos(a), NOZ_Z + NOZ_WELL_R * math.sin(a)))
    rings.append(front)
    for s, r in ((13.6, NOZ_WELL_R + 0.03), (14.35, 0.76), (15.5, 0.80)):
        rings.append([P(s, r * math.cos(2 * math.pi * i / n),
                        NOZ_Z + r * 0.92 * math.sin(2 * math.pi * i / n))
                      for i in range(n)])
    verts, faces = loft_rings(rings, True, True, True)
    ob = mesh_object("NozzleWellCutter", verts, faces, collection,
                     M.get("edge"), smooth=False)
    _fix_normals(ob)
    return ob


def build_cockpit_cutter(collection):
    """Cockpit tub cutter: canopy footprint extruded down to the floor."""
    foot = [(1.98, 0.04), (2.10, 0.16), (2.40, 0.31), (2.80, 0.41),
            (3.20, 0.46), (3.60, 0.48), (4.00, 0.48), (4.40, 0.46),
            (4.75, 0.42), (4.92, 0.34)]
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
    fus.data.set_sharp_from_angle(angle=math.radians(35))
    return fus
