"""Tricycle landing gear: single nose wheel + two single-wheel main units.

Everything is modelled in the extended (down & locked) position, which is
the rest pose of the rig.  The kinematics are solved here and handed to the
rig builder through ``ctx["rig_bones"]``:

* every leg swings about one trunnion axis.  The axis is *solved* from the
  extended and the stowed pose (strut direction + axle direction), so the
  main legs retract forward-and-inboard on a canted axis, the nose leg
  straight forward;
* folding drag braces (two links, 2-bone IK, knee breaks into the well);
* telescopic retraction actuators (barrel + rod tracking each other);
* nose-wheel steering about the strut axis, wheel spin about the axles.

Coordinates in this file are (x, s, z) station triples; +x = left side.
"""
import math
import bmesh
from mathutils import Vector, Matrix

from .geom import P, get_collection, mesh_object, cylinder, uv_sphere, add_modifier_bevel, loft_rings
from .geom import ground_z_airframe
from . import materials as M

# --------------------------------------------------------------- key points
# Tyres sit statically loaded: the axle is lower than the free radius (photos c22, c29, c51, c53:
# loaded mains ~0.8 m, nose ~0.55 m tall), so the tyre bottoms dip under the apron, which reads
# as the flat contact patch.  The ground under each wheel comes from the stance (geom).
NG_DEFLECT, MG_DEFLECT = 0.030, 0.045
# nose gear
NG_R, NG_RIM, NG_W = 0.2985, 0.127, 0.191     # 23.5x7.5R10 tyre
NG_T = (0.0, 4.45, -0.42)          # trunnion centre
NG_C = (0.0, 4.25, ground_z_airframe(4.25) + NG_R - NG_DEFLECT)     # wheel centre; wheelbase 6.02 m
NG_TRAIL = 0.10                    # axle aft of the piston axis (single trailing arm, c51, ref_05)
NG_SLIDE = 0.229                   # oleo closes this much as the leg retracts, so it stows as before
NG_STOW_C = (0.0, 3.40, -0.28)     # wheel centre when stowed
NG_B = (0.0, 3.80, -0.08)          # drag-brace airframe pivot
NG_E = (0.0, 5.00, -0.15)          # actuator airframe pivot
# main gear (left; right is mirrored).  Head-on and side photos (c29, c50,
# c53) show near-vertical legs that disappear into the wing root just outboard
# of the inlet cowl, so the trunnion sits in the wing-root end of the well,
# high enough (inside the wing-root fillet) that the stowed leg clears the
# closed doors.
MG_T = (1.90, 10.12, 0.25)
MG_R, MG_RIM, MG_W = 0.432, 0.216, 0.279      # 34x11.0R17 tyre
MG_C = (2.17, 10.27, ground_z_airframe(10.27) + MG_R - MG_DEFLECT)     # wheel track 4.34 m
MG_SLIDE = 0.095                   # oleo closes this much as the leg retracts (stows as before)
MG_AXLE_OFF = 0.215                # strut centreline inboard of wheel centre
MG_OLEO = 1.15                     # oleo body length below the trunnion (piston below it)
MG_STOW_C = (1.20, 8.85, 0.13)     # wheel centre stowed (target), above/outboard of the weapon bay roof
MG_STOW_TILT = 50.0                # axle tilt when stowed (deg, outboard-up)
MG_B = (1.74, 9.40, 0.28)          # drag-brace airframe pivot (well roof)
MG_E = (1.62, 10.62, 0.31)         # actuator airframe pivot (well roof)


def W(p):
    return P(p[1], p[0], p[2])


def Wd(d):
    """direction (x, s, z) -> world vector"""
    return Vector((d[0], d[1], d[2]))


def mirror(p, side):
    return (p[0] * side, p[1], p[2])


