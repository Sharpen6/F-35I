"""The F-35 Gen III Helmet Mounted Display System (HMDS) and the oxygen mask, as signed-distance
solids in the helmet's own frame, meshed and moved onto the head bone.

Helmet frame (metres): origin at the centre of the skull, x = the pilot's left, y = up the head,
z = forward.  The corneas are at y = EYE_Y, z = EYE_Z.  The sizes come from the measured spec in
docs/pilot.md (photos p00-p29), whose head frame (origin between the corneas, Y forward, Z up)
maps to this one as  x = X, y = Z + EYE_Y, z = Y + EYE_Z  (see `spec`).

Parts (all from public photos of USAF, RAAF and IAF F-35 pilots; the IAF uses the same helmet):
  * an unpainted carbon-fibre shell, egg-shaped, fullest at the back, with round recessed hard
    points, rear retention-lever recesses and a rubber edge bead;
  * the brow display module bulging over the forehead under a clear cover, with the night-vision
    camera on the centre line;
  * one wrap-around display visor pivoting on high side hubs, its lower edge notched over the mask;
  * ear-cup domes with round black covers, notched mask receivers on the cheeks;
  * the oxygen mask: black hard shell with a nose 'beak', grey silicone seal, valve boss, black
    elbow and grey cuff, straps and steel bayonets; its corrugated hose; the helmet cable.
"""
import math

import numpy as np

from . import sdf

SKULL_FROM_ATLAS = 0.074             # skull centre above the atlas joint, along the head bone
EYE_Y, EYE_Z = -0.013, 0.088         # corneas in the helmet frame


def spec(X, Y, Z):
    """Spec head frame (X left, Y forward, Z up, origin between the corneas) -> helmet frame."""
    return np.array([X, Z + EYE_Y, Y + EYE_Z])


# ----------------------------------------------------------------------------------- shell
SHELL_C = np.array([0.0, 0.020, -0.002])
SHELL_R = (0.1225, 0.135, 0.127, 0.125, 0.124)     # x, y-, y+, z-, z+
SHELL_N = 2.2
SHELL_T = 0.008                                    # shell + liner seen at the edges
BROW_C = np.array([0.0, 0.058, 0.080])             # brow display module (bulge over the forehead)
BROW_R = (0.104, 0.042, 0.040, 0.080, 0.082)
FACE_TOP, FACE_BACK = 0.009, 0.042                 # face opening: top edge (y), side edges (z)
HUB = spec(0.123, -0.058, 0.092)                   # visor pivot, left side (mirrored)
EAR = spec(0.128, -0.085, -0.045)                  # ear-cup cover centre, left side
CAMERA = spec(0.0, 0.072, 0.078)                   # night-vision camera lens centre
BOX = ((-0.3, -0.3, -0.3), (0.3, 0.3, 0.3))


def keep_above(y):
    """Solid to subtract that removes everything below y."""
    return sdf.Plane((0.0, y, 0.0), (0.0, 1.0, 0.0), *BOX)


def keep_below(y):
    return sdf.Plane((0.0, y, 0.0), (0.0, -1.0, 0.0), *BOX)


def keep_front_of(z):
    return sdf.Plane((0.0, 0.0, z), (0.0, 0.0, 1.0), *BOX)


def frame(j, F):
    """(origin, M): helmet-local -> world is origin + v @ M (rows of M = local axes in world)."""
    M = F["head"]
    C = j["head"] + M[1] * SKULL_FROM_ATLAS
    return C, M


def to_world(v, C, M):
    return C + np.asarray(v) @ M


def dome(grow=0.0):
    x, yn, yp, zn, zp = SHELL_R
    return sdf.SuperEllipsoid(SHELL_C, (x + grow, yn + grow, yp + grow, zn + grow, zp + grow), SHELL_N)


def brow(grow=0.0):
    x, yn, yp, zn, zp = BROW_R
    return sdf.SuperEllipsoid(BROW_C, (x + grow, yn + grow, yp + grow, zn + grow, zp + grow), 2.5)


def _lower_cut():
    """Below the lower edge: y < -0.093 at the ear cups, dipping to -0.101 at the nape."""
    def f(P):
        z = P[..., 2]
        return P[..., 1] - (-0.093 + 0.07 * np.minimum(z, 0.0))
    return sdf.Custom(f, *BOX)


def _face_opening():
    return sdf.RoundBox((0.0, FACE_TOP - 0.12, FACE_BACK + 0.16), (0.25, 0.12, 0.16), 0.02)


def outer_solids(grow=0.0):
    return [(dome(grow), 0.0, "union"), (brow(grow), 0.03, "union")]


