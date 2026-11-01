"""Shared helpers for the aircraft exporter: paths, frames, small numeric tools.

Frames (see sim/DESIGN.md):
  Blender  : the model as built by scripts/f35 (Z up, nose towards -Y, +X = the aircraft's LEFT),
             origin at station s = 7.835 m (Blender y = 0) on the centre line, z = 0.
  model    : the glTF scene as written by Blender's exporter (Y up): (x, y, z)_model = (x, z, -y)_blender,
             so +X = left, +Y = up, +Z = forward.  All node data in f35i_rig.json is in this frame.
  body     : the sim's aircraft body frame, +X = right wing, +Y = up, -Z = forward; the model turned
             180 deg about Y: (x, y, z)_body = (-x, y, -z)_model = (-x, z, y)_blender.
             Everything under "info" in f35i_rig.json is in this frame.
"""
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
SCRIPTS = os.path.join(REPO, "scripts")

# Blender -> model (glTF) rotation, and Blender -> body
C_B2M = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
C_B2BODY = np.array([[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])

_T0 = time.time()


def log(*a):
    print(f"[aircraft {time.time() - _T0:7.1f}s]", *a, flush=True)


def b2m(v):
    """Blender point / direction -> model frame (list)."""
    return (C_B2M @ np.asarray(v, float)).tolist()


def b2body(v):
    """Blender point / direction -> body frame (list)."""
    return (C_B2BODY @ np.asarray(v, float)).tolist()


def rnd(x, n=5):
    """Round floats (recursively) for compact JSON."""
    if isinstance(x, (list, tuple)):
        return [rnd(v, n) for v in x]
    if isinstance(x, np.ndarray):
        return rnd(x.tolist(), n)
    if isinstance(x, (float, np.floating)):
        v = round(float(x), n)
        return 0.0 if v == 0 else v
    return x


# --------------------------------------------------------------------- rigid transforms (numpy)
def mat_to_np(m):
    return np.array([list(r) for r in m], float)


def quat_from_mat3(R):
    """Rotation matrix -> unit quaternion (x, y, z, w)."""
    m = R
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w])
    q /= np.linalg.norm(q)
    if q[3] < 0:
        q = -q
    return q


def mat3_from_quat(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def slerp(q0, q1, t):
    d = float(np.dot(q0, q1))
    if d < 0:
        q1, d = -q1, -d
    if d > 0.9995:
        q = q0 + (q1 - q0) * t
        return q / np.linalg.norm(q)
    th = math.acos(min(1.0, d))
    s = math.sin(th)
    return (math.sin((1 - t) * th) * q0 + math.sin(t * th) * q1) / s


def axis_angle_mat3(axis, a):
    axis = np.asarray(axis, float)
    axis = axis / np.linalg.norm(axis)
    x, y, z = axis
    c, s = math.cos(a), math.sin(a)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def rot_about(axis, pivot, a):
    """4x4: rotation by a about the line through pivot along axis."""
    R = axis_angle_mat3(axis, a)
    M = np.eye(4)
    M[:3, :3] = R
    p = np.asarray(pivot, float)
    M[:3, 3] = p - R @ p
    return M


def apply(M, pts):
    return pts @ M[:3, :3].T + M[:3, 3]


def git_commit():
    try:
        import subprocess
        out = subprocess.run(["git", "-C", REPO, "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                             timeout=10)
        return out.stdout.strip() or None
    except Exception:
        return None


def ensure_paths():
    for p in (HERE, SCRIPTS):
        if p not in sys.path:
            sys.path.insert(0, p)
