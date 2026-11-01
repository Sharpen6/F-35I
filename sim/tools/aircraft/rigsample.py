"""Sample the Blender rig (armature F35I_Rig: custom-property controls, drivers, IK and track
constraints) and fit compact per-control transforms for the web app.

Every exported node is one rigid group of objects that follow the same rig bone.  For each control
the value is stepped over its range with all other controls at their defaults, the depsgraph is
evaluated and the world matrix of one object per group is read.  From that:

    D(x) = T(x) @ T(rest)^-1          the motion in the parent (model) frame
    L(x) = N^-1 @ D(x) @ N            the same motion in the node's own frame (N = node rest matrix:
                                      a translation to the group's pivot, the bone head)

L is stored per control and composed at run time (sim/js/aircraft/rig.js):

    node.matrix = N @ L_c[k] @ ... @ L_c[0]     (controls in COMPOSE order, inner first)

so combined controls compose (stick_pitch + stick_roll on the stabilators, nws + roll_distance +
gear on the nose wheel).  A group that only ever rotates about one fixed line (control surfaces,
doors, gear legs) is stored as signed angles about that hinge; the angles of all its controls
are summed and clamped to the Blender limits, as the rig's driver expressions do.  Wheel spin
(roll_distance) is a hinge with a constant rate (rad per metre).  Everything else stores
quaternion + translation samples.  Samples are taken densely and then thinned (greedy, max error
on the group's bounding-box corners) so linear interpolation stays within TOL_M.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix

from common import (log, rnd, quat_from_mat3, mat3_from_quat, slerp, axis_angle_mat3, rot_about, apply,
                    C_B2M)

TOL_M = 0.0015               # max interpolation error on a group's bounding-box corners (m)
DEG = math.pi / 180.0

# dense sample counts per control (the thinning keeps what linear interpolation needs)
DENSE = {
    "stick_pitch": 41, "stick_roll": 41, "pedals": 41, "throttle": 41, "flaps": 21, "speedbrake": 21,
    "gear": 201, "nws": 41, "weapon_bays": 81, "canopy": 41, "refuel_door": 31, "gun_door": 31,
    "tailhook": 31, "head_yaw": 41, "head_pitch": 31, "head_tilt": 25,
    "strut_nose": 9, "strut_left": 9, "strut_right": 9,
}
# head look is in degrees on the Blender rig; the JSON stores radians (SI)
DEGREE_CONTROLS = {"head_yaw", "head_pitch", "head_tilt"}

# composition order, inner (applied first, in the node's rest frame) to outer
COMPOSE = ["roll_distance", "strut_nose", "strut_left", "strut_right", "nws", "stick_pitch", "stick_roll",
           "pedals", "speedbrake", "flaps", "throttle", "weapon_bays", "canopy", "refuel_door", "gun_door",
           "tailhook", "head_pitch", "head_yaw", "head_tilt", "gear"]

# struts: oleo bones whose slide driver gets an extra compression term
STRUTS = {"strut_nose": "NG_Steer", "strut_left": "MG_Oleo_L", "strut_right": "MG_Oleo_R"}
STRUT_EXTEND = 0.05          # the struts may also extend this much below the modelled (static) pose


def add_strut_controls(arm, slides):
    """Add strut_<x> (m of compression from the modelled pose, + = shorter strut) to the oleo
    slide drivers: location.y of the oleo bone runs down the strut, so compression subtracts."""
    out = {}
    ad = arm.animation_data
    for prop, bone in STRUTS.items():
        fc = None
        if ad is not None:
            for f in ad.drivers:
                if f.data_path == f'pose.bones["{bone}"].location' and f.array_index == 1:
                    fc = f
        if fc is None:
            log("strut: no slide driver on", bone)
            continue
        arm[prop] = 0.0
        d = fc.driver
        v = d.variables.new()
        v.name = "c"
        v.type = 'SINGLE_PROP'
        v.targets[0].id_type = 'OBJECT'
        v.targets[0].id = arm
        v.targets[0].data_path = f'["{prop}"]'
        d.expression = f"({d.expression}) - c"
        out[prop] = {"bone": bone, "travel": slides.get(bone, 0.15)}
    return out


def control_specs(arm, struts):
    """[(name, default, lo, hi, description)] from the rig's own control list, plus the struts."""
    from f35 import rig as RIG
    specs = []
    for name, dv, lo, hi, desc in RIG.CONTROLS:
        if name == "roll_distance":
            lo, hi = -1.0e6, 1.0e6
        specs.append((name, float(dv), float(lo), float(hi), desc))
    for prop, s in struts.items():
        specs.append((prop, 0.0, -STRUT_EXTEND, s["travel"],
                      f"Strut compression from the modelled static pose (m, + = compressed), bone {s['bone']}"))
    # rest state: every control at its default (gear down)
    return specs