def surface_point(direction, grow=0.0):
    """Point of the outer dome along a direction from its centre, and the surface normal."""
    d = np.asarray(direction, float)
    d = d / np.linalg.norm(d)
    s = dome(grow)
    lo, hi = 0.0, 0.25
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if s.dist((SHELL_C + d * mid)[None])[0] < 0:
            lo = mid
        else:
            hi = mid
    p = SHELL_C + d * lo
    e = 1e-4
    g = np.array([(s.dist((p + o)[None])[0] - s.dist((p - o)[None])[0]) for o in np.eye(3) * e])
    return p, g / np.linalg.norm(g)


# recessed hard points (directions from the dome centre; left side, mirrored): two behind the
# visor hub on the upper side, one low behind the ear cup
HARD_POINTS = [(0.62, 0.62, -0.30), (0.50, 0.78, -0.42), (0.78, 0.05, -0.62)]
LEVER = spec(0.085, -0.175, 0.072)                 # rear retention-lever recess, left side


def shell_solids():
    ops = outer_solids() + [
        (dome(-SHELL_T), 0.004, "sub"),
        (_face_opening(), 0.010, "sub"),
        (_lower_cut(), 0.006, "sub")]
    for sg in (1.0, -1.0):
        e = EAR * np.array([sg, 1.0, 1.0])
        # ear-cup dome bulging over the ear
        ops.append((sdf.Ellipsoid(e - np.array([0.025 * sg, 0.0, 0.0]), (0.030, 0.046, 0.046)), 0.02, "union"))
        for d in HARD_POINTS:
            p, n = surface_point((d[0] * sg, d[1], d[2]))
            ops.append((sdf.Sphere(p + n * 0.0105, 0.0135), 0.003, "sub"))
        lv = LEVER * np.array([sg, 1.0, 1.0])
        p, n = surface_point(lv - SHELL_C)
        ops.append((sdf.Ellipsoid(p + n * 0.004, (0.012, 0.028, 0.016)), 0.004, "sub"))
    return ops


def bead_solids():
    """Rubber edge bead along the lower edge (a ring hugging the cut)."""
    def f(P):
        y_edge = -0.093 + 0.07 * np.minimum(P[..., 2], 0.0)
        dy = P[..., 1] - (y_edge + 0.002)
        ds = dome(-0.002).dist(P)
        face = _face_opening().dist(P)
        return np.maximum(np.sqrt(dy * dy + ds * ds) - 0.0048, -face - 0.004)
    return [(sdf.Custom(f, (-0.14, -0.12, -0.14), (0.14, -0.07, 0.07)), 0.0)]


def _basis(n, up):
    """Rows: x = up x n, y = up (orthogonalised), z = n."""
    n = n / np.linalg.norm(n)
    y = up - n * (up @ n)
    y /= np.linalg.norm(y)
    return np.stack([np.cross(y, n), y, n])


def detail_solids():
    """Black hardware: hard-point screws, levers, ear-cup covers, mask receivers, the hub latch
    plates and the cable boot at the back."""
    out = []
    for sg in (1.0, -1.0):
        m = np.array([sg, 1.0, 1.0])
        for d in HARD_POINTS[:2]:
            p, n = surface_point((d[0] * sg, d[1], d[2]))
            out.append((sdf.Disc(p - n * 0.0005, n, 0.0035, 0.0012, 0.0006), 0.0))
        p, n = surface_point(LEVER * m - SHELL_C)
        out.append((sdf.RoundBox(p - n * 0.0025, (0.0035, 0.014, 0.005), 0.0025, _basis(n, np.array([0.0, 1.0, 0.0]))), 0.002))
        # ear-cup cover: flat disc with a raised ring
        e = EAR * m
        ax = np.array([sg, 0.0, 0.0])
        out.append((sdf.Disc(e - ax * 0.002, ax, 0.029, 0.005, 0.002), 0.002))
        out.append((sdf.Disc(e + ax * 0.0025, ax, 0.029, 0.0015, 0.001), 0.001))
        # notched mask receiver rail down the cheek
        pts = [spec(0.112 * sg, -0.040, -0.005), spec(0.112 * sg, -0.050, -0.050), spec(0.106 * sg, -0.058, -0.090)]
        for a, b in zip(pts[:-1], pts[1:]):
            out.append((sdf.RoundCone(a, b, 0.0075, 0.0075), 0.004))
        # visor hub latch plate (behind the pivot)
        h = HUB * m
        out.append((sdf.RoundBox(h + np.array([0.003 * sg, -0.004, -0.016]), (0.0025, 0.007, 0.013), 0.0015), 0.002))
    cb, cd = cable_exit_local()
    out.append((sdf.RoundCone(cb - cd * 0.012, cb + cd * 0.022, 0.011, 0.008), 0.003))
    return out


