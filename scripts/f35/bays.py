"""Openings cut into the airframe + doors that conform to the skin:

* two internal weapon bays, each with a keel-hinged inboard door (carrying
  the door-mounted AIM-120 station) and an outboard-hinged main door; both
  open "straight down" (~90-95 deg).  A GBU-31 class JDAM hangs from the
  main station in each bay.
* nose-gear well with two long side doors hinged on the bottom corners;
  they hang down beside the leg while the gear is down.  The well has its
  own dark lining, frames, hydraulic lines and boxes; each door carries
  two hinge arms on its inner face
* main-gear wells in the lower body side, the wing-root fillet and the
  wing root.  Three doors per side: the aft outboard door (hinged at its
  outboard edge under the wing root, above the wheel) follows the fillet,
  so it hangs beside the leg as a gently curved panel while the gear is
  down, as in photos of parked F-35s (c29, c50, c51, c53); the forward
  outboard door and the inboard door only open while the gear is moving
* GAU-22/A gun fairing along the left shoulder, its gun-port door on the nose
* air-refuelling receptacle door on the spine (F-35A/I boom receptacle)

Door panels are ray-cast onto the closed skin, so they follow the outer
mould line exactly; the wells are then cut with exact booleans.
"""
import math
import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .geom import P, get_collection, mesh_object, loft_rings, boolean, add_solidify, cylinder
from .surfaces import set_hinge
from . import materials as M
from . import normals

BAY_S = (6.55, 10.75)          # weapon bay station range
BAY_X = (0.13, 1.09)           # inboard / outboard wall (each side)
BAY_Z = (-1.00, -0.24)         # roof 0.55 m above the belly (GBU-31 + rack fit)
DZ = 0.08                      # bay internals sit 8 cm higher since the belly was raised
INNER_DOOR_X = (0.135, 0.455)
OUTER_DOOR_X = (0.465, 1.085)
# Nose-gear well and its two long side doors (photos c20, c22, c34, c51, c53:
# both doors stay open with the gear down and hang from the bottom corners of
# the forward fuselage, the aircraft number painted on them).  Each door runs
# from its hinge line on the bottom corner (|x| = NOSE_WELL_X) to the centre
# line, from just behind the EOTS window to the strut.  Front edge sawtoothed,
# aft edge raked so the free edge is slightly longer than the hinge edge.
NOSE_WELL_X = (0.50, 0.33)         # hinge line |x| at the front / aft end.  At the front the hinge sits up
                                   # on the curved bottom corner, so the hinge line climbs towards the nose
                                   # and the open doors leave about a wheel diameter of daylight above the
                                   # nose tyre (c14, c28, c47, c48, c51, c53, ref_05); head-on the door fronts
                                   # are ~1 m apart (c22, c29).  The well narrows aft, so by the strut the
                                   # doors are shallow enough to show the white steering housing under them
NOSE_WELL_S = (2.30, 4.62)
NOSE_WELL_Z = (-1.20, 0.04)        # cutter bottom (below the skin) / well roof
NOSE_TEETH = 2                     # sawtooth teeth across each door's front edge
NOSE_TOOTH = 0.10
NOSE_AFT_RAKE = 0.05
NOSE_DOOR_LEAN = 25.0              # open doors hang with their free edge this far inboard of vertical (deg)
                                   # (head-on photos c22, c29, c50: the doors close in towards the strut and
                                   # stay inside the hinge width; 25 deg keeps the free edges 0.21 m off the
                                   # centre line, clear of the trailing arm and tow lug at |x| <= 0.18)
# Equipment in the open nose-gear well (c20, c22, c29 and ref_04 of 926: between the open doors the well
# is dark and busy -- frames, hydraulic lines, boxes -- and each door's inner face carries hinge arms and
# gussets).  It stays out of the stowed leg (|x| <= 0.19; the tyre top 2.5 cm under the roof between
# s 2.95 and 3.55, the folded brace on the centre line from s 3.78 to 4.40) and above the closed doors.
NOSE_FRAMES = (2.80, 3.20, 3.60, 4.00, 4.40)    # transverse frame stations
NOSE_FRAME = (0.04, 0.03)          # frame depth off the wall / roof, flange thickness (along s)
NOSE_FRAME_ROOF = 0.20             # the roof flanges stop this far off the centre line (|x|)
NOSE_LINE_GAP = 0.022              # hydraulic line centres off the side walls (inside the frame depth)
# hydraulic lines along the side walls, ~1.5 cm across: (side, z, radius, material, turns down the aft wall)
NOSE_LINES = ((1, -0.06, 0.0075, "chrome", False), (1, -0.11, 0.0075, "chrome", False),
              (1, -0.17, 0.009, "hose", True), (-1, -0.05, 0.0075, "chrome", False),
              (-1, -0.21, 0.0075, "chrome", True))
NOSE_LINE_DROP = (0.20, -0.47)     # ... the turned lines run inboard along the aft wall to this |x|, then
                                   # down to this z beside the trunnion ends (seen head-on, c22, c29)
NOSE_ROOF_LINE = (0.27, 0.028, 0.0075)          # (x, z, r) of a line along the roof (left)
# (side, s0, s1, z0, z1, depth off the wall, material); side 0 = on the roof, centred
NOSE_BOXES = ((1, 4.05, 4.32, -0.33, -0.21, 0.07, "bay"),          # valve block, left wall aft
              (-1, 2.50, 2.72, -0.17, -0.07, 0.06, "intake_dark"),  # connector box, right wall forward
              (0, 2.52, 2.72, -0.05, 0.045, 0.12, "gear"))          # uplock box, roof ahead of the stowed tyre
