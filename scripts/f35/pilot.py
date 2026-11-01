"""Seated pilot with flight suit, HMDS-style helmet, oxygen mask and an
armature: head look (yaw / pitch / tilt), arms with IK to stick & throttle,
legs to the rudder pedals.

The body is one smooth mesh: a torso loft, shoulder caps and limb capsules
fused by a voxel remesh, smoothed and weighted to the bones by distance (no
operator context needed, so it works in background mode and through the
Blender MCP).  Helmet, gloves, vest and boots ride rigidly on their bones.
"""
import math
import bmesh
import bpy
from mathutils import Vector, Matrix

from .geom import P, get_collection, mesh_object, apply_modifier
from . import materials as M

# joint positions (x, s, z) in aircraft station space; +x = pilot's LEFT
J = {
    "pelvis": (0.0, 3.84, 0.50),
    "hip.L": (0.10, 3.82, 0.50), "hip.R": (-0.10, 3.82, 0.50),
    "spine": (0.0, 3.91, 0.70),
    "chest": (0.0, 3.97, 0.87),
    "neck": (0.0, 4.02, 1.00),
    "head": (0.0, 4.00, 1.06),
    "head_top": (0.0, 3.98, 1.27),
    "shoulder.L": (0.185, 4.00, 0.925), "shoulder.R": (-0.185, 4.00, 0.925),
    "elbow.L": (0.27, 3.90, 0.69), "elbow.R": (-0.28, 3.91, 0.68),
    "wrist.L": (0.35, 3.66, 0.735), "wrist.R": (-0.37, 3.70, 0.70),
    "hand.L": (0.36, 3.60, 0.765), "hand.R": (-0.375, 3.665, 0.745),
    "knee.L": (0.13, 3.40, 0.64), "knee.R": (-0.13, 3.40, 0.64),
    "ankle.L": (0.14, 2.99, 0.31), "ankle.R": (-0.14, 2.99, 0.31),
    "toe.L": (0.14, 2.84, 0.255), "toe.R": (-0.14, 2.84, 0.255),
}

# skin skeleton: (joint, radius_x, radius_y)
SKIN_NODES = [
    ("pelvis", 0.145, 0.115), ("spine", 0.14, 0.11), ("chest", 0.165, 0.12),
    ("neck", 0.065, 0.065),
    ("hip.L", 0.085, 0.085), ("knee.L", 0.062, 0.062), ("ankle.L", 0.048, 0.048),
    ("toe.L", 0.045, 0.04),
    ("hip.R", 0.085, 0.085), ("knee.R", 0.062, 0.062), ("ankle.R", 0.048, 0.048),
    ("toe.R", 0.045, 0.04),
    ("shoulder.L", 0.058, 0.058), ("elbow.L", 0.045, 0.045), ("wrist.L", 0.034, 0.034),
    ("shoulder.R", 0.058, 0.058), ("elbow.R", 0.045, 0.045), ("wrist.R", 0.034, 0.034),
]
SKIN_EDGES = [
    ("pelvis", "spine"), ("spine", "chest"), ("chest", "neck"),
    ("pelvis", "hip.L"), ("hip.L", "knee.L"), ("knee.L", "ankle.L"), ("ankle.L", "toe.L"),
    ("pelvis", "hip.R"), ("hip.R", "knee.R"), ("knee.R", "ankle.R"), ("ankle.R", "toe.R"),
    ("chest", "shoulder.L"), ("shoulder.L", "elbow.L"), ("elbow.L", "wrist.L"),
    ("chest", "shoulder.R"), ("shoulder.R", "elbow.R"), ("elbow.R", "wrist.R"),
]

# bones: name, head joint, tail joint, parent, deform
BONES = [
    ("pelvis", "pelvis", "spine", None, True),
    ("spine", "spine", "chest", "pelvis", True),
    ("chest", "chest", "neck", "spine", True),
    ("neck", "neck", "head", "chest", True),
    ("head", "head", "head_top", "neck", True),
    ("shoulder.L", "chest", "shoulder.L", "chest", True),
    ("upperarm.L", "shoulder.L", "elbow.L", "shoulder.L", True),
    ("forearm.L", "elbow.L", "wrist.L", "upperarm.L", True),
    ("hand.L", "wrist.L", "hand.L", "forearm.L", True),
    ("shoulder.R", "chest", "shoulder.R", "chest", True),
    ("upperarm.R", "shoulder.R", "elbow.R", "shoulder.R", True),
    ("forearm.R", "elbow.R", "wrist.R", "upperarm.R", True),
    ("hand.R", "wrist.R", "hand.R", "forearm.R", True),
    ("thigh.L", "hip.L", "knee.L", "pelvis", True),
    ("shin.L", "knee.L", "ankle.L", "thigh.L", True),
    ("foot.L", "ankle.L", "toe.L", "shin.L", True),
    ("thigh.R", "hip.R", "knee.R", "pelvis", True),
    ("shin.R", "knee.R", "ankle.R", "thigh.R", True),
    ("foot.R", "ankle.R", "toe.R", "shin.R", True),
]


