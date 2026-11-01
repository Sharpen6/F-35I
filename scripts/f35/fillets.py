"""Lower wing-root fillets.

The wing and the body are separate solids, so below the wing root they
would meet in a sharp concave corner.  On the real aircraft that corner is
a broad blended fillet: head-on photos (c29, c50) show a rounded surface
above each main leg, and the aft main-gear door that hangs beside the leg
is a gently curved panel ~0.65-0.8 m tall (c29, c50, c51, c53), which only
fits a rounded corner.

Each fillet is a closed solid swept along the root.  In every station
plane the section is a curve tangent to the wing lower surface and to the
body side (both found by ray casts), closed through a point buried in the
corner.  The curve is a cubic Bezier: FILLET_K = 0.55 would be close to a
circular arc; the smaller value used here gives a flat, softly rounded
facet, so the aft gear door cut from it hangs as a nearly flat panel, as in
the head-on photos.  The size tapers to zero at both ends.  The fillets
are separate objects with the skin material; the main-gear wells cut them
like the wings (bays.py).
"""
import math

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .geom import P, get_collection, mesh_object, loft_rings
from . import materials as M

FILLET_S = (6.90, 11.35)        # first / last station: starts under the inboard root LE so the
FILLET_FULL = (7.60, 10.85)     # inlet side fairs into the wing (photos c10, c22, c53, ref_07)
FILLET_R = 0.50                 # size, as the radius of the equivalent circular fillet (m)
FILLET_K = 0.12                 # Bezier handle length (fraction of the tangent distance)
N_ARC = 14                      # points on each section curve


def _ss(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def radius(s):
    return FILLET_R * _ss(FILLET_S[0], FILLET_FULL[0], s) * (1.0 - _ss(FILLET_FULL[1], FILLET_S[1], s))


def _bvh(obs):
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


def _up(bvh, s, x):
    """z of the first surface above (x, s) seen from below."""
    h = bvh.ray_cast(P(s, x, -3.0), Vector((0, 0, 1)), 10.0)
    return None if h[0] is None else h[0].z


def _inward(bvh, s, z):
    """x of the body side at height z (ray from outboard, left side)."""
    h = bvh.ray_cast(P(s, 4.0, z), Vector((-1, 0, 0)), 5.0)
    return None if h[0] is None else h[0].x


def _line_hit(p, d, q, e):
    """Intersection of 2-D lines p + t d and q + u e."""
    den = d.x * e.y - d.y * e.x
    if abs(den) < 1e-9:
        return None
    t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den
    return p + d * t


def section(bvh, s, r, prev=None):
    """(x, z) polygon of the fillet at station s (left side), or None."""
    zw = _up(bvh, s, 2.30)
    if zw is None:
        zw = prev["zw"] if prev else 0.12
    xb1, xb2 = _inward(bvh, s, zw - 0.05), _inward(bvh, s, zw - 0.40)
    if xb1 is None or xb2 is None:
        return None
    pa = Vector((xb1, zw - 0.05))
    db = Vector((xb2 - xb1, -0.35)).normalized()           # down the body side
    xa, xc = xb1 + 0.12, xb1 + 0.55
    za, zc = _up(bvh, s, xa), _up(bvh, s, xc)
    if za is not None and zc is not None:
        qa = Vector((xa, za))
        dw = Vector((xc - xa, zc - za)).normalized()       # outboard along the wing
    elif prev:
        qa, dw = Vector((xa, prev["zw"])), prev["dw"]
    else:
        qa, dw = Vector((xa, zw)), Vector((1.0, 0.0))
    K = _line_hit(pa, db, qa, dw)
    if K is None:
        return None
    half = 0.5 * math.acos(max(-1.0, min(1.0, dw.dot(db))))
    b = (dw + db).normalized()                              # into the air
    r = max(r, 0.003)
    t = r / math.tan(half)                                  # tangent distance from the corner
    pw, pb = K + dw * t, K + db * t
    nw = (b - dw * b.dot(dw)).normalized()                  # outward normals
    nb = (b - db * b.dot(db)).normalized()
    h0, h1 = pw - dw * (t * FILLET_K), pb - db * (t * FILLET_K)
    arc = []
    for k in range(N_ARC):
        u = k / (N_ARC - 1)
        w = 1.0 - u
        arc.append(pw * (w * w * w) + h0 * (3 * w * w * u) + h1 * (3 * w * u * u) + pb * (u * u * u))
    # short run-outs along each surface, tilted slightly into the solid so
    # the seam is a clean intersection (no coplanar faces)
    pw2 = pw + dw * 0.05 - nw * 0.004
    pb2 = pb + db * 0.05 - nb * 0.004
    kin = K - b * 0.10                                      # buried in the corner
    poly = [pw2] + arc + [pb2, kin]
    return {"poly": poly, "zw": zw, "dw": dw, "K": K, "r": r}


def _fix(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Airframe", root)
    fus = ctx["objects"]["Fuselage"]
    wing = ctx["objects"].get("Wing_L")
    bvh = _bvh([fus, wing])
    stations, s = [], FILLET_S[0]
    while s < FILLET_S[1] - 1e-6:
        stations.append(s)
        in_taper = s < FILLET_FULL[0] or s > FILLET_FULL[1]
        s += 0.07 if in_taper else 0.12
    stations.append(FILLET_S[1])
    secs, prev = [], None
    for s in stations:
        sec = section(bvh, s, radius(s), prev)
        if sec is not None:
            secs.append((s, sec))
            prev = sec
    objs = {}
    for side, tag in ((1, "L"), (-1, "R")):
        rings = [[P(s, side * q.x, q.y) for q in sec["poly"]] for s, sec in secs]
        v, f = loft_rings(rings, close_ring=True)
        # end caps fanned from the buried corner point (the arc is concave,
        # so a centroid fan would fold outside the section)
        n = len(rings[0])
        for base in (0, (len(rings) - 1) * n):
            f.extend((base + n - 1, base + j, base + j + 1) for j in range(n - 2))
        ob = mesh_object(f"WingFillet_{tag}", v, f, coll, M.get("skin"), smooth=True, sharp_angle=40)
        _fix(ob)
        objs[ob.name] = ob
    ctx["objects"].update(objs)
    ctx["fillet_sections"] = [(s, round(sec["K"].x, 3), round(sec["K"].y, 3), round(sec["r"], 3))
                              for s, sec in secs]
    return objs
