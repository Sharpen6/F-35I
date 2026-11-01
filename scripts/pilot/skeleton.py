"""Pilot skeleton: joint positions for a standing and a seated pose, and a frame for every bone.

Body frame (standing model): origin on the floor between the boots, +X = the pilot's LEFT,
-Y = forward, +Z = up.  The aircraft uses the same axes (+X = aircraft left, -Y = forward), so a
seated pose is solved directly in aircraft world coordinates.

Proportions: a ~1.78 m, 80 kg pilot (ANSUR II 50th percentile male: stature 1.756-1.78 m, sitting
height 0.91 m, biacromial breadth 0.40 m, hand 0.19 m, foot 0.27 m), wearing flight boots with a
25 mm sole.  The body is built separately in every pose from the same bone-attached solids
(scripts/pilot/body.py), so a seated pilot has no skinning artefacts at the hips and knees.

Each bone frame is a 3x3 matrix whose ROWS are the bone's axes in world space:
    X = the pilot's left (carried round with the bone), Y = along the bone (head -> tail),
    Z = anterior (front of the body part).
"""
import math

import numpy as np

SOLE = 0.025


def V(*a):
    return np.array(a, dtype=float)


def unit(a):
    n = np.linalg.norm(a)
    return a / n if n > 1e-12 else a


# --------------------------------------------------------------------- standing joints
# left side (x > 0); the right side mirrors it.  z without the boot sole.
_STAND_L = {
    "hip": (0.088, 0.004, 0.925),
    "knee": (0.094, -0.012, 0.500),
    "ankle": (0.098, 0.004, 0.082),
    "heel": (0.096, 0.058, 0.006),
    "ball": (0.110, -0.142, 0.016),
    "toe": (0.114, -0.200, 0.014),
    "clav": (0.022, -0.040, 1.440),          # sternoclavicular joint
    "shoulder": (0.184, 0.012, 1.412),       # glenohumeral joint
    "elbow": (0.222, 0.034, 1.112),
    "wrist": (0.242, 0.006, 0.848),
    "hand": (0.247, 0.000, 0.750),           # middle-finger knuckle
}
_STAND_C = {
    "pelvis": (0.0, 0.004, 0.925),           # hip-joint centre
    "spine": (0.0, 0.020, 1.070),            # L3, mid-depth of the torso
    "chest": (0.0, 0.022, 1.240),            # T10
    "neck": (0.0, 0.030, 1.478),             # base of the neck (C7 / sternal notch, mid-depth)
    "head": (0.0, 0.026, 1.622),             # atlas: the skull pivots here
    "head_top": (0.0, 0.010, 1.782),
}


def standing():
    """Joint positions of the standing pose (np arrays)."""
    j = {}
    for k, p in _STAND_C.items():
        j[k] = V(p[0], p[1], p[2] + SOLE)
    for k, p in _STAND_L.items():
        j[k + ".L"] = V(p[0], p[1], p[2] + SOLE)
        j[k + ".R"] = V(-p[0], p[1], p[2] + SOLE)
    return j


# bones: name, head joint, tail joint, parent
BONES = [
    ("pelvis", "pelvis", "spine", None),
    ("spine", "spine", "chest", "pelvis"),
    ("chest", "chest", "neck", "spine"),
    ("neck", "neck", "head", "chest"),
    ("head", "head", "head_top", "neck"),
]
for _s in ("L", "R"):
    BONES += [
        (f"clavicle.{_s}", f"clav.{_s}", f"shoulder.{_s}", "chest"),
        (f"upperarm.{_s}", f"shoulder.{_s}", f"elbow.{_s}", f"clavicle.{_s}"),
        (f"forearm.{_s}", f"elbow.{_s}", f"wrist.{_s}", f"upperarm.{_s}"),
        (f"hand.{_s}", f"wrist.{_s}", f"hand.{_s}", f"forearm.{_s}"),
        (f"thigh.{_s}", f"hip.{_s}", f"knee.{_s}", "pelvis"),
        (f"shin.{_s}", f"knee.{_s}", f"ankle.{_s}", f"thigh.{_s}"),
        (f"foot.{_s}", f"ankle.{_s}", f"ball.{_s}", f"shin.{_s}"),
        (f"toe.{_s}", f"ball.{_s}", f"toe.{_s}", f"foot.{_s}"),
    ]
