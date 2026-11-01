"""One-piece, front-hinged F-35 canopy: gold-tinted transparency in an opaque frame, and the fixed
spine fairing that carries the canopy's section on aft."""
import math
import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .geom import P, Pchip, get_collection, mesh_object, loft_rings, add_solidify, Y0
from .fuselage import fore_upper_z
from .surfaces import set_hinge
from . import materials as M

# crest line from the side view; ~3 cm lower than the 3-view drawing in the
# middle because three camera-matched photos put the canopy top that much lower
CREST = Pchip([1.84, 2.00, 2.20, 2.40, 2.60, 2.80, 3.00, 3.20, 3.40, 3.70,
               4.00, 4.20, 4.40, 4.60, 4.80, 4.97],
              [0.625, 0.74, 0.87, 0.985, 1.104, 1.205, 1.264, 1.307, 1.328, 1.332,
               1.328, 1.315, 1.296, 1.276, 1.259, 1.248])
# sill half width: front half from the 3-view's plan view (glass ~0.30 m at s 2.2, 0.44 at 2.6,
# 0.52 at 3.0, 0.54 at 3.2-3.4) and the head-on photo c29 (canopy ~0.55 m at its widest)
SILL_W = Pchip([1.84, 1.95, 2.10, 2.40, 2.80, 3.20, 3.60, 4.00, 4.40, 4.70, 4.97],
               [0.0, 0.12, 0.27, 0.40, 0.51, 0.55, 0.55, 0.53, 0.51, 0.48, 0.44])
S_FRONT, S_GLASS_END, S_REAR = 1.84, 4.60, 4.97      # S_REAR: end of the CREST / SILL_W tables
HINGE_S, HINGE_Z = 1.90, 0.60
OPEN_ANGLE = 40.0                 # photos show ~30-40 deg
# Canopy bow: the dark arch inside the one-piece transparency, just ahead of the pilot's helmet.
# Photos c09 / c34: about 8-9 cm wide, a third of the way back, leaning forward at the top
# (station at the crest and at the sill).
BOW_CREST, BOW_SILL, BOW_W = 2.84, 3.01, 0.085
# Frame round the transparency (photos c34, c14, c09, c51, c53; 3-view ref_09): a flat band flush
# with the glass, carrying the "DO NOT CUT CANOPY WITHIN 3 INCHES OF CANOPY FRAME" stencil.  In
# side view it is a chevron of constant width: its upper edge (the edge of the glass) is two
# straight lines, almost level from the windscreen base to a V right under the bow foot, then
# straight up to the rear, where it turns up in a tight corner into the rear edge of the glass
# (near vertical, leaning aft at the top); its lower edge runs parallel to it, BAND_W lower, with
# its own sharp V under the glass V, and meets the rear frame's aft edge in a square corner.  Ahead
# of s ~2.1 the frame covers the whole canopy (the windscreen base, a chevron in plan); behind the
# glass it is a ~0.1 m straight pillar, behind which the spine fairing carries the canopy's section
# on aft, flush but for a small lip.  Below the band, down to the sill, the canopy's surface is
# fuselage skin (Canopy_Sill) that stays put when the canopy opens.
# (s, z) of the band's top: 3-view ref_09 (side view, x6) has the glass edge ~0.61-0.63 m from
# the windscreen (glass from s ~1.9 on the crest) back to a V at s ~3.0 under the bow foot, then
# straight up at ~15 deg to the rear corner.  The V and the aft run sit 3.5 cm higher than that
# drawing: c34, c09 and c51 measured against the crest and the chine put the glass 3.3-3.9 cm
# higher from the V to s ~3.75 (aft run parallel to the drawing's) with the band's lower V on the
# sill, so a band of constant width fits above the sill without the sill's dip at s ~2.7.
GLASS_LINE = [(1.84, 0.70), (3.00, 0.672), (4.47, 1.030)]     # front run drops ~1.5 deg aft
GLASS_REAR = (4.575, 0.99, 12.0)       # rear edge of the glass: through (s, z), leaning aft (deg)
GLASS_CORNER_R = 0.03                   # tight glass corner (c34, c51; ref_05 of 901 open)
FRAME_W = 0.105                         # rear frame, measured along s behind the glass edge
FRAME_T = 0.012                         # glass and frame thickness (solidified outwards)
# frame band width square to the glass edge in side view: c34 has the band 0.115-0.127 m tall
# (s 2.3-3.75, against 0.899 m from chine to crest at the V), ref_05 (901, canopy open) the same
# width on both runs, c09 and c51 ~0.12 m; at 0.115 the lower V stays clear of the sill
BAND_W = 0.115
# the band's lower edge is a dark gap over a lit step line (c34, c51): the sill strip below it
# stands this much proud of the band; where the band reaches the sill (ahead of s ~2.1) a sliver of
# strip SILL_MIN tall is kept so the band never shares an edge with the forebody
SILL_STEP = 0.003
SILL_MIN = 0.0015
SILL_SKIRT = 0.02                       # the sill strip runs on this far down inside the forebody
FAIR_END = 5.30                         # the spine fairing has blended into the fuselage by here


