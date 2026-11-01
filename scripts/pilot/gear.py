"""The pilot's flight gear over the flight suit, built from the same bone frames as the body so it
fits any pose: survival vest with the harness webbing and Koch fittings, full-coverage G-suit
trousers, the oxygen hose from the mask to the chest, the regulator hose, the helmet cable, the
kneeboard, the suit's collar, pockets, patches and a wrist watch.

Garments are offset copies of the body's lofts (sdf.Offset) cut to their extent by planes that
ride on the bones.  Straps are thin skins over a garment, kept only inside a ribbon (a tube
around the strap's path), so they follow the surface whatever the pose.
"""
import math

import numpy as np

from . import body, helmet, sdf
from .skeleton import BONE, unit

BIG = ((-3.0, -3.0, -3.0), (3.0, 3.0, 3.0))
VEST_T = 0.016          # vest thickness over the suit
GSUIT_T = 0.011         # G-suit over the suit
STRAP_T = 0.0050        # webbing thickness (>= 2.5 grid cells of the 2 mm strap meshes)


def side(c, n, lo=None, hi=None):
    """Solid filling the half space on the n side of the plane through c."""
    lo = BIG[0] if lo is None else lo
    hi = BIG[1] if hi is None else hi
    return sdf.Plane(c, -np.asarray(n, float), lo, hi)


def place(j, F, bone, x, t, z):
    return body._place(j, F, bone, (x, t, z))


def surface(solid, origin, direction, rmax=0.4):
    """First point where `solid` is crossed going out from origin along direction."""
    d = unit(np.asarray(direction, float))
    o = np.asarray(origin, float)
    lo, hi = 0.0, rmax
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if solid.dist((o + d * mid)[None])[0] < 0:
            lo = mid
        else:
            hi = mid
    return o + d * lo


def mesh(ops, h, pad=0.03, smooth=3, lo=None, hi=None):
    """Mesh a list of (solid, k, op) inside the bounds of the union solids (or lo/hi)."""
    if lo is None:
        uni = [s for s, _k, op in ops if op == "union"]
        lo = np.min([s.aabb()[0] for s in uni], axis=0) - pad
        hi = np.max([s.aabb()[1] for s in uni], axis=0) + pad
    f = sdf.Field(lo, hi, h)
    for s, k, op in ops:
        f.add(s, k, op)
    return f.mesh(smooth=smooth)


# ----------------------------------------------------------------------------------- bases
def lofts(j, F):
    torso = body.loft(j, F, body.TORSO, rounds=body.LOFT_ROUND["torso"])
    arms = {s: body.loft(j, F, body.ARM, s, body.LOFT_ROUND["arm"]) for s in ("L", "R")}
    legs = {s: body.loft(j, F, body.LEG, s, body.LOFT_ROUND["leg"]) for s in ("L", "R")}
    return torso, arms, legs


def vest_base(j, F, torso):
    return sdf.sampled(sdf.Offset(torso, VEST_T), h=0.004)


def gsuit_base(j, F, torso, legs):
    return sdf.sampled(sdf.Offset(sdf.Union([torso, legs["L"], legs["R"]], 0.04), GSUIT_T), h=0.004)


def skin_strap(base, path, width, thick=STRAP_T, lift=0.0):
    """(solid, k, op) list: a strap of `width` over `base` along `path` (points near the surface):
    a skin `thick` over the base, kept inside a ribbon tube round the path."""
    tube = sdf.Tube(path, width / 2, band=0.01)

    def f(P):
        shp = P.shape[:-1]
        Q = P.reshape(-1, 3)
        dt = tube.dist(Q)
        out = np.maximum(dt, 0.01)
        m = dt < 0.01
        if m.any():
            db = base.dist(Q[m])
            skin = np.maximum(db - (lift + thick), -(db - (lift - 0.0008)))
            out[m] = np.maximum(skin, dt[m])
        return out.reshape(shp)
    lo, hi = tube.aabb()
    return [(sdf.Custom(f, lo, hi), 0.0, "union")]