def _set(arm, name, value):
    arm[name] = value
    arm.update_tag()
    bpy.context.view_layer.update()


class Sampler:
    """Reads one representative world matrix per group (and driven shape-key values)."""

    def __init__(self, arm, groups):
        self.arm = arm
        self.groups = groups               # name -> dict(objects=[...], pivot=np(3), probe=np(8,3) local)
        self.reps = {}
        for g, d in groups.items():
            obs = d["objects"]
            self.reps[g] = obs[:2]         # two, to check that the group is rigid
        self.keys = []                     # (object, key block name)
        for ob in bpy.data.objects:
            if ob.type == 'MESH' and ob.data.shape_keys and ob.data.shape_keys.animation_data:
                for fc in ob.data.shape_keys.animation_data.drivers:
                    if fc.data_path.startswith("key_blocks["):
                        kb = fc.data_path.split('"')[1]
                        self.keys.append((ob, kb))

    def read(self):
        mats = {}
        for g, obs in self.reps.items():
            mats[g] = [np.array(ob.matrix_world, float) for ob in obs]
        keys = {(ob.name, kb): float(ob.data.shape_keys.key_blocks[kb].value) for ob, kb in self.keys}
        return mats, keys


def _local_delta(T, T0inv, piv):
    """L = N^-1 (T T0^-1) N for N = translation(piv)."""
    D = T @ T0inv
    N = np.eye(4)
    N[:3, 3] = piv
    Ni = np.eye(4)
    Ni[:3, 3] = -piv
    return Ni @ D @ N


def _angle_axis(R):
    q = quat_from_mat3(R)
    s = np.linalg.norm(q[:3])
    a = 2 * math.atan2(s, q[3])
    if s < 1e-12:
        return 0.0, np.array([1.0, 0.0, 0.0])
    return a, q[:3] / s


def _fit_hinge(Ls, probe):
    """If every L in Ls is a rotation about one fixed line, return (axis, pivot, angles); else None."""
    best, axis = 0.0, None
    for L in Ls:
        a, ax = _angle_axis(L[:3, :3])
        if a > best:
            best, axis = a, ax
    if axis is None or best < 1e-4:
        return None
    angles = []
    A, b = [], []
    for L in Ls:
        a, ax = _angle_axis(L[:3, :3])
        if a < 1e-9:
            angles.append(0.0)
            continue
        if abs(abs(float(np.dot(ax, axis))) - 1.0) > 2e-4:
            return None                       # a different axis
        angles.append(a if np.dot(ax, axis) > 0 else -a)
        if a > 1e-3:
            A.append(np.eye(3) - L[:3, :3])
            b.append(L[:3, 3])
    if not A:
        return None
    # rcond drops the (near-)null direction along the axis, where noise would blow up
    pivot, *_ = np.linalg.lstsq(np.vstack(A), np.concatenate(b), rcond=1e-6)
    # minimum-norm solution: the point on the axis closest to the node origin
    pivot = pivot - axis * float(np.dot(pivot, axis))
    for L, a in zip(Ls, angles):
        M = rot_about(axis, pivot, a)
        err = np.abs(apply(M, probe) - apply(L, probe)).max()
        if err > 1e-4:
            return None
    return axis, pivot, np.array(angles)


def _trs(L):
    return quat_from_mat3(L[:3, :3]), L[:3, 3].copy()


def _interp_err(kind, data, probe, i, a, b, xs):
    """Max probe-point error of interpolating sample i from samples a and b."""
    t = (xs[i] - xs[a]) / (xs[b] - xs[a])
    if kind == "hinge":
        axis, pivot, ang, Ls = data
        A = ang[a] + (ang[b] - ang[a]) * t
        M = rot_about(axis, pivot, A)
        return float(np.abs(apply(M, probe) - apply(Ls[i], probe)).max())
    qs, ts, Ls = data
    q = slerp(qs[a], qs[b], t)
    tr = ts[a] + (ts[b] - ts[a]) * t
    M = np.eye(4)
    M[:3, :3] = mat3_from_quat(q)
    M[:3, 3] = tr
    return float(np.abs(apply(M, probe) - apply(Ls[i], probe)).max())


