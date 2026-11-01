"""Animation rig: one armature, ``F35I_Rig``, drives every moving part.

All controls are custom properties on the armature object (animatable,
visible in the N-panel / Object properties).  Drivers use only Blender's
"simple expressions", so they work even when Python auto-run is disabled.

Flight controls
  stick_pitch  -1..1  + = pull (nose up)       -> stabilators (+ side-stick)
  stick_roll   -1..1  + = roll right           -> flaperons + differential stabs
  pedals       -1..1  + = yaw right            -> twin rudders (+ pedals)
  throttle      0..1  0.75 = MIL, 1 = max A/B  -> nozzle petals, throttle lever
  flaps         0..1  landing flap / LEF schedule
  speedbrake    0..1  split (toe-out) rudders
Ground / doors
  gear 0..1 (1 = down, sequenced doors -> legs), nws, roll_distance,
  weapon_bays, canopy, refuel_door, gun_door, tailhook
Pilot
  head_yaw / head_pitch / head_tilt (deg) -> Pilot_Rig
Cockpit switches
  sw_<NAME> 0/1 for each of the 24 switches: moves the lever (and guard),
  lights its LED (needs sw_BATT) and switches the related system (lights,
  displays).  Use ``f35.anim.actuate()`` to flip a switch *and* animate
  the system it commands (gear, bays, canopy, ...).
"""
import math
import bpy
from mathutils import Vector, Matrix

from .geom import get_collection, P, Y0

D2R = math.pi / 180.0

CONTROLS = [
    ("stick_pitch", 0.0, -1.0, 1.0, "Side-stick pitch: + = pull back (nose up)"),
    ("stick_roll", 0.0, -1.0, 1.0, "Side-stick roll: + = roll right"),
    ("pedals", 0.0, -1.0, 1.0, "Rudder pedals: + = yaw right"),
    ("throttle", 0.0, 0.0, 1.0, "Throttle: 0 idle, 0.75 military, 1.0 max afterburner"),
    ("flaps", 0.0, 0.0, 1.0, "Trailing-edge flap / LEF schedule: 0 up, 1 landing"),
    ("speedbrake", 0.0, 0.0, 1.0, "Speed brake (rudders split outwards)"),
    ("gear", 1.0, 0.0, 1.0, "Landing gear: 0 = up & locked, 1 = down & locked (doors sequenced)"),
    ("nws", 0.0, -1.0, 1.0, "Nose-wheel steering: + = turn right"),
    ("roll_distance", 0.0, -1.0e6, 1.0e6, "Distance rolled forward on the ground (m); spins the wheels"),
    ("weapon_bays", 0.0, 0.0, 1.0, "Weapon bay doors"),
    ("canopy", 0.0, 0.0, 1.0, "Canopy (front hinged)"),
    ("refuel_door", 0.0, 0.0, 1.0, "Air-refuelling receptacle door"),
    ("gun_door", 0.0, 0.0, 1.0, "GAU-22/A gun port door"),
    ("tailhook", 0.0, 0.0, 1.0, "Arresting hook"),
    ("head_yaw", 0.0, -100.0, 100.0, "Pilot looks left (+) / right (-), degrees"),
    ("head_pitch", 0.0, -45.0, 60.0, "Pilot looks up (+) / down (-), degrees"),
    ("head_tilt", 0.0, -30.0, 30.0, "Pilot head tilt, degrees"),
]

# positive rotation = this motion of the probe point
WANT = {
    "lef": (0, 0, -1), "flaperon": (0, 0, -1), "stabilator": (0, 0, -1),
    "rudder": (1, 0, 0), "canopy": (0, 0, 1), "bay_door": (0, 0, -1),
    "nose_door": (0, 0, -1), "gun_door": (0, 0, -1), "refuel_door": (0, 0, -1),
    "main_door": (0, 0, -1), "main_well_door": (0, 0, -1),
    "tailhook": (0, 0, -1),
}

# driver expressions per hinge kind (degrees -> radians done here)
#   variables available: see _vars()
SS = "smoothstep"


