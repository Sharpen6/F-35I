"""Gloved hands and flight boots as signed-distance solids, built in the hand / foot bone frames
so they follow any pose.

Hand frame (from skeleton.frames, bone 'hand.<s>' = wrist -> middle knuckle):
    Y along the hand, Z = thumb side (anterior in the standing pose), X = the pilot's left, which
    is the BACK of the left hand and the PALM of the right hand.  Below, `back` = X * side sign.
Finger flexion curls towards the palm (-back).
"""
import math

import numpy as np

from . import sdf
from .skeleton import unit

# finger: (MCP offset along the hand from the knuckle line, across (+ = thumb side),
#          phalanx lengths, base radius, tip radius) -- gloved sizes for a 0.19 m hand
FINGERS = {
    "index": (-0.003, 0.025, (0.046, 0.027, 0.022), 0.0108, 0.0088),
    "middle": (0.000, 0.004, (0.050, 0.031, 0.023), 0.0110, 0.0090),
    "ring": (-0.004, -0.016, (0.047, 0.029, 0.022), 0.0105, 0.0086),
    "little": (-0.013, -0.034, (0.037, 0.022, 0.019), 0.0094, 0.0078),
}
THUMB = ((0.020, 0.026, -0.012), (0.046, 0.033, 0.029), 0.0135, 0.0098)   # CMC (along, across, back)

# curl presets: per finger (MCP, PIP, DIP) degrees, spread (deg), thumb (CMC abduction, MCP, IP)
POSES = {
    "relaxed": dict(fingers={"index": (14, 22, 12), "middle": (18, 28, 14), "ring": (22, 32, 16),
                             "little": (26, 36, 18)},
                    spread={"index": 4, "middle": 0, "ring": -4, "little": -9},
                    thumb=(38, 12, 12, 20)),
    "grip": dict(fingers={"index": (62, 80, 40), "middle": (68, 86, 44), "ring": (72, 88, 44),
                          "little": (76, 90, 46)},
                 spread={"index": 1, "middle": 0, "ring": -2, "little": -5},
                 thumb=(62, 30, 34, 38)),
    "throttle": dict(fingers={"index": (40, 55, 30), "middle": (55, 70, 38), "ring": (60, 78, 40),
                              "little": (66, 82, 42)},
                     spread={"index": 2, "middle": 0, "ring": -3, "little": -7},
                     thumb=(45, 20, 20, 25)),
}


def hand_solids(wrist, F, side, pose="relaxed"):
    """Solids (with blend radii) of a gloved hand.  wrist: wrist joint; F: hand frame rows."""
    sg = 1.0 if side == "L" else -1.0
    X, Y, Z = F[0], F[1], F[2]
    back = X * sg                      # back of the hand
    palm = -back
    P = POSES[pose]
    out = []

    def W(along, across, up):          # hand-local -> world (up = towards the back of the hand)
        return wrist + Y * along + Z * across + back * up
    # palm: a flattened rounded block, thicker at the heel of the hand
    out.append((sdf.SuperEllipsoid(W(0.052, 0.000, 0.000), (0.017, 0.050, 0.050, 0.044, 0.044), 2.8,
                                   R=np.stack([back, Y, Z])), 0.012))
    out.append((sdf.Ellipsoid(W(0.030, 0.020, -0.010), (0.018, 0.030, 0.022), np.stack([back, Y, Z])), 0.012))  # thenar
    out.append((sdf.Ellipsoid(W(0.035, -0.024, -0.008), (0.016, 0.032, 0.018), np.stack([back, Y, Z])), 0.012))  # hypothenar
    knuck = 0.098
    for name, (dy, across, lens, r0, r1) in FINGERS.items():
        mcp, pip, dip = [math.radians(a) for a in P["fingers"][name]]
        spread = math.radians(P["spread"][name])
        base = W(knuck + dy, across, 0.004)
        d = unit(Y * math.cos(spread) + Z * math.sin(spread))
        ang = 0.0
        p = base
        rads = np.linspace(r0, r1, 4)
        for k, (L, flex) in enumerate(zip(lens, (mcp, pip, dip))):
            ang += flex
            dk = unit(d * math.cos(ang) + palm * math.sin(ang))
            q = p + dk * L
            out.append((sdf.RoundCone(p, q - dk * (rads[k + 1] * 0.6 if k == 2 else 0.0), rads[k], rads[k + 1]),
                        0.006 if k else 0.010))
            p = q
        # knuckle bump on the back of the glove
        out.append((sdf.Sphere(base + back * 0.003, r0 * 1.05), 0.008))
    # thumb
    (ca, cc, cb), lens, r0, r1 = THUMB
    abd, m1, m2, ip = [math.radians(a) for a in P["thumb"]]
    p = W(ca, cc, cb)
    d = unit(Y * math.cos(abd) + Z * math.sin(abd) * 0.8 + palm * math.sin(abd) * 0.6)
    ang = 0.0
    rads = np.linspace(r0, r1, 4)
    for k, (L, flex) in enumerate(zip(lens, (m1, m2, ip))):
        ang += flex
        # the thumb curls across the palm (towards -Z and the palm)
        dk = unit(d * math.cos(ang) + unit(palm * 0.7 - Z * 0.7) * math.sin(ang))
        q = p + dk * L
        out.append((sdf.RoundCone(p, q, rads[k] * (1.25 if k == 0 else 1.0), rads[k + 1]), 0.012 if k == 0 else 0.006))
        p = q
    # gauntlet cuff: flares over the sleeve
    out.append((sdf.RoundCone(W(-0.075, 0.0, 0.0), W(0.008, 0.0, 0.0), 0.046, 0.034), 0.010))
    return out


