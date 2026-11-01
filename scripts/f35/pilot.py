"""Seated F-35I pilot: the detailed pilot of scripts/pilot (lofted body in the IAF olive flight
suit, gloves, boots, Gen III helmet with visor and oxygen mask, survival vest, harness, G-suit,
hoses, helmet cable, kneeboard) posed in the ejection seat: right hand on the side-stick, left
hand on the throttle, boots on the rudder pedals.

The rig keeps the interface of the first pilot (f35/pilot_legacy.py): armature 'Pilot_Rig' with
IK_hand.L / IK_hand.R (rig.py ties them to the stick and throttle) and the head_yaw / head_pitch /
head_tilt properties driving the neck and head.

The meshes take a few minutes of numpy, so they are cached in blend/cache/pilot_seated.npz; the
cache is rebuilt when the pilot's sources or the cockpit targets change.
"""
import importlib
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

from .geom import get_collection

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
REPO = os.path.dirname(SCRIPTS)
CACHE = os.path.join(REPO, "blend", "cache", "pilot_seated.npz")
DECIMATE = 0.25                 # of the studio pilot's vertices: plenty inside the canopy

# design stations (x, s, z; +x = the pilot's left): the skull centre fitted to the photos (helmet
# ~8-10 cm under the glass, eyes at the design eye) and the hip-joint centre that a 1.78 m pilot
# reaches it from with a natural seated spine (pelvis 28, lumbar 24, chest 15 deg back, neck
# upright).  The first, shorter pilot sat at s 3.84, z 0.50; this one needs the seat bucket lowered
# (cockpit.BUCKET_DZ): hips 7.5 cm over the cushion, back on the back cushion.
HIP = (0.0, 3.807, 0.416)
HEAD_C = (0.0, 4.00, 1.06 + 0.088)


def _v(p):
    return np.array(tuple(p), float)


def _unit(a):
    a = np.asarray(a, float)
    return a / np.linalg.norm(a)


def targets():
    """Seat, grips and pedals in world coordinates (numpy), from the cockpit layout."""
    from .cockpit import W, CONSOLE_Z, SEAT_DZ

    def WS(x, s, z):
        return _v(W(x, s, z + SEAT_DZ))
    hip = WS(*HIP)
    head = WS(*HEAD_C)
    # side-stick: grip 0.06-0.16 m up a stick tilted 8 deg aft at the top (cockpit.build)
    th = math.radians(-8.0)
    axis = np.array([0.0, -math.sin(th), math.cos(th)])
    stick = _v(W(-0.375, 3.66, CONSOLE_Z + 0.03)) + axis * 0.11
    # throttle grip box on top of the lever
    thr = _v(W(0.37, 3.64, CONSOLE_Z + 0.02)) + np.array([0.012, -0.01, 0.15])
    grips = {"R": (stick, axis, _unit([1.0, -0.35, 0.0])),        # palm on the outboard-aft side
             "L": (thr, np.array([0.0, 0.0, 1.0]), _unit([-1.0, 0.0, -0.25]))}
    # feet: the balls of the boots on the pedal faces, toes up and forward
    fdir = _unit([0.0, -0.82, 0.57])
    n_sole = _unit([0.0, 0.57, 0.82])
    feet = {}
    for s, x in (("L", 0.14), ("R", -0.14)):
        face = _v(W(x, 2.86 + 0.01, 0.26))
        feet[s] = (face + n_sole * 0.045, n_sole, fdir)
    cable_end = hip + np.array([-0.20, 0.05, 0.05])            # seat-side connector, right
    return dict(hip=hip, head=head, grips=grips, feet=feet, cable_end=cable_end)


def _reload_pilot():
    if SCRIPTS not in sys.path:
        sys.path.insert(0, SCRIPTS)
    # twice: modules that import names from others (from .skeleton import unit) pick up the
    # reloaded versions on the second pass
    for _ in range(2):
        for name in sorted(n for n in sys.modules if n == "pilot" or n.startswith("pilot.")):
            importlib.reload(sys.modules[name])


def build(ctx):
    _reload_pilot()
    from pilot import build_pilot as BP, materials as PM, parts as P, skeleton as S
    t0 = time.time()
    t = targets()
    j, hints = S.seated(t["hip"], t["head"], t["grips"], t["feet"])
    F = S.frames(j, hints)
    sole_n = {s: t["feet"][s][1] for s in ("L", "R")}
    key = P.source_hash(json.dumps({k: np.round(np.asarray(v, float), 4).tolist() for k, v in j.items()},
                                   sort_keys=True) + json.dumps(np.round(t["cable_end"], 4).tolist()))
    parts, cached = P.cached_build(CACHE, key, j=j, F=F, h=0.004, hand_pose={"R": "grip", "L": "throttle"},
                                   sole_n=sole_n, cable_end=t["cable_end"])
    t1 = time.time()
    coll = get_collection("Pilot", ctx["root"])
    mats = PM.all_materials()
    arm = BP.rig(coll, j, F, "Pilot_Rig", ik=True)
    obs = BP.objects_from_parts(coll, parts, arm, j, mats, prefix="Pilot", ratio=DECIMATE)
    ctx["objects"]["Pilot_Rig"] = arm
    ctx["objects"]["Pilot_Body"] = bpy.data.objects.get("Pilot_Suit")
    ctx.setdefault("info", {})["pilot"] = {
        "cached": cached, "meshes_s": round(t1 - t0, 1), "objects_s": round(time.time() - t1, 1),
        "objects": len(obs), "verts": int(sum(len(o.data.vertices) for o in obs))}
    return arm


def helmet_centre():
    """Skull centre (world): where the helmet sits."""
    t = targets()
    return Vector(tuple(t["head"]))