def ring(centre, axis, radius, n=48):
    a = unit(np.asarray(axis, float))
    u = unit(np.cross(a, [0.0, 0.0, 1.0]) if abs(a[2]) < 0.9 else np.cross(a, [1.0, 0.0, 0.0]))
    v = np.cross(a, u)
    th = np.linspace(0, 2 * np.pi, n + 1)
    return np.asarray(centre)[None] + radius * (np.cos(th)[:, None] * u + np.sin(th)[:, None] * v)


# ----------------------------------------------------------------------------------- vest
def vest_parts(j, F, torso, arms):
    base = vest_base(j, F, torso)
    Fs, Fc = F["spine"], F["chest"]
    waist = place(j, F, "spine", 0.0, 0.12, 0.0)
    neck_a = place(j, F, "chest", 0.0, 0.78, 0.0)
    ops = [(base, 0.0, "union"),
           (side(waist, -Fs[1]), 0.006, "sub"),
           (sdf.RoundCone(neck_a, j["head"] + F["neck"][1] * 0.05, 0.074, 0.080), 0.012, "sub")]
    for s in ("L", "R"):
        ops.append((sdf.Offset(arms[s], 0.010), 0.010, "sub"))
    # pockets: upper chest and lower front, both sides
    for sg in (1.0, -1.0):
        for bone, t, x, half in (("chest", 0.52, 0.086, (0.046, 0.058, 0.013)),
                                 ("spine", 0.72, 0.092, (0.050, 0.044, 0.013))):
            o = place(j, F, bone, x * sg, t, 0.0)
            p = surface(base, o, F[bone][2])
            R = F[bone]
            ops.append((sdf.RoundBox(p + R[2] * 0.004, half, 0.008, R), 0.010, "union"))
    v, q = mesh(ops, 0.004, smooth=3)
    out = [dict(name="Vest", v=v, q=q, mat="vest", bone=None)]
    # front zip: a ridge down the centre line
    pts = []
    for bone, t in (("spine", 0.16), ("spine", 0.6), ("chest", 0.1), ("chest", 0.45), ("chest", 0.75)):
        o = place(j, F, bone, 0.0, t, 0.0)
        pts.append(surface(base, o, F[bone][2]))
    zp = sdf.spline(pts, 8)
    v, q = mesh([(sdf.Tube(zp, 0.0042, band=0.01), 0.0, "union")], 0.0015, smooth=1)
    out.append(dict(name="Vest_Zip", v=v, q=q, mat="zip", bone=None))
    return out, base


HARNESS = {
    # shoulder strap, left side (mirrored): back -> over the shoulder -> down the front
    "shoulder": [("chest", 0.090, 0.40, -1.0), ("chest", 0.100, 0.80, -1.0), ("chest", 0.110, 1.05, 0.0),
                 ("chest", 0.100, 0.82, 1.0), ("chest", 0.090, 0.55, 1.0), ("chest", 0.085, 0.25, 1.0),
                 ("spine", 0.085, 0.70, 1.0), ("spine", 0.090, 0.30, 1.0)],
}


def _strap_path(j, F, base, spec_pts, sg):
    pts = []
    for bone, x, t, zs in spec_pts:
        o = place(j, F, bone, x * sg, t, 0.0)
        R = F[bone]
        if zs == 0.0:
            d = R[1]
        else:
            d = R[2] * zs
        pts.append(surface(base, o, d))
    return sdf.spline(pts, 8)


