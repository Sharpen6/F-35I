"""Build the detailed F-35I pilot in Blender from pilot.parts (plain numpy meshes): every part
becomes an object with its materials, the garments, hoses and cables are skinned to the bones
they ride on, and the rigid parts (helmet, gloves, boots, kneeboard, watch, patches) are parented
to their bones.  The armature has head-look controls (head_yaw / head_pitch / head_tilt in
degrees on the armature object, as on the aircraft's pilot) and optional IK hands.

Inside Blender 5.1 with <repo>/scripts on sys.path:

    from pilot import build_pilot
    build_pilot.standing()                    # studio scene 'Pilot_Studio', collection 'Pilot'
    build_pilot.save_blend()                  # blend/F-35I_Pilot.blend (the studio scene only)
    from pilot import studio; studio.render(["front34", "side", "head34"])

The full build takes a minute or two (numpy), so from the MCP run it in a background Blender:
scripts/pilot/run_studio.py.
"""
import math
import os
import time

import bpy
import numpy as np

from . import blender_io as io
from . import materials, parts as P, skeleton as S, studio

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BLEND = os.path.join(ROOT, "blend", "F-35I_Pilot.blend")

TORSO = ["pelvis", "spine", "chest", "neck", "clavicle.L", "clavicle.R"]
LEGS = ["pelvis", "thigh.L", "thigh.R", "shin.L", "shin.R"]
# skinned parts (bone None): the bones each may follow (longest name prefix wins; None = all)
ARMS = [f"{b}.{s}" for s in ("L", "R") for b in ("upperarm", "forearm", "hand")]
SKIN_SETS = {
    "Suit": None,
    "Suit_Collar": ["neck", "chest", "head"],
    "Jacket": TORSO + ARMS,                     # the shell with its sleeves
    "Jacket_": TORSO,                           # pockets, zip and webbing on the torso
    "LPU": ["chest", "spine"],
    "FCAGS": ["spine"] + LEGS,
    "Hose_Mask": ["head", "neck", "chest"],
    "Hose_MicCord": ["head", "neck", "chest"],
    "Hose_Disconnect": ["chest"],
    "Hose_Clip": ["chest"],
    "Hose_BGHA": ["chest", "spine", "pelvis", "thigh.L"],
    "Hose_AntiG": ["pelvis", "thigh.L"],
    "Helmet_Cable": ["head", "neck", "chest", "spine", "pelvis", "thigh.L"],
    "PEC_SeatLead": ["pelvis", "thigh.L"],
    "PEC_SeatPlug": ["pelvis"],
    "Harness": TORSO,
    "Kneeboard_Strap": ["thigh.R"],
}


def skin_set(name):
    best = None
    for k in SKIN_SETS:
        if name.startswith(k) and (best is None or len(k) > len(best)):
            best = k
    return SKIN_SETS[best] if best else None


# --------------------------------------------------------------------------- rig
def _fit_pole_angle(arm, side):
    """IK pole angle for which the solved arm matches the rest pose (no twist in the sleeves)."""
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


def look_controls(arm):
    """head_yaw / head_pitch / head_tilt (degrees) on the armature drive the neck (40 %) and the
    head (60 %): yaw about the bones' long axis, pitch about their lateral axis."""
    for k, lo, hi, desc in (("head_yaw", -100, 100, "Look left (+) / right (-)"),
                            ("head_pitch", -45, 60, "Look up (+) / down (-)"),
                            ("head_tilt", -30, 30, "Tilt head")):
        arm[k] = 0.0
        ui = arm.id_properties_ui(k)
        ui.update(min=lo, max=hi, soft_min=lo, soft_max=hi, description=desc)
    for bn, share in (("neck", 0.4), ("head", 0.6)):
        pb = arm.pose.bones[bn]
        pb.rotation_mode = 'YXZ'
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