def jp(name):
    """Joint position in the world (J is in cockpit design stations, see cockpit.COCKPIT_DS)."""
    from .cockpit import COCKPIT_DS
    x, s, z = J[name]
    return Vector(P(s + COCKPIT_DS, x, z))


def _seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(1e-9, ab.length_squared)))
    return (p - (a + ab * t)).length


def _capsule(name, coll, a, b, ra, rb, mat, seg=18, rings=6):
    """Tapered capsule between points a and b (radii ra, rb)."""
    a, b = Vector(a), Vector(b)
    axis = (b - a)
    L = axis.length
    d = axis.normalized()
    u = d.cross(Vector((0, 0, 1)))
    if u.length < 1e-3:
        u = d.cross(Vector((1, 0, 0)))
    u.normalize()
    w = d.cross(u)
    profile = []
    for i in range(rings, 0, -1):
        th = (math.pi / 2) * i / rings
        profile.append((-math.sin(th) * ra, math.cos(th) * ra))
    profile.append((0.0, ra))
    profile.append((L, rb))
    for i in range(1, rings + 1):
        th = (math.pi / 2) * i / rings
        profile.append((L + math.sin(th) * rb, math.cos(th) * rb))
    verts, faces = [], []
    for t, r in profile:
        c = a + d * t
        for k in range(seg):
            ang = 2 * math.pi * k / seg
            verts.append(c + (u * math.cos(ang) + w * math.sin(ang)) * max(r, 1e-4))
    n = len(profile)
    for i in range(n - 1):
        for k in range(seg):
            k1 = (k + 1) % seg
            faces.append((i * seg + k, i * seg + k1, (i + 1) * seg + k1, (i + 1) * seg + k))
    faces.append(tuple(range(seg - 1, -1, -1)))
    faces.append(tuple((n - 1) * seg + k for k in range(seg)))
    ob = mesh_object(name, verts, faces, coll, mat)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def _torso(name, coll, levels, mat, seg=28):
    """Loft of horizontal super-ellipse rings: [(centre Vector, rx, ry), ...]."""
    from .geom import loft_rings
    rings = []
    for c, rx, ry in levels:
        ring = []
        for k in range(seg):
            ang = 2 * math.pi * k / seg
            ca, sa = math.cos(ang), math.sin(ang)
            x = rx * math.copysign(abs(ca) ** 0.8, ca)
            y = ry * math.copysign(abs(sa) ** 0.8, sa)
            ring.append(c + Vector((x, y, 0)))
        rings.append(ring)
    v, f = loft_rings(rings, True, True, True)
    ob = mesh_object(name, v, f, coll, mat)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def _merge(name, coll, objs, mat):
    """One object from several temporary ones (their vertices are already in world space)."""
    bm = bmesh.new()
    for o in objs:
        bm.from_mesh(o.data)              # repeated calls append
        me = o.data
        bpy.data.objects.remove(o)
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    me.materials.append(mat)
    return ob


def _bone_segments():
    return [(n, jp(h), jp(t)) for n, h, t, _p, deform in BONES if deform]


def _nearest_bones(co, behind=1.5):
    """Distance of each point (N x 3) to every deform bone segment: (names, N x B array).
    Points that lie beyond a bone's head (back towards its parent) are pushed away by `behind`
    times the overshoot, so the torso round a shoulder or hip stays with the torso bones."""
    import numpy as np
    segs = _bone_segments()
    names = [n for n, _, _ in segs]
    A = np.array([tuple(a) for _, a, _ in segs])
    B = np.array([tuple(b) for _, _, b in segs])
    AB = B - A
    L2 = np.maximum((AB * AB).sum(1), 1e-9)
    t0 = np.einsum("nbk,bk->nb", co[:, None, :] - A[None], AB) / L2[None]
    t = np.clip(t0, 0.0, 1.0)
    proj = A[None] + t[..., None] * AB[None]
    d = np.linalg.norm(co[:, None, :] - proj, axis=2)
    return names, d + behind * np.maximum(-t0, 0.0) * np.sqrt(L2)[None]