def brow_cover_solids():
    """Clear cover over the brow module: a thin skin a few mm above it."""
    return [(brow(0.004), 0.0, "union"), (brow(0.0015), 0.0, "sub"),
            (keep_above(FACE_TOP + 0.010), 0.004, "sub"),
            (keep_front_of(0.030), 0.012, "sub")]


CAM_AXIS = np.array([0.0, -0.10, 0.995])


def camera_solids():
    c, a = CAMERA, CAM_AXIS
    return [(sdf.Disc(c - a * 0.012, a, 0.020, 0.010, 0.003), 0.0),
            (sdf.Disc(c + a * 0.001, a, 0.0165, 0.004, 0.002), 0.002),
            (sdf.Disc(c + np.array([0.016, 0.024, 0.0]) - a * 0.004, a, 0.006, 0.004, 0.0015), 0.002)]


def camera_glass_solids():
    return [(sdf.Disc(CAMERA + CAM_AXIS * 0.0045, CAM_AXIS, 0.0135, 0.0012, 0.0008), 0.0)]


def hub_solids():
    """Visor pivot bosses with the screw and washer (both sides)."""
    out = []
    for sg in (1.0, -1.0):
        c = HUB * np.array([sg, 1.0, 1.0])
        ax = np.array([sg, 0.0, 0.0])
        out.append((sdf.Disc(c + ax * 0.003, ax, 0.011, 0.004, 0.0015), 0.0))
        out.append((sdf.Disc(c + ax * 0.0075, ax, 0.0045, 0.0015, 0.0008), 0.0008))
    return out


# ----------------------------------------------------------------------------------- visor
VISOR_C = np.array([0.0, -0.002, 0.024])
VISOR_R = (0.131, 0.150, 0.150, 0.130, 0.130)
VISOR_T = 0.0024
VISOR_SPAN = math.radians(84.0)                    # half angle of the visor round the face


def _visor_edges(th):
    """Top and bottom edge heights (y) at azimuth th (0 = front, VISOR_SPAN = hub)."""
    a = np.degrees(np.abs(th))
    t = np.clip(a / np.degrees(VISOR_SPAN), 0.0, 1.0)
    top = (EYE_Y + 0.045) + 0.058 * t ** 2.4
    # bottom: notch over the mask (|a| < ~12 deg), cheek lobes down to Z -0.06, up to the hub
    notch = EYE_Y - 0.010
    low = EYE_Y - 0.060
    s1 = np.clip((a - 11.0) / 8.0, 0.0, 1.0)
    s1 = s1 * s1 * (3 - 2 * s1)
    bot = notch + (low - notch) * s1
    s2 = np.clip((a - 38.0) / (np.degrees(VISOR_SPAN) - 38.0), 0.0, 1.0)
    bot = bot + (0.052 - low) * s2 ** 1.7
    return top, bot


def visor_solids():
    """A thin, doubly curved display visor wrapping from hub to hub; the lower edge is notched
    over the mask's nose and sweeps up to the mounting ears at the hubs."""
    x, yn, yp, zn, zp = VISOR_R
    outer = sdf.SuperEllipsoid(VISOR_C, VISOR_R, 2.0)
    inner = sdf.SuperEllipsoid(VISOR_C, (x - VISOR_T, yn - VISOR_T, yp - VISOR_T, zn - VISOR_T, zp - VISOR_T), 2.0)

    def window(P):
        X, Y, Z = P[..., 0], P[..., 1], P[..., 2] - VISOR_C[2]
        th = np.arctan2(X, Z)
        top, bot = _visor_edges(th)
        r = np.sqrt(X * X + Z * Z)
        dth = (np.abs(th) - VISOR_SPAN) * r
        return np.maximum(dth, np.maximum(Y - top, bot - Y))
    win = sdf.Custom(window, *BOX)
    return [(outer, 0.0, "union"), (inner, 0.0, "sub"), (win, 0.006, "inter"),
            (keep_front_of(-0.02), 0.0, "sub")]


def visor_rib_solids():
    """Mounting ears at the hubs: a clear boss with radial stiffening ribs."""
    out = []
    for sg in (1.0, -1.0):
        c = HUB * np.array([sg, 1.0, 1.0])
        ax = np.array([sg, 0.0, 0.0])
        out.append((sdf.Disc(c - ax * 0.001, ax, 0.016, 0.003, 0.0015), 0.0))
        for k in range(8):
            a = math.radians(-10.0 + 25.0 * k)
            d = np.array([0.0, math.sin(a), math.cos(a)])
            out.append((sdf.RoundCone(c + d * 0.011 - ax * 0.0015, c + d * 0.019 - ax * 0.0025, 0.0013, 0.0009), 0.0015))
    return out


