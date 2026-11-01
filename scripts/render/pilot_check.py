"""Check the pilot inside the aircraft (background Blender): clearances, hand IK and a few stills.

    blender -b --factory-startup --python scripts/render/pilot_check.py -- \
        --blend blend/F-35I_Adir_newpilot.blend --prefix np_ --res 1280x720 --samples 64

Prints lines starting with CHECK:
  * pilot objects and vertices,
  * the gap between the helmet and the canopy glass for the head-look extremes (canopy closed),
  * how far each IK hand ends from its target (stick / throttle), at rest and with the stick
    and throttle moved,
  * stills of the pilot (renders/review/<prefix>pilot_<view>.png).
"""
import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import bpy                  # noqa: E402
import numpy as np          # noqa: E402
from mathutils import Vector                    # noqa: E402
from mathutils.bvhtree import BVHTree           # noqa: E402

import clips                # noqa: E402
import review               # noqa: E402
from history_stills import fix_sky   # noqa: E402

# name: (camera, target, lens, canopy open, head (yaw, pitch, tilt))
# the front views look in under the raised canopy from low on the left (it hinges at the front,
# so a camera ahead of the jet sees the pilot through the glass)
FRONT = ((2.55, -5.95, 1.42), (0.0, -4.35, 1.02), 52)
VIEWS = {
    "left": ((2.35, -4.10, 1.55), (0.0, -4.30, 0.95), 50, 0.0, (0, 0, 0)),
    "left_open": ((2.35, -4.10, 1.55), (0.0, -4.30, 0.95), 50, 1.0, (0, 0, 0)),
    "front_open": FRONT + (1.0, (0, 0, 0)),
    "rhs_open": ((-1.25, -4.55, 1.50), (0.08, -4.35, 0.85), 26, 1.0, (0, 0, 0)),
    "look_left": FRONT + (1.0, (75, 5, 0)),
    "look_right": FRONT + (1.0, (-75, 5, 0)),
    "look_up": FRONT + (1.0, (0, 35, 0)),
    "look_down": FRONT + (1.0, (0, -35, 0)),
}
POSES = [(0, 0, 0), (75, 5, 0), (-75, 5, 0), (0, 35, 0), (0, -35, 0), (20, 0, 25), (-20, 0, -25), (100, 0, 0)]


def log(*a):
    print("CHECK", *a, flush=True)


def world_points(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    mw = np.array(ev.matrix_world)
    return co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]


def head_pose(arm, yaw, pitch, tilt):
    arm["head_yaw"], arm["head_pitch"], arm["head_tilt"] = float(yaw), float(pitch), float(tilt)
    arm.update_tag()
    sc = bpy.context.scene
    sc.frame_set(sc.frame_current)


def glass_gap(glass, helmet):
    """Smallest distance from the helmet (and visor) to the canopy glass, and how many helmet
    points lie behind the nearest glass face (the inner face's normals look into the cockpit, so
    a point behind it is in or through the glass)."""
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(glass, dg)
    inv = glass.matrix_world.inverted()
    best, behind = 9.0, 0
    for ob in helmet:
        pts = world_points(ob)
        for p in pts[:: max(1, len(pts) // 4000)]:
            q = inv @ Vector(p)
            hit = bvh.find_nearest(q)
            if hit[0] is None:
                continue
            loc, nrm, _i, d = hit
            if (q - loc).dot(nrm) < 0.0:
                behind += 1
            best = min(best, d)
    return round(best, 4), behind


def hand_gaps(pilot, rest=None):
    """Distance from each hand to its IK target, and how far the target moved from `rest`."""
    out = {}
    for s in ("L", "R"):
        h = pilot.matrix_world @ pilot.pose.bones[f"hand.{s}"].head
        t = pilot.matrix_world @ pilot.pose.bones[f"IK_hand.{s}"].head
        out[s] = round((h - t).length, 4)
        if rest is not None:
            out[s + "_moved"] = round((t - rest[s]).length, 4)
    return out


def ik_targets(pilot):
    return {s: (pilot.matrix_world @ pilot.pose.bones[f"IK_hand.{s}"].head).copy() for s in ("L", "R")}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--blend", default=os.path.join(ROOT, "blend", "F-35I_Adir.blend"))
    ap.add_argument("--prefix", default="np_")
    ap.add_argument("--res", default="1280x720")
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--views", default=",".join(VIEWS))
    ap.add_argument("--no-render", action="store_true")
    a = ap.parse_args(argv)
    t0 = time.time()
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(a.blend))
    log("open", os.path.basename(a.blend), "sky fixed:", fix_sky())
    clips.clear_rig_animation()
    arm = clips.rig()
    pilot = bpy.data.objects["Pilot_Rig"]
    pobs = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith("Pilot_")]
    log("pilot objects", len(pobs), "verts", sum(len(o.data.vertices) for o in pobs))
    glass = bpy.data.objects.get("Canopy_Glass")
    helmet = [o for o in pobs if o.name.startswith(("Pilot_Helmet", "Pilot_Visor"))]
    log("helmet parts", [o.name for o in helmet])
    arm["canopy"] = 0.0
    for pose in POSES:
        head_pose(arm, *pose)
        gap = glass_gap(glass, helmet) if glass is not None and helmet else None
        log("head", pose, "glass gap m, points behind the glass:", gap)
    head_pose(arm, 0, 0, 0)
    log("hand gap at rest", hand_gaps(pilot))
    rest = ik_targets(pilot)
    for k, v in (("stick_roll", 1.0), ("stick_roll", -1.0), ("stick_pitch", 1.0), ("stick_pitch", -1.0),
                 ("throttle", 1.0), ("throttle", 0.0)):
        if k not in arm.keys():
            continue
        old = arm[k]
        arm[k] = v
        arm.update_tag()
        bpy.context.scene.frame_set(bpy.context.scene.frame_current)
        log("hand gap", k, v, hand_gaps(pilot, rest))
        arm[k] = old
    arm.update_tag()
    if a.no_render:
        log("done", round(time.time() - t0, 1))
        return
    res = tuple(int(v) for v in a.res.lower().split("x"))
    clips.setup_render(res, a.samples, 24, "CYCLES", ("4k",))
    clips.set_visibility()
    sc = bpy.context.scene
    for ob in bpy.data.objects:
        if ob.name.startswith(review.HIDE_PREFIX):
            ob.hide_render = True
    os.makedirs(review.OUT, exist_ok=True)
    for v in [v for v in a.views.split(",") if v]:
        loc, tgt, lens, canopy, (yaw, pitch, tilt) = VIEWS[v]
        arm["canopy"] = canopy
        head_pose(arm, yaw, pitch, tilt)
        clips.camera(loc, tgt, lens)
        sc.render.filepath = os.path.join(review.OUT, f"{a.prefix}pilot_{v}.png")
        t = time.time()
        bpy.ops.render.render(write_still=True)
        log("render", v, f"{time.time() - t:.1f}s", sc.render.filepath)
    log("done", round(time.time() - t0, 1))


if __name__ == "__main__":
    main()