BONE_REACH = {"upperarm": 0.085, "forearm": 0.072, "hand": 0.0, "thigh": 0.115, "shin": 0.088,
              "foot": 0.07}


def _skin_to_bones(ob, arm, falloff=0.035):
    """Vertex groups from the distance to the bones (inverse 4th power among the bones within
    `falloff` of the nearest one) + an Armature modifier: the suit bends at the joints."""
    import numpy as np
    me = ob.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    names, d = _nearest_bones(co)
    # a limb bone only takes the vertices of its own limb (within its radius + a margin), so the
    # torso next to an elbow does not swing round when the arm rolls
    reach = np.array([BONE_REACH.get(n.split(".")[0], 1.0) for n in names])[None]
    d = np.where(d < reach, d, d + 1.0)
    dmin = d.min(axis=1, keepdims=True)
    w = np.where(d < dmin + falloff, 1.0 / np.maximum(d, 0.01) ** 4, 0.0)
    w /= w.sum(axis=1, keepdims=True)
    q = np.round(w * 64) / 64                           # quantised: few vertex_group.add calls
    for j, n in enumerate(names):
        vg = ob.vertex_groups.new(name=n)
        col = q[:, j]
        for val in np.unique(col[col > 0]):
            vg.add(np.nonzero(col == val)[0].tolist(), float(val), 'REPLACE')
    ob.parent = arm
    ob.matrix_parent_inverse = arm.matrix_world.inverted()
    m = ob.modifiers.new("Armature", 'ARMATURE')
    m.object = arm
    m.use_deform_preserve_volume = True
    return ob