# ------------------------------------------------------------ mesh helpers
def _recalc(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()


def lathe(name, coll, mat, centre, axis, prof, seg=40, closed=True):
    """Surface of revolution of profile [(radius, axial)] about axis."""
    axis = Vector(axis).normalized()
    u = axis.orthogonal().normalized()
    w = axis.cross(u).normalized()
    n = len(prof)
    verts = []
    for k in range(seg):
        t = 2 * math.pi * k / seg
        dv = u * math.cos(t) + w * math.sin(t)
        for r, a in prof:
            verts.append(Vector(centre) + axis * a + dv * r)
    faces = []
    m = n if closed else n - 1
    for k in range(seg):
        k1 = (k + 1) % seg
        for i in range(m):
            i1 = (i + 1) % n
            faces.append((k * n + i, k * n + i1, k1 * n + i1, k1 * n + i))
    ob = mesh_object(name, verts, faces, coll, mat, smooth=True, sharp_angle=50)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def bar(name, p0, p1, w, t, nrm, coll, mat, bevel=0.0):
    """Rectangular link from p0 to p1 (width w, thickness t along nrm)."""
    p0, p1 = Vector(p0), Vector(p1)
    ax = p1 - p0
    axn = ax.normalized()
    n = Vector(nrm)
    n = (n - axn * axn.dot(n)).normalized()
    b = axn.cross(n)
    v = [p0 + ax * a + b * (w * i) + n * (t * j)
         for a in (0.0, 1.0) for i in (-0.5, 0.5) for j in (-0.5, 0.5)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    ob = mesh_object(name, v, f, coll, mat, smooth=False)
    _recalc(ob)
    if bevel:
        add_modifier_bevel(ob, bevel, 2, 30)
    return ob


def tyre_profile(R, rim, Wd_, n=56, k=3.4):
    rc, h, hw = (R + rim) / 2, (R - rim) / 2, Wd_ / 2
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        c, s = math.cos(t), math.sin(t)
        r = rc + h * math.copysign(abs(c) ** (2 / k), c)
        a = hw * math.copysign(abs(s) ** (2 / k), s)
        # three circumferential tread grooves
        if c > 0.93:
            for ag in (-0.24, 0.0, 0.24):
                if abs(a - ag * Wd_) < Wd_ * 0.035:
                    r -= 0.007
        pts.append((r, a))
    return pts


def build_wheel(prefix, coll, centre, axle_dir, R, rim, width, outboard=1.0):
    """Tyre + hub + bolt ring + valve stem (non-axisymmetric so spin shows)."""
    a = Vector(axle_dir).normalized()
    c = Vector(centre)
    tyre = lathe(f"{prefix}_Tyre", coll, M.get("tyre"), c, a, tyre_profile(R, rim, width), seg=64)
    hw = width / 2
    o = outboard
    prof = [(0.0, o * hw * 0.62), (rim * 0.30, o * hw * 0.62), (rim * 0.40, o * hw * 0.45),
            (rim * 0.82, o * hw * 0.40), (rim * 0.95, o * hw * 0.80), (rim + 0.014, o * hw * 0.86),
            (rim + 0.016, o * hw * 0.74), (rim, o * hw * 0.70), (rim, -o * hw * 0.70),
            (rim + 0.016, -o * hw * 0.74), (rim + 0.014, -o * hw * 0.86), (rim * 0.95, -o * hw * 0.80),
            (rim * 0.60, -o * hw * 0.50), (rim * 0.30, -o * hw * 0.60), (0.0, -o * hw * 0.60)]
    hub = lathe(f"{prefix}_Hub", coll, M.get("hub"), c, a, prof, seg=48, closed=False)
    parts = [tyre, hub]
    u = a.orthogonal().normalized()
    w = a.cross(u)
    nb = 10 if R > 0.3 else 6
    for k in range(nb):
        t = 2 * math.pi * k / nb
        p = c + a * (o * hw * 0.42) + (u * math.cos(t) + w * math.sin(t)) * rim * 0.62
        b = cylinder(f"{prefix}_Bolt{k}", p, p + a * (o * 0.022), rim * 0.07, None, coll,
                     M.get("chrome"), segments=6)
        parts.append(b)
    # centre cap + valve stem + cooling slots (dark) on the outboard face
    cap = cylinder(f"{prefix}_Cap", c + a * (o * hw * 0.60), c + a * (o * hw * 0.70),
                   rim * 0.26, rim * 0.20, coll, M.get("chrome"), segments=20)
    parts.append(cap)
    vs = c + a * (o * hw * 0.55) + u * rim * 0.86
    parts.append(cylinder(f"{prefix}_Valve", vs, vs + a * (o * 0.035), 0.007, None, coll,
                          M.get("chrome"), segments=6))
    for k in range(nb // 2):
        t = 2 * math.pi * (k + 0.5) / (nb // 2)
        dv = u * math.cos(t) + w * math.sin(t)
        p0 = c + a * (o * hw * 0.425) + dv * rim * 0.42
        p1 = c + a * (o * hw * 0.425) + dv * rim * 0.78
        parts.append(bar(f"{prefix}_Slot{k}", p0, p1, rim * 0.16, 0.012, a, coll,
                         M.get("intake_dark")))
    return parts


# ------------------------------------------------------------- kinematics
def _frame(d, a):
    d = Vector(d).normalized()
    a = Vector(a)
    a = (a - d * a.dot(d)).normalized()
    return Matrix((d, a, d.cross(a))).transposed()


def solve_trunnion(T, d1, a1, d2, a2):
    """Rotation about a line through T taking (strut d1, axle a1) to (d2, a2).
    Returns (axis, angle_rad, R)."""
    R = _frame(d2, a2) @ _frame(d1, a1).transposed()
    q = R.to_quaternion()
    axis, ang = q.axis, q.angle
    if ang > math.pi:
        ang = 2 * math.pi - ang
        axis = -axis
    return axis.normalized(), ang, R


def rot_about(p, T, R):
    return T + R @ (Vector(p) - T)


def brace_geometry(Bw, Dw, pole_dir, over=0.012):
    """Two equal links B-K-D, slightly bent (over-centre) towards pole_dir."""
    d = (Dw - Bw)
    L = d.length
    Lk = L / 2 + over
    n = Vector(pole_dir)
    n = (n - d.normalized() * d.normalized().dot(n)).normalized()
    h = math.sqrt(max(Lk * Lk - (L / 2) ** 2, 0.0))
    K = (Bw + Dw) / 2 + n * h
    return K, Lk, n


# ------------------------------------------------------------------ build
def _bone(spec_list, name, head, tail, parent, objects=(), roll_axis=None, **kw):
    d = {"name": name, "head": Vector(head), "tail": Vector(tail), "parent": parent,
         "objects": [o.name for o in objects], "roll_axis": roll_axis}
    d.update(kw)
    spec_list.append(d)
    return d


def build_nose(coll, bones):
    """Nose leg as in the photos (c20, c29, c50, c51, ref_04, ref_05): a boxy white steering
    housing with the lamps on its front, a short chrome piston, a compact yoke and one curved
    trailing arm down the aircraft's LEFT side to a cantilevered axle; the right face of the wheel
    is clear, and the torque links sit behind the strut with the knee pointing aft."""
    T = W(NG_T)
    C = W(NG_C)
    X = Vector((1, 0, 0))
    fwd = Vector((0, -1, 0))
    Cp = C + fwd * NG_TRAIL                      # where the piston axis meets the axle height
    u = (Cp - T).normalized()                    # strut axis (down)
    L = (Cp - T).length
    fwd_perp = (fwd - u * u.dot(fwd)).normalized()
    gear, chrome, dark = M.get("gear"), M.get("chrome"), M.get("intake_dark")
    strut_objs, steer_objs = [], []
    # trunnion + upper (outer) cylinder
    strut_objs.append(cylinder("NG_Trunnion", T - X * 0.17, T + X * 0.17, 0.05, None, coll, gear))
    strut_objs.append(cylinder("NG_UpperStrut", T - u * 0.06, T + u * 0.50, 0.072, 0.068, coll, gear))
    # boxy steering housing (~0.24 m wide) just under the well
    hb0, hb1 = T + u * 0.12, T + u * 0.40
    strut_objs.append(bar("NG_SteerHousing", hb0 - fwd_perp * 0.01, hb1 - fwd_perp * 0.01, 0.24, 0.17,
                          fwd_perp, coll, gear, bevel=0.02))
    # taxi + landing lights on the front of the housing
    lamps = []
    for k, dz in enumerate((0.19, 0.31)):
        base = T + u * dz + fwd_perp * 0.075
        look = (fwd_perp * 0.9 - u * 0.15 * (k + 1)).normalized()
        strut_objs.append(cylinder(f"NG_LampBody{k}", base, base + look * 0.04, 0.045, 0.047, coll, gear,
                                   segments=16))
        lens = cylinder(f"NG_LampLens{k}", base + look * 0.04, base + look * 0.046, 0.042, None, coll,
                        M.get("landing_light"), segments=16)
        lens["light"] = "landing"
        strut_objs.append(lens)
        lamps.append(lens)
    # lower (sliding) part -> steer group: piston, yoke, trailing arm, axle, torque links
    yoke_d = L - (NG_R + 0.07)
    yoke = T + u * yoke_d
    steer_objs.append(cylinder("NG_Piston", T + u * 0.44, yoke + u * 0.01, 0.050, None, coll, chrome))
    # compact yoke under the piston, offset to the left so nothing passes the tyre's right edge
    steer_objs.append(bar("NG_Yoke", yoke - X * 0.06, yoke + X * 0.165, 0.13, 0.08, u, coll, gear, bevel=0.012))
    ax = 0.150                                   # arm centre plane, outside the tyre's left face
    arm_pts = [yoke + X * ax + u * 0.02,
               yoke + X * ax + u * 0.16 - fwd * 0.03,
               C + X * ax - u * 0.12 + fwd * 0.005,
               C + X * ax]
    for k in range(3):
        steer_objs.append(bar(f"NG_TrailArm{k}", arm_pts[k], arm_pts[k + 1], 0.085 - 0.008 * k, 0.045, X, coll,
                              gear, bevel=0.008))
    steer_objs.append(cylinder("NG_ArmBoss", C + X * (ax - 0.03), C + X * (ax + 0.035), 0.060, None, coll, gear,
                               segments=20))
    steer_objs.append(cylinder("NG_Axle", C - X * 0.06, C + X * (ax - 0.02), 0.030, None, coll, gear,
                               segments=12))
    lug = C + X * (ax + 0.01) + fwd * 0.06
    steer_objs.append(cylinder("NG_TowLug", lug, lug + fwd * 0.07, 0.018, 0.015, coll, gear, segments=10))
    # torque links behind the strut, knee pointing aft
    k_up = T + u * 0.47 - fwd_perp * 0.065
    knee = T + u * ((0.47 + yoke_d) / 2) - fwd_perp * 0.17
    k_lo = yoke - u * 0.02 - fwd_perp * 0.06
    steer_objs.append(bar("NG_TorqueLink_U", k_up, knee, 0.05, 0.03, X, coll, gear, bevel=0.005))
    steer_objs.append(bar("NG_TorqueLink_L", knee, k_lo, 0.05, 0.03, X, coll, gear, bevel=0.005))
    steer_objs.append(cylinder("NG_TorqueKnee", knee - X * 0.035, knee + X * 0.035, 0.018, None, coll,
                               chrome, segments=10))
    # wheel: hub face on the right, where nothing covers it
    wheel = build_wheel("NG_Wheel", coll, C, X, NG_R, NG_RIM, NG_W, outboard=-1.0)
    # ----------------------------------------------------- retraction solve
    # the oleo closes by NG_SLIDE first, so the stowed wheel lands where it always did
    Cs = W(NG_STOW_C)
    d1 = (C - u * NG_SLIDE) - T
    d2 = (Cs - T)
    axis, ang, R = solve_trunnion(T, d1, X, d2, X)
    # drag brace: B (airframe) -> K -> D (strut)
    Bw = W(NG_B)
    Dw = T + u * 0.56 + fwd_perp * 0.03
    pole = (Vector((0, 1, 0)) + Vector((0, 0, 1))).normalized()     # knee breaks aft-up
    K, Lk, n = brace_geometry(Bw, Dw, pole)
    br_u = bar("NG_DragBrace_U", Bw, K, 0.07, 0.05, X, coll, gear, bevel=0.008)
    br_l = bar("NG_DragBrace_L", K, Dw, 0.06, 0.045, X, coll, gear, bevel=0.008)
    hinge_pins = [cylinder("NG_BracePinB", Bw - X * 0.06, Bw + X * 0.06, 0.025, None, coll, chrome, segments=10),
                  cylinder("NG_BracePinK", K - X * 0.05, K + X * 0.05, 0.022, None, coll, chrome, segments=10)]
    strut_objs.append(cylinder("NG_BraceLug", Dw - X * 0.05, Dw + X * 0.05, 0.03, None, coll, gear,
                               segments=10))
    # retraction actuator: E (airframe) <-> F (strut, aft side)
    Ew = W(NG_E)
    Fw = T + u * 0.30 - fwd_perp * 0.07
    act_len = (Fw - Ew).length
    dirEF = (Fw - Ew).normalized()
    barrel_len = 0.50
    rod_len = 0.52
    barrel = cylinder("NG_ActBarrel", Ew, Ew + dirEF * barrel_len, 0.042, None, coll, gear, segments=14)
    rod = cylinder("NG_ActRod", Fw, Fw - dirEF * rod_len, 0.022, None, coll, chrome, segments=12)
    strut_objs.append(cylinder("NG_ActLug", Fw - X * 0.04, Fw + X * 0.04, 0.03, None, coll, gear,
                               segments=10))
    # ------------------------------------------------------------- bones
    _bone(bones, "NG_Strut", T, T + axis * 0.3, "Root", strut_objs + hinge_pins[:0],
          drive="gear_leg", angle=math.degrees(ang), unit="nose")
    _bone(bones, "NG_Steer", T + u * 0.40, T + u * 0.80, "NG_Strut", steer_objs, drive="nws", slide=NG_SLIDE)
    _bone(bones, "NG_Wheel", C, C + X * 0.2, "NG_Steer", wheel, drive="wheel_spin", radius=NG_R)
    _bone(bones, "NG_BraceTgt", Dw, Dw + X * 0.08, "NG_Strut")
    _bone(bones, "NG_BracePole", K + n * 0.8, K + n * 0.8 + X * 0.08, "Root")
    _bone(bones, "NG_BraceUp", Bw, K, "Root", [br_u, hinge_pins[0]], roll_axis=n)
    _bone(bones, "NG_BraceLo", K, Dw, "NG_BraceUp", [br_l, hinge_pins[1]], roll_axis=n,
          ik=("NG_BraceTgt", "NG_BracePole", 2))
    _bone(bones, "NG_ActE", Ew, Ew + X * 0.06, "Root")
    _bone(bones, "NG_ActF", Fw, Fw + X * 0.06, "NG_Strut")
    _bone(bones, "NG_ActBarrel", Ew, Ew + dirEF * barrel_len, "Root", [barrel], track="NG_ActF")
    _bone(bones, "NG_ActRod", Fw, Fw - dirEF * rod_len, "NG_Strut", [rod], track="NG_ActE")
    info = {"axis": axis, "angle": math.degrees(ang), "T": T, "R": R,
            "stowed_wheel": rot_about(C - u * NG_SLIDE, T, R), "brace": (Bw, Dw, Lk),
            "act": (Ew, Fw, barrel_len, rod_len, act_len), "lamps": [o.name for o in lamps]}
    return info


def build_main(coll, bones, side):
    tag = "L" if side > 0 else "R"
    T = W(mirror(MG_T, side))
    C = W(mirror(MG_C, side))
    a1 = Vector((side, 0, 0))                    # axle, pointing outboard
    S = C - a1 * MG_AXLE_OFF                      # strut bottom
    u = (S - T).normalized()
    Ls = (S - T).length
    aft = Vector((0, 1, 0))
    aft_p = (aft - u * u.dot(aft)).normalized()
    out_p = u.cross(aft_p) * side                 # outboard-ish, perpendicular to the strut
    if out_p.x * side < 0:
        out_p = -out_p
    gear, chrome = M.get("gear"), M.get("chrome")
    strut_objs = []
    # ------------------------------------------------------ retraction solve
    Cs = W(mirror(MG_STOW_C, side))
    tilt = math.radians(MG_STOW_TILT)
    a2 = Vector((side * math.cos(tilt), 0.0, math.sin(tilt)))
    Ss = Cs - a2 * MG_AXLE_OFF
    axis, ang, R = solve_trunnion(T, S - u * MG_SLIDE - T, a1, Ss - T, a2)     # oleo closed when stowed
    # trunnion along the solved hinge axis, running up into the wing root
    ax_up = axis if axis.z > 0 else -axis
    strut_objs.append(cylinder(f"MG_Trunnion_{tag}", T - ax_up * 0.12, T + ax_up * 0.07, 0.058, None,
                               coll, gear, segments=16))
    # long white oleo body (~0.19 m) with a tapered main fitting at the top
    # and a short chrome piston: photos c29/c53 show the thick cylinder
    # filling most of the leg below the wing root
    oleo = MG_OLEO
    # main fitting: widest just below the skin, round where it meets the
    # oleo, so head-on it reads as the inverted V of the photos.  The top
    # stays narrow: stowed, the leg's lateral axis points up into the wing.
    rings = []
    for t, a_, b_ in ((0.05, 0.11, 0.10), (0.22, 0.17, 0.10), (0.34, 0.14, 0.098), (0.62, 0.097, 0.097)):
        c = T + u * t
        rings.append([c + out_p * (a_ * math.cos(2 * math.pi * k / 24)) + aft_p * (b_ * math.sin(2 * math.pi * k / 24))
                      for k in range(24)])
    v, f = loft_rings(rings, True, True, True)
    fit = mesh_object(f"MG_MainFitting_{tag}", v, f, coll, gear, smooth=True)
    _recalc(fit)
    strut_objs.append(fit)
    strut_objs.append(cylinder(f"MG_UpperStrut_{tag}", T - u * 0.07, T + u * oleo, 0.095, 0.090, coll, gear,
                               segments=24))
    strut_objs.append(cylinder(f"MG_Gland_{tag}", T + u * (oleo - 0.04), T + u * (oleo + 0.04), 0.102, None,
                               coll, gear, segments=24))
    oleo_objs = []                               # slide up the strut as the leg retracts
    oleo_objs.append(cylinder(f"MG_Piston_{tag}", T + u * oleo, S + u * 0.02, 0.066, None, coll, chrome,
                              segments=20))
    oleo_objs.append(cylinder(f"MG_Knuckle_{tag}", S - a1 * 0.08, S + a1 * 0.10, 0.088, None, coll, gear,
                              segments=20))            # axle fitting at the foot of the piston
    oleo_objs.append(cylinder(f"MG_Axle_{tag}", S, C + a1 * 0.17, 0.045, None, coll, gear, segments=14))
    oleo_objs.append(cylinder(f"MG_Brake_{tag}", C - a1 * 0.115, C - a1 * 0.03, 0.16, None, coll,
                              M.get("intake_dark"), segments=24))
    # torque links (aft side), from the gland down to the axle fork
    t_up = T + u * (oleo + 0.05) + aft_p * 0.11
    knee = T + u * ((oleo + 0.05 + Ls - 0.07) / 2) + aft_p * 0.20
    t_lo = S - u * 0.07 + aft_p * 0.10
    nrm = u.cross(aft_p)
    strut_objs.append(bar(f"MG_TorqueLink_U_{tag}", t_up, knee, 0.06, 0.035, nrm, coll, gear, bevel=0.006))
    oleo_objs.append(bar(f"MG_TorqueLink_L_{tag}", knee, t_lo, 0.06, 0.035, nrm, coll, gear, bevel=0.006))
    oleo_objs.append(cylinder(f"MG_TorqueKnee_{tag}", knee - nrm * 0.04, knee + nrm * 0.04, 0.02, None,
                              coll, chrome, segments=10))
    # brake line down the front of the strut
    fwd_p = -aft_p
    pts = [T + u * 0.45 + fwd_p * 0.11, T + u * (oleo - 0.06) + fwd_p * 0.11, S - u * 0.12 + fwd_p * 0.09,
           C - a1 * 0.09 + fwd_p * 0.12]
    for k in range(len(pts) - 1):
        (oleo_objs if k == 2 else strut_objs).append(
            cylinder(f"MG_BrakeLine{k}_{tag}", pts[k], pts[k + 1], 0.009, None, coll, chrome, segments=6, cap=False))
    # wheel (outboard face shows the hub)
    wheel = build_wheel(f"MG_Wheel_{tag}", coll, C, a1, MG_R, MG_RIM, MG_W)
    # drag brace (forward)
    Bw = W(mirror(MG_B, side))
    Dw = T + u * 0.50 + fwd_p * 0.11
    pole = Vector((-side, 0, 0))                 # knee folds inboard, into the well (up would pierce the wing)
    K, Lk, n = brace_geometry(Bw, Dw, pole)
    br_u = bar(f"MG_DragBrace_U_{tag}", Bw, K, 0.085, 0.06, n.cross((Dw - Bw).normalized()), coll, gear,
               bevel=0.008)
    br_l = bar(f"MG_DragBrace_L_{tag}", K, Dw, 0.075, 0.055, n.cross((Dw - Bw).normalized()), coll, gear,
               bevel=0.008)
    pin_axis = (Dw - Bw).normalized().cross(n).normalized()
    pinB = cylinder(f"MG_BracePinB_{tag}", Bw - pin_axis * 0.07, Bw + pin_axis * 0.07, 0.028, None, coll,
                    chrome, segments=10)
    pinK = cylinder(f"MG_BracePinK_{tag}", K - pin_axis * 0.06, K + pin_axis * 0.06, 0.024, None, coll,
                    chrome, segments=10)
    strut_objs.append(cylinder(f"MG_BraceLug_{tag}", Dw - pin_axis * 0.06, Dw + pin_axis * 0.06, 0.034,
                               None, coll, gear, segments=10))
    # retraction actuator
    Ew = W(mirror(MG_E, side))
    Fw = T + u * 0.34 + aft_p * 0.12
    dirEF = (Fw - Ew).normalized()
    act_len = (Fw - Ew).length
    barrel_len, rod_len = 0.55, 0.58
    barrel = cylinder(f"MG_ActBarrel_{tag}", Ew, Ew + dirEF * barrel_len, 0.05, None, coll, gear, segments=14)
    rod = cylinder(f"MG_ActRod_{tag}", Fw, Fw - dirEF * rod_len, 0.026, None, coll, chrome, segments=12)
    strut_objs.append(cylinder(f"MG_ActLug_{tag}", Fw - nrm * 0.045, Fw + nrm * 0.045, 0.034, None, coll,
                               gear, segments=10))
    # ------------------------------------------------------------- bones
    _bone(bones, f"MG_Strut_{tag}", T, T + axis * 0.3, "Root", strut_objs, drive="gear_leg",
          angle=math.degrees(ang), unit="main")
    _bone(bones, f"MG_Oleo_{tag}", T + u * 0.6, T + u * 0.9, f"MG_Strut_{tag}", oleo_objs, slide=MG_SLIDE)
    _bone(bones, f"MG_Wheel_{tag}", C, C + a1 * 0.2, f"MG_Oleo_{tag}", wheel, drive="wheel_spin",
          radius=MG_R)
    _bone(bones, f"MG_BraceTgt_{tag}", Dw, Dw + pin_axis * 0.08, f"MG_Strut_{tag}")
    _bone(bones, f"MG_BracePole_{tag}", K + n * 0.8, K + n * 0.8 + pin_axis * 0.08, "Root")
    _bone(bones, f"MG_BraceUp_{tag}", Bw, K, "Root", [br_u, pinB], roll_axis=n)
    _bone(bones, f"MG_BraceLo_{tag}", K, Dw, f"MG_BraceUp_{tag}", [br_l, pinK], roll_axis=n,
          ik=(f"MG_BraceTgt_{tag}", f"MG_BracePole_{tag}", 2))
    _bone(bones, f"MG_ActE_{tag}", Ew, Ew + nrm * 0.06, "Root")
    _bone(bones, f"MG_ActF_{tag}", Fw, Fw + nrm * 0.06, f"MG_Strut_{tag}")
    _bone(bones, f"MG_ActBarrel_{tag}", Ew, Ew + dirEF * barrel_len, "Root", [barrel], track=f"MG_ActF_{tag}")
    _bone(bones, f"MG_ActRod_{tag}", Fw, Fw - dirEF * rod_len, f"MG_Strut_{tag}", [rod],
          track=f"MG_ActE_{tag}")
    info = {"axis": axis, "angle": math.degrees(ang), "T": T, "R": R,
            "stowed_wheel": rot_about(C - u * MG_SLIDE, T, R), "brace": (Bw, Dw, Lk),
            "act": (Ew, Fw, barrel_len, rod_len, act_len)}
    return info


def build(ctx):
    root = ctx["root"]
    coll = get_collection("LandingGear", root)
    bones = ctx.setdefault("rig_bones", [])
    info = {"nose": build_nose(coll, bones)}
    for side in (1, -1):
        info["main_" + ("L" if side > 0 else "R")] = build_main(coll, bones, side)
    ctx["gear"] = info
    return info
