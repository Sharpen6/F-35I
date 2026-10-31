"""F135 axisymmetric convergent-divergent nozzle with serrated petals.

Shape key 'AB_Open' opens the exit for afterburner; the rig drives it."""
import math
import bmesh
import bpy

from .geom import P, get_collection, mesh_object, loft_rings
from .fuselage import NOZ_Z, NOZ_SHROUD_S
from . import materials as M

PETALS = 15
S_START = 13.10
S_EXIT = 13.97
R_START = 0.575
R_EXIT = 0.405
R_EXIT_OPEN = 0.505


def _ring(s, r, n, phase=0.0, tooth=0.0, facet=0.0):
    pts = []
    for i in range(n):
        a = 2 * math.pi * (i + phase) / n
        rr = r
        if facet:
            # flat petals: shrink between petal centres
            k = (i % 2)
            rr = r * (1 - facet * (1 - k))
        ss = s - (tooth if i % 2 == 0 else 0.0)
        pts.append(P(ss, rr * math.cos(a), NOZ_Z + rr * math.sin(a)))
    return pts


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Engine", root)
    n = PETALS * 2
    # --- outer petal shell (closed: outer surface + inner liner + edges)
    st = [S_START, 13.30, 13.45, 13.60, 13.75, 13.88, S_EXIT]
    rings_out, rings_in = [], []
    for k, s in enumerate(st):
        f = (s - S_START) / (S_EXIT - S_START)
        r = R_START + (R_EXIT - R_START) * (f ** 1.15)
        tooth = 0.075 if s == S_EXIT else 0.0
        rings_out.append(_ring(s, r, n, tooth=tooth, facet=0.012))
        rings_in.append(_ring(s, r - 0.025, n, tooth=tooth))
    rings = rings_out + list(reversed(rings_in))
    verts, faces = loft_rings(rings, True, False, False)
    # close the front (start) between outer and inner start rings is already
    # handled because rings list wraps outer->inner; close the start gap:
    nr = len(rings)
    base0, basel = 0, (nr - 1) * n
    for j in range(n):
        j1 = (j + 1) % n
        faces.append((basel + j, basel + j1, base0 + j1, base0 + j))
    noz = mesh_object("Nozzle", verts, faces, coll, M.get("nozzle"), smooth=True)
    bm = bmesh.new()
    bm.from_mesh(noz.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(noz.data)
    bm.free()
    noz.data.set_sharp_from_angle(angle=math.radians(25))
    noz.data.materials.append(M.get("nozzle_in"))
    # inner liner faces -> second material (faces whose centre radius < outer)
    me = noz.data
    for p in me.polygons:
        c = p.center
        r = math.hypot(c.x, c.z - NOZ_Z)
        s = c.y + 15.67 / 2
        f = min(1, max(0, (s - S_START) / (S_EXIT - S_START)))
        r_out = R_START + (R_EXIT - R_START) * (f ** 1.15)
        if r < r_out - 0.012:
            p.material_index = 1
    # shape key: afterburner open (scale exit radius)
    noz.shape_key_add(name="Basis")
    sk = noz.shape_key_add(name="AB_Open")
    for i, v in enumerate(me.vertices):
        co = v.co
        s = co.y + 15.67 / 2
        f = min(1, max(0, (s - S_START) / (S_EXIT - S_START)))
        r = math.hypot(co.x, co.z - NOZ_Z)
        if r < 1e-6:
            continue
        target_exit = R_EXIT_OPEN / R_EXIT
        scale = 1 + (target_exit - 1) * (f ** 1.6)
        sk.data[i].co.x = co.x * scale
        sk.data[i].co.z = NOZ_Z + (co.z - NOZ_Z) * scale
    # --- turbine / augmentor face deep inside (dark) + tail cone
    face_rings = [_ring(12.95, 0.56, 32), _ring(12.95, 0.001, 32)]
    v2, f2 = loft_rings(face_rings, True, False, False)
    face = mesh_object("Engine_Face", v2, f2, coll, M.get("intake_dark"), smooth=False)
    cone_r = [_ring(12.90, 0.22, 24), _ring(13.25, 0.12, 24), _ring(13.42, 0.01, 24)]
    v3, f3 = loft_rings(cone_r, True, False, True)
    cone = mesh_object("Engine_TailCone", v3, f3, coll, M.get("nozzle_in"))
    # flame holder ring
    fh = [_ring(13.02, 0.36, 32), _ring(13.02, 0.33, 32), _ring(13.08, 0.33, 32), _ring(13.08, 0.36, 32)]
    v4, f4 = loft_rings(fh, True, False, False)
    nb = len(fh[0])
    for j in range(nb):
        j1 = (j + 1) % nb
        f4.append((3 * nb + j, 3 * nb + j1, j1, j))
    holder = mesh_object("Engine_FlameHolder", v4, f4, coll, M.get("nozzle_in"), smooth=False)
    for ob in (face, cone, holder):
        ob.parent = noz
    ctx["objects"]["Nozzle"] = noz
    noz["hinge_kind"] = "nozzle"
    return noz