def rig(coll, j, F, name, ik=False):
    """Armature for joints j (rest pose = the built pose), head-look controls, IK hands if ik."""
    extra = []
    if ik:
        for s, sg in (("L", 1.0), ("R", -1.0)):
            extra.append((f"IK_hand.{s}", j[f"wrist.{s}"], j[f"hand.{s}"], None, F[f"hand.{s}"][2], False))
            ph = j[f"elbow.{s}"] + np.array([0.25 * sg, 0.10, -0.05])
            extra.append((f"pole_elbow.{s}", ph, ph + np.array([0.0, 0.0, 0.05]), None, None, False))
    arm = io.armature(name, j, F, coll, extra_bones=extra)
    if ik:
        for s in ("L", "R"):
            pb = arm.pose.bones[f"forearm.{s}"]
            c = pb.constraints.new('IK')
            c.target, c.subtarget = arm, f"IK_hand.{s}"
            c.pole_target, c.pole_subtarget = arm, f"pole_elbow.{s}"
            c.pole_angle = math.radians(-90)
            c.chain_count = 2
            cr = arm.pose.bones[f"hand.{s}"].constraints.new('COPY_ROTATION')
            cr.target, cr.subtarget = arm, f"IK_hand.{s}"
        for s in ("L", "R"):
            _fit_pole_angle(arm, s)
    look_controls(arm)
    return arm


# --------------------------------------------------------------------------- parts -> objects
def decimate(ob, ratio):
    """Collapse-decimate a mesh in place (keeps material slots and UVs); no operator context."""
    if ratio >= 0.999 or len(ob.data.polygons) < 2000:
        return ob
    m = ob.modifiers.new("Decimate", 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = ratio
    m.use_collapse_triangulate = False
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.remove(m)
    ob.data = me
    me.name = old.name
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return ob


def objects_from_parts(coll, parts, arm, j, mats, prefix="Pilot", ratio=1.0):
    """One object per part: materials (per-face slots), UVs, skinned or parented to its bone.
    ratio < 1 decimates the dense surface-net meshes first (the aircraft needs far fewer
    vertices than the studio close-ups)."""
    obs = []
    for p in parts:
        keys = p.get("mats") or [p["mat"]]
        ml = [mats[k] for k in keys]
        ob = io.mesh_obj(f"{prefix}_{p['name']}", p["v"], p["q"], coll, ml if len(ml) > 1 else ml[0])
        if "mi" in p:
            io.set_face_materials(ob, p["mi"])
        if "uv" in p:
            io.set_uv(ob, p["uv"])
        # parametric meshes with material zones or UVs keep their exact layout
        decimate(ob, 1.0 if ("mi" in p or "uv" in p) else ratio)
        if p["bone"] is None:
            io.skin(ob, arm, j, names=skin_set(p["name"]))
        else:
            io.parent_bone(ob, arm, p["bone"])
        obs.append(ob)
    return obs


def build_into(coll, j, F, mats, prefix="Pilot", h=0.004, timings=None, hand_pose=None, sole_n=None,
               cable_end=None, ik=False, only=None, ratio=1.0):
    """Meshes (numpy) and objects for joints j into coll; returns (armature, objects)."""
    tm = timings if timings is not None else {}
    t = time.time()
    parts = P.build(j, F, h=h, hand_pose=hand_pose, sole_n=sole_n, timings=tm, cable_end=cable_end, only=only)
    tm["meshes"] = round(time.time() - t, 1)
    t = time.time()
    arm = rig(coll, j, F, f"{prefix}_Rig", ik=ik)
    obs = objects_from_parts(coll, parts, arm, j, mats, prefix, ratio=ratio)
    tm["objects"] = round(time.time() - t, 1)
    tm["verts"] = int(sum(len(ob.data.vertices) for ob in obs))
    return arm, obs


class in_scene:
    """Make `sc` the window's scene for a block (edit-mode work needs its view layer)."""
    def __init__(self, sc):
        self.sc = sc

    def __enter__(self):
        self.win = bpy.context.window
        self.prev = self.win.scene if self.win else None
        if self.win:
            self.win.scene = self.sc
        return self.sc

    def __exit__(self, *exc):
        if self.win and self.prev:
            self.win.scene = self.prev


def standing(h=0.004, only=None, ratio=1.0):
    """The standing pilot in the studio scene."""
    sc, coll = studio.scene()
    with in_scene(sc):
        studio.clear(coll)
        mats = materials.all_materials()
        j = S.standing()
        F = S.frames(j)
        tm = {}
        arm, obs = build_into(coll, j, F, mats, prefix="Pilot", h=h, timings=tm, only=only, ratio=ratio)
    return {"objects": len(obs), "timings": tm, "rig": arm.name}


def save_blend(path=BLEND):
    """Save the studio.  In a background job the session holds only the studio, so it is saved
    as a normal file (opens on the studio scene); from an interactive session only the studio
    scene and what it uses are written (the open file is left alone)."""
    sc, _coll = studio.scene()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if bpy.app.background:
        bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)
    else:
        bpy.data.libraries.write(path, {sc}, path_remap='RELATIVE_ALL', fake_user=True, compress=True)
    return path