def section(s, n=40, inset=0.0, th0=-math.pi / 2, th1=math.pi / 2):
    w = max(1e-4, SILL_W(s) - inset)
    zs = fore_upper_z(s, min(SILL_W(s), 0.85)) - 0.005
    zt = CREST(s) - inset
    pts = []
    for i in range(n + 1):
        th = th0 + (th1 - th0) * i / n
        st, ct = math.sin(th), math.cos(th)
        u = abs(ct) ** (2 / 1.9)                 # height fraction sill -> crest
        # head-on photos: sides lean inward (half width ~0.79 w at mid height)
        x = w * math.copysign(math.sqrt(max(0.0, 1.0 - u ** 1.35)), st)
        z = zs + (zt - zs) * u
        pts.append(P(s, x, z))
    return pts


def surface_point(s, th, inset=0.0):
    """Point of the canopy surface at station s and section angle th (-pi/2 sill .. 0 crest ..
    pi/2 other sill), moved `inset` inwards; also returns the height fraction u (0 sill, 1 crest)."""
    w = max(1e-4, SILL_W(s) - inset)
    zs = fore_upper_z(s, min(SILL_W(s), 0.85)) - 0.005 + inset * 0.5
    zt = CREST(s) - inset
    st, ct = math.sin(th), math.cos(th)
    u = abs(ct) ** (2 / 1.9)
    x = w * math.copysign(math.sqrt(max(0.0, 1.0 - u ** 1.35)), st)
    return P(s, x, zs + (zt - zs) * u), u


def build_bow(coll, n=48):
    """The canopy bow: a dark band lining the inside of the transparency from sill to sill."""
    rings = []
    for i in range(n + 1):
        th = -math.pi / 2 + math.pi * i / n
        u = abs(math.cos(th)) ** (2 / 1.9)
        sc = BOW_SILL + (BOW_CREST - BOW_SILL) * u
        s0, s1 = sc - BOW_W / 2, sc + BOW_W / 2
        rings.append([surface_point(s0, th, 0.004)[0], surface_point(s1, th, 0.004)[0],
                      surface_point(s1, th, 0.030)[0], surface_point(s0, th, 0.030)[0]])
    v, f = loft_rings(rings, True, True, True)
    ob = mesh_object("Canopy_Bow", v, f, coll, M.get("canopy_bow"))
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def _outward(s, th, h=0.01):
    """Canopy surface point at (s, th) and its outward unit normal (finite differences)."""
    p = surface_point(s, th)[0]
    d_s = surface_point(s + h, th)[0] - surface_point(s - h, th)[0]
    d_t = surface_point(s, th - math.copysign(h, th))[0] - p      # one step towards the crest
    n = d_s.cross(d_t)
    c = P(s, 0.0, fore_upper_z(s, min(SILL_W(s), 0.85)) - 0.05)
    if n.dot(p - c) < 0:
        n = -n
    return p, n.normalized()


def sill_z(s):
    """Height of the canopy's lower edge (on the forebody's upper surface) at station s."""
    return fore_upper_z(s, min(SILL_W(s), 0.85)) - 0.005


_OUTLINE = []