# hinge arms on each door: (station, root inset from the hinge line, length across the door).  Near the
# door's ends, between the frames: the straight hinge axis runs above the curved skin (~6 cm at the aft
# arm, 0.13 m at mid-length), so a root closer to the hinge line would swing out through the skin as the
# door opens.  The aft arm is shorter: on the hanging door it stays > 8 cm off the housing and the
# actuator boss as they swing past.
NOSE_DOOR_ARMS = ((2.62, 0.05, 0.25), (4.24, 0.10, 0.18))
NOSE_ARM = (0.065, 0.022, 0.02)    # height off the inner face at the root / at the tip, plate thickness
MAIN_WELL_S = (8.20, 10.72)        # the stowed wheel reaches s 8.34
# (x, z) cross-section of the main-gear well (left side; mirrored for right).
# Its lower edge runs outside the skin from the belly corner to under the
# wing root, so the opening spans the sloping body side and the wing root.
MAIN_WELL_POLY = [(1.13, -1.00), (2.215, -0.43), (2.215, 0.21), (1.40, 0.40),
                  (0.78, 0.40), (0.78, -0.17), (1.13, -0.21)]
MAIN_SPLIT_X = 1.64            # inboard door | outboard doors
MAIN_OUT_X = 2.20              # outboard hinge line (under the wing root, above the wheel)
MAIN_AFT_S = 9.50              # forward outboard door | aft outboard door, at the hinge line
MAIN_RAKE = 0.62               # ... the split runs aft by this much towards the doors' free edge: the
                               # hanging door is a trapezoid with a raked front edge (c14, c51), the
                               # white drag brace just ahead of it
MAIN_NOTCH = (0.84, 0.14)      # notch in the forward door's aft-outboard corner (u from, depth) for
                               # the brace fitting


def main_split_s(u):
    """Station of the forward / hanging door split at u (0 free edge, 1 hinge line)."""
    return MAIN_AFT_S + MAIN_RAKE * (1.0 - u)


def main_fwd_aft_s(u):
    """Aft edge of the forward outboard door: the split, notched near the hinge line."""
    u0, depth = MAIN_NOTCH
    t = min(1.0, max(0.0, (u - u0) / 0.04))
    return main_split_s(u) - depth * t * t * (3 - 2 * t)
# GAU-22/A gun fairing on the left shoulder (photos c20, c53 and ref_05 / ref_06 of 901): a long,
# half-buried tube along the shoulder from a rounded nose just aft of and above the cowl's top
# corner to the wing root.  Seen from above it stands out of the shoulder as a separate cylinder
# with a steep inboard flank; outboard it rolls over the shoulder and runs down the cowl side as
# a thin skin to a fastener crease about 5 cm above the strake edge.  Its crest is only ~5 cm
# above the old shoulder (camera-matched c20 / c29 silhouettes).  The gun door is its nose.
GUN_FAIR_S = (5.00, 5.42, 7.70, 8.95)   # nose tip / full section from / taper from / gone by
GUN_FAIR_X = 1.28                       # crest line |x|
GUN_FAIR_IN = 0.17                      # crest to the inboard foot (x)
GUN_FAIR_ROLL = 0.45                    # crest to where the skin runs down the side (fraction of the
                                        # arc from the crest to the crease)
GUN_FAIR_H = 0.050                      # crest height above the shoulder
GUN_FAIR_SIDE = 0.008                   # skin thickness down the cowl side
GUN_FAIR_C = (1.20, 0.20)               # (x, z) centre of the radial ray casts
GUN_FAIR_EPS = 0.0025                   # edges tuck this far under the skin: clean crease lines
# Raised NO STEP vent fairing on the outer slope of the right shoulder (photos c10, c28, c29, c50,
# c51, ref_01 of 926; seen in flight on 901 in ref_06): a flat-topped box ~0.24 m wide standing
# ~0.11 m off the slope, a blunt front face at s ~5.9 that is mostly a dark forward-facing opening
# (head-on a slanted parallelogram ~0.2 x 0.14 m standing above the shoulder skyline), grille
# panels on top and a taper into the shoulder by s ~7.75.
VENT_S = (5.88, 5.95, 7.15, 7.75)       # front face / full from / taper from / gone by
VENT_Z = 0.47                           # centre line: where the slope passes this height
VENT_HALF = 0.12                        # half-width along the skin
VENT_H = 0.11                           # height off the slope


def nose_front(x):
    """Station of the well / door front edge at lateral position x (sawtooth)."""
    xf = NOSE_WELL_X[0]
    t = min(abs(x), xf) / xf * NOSE_TEETH
    f = t - math.floor(t)
    return NOSE_WELL_S[0] + NOSE_TOOTH * (1.0 - abs(2.0 * f - 1.0))


def nose_aft(x):
    xa = NOSE_WELL_X[1]
    return NOSE_WELL_S[1] - NOSE_AFT_RAKE * min(abs(x), xa) / xa


def nose_half_width(s):
    """|x| of the hinge line at station s."""
    (s0, s1), (x0, x1) = NOSE_WELL_S, NOSE_WELL_X
    t = min(1.0, max(0.0, (s - s0) / (s1 - s0)))
    return x0 + (x1 - x0) * t


def nose_plan():
    """Plan outline (x, s) of the nose-gear well, front edge first."""
    n = 4 * NOSE_TEETH
    x0, x1 = NOSE_WELL_X
    front = [(x0 * (-1 + 2 * k / n), nose_front(x0 * (-1 + 2 * k / n))) for k in range(n + 1)]
    front[0] = (-x0, NOSE_WELL_S[0])
    front[-1] = (x0, NOSE_WELL_S[0])
    aft = [(x1, nose_aft(x1)), (0.0, nose_aft(0.0)), (-x1, nose_aft(x1))]
    return front + aft


def nose_wall_x(s):
    """|x| of the nose-gear well's side wall at station s (the cutter outline, front corner to aft corner)."""
    (x0, x1), s0 = NOSE_WELL_X, NOSE_WELL_S[0]
    t = min(1.0, max(0.0, (s - s0) / (nose_aft(x1) - s0)))
    return x0 + (x1 - x0) * t


def _plan_prism(name, coll, plan_xs, z0, z1, mat):
    """Closed vertical prism: simple polygon in plan (x, s) from z0 to z1.
    The caps are ear-clipped so a sawtooth outline stays a valid solid."""
    bm = bmesh.new()
    lo = [bm.verts.new(P(s, x, z0)) for x, s in plan_xs]
    hi = [bm.verts.new(P(s, x, z1)) for x, s in plan_xs]
    n = len(plan_xs)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.faces.new(lo)
    bm.faces.new(list(reversed(hi)))
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], ngon_method='EAR_CLIP')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    if mat is not None:
        me.materials.append(mat)
    return ob