# ----------------------------------------------------------------------------------- mask
# (spec Z, half width, front Y, back Y): nose bridge -> chin.  Y is forward in the spec frame.
MASK = [
    (0.010, 0.018, 0.028, 0.008),
    (-0.006, 0.030, 0.058, 0.005),
    (-0.022, 0.040, 0.068, 0.003),
    (-0.045, 0.049, 0.064, 0.001),
    (-0.068, 0.0525, 0.056, 0.000),
    (-0.092, 0.049, 0.046, 0.000),
    (-0.112, 0.038, 0.034, 0.002),
    (-0.126, 0.018, 0.022, 0.006),
]
VALVE = (spec(0.0, 0.050, -0.076), np.array([0.0, -0.25, 0.97]))
ELBOW = (spec(0.0, 0.052, -0.084), spec(0.0, 0.050, -0.112))
CUFF = spec(0.0, 0.050, -0.124)
SIDE_PORT = spec(-0.046, 0.030, -0.050)


def _mask_loft(grow=0.0, sub=3):
    st = []
    for Z, w, fy, by in MASK:
        p = spec(0.0, 0.5 * (fy + by), Z)
        st.append(dict(p=p, Z=(0.0, 0.0, 1.0), w=w + grow, f=0.5 * (fy - by) + grow, b=0.5 * (fy - by) + grow, n=2.2))
    return sdf.Loft(st, round0=0.010, round1=0.012, left=(1.0, 0.0, 0.0), sub=sub, band=0.02)


def mask_solids():
    out = [(_mask_loft(), 0.0)]
    c, a = VALVE
    out.append((sdf.Disc(c, a, 0.0175, 0.006, 0.003), 0.006))
    # strap anchor lugs at the upper and lower corners
    for sg in (1.0, -1.0):
        out.append((sdf.Ellipsoid(spec(0.036 * sg, 0.020, -0.012), (0.008, 0.010, 0.007)), 0.006))
        out.append((sdf.Ellipsoid(spec(0.042 * sg, 0.010, -0.100), (0.008, 0.010, 0.007)), 0.006))
    return out


def mask_seal_solids():
    """Grey silicone face seal: a rolled rim standing out round the back of the shell."""
    loft = _mask_loft(0.007, sub=2)

    def f(P):
        d = loft.dist(P)
        y_face = P[..., 2] - EYE_Z                         # spec Y
        return np.maximum(d, np.abs(y_face - 0.006) - 0.007)
    return [(sdf.Custom(f, (-0.07, -0.16, 0.06), (0.07, 0.02, 0.13)), 0.0)]


SIDE_N = np.array([-0.75, 0.0, 0.66])


def mask_dark_solids():
    """Glossy black elbow and the side port rim."""
    a, b = ELBOW
    return [(sdf.RoundCone(a, b, 0.0105, 0.0100), 0.0),
            (sdf.Disc(SIDE_PORT, SIDE_N, 0.0060, 0.0050, 0.002), 0.0)]


def mask_grey_solids():
    """Grey rubber cuff on the elbow and the round side port (anti-suffocation valve)."""
    return [(sdf.Disc(CUFF, (0.0, 1.0, 0.0), 0.016, 0.0125, 0.004), 0.0),
            (sdf.Disc(SIDE_PORT - SIDE_N * 0.002, SIDE_N, 0.015, 0.004, 0.002), 0.0)]


def strap_box(a, b, width, thick, normal):
    """A flat strap (rounded box) from a to b, its face towards `normal`."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    x = b - a
    L = np.linalg.norm(x)
    x /= L
    n = np.asarray(normal, float)
    n = n - x * (n @ x)
    n /= np.linalg.norm(n)
    y = np.cross(n, x)
    return sdf.RoundBox((a + b) / 2, (L / 2 + 0.002, width / 2, thick / 2), min(thick / 2, 0.0008), np.stack([x, y, n]))


def mask_strap_solids():
    """Black webbing straps in a V from the mask lugs to a buckle on each side."""
    out = []
    for sg in (1.0, -1.0):
        buckle = spec(0.098 * sg, -0.040, -0.052)
        out.append((strap_box(spec(0.038 * sg, 0.018, -0.012), buckle, 0.016, 0.0016, (sg, 0.0, 0.2)), 0.002))
        out.append((strap_box(spec(0.044 * sg, 0.008, -0.100), buckle, 0.016, 0.0016, (sg, 0.0, 0.2)), 0.002))
        out.append((sdf.RoundBox(buckle, (0.006, 0.0125, 0.010), 0.002), 0.002))
    return out


def bayonet_solids():
    out = []
    for sg in (1.0, -1.0):
        a = spec(0.100 * sg, -0.042, -0.052)
        b = spec(0.110 * sg, -0.050, -0.050)
        out.append((strap_box(a, b, 0.012, 0.003, (sg, 0.0, 0.0)), 0.0))
    return out


def mask_outlet(C, M):
    """World position and direction of the hose end below the mask's cuff."""
    return to_world(CUFF + np.array([0.0, -0.012, 0.0]), C, M), np.array([0.0, -1.0, 0.0]) @ M