def _expr(kind, ob):
    side = ob.get("side", 1)
    lim = ob.get("limit_max", 0.0)
    lo = ob.get("limit_min", 0.0)
    if kind == "flaperon":
        roll = "+" if side > 0 else "-"
        return f"clamp(25*flaps {roll} 20*roll, {lo}, {lim})*{D2R}"
    if kind == "lef":
        return f"clamp(25*flaps, {lo}, {lim})*{D2R}"
    if kind == "stabilator":
        roll = "+" if side > 0 else "-"
        return f"clamp(-20*pitch {roll} 8*roll, {lo}, {lim})*{D2R}"
    if kind == "rudder":
        sb = "+" if side > 0 else "-"
        return f"clamp(-25*yaw {sb} 25*sbrk, {lo}, {lim})*{D2R}"
    if kind == "canopy":
        return f"{lim}*{SS}(0, 1, canopy)*{D2R}"
    if kind == "bay_door":
        lead = 0.0 if ob.get("door") == "Inner" else 0.1
        return f"{lim}*{SS}({lead}, {lead + 0.9}, bays)*{D2R}"
    if kind in ("nose_door", "main_door"):
        return f"{lim}*{SS}(0, 0.25, gear)*{D2R}"
    if kind == "main_well_door":
        # open only while the leg travels (it swings between gear 0.25 and 0.95)
        return f"{lim}*{SS}(0, 0.22, gear)*(1 - {SS}(0.955, 1.0, gear))*{D2R}"
    if kind == "gun_door":
        return f"{lim}*{SS}(0, 1, gun)*{D2R}"
    if kind == "refuel_door":
        return f"{lim}*{SS}(0, 1, refuel)*{D2R}"
    if kind == "tailhook":
        return f"{lim}*{SS}(0, 1, hook)*{D2R}"
    return "0"


VARMAP = {"flaps": "flaps", "roll": "stick_roll", "pitch": "stick_pitch", "yaw": "pedals",
          "sbrk": "speedbrake", "canopy": "canopy", "bays": "weapon_bays", "gear": "gear",
          "gun": "gun_door", "refuel": "refuel_door", "hook": "tailhook", "thr": "throttle",
          "nws": "nws", "dist": "roll_distance", "batt": "sw_BATT"}


def _driver(owner, path, index, expr, arm, names=None, extra=()):
    fc = owner.driver_add(path, index) if index is not None else owner.driver_add(path)
    d = fc.driver
    d.type = 'SCRIPTED'
    used = names if names is not None else [k for k in VARMAP if _uses(expr, k)]
    for vn in used:
        v = d.variables.new()
        v.name = vn
        v.type = 'SINGLE_PROP'
        v.targets[0].id_type = 'OBJECT'
        v.targets[0].id = arm
        v.targets[0].data_path = f'["{VARMAP.get(vn, vn)}"]'
    for vn, idt, path_ in extra:
        v = d.variables.new()
        v.name = vn
        v.type = 'SINGLE_PROP'
        v.targets[0].id_type = 'OBJECT'
        v.targets[0].id = idt
        v.targets[0].data_path = path_
    d.expression = expr
    return d


def _uses(expr, name):
    import re
    return re.search(r'(?<![A-Za-z_])' + name + r'(?![A-Za-z_0-9])', expr) is not None


def _probe(ob, kind, p0, p1):
    mw = ob.matrix_world
    pts = [mw @ v.co for v in ob.data.vertices]
    if kind == "stabilator":
        ym = (p0.y + p1.y) / 2
        aft = [p for p in pts if p.y > ym + 0.05]
        pts = aft or pts
    return sum(pts, Vector()) / len(pts)


def orient(ob, kind):
    """Order the hinge points so that a positive rotation produces the
    'positive' motion of WANT (or the per-object 'want' property)."""
    p0, p1 = Vector(ob["hinge_p0"]), Vector(ob["hinge_p1"])
    want = Vector(ob["want"]) if "want" in ob else Vector(WANT.get(kind, (0, 0, -1)))
    c = _probe(ob, kind, p0, p1)
    ax = (p1 - p0).normalized()
    R = Matrix.Rotation(math.radians(5), 3, ax)
    moved = p0 + R @ (c - p0) - c
    if moved.dot(want) < 0:
        p0, p1 = p1, p0
    return p0, p1