def _thin(xs, fits, probes, keep_x=()):
    """Greedy refinement: start with the end points (and keep_x), add the worst sample until every
    group interpolates within TOL_M."""
    n = len(xs)
    keep = {0, n - 1}
    for kx in keep_x:
        keep.add(int(np.argmin(np.abs(xs - kx))))
    while True:
        ks = sorted(keep)
        added = False
        for a, b in zip(ks, ks[1:]):
            if b - a < 2:
                continue
            worst, wi = 0.0, None
            for i in range(a + 1, b):
                e = max((_interp_err(k, d, probes[g], i, a, b, xs) for g, (k, d) in fits.items()), default=0.0)
                if e > worst:
                    worst, wi = e, i
            if worst > TOL_M:
                keep.add(wi)
                added = True
        if not added:
            return sorted(keep)


def _thin_1d(xs, ys, tol=0.002):
    n = len(xs)
    keep = {0, n - 1}
    while True:
        ks = sorted(keep)
        added = False
        for a, b in zip(ks, ks[1:]):
            worst, wi = 0.0, None
            for i in range(a + 1, b):
                t = (xs[i] - xs[a]) / (xs[b] - xs[a])
                e = abs(ys[a] + (ys[b] - ys[a]) * t - ys[i])
                if e > worst:
                    worst, wi = e, i
            if worst > tol:
                keep.add(wi)
                added = True
        if not added:
            return sorted(keep)


def sample_rig(arm, groups, specs, limits):
    """Sample every control.  groups: name -> dict(objects, pivot (np, Blender), probe (np 8x3, local)).
    limits: group -> (min_deg, max_deg, bone_y_axis) for hinged surfaces with clamped drivers.
    Returns (controls_json, nodes_json, morphs_json) in the model frame."""
    smp = Sampler(arm, groups)
    defaults = {name: dv for name, dv, lo, hi, desc in specs}
    for name, dv in defaults.items():
        arm[name] = dv
    arm.update_tag()
    bpy.context.view_layer.update()
    rest, rest_keys = smp.read()
    T0inv = {g: np.linalg.inv(m[0]) for g, m in rest.items()}
    probes = {g: d["probe"] for g, d in groups.items()}
    controls_json, per_node, morphs = {}, {}, {}
    rigid_warn = set()
    for name, dv, lo, hi, desc in specs:
        if name == "roll_distance":
            xs = np.array([0.0, 0.05, 0.1, 0.2, 0.3])
        else:
            xs = np.linspace(lo, hi, DENSE.get(name, 21))
            if not np.any(np.isclose(xs, dv)):
                xs = np.sort(np.append(xs, dv))
        Ls = {g: [] for g in groups}
        keyvals = {k: [] for k in rest_keys}
        for x in xs:
            _set(arm, name, float(x))
            mats, keys = smp.read()
            for g, ms in mats.items():
                L = _local_delta(ms[0], T0inv[g], groups[g]["pivot"])
                Ls[g].append(L)
                if len(ms) > 1 and g not in rigid_warn:
                    L2 = _local_delta(ms[1], np.linalg.inv(rest[g][1]), groups[g]["pivot"])
                    if np.abs(apply(L2, probes[g]) - apply(L, probes[g])).max() > 1e-4:
                        rigid_warn.add(g)
                        log(f"WARNING group {g} is not rigid under {name}")
            for k, v in keys.items():
                keyvals[k].append(v)
        _set(arm, name, dv)
        # which groups move
        moving = {}
        for g, lst in Ls.items():
            dev = max(float(np.abs(apply(L, probes[g]) - probes[g]).max()) for L in lst)
            if dev > 5e-5:
                moving[g] = lst
        if name == "roll_distance":
            for g, lst in moving.items():
                fit = _fit_hinge(lst, probes[g])
                if fit is None:
                    log(f"WARNING roll_distance moves {g} but not as a spin")
                    continue
                axis, pivot, ang = fit
                rate = float(np.polyfit(xs, ang, 1)[0])
                per_node.setdefault(g, {})[name] = {"spin": (axis, pivot, rate)}
            controls_json[name] = {"default": dv, "min": lo, "max": hi, "desc": desc, "unit": "m"}
            continue
        fits = {}
        for g, lst in moving.items():
            h = _fit_hinge(lst, probes[g])
            if h is not None:
                axis, pivot, ang = h
                fits[g] = ("hinge", (axis, pivot, ang, lst))
            else:
                qs, ts = zip(*[_trs(L) for L in lst])
                qs = list(qs)
                for i in range(1, len(qs)):          # keep the quaternion hemisphere continuous
                    if np.dot(qs[i], qs[i - 1]) < 0:
                        qs[i] = -qs[i]
                fits[g] = ("trs", (qs, list(ts), lst))
        mkeys = {k: np.array(v) for k, v in keyvals.items() if np.ptp(v) > 1e-4}
        keep = _thin(xs, fits, probes, keep_x=(dv,)) if fits else [0, len(xs) - 1]
        for k, v in mkeys.items():
            keep = sorted(set(keep) | set(_thin_1d(xs, v)))
        scale = DEG if name in DEGREE_CONTROLS else 1.0
        controls_json[name] = {"default": dv * scale, "min": lo * scale, "max": hi * scale, "desc": desc,
                               "unit": "rad" if scale != 1.0 else ("m" if name.startswith("strut") else "1"),
                               "x": rnd([xs[i] * scale for i in keep], 6)}
        for g, (kind, data) in fits.items():
            if kind == "hinge":
                axis, pivot, ang, _ = data
                per_node.setdefault(g, {})[name] = {"hinge": (axis, pivot, ang[keep])}
            else:
                qs, ts, _ = data
                per_node.setdefault(g, {})[name] = {"trs": ([qs[i] for i in keep], [ts[i] for i in keep])}
        for (obn, kb), v in mkeys.items():
            morphs.setdefault(obn, {}).setdefault(kb, {})[name] = rnd(v[keep], 5)
        log(f"  {name}: {len(xs)} samples -> {len(keep)} kept, {len(fits)} nodes move")
    nodes_json = _nodes_to_json(per_node, groups, limits)
    return controls_json, nodes_json, morphs