def glass_outline():
    """Side-view outline of the glass edge as a polyline (s, z), s increasing: the frame band's
    upper edge (straight lines with the V under the bow foot), the rounded rear corner and the
    rear edge of the glass up past the crest."""
    if _OUTLINE:
        return _OUTLINE
    (s0, z0), (s1, z1), (s2, z2) = GLASS_LINE
    d = Vector((s2 - s1, z2 - z1)).normalized()
    sr, zr, lean = GLASS_REAR
    e = Vector((math.sin(math.radians(lean)), math.cos(math.radians(lean))))
    a, b = Vector((s1, z1)), Vector((sr, zr))
    det = d.x * (-e.y) + d.y * e.x
    t = ((b.x - a.x) * (-e.y) + (b.y - a.y) * e.x) / det
    x = a + d * t                                       # corner before rounding
    turn = math.acos(max(-1.0, min(1.0, d.dot(e))))
    tl = GLASS_CORNER_R * math.tan(turn / 2)
    t2, t3 = x - d * tl, x + e * tl
    c = t2 + Vector((-d.y, d.x)) * GLASS_CORNER_R
    a0 = math.atan2(t2.y - c.y, t2.x - c.x)
    a1 = math.atan2(t3.y - c.y, t3.x - c.x)
    pts = [(s0, z0), (s1, z1), (t2.x, t2.y)]
    n = 12
    for i in range(1, n):
        an = a0 + (a1 - a0) * i / n
        pts.append((c.x + GLASS_CORNER_R * math.cos(an), c.y + GLASS_CORNER_R * math.sin(an)))
    pts.append((t3.x, t3.y))
    top = x + e * ((1.6 - x.y) / e.y)
    pts.append((top.x, top.y))
    _OUTLINE.extend(pts)
    return _OUTLINE


def glass_edge_z(s):
    pts = glass_outline()
    if s <= pts[0][0]:
        return pts[0][1]
    for (sa, za), (sb, zb) in zip(pts, pts[1:]):
        if s <= sb:
            return za + (zb - za) * (s - sa) / max(1e-9, sb - sa)
    return 9.0


def _cross2(a, b):
    return a.x * b.y - a.y * b.x


def _meet(p, d, q, e):
    """Intersection of the 2-D lines p + t d and q + t e."""
    return p + d * (_cross2(q - p, e) / _cross2(d, e))


_BAND = []


def band_outline():
    """Side-view polyline (s, z) of the frame band's lower edge: both straight runs of GLASS_LINE
    moved BAND_W square to themselves, meeting in a sharp V under the glass V, and ending in the
    square corner with the rear frame's aft edge (rear_edge_s + FRAME_W)."""
    if _BAND:
        return _BAND
    (s0, z0), (s1, z1), (s2, z2) = (Vector(p) for p in GLASS_LINE)
    d0 = Vector((s1 - s0, z1 - z0)).normalized()
    d1 = Vector((s2 - s1, z2 - z1)).normalized()
    a0 = Vector((s0, z0)) + Vector((d0.y, -d0.x)) * BAND_W        # (d.y, -d.x): below a run going aft
    a1 = Vector((s1, z1)) + Vector((d1.y, -d1.x)) * BAND_W
    v = _meet(a0, d0, a1, d1)
    sr, zr, lean = GLASS_REAR
    e = Vector((math.sin(math.radians(lean)), math.cos(math.radians(lean))))
    c = _meet(a1, d1, Vector((sr + FRAME_W, zr)), e)
    _BAND.extend([(a0.x, a0.y), (v.x, v.y), (c.x, c.y)])
    return _BAND


def band_corner():
    """(s, z) of the band's lower aft corner, where the rear pillar's aft edge starts."""
    return band_outline()[-1]


def band_low_z(s):
    """Height of the frame band's lower edge at station s: the straight chevron of band_outline,
    or SILL_MIN above the sill where that would run below it (the windscreen base)."""
    pts = band_outline()
    (sa, za), (sb, zb) = pts[0], pts[1]
    for p, q in zip(pts, pts[1:]):
        if s >= p[0]:
            (sa, za), (sb, zb) = p, q
    s_ = min(s, pts[-1][0])
    z = za + (zb - za) * (s_ - sa) / max(1e-9, sb - sa)
    return max(z, sill_z(s) + SILL_MIN)