def harness_parts(j, F, vbase, gbase):
    """Harness webbing over the vest, chest strap, Koch fittings, leg loops round the thighs."""
    ops_web = []
    out = []
    koch = []
    for sg in (1.0, -1.0):
        path = _strap_path(j, F, vbase, HARNESS["shoulder"], sg)
        ops_web.append(skin_strap(vbase, path, 0.044))
        # Koch fitting on the upper chest
        o = place(j, F, "chest", 0.086 * sg, 0.62, 0.0)
        p = surface(vbase, o, F["chest"][2])
        koch.append((p, F["chest"]))
    # chest strap
    pts = []
    for x in (-0.13, -0.07, 0.0, 0.07, 0.13):
        o = place(j, F, "chest", x, 0.30, 0.0)
        d = unit(F["chest"][2] + F["chest"][0] * x * 3.0)
        pts.append(surface(vbase, o, d))
    ops_web.append(skin_strap(vbase, sdf.spline(pts, 6), 0.036))
    for k, ops in enumerate(ops_web):
        v, q = mesh(ops, 0.002, smooth=2)
        out.append(dict(name=f"Harness_Web{k}", v=v, q=q, mat="webbing", bone=None))
    # leg loops round each thigh (over the G-suit), joined to the lower harness at the hips
    for sg, s in ((1.0, "L"), (-1.0, "R")):
        c = place(j, F, f"thigh.{s}", 0.0, 0.16, 0.0)
        R = F[f"thigh.{s}"]
        pts = []
        for a in np.linspace(0, 2 * np.pi, 25):
            d = R[0] * math.cos(a) + R[2] * math.sin(a)
            pts.append(surface(gbase, c, d))
        ops = skin_strap(gbase, np.array(pts), 0.040)
        lo, hi = np.min(pts, 0) - 0.04, np.max(pts, 0) + 0.04
        v, q = mesh(ops, 0.002, smooth=2, lo=lo, hi=hi)
        out.append(dict(name=f"Harness_Leg_{s}", v=v, q=q, mat="webbing", bone=None))
    # Koch fittings: a metal plate with a rounded bar and a release lever
    ops = []
    for p, R in koch:
        ops.append((sdf.RoundBox(p + R[2] * 0.008, (0.020, 0.026, 0.007), 0.003, R), 0.0, "union"))
        ops.append((sdf.RoundCone(p + R[2] * 0.016 - R[0] * 0.016 + R[1] * 0.018,
                                  p + R[2] * 0.016 + R[0] * 0.016 + R[1] * 0.018, 0.0045, 0.0045), 0.002, "union"))
    v, q = mesh(ops, 0.0012, smooth=2)
    out.append(dict(name="Harness_Koch", v=v, q=q, mat="metal", bone="chest"))
    return out