def _bvh(*obs):
    """BVH over several objects (world space)."""
    dg = bpy.context.evaluated_depsgraph_get()
    verts, polys = [], []
    for ob in obs:
        if ob is None:
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        mw = ob.matrix_world
        off = len(verts)
        verts.extend(mw @ v.co for v in me.vertices)
        polys.extend([off + i for i in p.vertices] for p in me.polygons)
        ev.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys)


def _fix(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()


def _cavity(name, coll, x0, x1, s0, s1, z0, z1, mat):
    """Closed box cutter in station space; its faces become the cavity walls."""
    v = [P(s, x, z) for x in (x0, x1) for s in (s0, s1) for z in (z0, z1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    ob = mesh_object(name, v, f, coll, mat, smooth=False)
    _fix(ob)
    return ob


def _prism(name, coll, poly_xz, s0, s1, mat):
    """Closed prism: simple polygon in (x, z) extruded along the station axis."""
    n = len(poly_xz)
    v = [P(s0, x, z) for x, z in poly_xz] + [P(s1, x, z) for x, z in poly_xz]
    f = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        f.append((i, j, n + j, n + i))
    ob = mesh_object(name, v, f, coll, mat, smooth=False)
    _fix(ob)
    return ob


def _ss(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def gun_crease_z(s):
    """Height of the fairing's side crease: ~5 cm above the strake edge, rising aft to stay above
    the wing's upper surface where it runs out of the cowl side."""
    return 0.37 + 0.10 * _ss(7.0, 8.6, s)


def _gun_section(bvh, s, side=1, n=241):
    """Outer skin section round a shoulder (side 1 = left) at station s: (points, arc lengths),
    ordered inboard over the top and down the cowl side.  Rays come in from outside towards
    GUN_FAIR_C so the duct walls inside are never hit."""
    cx, cz = GUN_FAIR_C
    c = P(s, side * cx, cz)
    pts = []
    for k in range(n):
        th = math.radians(128.0 - 128.0 * k / (n - 1))
        d = Vector((side * math.cos(th), 0.0, math.sin(th)))
        hit = bvh.ray_cast(c + d * 3.0, -d, 3.2)
        if hit[0] is not None and (not pts or (hit[0] - pts[-1]).length > 2e-4):
            pts.append(hit[0])
    w = [0.0]
    for a, b in zip(pts, pts[1:]):
        w.append(w[-1] + (b - a).length)
    return pts, w


def _at(pts, w, x, side=1):
    """Point and outward section normal at arc length x."""
    x = min(max(x, 0.0), w[-1])
    for i in range(len(w) - 1):
        if w[i + 1] >= x:
            break
    f = (x - w[i]) / max(w[i + 1] - w[i], 1e-9)
    p = pts[i].lerp(pts[i + 1], f)
    # tangent over a ~2 cm window: smooth normals on a faceted skin
    a = _lerp_w(pts, w, x - 0.01)
    b = _lerp_w(pts, w, x + 0.01)
    t = b - a
    nrm = Vector((t.z, 0.0, -t.x)).normalized()       # rotate the tangent; outward = away from C
    if nrm.x * (p.x - side * GUN_FAIR_C[0]) + nrm.z * (p.z - GUN_FAIR_C[1]) < 0:
        nrm = -nrm
    return p, nrm


def _lerp_w(pts, w, x):
    x = min(max(x, 0.0), w[-1])
    for i in range(len(w) - 1):
        if w[i + 1] >= x:
            break
    f = (x - w[i]) / max(w[i + 1] - w[i], 1e-9)
    return pts[i].lerp(pts[i + 1], f)


def _w_where(pts, w, test, start=0):
    """Arc length where test(p) first becomes true (linear between samples)."""
    for i in range(max(start, 0), len(pts) - 1):
        a, b = test(pts[i]), test(pts[i + 1])
        if b >= 0.0 > a or (a == 0.0):
            f = -a / (b - a) if b != a else 0.0
            return w[i] + f * (w[i + 1] - w[i]), i
    return None, None


def build_gun_fairing(coll, bvh):
    """Closed solid lying on the left shoulder (see GUN_FAIR_*): every station is a section of
    the skin found by ray casts, pushed out along its normal by the fairing thickness; the
    bottom runs 2 cm under the skin."""
    s0, sn, st, s1 = GUN_FAIR_S
    e_min = 0.12
    stations = []
    s = s0
    while s < s1 - 1e-6:
        stations.append(s)
        s += 0.012 if s < sn else (0.03 if s < st else 0.04)
    stations.append(s1)
    # cross-section samples: (region, u); A inboard foot -> crest (dense at the foot),
    # B crest -> side, C down the side, D the crease
    na, nb, nc, nd = 18, 14, 10, 6
    samples = ([("A", 1.0 - math.cos(0.5 * math.pi * k / na)) for k in range(na)]
               + [("B", k / nb) for k in range(nb)]
               + [("C", k / nc) for k in range(nc)]
               + [("D", math.sin(0.5 * math.pi * k / (nd - 1))) for k in range(nd)])
    rings = []
    for s in stations:
        pts, w = _gun_section(bvh, s, 1)
        if len(pts) < 20:
            raise RuntimeError(f"gun fairing: no skin section at s={s:.3f}")
        if s < sn:
            e = e_min + (1.0 - e_min) * math.sqrt(max(0.0, 1.0 - ((sn - s) / (sn - s0)) ** 2))
        else:
            e = 1.0
        grow = (e - e_min) / (1.0 - e_min)
        fade = 1.0 - _ss(st, s1, s)
        h = GUN_FAIR_H * grow ** 0.7 * fade
        hs = GUN_FAIR_SIDE * grow * fade
        wc, ic = _w_where(pts, w, lambda p: p.x - GUN_FAIR_X)
        wi, _ = _w_where(pts, w, lambda p: p.x - (GUN_FAIR_X - GUN_FAIR_IN))
        zc = gun_crease_z(s)
        wk, _ = _w_where(pts, w, lambda p: zc - p.z, ic)
        if None in (wc, wi, wk):
            raise RuntimeError(f"gun fairing: section limits not found at s={s:.3f}")
        wi = wc - (wc - wi) * e
        wk = wc + (wk - wc) * e
        wr = wc + (wk - wc) * GUN_FAIR_ROLL
        dk = 0.012 * e                       # width of the crease step
        top, bot = [], []
        for reg, u in samples:
            if reg == "A":
                x = wi + (wc - wi) * u
                th = h * (1.0 - (1.0 - u) ** 2.2) ** 0.55
            elif reg == "B":
                x = wc + (wr - wc) * u
                th = hs + (h - hs) * 0.5 * (1.0 + math.cos(math.pi * u))
            elif reg == "C":
                x = wr + (wk - dk - wr) * u
                th = hs
            else:
                x = wk - dk + dk * u
                th = hs * math.sqrt(max(0.0, 1.0 - u * u))
            p, nrm = _at(pts, w, x)
            top.append(p + nrm * (th - GUN_FAIR_EPS))
            bot.append(p - nrm * 0.02)
        rings.append(top + bot[::-1])
    verts, faces = loft_rings(rings, True, True, True)
    ob = mesh_object("GunFairing", verts, faces, coll, M.get("skin"), smooth=True, sharp_angle=40)
    _fix(ob)
    return ob


def _vent_frame(pts, w, s, side):
    """Arc position of the vent fairing's centre line at station s."""
    _, ic = _w_where(pts, w, lambda p: side * p.x - GUN_FAIR_X)
    wm, _ = _w_where(pts, w, lambda p: VENT_Z - p.z, ic)
    if wm is None:
        raise RuntimeError(f"vent fairing: no slope at z={VENT_Z} at s={s:.3f}")
    return wm


def build_vent_fairing(coll, bvh, side=-1):
    """Flat-topped fairing on the outer slope of the right shoulder (see VENT_*), with a dark
    slot cut into its blunt front face."""
    sf, sm, st, s1 = VENT_S
    stations = []
    s = sf
    while s < s1 - 1e-6:
        stations.append(s)
        s += 0.007 if s < sm else 0.03
    stations.append(s1)
    nu = 32
    us = [math.sin(0.5 * math.pi * (2.0 * k / (nu - 1) - 1.0)) for k in range(nu)]
    rings = []
    for s in stations:
        pts, w = _gun_section(bvh, s, side)
        wm = _vent_frame(pts, w, s, side)
        if s < sm:                          # blunt face, rounded top edge
            g = (1.0 - ((sm - s) / (sm - sf)) ** 2.2) ** 0.5 if s > sf else 0.0
        else:
            g = 1.0
        fade = 1.0 - _ss(st, s1, s)
        h = VENT_H * g * fade
        half = VENT_HALF * (0.6 + 0.4 * fade)
        top, bot = [], []
        for u in us:
            p, nrm = _at(pts, w, wm + u * half, side)
            th = h * max(0.0, 1.0 - abs(u) ** 5) ** 0.4
            top.append(p + nrm * (th - GUN_FAIR_EPS))
            bot.append(p - nrm * 0.02)
        rings.append(top + bot[::-1])
    verts, faces = loft_rings(rings, True, True, True)
    ob = mesh_object("VentFairing", verts, faces, coll, M.get("skin"), smooth=True, sharp_angle=40)
    _fix(ob)
    # the dark opening in the front face: a box in the fairing's own frame, 0.19 m across the
    # slope, from 1.5 to 8.8 cm off the skin, 0.22 m deep
    sc = sf + 0.03
    pts, w = _gun_section(bvh, sc, side)
    wm = _vent_frame(pts, w, sc, side)
    pc, nrm = _at(pts, w, wm, side)
    pa, _ = _at(pts, w, wm + 0.01, side)
    tng = (pa - pc).normalized()
    v = []
    for ds in (-0.05, 0.22):
        for a in (-0.095, 0.095):
            for b in (0.015, 0.088):
                v.append(pc + tng * a + nrm * b + Vector((0.0, ds - 0.03, 0.0)))
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    cut = mesh_object("Cav_Vent", v, f, coll, M.get("intake_dark"), smooth=False)
    _fix(cut)
    boolean(ob, cut, 'DIFFERENCE', apply=True)
    bpy.data.objects.remove(cut)
    ob.data.set_sharp_from_angle(angle=math.radians(40))
    return ob


def surface_patch(name, coll, bvh, grid_fn, nu, nv, ray_dir, offset=0.002,
                  thickness=0.018, mat=None):
    """Patch on the skin: grid_fn(u, v) -> ray origin (world).  Rays cast
    along ray_dir; hit points pushed out by `offset` along -ray_dir."""
    d = Vector(ray_dir).normalized()
    pts = []
    for j in range(nv):
        row = []
        for i in range(nu):
            o = grid_fn(i / (nu - 1), j / (nv - 1))
            hit = bvh.ray_cast(o, d, 20.0)
            if hit[0] is None:
                hit = bvh.ray_cast(o - d * 2.0, d, 20.0)
            p = hit[0] if hit[0] is not None else o
            row.append(p - d * offset)
        pts.append(row)
    verts = [p for row in pts for p in row]
    faces = []
    for j in range(nv - 1):
        for i in range(nu - 1):
            a = j * nu + i
            faces.append((a, a + 1, a + nu + 1, a + nu))
    ob = mesh_object(name, verts, faces, coll, mat or M.get("skin"))
    me = ob.data
    if me.polygons and me.polygons[0].normal.dot(d) > 0:
        me.flip_normals()
    # sharp rims: the Solidify edge must not bend the outer face's shading normals, or every
    # door reads as a bevelled, outlined box instead of flush skin with a fine seam
    bm = bmesh.new()
    bm.from_mesh(me)
    for e in bm.edges:
        if e.is_boundary:
            e.smooth = False
    bm.to_mesh(me)
    bm.free()
    add_solidify(ob, thickness, -1.0)
    return ob


def build(ctx):
    root = ctx["root"]
    helpers = ctx["helpers"]
    fus = ctx["objects"]["Fuselage"]
    coll = get_collection("Doors", root)
    wcoll = get_collection("Weapons", root)
    objs = {}
    bay_mat = M.get("bay")
    wings = [ctx["objects"].get(f"{n}_{t}") for n in ("Wing", "WingFillet") for t in ("L", "R")]
    bvh = _bvh(fus, *wings)              # rays are cast before cutting
    up = (0, 0, 1)
    s0, s1 = BAY_S
    door_specs = []
    for side, tag in ((1, "L"), (-1, "R")):
        for kind, (xa, xb), hinge_x, lim in (("Inner", INNER_DOOR_X, INNER_DOOR_X[0], 95.0),
                                             ("Outer", OUTER_DOOR_X, OUTER_DOOR_X[1], 92.0)):
            xa_s, xb_s = side * xa, side * xb
            door_specs.append((f"BayDoor_{kind}_{tag}",
                               lambda u, v, xa_s=xa_s, xb_s=xb_s: P(s0 + 0.01 + (s1 - s0 - 0.02) * v,
                                                                     xa_s + (xb_s - xa_s) * u, -2.5),
                               12, 30, up,
                               dict(kind="bay_door", side=side, hx=hinge_x * side, lim=lim,
                                    sub=kind, want=(0, 0, -1), s=(s0 + 0.01, s1 - 0.01), hz=None)))
    # nose gear doors: hinged on the bottom corners, each reaching the centre
    # line; open, they hang with the free edge a little inboard of vertical.
    sm = 0.5 * (NOSE_WELL_S[0] + NOSE_WELL_S[1])
    sf, sa_ = NOSE_WELL_S[0] + 0.008, nose_aft(NOSE_WELL_X[1]) - 0.008
    for side, tag in ((1, "L"), (-1, "R")):
        def nose_grid(u, v, side=side):
            # u across the door (centre line -> hinge), v along it.  Each
            # column runs from the sawtooth front edge to the raked aft edge;
            # x follows the tapering hinge line (two fixed-point passes).
            x = 0.003 + (nose_half_width(sm) - 0.006) * u
            for _ in range(3):
                s_lo, s_hi = nose_front(x) + 0.008, nose_aft(x) - 0.008
                sv = s_lo + (s_hi - s_lo) * v
                x = 0.003 + (nose_half_width(sv) - 0.006) * u
            return P(sv, side * x, -2.5)
        ph0 = _skin_point(bvh, side * (nose_half_width(sf) - 0.003), sf)
        ph1 = _skin_point(bvh, side * (nose_half_width(sa_) - 0.003), sa_)
        hm = _skin_point(bvh, side * nose_half_width(sm), sm)
        cm = _skin_point(bvh, side * 0.003, sm)
        chord = math.degrees(math.atan2(hm.z - cm.z, abs(hm.x - cm.x)))
        door_specs.append((f"NoseGearDoor_{tag}", nose_grid, 8 * NOSE_TEETH + 1, 30, up,
                           dict(kind="nose_door", side=side, hx=side * NOSE_WELL_X[1],
                                lim=round(90.0 - chord - NOSE_DOOR_LEAN, 1), sub="", want=(0, 0, -1),
                                s=(sf, sa_), hz=None, p0=ph0, p1=ph1)))
    # main gear doors.  Skin chord (x, z) of each door at mid well, found by
    # ray casts; the doors are ray-cast patches between two lateral limits.
    ms0, ms1 = MAIN_WELL_S
    for side, tag in ((1, "L"), (-1, "R")):
        for name, (xa, xb), (sa, sb), hinge, kind, lim_pad in (
                (f"MainGearDoor_Inner_{tag}", (1.135, MAIN_SPLIT_X), (ms0 + 0.01, ms1 - 0.01), "in",
                 "main_well_door", 0.0),
                (f"MainGearDoor_Fwd_{tag}", (MAIN_SPLIT_X, MAIN_OUT_X), (ms0 + 0.01, MAIN_AFT_S - 0.005), "out",
                 "main_well_door", 4.0),
                (f"MainGearDoor_{tag}", (MAIN_SPLIT_X, MAIN_OUT_X), (MAIN_AFT_S + 0.005, ms1 - 0.01), "out",
                 "main_door", 3.0)):
            pa = _skin_point(bvh, side * xa, 0.5 * (sa + sb))
            pb = _skin_point(bvh, side * xb, 0.5 * (sa + sb))
            ch = (pb - pa)
            ch.y = 0.0
            ch.normalize()
            nrm = Vector((-ch.z, 0.0, ch.x * 1.0)) if side > 0 else Vector((ch.z, 0.0, -ch.x))
            if nrm.z > 0:                       # outward normal points down/outboard
                nrm = -nrm

            def gf(u, v, pa=pa, pb=pb, sa=sa, sb=sb, nrm=nrm, name=name):
                q = pa.lerp(pb, u)
                a, b_ = sa, sb
                if name.startswith("MainGearDoor_Fwd"):        # raked, notched aft edge
                    b_ = main_fwd_aft_s(u) - 0.005
                elif not name.startswith("MainGearDoor_Inner"):  # hanging door: raked front edge
                    a = main_split_s(u) + 0.005
                return Vector((q.x, P(a + (b_ - a) * v, 0, 0).y, q.z)) + nrm * 1.2
            slope = math.degrees(math.atan2(abs(pb.z - pa.z), abs(pb.x - pa.x)))
            if hinge == "out":
                lim = 90.0 - slope + lim_pad          # hangs (just past) vertical
                hx, want = side * xb, (0, 0, -1)
            else:
                lim = 90.0 + slope + lim_pad          # swings down to vertical, clear of the wheel
                hx, want = side * xa, (0, 0, -1)
            door_specs.append((name, gf, 12, 22, -nrm,
                               dict(kind=kind, side=side, hx=hx, lim=lim, sub="",
                                    want=want, s=(sa, sb), hz=None)))
    doors = {}
    for name, fn, nu, nv, ray, meta in door_specs:
        d = surface_patch(name, coll, bvh, fn, nu, nv, ray, mat=M.get("skin"))
        d.data.materials.append(bay_mat)
        d.modifiers["Solidify"].material_offset = 1
        doors[name] = (d, meta)
    # gun fairing on the left shoulder (the gun door is cast onto its nose), vent fairing on
    # the right shoulder
    bvh_f = _bvh(fus)
    fairing = build_gun_fairing(coll, bvh_f)
    objs["VentFairing"] = build_vent_fairing(coll, bvh_f, -1)
    bvh_g = _bvh(fus, fairing)
    # (1 cm larger all round than the gun cavity, so the closed door leaves no dark slot)
    gun = surface_patch("GunDoor", coll, bvh_g,
                        lambda u, v: P(5.05 + 0.76 * v, 1.215 + 0.17 * u, 2.0), 13, 28, (0, 0, -1))
    refuel = surface_patch("RefuelDoor", coll, bvh,
                           lambda u, v: P(5.55 + 0.42 * v, -0.11 + 0.22 * u, 3.0), 6, 8, (0, 0, -1))
    # ------------------------------------------------------------ cut wells
    cutters = []
    for side, tag in ((1, "L"), (-1, "R")):
        xa, xb = sorted((side * BAY_X[0], side * BAY_X[1]))
        cutters.append(_cavity(f"Cav_WeaponBay_{tag}", helpers, xa, xb, s0, s1, BAY_Z[0], BAY_Z[1], bay_mat))
        poly = [(side * x, z) for x, z in MAIN_WELL_POLY]
        if side < 0:
            poly = list(reversed(poly))
        cutters.append(_prism(f"Cav_MainGear_{tag}", helpers, poly, *MAIN_WELL_S, bay_mat))
    # the nose-gear well takes its own darker lining; the doors' inner faces stay 'bay'
    cutters.append(_plan_prism("Cav_NoseGear", helpers, nose_plan(), *NOSE_WELL_Z, M.get("nose_well")))
    cutters.append(_cavity("Cav_Gun", helpers, 1.225, 1.375, 5.06, 5.80, 0.38, 1.2, M.get("intake_dark")))
    cutters.append(_cavity("Cav_Refuel", helpers, -0.13, 0.13, 5.53, 6.00, 1.05, 1.6, bay_mat))
    for cut in cutters:
        boolean(fus, cut, 'DIFFERENCE', apply=True)
        if cut.name == "Cav_Gun":
            boolean(fairing, cut, 'DIFFERENCE', apply=True)
            fairing.data.set_sharp_from_angle(angle=math.radians(40))
        if cut.name.startswith("Cav_MainGear_"):
            for n in ("Wing_", "WingFillet_"):
                ob = ctx["objects"].get(n + cut.name[-1])
                if ob is not None:
                    boolean(ob, cut, 'DIFFERENCE', apply=True)
        bpy.data.objects.remove(cut)
    normals.apply(fus, "Fuselage")       # smooth source normals up to the new cut edges
    # ------------------------------------------------------------- hinges
    for name, (d, meta) in doors.items():
        sa, sb = meta["s"]
        if "p0" in meta:                 # hinge line given as skin points
            p0, p1 = meta["p0"], meta["p1"]
        else:                            # hinge line on the door's own edge
            hz = _edge_z(d, meta["hx"])
            p0, p1 = P(sa, meta["hx"], hz), P(sb, meta["hx"], hz)
        set_hinge(d, p0, p1, meta["kind"], (0.0, meta["lim"]),
                  {"side": meta["side"], "door": meta["sub"], "want": list(meta["want"])})
        objs[name] = d
    # hinge on the door's outboard edge, on the fairing skin (it climbs over the nose)
    g0 = bvh_g.ray_cast(P(5.05, 1.385, 2.0), Vector((0, 0, -1)), 5.0)[0]
    g1 = bvh_g.ray_cast(P(5.81, 1.385, 2.0), Vector((0, 0, -1)), 5.0)[0]
    set_hinge(gun, g0 + Vector((0, 0, 0.002)), g1 + Vector((0, 0, 0.002)), "gun_door", (0, 70),
              {"side": 1, "want": [0, 0, -1]})
    set_hinge(refuel, P(5.97, 0.11, 1.18), P(5.97, -0.11, 1.18), "refuel_door", (0, 100),
              {"side": 0, "want": [0, 0, -1]})
    objs["GunDoor"] = gun
    objs["GunFairing"] = fairing
    objs["RefuelDoor"] = refuel
    # ------------------------------------------- nose-gear well equipment
    objs.update(build_nose_well(coll, bvh))
    for side, tag in ((1, "L"), (-1, "R")):
        objs.update(nose_door_arms(coll, bvh, objs[f"NoseGearDoor_{tag}"], side))
    # ---------------------------------------------------- bay interiors
    gear_mat = M.get("gear")
    for side, tag in ((1, "L"), (-1, "R")):
        # roof rails + transverse frames
        for k, xx in enumerate((0.36, 0.95)):
            _box(f"BayRail_{tag}{k}", coll, side * xx, 0.025, s0 + 0.15, s1 - 0.15, -0.37 + DZ, -0.32 + DZ, gear_mat)
        for k in range(7):
            s = s0 + 0.25 + k * (s1 - s0 - 0.5) / 6
            _box(f"BayFrame_{tag}{k}", coll, side * 0.61, 0.95, s - 0.02, s + 0.02, -0.355 + DZ, -0.32 + DZ, bay_mat)
        # main station: bomb rack + GBU-31 class JDAM
        _box(f"BombRack_{tag}", coll, side * 0.76, 0.12, 7.85, 9.45, -0.36 + DZ, -0.30 + DZ, gear_mat)
        jd = build_jdam(wcoll, f"GBU31_{tag}", P(8.62, side * 0.76, -0.565 + DZ))
        objs[jd.name] = jd
        # door station: AIM-120 on a launcher fixed to the inboard door
        door = objs[f"BayDoor_Inner_{tag}"]
        ms = build_amraam(wcoll, f"AIM120_{tag}", P(8.55, side * 0.30, -0.67 + DZ))
        rail = _box(f"AMRAAM_Launcher_{tag}", wcoll, side * 0.30, 0.05, 7.80, 9.30, -0.845 + DZ, -0.755 + DZ,
                    gear_mat)
        for ob in [ms, rail]:
            mw = ob.matrix_world.copy()
            ob.parent = door
            ob.matrix_world = mw
        objs[ms.name] = ms
    ctx["objects"].update(objs)
    return objs


def _skin_point(bvh, x, s):
    """Outer skin point below/outboard at lateral position x, station s (ray up)."""
    o = P(s, x, -3.0)
    hit = bvh.ray_cast(o, Vector((0, 0, 1)), 10.0)
    if hit[0] is None:
        raise RuntimeError(f"no skin at x={x} s={s}")
    return hit[0]


def _edge_z(door, hx):
    """z of the door skin at lateral position hx (average over stations)."""
    best = []
    for v in door.data.vertices:
        if abs(v.co.x - hx) < 0.03:
            best.append(v.co.z)
    return sum(best) / len(best) if best else -0.86


def _box(name, coll, xc, w, s0, s1, z0, z1, mat):
    v = [P(s, xc + dx, z) for dx in (-w / 2, w / 2) for s in (s0, s1) for z in (z0, z1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    ob = mesh_object(name, v, f, coll, mat, smooth=False)
    _fix(ob)
    return ob


def _tube(name, coll, pts, r, mat, seg=10):
    """Pipe through the points: straight runs with mitred corners."""
    pts = [Vector(p) for p in pts]
    d = [(b - a).normalized() for a, b in zip(pts, pts[1:])]
    frames = [d[0].orthogonal().normalized()]
    for a, b in zip(d, d[1:]):
        frames.append(a.rotation_difference(b) @ frames[-1])
    rings = []
    for i, p in enumerate(pts):
        j = max(i - 1, 0)                        # the run arriving at this point
        din, u = d[j], frames[j]
        t = (din + d[min(i, len(d) - 1)]).normalized()
        w = din.cross(u)
        ring = []
        for k in range(seg):
            a = 2 * math.pi * k / seg
            q = (u * math.cos(a) + w * math.sin(a)) * r
            ring.append(p + q - din * (q.dot(t) / din.dot(t)))
        rings.append(ring)
    v, f = loft_rings(rings, True, True, True)
    ob = mesh_object(name, v, f, coll, mat, smooth=True, sharp_angle=40)
    _fix(ob)
    return ob


def build_nose_well(coll, bvh):
    """Equipment in the nose-gear well (see NOSE_FRAMES .. NOSE_BOXES): transverse frames on the side walls
    with stubs under the roof, hydraulic lines along the walls (two turn down the aft wall to the trunnion
    ends), a line along the roof and three boxes.  bvh: the closed skin, for the walls' lower edges."""
    objs = {}
    mats = {n: M.get(n) for n in ("nose_well", "bay", "gear", "chrome", "hose", "intake_dark")}
    zr = NOSE_WELL_Z[1]
    depth, thick = NOSE_FRAME
    for k, s in enumerate(NOSE_FRAMES):
        xw = nose_wall_x(s)
        zb = _skin_point(bvh, xw, s).z + 0.03     # just above the wall's lower edge (and the closed door)
        for side, tag in ((1, "L"), (-1, "R")):
            poly = [(xw + 0.005, zb), (xw + 0.005, zr + 0.005), (NOSE_FRAME_ROOF, zr + 0.005),
                    (NOSE_FRAME_ROOF, zr - depth), (xw - depth, zr - depth), (xw - depth, zb)]
            poly = [(side * x, z) for x, z in poly]
            ob = _prism(f"NoseWell_Frame{k}_{tag}", coll, poly if side > 0 else poly[::-1],
                        s - thick / 2, s + thick / 2, mats["nose_well"])
            objs[ob.name] = ob
    # hydraulic lines: along a side wall from the front wall to the aft corner; the turned ones carry on
    # along the aft wall and down to the trunnion ends
    gap = NOSE_LINE_GAP
    sc = NOSE_WELL_S[1]
    for _ in range(4):                           # aft corner of the line runs (side wall meets aft wall)
        sc = nose_aft(nose_wall_x(sc) - gap) - gap
    s0 = nose_front(nose_wall_x(NOSE_WELL_S[0]) - gap)
    xd, zd = NOSE_LINE_DROP
    for k, (side, z, r, mat, turn) in enumerate(NOSE_LINES):
        pts = [P(s0 + r + 0.002, side * (nose_wall_x(s0) - gap), z)]
        if turn:
            sd = nose_aft(xd) - gap
            pts += [P(sc, side * (nose_wall_x(sc) - gap), z), P(sd, side * xd, z), P(sd, side * xd, zd)]
        else:
            pts.append(P(sc + gap - r - 0.003, side * (nose_wall_x(sc) - gap), z))
        ob = _tube(f"NoseWell_Line{k}", coll, pts, r, mats[mat])
        objs[ob.name] = ob
    x, z, r = NOSE_ROOF_LINE
    ob = _tube(f"NoseWell_Line{len(NOSE_LINES)}", coll,
               [P(nose_front(x) + r + 0.002, x, z), P(nose_aft(x) - r - 0.002, x, z)], r, mats["chrome"])
    objs[ob.name] = ob
    for k, (side, sa, sb, z0, z1, dep, mat) in enumerate(NOSE_BOXES):
        if side == 0:
            ob = _box(f"NoseWell_Box{k}", coll, 0.0, dep, sa, sb, z0, z1, mats[mat])
        else:                                    # back face into the (converging) wall all along
            xo, xi = nose_wall_x(sa) + 0.004, nose_wall_x(sb) - dep
            ob = _box(f"NoseWell_Box{k}", coll, side * 0.5 * (xo + xi), xo - xi, sa, sb, z0, z1, mats[mat])
        objs[ob.name] = ob
    return objs


def nose_door_arms(coll, bvh, door, side):
    """Hinge arms on a nose-gear door's inner face (see NOSE_DOOR_ARMS, NOSE_ARM): a tapered plate standing
    on the door across it, tallest at the hinge end, with a hinge pin there (c22, c29: bright arms and
    gussets on the doors' inner faces; c20: a white fitting at the hinge end).  Parented to the door, so
    they swing with it; closed, they lie along the door's inner face next to the well wall."""
    h_root, h_tip, th = NOSE_ARM
    tag = "L" if side > 0 else "R"
    objs = {}
    n = 7
    for k, (s, inset, length) in enumerate(NOSE_DOOR_ARMS):
        xs = [nose_half_width(s) - inset - length * i / (n - 1) for i in range(n)]
        pts = [_skin_point(bvh, side * x, s) for x in xs]
        bot, top = [], []
        for i, p in enumerate(pts):
            tg = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
            nrm = Vector((-tg.z, 0.0, tg.x)).normalized()
            if nrm.z < 0:
                nrm = -nrm                       # into the well (the door's inner side)
            f = i / (n - 1)
            h = h_tip + (h_root - h_tip) * (1.0 - f) ** 1.5
            bot.append(p + nrm * 0.006)          # inside the door (outer face 2 mm proud, 18 mm thick)
            top.append(p + nrm * (0.016 + h))
        faces = [(i, i + 1, n + i + 1, n + i) for i in range(n - 1)]
        arm = mesh_object(f"NoseGearDoorArm_{tag}{k}", bot + top, faces, coll, M.get("gear"), smooth=False)
        add_solidify(arm, th, 0.0)
        c = top[0] - (top[0] - bot[0]).normalized() * 0.014
        pin = cylinder(f"NoseGearDoorArm_{tag}{k}_Pin", c - Vector((0, 0.035, 0)), c + Vector((0, 0.035, 0)),
                       0.016, None, coll, M.get("chrome"), segments=10)
        for ob in (arm, pin):
            mw = ob.matrix_world.copy()
            ob.parent = door
            ob.matrix_world = mw
            objs[ob.name] = ob
    return objs


def _body_of_revolution(name, coll, centre, prof, mat, seg=28):
    c = Vector(centre)
    rings = []
    for t, r in prof:
        rings.append([c + Vector((r * math.cos(2 * math.pi * k / seg), t,
                                  r * math.sin(2 * math.pi * k / seg))) for k in range(seg)])
    v, f = loft_rings(rings, True, True, True)
    ob = mesh_object(name, v, f, coll, mat, smooth=True, sharp_angle=40)
    _fix(ob)
    return ob


def _fins(ob, coll, name, c, roots, mat, angles=(45, 135, 225, 315), thick=0.006):
    """roots: list of (t0, t1, r_root, span, sweep_tip) per fin set."""
    for k, deg in enumerate(angles):
        a = math.radians(deg)
        dv = Vector((math.cos(a), 0, math.sin(a)))
        for j, (t0, t1, rr, span, tip) in enumerate(roots):
            p0 = c + Vector((0, t0, 0)) + dv * rr
            p1 = c + Vector((0, t1, 0)) + dv * rr
            p2 = c + Vector((0, t1, 0)) + dv * (rr + span)
            p3 = c + Vector((0, t1 - tip, 0)) + dv * (rr + span)
            fv = [p0, p1, p2, p3] if tip > 0 else [p0, p1, p2]
            ff = [tuple(range(len(fv)))]
            fin = mesh_object(f"{name}_fin{k}{j}", fv, ff, coll, mat, smooth=False)
            add_solidify(fin, thick, 0.0)
            fin.parent = ob


def build_amraam(coll, name, centre, length=3.65, r=0.0889):
    """AIM-120C class missile with clipped wings/fins for internal carriage."""
    c = Vector(centre)
    L = length
    prof = [(-L / 2, 0.0), (-L / 2 + 0.03, r * 0.30), (-L / 2 + 0.15, r * 0.70),
            (-L / 2 + 0.32, r * 0.95), (-L / 2 + 0.45, r), (L / 2 - 0.03, r), (L / 2, r * 0.80)]
    ob = _body_of_revolution(name, coll, c, prof, M.get("marking_white"))
    # seeker dome tint + grey band
    _fins(ob, coll, name, c, [(-0.30, 0.10, r, 0.11, 0.06), (L / 2 - 0.36, L / 2 - 0.02, r, 0.14, 0.10)],
          M.get("marking_white"))
    return ob


def build_jdam(coll, name, centre):
    """GBU-31(V)1 class 2,000 lb JDAM: Mk 84 body + tail kit + strakes."""
    c = Vector(centre)
    L, R = 3.88, 0.229
    prof = [(-L / 2, 0.0), (-L / 2 + 0.02, 0.05), (-L / 2 + 0.25, 0.14), (-L / 2 + 0.55, 0.20),
            (-L / 2 + 0.95, R), (0.55, R), (0.95, 0.205), (1.20, 0.18), (L / 2 - 0.05, 0.17),
            (L / 2, 0.12)]
    body = _body_of_revolution(name, coll, c, prof, M.get("marking_grey"))
    # yellow fuze band (live weapon marking)
    band = _body_of_revolution(f"{name}_Band", coll, c,
                               [(-L / 2 + 0.70, 0.2205), (-L / 2 + 0.70, 0.232), (-L / 2 + 0.78, 0.232),
                                (-L / 2 + 0.78, 0.2205)], M.get("marking_yellow"))
    band.parent = body
    _fins(body, coll, name, c, [(L / 2 - 0.55, L / 2 - 0.05, 0.17, 0.15, 0.10)], M.get("marking_grey"),
          thick=0.012)
    # mid-body strakes
    _fins(body, coll, f"{name}_strake", c, [(-0.30, 0.25, R, 0.07, 0.25)], M.get("marking_grey"),
          thick=0.008)
    # suspension lugs
    for t in (-0.25, 0.51):
        lug = cylinder(f"{name}_Lug{t:+.2f}", c + Vector((0, t, R - 0.01)), c + Vector((0, t, R + 0.05)),
                       0.018, None, coll, M.get("gear"), segments=8)
        lug.parent = body
    return body