def _nodes_to_json(per_node, groups, limits):
    C = C_B2M
    out = {}
    for g, ctrls in per_node.items():
        node = {"controls": {}}
        hinges = [c for c in ctrls.values() if "hinge" in c]
        common = None
        if hinges and len(hinges) == len(ctrls):
            ax0, pv0, _ = hinges[0]["hinge"]
            same = all(abs(abs(float(np.dot(h["hinge"][0], ax0))) - 1) < 1e-4 and
                       np.linalg.norm(np.cross(h["hinge"][1] - pv0, ax0)) < 2e-4 for h in hinges)
            if same:
                common = (ax0, pv0)
        if common is not None:
            ax0, pv0 = common
            lim = limits.get(g)
            sign = 1.0
            if lim is not None and float(np.dot(lim[2], ax0)) < 0:
                sign = -1.0                   # angles in the driver's sense (bone Y axis)
            axis = ax0 * sign
            hj = {"pivot": rnd(C @ pv0, 6), "axis": rnd(C @ axis, 6)}
            # the limits clamp a MIXED command (stick + pedals + flaps), as the drivers do; a node
            # moved by one control needs none, and its limits may be in another sense than its
            # samples (the gear doors rest open and their angles run negative to shut)
            if lim is not None and len(ctrls) > 1:
                hj["min"] = rnd(lim[0] * DEG, 6)
                hj["max"] = rnd(lim[1] * DEG, 6)
            node["hinge"] = hj
            for name, c in ctrls.items():
                ax, pv, ang = c["hinge"]
                s = sign * (1.0 if float(np.dot(ax, ax0)) > 0 else -1.0)
                node["controls"][name] = {"a": rnd(np.asarray(ang) * s, 6)}
        else:
            for name, c in ctrls.items():
                if "spin" in c:
                    ax, pv, rate = c["spin"]
                    node["controls"][name] = {"spin": {"pivot": rnd(C @ pv, 6), "axis": rnd(C @ ax, 6),
                                                       "rate": rnd(rate, 6)}}
                elif "hinge" in c:
                    ax, pv, ang = c["hinge"]
                    node["controls"][name] = {"pivot": rnd(C @ pv, 6), "axis": rnd(C @ ax, 6),
                                              "a": rnd(ang, 6)}
                else:
                    qs, ts = c["trs"]
                    qm, tm = [], []
                    for q, t in zip(qs, ts):
                        R = C @ mat3_from_quat(q) @ C.T
                        qq = quat_from_mat3(R)
                        if qm and np.dot(qq, qm[-1]) < 0:
                            qq = -qq
                        qm.append(qq)
                        tm.append(C @ t)
                    node["controls"][name] = {"q": rnd(qm, 6), "t": rnd(tm, 6)}
        out[g] = node
    return out