def hand_segments(wrist, F, side, pose="relaxed"):
    """The finger and thumb phalanges of hand_solids as segments: dict(a, b, r, palmar, tip)."""
    sg = 1.0 if side == "L" else -1.0
    X, Y, Z = F[0], F[1], F[2]
    back = X * sg
    palm = -back
    P = POSES[pose]
    segs = []

    def W(along, across, up):
        return wrist + Y * along + Z * across + back * up
    knuck = 0.098
    for name, (dy, across, lens, r0, r1) in FINGERS.items():
        mcp, pip, dip = [math.radians(a) for a in P["fingers"][name]]
        spread = math.radians(P["spread"][name])
        d = unit(Y * math.cos(spread) + Z * math.sin(spread))
        ang, p = 0.0, W(knuck + dy, across, 0.004)
        for k, (L, flex) in enumerate(zip(lens, (mcp, pip, dip))):
            ang += flex
            dk = unit(d * math.cos(ang) + palm * math.sin(ang))
            q = p + dk * L
            segs.append(dict(a=p, b=q, r=0.5 * (r0 + r1), palmar=unit(palm * math.cos(ang) - d * math.sin(ang)),
                             tip=(k == 2), dk=dk))
            p = q
    (ca, cc, cb), lens, r0, r1 = THUMB
    abd, m1, m2, ip = [math.radians(a) for a in P["thumb"]]
    p = W(ca, cc, cb)
    d = unit(Y * math.cos(abd) + Z * math.sin(abd) * 0.8 + palm * math.sin(abd) * 0.6)
    w = unit(palm * 0.7 - Z * 0.7)
    ang = 0.0
    for k, (L, flex) in enumerate(zip(lens, (m1, m2, ip))):
        ang += flex
        dk = unit(d * math.cos(ang) + w * math.sin(ang))
        q = p + dk * L
        pal = -d * math.sin(ang) + w * math.cos(ang)
        pal = unit(pal - dk * (pal @ dk))
        segs.append(dict(a=p, b=q, r=0.5 * (r0 + r1), palmar=pal, tip=(k == 2), dk=dk))
        p = q
    return segs, dict(wrist=wrist, Y=Y, Z=Z, back=back, palm=palm, knuck=knuck)


def glove_leather(wrist, F, side, pose, v, n):
    """True for the glove's vertices under the grey leather: the palm, the palm side of the
    fingers and thumb, and the fingertips (the leather wraps ~1 cm over them).  v, n: vertices and
    outward normals of the glove mesh."""
    segs, H = hand_segments(wrist, F, side, pose)
    rel = v - H["wrist"]
    along, across = rel @ H["Y"], rel @ H["Z"]
    # nearest phalanx (capsule distance)
    best = np.full(len(v), np.inf)
    idx = np.full(len(v), -1)
    for i, g in enumerate(segs):
        ab = g["b"] - g["a"]
        t = np.clip(((v - g["a"]) @ ab) / max(ab @ ab, 1e-12), 0.0, 1.0)
        dd = np.linalg.norm(v - (g["a"] + t[:, None] * ab), axis=1) - g["r"]
        m = dd < best
        best[m], idx[m] = dd[m], i
    pal = np.zeros_like(v)
    tip = np.zeros(len(v), bool)
    for i, g in enumerate(segs):
        m = idx == i
        pal[m] = g["palmar"]
        if g["tip"]:
            tip |= m & (((v - g["b"]) @ g["dk"]) > -0.009)
    on_finger = best < 0.006
    in_palm = (along > 0.004) & (along < H["knuck"] + 0.004) & (np.abs(across) < 0.062) & ~on_finger
    leather = np.where(in_palm, (n @ H["palm"]) > 0.35, ((n * pal).sum(1) > 0.25) | tip)
    return leather & (along > 0.0)


def hand_field(wrist, F, side, pose="relaxed", h=0.0016):
    sol = hand_solids(wrist, F, side, pose)
    lo = np.min([s.aabb()[0] for s, _k in sol], axis=0) - 0.02
    hi = np.max([s.aabb()[1] for s, _k in sol], axis=0) + 0.02
    f = sdf.Field(lo, hi, h)
    for s, k in sol:
        f.add(s, k)
    return f