def cable_exit_local():
    return spec(0.0, -0.212, -0.040), np.array([0.0, -0.55, -0.83])


def cable_exit(C, M):
    p, d = cable_exit_local()
    return to_world(p + d * 0.024, C, M), d @ M


# ----------------------------------------------------------------------------------- build
def _mesh_local(ops, lo, hi, h, smooth=3):
    f = sdf.Field(lo, hi, h)
    for item in ops:
        s, k = item[0], item[1]
        op = item[2] if len(item) > 2 else "union"
        f.add(s, k, op)
    return f.mesh(smooth=smooth)


def parts(j, F, h=0.002):
    """Helmet and mask: list of part dicts (world space, rigid on the head bone)."""
    C, M = frame(j, F)
    out = []
    LO, HI = (-0.16, -0.13, -0.15), (0.16, 0.17, 0.20)

    def add(name, ops, mat, hh=h, smooth=3, lo=LO, hi=HI):
        v, q = _mesh_local(ops, lo, hi, hh, smooth)
        out.append(dict(name=name, v=to_world(v, C, M), q=q, mat=mat, bone="head"))
    add("Helmet_Shell", shell_solids(), "helmet")
    add("Helmet_BrowCover", brow_cover_solids(), "clear_cover", hh=0.0016, smooth=2,
        lo=(-0.13, 0.0, -0.02), hi=(0.13, 0.12, 0.18))
    add("Helmet_Bead", bead_solids(), "rubber", hh=0.0015, smooth=2, lo=(-0.15, -0.12, -0.15), hi=(0.15, -0.07, 0.08))
    add("Helmet_Hardware", detail_solids(), "black", hh=0.0012, smooth=2)
    add("Helmet_Hubs", hub_solids(), "metal", hh=0.0008, smooth=1, lo=(-0.15, 0.03, 0.0), hi=(0.15, 0.09, 0.06))
    add("Helmet_Camera", camera_solids(), "black", hh=0.0010, smooth=2, lo=(-0.04, 0.02, 0.11), hi=(0.04, 0.09, 0.19))
    add("Helmet_CameraGlass", camera_glass_solids(), "lens", hh=0.0008, smooth=1, lo=(-0.03, 0.03, 0.15), hi=(0.03, 0.08, 0.19))
    add("Helmet_Visor", visor_solids(), "visor", hh=0.0014, smooth=2, lo=(-0.15, -0.10, -0.03), hi=(0.15, 0.12, 0.17))
    add("Helmet_VisorRibs", visor_rib_solids(), "clear_cover", hh=0.0008, smooth=1, lo=(-0.15, 0.03, 0.0), hi=(0.15, 0.10, 0.07))
    add("Mask", mask_solids(), "mask", hh=0.0015, lo=(-0.07, -0.16, 0.05), hi=(0.07, 0.03, 0.18))
    add("Mask_Seal", mask_seal_solids(), "mask_seal", hh=0.0013, smooth=2, lo=(-0.07, -0.16, 0.06), hi=(0.07, 0.02, 0.13))
    add("Mask_Elbow", mask_dark_solids(), "black_gloss", hh=0.0010, smooth=2, lo=(-0.07, -0.15, 0.08), hi=(0.07, -0.05, 0.17))
    add("Mask_Cuff", mask_grey_solids(), "cuff", hh=0.0010, smooth=2, lo=(-0.07, -0.16, 0.08), hi=(0.07, -0.05, 0.17))
    add("Mask_Straps", mask_strap_solids(), "webbing_black", hh=0.0009, smooth=1, lo=(-0.13, -0.13, 0.03), hi=(0.13, 0.02, 0.15))
    add("Mask_Bayonets", bayonet_solids(), "metal", hh=0.0008, smooth=1, lo=(-0.13, -0.09, 0.02), hi=(0.13, -0.03, 0.07))
    return out