BONE = {b[0]: b for b in BONES}


def lengths(j=None):
    j = j or standing()
    return {n: float(np.linalg.norm(j[t] - j[h])) for n, h, t, _p in BONES}


# anterior hints for the standing pose: the front of each part (toes and feet: the top)
def _stand_hint(name):
    base = name.split(".")[0]
    if base in ("foot", "toe"):
        return V(0, 0, 1)
    return V(0, -1, 0)


def frame(head, tail, ant, left=None):
    """Rows X (pilot's left), Y (along), Z (anterior) from a bone and an anterior hint."""
    y = unit(tail - head)
    z = unit(ant - y * (ant @ y))
    x = np.cross(y, z)
    if left is not None and x @ left < 0:
        x = -x
    return np.stack([x, y, z])


def frames(j, hints=None):
    """Frame of every bone for joints j; hints: bone -> anterior vector (defaults: standing)."""
    hints = hints or {}
    out = {}
    for n, h, t, _p in BONES:
        ant = hints.get(n, _stand_hint(n))
        out[n] = frame(j[h], j[t], ant, left=hints.get("_left_" + n, V(1, 0, 0)))
    return out


# --------------------------------------------------------------------- helpers for posing
def rot(axis, ang):
    """Rotation matrix (column-vector convention) about a unit axis."""
    a = unit(np.asarray(axis, float))
    c, s = math.cos(ang), math.sin(ang)
    x, y, z = a
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