def build_body(coll, arm):
    """Flight suit + G-suit body as ONE smooth mesh: torso loft, shoulder caps and limb capsules are
    fused with a voxel remesh, smoothed, then skinned to the pilot's bones."""
    suit, gs = M.get("flightsuit"), M.get("gsuit")
    pel, spi, che, nec = jp("pelvis"), jp("spine"), jp("chest"), jp("neck")
    V = Vector
    parts = [_torso("tmp_torso", coll, [
        (pel + V((0, 0.015, -0.10)), 0.150, 0.115),
        (pel + V((0, 0.005, -0.03)), 0.165, 0.125),
        (pel.lerp(spi, 0.5), 0.152, 0.115),
        (spi, 0.150, 0.118),
        (spi.lerp(che, 0.5), 0.163, 0.124),
        (che, 0.178, 0.128),
        (che.lerp(nec, 0.40), 0.196, 0.124),
        (che.lerp(nec, 0.72), 0.186, 0.106),
        (che.lerp(nec, 0.90), 0.118, 0.086),
        (nec, 0.064, 0.062)], suit)]
    parts.append(_capsule("tmp_neck", coll, nec, jp("head") + V((0, 0, 0.03)), 0.056, 0.053, suit))
    for side in ("L", "R"):
        sh, el, wr = jp(f"shoulder.{side}"), jp(f"elbow.{side}"), jp(f"wrist.{side}")
        parts.append(_ellipsoid("tmp_delt", coll, sh + V((0, 0.0, 0.005)), (0.064, 0.066, 0.062), suit,
                                seg=20, rings=12))
        parts.append(_capsule("tmp_uarm", coll, sh, el, 0.060, 0.050, suit))
        parts.append(_capsule("tmp_farm", coll, el, wr, 0.050, 0.039, suit))
        hp, kn, an = jp(f"hip.{side}"), jp(f"knee.{side}"), jp(f"ankle.{side}")
        parts.append(_capsule("tmp_thigh", coll, hp, kn, 0.092, 0.067, gs))
        parts.append(_capsule("tmp_shin", coll, kn, an, 0.064, 0.048, gs))
    # exact boolean union first: a voxel remesh of the raw overlapping shells leaves sheets where
    # the shoulder caps meet the torso at a grazing angle
    from .geom import boolean
    body = parts[0]
    body.name = body.data.name = "Pilot_Body"
    for o in parts[1:]:
        boolean(body, o, 'UNION')
        me = o.data
        bpy.data.objects.remove(o)
        bpy.data.meshes.remove(me)
    m = body.modifiers.new("Remesh", 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = 0.0065
    apply_modifier(body, "Remesh")
    m = body.modifiers.new("Smooth", 'SMOOTH')
    m.factor = 0.9
    m.iterations = 10
    apply_modifier(body, "Smooth")
    me = body.data
    me.materials.append(gs)
    for p in me.polygons:
        p.use_smooth = True
    # G-suit on the legs and the lower belly, flight suit above
    import numpy as np
    cen = np.empty(len(me.polygons) * 3)
    me.polygons.foreach_get("center", cen)
    cen = cen.reshape(-1, 3)
    names, d = _nearest_bones(cen)
    near = [names[i] for i in d.argmin(axis=1)]
    idx = [1 if (n.startswith(("thigh", "shin")) or (n == "pelvis" and c[2] < pel.z + 0.05)) else 0
           for n, c in zip(near, cen)]
    me.polygons.foreach_set("material_index", idx)
    _skin_to_bones(body, arm)
    return body


def _fit_pole_angle(arm, side):
    """IK pole angle for which the solved arm chain matches the rest pose (no roll): the skinned
    sleeves would otherwise twist round the bones."""
    ik = arm.pose.bones[f"forearm.{side}"].constraints[0]
    names = (f"upperarm.{side}", f"forearm.{side}")

    def err(deg):
        ik.pole_angle = math.radians(deg)
        bpy.context.view_layer.update()
        e = 0.0
        for n in names:
            pb = arm.pose.bones[n]
            q = pb.matrix.to_quaternion().rotation_difference(pb.bone.matrix_local.to_quaternion())
            e += abs(q.angle)
        return e
    best = min(range(-180, 180, 5), key=err)
    fine = min((best + k * 0.5 for k in range(-10, 11)), key=err)
    err(fine)
    return fine


def build_armature(coll):
    arm_data = bpy.data.armatures.new("Pilot_Rig")
    arm = bpy.data.objects.new("Pilot_Rig", arm_data)
    coll.objects.link(arm)
    arm_data.display_type = 'STICK'
    # edit bones need edit mode -> use a temporary context override
    view_layer = bpy.context.view_layer
    view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    for name, h, t, parent, deform in BONES:
        b = eb.new(name)
        b.head = jp(h)
        b.tail = jp(t)
        b.use_deform = deform
        if parent:
            b.parent = eb[parent]
            b.use_connect = (eb[parent].tail - b.head).length < 1e-4
        # roll so the local X axis stays horizontal (lateral)
        b.align_roll(Vector((0, 0, 1)) if abs((b.tail - b.head).normalized().z) < 0.9 else Vector((0, -1, 0)))
    # IK targets (non deforming) for the hands, parented to nothing; the rig
    # module re-parents them to the stick / throttle objects
    for side in ("L", "R"):
        b = eb.new(f"IK_hand.{side}")
        b.head = jp(f"wrist.{side}")
        b.tail = jp(f"hand.{side}")
        b.roll = eb[f"hand.{side}"].roll          # same frame: the hand keeps its rest orientation
        b.use_deform = False
        p = eb.new(f"pole_elbow.{side}")
        e = jp(f"elbow.{side}")
        p.head = e + Vector((0.25 if side == "L" else -0.25, 0.10, -0.05))
        p.tail = p.head + Vector((0, 0, 0.05))
        p.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')
    # IK constraints on the forearms
    for side in ("L", "R"):
        pb = arm.pose.bones[f"forearm.{side}"]
        c = pb.constraints.new('IK')
        c.target = arm
        c.subtarget = f"IK_hand.{side}"
        c.pole_target = arm
        c.pole_subtarget = f"pole_elbow.{side}"
        c.pole_angle = math.radians(-90)
        c.chain_count = 2
        hand = arm.pose.bones[f"hand.{side}"]
        cr = hand.constraints.new('COPY_ROTATION')
        cr.target = arm
        cr.subtarget = f"IK_hand.{side}"
    for side in ("L", "R"):
        _fit_pole_angle(arm, side)
    # head-look custom properties on the armature object (degrees)
    arm["head_yaw"] = 0.0
    arm["head_pitch"] = 0.0
    arm["head_tilt"] = 0.0
    for k, lo, hi, desc in (("head_yaw", -100, 100, "Look left (+) / right (-)"),
                            ("head_pitch", -45, 60, "Look up (+) / down (-)"),
                            ("head_tilt", -30, 30, "Tilt head")):
        ui = arm.id_properties_ui(k)
        ui.update(min=lo, max=hi, soft_min=lo, soft_max=hi, description=desc)
    for bn, share in (("neck", 0.4), ("head", 0.6)):
        pb = arm.pose.bones[bn]
        pb.rotation_mode = 'YXZ'
        # bone local axes: Y along the neck, X lateral -> yaw = rotation about Y
        for idx, prop, sign in ((1, "head_yaw", 1.0), (0, "head_pitch", -1.0), (2, "head_tilt", 1.0)):
            fc = pb.driver_add("rotation_euler", idx)
            d = fc.driver
            d.type = 'SCRIPTED'
            var = d.variables.new()
            var.name = "v"
            var.type = 'SINGLE_PROP'
            var.targets[0].id_type = 'OBJECT'
            var.targets[0].id = arm
            var.targets[0].data_path = f'["{prop}"]'
            d.expression = f"v * {sign * share:.3f} * 0.0174533"
    return arm


def _superellipsoid(name, coll, c, rx, ry_front, ry_back, rz_top, rz_bot, mat, e=0.85,
                    seg=40, rings=24, keep=None):
    """Rounded helmet-like solid (front = -Y); `keep(v - c)` drops faces whose centre fails."""
    def pw(v, k):
        return math.copysign(abs(v) ** k, v)
    verts, faces, idx = [], [], {}
    for i in range(rings + 1):
        th = math.pi * i / rings
        cz, sz = math.cos(th), math.sin(th)
        for j in range(seg):
            ph = 2 * math.pi * j / seg
            cx, sy = math.cos(ph), math.sin(ph)
            x = rx * pw(sz, e) * pw(cx, e)
            y = (ry_front if sy < 0 else ry_back) * pw(sz, e) * pw(sy, e)
            z = (rz_top if cz > 0 else rz_bot) * pw(cz, e)
            idx[(i, j)] = len(verts)
            verts.append(c + Vector((x, y, z)))
    for i in range(rings):
        for j in range(seg):
            j1 = (j + 1) % seg
            q = (idx[(i, j)], idx[(i, j1)], idx[(i + 1, j1)], idx[(i + 1, j)])
            if keep is not None and not keep(sum((verts[k] for k in q), Vector()) / 4 - c):
                continue
            faces.append(q)
    ob = mesh_object(name, verts, faces, coll, mat)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def helmet_centre():
    return jp("head") + Vector((0, 0.0, 0.088))


def build_helmet(coll):
    """Gen III HMDS-style helmet (dark grey shell, big wrap-around display visor with a brow
    housing and side pivots), oxygen mask with straps and hose, rear umbilical, face under it."""
    objs = []
    c = helmet_centre()
    V = Vector
    hel, vis, msk = M.get("helmet"), M.get("visor"), M.get("mask")

    def shell_keep(d):
        if d.z < -0.098 - (0.035 if d.y > 0.06 else 0.0):     # lower edge, longer at the nape
            return False
        # face opening (covered by the visor and the mask)
        return not (d.y < -0.045 and abs(d.x) < 0.098 and d.z < 0.030)
    shell = _superellipsoid("Pilot_Helmet", coll, c, 0.132, 0.140, 0.160, 0.150, 0.118, hel, keep=shell_keep)
    so = shell.modifiers.new("Solidify", 'SOLIDIFY')
    so.thickness = 0.010
    so.offset = -1.0
    objs.append(shell)
    # brow housing above the visor (display optics)
    brow = _superellipsoid("Pilot_HelmetBrow", coll, c + V((0, -0.004, 0.0)), 0.140, 0.170, 0.150, 0.154, 0.120,
                           hel, keep=lambda d: d.y < -0.050 and 0.024 < d.z < 0.064 and abs(d.x) < 0.120)
    so = brow.modifiers.new("Solidify", 'SOLIDIFY')
    so.thickness = 0.012
    objs.append(brow)
    # visor: wide, wrapping round to the temples, lower edge rising towards the sides

    def visor_keep(d):
        return d.y < -0.040 and abs(d.x) < 0.124 and -0.078 + 0.9 * d.x * d.x < d.z < 0.050
    visor = _superellipsoid("Pilot_Visor", coll, c + V((0, -0.012, -0.012)), 0.142, 0.152, 0.150, 0.140, 0.130,
                            vis, e=0.9, keep=visor_keep)
    so = visor.modifiers.new("Solidify", 'SOLIDIFY')
    so.thickness = 0.004
    objs.append(visor)
    for side in (1, -1):
        tag = "L" if side > 0 else "R"
        piv = _ellipsoid(f"Pilot_VisorPivot_{tag}", coll, c + V((side * 0.136, -0.044, -0.010)),
                         (0.010, 0.025, 0.025), hel, seg=18, rings=10)
        objs.append(piv)
        # mask receivers low on the helmet sides
        rec = _ellipsoid(f"Pilot_MaskReceiver_{tag}", coll, c + V((side * 0.121, -0.060, -0.092)),
                         (0.011, 0.016, 0.012), hel, seg=12, rings=8)
        objs.append(rec)
    # face (skin) under the helmet: cheeks and chin show round the mask
    face = _ellipsoid("Pilot_Face", coll, jp("head") + V((0, -0.022, 0.055)), (0.073, 0.098, 0.112),
                      M.get("pilot_skin"), seg=24, rings=14)
    objs.append(face)
    # oxygen mask: a rounded cup over nose and mouth, valve in front, straps to the receivers
    mc = c + V((0, -0.110, -0.106))
    mask = _ellipsoid("Pilot_Mask", coll, mc, (0.040, 0.042, 0.053), msk, seg=24, rings=14,
                      clip=lambda v: v.y - mc.y < 0.022)
    objs.append(mask)
    valve = _capsule("Pilot_MaskValve", coll, mc + V((0, -0.032, -0.022)), mc + V((0, -0.042, -0.028)),
                     0.016, 0.015, msk, seg=16, rings=3)
    objs.append(valve)
    for side in (1, -1):
        a = mc + V((side * 0.037, -0.004, 0.012))
        b = c + V((side * 0.120, -0.060, -0.092))
        objs.append(_tube(f"Pilot_MaskStrap_{'L' if side > 0 else 'R'}", coll,
                          [a, a.lerp(b, 0.5) + V((side * 0.012, 0.0, 0.004)), b], 0.006, msk, seg=6, samples=6))
    # hose from the mask down to the regulator on the chest (left)
    a = mc + V((0, -0.040, -0.034))
    b = jp("chest") + V((0.075, -0.168, -0.010))
    objs.append(_tube("Pilot_Hose", coll, [a, a.lerp(b, 0.45) + V((0.03, -0.06, -0.03)), b], 0.0165,
                      M.get("hose"), seg=12, samples=16))
    # umbilical from the back of the helmet to the seat
    a = c + V((0.05, 0.150, -0.075))
    b = jp("shoulder.L") + V((-0.02, 0.10, 0.02))
    objs.append(_tube("Pilot_HelmetCable", coll, [a, a.lerp(b, 0.5) + V((0.03, 0.04, 0.0)), b], 0.009,
                      M.get("harness"), seg=8, samples=10))
    return objs


def _ellipsoid(name, coll, c, r, mat, seg=28, rings=16, clip=None):
    verts, faces, idx = [], [], {}
    for i in range(rings + 1):
        th = math.pi * i / rings
        for j in range(seg):
            ph = 2 * math.pi * j / seg
            v = Vector((c.x + r[0] * math.sin(th) * math.cos(ph),
                        c.y + r[1] * math.sin(th) * math.sin(ph),
                        c.z + r[2] * math.cos(th)))
            idx[(i, j)] = len(verts)
            verts.append(v)
    for i in range(rings):
        for j in range(seg):
            j1 = (j + 1) % seg
            q = (idx[(i, j)], idx[(i + 1, j)], idx[(i + 1, j1)], idx[(i, j1)])
            if clip is not None:
                ctr = sum((verts[k] for k in q), Vector()) / 4
                if not clip(ctr):
                    continue
            faces.append(q)
    ob = mesh_object(name, verts, faces, coll, mat)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    if clip is not None:
        m = ob.modifiers.new("Solidify", 'SOLIDIFY')
        m.thickness = 0.004
    return ob


def _tube(name, coll, pts, r, mat, seg=10, samples=12):
    # quadratic bezier through 3 points
    path = []
    for i in range(samples + 1):
        t = i / samples
        p = pts[0] * (1 - t) ** 2 + pts[1] * 2 * t * (1 - t) + pts[2] * t * t
        path.append(p)
    rings = []
    for i, p in enumerate(path):
        d = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        u = d.cross(Vector((0, 0, 1)))
        if u.length < 1e-3:
            u = d.cross(Vector((1, 0, 0)))
        u.normalize()
        w = d.cross(u)
        rings.append([p + (u * math.cos(2 * math.pi * k / seg) + w * math.sin(2 * math.pi * k / seg)) * r
                      for k in range(seg)])
    from .geom import loft_rings
    v, f = loft_rings(rings, True, True, True)
    return mesh_object(name, v, f, coll, mat)


def _hand_frame(side):
    """Local frame of a gripping hand: Y = wrist -> knuckles, Z = back of the hand (outboard),
    X = across the knuckles from the index finger (up) to the little finger (down)."""
    w, h = jp(f"wrist.{side}"), jp(f"hand.{side}")
    fy = (h - w).normalized()
    out = Vector((1.0, 0.0, 0.0)) if side == "L" else Vector((-1.0, 0.0, 0.0))
    fz = (out - fy * out.dot(fy)).normalized()
    fx = fy.cross(fz)
    if fx.z > 0:
        fx = -fx
    return w, fx, fy, fz


def build_gloves(coll):
    """Gloved fists round the stick (right) and the throttle (left): palm, four curled fingers,
    thumb over the top of the grip."""
    out = []
    mat = M.get("glove")
    for side in ("L", "R"):
        w, fx, fy, fz = _hand_frame(side)

        def L(x, y, z):
            return w + fx * x + fy * y + fz * z
        parts = [_ellipsoid("tmp_palm", coll, L(0.0, 0.050, 0.004), (0.042, 0.050, 0.022), mat,
                            seg=18, rings=10)]
        # cuff
        parts.append(_capsule("tmp_cuff", coll, L(0, -0.012, 0.0), L(0, 0.016, 0.0), 0.040, 0.038, mat,
                              seg=16, rings=3))
        for i, x in enumerate((-0.026, -0.009, 0.008, 0.024)):
            ln = (1.0, 1.06, 1.0, 0.86)[i]
            k = L(x, 0.088, 0.006)
            m1 = L(x, 0.088 + 0.030 * ln, -0.012)
            tip = L(x, 0.086 + 0.016 * ln, -0.040)
            parts.append(_tube("tmp_finger", coll, [k, m1, tip], 0.0098 if i < 3 else 0.0088, mat,
                               seg=10, samples=8))
            parts.append(_ellipsoid("tmp_tip", coll, tip, (0.0095, 0.0095, 0.0095), mat, seg=10, rings=6))
        th0, th1, th2 = L(-0.036, 0.030, -0.012), L(-0.046, 0.066, -0.026), L(-0.030, 0.090, -0.034)
        parts.append(_tube("tmp_thumb", coll, [th0, th1, th2], 0.0115, mat, seg=10, samples=8))
        parts.append(_ellipsoid("tmp_ttip", coll, th2, (0.011, 0.011, 0.011), mat, seg=10, rings=6))
        g = _merge(f"Pilot_Glove_{side}", coll, parts, mat)
        for p in g.data.polygons:
            p.use_smooth = True
        out.append((g, f"hand.{side}"))
    return out


def build_extras(coll):
    """Survival vest + harness over the suit, life-preserver collar, pouches, kneeboard, boots."""
    out = []
    V = Vector
    pel, spi, che, nec = jp("pelvis"), jp("spine"), jp("chest"), jp("neck")
    vest_m, strap_m = M.get("vest"), M.get("harness")
    vest = _torso("Pilot_Vest", coll, [
        (pel.lerp(spi, 0.60), 0.176, 0.140),
        (spi, 0.178, 0.146),
        (spi.lerp(che, 0.5), 0.190, 0.152),
        (che, 0.198, 0.156),
        (che.lerp(nec, 0.35), 0.188, 0.150),
        (che.lerp(nec, 0.65), 0.166, 0.134),
        (che.lerp(nec, 0.86), 0.136, 0.106)], vest_m)
    so = vest.modifiers.new("Solidify", 'SOLIDIFY')      # padded: stands clear of the suit
    so.thickness = 0.010
    so.offset = 1.0
    out.append((vest, "chest"))
    # life-preserver collar round the back of the neck
    ring = []
    for k in range(13):
        a = math.radians(-115 + 230 * k / 12)
        ring.append(nec + V((0.098 * math.sin(a), 0.090 * math.cos(a) - 0.005, -0.050 + 0.02 * math.cos(a))))
    pts = ring
    col_rings = []
    for i, p in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        u = d.cross(V((0, 0, 1))).normalized()
        wv = d.cross(u)
        r = 0.030 * (0.55 + 0.45 * math.sin(math.pi * i / (len(pts) - 1)))
        col_rings.append([p + (u * math.cos(2 * math.pi * j / 12) + wv * math.sin(2 * math.pi * j / 12)) * r
                          for j in range(12)])
    from .geom import loft_rings
    v, f = loft_rings(col_rings, True, True, True)
    out.append((mesh_object("Pilot_LPU", v, f, coll, vest_m), "chest"))
    # pouches on the front of the vest
    from .geom import box
    for side, dz, size in ((1, 0.0, (0.075, 0.036, 0.095)), (-1, 0.02, (0.070, 0.034, 0.080))):
        c = spi.lerp(che, 0.55) + V((side * 0.088, -0.165, dz))
        out.append((box(f"Pilot_Pouch_{'L' if side > 0 else 'R'}", c, size, coll, M.get("pouch"), bevel=0.008),
                    "chest"))
    out.append((box("Pilot_Regulator", jp("chest") + V((0.075, -0.168, -0.010)), (0.05, 0.03, 0.04), coll,
                    strap_m, bevel=0.006), "chest"))
    # harness: shoulder straps down the front to the lap belt, Koch fittings on the chest
    for side in (1, -1):
        sh = jp("shoulder.L" if side > 0 else "shoulder.R")
        top = sh + V((-side * 0.075, 0.025, 0.060))
        mid = jp("spine") + V((side * 0.074, -0.160, 0.03))
        bot = jp("pelvis") + V((side * 0.055, -0.140, -0.02))
        tag = "L" if side > 0 else "R"
        out.append((_tube(f"Pilot_Strap_{tag}", coll, [top, mid, bot], 0.012, strap_m, seg=6), "chest"))
        out.append((box(f"Pilot_Koch_{tag}", jp("chest") + V((side * 0.074, -0.168, -0.06)), (0.035, 0.014, 0.04),
                        coll, M.get("koch"), bevel=0.004), "chest"))
        # leg straps round the thighs
        hp, kn = jp(f"hip.{tag}"), jp(f"knee.{tag}")
        cc = hp.lerp(kn, 0.22)
        ax = (kn - hp).normalized()
        u = ax.cross(V((0, 0, 1))).normalized()
        wv = ax.cross(u)
        lr = [[cc + ax * dd + (u * math.cos(2 * math.pi * j / 20) + wv * math.sin(2 * math.pi * j / 20)) * 0.097
               for j in range(20)] for dd in (-0.016, 0.016)]
        v, f = loft_rings(lr, True, False, False)
        ob = mesh_object(f"Pilot_LegStrap_{tag}", v, f, coll, strap_m)
        so = ob.modifiers.new("Solidify", 'SOLIDIFY')
        so.thickness = 0.004
        out.append((ob, f"thigh.{tag}"))
    belt_a = jp("hip.L") + V((0.06, -0.02, 0.03))
    belt_b = jp("hip.R") + V((-0.06, -0.02, 0.03))
    out.append((_tube("Pilot_LapBelt", coll, [belt_a, jp("pelvis") + V((0, -0.155, 0.02)), belt_b],
                      0.014, strap_m, seg=6), "pelvis"))
    # kneeboard strapped to the right thigh
    hp, kn = jp("hip.R"), jp("knee.R")
    ax = (kn - hp).normalized()
    kb_c = hp.lerp(kn, 0.62) + V((0, 0, 0.071))
    kb = box("Pilot_Kneeboard", (0, 0, 0), (0.125, 0.20, 0.012), coll, M.get("kneeboard"), bevel=0.003)
    paper = box("Pilot_KneeboardPaper", (0, 0, 0.0065), (0.110, 0.165, 0.002), coll, M.get("paper"))
    rot = V((0, -1, 0)).rotation_difference(V((ax.x, ax.y, ax.z)))
    for o in (kb, paper):
        me = o.data
        for vv in me.vertices:
            vv.co = kb_c + rot @ vv.co
        out.append((o, "thigh.R"))
    # boots: upper + sole
    for side in ("L", "R"):
        a = jp(f"ankle.{side}")
        t = jp(f"toe.{side}")
        boot = _ellipsoid(f"Pilot_Boot_{side}", coll, a.lerp(t, 0.45) + V((0, 0, 0.0)),
                          (0.050, 0.120, 0.058), M.get("boot"), seg=18, rings=10)
        out.append((boot, f"foot.{side}"))
        out.append((_capsule(f"Pilot_BootTop_{side}", coll, a + V((0, 0.01, -0.03)), a + V((0, 0.0, 0.08)),
                             0.050, 0.048, M.get("boot"), seg=16, rings=3), f"foot.{side}"))
    return out


def parent_to_bone(ob, arm, bone):
    mw = ob.matrix_world.copy()
    ob.parent = arm
    ob.parent_type = 'BONE'
    ob.parent_bone = bone
    bpy.context.view_layer.update()
    ob.matrix_world = mw


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Pilot", root)
    arm = build_armature(coll)
    body = build_body(coll, arm)
    for ob in build_helmet(coll):
        parent_to_bone(ob, arm, "head")
    for ob, bone in build_gloves(coll) + build_extras(coll):
        parent_to_bone(ob, arm, bone)
    ctx["objects"]["Pilot_Rig"] = arm
    ctx["objects"]["Pilot_Body"] = body
    return arm
