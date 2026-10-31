"""Seated pilot with flight suit, HMDS-style helmet, oxygen mask and an
armature: head look (yaw / pitch / tilt), arms with IK to stick & throttle,
legs to the rudder pedals.

The body is generated with a Skin modifier over a joint skeleton, converted
to a mesh and weighted to the bones by distance (no operator context needed,
so it works in background mode and through Blender MCP).
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


def build_body(coll):
    """Articulated mannequin in a flight suit: returns [(object, bone), ...]."""
    out = []
    suit, gs = M.get("flightsuit"), M.get("gsuit")
    pel, spi, che, nec = jp("pelvis"), jp("spine"), jp("chest"), jp("neck")
    lower = _torso("Pilot_TorsoLower", coll, [
        (pel + Vector((0, 0.0, -0.08)), 0.150, 0.105),
        (pel + Vector((0, 0.0, 0.00)), 0.160, 0.115),
        (pel.lerp(spi, 0.6), 0.150, 0.110),
        (spi + Vector((0, 0, 0.03)), 0.145, 0.105)], gs)
    out.append((lower, "pelvis"))
    upper = _torso("Pilot_TorsoUpper", coll, [
        (spi + Vector((0, 0, -0.03)), 0.145, 0.105),
        (spi.lerp(che, 0.5), 0.160, 0.112),
        (che, 0.180, 0.118),
        (che.lerp(nec, 0.55), 0.185, 0.105),
        (che.lerp(nec, 0.85), 0.120, 0.080),
        (nec, 0.065, 0.062)], suit)
    out.append((upper, "spine"))
    out.append((_capsule("Pilot_Neck", coll, nec, jp("head") + Vector((0, 0, 0.03)), 0.055, 0.052,
                         suit), "neck"))
    for side in ("L", "R"):
        out.append((_capsule(f"Pilot_UpperArm_{side}", coll, jp(f"shoulder.{side}"),
                             jp(f"elbow.{side}"), 0.056, 0.046, suit), f"upperarm.{side}"))
        out.append((_capsule(f"Pilot_Forearm_{side}", coll, jp(f"elbow.{side}"),
                             jp(f"wrist.{side}"), 0.045, 0.034, suit), f"forearm.{side}"))
        out.append((_capsule(f"Pilot_Thigh_{side}", coll, jp(f"hip.{side}"),
                             jp(f"knee.{side}"), 0.088, 0.062, gs), f"thigh.{side}"))
        out.append((_capsule(f"Pilot_Shin_{side}", coll, jp(f"knee.{side}"),
                             jp(f"ankle.{side}"), 0.060, 0.045, gs), f"shin.{side}"))
    return out


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


def build_helmet(coll):
    """HMDS Gen III style helmet: shell, visor, mask, hose, display modules."""
    objs = []
    c = jp("head") + Vector((0, -0.01, 0.085))
    # shell
    shell = _ellipsoid("Pilot_Helmet", coll, c, (0.135, 0.155, 0.145), M.get("helmet"))
    objs.append(shell)
    # visor: front part of a slightly larger ellipsoid
    visor = _ellipsoid("Pilot_Visor", coll, c + Vector((0, -0.012, -0.012)), (0.14, 0.158, 0.13),
                       M.get("visor"), clip=lambda v: v.y - c.y < -0.03 and v.z - c.z < 0.075
                       and v.z - c.z > -0.10)
    objs.append(visor)
    # oxygen mask
    mask = _ellipsoid("Pilot_Mask", coll, c + Vector((0, -0.125, -0.11)), (0.055, 0.05, 0.06),
                      M.get("mask"))
    objs.append(mask)
    # hose to the chest
    a = c + Vector((0, -0.14, -0.15))
    b = jp("chest") + Vector((0.05, -0.17, -0.02))
    hose = _tube("Pilot_Hose", coll, [a, a.lerp(b, 0.5) + Vector((0.03, -0.03, -0.02)), b],
                 0.016, M.get("harness"))
    objs.append(hose)
    # side display modules
    for side in (1, -1):
        m = _ellipsoid(f"Pilot_HMD_{'L' if side > 0 else 'R'}", coll,
                       c + Vector((side * 0.12, -0.07, 0.03)), (0.03, 0.06, 0.035), M.get("helmet"))
        objs.append(m)
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


def build_gloves(coll):
    out = []
    for side in ("L", "R"):
        w = jp(f"wrist.{side}")
        h = jp(f"hand.{side}")
        c = w.lerp(h, 0.6)
        g = _ellipsoid(f"Pilot_Glove_{side}", coll, c, (0.04, 0.05, 0.03), M.get("glove"),
                       seg=16, rings=10)
        out.append((g, f"hand.{side}"))
    return out


def build_extras(coll):
    """Survival vest / harness and boots (rigid, parented to bones)."""
    out = []
    # harness: shoulder straps + lap belt (seat restraint)
    for side in (1, -1):
        sh = jp("shoulder.L" if side > 0 else "shoulder.R")
        top = sh + Vector((-side * 0.07, 0.03, 0.06))
        mid = jp("spine") + Vector((side * 0.07, -0.115, 0.02))
        bot = jp("pelvis") + Vector((side * 0.05, -0.12, -0.02))
        out.append((_tube(f"Pilot_Strap_{'L' if side > 0 else 'R'}", coll, [top, mid, bot],
                          0.012, M.get("harness"), seg=6), "chest"))
    belt_a = jp("hip.L") + Vector((0.06, -0.02, 0.03))
    belt_b = jp("hip.R") + Vector((-0.06, -0.02, 0.03))
    out.append((_tube("Pilot_LapBelt", coll, [belt_a, jp("pelvis") + Vector((0, -0.15, 0.02)), belt_b],
                      0.014, M.get("harness"), seg=6), "pelvis"))
    for side in ("L", "R"):
        a = jp(f"ankle.{side}")
        t = jp(f"toe.{side}")
        boot = _ellipsoid(f"Pilot_Boot_{side}", coll, a.lerp(t, 0.5) + Vector((0, 0, -0.01)),
                          (0.055, 0.12, 0.06), M.get("boot"), seg=16, rings=10)
        out.append((boot, f"foot.{side}"))
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
    body_parts = build_body(coll)
    for ob, bone in body_parts:
        parent_to_bone(ob, arm, bone)
    body = body_parts[0][0]
    for ob in build_helmet(coll):
        parent_to_bone(ob, arm, "head")
    for ob, bone in build_gloves(coll) + build_extras(coll):
        parent_to_bone(ob, arm, bone)
    ctx["objects"]["Pilot_Rig"] = arm
    ctx["objects"]["Pilot_Body"] = body
    return arm
