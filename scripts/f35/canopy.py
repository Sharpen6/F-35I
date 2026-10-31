"""One-piece, front-hinged F-35 canopy: gold-tinted transparency + frame."""
import math
import bmesh
from mathutils import Vector

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
SILL_W = Pchip([1.84, 1.95, 2.10, 2.40, 2.80, 3.20, 3.60, 4.00, 4.40, 4.70, 4.97],
               [0.0, 0.085, 0.205, 0.355, 0.455, 0.505, 0.525, 0.525, 0.51, 0.48, 0.44])
S_FRONT, S_GLASS_END, S_REAR = 1.84, 4.60, 4.97
HINGE_S, HINGE_Z = 1.90, 0.60
OPEN_ANGLE = 40.0                 # photos show ~30-40 deg
# Canopy bow: the dark arch inside the one-piece transparency, just ahead of the pilot's helmet.
# Photos c09 / c34: about 8-9 cm wide, a third of the way back, leaning forward at the top
# (station at the crest and at the sill).
BOW_CREST, BOW_SILL, BOW_W = 2.84, 3.01, 0.085
# Frame band round the lower edge of the transparency (photo c34: light grey, about 9 cm tall,
# carrying the "DO NOT CUT CANOPY WITHIN 3 INCHES OF CANOPY FRAME" stencil); it lifts with the canopy.
BAND_H = 0.09


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


def build_band(coll, side, s0=1.95, step=0.05):
    """Frame band outside the glass along one sill, from the front tip to the rear frame."""
    rings = []
    s = s0
    sts = []
    while s < S_GLASS_END - 1e-6:
        sts.append(s)
        s += step
    sts.append(S_GLASS_END)
    for s in sts:
        zs = fore_upper_z(s, min(SILL_W(s), 0.85)) - 0.005
        ub = min(0.9, BAND_H / max(1e-3, CREST(s) - zs))
        ths = [side * math.acos(min(1.0, (ub * k / 2) ** 0.95)) for k in range(3)]
        outer = [surface_point(s, th, -0.020)[0] for th in ths]
        inner = [surface_point(s, th, -0.013)[0] for th in reversed(ths)]
        rings.append(outer + inner)
    v, f = loft_rings(rings, True, True, True)
    ob = mesh_object(f"Canopy_Band_{'L' if side > 0 else 'R'}", v, f, coll, M.get("skin"))
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Canopy", root)
    # glass: open shell from front tip to rear frame
    sts = [S_FRONT + 0.004]
    s = 1.90
    while s < S_GLASS_END:
        sts.append(s)
        s += 0.05
    sts.append(S_GLASS_END)
    rings = [section(s) for s in sts]
    verts, faces = loft_rings(rings, close_ring=False)
    # pointed front: fan to the tip
    tip = len(verts)
    verts.append(P(S_FRONT, 0.0, CREST(S_FRONT)))
    nr = len(rings[0])
    for j in range(nr - 1):
        faces.append((tip, j + 1, j))
    glass = mesh_object("Canopy_Glass", verts, faces, coll, M.get("canopy"))
    bm = bmesh.new()
    bm.from_mesh(glass.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(glass.data)
    bm.free()
    add_solidify(glass, 0.012, 1.0)
    # frame: rear arch (opaque) + sill rails
    sts = [S_GLASS_END - 0.08 + 0.04 * i for i in range(int((S_REAR - S_GLASS_END + 0.08) / 0.04) + 1)]
    sts[-1] = S_REAR
    rings = [section(s, inset=-0.004) for s in sts]
    v2, f2 = loft_rings(rings, close_ring=False)
    # close the rear of the arch against the spine with a cap strip
    arch = mesh_object("Canopy_Frame", v2, f2, coll, M.get("skin"))
    add_solidify(arch, 0.03, -1.0)
    # sill rails (both sides)
    rails = []
    for side in (1, -1):
        rr = []
        s = S_FRONT + 0.06
        while s <= S_GLASS_END + 1e-6:
            w = SILL_W(s) + 0.006
            zs = fore_upper_z(s, min(SILL_W(s), 0.85))
            rr.append([P(s, side * (w - 0.035), zs + 0.045), P(s, side * w, zs + 0.012),
                       P(s, side * (w + 0.012), zs - 0.012), P(s, side * (w - 0.04), zs - 0.012)])
            s += 0.05
        v3, f3 = loft_rings(rr, True, True, True)
        rails.append(mesh_object(f"Canopy_Rail_{'L' if side > 0 else 'R'}", v3, f3, coll,
                                 M.get("canopy_frame")))
    for ob in rails:
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(ob.data)
        bm.free()
    bow = build_bow(coll)
    bands = [build_band(coll, side) for side in (1, -1)]
    for ob in [arch, bow] + bands + rails:
        ob.parent = glass
    p0 = P(HINGE_S, 0.4, HINGE_Z)
    p1 = P(HINGE_S, -0.4, HINGE_Z)
    set_hinge(glass, p0, p1, "canopy", (0.0, OPEN_ANGLE))
    ctx["objects"]["Canopy"] = glass
    return glass