# ----------------------------------------------------------------------------------- G-suit
def gsuit_parts(j, F, torso, legs):
    base = gsuit_base(j, F, torso, legs)
    waist = place(j, F, "spine", 0.0, 0.32, 0.0)
    ops = [(base, 0.0, "union"), (side(waist, F["spine"][1]), 0.008, "sub")]
    for s in ("L", "R"):
        c = place(j, F, f"shin.{s}", 0.0, 0.76, 0.0)
        lo, hi = c - 0.20, c + 0.20
        ops.append((side(c, F[f"shin.{s}"][1], lo, hi), 0.008, "sub"))
    # abdominal bladder
    o = place(j, F, "spine", 0.0, 0.0, 0.0)
    p = surface(base, o, F["spine"][2])
    # abdominal bladder: a broad raised panel over the belly, not a dome
    ops.append((sdf.Ellipsoid(p - F["spine"][2] * 0.012, (0.135, 0.085, 0.018), F["spine"]), 0.04, "union"))
    for sg, s in ((1.0, "L"), (-1.0, "R")):
        R = F[f"thigh.{s}"]
        # thigh pocket, front-outer
        o = place(j, F, f"thigh.{s}", 0.0, 0.42, 0.0)
        d = unit(R[2] * 0.35 + R[0] * sg)          # on the outer side of the thigh
        p = surface(base, o, d)
        Rp = np.stack([unit(np.cross(R[1], d)), R[1], d])
        ops.append((sdf.RoundBox(p + d * 0.002, (0.052, 0.072, 0.012), 0.008, Rp), 0.008, "union"))
        # calf pocket
        Rs = F[f"shin.{s}"]
        o = place(j, F, f"shin.{s}", 0.0, 0.30, 0.0)
        d = unit(Rs[2] * 0.4 + Rs[0] * sg)
        p = surface(base, o, d)
        Rp = np.stack([unit(np.cross(Rs[1], d)), Rs[1], d])
        ops.append((sdf.RoundBox(p + d * 0.001, (0.038, 0.060, 0.010), 0.007, Rp), 0.006, "union"))
    v, q = mesh(ops, 0.004, smooth=3)
    out = [dict(name="GSuit", v=v, q=q, mat="gsuit", bone=None)]
    # lacing panels down the outer legs and zips down the inner legs
    ops = []
    zops = []
    for sg, s in ((1.0, "L"), (-1.0, "R")):
        lace, zipl = [], []
        for bone, t in ((f"thigh.{s}", 0.10), (f"thigh.{s}", 0.5), (f"thigh.{s}", 0.92),
                        (f"shin.{s}", 0.15), (f"shin.{s}", 0.45), (f"shin.{s}", 0.70)):
            R = F[bone]
            o = place(j, F, bone, 0.0, t, 0.0)
            lace.append(surface(base, o, R[0] * sg))
            zipl.append(surface(base, o, -R[0] * sg + R[2] * 0.15))
        ops.append((sdf.Tube(sdf.spline(lace, 8), 0.0065, band=0.01), 0.0, "union"))
        zops.append((sdf.Tube(sdf.spline(zipl, 8), 0.0035, band=0.01), 0.0, "union"))
    v, q = mesh(ops, 0.002, smooth=2)
    out.append(dict(name="GSuit_Lacing", v=v, q=q, mat="webbing", bone=None))
    v, q = mesh(zops, 0.0018, smooth=1)
    out.append(dict(name="GSuit_Zips", v=v, q=q, mat="zip", bone=None))
    return out, base