def band_u(s):
    """Height fraction (0 sill .. 1 crest) of the band's lower edge at station s."""
    zs, zt = sill_z(s), CREST(s)
    if zt - zs < 1e-4:
        return 0.0
    return min(0.5, max(0.0, (band_low_z(s) - zs) / (zt - zs)))


def rear_edge_s(z):
    """Station of the (straight part of the) glass's rear edge at height z."""
    sr, zr, lean = GLASS_REAR
    return sr + (z - zr) * math.tan(math.radians(lean))


def glass_u(s):
    """Height fraction (0 sill .. 1 crest) of the glass edge at station s (1: no glass here)."""
    zs, zt = sill_z(s), CREST(s)
    if zt - zs < 1e-4:
        return 1.0
    return min(1.0, max(0.0, (glass_edge_z(s) - zs) / (zt - zs)))


def th_of_u(u, side=1):
    return side * math.acos(min(1.0, max(0.0, u)) ** 0.95)


def glass_span():
    """Stations where the glass begins (front apex on the crest) and ends (rear apex)."""
    def f(s):
        return CREST(s) - glass_edge_z(s)

    def root(lo, hi):
        flo = f(lo)
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            fm = f(mid)
            if (fm > 0) == (flo > 0):
                lo, flo = mid, fm
            else:
                hi = mid
        return 0.5 * (lo + hi)
    return root(S_FRONT + 0.01, 2.8), root(4.0, S_REAR)


def _span(a, b, step):
    n = max(1, int(math.ceil((b - a) / step)))
    return [a + (b - a) * i / n for i in range(n + 1)]


def glass_stations():
    a, b = glass_span()
    st = set(round(s, 5) for s in _span(a + 0.003, b - 0.003, 0.04))
    st |= set(round(s, 5) for s in _span(a + 0.003, min(b, a + 0.12), 0.006))
    st |= set(round(s, 5) for s in _span(max(a, b - 0.16), b - 0.003, 0.006))
    return a, b, sorted(st)


def frame_end_s(u):
    """Aft end of the rear frame for the frame column at height fraction u (straight, leaning
    aft like the glass edge, FRAME_W behind it)."""
    s = 4.70
    for _ in range(8):
        z = sill_z(s) + (CREST(s) - sill_z(s)) * u
        s = rear_edge_s(z) + FRAME_W
    return s


def _orient_outwards(ob):
    """Make the face normals of an open canopy-surface mesh point away from the cockpit."""
    me = ob.data
    me.update()
    score = 0.0
    for p in me.polygons:
        c = p.center
        s = c.y + Y0
        axis = P(s, 0.0, sill_z(min(max(s, S_FRONT), S_REAR)) - 0.05)
        score += p.normal.dot(c - axis) * p.area
    if score < 0:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        me.update()


def build_glass(coll):
    a, b, sts = glass_stations()
    n = 40
    rings = []
    for s in sts:
        tb = th_of_u(glass_u(s))
        rings.append([surface_point(s, -tb + 2 * tb * j / n)[0] for j in range(n + 1)])
    verts, faces = loft_rings(rings, close_ring=False)
    nr = n + 1
    tip = len(verts)
    verts.append(P(a, 0.0, CREST(a)))
    for j in range(n):
        faces.append((tip, j + 1, j))
    tail = len(verts)
    verts.append(P(b, 0.0, CREST(b)))
    base = (len(rings) - 1) * nr
    for j in range(n):
        faces.append((tail, base + j, base + j + 1))
    glass = mesh_object("Canopy_Glass", verts, faces, coll, M.get("canopy"))
    _orient_outwards(glass)
    add_solidify(glass, FRAME_T, 1.0)
    # split the sharp rim: with smooth normals the solidify rim bends the last row of glass
    # normals and the glass shows a 3 cm amber band along the frame (photos show a hairline)
    es = glass.modifiers.new("EdgeSplit", 'EDGE_SPLIT')
    es.split_angle = math.radians(30.0)
    return glass


def band_stations():
    """Stations of the frame's (and the sill strip's) sections, nose to the band's aft corner,
    and the glass span (a, b)."""
    a, b, gst = glass_stations()
    front = [s for s in _span(S_FRONT + 0.004, a, 0.02)]
    rear = [s for s in _span(b, band_corner()[0] - 0.004, 0.012)]
    return a, b, front + gst + rear