def _signed_angle(u, v, normal):
    a = u.angle(v)
    if u.cross(v).angle(normal) < 1:
        a = -a
    return a


def _pole_angle(base, tip, pole_loc):
    """IK pole angle that keeps a 2-bone chain in its rest bend plane."""
    pole_normal = (tip.tail - base.head).cross(pole_loc - base.head)
    projected = pole_normal.cross(base.tail - base.head)
    return _signed_angle(base.x_axis, projected, base.tail - base.head)


def _edit_bone(eb, name, head, tail, parent=None, roll_axis=None):
    b = eb.new(name)
    b.head = head
    b.tail = tail
    b.use_deform = False
    if roll_axis is not None:
        b.align_roll(Vector(roll_axis))
    if parent:
        b.parent = eb[parent]
    return b


def parent_keep(ob, arm, bone):
    mw = ob.matrix_world.copy()
    ob.parent = arm
    ob.parent_type = 'BONE'
    ob.parent_bone = bone
    bpy.context.view_layer.update()
    ob.matrix_world = mw


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Rig", root)
    arm_data = bpy.data.armatures.new("F35I_Rig")
    arm = bpy.data.objects.new("F35I_Rig", arm_data)
    coll.objects.link(arm)
    arm.show_in_front = True
    arm_data.display_type = 'STICK'
    for name, dv, lo, hi, desc in CONTROLS:
        arm[name] = dv
        ui = arm.id_properties_ui(name)
        ui.update(min=lo, max=hi, soft_min=lo, soft_max=hi, description=desc)
    switches = ctx.get("switches", [])
    for sw in switches:
        k = "sw_" + sw["name"]
        arm[k] = 0
        arm.id_properties_ui(k).update(min=0, max=1, description=sw["label"])
    if "sw_BATT" not in arm:
        arm["sw_BATT"] = 1
    # ----------------------------------------------------------- edit bones
    hinged = [ob for ob in bpy.data.objects
              if ob.type == 'MESH' and "hinge_kind" in ob and "hinge_p0" in ob and ob.parent is None]
    bone_specs = list(ctx.get("rig_bones", []))
    vl = bpy.context.view_layer
    vl.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    _edit_bone(eb, "Root", P(8.0, 0, 0), P(9.5, 0, 0))
    hinge_bones = []
    for ob in hinged:
        kind = ob["hinge_kind"]
        p0, p1 = orient(ob, kind)
        bn = "H_" + ob.name
        _edit_bone(eb, bn, p0, p1, "Root")
        hinge_bones.append((bn, ob, kind))
    for spec in bone_specs:
        _edit_bone(eb, spec["name"], spec["head"], spec["tail"], spec["parent"], spec.get("roll_axis"))
    pole_angles = {}
    for spec in bone_specs:
        if "ik" in spec:
            tgt, pole, chain = spec["ik"]
            lo = eb[spec["name"]]
            up = lo.parent if chain == 2 else lo
            pole_angles[spec["name"]] = _pole_angle(up, lo, eb[pole].head)
    # cockpit controls
    ck = ctx["objects"]
    if "Stick" in ck:
        base = ck["Stick"].matrix_world.translation
        _edit_bone(eb, "Stick", base, base + Vector((0, 0, 0.12)), "Root", roll_axis=(1, 0, 0))
    if "Throttle" in ck:
        base = ck["Throttle"].matrix_world.translation
        _edit_bone(eb, "Throttle", base, base + Vector((0, 0, 0.12)), "Root", roll_axis=(1, 0, 0))
    for tag in ("L", "R"):
        if f"Pedal_{tag}" in ck:
            base = ck[f"Pedal_{tag}"].matrix_world.translation
            _edit_bone(eb, f"Pedal_{tag}", base, base + Vector((0, 0.10, 0)), "Root", roll_axis=(0, 0, 1))
    pilot = bpy.data.objects.get("Pilot_Rig")
    if pilot is not None:
        for side, ctrl in (("R", "Stick"), ("L", "Throttle")):
            pb = pilot.data.bones.get(f"IK_hand.{side}")
            if pb is not None and ctrl in eb:
                z = pilot.matrix_world.to_3x3() @ pb.matrix_local.col[2].xyz    # keep the hand's roll
                _edit_bone(eb, f"Hand_{side}", pilot.matrix_world @ pb.head_local,
                           pilot.matrix_world @ pb.tail_local, ctrl, roll_axis=tuple(z))
    bpy.ops.object.mode_set(mode='OBJECT')
    pose = arm.pose.bones
    for pb in pose:
        pb.rotation_mode = 'XYZ'
    # ------------------------------------------------- hinge objects + drivers
    for bn, ob, kind in hinge_bones:
        parent_keep(ob, arm, bn)
        expr = _expr(kind, ob)
        _driver(pose[bn], "rotation_euler", 1, expr, arm)
    # -------------------------------------------------- spec bones (gear)
    for spec in bone_specs:
        for on in spec["objects"]:
            parent_keep(bpy.data.objects[on], arm, spec["name"])
        pb = pose[spec["name"]]
        drv = spec.get("drive")
        if drv == "gear_leg":
            ang = spec["angle"]
            _driver(pb, "rotation_euler", 1, f"{ang:.3f}*(1 - {SS}(0.25, 0.95, gear))*{D2R}", arm)
        elif drv == "nws":
            _driver(pb, "rotation_euler", 1, f"60*nws*{SS}(0.9, 1.0, gear)*{D2R}", arm)
        elif drv == "wheel_spin":
            sign = 1.0 if (spec["tail"] - spec["head"]).x >= 0 else -1.0
            _driver(pb, "rotation_euler", 1, f"{sign}*dist/{spec['radius']:.4f}", arm)
        if spec.get("slide"):
            # the oleo closes along the strut (bone +Y points down it) as the gear starts up
            _driver(pb, "location", 1, f"-{spec['slide']:.4f}*(1 - {SS}(0.86, 1.0, gear))", arm)
        if "ik" in spec:
            tgt, pole, chain = spec["ik"]
            c = pb.constraints.new('IK')
            c.target = arm
            c.subtarget = tgt
            c.pole_target = arm
            c.pole_subtarget = pole
            c.pole_angle = pole_angles[spec["name"]]
            c.chain_count = chain
        if "track" in spec:
            c = pb.constraints.new('DAMPED_TRACK')
            c.target = arm
            c.subtarget = spec["track"]
            c.track_axis = 'TRACK_Y'
    # --------------------------------------------------- cockpit controls
    if "Stick" in pose:
        parent_keep(ck["Stick"], arm, "Stick")
        _driver(pose["Stick"], "rotation_euler", 0, f"-12*pitch*{D2R}", arm)
        _driver(pose["Stick"], "rotation_euler", 2, f"12*roll*{D2R}", arm)
    if "Throttle" in pose:
        parent_keep(ck["Throttle"], arm, "Throttle")
        _driver(pose["Throttle"], "rotation_euler", 0, f"(36*thr - 12)*{D2R}", arm)
    for tag, sgn in (("L", 1.0), ("R", -1.0)):
        if f"Pedal_{tag}" in pose:
            parent_keep(ck[f"Pedal_{tag}"], arm, f"Pedal_{tag}")
            _driver(pose[f"Pedal_{tag}"], "location", 1, f"{sgn * 0.045}*yaw", arm)
    # nozzle afterburner petals
    noz = bpy.data.objects.get("Nozzle")
    if noz is not None and noz.data.shape_keys and "AB_Open" in noz.data.shape_keys.key_blocks:
        kb = noz.data.shape_keys.key_blocks["AB_Open"]
        _driver(kb, "value", None, "clamp((thr - 0.75)*4, 0, 1)", arm)
    # ------------------------------------------------------------ switches
    _rig_switches(arm, switches)
    # ----------------------------------------------------------- lights
    for ob in bpy.data.objects:
        role = ob.get("light")
        if not role:
            continue
        if role != "afterburner":
            ob["on"] = 0.0
        if role == "landing":
            _driver(ob, '["on"]', None, f"batt*sw*{SS}(0.9, 1.0, gear)", arm, ["batt", "gear"],
                    [("sw", arm, '["sw_LDG_LT"]')])
        elif role == "nav":
            _driver(ob, '["on"]', None, "batt*sw", arm, ["batt"], [("sw", arm, '["sw_POS_LT"]')])
        elif role == "formation":
            _driver(ob, '["on"]', None, "batt*sw", arm, ["batt"], [("sw", arm, '["sw_FORM_LT"]')])
        elif role == "afterburner":
            _driver(ob, '["ab"]', None, "clamp((thr - 0.75)*4, 0, 1)", arm)
            continue
        elif role == "beacon":
            # anti-collision strobe: 1 Hz flash using the frame number (24 fps)
            _driver(ob, '["on"]', None, "batt*sw*(fmod(frame, 24) < 3)", arm, ["batt"],
                    [("sw", arm, '["sw_ANTI_COLL"]')])
    # ------------------------------------------------- everything else
    for ob in list(root.all_objects):
        if ob.parent is None and ob is not arm and ob.name in bpy.context.scene.objects:
            parent_keep(ob, arm, "Root")
    # pilot follows the stick / throttle with its hands, head look via rig
    if pilot is not None:
        for side in ("R", "L"):
            tb = f"Hand_{side}"
            if tb not in pose:
                continue
            c = pilot.pose.bones[f"IK_hand.{side}"].constraints.new('COPY_TRANSFORMS')
            c.target = arm
            c.subtarget = tb
        for k in ("head_yaw", "head_pitch", "head_tilt"):
            _driver(pilot, f'["{k}"]', None, "v", arm, [], [("v", arm, f'["{k}"]')])
    bad = check_drivers(arm)
    ctx["objects"]["F35I_Rig"] = arm
    ctx["rig_info"] = {"bones": len(arm.data.bones), "non_simple_drivers": bad}
    return arm