# ----------------------------------------------------------------------------------- hoses
def hose_parts(j, F, vbase, gbase, cable_end=None):
    C, M = helmet.frame(j, F)
    out = []
    # oxygen hose: mask outlet -> quick-disconnect on the right upper chest
    p0, d0 = helmet.mask_outlet(C, M)
    o = place(j, F, "chest", -0.080, 0.50, 0.0)
    conn = surface(vbase, o, F["chest"][2]) + F["chest"][2] * 0.022
    p3 = conn + F["chest"][1] * 0.022
    path = sdf.bezier(p0, p0 + d0 * 0.11 + F["chest"][2] * 0.02,
                      p3 + F["chest"][1] * 0.09 + F["chest"][0] * 0.03 + F["chest"][2] * 0.015, p3, 48)
    v, q = mesh([(sdf.Tube(path, 0.0128, amp=0.0016, pitch=0.009, band=0.01), 0.0, "union")], 0.0012, smooth=1)
    out.append(dict(name="Hose_Oxygen", v=v, q=q, mat="hose", bone=None))
    # quick-disconnect block in its webbing loop; the regulator hose on to the left hip
    Rc = F["chest"]
    ops = [(sdf.RoundBox(conn, (0.016, 0.022, 0.014), 0.005, Rc), 0.0, "union"),
           (sdf.Disc(conn + Rc[1] * 0.024, Rc[1], 0.0155, 0.006, 0.002), 0.003, "union")]
    v, q = mesh(ops, 0.0012, smooth=2)
    out.append(dict(name="Hose_Connector", v=v, q=q, mat="dark_metal", bone=None))
    o = place(j, F, "pelvis", 0.150, 0.55, 0.0)
    hip = surface(gbase, o, unit(F["pelvis"][2] + F["pelvis"][0] * 0.8)) + unit(F["pelvis"][2] + F["pelvis"][0]) * 0.012
    a = conn - Rc[1] * 0.022
    path = sdf.bezier(a, a - Rc[1] * 0.10 + Rc[2] * 0.03, hip + F["spine"][1] * 0.12 + F["spine"][2] * 0.05, hip, 40)
    v, q = mesh([(sdf.Tube(path, 0.0085, amp=0.0008, pitch=0.007, band=0.01), 0.0, "union")], 0.0011, smooth=1)
    out.append(dict(name="Hose_Regulator", v=v, q=q, mat="hose_olive", bone=None))
    ops = [(sdf.RoundBox(hip, (0.016, 0.022, 0.011), 0.005, F["pelvis"]), 0.0, "union"),
           (sdf.Disc(hip + F["pelvis"][1] * 0.024, F["pelvis"][1], 0.010, 0.006, 0.0015), 0.002, "union")]
    v, q = mesh(ops, 0.0015, smooth=2)
    out.append(dict(name="Hose_HipBlock", v=v, q=q, mat="dark_metal", bone=None))
    # helmet cable: back of the helmet, down the back of the neck, round to the right hip
    c0, cd = helmet.cable_exit(C, M)
    back = lambda bone, x, t: surface(vbase, place(j, F, bone, x, t, 0.0), -F[bone][2]) - F[bone][2] * 0.008
    p_neck = back("chest", 0.0, 0.95)
    p_up = back("chest", -0.06, 0.55)
    p_mid = back("spine", -0.12, 0.6)
    o = place(j, F, "spine", 0.0, 0.25, 0.0)
    p_side = surface(vbase, o, unit(-F["spine"][0] - F["spine"][2] * 0.6)) + unit(-F["spine"][0] - F["spine"][2] * 0.6) * 0.012
    if cable_end is None:
        o = place(j, F, "pelvis", -0.17, 0.75, 0.0)
        cable_end = surface(gbase, o, -F["pelvis"][0]) - F["pelvis"][0] * 0.022 + F["pelvis"][2] * 0.02
    pts = [c0, c0 + cd * 0.04, p_neck, p_up, p_mid, p_side, cable_end]
    path = sdf.spline(pts, 10)
    v, q = mesh([(sdf.Tube(path, 0.0052, band=0.01), 0.0, "union")], 0.0012, smooth=1)
    out.append(dict(name="Helmet_Cable", v=v, q=q, mat="cable", bone=None))
    dd = unit(path[-1] - path[-4])
    ops = [(sdf.Disc(cable_end + dd * 0.012, dd, 0.017, 0.011, 0.004), 0.0, "union"),
           (sdf.RoundCone(cable_end - dd * 0.012, cable_end + dd * 0.002, 0.007, 0.012), 0.004, "union")]
    v, q = mesh(ops, 0.0012, smooth=2)
    out.append(dict(name="Helmet_CableConnector", v=v, q=q, mat="olive_metal", bone=None))
    return out


# ----------------------------------------------------------------------------------- suit details
def dressed_near(j, F, c, half=0.075, h=0.002):
    """The dressed body (the suit surface, as parts.build meshes it) sampled in a box round c."""
    f = sdf.Field(np.asarray(c, float) - half, np.asarray(c, float) + half, h)
    for s, k in body.solids(j, F):
        f.add(s, k)
    return sdf.Sampled(f)