def corner_u():
    """Height fraction of the band's aft corner on its station (the foot of the pillar's aft edge)."""
    sc, zc = band_corner()
    return (zc - sill_z(sc)) / (CREST(sc) - sill_z(sc))


def _col_point(s, u, side):
    """Canopy surface point at station s and height fraction u on `side`; u < 0 carries the
    surface's (vertical) foot on straight down below the sill."""
    if u >= 0.0:
        return surface_point(s, th_of_u(u, side))[0]
    return surface_point(s, th_of_u(0.0, side))[0] + Vector((0.0, 0.0, (CREST(s) - sill_z(s)) * u))


def _two_sided(name, coll, mat, cols, end):
    """Mesh of a strip of the canopy surface on both sides, nose to the band's aft corner:
    cols(s, a, b) gives the height fractions of the section's columns at station s (sill side
    first), `end` those of the last section, which lies on the rear frame's straight aft edge
    (each column at its own frame_end_s).  Both halves' first sections are fanned to the nose."""
    a, b, sts = band_stations()
    k_cols = len(end) - 1
    halves = []
    for side in (1, -1):
        rings = []
        for s in sts:
            us = cols(s, a, b)
            if side < 0:
                us = us[::-1]
            # below the band's aft corner the aft edge leans forward: a column never runs past it
            rings.append([_col_point(min(s, frame_end_s(u)), u, side) for u in us])
        us = end if side > 0 else end[::-1]
        rings.append([_col_point(frame_end_s(u), u, side) for u in us])
        halves.append(rings)
    verts, faces = [], []
    for rings in halves:
        v, f = loft_rings(rings, close_ring=False)
        o = len(verts)
        verts.extend(v)
        faces.extend([tuple(i + o for i in fc) for fc in f])
    t = len(verts)
    verts.append(P(S_FRONT, 0.0, CREST(S_FRONT)))
    nper = (len(sts) + 1) * (k_cols + 1)
    for h in range(2):
        for k in range(k_cols):
            faces.append((t, h * nper + k + 1, h * nper + k))
    ob = mesh_object(name, verts, faces, coll, mat)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)     # halves meet on the crest / nose
    bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=bm.edges)  # columns clamped onto the aft edge
    bm.to_mesh(ob.data)
    bm.free()
    _orient_outwards(ob)
    return ob


def build_frame(coll, k_cols=6):
    """The opaque frame: both side bands from their straight lower edge (band_outline) up to the
    glass, the windscreen base ahead of the glass and the rear pillar behind it, as one surface
    flush with the glass (same thickness, shared edge).  Opens with the canopy."""
    def cols(s, a, b):
        ub = glass_u(s) if a < s < b else 1.0
        ul = band_u(s)
        return [ul + (ub - ul) * k / k_cols for k in range(k_cols + 1)]
    uc = corner_u()
    end = [uc + (1.0 - uc) * k / k_cols for k in range(k_cols + 1)]
    ob = _two_sided("Canopy_Frame", coll, M.get("skin"), cols, end)
    add_solidify(ob, FRAME_T, 1.0)
    # crisp rims: the pillar's aft edge and the band's lower edge read as sharp steps (c34, c51)
    es = ob.modifiers.new("EdgeSplit", 'EDGE_SPLIT')
    es.split_angle = math.radians(30.0)
    return ob


def build_sill(coll, k_cols=2):
    """The strip of fuselage skin between the forebody's upper surface (the canopy sill) and the
    frame band's lower edge, back to the pillar's aft edge: the canopy's section carried on by the
    fixed structure, so it stays put when the canopy opens.  It stands SILL_STEP proud of the frame
    (the lit step line along the band's lower edge) and runs on SILL_SKIRT below the sill, inside
    the forebody, so no shadowed lip shows where the two meet."""
    def skirt(s):
        return -SILL_SKIRT / max(1e-3, CREST(s) - sill_z(s))

    def cols(s, a, b):
        ul = band_u(s)
        return [skirt(s)] + [ul * k / k_cols for k in range(k_cols + 1)]
    uc = corner_u()
    sc = band_corner()[0]
    end = [skirt(sc)] + [uc * k / k_cols for k in range(k_cols + 1)]
    ob = _two_sided("Canopy_Sill", coll, M.get("skin"), cols, end)
    add_solidify(ob, FRAME_T + SILL_STEP, 1.0)
    es = ob.modifiers.new("EdgeSplit", 'EDGE_SPLIT')
    es.split_angle = math.radians(30.0)
    return ob