SWITCH_LINKS = {
    # switch -> (lever throw deg, emission targets)
    "DISPLAY": "display",
}


def _rig_switches(arm, switches):
    for sw in switches:
        name = sw["name"]
        lev = bpy.data.objects.get(sw["object"])
        if lev is None:
            continue
        kind = sw["kind"]
        throw = {"gear": 50.0, "handle": 35.0, "button": 0.0}.get(kind, 50.0)
        prop = f'["sw_{name}"]'
        if kind == "button":
            _driver(lev, "delta_location", 2, "-0.004*s", arm, [], [("s", arm, prop)])
        else:
            # lever rests at -throw/2 (OFF) and flips to +throw/2 (ON)
            _driver(lev, "delta_rotation_euler", 0, f"({throw}*s - {throw / 2})*{D2R}", arm, [],
                    [("s", arm, prop)])
        led = bpy.data.objects.get(sw.get("led", ""))
        if led is not None:
            if name == "BATT":
                _driver(led, '["on"]', None, "s", arm, [], [("s", arm, prop)])
            else:
                _driver(led, '["on"]', None, "s*batt", arm, ["batt"], [("s", arm, prop)])
        guard = bpy.data.objects.get(sw.get("guard", ""))
        if guard is not None:
            _driver(guard, "delta_rotation_euler", 0, f"-110*s*{D2R}", arm, [], [("s", arm, prop)])
    scr = bpy.data.objects.get("PCD_Screen")
    if scr is not None:
        _driver(scr, '["power"]', None, "batt*s", arm, ["batt"], [("s", arm, '["sw_DISPLAY"]')])


def check_drivers(arm):
    """Return the drivers that need Python (should be none)."""
    bad = []
    for idb in list(bpy.data.objects) + [k for k in bpy.data.shape_keys]:
        ad = getattr(idb, "animation_data", None)
        if not ad:
            continue
        for fc in ad.drivers:
            if fc.driver.type == 'SCRIPTED' and not fc.driver.is_simple_expression:
                bad.append(f"{idb.name}:{fc.data_path}[{fc.array_index}] = {fc.driver.expression}")
    return bad