def two_bone(a, target, l1, l2, pole):
    """Middle joint of a 2-bone chain from a towards target (lengths l1, l2), bending towards
    `pole` (a point).  The end is pulled in to the reachable range."""
    d = target - a
    dist = np.linalg.norm(d)
    dist_c = min(max(dist, abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4)
    u = d / dist
    end = a + u * dist_c
    x = (l1 * l1 - l2 * l2 + dist_c * dist_c) / (2 * dist_c)
    hgt = math.sqrt(max(l1 * l1 - x * x, 0.0))
    pv = pole - a
    pv = unit(pv - u * (pv @ u))
    return a + u * x + pv * hgt, end


def carry(j_rest, j_new, names, parent_head, frame_rest, frame_new):
    """Move rest joints `names` rigidly with a bone: p' = h' + Fn^T Fr (p - h)."""
    M = frame_new.T @ frame_rest
    for n in names:
        j_new[n] = j_new[parent_head] + M @ (j_rest[n] - j_rest[parent_head])


# --------------------------------------------------------------------- seated pose
def seated(hip_c, head_c_target, grips, feet, recline=math.radians(18.0)):
    """Seated pose in world coordinates.

    hip_c          hip-joint centre (on the seat cushion)
    head_c_target  where the skull centre should be (the helmet position fitted to photos)
    grips          {"R": (centre, axis, palm_dir), "L": ...}: grip centre, grip axis (up the
                   grip) and the direction the palm faces (from the palm to the grip centre)
    feet           {"L": (ball, sole_normal, foot_dir), ...}: ball of the foot on the pedal,
                   pedal face normal (out of the sole) and the foot's toe direction
    Returns (joints, hints): joints and the anterior hint of every bone for frames()."""
    js = standing()
    L = lengths(js)
    fr_s = frames(js)
    j = {}
    hints = {}
    # ---------------------------------------------- spine: fit the head centre
    # the pelvis, lumbar and thoracic bones recline back from vertical; neck and head come
    # forward again so the face looks ahead.  Search the two curvature terms that put the skull
    # centre on the target, the hip staying on the seat.
    head_off = 0.075                               # skull centre above the atlas (along head bone)
    best = None
    for a_low in np.radians(np.arange(8.0, 34.0, 0.5)):
        for a_up in np.radians(np.arange(-18.0, 22.0, 0.5)):
            angs = [a_low + 4 * math.pi / 180, a_low, recline * 0.85, a_up, a_up - 6 * math.pi / 180]
            p = hip_c.copy()
            pts = [p.copy()]
            for nm, ang in zip(("pelvis", "spine", "chest", "neck", "head"), angs):
                d = V(0, math.sin(ang), math.cos(ang))      # +y = back
                p = p + d * L[nm]
                pts.append(p.copy())
            atlas, top = pts[4], pts[5]
            hc = atlas + unit(top - atlas) * head_off
            e = np.linalg.norm(hc - head_c_target)
            if best is None or e < best[0]:
                best = (e, pts, angs)
    _e, pts, angs = best
    for nm, p in zip(("pelvis", "spine", "chest", "neck", "head", "head_top"), pts):
        j[nm] = p
    for nm, ang in zip(("pelvis", "spine", "chest", "neck", "head"), angs):
        hints[nm] = V(0, -math.cos(ang), math.sin(ang))
    fr = {n: frame(j[BONE[n][1]], j[BONE[n][2]], hints[n], V(1, 0, 0))
          for n in ("pelvis", "spine", "chest", "neck", "head")}
    # hips ride with the pelvis, clavicles with the chest
    for s in ("L", "R"):
        carry(js, j, [f"hip.{s}"], "pelvis", fr_s["pelvis"], fr["pelvis"])
        carry(js, j, [f"clav.{s}", f"shoulder.{s}"], "chest", fr_s["chest"], fr["chest"])
    # shoulders forward and down a little (reaching for the stick and throttle)
    for s, sg in (("L", 1), ("R", -1)):
        j[f"shoulder.{s}"] = j[f"shoulder.{s}"] + V(0, -0.015, -0.012)
        hints[f"clavicle.{s}"] = fr["chest"][2]
    # ---------------------------------------------- arms
    for s, sg in (("L", 1), ("R", -1)):
        c, axis, palm = grips[s]
        axis, palm = unit(axis), unit(palm)
        # power grip on a near-vertical handle: the forearm points forward past the grip, the
        # palm lies against its outboard side (palm -> grip centre = `palm`), thumb up.
        # hand_dir (wrist -> middle knuckle) = palm x axis for the right hand, axis x palm for
        # the left one, tipped a little towards the grip.
        hand_dir = unit(-sg * np.cross(palm, axis))
        hand_dir = unit(hand_dir + palm * 0.30)
        knuck = c - palm * 0.028 + hand_dir * 0.022
        wrist = knuck - hand_dir * L[f"hand.{s}"]
        sh = j[f"shoulder.{s}"]
        pole = sh + V(sg * 0.45, 0.30, -0.35)          # elbows out, back and down
        el, wr = two_bone(sh, wrist, L[f"upperarm.{s}"], L[f"forearm.{s}"], pole)
        j[f"elbow.{s}"], j[f"wrist.{s}"] = el, wr
        j[f"hand.{s}"] = wr + hand_dir * L[f"hand.{s}"]
        hints[f"upperarm.{s}"] = V(0, -1, 0.3)
        hints[f"forearm.{s}"] = axis                  # thumb side up the grip
        hints[f"hand.{s}"] = axis
        hints[f"_grip_{s}"] = (c, axis, palm)
    # ---------------------------------------------- legs
    for s, sg in (("L", 1), ("R", -1)):
        ball, n_sole, fdir = feet[s]
        n_sole, fdir = unit(n_sole), unit(fdir)
        ankle = ball - fdir * 0.150 + n_sole * 0.065   # ankle above / behind the ball, sole on the pedal
        hip = j[f"hip.{s}"]
        pole = hip + V(sg * 0.10, -0.6, 0.55)           # knees up, forward, a little out
        kn, an = two_bone(hip, ankle, L[f"thigh.{s}"], L[f"shin.{s}"], pole)
        j[f"knee.{s}"], j[f"ankle.{s}"] = kn, an
        j[f"ball.{s}"] = an + unit(ball - an) * L[f"foot.{s}"]
        j[f"toe.{s}"] = j[f"ball.{s}"] + fdir * L[f"toe.{s}"]
        j[f"heel.{s}"] = an - fdir * 0.058 - n_sole * 0.075
        hints[f"thigh.{s}"] = V(0, 0, 1)                # knee cap up
        hints[f"shin.{s}"] = V(0, -1, 0.2)
        hints[f"foot.{s}"] = n_sole
        hints[f"toe.{s}"] = n_sole
    return j, hints


def standing_hints():
    return {}