def frame_end_ring(k_cols=6, lift=0.004):
    """Aft edge of the frame (left sill over the crest to the right sill), `lift` outside the
    canopy surface, with the outward normal at each point."""
    pts = []
    for side, ks in ((1, range(k_cols + 1)), (-1, range(k_cols - 1, -1, -1))):
        for k in ks:
            u = k / k_cols
            s = frame_end_s(u)
            th = th_of_u(u, side)
            p = surface_point(s, th)[0]
            q1 = surface_point(s, th - math.copysign(0.01, th) if abs(th) > 0.011 else th + 0.01)[0]
            q2 = surface_point(s + 0.01, th)[0]
            n = (q2 - p).cross(q1 - p)
            c = P(s, 0.0, sill_z(s) - 0.05)
            if n.dot(p - c) < 0:
                n = -n
            n.normalize()
            pts.append((p + n * lift, n))
    return pts


def build_fairing(ctx, coll, rings_n=10):
    """Fixed spine fairing behind the canopy: starts on the canopy's section just aft of the rear
    frame (a few mm lower: the lip of the frame shows, as in photo c34) and blends into the
    fuselage's own section by FAIR_END.  The fuselage dips behind the canopy otherwise."""
    fus = ctx["objects"].get("Fuselage")
    if fus is None:
        return None
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(fus, dg)
    mw = fus.matrix_world
    inv = mw.inverted()
    start = [(p + Vector((0.0, 0.002, 0.0)), n) for p, n in frame_end_ring()]
    zc = sum(p.z for p, _ in start) / len(start) - 0.12
    target = []
    for p, n in start:
        d = Vector((p.x, 0.0, p.z - zc))
        d = d.normalized() if d.length > 1e-6 else Vector((0, 0, 1))
        o = P(FAIR_END, 0.0, zc) + d * 2.5
        hit = bvh.ray_cast(inv @ o, (inv.to_3x3() @ -d).normalized(), 4.0)
        if hit[0] is None:
            target.append(P(FAIR_END, p.x, p.z))
        else:
            target.append(mw @ hit[0] - d * 0.006)
    rings = []
    for j in range(rings_n + 1):
        t = j / rings_n
        w = t * t * (3 - 2 * t)
        ring = []
        for (p, _), q in zip(start, target):
            r = p.lerp(q, w)
            r.y = p.y + (q.y - p.y) * t
            ring.append(r)
        rings.append(ring)
    v, f = loft_rings(rings, close_ring=False, cap_start=True)
    ob = mesh_object("Spine_Fairing", v, f, coll, M.get("skin"))
    ob.data.materials.append(M.get("cockpit"))
    ncap = len(rings[0]) - 1
    for p in ob.data.polygons[-ncap:]:
        p.material_index = 1                    # the bulkhead seen when the canopy is open
    _orient_outwards(ob)
    return ob


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Canopy", root)
    glass = build_glass(coll)
    frame = build_frame(coll)
    bow = build_bow(coll)
    for ob in (frame, bow):
        ob.parent = glass
    fus = ctx["objects"].get("Fuselage")
    fcoll = fus.users_collection[0] if fus is not None else coll
    ctx["objects"]["Canopy_Sill"] = build_sill(fcoll)        # fixed: not parented to the glass
    fair = build_fairing(ctx, fcoll)
    if fair is not None:
        ctx["objects"]["Spine_Fairing"] = fair
    p0 = P(HINGE_S, 0.4, HINGE_Z)
    p1 = P(HINGE_S, -0.4, HINGE_Z)
    set_hinge(glass, p0, p1, "canopy", (0.0, OPEN_ANGLE))
    ctx["objects"]["Canopy"] = glass
    return glass