# ------------------------------------------------------------------------------- boots
# Flight boot: a lofted leather upper on a rubber sole, both swept heel -> toe in the boot frame
# (u along the foot from the back of the heel, as a fraction of the boot length; heights above
# the floor; half widths; x0 outwards).  Sizes of a ~US 10 boot: 0.29 m long, 0.105 m wide.
UPPER = [  # (u, half width, x0, bottom, top, n)
    (0.00, 0.030, 0.000, 0.026, 0.104, 2.6),
    (0.10, 0.036, 0.000, 0.026, 0.112, 2.6),
    (0.28, 0.039, 0.002, 0.024, 0.110, 2.6),
    (0.46, 0.042, 0.004, 0.021, 0.098, 2.6),
    (0.62, 0.047, 0.004, 0.019, 0.078, 2.6),
    (0.74, 0.050, 0.003, 0.019, 0.063, 2.6),
    (0.86, 0.047, 0.000, 0.019, 0.055, 2.6),
    (0.97, 0.034, -0.004, 0.020, 0.047, 2.6),
]
SOLE = [   # (u, half width, x0, bottom, top, n)
    (0.00, 0.033, 0.000, 0.000, 0.030, 4.0),
    (0.12, 0.040, 0.000, 0.000, 0.030, 4.0),
    (0.27, 0.042, 0.002, 0.000, 0.029, 4.0),
    (0.32, 0.041, 0.003, 0.007, 0.026, 4.0),
    (0.45, 0.045, 0.004, 0.007, 0.023, 4.0),
    (0.58, 0.051, 0.004, 0.001, 0.021, 4.0),
    (0.74, 0.056, 0.003, 0.000, 0.021, 4.0),
    (0.88, 0.052, 0.000, 0.001, 0.021, 4.0),
    (0.99, 0.038, -0.004, 0.006, 0.022, 4.0),
]
BOOT_BACK, BOOT_TOE = 0.014, 0.018          # boot heel behind the heel joint, toe cap ahead of the toe
BALL_HEIGHT = 0.041                          # ball joint above the floor (standing)


def boot_frame(j, side, sole_n=None):
    """Boot frame: origin on the floor under the back of the heel, fwd, sole normal n, lateral."""
    heel, ball, toe = j[f"heel.{side}"], j[f"ball.{side}"], j[f"toe.{side}"]
    n = unit(np.asarray(sole_n, float)) if sole_n is not None else np.array([0.0, 0.0, 1.0])
    fwd = unit((toe - heel) - n * ((toe - heel) @ n))
    floor = ball - n * BALL_HEIGHT
    h0 = heel - n * ((heel - floor) @ n)
    O = h0 - fwd * BOOT_BACK
    L = (toe - O) @ fwd + BOOT_TOE
    sg = 1.0 if side == "L" else -1.0
    left = -unit(np.cross(fwd, n))            # the pilot's left (cross(fwd, up) points right)
    return dict(O=O, fwd=fwd, n=n, lat=left * sg, left=left, L=float(L), sg=sg,
                heel=heel, ball=ball, toe=toe, ankle=j[f"ankle.{side}"])


def _foot_loft(fr, table, r0, r1, grow=0.0):
    st = []
    for u, hw, x0, bot, top, n in table:
        st.append(dict(p=fr["O"] + fr["fwd"] * (u * fr["L"]), Z=fr["n"], w=hw + grow, n=n,
                       x0=x0 * fr["sg"], z0=0.5 * (top + bot), f=0.5 * (top - bot) + grow,
                       b=0.5 * (top - bot) + grow))
    return sdf.Loft(st, round0=r0, round1=r1, left=fr["left"])


def boot_solids(j, F, side, sole_n=None):
    """Leather upper of a flight boot: lofted foot plus the shaft up the shin."""
    fr = boot_frame(j, side, sole_n)
    out = [(_foot_loft(fr, UPPER, 0.026, 0.030), 0.0)]
    an, kn = j[f"ankle.{side}"], j[f"knee.{side}"]
    sdir = unit(kn - an)
    Zs = F[f"shin.{side}"][2]
    st = []
    for dt, w, f, b in ((-0.035, 0.043, 0.050, 0.050), (0.03, 0.046, 0.050, 0.052),
                        (0.08, 0.048, 0.050, 0.054), (0.118, 0.050, 0.052, 0.056)):
        st.append(dict(p=an + sdir * dt, Z=Zs, w=w, f=f, b=b, z0=-0.004, n=2.2))
    out.append((sdf.Loft(st, round0=0.02, round1=0.004, left=fr["left"]), 0.03))
    return out, fr


def sole_solids(fr):
    """Rubber sole and heel under the boot (heel block, raised arch, toe spring)."""
    return [(_foot_loft(fr, SOLE, 0.012, 0.012), 0.0)]
