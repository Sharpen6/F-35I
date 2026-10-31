"""Openings cut into the airframe + doors that conform to the skin:

* two internal weapon bays, each with a keel-hinged inboard door (carrying
  the door-mounted AIM-120 station) and an outboard-hinged main door; both
  open "straight down" (~90-95 deg).  A GBU-31 class JDAM hangs from the
  main station in each bay.
* nose-gear well (two side doors hanging down when open)
* main-gear wells on the lower fuselage sides; one large door each, hinged
  at its upper (outboard) edge, opening outward/down (as in photos of
  parked F-35Is)
* GAU-22/A gun-port door on the left shoulder
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

BAY_S = (6.55, 10.75)          # weapon bay station range
BAY_X = (0.13, 1.09)           # inboard / outboard wall (each side)
BAY_Z = (-1.00, -0.32)
INNER_DOOR_X = (0.135, 0.455)
OUTER_DOOR_X = (0.465, 1.085)
NOSE_WELL = (-0.21, 0.21, 3.00, 4.65, -1.0, 0.04)       # x0 x1 s0 s1 z0 z1
MAIN_WELL_S = (8.60, 10.62)
# (x, z) cross-section of the main-gear well (left side; mirrored for right)
MAIN_WELL_POLY = [(1.13, -1.05), (1.95, -0.45), (1.95, -0.30), (1.67, -0.17),
                  (1.40, 0.45), (0.78, 0.40), (0.78, -0.25), (1.13, -0.30)]
MAIN_DOOR_CHORD = ((1.135, -0.862), (1.690, -0.185))    # skin points (x, z)


def _bvh(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    return BVHTree.FromObject(ob, dg)


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
    bvh = _bvh(fus)                      # rays are cast before cutting
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
    # nose gear doors (hinged at the outer edges, hang down when open)
    x0, x1, ns0, ns1, _, _ = NOSE_WELL
    for side, tag in ((1, "L"), (-1, "R")):
        door_specs.append((f"NoseGearDoor_{tag}",
                           lambda u, v, side=side: P(ns0 + 0.01 + (ns1 - ns0 - 0.02) * v,
                                                     side * (0.003 + (x1 - 0.006) * u), -2.5),
                           8, 20, up,
                           dict(kind="nose_door", side=side, hx=side * (x1 - 0.003), lim=90.0, sub="",
                                want=(0, 0, -1), s=(ns0 + 0.01, ns1 - 0.01), hz=None)))
    # main gear doors on the sloping lower side; hinged at the top edge
    (cx0, cz0), (cx1, cz1) = MAIN_DOOR_CHORD
    ch = Vector((cx1 - cx0, 0, cz1 - cz0)).normalized()
    for side, tag in ((1, "L"), (-1, "R")):
        nrm = Vector((side * -ch.z, 0, ch.x if False else -abs(ch.x)))
        nrm = Vector((side * abs(ch.z), 0, -abs(ch.x))).normalized()
        ms0, ms1 = MAIN_WELL_S

        def gf(u, v, side=side, nrm=nrm, ms0=ms0, ms1=ms1):
            x = cx0 + (cx1 - cx0) * u
            z = cz0 + (cz1 - cz0) * u
            return P(ms0 + 0.01 + (ms1 - ms0 - 0.02) * v, side * x, z) + nrm * 1.5
        door_specs.append((f"MainGearDoor_{tag}", gf, 12, 22, -nrm,
                           dict(kind="main_door", side=side, hx=side * cx1, lim=100.0, sub="",
                                want=(side, 0, 0), s=(ms0 + 0.01, ms1 - 0.01), hz=cz1)))
    doors = {}
    for name, fn, nu, nv, ray, meta in door_specs:
        d = surface_patch(name, coll, bvh, fn, nu, nv, ray, mat=M.get("skin"))
        d.data.materials.append(bay_mat)
        d.modifiers["Solidify"].material_offset = 1
        doors[name] = (d, meta)
    gun = surface_patch("GunDoor", coll, bvh,
                        lambda u, v: P(5.05 + 0.75 * v, 1.22 + 0.16 * u, 2.0), 6, 10, (0, 0, -1))
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
    cutters.append(_cavity("Cav_NoseGear", helpers, *NOSE_WELL, bay_mat))
    cutters.append(_cavity("Cav_Gun", helpers, 1.20, 1.40, 5.03, 5.82, 0.45, 1.2, M.get("intake_dark")))
    cutters.append(_cavity("Cav_Refuel", helpers, -0.13, 0.13, 5.53, 6.00, 1.05, 1.6, bay_mat))
    for cut in cutters:
        boolean(fus, cut, 'DIFFERENCE', apply=True)
        bpy.data.objects.remove(cut)
    fus.data.set_sharp_from_angle(angle=math.radians(35))
    # ------------------------------------------------------------- hinges
    for name, (d, meta) in doors.items():
        sa, sb = meta["s"]
        if meta["kind"] == "main_door":
            hz = meta["hz"]
            p0, p1 = P(sa, meta["hx"], hz), P(sb, meta["hx"], hz)
        else:
            # hinge line on the door's own edge (lowest skin point there)
            zs = [(ob_v.co.z) for ob_v in d.data.vertices]
            hz = _edge_z(d, meta["hx"])
            p0, p1 = P(sa, meta["hx"], hz), P(sb, meta["hx"], hz)
        set_hinge(d, p0, p1, meta["kind"], (0.0, meta["lim"]),
                  {"side": meta["side"], "door": meta["sub"], "want": list(meta["want"])})
        objs[name] = d
    set_hinge(gun, P(5.05, 1.38, 0.62), P(5.80, 1.38, 0.62), "gun_door", (0, 70),
              {"side": 1, "want": [0, 0, -1]})
    set_hinge(refuel, P(5.97, 0.11, 1.18), P(5.97, -0.11, 1.18), "refuel_door", (0, 100),
              {"side": 0, "want": [0, 0, -1]})
    objs["GunDoor"] = gun
    objs["RefuelDoor"] = refuel
    # ---------------------------------------------------- bay interiors
    gear_mat = M.get("gear")
    for side, tag in ((1, "L"), (-1, "R")):
        # roof rails + transverse frames
        for k, xx in enumerate((0.36, 0.95)):
            _box(f"BayRail_{tag}{k}", coll, side * xx, 0.025, s0 + 0.15, s1 - 0.15, -0.37, -0.32, gear_mat)
        for k in range(7):
            s = s0 + 0.25 + k * (s1 - s0 - 0.5) / 6
            _box(f"BayFrame_{tag}{k}", coll, side * 0.61, 0.95, s - 0.02, s + 0.02, -0.355, -0.32, bay_mat)
        # main station: bomb rack + GBU-31 class JDAM
        _box(f"BombRack_{tag}", coll, side * 0.76, 0.12, 7.85, 9.45, -0.36, -0.30, gear_mat)
        jd = build_jdam(wcoll, f"GBU31_{tag}", P(8.62, side * 0.76, -0.565))
        objs[jd.name] = jd
        # door station: AIM-120 on a launcher fixed to the inboard door
        door = objs[f"BayDoor_Inner_{tag}"]
        ms = build_amraam(wcoll, f"AIM120_{tag}", P(8.55, side * 0.30, -0.67))
        rail = _box(f"AMRAAM_Launcher_{tag}", wcoll, side * 0.30, 0.05, 7.80, 9.30, -0.845, -0.755,
                    gear_mat)
        for ob in [ms, rail]:
            mw = ob.matrix_world.copy()
            ob.parent = door
            ob.matrix_world = mw
        objs[ms.name] = ms
    ctx["objects"].update(objs)
    return objs


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