def suit_detail_parts(j, F, torso, arms, gbase):
    out = []
    # flight-suit collar standing round the neck above the vest
    na, nb = j["neck"], j["head"]
    neck = sdf.RoundCone(na, nb, 0.061, 0.055)
    c = na + F["neck"][1] * 0.030
    ops = [(sdf.Offset(neck, 0.010), 0.0, "union"), (sdf.Offset(neck, 0.004), 0.0, "sub"),
           (sdf.Tube(ring(c, F["neck"][1], 0.068), 0.022, band=0.02), 0.002, "inter"),
           (side(c - F["neck"][2] * 0.075, -F["neck"][2] + F["neck"][1] * 0.6), 0.004, "sub")]
    v, q = mesh(ops, 0.0025, smooth=2, lo=c - 0.12, hi=c + 0.12)
    out.append(dict(name="Suit_Collar", v=v, q=q, mat="suit", bone=None))
    # Israeli flag on the left upper arm, round unit patch on the right; pen pocket on the left.
    # The patches are sewn-on cloth: a 2.6 mm shell over the real suit surface (the sleeve blends
    # into the shoulder there, so a flat badge would sink into the cloth and show only its rim)
    ops_p = []
    for sg, s in ((1.0, "L"), (-1.0, "R")):
        R = F[f"upperarm.{s}"]
        o = place(j, F, f"upperarm.{s}", 0.0, 0.20, 0.0)
        d = unit(R[0] * sg * 1.0 + R[2] * 0.15)
        suit = dressed_near(j, F, surface(arms[s], o, d))
        p = surface(suit, o, d)
        across = unit(np.cross(R[1], d))
        Rp = np.stack([across, R[1], d])
        shell = [(sdf.Offset(suit, 0.0030), 0.0, "union"), (sdf.Offset(suit, 0.0004), 0.0, "sub")]
        if s == "L":
            cut = sdf.RoundBox(p, (0.0425, 0.0275, 0.03), 0.004, Rp)
            size = (0.085, 0.055)
            name, mat = "Suit_Flag", "flag"
        else:
            cut = sdf.Disc(p, d, 0.0425, 0.03, 0.0)
            size = (0.085, 0.085)
            name, mat = "Suit_UnitPatch", "unit_patch"
        v, q = mesh(shell + [(cut, 0.0, "inter")], 0.0010, smooth=1, lo=p - 0.055, hi=p + 0.055)
        # planar UVs in the patch frame: u across the arm (viewer's right when facing the patch),
        # v up towards the shoulder
        rel = v - p
        u = 0.5 + (rel @ (across * sg)) / size[0]
        w = 0.5 + (rel @ (-R[1])) / size[1]
        out.append(dict(name=name, v=v, q=q, mat=mat, bone=f"upperarm.{s}", uv=np.c_[u, w]))
        if s == "L":
            o = place(j, F, f"upperarm.{s}", 0.0, 0.52, 0.0)
            d = unit(R[0] * 0.55 + R[2])
            p = surface(arms[s], o, d)
            Rp = np.stack([unit(np.cross(R[1], d)), R[1], d])
            ops_p.append((sdf.RoundBox(p + d * 0.002, (0.022, 0.058, 0.006), 0.004, Rp), 0.0, "union"))
            for k in range(2):
                pp = p + d * 0.006 + R[1] * (-0.060) + Rp[0] * (-0.008 + 0.012 * k)
                ops_p.append((sdf.RoundCone(pp - R[1] * 0.010, pp + R[1] * 0.012, 0.0042, 0.0042), 0.0, "union"))
    v, q = mesh(ops_p, 0.0015, smooth=2)
    out.append(dict(name="Suit_SleevePocket", v=v, q=q, mat="suit", bone="upperarm.L"))
    # tablet kneeboard on the right thigh: a black board holding a tablet, on an elastic strap
    R = F["thigh.R"]
    o = place(j, F, "thigh.R", 0.0, 0.58, 0.0)
    p = surface(gbase, o, R[2])
    ops = [(sdf.RoundBox(p + R[2] * 0.0085, (0.088, 0.128, 0.0065), 0.004, R), 0.0, "union"),
           (sdf.RoundBox(p + R[2] * 0.0160, (0.074, 0.110, 0.0016), 0.003, R), 0.002, "union")]
    v, q = mesh(ops, 0.0014, smooth=1)
    out.append(dict(name="Kneeboard", v=v, q=q, mat="kneeboard", bone="thigh.R"))
    ops = [(sdf.RoundBox(p + R[2] * 0.0172, (0.066, 0.100, 0.0010), 0.0005, R), 0.0, "union")]
    v, q = mesh(ops, 0.0007, smooth=0)
    rel = v - p
    # screen UVs as the seated pilot reads it: u to the pilot's right, v (up) towards the knee
    uv = np.c_[0.5 + (rel @ -R[0]) / 0.132, 0.5 + (rel @ R[1]) / 0.200]
    out.append(dict(name="Kneeboard_Screen", v=v, q=q, mat="screen", bone="thigh.R", uv=uv))
    c = place(j, F, "thigh.R", 0.0, 0.44, 0.0)
    pts = [surface(gbase, c, R[0] * math.cos(a) + R[2] * math.sin(a)) for a in np.linspace(0, 2 * np.pi, 25)]
    ops = skin_strap(gbase, np.array(pts), 0.032, thick=0.003)
    v, q = mesh(ops, 0.002, smooth=2, lo=np.min(pts, 0) - 0.04, hi=np.max(pts, 0) + 0.04)
    out.append(dict(name="Kneeboard_Strap", v=v, q=q, mat="webbing_black", bone=None))
    # wrist watch on the left forearm, just above the glove's cuff
    Rf = F["forearm.L"]
    o = place(j, F, "forearm.L", 0.0, 0.66, 0.0)
    d = Rf[0]                                   # back of the left wrist (standing: palm faces in)
    p = surface(arms["L"], o, d)
    # dial frame: 3 o'clock (and the crown) towards the hand, 12 o'clock round the wrist
    right = Rf[1]
    up = unit(np.cross(d, right))
    ops = [(sdf.Disc(p + d * 0.004, d, 0.019, 0.0045, 0.0015), 0.0, "union"),
           (sdf.RoundBox(p + d * 0.003, (0.024, 0.010, 0.0025), 0.0015, np.stack([up, right, d])), 0.002, "union"),
           (sdf.Disc(p + d * 0.004 + right * 0.020, right, 0.0028, 0.003, 0.0008), 0.0, "union")]
    v, q = mesh(ops, 0.0008, smooth=1)
    out.append(dict(name="Watch", v=v, q=q, mat="steel", bone="forearm.L"))
    ops = [(sdf.Disc(p + d * 0.0082, d, 0.0200, 0.0011, 0.0005), 0.0, "union"),
           (sdf.Disc(p + d * 0.0082, d, 0.0160, 0.004, 0.0), 0.0, "sub")]
    v, q = mesh(ops, 0.0006, smooth=1, lo=p - 0.03, hi=p + 0.03)
    out.append(dict(name="Watch_Bezel", v=v, q=q, mat="black_gloss", bone="forearm.L"))
    pts = [surface(arms["L"], o, Rf[0] * math.cos(a) + Rf[2] * math.sin(a)) for a in np.linspace(0, 2 * np.pi, 25)]
    ops = skin_strap(arms["L"], np.array(pts), 0.018, thick=0.003)
    v, q = mesh(ops, 0.0012, smooth=1, lo=np.min(pts, 0) - 0.02, hi=np.max(pts, 0) + 0.02)
    out.append(dict(name="Watch_Band", v=v, q=q, mat="steel_brushed", bone="forearm.L"))
    ops = [(sdf.Disc(p + d * 0.0086, d, 0.0155, 0.0008, 0.0003), 0.0, "union")]
    v, q = mesh(ops, 0.0005, smooth=0)
    rel = v - p
    uv = np.c_[0.5 + (rel @ right) / 0.031, 0.5 + (rel @ up) / 0.031]
    out.append(dict(name="Watch_Face", v=v, q=q, mat="watch_face", bone="forearm.L", uv=uv))
    return out


def parts(j, F, cable_end=None):
    torso, arms, legs = lofts(j, F)
    vest, vbase = vest_parts(j, F, torso, arms)
    gs, gbase = gsuit_parts(j, F, torso, legs)
    out = vest + gs
    out += harness_parts(j, F, vbase, gbase)
    out += hose_parts(j, F, vbase, gbase, cable_end)
    out += suit_detail_parts(j, F, torso, arms, gbase)
    return out
