"""The pilot's flight equipment over the flight coverall: the Survitec F-35 ensemble that F-35
pilots wear with the Martin-Baker US16E seat (USAF and RAAF photos, and the IAF going by its
photos; docs/pilot.md):

* a short, waist-length sleeved jacket with no collar: front zip just right of the midline, a
  flapped pocket and a hook-and-loop field on the left chest, a box pouch on the right ribs,
  webbing keepers low on the front, slotted webbing rows on the sides, waist adjusters, two
  arm-restraint straps round each upper arm, hook-and-loop on the forearms, grey tape bands and
  cuff tabs, the navy rank tab and a pocket with the lime arm-restraint cord on the left sleeve,
  the flag on the right sleeve;
* the life preserver (LPU) stowed in it: a padded horseshoe that stands behind the neck as a soft
  roll and runs down the chest as two lobes either side of the zip, grey binding on the inner
  edges, an olive mesh panel on the lower half, a toggle hanging at each tip;
* full-coverage anti-G trousers (FCAGS), abdomen to ankles: rolled top edge, inseam zips, a coarse
  strip down each shin, a black dome fitting on the belly;
* the personal equipment connector (PEC) on the front of the left thigh, where the breathing-gas
  hose (BGHA), the anti-G hose and the helmet cable meet; in the cockpit its lead to the seat;
* the grey mask hose with the microphone lead wound round it, down to the disconnect on the
  sternum;
* in the cockpit only, the seat's own harness: shoulder straps over the LPU lobes and lap straps
  meeting at the quick-release box.

No torso harness, Koch fittings, leg garters or survival vest: on the F-35 the harness belongs to
the seat and the survival kit and raft are in the seat.

Garments are offset copies of the body's solids (sdf.Offset) cut to their extent by planes that
ride on the bones.  Sewn-on webbing is a thin skin over a garment, kept inside a ribbon round its
path; hoses, cables and the seat straps are swept along paths that are pushed clear of the body.
"""
import math

import numpy as np

from . import body, helmet, sdf
from .skeleton import unit

BIG = ((-3.0, -3.0, -3.0), (3.0, 3.0, 3.0))
JACKET_T = 0.008        # jacket shell over the coverall
FCAGS_T = 0.012         # anti-G trousers: shell and deflated bladder
STRAP_T = 0.0050        # webbing thickness (>= 2.5 grid cells of the 2 mm strap meshes)
LPU_T = 0.043           # stowed life preserver: its thickness over the jacket
UPPER = ["pelvis", "spine", "chest", "neck", "head"] + [f"{n}.{s}" for s in ("L", "R")
                                                        for n in ("clav", "shoulder", "elbow", "wrist", "hand")]


# ----------------------------------------------------------------------------------- helpers
def side(c, n, lo=None, hi=None):
    """Solid filling the half space on the n side of the plane through c."""
    lo = BIG[0] if lo is None else lo
    hi = BIG[1] if hi is None else hi
    return sdf.Plane(c, -np.asarray(n, float), lo, hi)


def place(j, F, bone, x, t, z):
    return body._place(j, F, bone, (x, t, z))


def surface(solid, origin, direction, rmax=0.4):
    """Point where `solid` is crossed going out from origin (inside it) along direction."""
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


def grad(solid, P, e=0.001):
    """Unit gradients (outward normals) of a solid at points P (N x 3)."""
    P = np.atleast_2d(np.asarray(P, float))
    g = np.stack([solid.dist(P + o) - solid.dist(P - o) for o in np.eye(3) * e], axis=1)
    return g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-12)


def normal(solid, p, e=0.001):
    return grad(solid, p, e)[0]


def on(base, j, F, bone, x, t, d, lift=0.0):
    """Point on base's surface out from the bone point (x, t) along d, lifted along the normal."""
    p = surface(base, place(j, F, bone, x, t, 0.0), d)
    return p + normal(base, p) * lift if lift else p


def push_out(P, base, clearance, it=3):
    """Move path points that come closer than `clearance` to base out along its normal."""
    P = np.array(P, float)
    for _ in range(it):
        d = base.dist(P)
        m = d < clearance
        if not m.any():
            break
        P[m] += grad(base, P[m]) * (clearance - d[m])[:, None]
    return P


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


def near(solid, c, half=0.07, h=0.002):
    """`solid` sampled in a box round c: a cheap stand-in for many evaluations there."""
    f = sdf.Field(np.asarray(c, float) - half, np.asarray(c, float) + half, h)
    f.add(solid, 0.0)
    return sdf.Sampled(f)


def upper_bounds(j, pad=0.14):
    P = np.array([j[k] for k in UPPER])
    return P.min(0) - pad, P.max(0) + pad


def around(base, j, F, bone, t, n=25):
    """Closed ring of surface points round the bone at t (first point repeated at the end)."""
    R = F[bone]
    c = place(j, F, bone, 0.0, t, 0.0)
    return np.array([surface(base, c, R[0] * math.cos(a) + R[2] * math.sin(a))
                     for a in np.linspace(0, 2 * np.pi, n)])


def arc(base, j, F, bone, t, a0, a1, sg, n=9):
    """Surface points round the bone at t from angle a0 to a1 (degrees from the front towards
    the side sg: +1 the pilot's left, -1 the right)."""
    R = F[bone]
    c = place(j, F, bone, 0.0, t, 0.0)
    return np.array([surface(base, c, R[2] * math.cos(a) + R[0] * sg * math.sin(a))
                     for a in np.radians(np.linspace(a0, a1, n))])


def tangent_frame(d, up):
    """Rows (across, up, d): a right-handed frame on a surface of normal d, `up` made tangent."""
    d = unit(np.asarray(d, float))
    up = np.asarray(up, float)
    u = unit(up - d * (up @ d))
    return np.stack([np.cross(u, d), u, d])


def lofts(j, F, band=0.09):
    """The body's lofts with distances good to `band` off them: the LPU stands 4.3 cm over the
    jacket and the PEC 3 cm over the trousers, so their bases must be right that far out."""
    torso = body.loft(j, F, body.TORSO, rounds=body.LOFT_ROUND["torso"], band=band)
    arms = {s: body.loft(j, F, body.ARM, s, body.LOFT_ROUND["arm"], band=band) for s in ("L", "R")}
    legs = {s: body.loft(j, F, body.LEG, s, body.LOFT_ROUND["leg"], band=band) for s in ("L", "R")}
    return torso, arms, legs


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


def band(base, pts, width, thick=STRAP_T, h=0.0015, smooth=1):
    """Mesh of a strap of `width` sewn over base along pts."""
    pts = np.asarray(pts, float)
    m = width + 0.02
    return mesh(skin_strap(base, pts, width, thick), h, smooth=smooth, lo=pts.min(0) - m, hi=pts.max(0) + m)


def bands(base, paths, width, thick=STRAP_T, h=0.0015):
    """Several straps over base meshed together."""
    ops = []
    for p in paths:
        ops += skin_strap(base, np.asarray(p, float), width, thick)
    P = np.concatenate([np.asarray(p, float) for p in paths])
    m = width + 0.02
    return mesh(ops, h, smooth=1, lo=P.min(0) - m, hi=P.max(0) + m)


def sewn_patch(base, p, cut, t0=0.0005, t1=0.0030, h=0.001, half=0.06):
    """A sewn-on piece: the shell t0..t1 over base, inside the solid `cut`."""
    ops = [(sdf.Offset(base, t1), 0.0, "union"), (sdf.Offset(base, t0), 0.0, "sub"), (cut, 0.0, "inter")]
    p = np.asarray(p, float)
    return mesh(ops, h, smooth=1, lo=p - half, hi=p + half)


def flat_grid(c, a, b, ha, hb, na, nb, normal, disc=False):
    """A flat all-quad sheet centred on c, +-ha along unit a and +-hb along unit b, facing
    `normal`.  disc=True squeezes the square grid onto the ellipse ha x hb (no pole)."""
    X, Y = np.meshgrid(np.linspace(-1.0, 1.0, na + 1), np.linspace(-1.0, 1.0, nb + 1))
    if disc:
        X, Y = X * np.sqrt(1.0 - Y * Y / 2.0), Y * np.sqrt(1.0 - X * X / 2.0)
    a, b = np.asarray(a, float), np.asarray(b, float)
    v = np.asarray(c, float) + (X.ravel() * ha)[:, None] * a + (Y.ravel() * hb)[:, None] * b
    i = (np.arange(nb)[:, None] * (na + 1) + np.arange(na)[None, :]).ravel()
    q = np.stack([i, i + 1, i + na + 2, i + na + 1], axis=1)
    if np.dot(np.cross(a, b), normal) < 0.0:
        q = q[:, ::-1]
    return v, q


def first_exit(solid, O, D, rmax=0.08, n=33, it=22):
    """Where rays from points O (inside solid) along unit directions D first leave it: coarse
    steps find the first sample outside, bisection refines it (rays that leave and re-enter
    farther on still stop at the first crossing)."""
    O = np.asarray(O, float)
    D = np.asarray(D, float)
    ts = np.linspace(0.0, rmax, n)
    out = solid.dist(O[:, None, :] + D[:, None, :] * ts[None, :, None]) >= 0
    out[:, 0] = False
    out[:, -1] = True
    k = np.argmax(out, axis=1)
    lo, hi = ts[k - 1], ts[k]
    for _ in range(it):
        mid = 0.5 * (lo + hi)
        ins = solid.dist(O + D * mid[:, None]) < 0
        lo = np.where(ins, mid, lo)
        hi = np.where(ins, hi, mid)
    return O + D * (0.5 * (lo + hi))[:, None]


def ring(centre, axis, radius, n=48):
    a = unit(np.asarray(axis, float))
    u = unit(np.cross(a, [0.0, 0.0, 1.0]) if abs(a[2]) < 0.9 else np.cross(a, [1.0, 0.0, 0.0]))
    v = np.cross(a, u)
    th = np.linspace(0, 2 * np.pi, n + 1)
    return np.asarray(centre)[None] + radius * (np.cos(th)[:, None] * u + np.sin(th)[:, None] * v)


# ----------------------------------------------------------------------------------- sweeps
def resample(path, step):
    """The polyline resampled at (about) equal arc-length steps."""
    P = np.asarray(path, float)
    s = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
    m = max(2, int(math.ceil(s[-1] / step)) + 1)
    u = np.linspace(0.0, s[-1], m)
    return np.stack([np.interp(u, s, P[:, k]) for k in range(3)], axis=1)


def path_frames(P, ref=None):
    """Tangents, normals and binormals along a polyline (normals parallel-transported)."""
    T = np.gradient(P, axis=0)
    T /= np.maximum(np.linalg.norm(T, axis=1, keepdims=True), 1e-12)
    ref = np.array([0.0, 0.0, 1.0]) if ref is None else np.asarray(ref, float)
    if abs(ref @ T[0]) > 0.95:
        ref = np.array([1.0, 0.0, 0.0])
    N = np.empty_like(P)
    n = unit(ref - T[0] * (ref @ T[0]))
    for i, t in enumerate(T):
        n = unit(n - t * (n @ t))
        N[i] = n
    return T, N, np.cross(T, N)


def arclen(P):
    return np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]


def sweep(path, radius, n=12, amp=0.0, pitch=0.01, step=0.002, ref=None):
    """Quad mesh of a round tube along a path (corrugated: radius + amp sin(2 pi s / pitch)).
    The ends are open: they go into fittings."""
    P = resample(path, step)
    _T, N, B = path_frames(P, ref)
    r = radius + amp * np.sin(2 * np.pi * arclen(P) / pitch) if amp else np.full(len(P), float(radius))
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    rg = np.cos(th)[None, :, None] * N[:, None, :] + np.sin(th)[None, :, None] * B[:, None, :]
    v = (P[:, None, :] + r[:, None, None] * rg).reshape(-1, 3)
    i = np.arange(len(P) - 1)[:, None]
    k = np.arange(n)[None, :]
    a, b = i * n + k, i * n + (k + 1) % n
    return v, np.stack([a, b, b + n, a + n], axis=-1).reshape(-1, 4)


def helix(path, radius, pitch, step=0.001, ref=None):
    """A wire wound round a path."""
    P = resample(path, step)
    _T, N, B = path_frames(P, ref)
    a = 2 * np.pi * arclen(P) / pitch
    return P + radius * (np.cos(a)[:, None] * N + np.sin(a)[:, None] * B)


def running_mean(A, k):
    """Moving average of the rows of A over +-k rows (shorter windows at the ends)."""
    A = np.asarray(A, float)
    cs = np.cumsum(np.vstack([np.zeros((1,) + A.shape[1:]), A]), axis=0)
    i = np.arange(len(A))
    i0, i1 = np.clip(i - k, 0, len(A)), np.clip(i + k + 1, 0, len(A))
    return (cs[i1] - cs[i0]) / (i1 - i0).reshape((-1,) + (1,) * (A.ndim - 1))


def taut(path, base, clearance, step=0.004, it=6, k=4):
    """A strap's path pulled taut over base: smoothed (ends kept) and pushed clear in turns, so
    it bridges hollows and creases instead of following them."""
    P = resample(path, step)
    for _ in range(it):
        S = running_mean(P, k)
        S[0], S[-1] = P[0], P[-1]
        P = push_out(S, base, clearance)
    return P


def ribbon(path, base, width, thick, step=0.004, turn=0.05):
    """Flat webbing (width x thick) along a path lying on base (its face turned to base's
    normal, averaged over `turn` of its length: a strap twists slowly), with closed ends: a
    tensioned strap bridges hollows instead of dipping into them."""
    P = resample(path, step)
    T = np.gradient(P, axis=0)
    T /= np.maximum(np.linalg.norm(T, axis=1, keepdims=True), 1e-12)
    # the base's normal sampled a little off the surface (smoother over creases), averaged
    G = grad(base, P, e=0.004)
    Nb = running_mean(grad(base, P + G * 0.012, e=0.004), max(1, int(turn / step / 2)))
    Nb = Nb - T * (Nb * T).sum(1, keepdims=True)
    n = np.linalg.norm(Nb, axis=1)
    ok = n > 0.2
    if not ok.all():                       # along the normal: keep the neighbours' orientation
        idx = np.maximum.accumulate(np.where(ok, np.arange(len(P)), 0))
        Nb = Nb[idx]
        n = n[idx]
    Nb /= np.maximum(n, 1e-12)[:, None]
    X = np.cross(T, Nb)
    w, t = width / 2, thick / 2
    cs = [(-w, -t), (w, -t), (w, t), (-w, t)]
    v = np.concatenate([P + X * a + Nb * b for a, b in cs], axis=1).reshape(-1, 3)
    m = len(P)
    q = []
    for k in range(4):
        k1 = (k + 1) % 4
        i = np.arange(m - 1)
        q.append(np.stack([i * 4 + k, (i + 1) * 4 + k, (i + 1) * 4 + k1, i * 4 + k1], axis=1))
    q.append(np.array([[0, 1, 2, 3], [(m - 1) * 4 + 3, (m - 1) * 4 + 2, (m - 1) * 4 + 1, (m - 1) * 4]]))
    return v, np.concatenate(q)


def merge(*meshes):
    """Concatenate (v, q) meshes."""
    vs, qs, n = [], [], 0
    for v, q in meshes:
        vs.append(v)
        qs.append(q + n)
        n += len(v)
    return np.concatenate(vs), np.concatenate(qs)


def face_normals(v, q):
    n = np.cross(v[q[:, 2]] - v[q[:, 0]], v[q[:, 3]] - v[q[:, 1]])
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


# ----------------------------------------------------------------------------------- jacket
def jacket_fields(j, F, torso, arms, h=0.004):
    """(jb, tf): jb the jacket's whole outer surface (torso, neck, shoulders and sleeves, uncut)
    as a sampled solid to place things on; tf a Field of its torso part alone, to be cut at the
    hem and the neck before the sleeves go on (so the hem cannot shorten hanging sleeves)."""
    lo, hi = upper_bounds(j)
    f = sdf.Field(lo, hi, h)
    f.add(sdf.Offset(torso, JACKET_T), 0.0)
    table = [e for e in body.SOLIDS if e[0] in ("neck", "upperarm", "chest")]
    for s, k in body.solids(j, F, table)[5:]:
        f.add(sdf.Offset(s, JACKET_T), k)
    tf = sdf.Field(lo, hi, h)
    tf.d = f.d.copy()
    for s in ("L", "R"):
        f.add(sdf.Offset(arms[s], JACKET_T), 0.035)
    return sdf.Sampled(f), tf


def jacket_parts(j, F, jb, tf, arms):
    """The jacket and everything sewn on it.  Returns (parts, solids standing proud of it)."""
    Fs, Fc, Fn = F["spine"], F["chest"], F["neck"]
    out, extra = [], []
    # ---- the shell: hem at navel height, no collar (the LPU roll is the collar), cuffs at the wrist
    hem = place(j, F, "spine", 0.0, 0.06, 0.0)
    tf.add(side(hem, -Fs[1]), 0.004, "sub")
    tf.add(sdf.RoundCone(place(j, F, "chest", 0.0, 0.80, 0.0), j["head"] + Fn[1] * 0.05, 0.072, 0.078), 0.010, "sub")
    for s in ("L", "R"):
        tf.add(sdf.Offset(arms[s], JACKET_T), 0.035)
        c = place(j, F, f"forearm.{s}", 0.0, 0.86, 0.0)
        tf.add(side(c, F[f"forearm.{s}"][1], c - 0.16, c + 0.16), 0.003, "sub")
    # box pouch on the front/side of the right ribs (16 x 14 x 5 cm), a stiff box
    a = math.radians(65.0)
    p = surface(jb, place(j, F, "spine", -0.03, 0.47, 0.0), Fs[2] * math.cos(a) - Fs[0] * math.sin(a))
    n = normal(jb, p)
    Rb = tangent_frame(n, Fs[1])
    pouch = sdf.RoundBox(p + n * 0.004, (0.060, 0.064, 0.030), 0.008, Rb)
    tf.add(pouch, 0.006, "union")
    extra.append(pouch)
    v, q = tf.mesh(smooth=3)
    out.append(dict(name="Jacket", v=v, q=q, mat="jacket", bone=None))
    flaps = [(sdf.RoundBox(p + n * 0.0355 + Rb[1] * 0.044, (0.062, 0.024, 0.0025), 0.002, Rb), 0.0, "union")]
    snaps = [(sdf.Disc(p + n * 0.039 + Rb[1] * 0.030, n, 0.0065, 0.0018, 0.001), 0.0, "union")]
    # ---- left chest: flapped pocket outboard of the LPU lobe, a hook-and-loop field below it
    d = unit(Fc[2] + Fc[0] * 0.55)
    p = surface(jb, place(j, F, "chest", 0.13, 0.05, 0.0), d)
    n = normal(jb, p)
    Rp = tangent_frame(n, Fc[1])
    cut = sdf.RoundBox(p, (0.060, 0.038, 0.04), 0.006, Rp)
    v, q = sewn_patch(jb, p, cut, -0.002, 0.010, h=0.0015, half=0.08)
    out.append(dict(name="Jacket_Pocket", v=v, q=q, mat="jacket", bone=None))
    extra.append(sdf.Custom(lambda P, c=cut: np.maximum(jb.dist(P) - 0.010, c.dist(P)), *cut.aabb()))
    cutf = sdf.RoundBox(p + Rp[1] * 0.024, (0.063, 0.017, 0.04), 0.005, Rp)
    v, q = sewn_patch(jb, p, cutf, 0.0085, 0.0125, h=0.0012, half=0.08)
    out.append(dict(name="Jacket_Flap_Pocket", v=v, q=q, mat="jacket", bone=None))
    snaps.append((sdf.Disc(p + n * 0.0135 + Rp[1] * 0.018, n, 0.0060, 0.0016, 0.001), 0.0, "union"))
    pv = on(jb, j, F, "spine", 0.14, 0.62, unit(Fs[2] + Fs[0] * 0.55))
    nv = normal(jb, pv)
    cutv = sdf.RoundBox(pv, (0.064, 0.030, 0.04), 0.006, tangent_frame(nv, Fs[1]))
    v, q = sewn_patch(jb, pv, cutv, 0.0004, 0.0028, h=0.0012, half=0.08)
    out.append(dict(name="Jacket_Velcro_Chest", v=v, q=q, mat="velcro", bone=None))
    v, q = mesh(flaps, 0.001, smooth=1)
    out.append(dict(name="Jacket_Flap_Pouch", v=v, q=q, mat="jacket", bone=None))
    v, q = mesh(snaps, 0.0006, smooth=1)
    out.append(dict(name="Jacket_Snaps", v=v, q=q, mat="black_gloss", bone=None))
    # ---- front zip just right of the midline, along the inner edge of the right LPU lobe
    pts = [on(jb, j, F, b, -0.024, t, F[b][2], 0.001) for b, t in
           (("spine", 0.08), ("spine", 0.45), ("spine", 0.85), ("chest", 0.25), ("chest", 0.55), ("chest", 0.79))]
    v, q = sweep(sdf.spline(pts, 10), 0.0045, n=8, step=0.002)
    out.append(dict(name="Jacket_Zip", v=v, q=q, mat="zip", bone=None))
    # ---- webbing keepers: two columns low on the front right, one low on the front left
    ops = []
    for x, t in [(-0.072, t) for t in (0.20, 0.45, 0.70)] + [(-0.100, t) for t in (0.20, 0.45, 0.70)] + [(0.062, 0.32)]:
        pp = on(jb, j, F, "spine", x, t, unit(Fs[2] + Fs[0] * x * 2.0))
        nn = normal(jb, pp)
        ops.append((sdf.RoundBox(pp + nn * 0.0025, (0.0125, 0.016, 0.0024), 0.0015, tangent_frame(nn, Fs[1])), 0.0, "union"))
    v, q = mesh(ops, 0.0012, smooth=1)
    out.append(dict(name="Jacket_Loops", v=v, q=q, mat="webbing_gg", bone=None))
    # ---- slotted webbing rows on each side, wrapping towards the back; waist adjusters
    buckles = []
    for sg, s in ((1.0, "L"), (-1.0, "R")):
        rows = [arc(jb, j, F, "spine", t, 95.0, 150.0, sg, n=7) for t in (0.30, 0.46, 0.62, 0.78, 0.94)]
        v, q = bands(jb, rows, 0.016, thick=0.0032)
        out.append(dict(name=f"Jacket_Grid_{s}", v=v, q=q, mat="webbing_gg", bone=None))
        v, q = band(jb, arc(jb, j, F, "spine", 0.16, 66.0, 114.0, sg, n=7), 0.025, thick=0.0032)
        out.append(dict(name=f"Jacket_Adjust_{s}", v=v, q=q, mat="webbing_gg", bone=None))
        pb = arc(jb, j, F, "spine", 0.16, 90.0, 90.0, sg, n=1)[0]
        nb = normal(jb, pb)
        Rk = tangent_frame(nb, Fs[1])
        buckles.append((sdf.RoundBox(pb + nb * 0.0045, (0.024, 0.016, 0.0022), 0.0015, Rk), 0.0, "union"))
        buckles.append((sdf.RoundBox(pb + nb * 0.0045, (0.017, 0.010, 0.004), 0.001, Rk), 0.0, "sub"))
        buckles.append((sdf.RoundBox(pb + nb * 0.0045, (0.0025, 0.012, 0.0025), 0.001, Rk), 0.0, "union"))
    v, q = mesh(buckles, 0.0008, smooth=1)
    out.append(dict(name="Jacket_Buckles", v=v, q=q, mat="olive_metal", bone=None))
    # ---- seams: a rolled hem, the back yoke and the centre-back seam (half sunk piping)
    v, q = sweep(around(jb, j, F, "spine", 0.068, n=49), 0.0048, n=10, step=0.003)
    out.append(dict(name="Jacket_Hem", v=v, q=q, mat="jacket", bone=None))
    yoke = np.concatenate([arc(jb, j, F, "chest", 0.74, 118.0, 180.0, 1.0, n=9),
                           arc(jb, j, F, "chest", 0.74, 180.0, 118.0, -1.0, n=9)[1:]])
    back = [on(jb, j, F, b, 0.0, t, -F[b][2]) for b, t in (("spine", 0.075), ("spine", 0.45), ("spine", 0.85),
                                                          ("chest", 0.30), ("chest", 0.74))]
    seams = []
    for pts in (sdf.spline(yoke, 6), sdf.spline(back, 8)):
        pts = resample(pts, 0.002)
        pts = pts - grad(jb, pts) * (jb.dist(pts) + 0.0008)[:, None]
        seams.append(sweep(pts, 0.0018, n=8, step=0.002))
    v, q = merge(*seams)
    out.append(dict(name="Jacket_Seams", v=v, q=q, mat="jacket", bone=None))
    out += sleeve_parts(j, F, jb, arms)
    return out, extra


def sleeve_parts(j, F, jb, arms):
    """Rigid details on the sleeves: arm-restraint straps, tape bands, hook-and-loop, cuff tabs,
    the rank tab, flag, pocket and lime cord."""
    out = []
    for sg, s in ((1.0, "L"), (-1.0, "R")):
        U, Fa = f"upperarm.{s}", F[f"forearm.{s}"]
        sl = sdf.Offset(arms[s], JACKET_T)
        # two black arm-restraint straps above the elbow
        v, q = bands(sl, [around(sl, j, F, U, t) for t in (0.70, 0.84)], 0.022, thick=0.004)
        out.append(dict(name=f"Jacket_ARS_{s}", v=v, q=q, mat="webbing_black", bone=U))
        # grey tape band on the forearm (the cuff itself is under the glove's gauntlet)
        v, q = band(sl, around(sl, j, F, f"forearm.{s}", 0.53), 0.025, thick=0.0028)
        out.append(dict(name=f"Jacket_SleeveBand_{s}", v=v, q=q, mat="binding", bone=f"forearm.{s}"))
        # hook-and-loop field on the outer forearm
        pv = on(jb, j, F, f"forearm.{s}", 0.0, 0.27, Fa[0] * sg)
        nv = normal(jb, pv)
        cut = sdf.RoundBox(pv, (0.0225, 0.050, 0.04), 0.006, tangent_frame(nv, -Fa[1]))
        v, q = sewn_patch(near(jb, pv, 0.075), pv, cut, 0.0004, 0.0028, h=0.001, half=0.075)
        out.append(dict(name=f"Jacket_Velcro_{s}", v=v, q=q, mat="velcro", bone=f"forearm.{s}"))
    # left sleeve: navy rank tab (one white leaf: rav-seren), the pocket with the lime cord
    Ru = F["upperarm.L"]
    pt = on(jb, j, F, "upperarm.L", 0.0, 0.17, unit(Ru[0] + Ru[2] * 0.15))
    nt = normal(jb, pt)
    Rt = tangent_frame(nt, -Ru[1])
    base = near(jb, pt, 0.06, 0.0015)
    v, q = sewn_patch(base, pt, sdf.RoundBox(pt, (0.028, 0.028, 0.04), 0.004, Rt), 0.0005, 0.0028, h=0.0008, half=0.045)
    rel = v - pt
    out.append(dict(name="Jacket_RankTab", v=v, q=q, mat="rank_tab", bone="upperarm.L",
                    uv=np.c_[0.5 + rel @ Rt[0] / 0.056, 0.5 + rel @ Rt[1] / 0.056]))
    pp = on(jb, j, F, "upperarm.L", 0.0, 0.48, unit(Ru[0] + Ru[2] * 0.25))
    npk = normal(jb, pp)
    Rk = tangent_frame(npk, -Ru[1])
    base = near(jb, pp, 0.07, 0.0015)
    v, q = sewn_patch(base, pp, sdf.RoundBox(pp, (0.034, 0.044, 0.04), 0.005, Rk), -0.002, 0.008, h=0.001, half=0.06)
    out.append(dict(name="Jacket_SleevePocket", v=v, q=q, mat="jacket", bone="upperarm.L"))
    v, q = sewn_patch(base, pp, sdf.RoundBox(pp + Rk[1] * 0.031, (0.036, 0.015, 0.04), 0.004, Rk), 0.0075, 0.011,
                      h=0.0009, half=0.06)
    out.append(dict(name="Jacket_SleeveFlap", v=v, q=q, mat="jacket", bone="upperarm.L"))
    cord = [pp + Rk[1] * 0.047 + Rk[0] * x + npk * 0.0105 for x in (-0.040, -0.020, 0.0, 0.020, 0.034)]
    cord.append(cord[-1] + Rk[0] * 0.012 - Rk[1] * 0.006 - npk * 0.004)
    v, q = sweep(push_out(sdf.spline(cord, 6), base, 0.009), 0.0024, n=8, step=0.0015)
    out.append(dict(name="Jacket_LimeCord", v=v, q=q, mat="lime_cord", bone="upperarm.L"))
    # right sleeve: the Israeli flag
    Rr = F["upperarm.R"]
    pf = on(jb, j, F, "upperarm.R", 0.0, 0.22, unit(-Rr[0] + Rr[2] * 0.15))
    nf = normal(jb, pf)
    Rf = tangent_frame(nf, -Rr[1])
    base = near(jb, pf, 0.07, 0.0015)
    v, q = sewn_patch(base, pf, sdf.RoundBox(pf, (0.0425, 0.0275, 0.04), 0.004, Rf), 0.0005, 0.0028, h=0.0009,
                      half=0.06)
    rel = v - pf
    out.append(dict(name="Jacket_Flag", v=v, q=q, mat="flag", bone="upperarm.R",
                    uv=np.c_[0.5 + rel @ Rf[0] / 0.085, 0.5 + rel @ Rf[1] / 0.055]))
    return out


# ----------------------------------------------------------------------------------- LPU
# the horseshoe's centre line, left half from the lobe tip to behind the neck (mirrored for the
# right): (bone, x, t, direction, tube radius).  The tube centre sits LPU_LIFT radii off the
# jacket; the lobe is then clipped to LPU_T over it: flat against the body, convex outside.
LPU_PATH = [
    ("chest", 0.070, 0.04, "front", 0.033),        # lobe tip, lower chest
    ("chest", 0.070, 0.30, "front", 0.039),
    ("chest", 0.072, 0.60, "front", 0.040),
    ("chest", 0.078, 0.86, "upfront", 0.036),
    ("chest", 0.084, 1.02, "up", 0.033),           # over the trapezius
    ("neck", 0.050, 0.34, "backout", 0.031),
]
LPU_BACK = ("neck", 0.0, 0.40, 0.030)              # the roll behind the neck
LPU_LIFT = 0.45
N_PER = 8
LPU_CREASE = 0.012                                 # blend radius of the cut edge
LPU_PHI = np.linspace(-50.0, 230.0, 37)            # the cover's rays round each ring (deg)
LPU_BIND = (26.0, 58.0)                            # grey binding over the inner edge
LPU_MESH = (58.0, 150.0)                           # olive mesh over the face


def _lpu_dir(F, key, sg):
    Fc, Fn = F["chest"], F["neck"]
    return {"front": Fc[2], "upfront": unit(Fc[1] + Fc[2]), "up": Fc[1],
            "backout": unit(-Fn[2] + Fn[0] * sg * 0.9), "back": -Fn[2]}[key]


def lpu_path(j, F, jb):
    """Control points, radii and labels ('L', 'R' lobes, 'N' round the neck), left tip to right tip."""
    pts = []
    for sg, s in ((1.0, "L"), (-1.0, "R")):
        half = []
        for bone, x, t, key, r in LPU_PATH:
            p = surface(jb, place(j, F, bone, x * sg, t, 0.0), _lpu_dir(F, key, sg))
            half.append((p + normal(jb, p) * r * LPU_LIFT, r, s if bone == "chest" else "N"))
        if s == "L":
            bone, x, t, r = LPU_BACK
            p = surface(jb, place(j, F, bone, x, t, 0.0), -F["neck"][2])
            half.append((p + normal(jb, p) * r * LPU_LIFT, r, "N"))
            pts += half
        else:
            pts += half[::-1]
    return np.array([p for p, _r, _l in pts]), np.array([r for _p, r, _l in pts]), [l for _p, _r, l in pts]


def lpu_solid(j, F, jb):
    """The stowed LPU as a solid: the tube round its centre line, cut to LPU_T over the jacket
    (the cut edge rounded) and sunk 2 mm into it."""
    pts, rad, lab = lpu_path(j, F, jb)
    path = sdf.spline(pts, N_PER)
    n = len(path)
    rr = np.interp(np.arange(n) / N_PER, np.arange(len(pts)), rad)
    tube = sdf.Tube(path, rr, band=0.02)
    labels = [lab[min(int(round(i / N_PER)), len(lab) - 1)] for i in range(n)]

    def f(P):
        db = jb.dist(P)
        return np.maximum(sdf.smax(tube.dist(P), db - LPU_T, LPU_CREASE), -(db + 0.002))
    lo, hi = tube.aabb()
    return sdf.Custom(f, lo, hi), path, labels, rr


def lpu_cover(jb, lpu, path, labels, step=0.004, caps=7):
    """Quad mesh of the LPU's cover, cast from its centre line: a ring of rays at each step along
    the path, from under the inner edge over the face to under the outer edge (LPU_PHI: 0 points
    at the inside of the horseshoe, 90 deg away from the body), closed by domes at the lobe tips.
    Returns v, q, and per quad its ring (-1 on the domes) and phi (deg), the rings' centres and
    labels, and per-vertex (along, around) arc lengths for UVs."""
    P = resample(path, step)
    sp = arclen(path)
    sP = arclen(P)
    lab = np.array([labels[min(int(np.searchsorted(sp, x)), len(labels) - 1)] for x in sP])
    T = np.gradient(P, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    G = grad(jb, P)
    k = 6
    cs = np.cumsum(np.vstack([np.zeros(3), G]), axis=0)
    i0 = np.clip(np.arange(len(P)) - k, 0, len(P))
    i1 = np.clip(np.arange(len(P)) + k + 1, 0, len(P))
    G = (cs[i1] - cs[i0]) / (i1 - i0)[:, None]
    M = np.cross(G, T)
    M /= np.linalg.norm(M, axis=1, keepdims=True)
    N = np.cross(T, M)
    ph = np.radians(LPU_PHI)
    D = np.cos(ph)[None, :, None] * M[:, None, :] + np.sin(ph)[None, :, None] * N[:, None, :]
    # domes: the rays tilt out of the end rings towards the tips' poles
    b = np.radians(np.linspace(90.0, 90.0 / caps, caps))
    dl = np.cos(b)[:, None, None] * D[0][None] - np.sin(b)[:, None, None] * T[0][None, None]
    dr = np.cos(b[::-1])[:, None, None] * D[-1][None] + np.sin(b[::-1])[:, None, None] * T[-1][None, None]
    Dall = np.concatenate([dl, D, dr])
    Oall = np.concatenate([np.repeat(P[:1], caps, 0), P, np.repeat(P[-1:], caps, 0)])
    R, K = Dall.shape[:2]
    Dall /= np.linalg.norm(Dall, axis=2, keepdims=True)
    V = first_exit(lpu, np.repeat(Oall, K, 0), Dall.reshape(-1, 3)).reshape(R, K, 3)
    r = np.arange(R - 1)[:, None]
    c = np.arange(K - 1)[None, :]
    q = np.stack([r * K + c, r * K + c + 1, (r + 1) * K + c + 1, (r + 1) * K + c], -1).reshape(-1, 4)
    ring = np.repeat(np.arange(R - 1) - caps, K - 1)
    ring[(ring < 0) | (ring >= len(P) - 1)] = -1
    phi = np.tile(0.5 * (LPU_PHI[:-1] + LPU_PHI[1:]), R - 1)
    # UVs in metres: along the centre line, and round each ring
    along = np.concatenate([-np.linspace(1.0, 1.0 / caps, caps) * 0.03, sP, sP[-1] + np.linspace(1.0 / caps, 1.0, caps) * 0.03])
    around = np.concatenate([np.zeros((R, 1)), np.cumsum(np.linalg.norm(np.diff(V, axis=1), axis=2), axis=1)], 1)
    uv = np.stack([np.repeat(along[:, None], K, 1), around], -1).reshape(-1, 2)
    return V.reshape(-1, 3), q, ring, phi, P, lab, uv


def lpu_parts(j, F, jb):
    Fc = F["chest"]
    lpu, path, labels, rr = lpu_solid(j, F, jb)
    v, q, ring, phi, P, lab, uv = lpu_cover(jb, lpu, path, labels)
    # grey binding over the inner edge all round the horseshoe; the olive mesh on the face of
    # the lower half of each lobe (below mid-chest)
    t_chest = ((P - j["chest"]) @ Fc[1]) / np.linalg.norm(j["neck"] - j["chest"])
    mi = np.zeros(len(q), np.int32)
    main = ring >= 0
    rc = np.clip(ring, 0, len(P) - 1)
    mi[main & (phi > LPU_BIND[0]) & (phi < LPU_BIND[1])] = 1
    lower = (lab[rc] != "N") & (t_chest[rc] < 0.50)
    mi[main & lower & (phi > LPU_MESH[0]) & (phi < LPU_MESH[1])] = 2
    out = [dict(name="LPU", v=v, q=q, mat="jacket", bone=None, mats=["jacket", "binding", "lpu_mesh"], mi=mi,
                uv=uv)]
    # inflation toggles hanging from the lobe tips on short grey cords
    tog, cords = [], []
    for k, k2 in ((0, 3), (-1, -4)):
        tip = path[k] + unit(path[k] - path[k2]) * 0.030
        tip = tip - normal(jb, tip) * 0.006
        a = tip - Fc[1] * 0.020
        cords.append(sweep([tip, tip - Fc[1] * 0.010, a], 0.0015, n=6, step=0.002))
        tog.append((sdf.RoundCone(a - Fc[1] * 0.004, a - Fc[1] * 0.026, 0.0065, 0.0105), 0.0, "union"))
    v, q = mesh(tog, 0.0009, smooth=2)
    out.append(dict(name="LPU_Toggles", v=v, q=q, mat="toggle", bone=None))
    v, q = merge(*cords)
    out.append(dict(name="LPU_ToggleCords", v=v, q=q, mat="binding", bone=None))
    # two black ring snaps on the left lobe's binding (5 and 13 cm below the notch)
    U = sdf.Union([jb, lpu])
    ops = []
    for t in (0.79, 0.45):
        p = on(U, j, F, "chest", 0.040, t, unit(Fc[2] - Fc[0] * 0.5))
        n = normal(U, p)
        ops.append((sdf.Disc(p + n * 0.0005, n, 0.0062, 0.0018, 0.0012), 0.0, "union"))
        ops.append((sdf.Disc(p + n * 0.0022, n, 0.0028, 0.0012, 0.0004), 0.0, "sub"))
    v, q = mesh(ops, 0.0005, smooth=1)
    out.append(dict(name="LPU_Snaps", v=v, q=q, mat="black_gloss", bone=None))
    return out, lpu


# ----------------------------------------------------------------------------------- FCAGS
def fcags_base(j, F, torso, legs, h=0.004):
    """Outer surface of the anti-G trousers (uncut), sampled below the waist."""
    u = sdf.Offset(sdf.Union([torso, legs["L"], legs["R"]], 0.04), FCAGS_T)
    lo, hi = u.aabb()
    hi = hi.copy()
    hi[2] = min(hi[2], j["spine"][2] + 0.10)
    f = sdf.Field(lo - 0.02, hi + 0.02, h)
    f.add(u, 0.0)
    return sdf.Sampled(f)


def fcags_parts(j, F, torso, legs):
    fb = fcags_base(j, F, torso, legs)
    Fp = F["pelvis"]
    top = place(j, F, "pelvis", 0.0, 0.76, 0.0)
    ops = [(fb, 0.0, "union"), (side(top, Fp[1], top - 0.35, top + 0.35), 0.006, "sub")]
    for s in ("L", "R"):
        c = place(j, F, f"shin.{s}", 0.0, 0.74, 0.0)
        ops.append((side(c, F[f"shin.{s}"][1], c - 0.20, c + 0.20), 0.006, "sub"))
    lo, hi = fb.aabb()
    v, q = mesh(ops, 0.004, smooth=3, lo=lo, hi=hi)
    out = [dict(name="FCAGS", v=v, q=q, mat="fcags", bone=None)]
    # soft rolled top edge round the abdomen and back
    v, q = sweep(around(fb, j, F, "pelvis", 0.752, n=49), 0.0085, n=12, step=0.003)
    out.append(dict(name="FCAGS_Roll", v=v, q=q, mat="fcags", bone=None))
    # inseam zips (crotch to cuff) and the coarse strip down the front of each shin
    zips, strips = [], []
    for sg, s in ((1.0, "L"), (-1.0, "R")):
        pts = []
        for bone, t in ((f"thigh.{s}", 0.06), (f"thigh.{s}", 0.35), (f"thigh.{s}", 0.65), (f"thigh.{s}", 0.95),
                        (f"shin.{s}", 0.20), (f"shin.{s}", 0.45), (f"shin.{s}", 0.70)):
            R = F[bone]
            pts.append(on(fb, j, F, bone, 0.0, t, unit(-R[0] * sg - R[2] * 0.08), 0.0015))
        zips.append(sweep(sdf.spline(pts, 8), 0.0036, n=8, step=0.002))
        R = F[f"shin.{s}"]
        strips.append([on(fb, j, F, f"shin.{s}", 0.0, t, R[2]) for t in (0.06, 0.25, 0.45, 0.62, 0.71)])
    v, q = merge(*zips)
    out.append(dict(name="FCAGS_Zips", v=v, q=q, mat="zip", bone=None))
    for sg, s in ((1.0, "L"), (-1.0, "R")):
        v, q = band(fb, sdf.spline(strips[0 if s == "L" else 1], 6), 0.05, thick=0.003)
        out.append(dict(name=f"FCAGS_Strip_{s}", v=v, q=q, mat="fcags_strip", bone=None))
    # glossy black dome fitting on the abdominal panel, left of the midline
    p = on(fb, j, F, "pelvis", 0.03, 0.42, Fp[2])
    n = normal(fb, p)
    v, q = mesh([(sdf.Disc(p + n * 0.002, n, 0.0125, 0.004, 0.0035), 0.0, "union")], 0.0006, smooth=1)
    out.append(dict(name="FCAGS_Dome", v=v, q=q, mat="black_gloss", bone=None))
    return out, fb


# ----------------------------------------------------------------------------------- PEC
def pec_frame(j, F, fb):
    """Centre on the front/outer upper left thigh and the axes (long axis tilted 35 deg from the
    horizontal, its connector end towards the rear and down; W across, up; d the normal)."""
    R = F["thigh.L"]
    p = surface(fb, place(j, F, "thigh.L", 0.0, 0.35, 0.0), unit(R[2] + R[0] * 0.55))
    d = normal(fb, p)
    fwd = unit(R[2] - d * (R[2] @ d))
    down = unit(R[1] - d * (R[1] @ d))
    a = math.radians(35.0)
    L = unit(-fwd * math.cos(a) + down * math.sin(a))
    L = unit(L - d * (L @ d))
    W = unit(np.cross(d, L))
    if W @ R[1] > 0:
        W = -W
    return p, L, W, d


def lift_to(base, pt, h, it=3):
    """pt moved onto base's surface, then h out along the normal there."""
    pt = np.array(pt, float)
    for _ in range(it):
        pt = pt - normal(base, pt) * base.dist(pt[None])[0]
    return pt + normal(base, pt) * h


def pec_parts(j, F, fb, leg, cable_end=None):
    """The PEC block (19 x 10.5 x 3.2 cm, black) with its connectors; with cable_end, its lead to
    the seat-side half on the left of the seat bucket.  The block sits in a mount that follows the
    thigh, so it is built as a 3 cm layer over the trousers inside its rounded outline: over the
    left trouser leg alone (`leg`), so that seated it cannot spread onto the belly."""
    p, L, W, d = pec_frame(j, F, fb)
    Rr = np.stack([L, W, d])
    out = []
    TH = 0.030
    base = near(leg, p, 0.13, 0.002)
    v, q = mesh([(sdf.Offset(base, TH), 0.0, "union"), (sdf.Offset(base, -0.004), 0.0, "sub"),
                 (sdf.RoundBox(p, (0.095, 0.052, 0.08), 0.014, Rr), 0.0, "inter")], 0.0015, smooth=2,
                lo=p - 0.12, hi=p + 0.12)
    out.append(dict(name="PEC", v=v, q=q, mat="pec", bone="thigh.L"))
    top = lift_to(base, p - L * 0.030 + W * 0.010, TH)
    nt = normal(base, top)
    rear = lift_to(base, p + L * 0.092, TH * 0.5)
    elbow0 = lift_to(base, p + L * 0.066 + W * 0.038, TH - 0.004)
    ne = normal(base, elbow0)
    elbow = elbow0 + W * 0.026 + ne * 0.014
    front = lift_to(base, p - L * 0.086 + W * 0.030, TH * 0.6)
    ops = [(sdf.Disc(top + nt * 0.004, nt, 0.011, 0.0075, 0.002), 0.0, "union"),             # top knob
           (sdf.Disc(rear + L * 0.006 + W * 0.020, L, 0.010, 0.0085, 0.002), 0.0, "union"),  # rear connectors
           (sdf.Disc(rear + L * 0.006 - W * 0.018, L, 0.010, 0.0085, 0.002), 0.0, "union"),
           (sdf.RoundCone(elbow0, elbow, 0.0125, 0.0115), 0.004, "union"),                   # BGHA elbow
           (sdf.Disc(front - L * 0.004, unit(-L + W * 0.3), 0.0105, 0.0075, 0.002), 0.0, "union")]  # anti-G port
    v, q = mesh(ops, 0.001, smooth=1)
    out.append(dict(name="PEC_Connectors", v=v, q=q, mat="black_gloss", bone="thigh.L"))
    rings = []
    for wv in (0.020, -0.018):
        cc = rear + L * 0.010 + W * wv
        rings += [(sdf.Disc(cc, L, 0.0118, 0.0035, 0.001), 0.0, "union"), (sdf.Disc(cc, L, 0.0098, 0.006, 0.0), 0.0, "sub")]
    v, q = mesh(rings, 0.0006, smooth=1)
    out.append(dict(name="PEC_Rings", v=v, q=q, mat="steel", bone="thigh.L"))
    info = dict(top=top + nt * 0.011, d=nt, elbow=elbow, elbow_dir=unit(W + ne * 0.45), front=front - L * 0.010,
                front_dir=unit(-L + W * 0.3), L=L, W=W, rear=rear + L * 0.015 + W * 0.020)
    if cable_end is not None:
        e = np.asarray(cable_end, float)
        r0 = info["rear"]
        path = sdf.bezier(r0, r0 + L * 0.06, e + (r0 - e) * 0.35 + d * 0.04, e, 40)
        v, q = sweep(push_out(path, fb, 0.012), 0.0085, n=12, step=0.003)
        out.append(dict(name="PEC_SeatLead", v=v, q=q, mat="cable", bone=None))
        dd = unit(e - path[-4])
        v, q = mesh([(sdf.Disc(e + dd * 0.012, dd, 0.021, 0.014, 0.004), 0.0, "union"),
                     (sdf.RoundCone(e - dd * 0.014, e + dd * 0.002, 0.009, 0.0135), 0.004, "union")], 0.0012, smooth=2)
        out.append(dict(name="PEC_SeatPlug", v=v, q=q, mat="pec", bone=None))
    return out, info


# ----------------------------------------------------------------------------------- hoses
def hose_parts(j, F, top, fb, pec):
    """Mask hose (grey, corrugated, the microphone lead wound round it) down to the disconnect on
    the sternum; the teal breathing-gas hose (BGHA) from there across the jacket and the belly to
    the PEC's elbow; the anti-G hose from the left hip into the PEC; the helmet cable from the back
    of the helmet over the LPU and the left shoulder, down the left side to the PEC."""
    C, M = helmet.frame(j, F)
    Fc, Fs, Fp, Fn = F["chest"], F["spine"], F["pelvis"], F["neck"]
    allb = sdf.Union([top, fb])
    out = []
    # quick-disconnect at mid-sternum, slightly right of the midline (grey body, chrome clip)
    s0 = surface(top, place(j, F, "chest", -0.012, 0.29, 0.0), Fc[2])
    n0 = normal(top, s0)
    ax = unit(Fc[1] - n0 * (Fc[1] @ n0))
    conn = s0 + n0 * 0.017
    v, q = mesh([(sdf.Disc(conn, ax, 0.015, 0.025, 0.005), 0.0, "union"),
                 (sdf.Disc(conn + ax * 0.012, ax, 0.0162, 0.0045, 0.0015), 0.002, "union")], 0.0009, smooth=2)
    out.append(dict(name="Hose_Disconnect", v=v, q=q, mat="cuff", bone=None))
    v, q = sweep(ring(conn - ax * 0.004, ax, 0.0158, 40), 0.0014, n=6, step=0.002)
    out.append(dict(name="Hose_Clip", v=v, q=q, mat="steel", bone=None))
    # mask hose: drops from the mask, swings a little to the right and back to the disconnect
    p0, d0 = helmet.mask_outlet(C, M)
    a = conn + ax * 0.024
    m1 = on(top, j, F, "chest", -0.022, 0.66, Fc[2], 0.019)
    path = sdf.spline([p0, p0 + d0 * 0.03, m1, a + ax * 0.045, a], 12)
    path = push_out(path, top, 0.0145)
    v, q = sweep(path, 0.0125, n=16, amp=0.0011, pitch=0.007, step=0.001)
    out.append(dict(name="Hose_Mask", v=v, q=q, mat="hose", bone=None))
    v, q = sweep(helix(path[2:-2], 0.0157, 0.012, step=0.0008), 0.0021, n=6, step=0.0012)
    out.append(dict(name="Hose_MicCord", v=v, q=q, mat="cable", bone=None))
    # BGHA: down and to the left across the jacket front and the belly into the PEC elbow
    R = F["thigh.L"]
    b0 = conn - ax * 0.024
    pts = [b0, b0 - ax * 0.035,
           on(top, j, F, "spine", 0.035, 0.58, Fs[2], 0.013),
           on(allb, j, F, "pelvis", 0.080, 0.62, unit(Fp[2] + Fp[0] * 0.3), 0.012),
           on(allb, j, F, "thigh.L", 0.030, 0.06, unit(R[2] + R[0] * 0.5), 0.016),
           pec["elbow"] + pec["elbow_dir"] * 0.040, pec["elbow"]]
    path = push_out(sdf.spline(pts, 12), allb, 0.0105)
    v, q = sweep(path, 0.009, n=14, amp=0.0008, pitch=0.0065, step=0.001)
    out.append(dict(name="Hose_BGHA", v=v, q=q, mat="hose_teal", bone=None))
    # anti-G hose: from the trousers' port on the left hip into the PEC's upper front end
    g0 = on(fb, j, F, "pelvis", 0.120, 0.30, unit(Fp[2] + Fp[0] * 0.9), 0.004)
    gn = normal(fb, g0)
    path = sdf.spline([g0, g0 + gn * 0.025 - Fp[1] * 0.02, pec["front"] + pec["front_dir"] * 0.035, pec["front"]], 12)
    v, q = sweep(push_out(path, fb, 0.010), 0.0095, n=12, amp=0.0007, pitch=0.007, step=0.001)
    out.append(dict(name="Hose_AntiG", v=v, q=q, mat="hose_olive", bone=None))
    # helmet cable
    c0, cd = helmet.cable_exit(C, M)
    pts = [c0, c0 + cd * 0.04,
           on(top, j, F, "neck", 0.050, 0.40, unit(-Fn[2] + Fn[0] * 0.8 + Fn[1] * 0.5), 0.006),
           on(top, j, F, "chest", 0.130, 1.00, Fc[1], 0.006),
           on(top, j, F, "chest", 0.145, 0.74, unit(Fc[2] + Fc[0] * 0.45), 0.006),
           on(top, j, F, "chest", 0.150, 0.30, unit(Fc[2] + Fc[0] * 0.55), 0.006),
           on(top, j, F, "spine", 0.130, 0.40, unit(Fs[2] + Fs[0] * 0.6), 0.006),
           on(allb, j, F, "pelvis", 0.125, 0.45, unit(Fp[2] + Fp[0] * 0.6), 0.006),
           pec["top"] + pec["d"] * 0.040, pec["top"]]
    path = push_out(sdf.spline(pts, 10), allb, 0.0055)
    v, q = sweep(path, 0.0045, n=10, step=0.003)
    out.append(dict(name="Helmet_Cable", v=v, q=q, mat="cable", bone=None))
    return out


# ----------------------------------------------------------------------------------- seat harness
def seat_harness_parts(j, F, base):
    """The seat's harness as the strapped-in pilot wears it: shoulder straps from the seat back
    over the shoulders and the LPU lobes, lap straps from the bucket sides, all into the
    quick-release box on the lap; adjusters on the upper chest."""
    Fc, Fs, Fp = F["chest"], F["spine"], F["pelvis"]
    out = []
    qp = surface(base, place(j, F, "pelvis", 0.0, 0.52, 0.0), Fp[2])
    qn = normal(base, qp)
    Rq = tangent_frame(qn, Fp[1])
    qc = qp + qn * 0.017
    straps, adj = [], []
    for sg in (1.0, -1.0):
        # over the top of the shoulder (on the LPU), from behind it to the front
        arc = []
        for th in np.linspace(-35.0, 70.0, 22):
            a = math.radians(th)
            t = 1.04 - 0.12 * (th / 80.0) ** 2
            arc.append(on(base, j, F, "chest", 0.080 * sg, t, Fc[1] * math.cos(a) + Fc[2] * math.sin(a), 0.003))
        # from the harness exit on the seat back, taut onto the shoulder
        s0 = arc[0] - Fc[2] * 0.10 - Fc[1] * 0.03
        back = [s0 + (arc[0] - s0) * u for u in np.linspace(0.0, 1.0, 8)[:-1]]
        # down the lobe, then straight across the belly into the buckle
        front = [on(base, j, F, "chest", (0.060 + 0.016 * (t - 0.08) / 0.8) * sg, t, Fc[2], 0.003)
                 for t in np.linspace(0.84, 0.08, 20)]
        e = qc + Rq[1] * 0.045 + Rq[0] * 0.022 * sg
        line = [front[-1] + (e - front[-1]) * u for u in np.linspace(0.0, 1.0, 12)[1:]]
        path = taut(np.array(back + arc + front + line), base, 0.0025, it=4, k=2)
        straps.append(ribbon(path, base, 0.043, 0.0022))
        # adjuster on the upper chest: black body, silver screw
        k = int(np.argmin(np.linalg.norm(path - front[1], axis=1)))
        pa = path[k]
        na = normal(base, pa)
        Ra = tangent_frame(na, path[k + 1] - path[k - 1])
        adj.append((sdf.RoundBox(pa + na * 0.004, (0.027, 0.022, 0.0045), 0.002, Ra), 0.0, "union"))
        pts = [on(base, j, F, "pelvis", 0.175 * sg, 0.12, unit(Fp[0] * sg - Fp[2] * 0.3), 0.003),
               on(base, j, F, "pelvis", 0.150 * sg, 0.30, unit(Fp[0] * sg + Fp[2] * 0.8), 0.003),
               on(base, j, F, "pelvis", 0.090 * sg, 0.45, unit(Fp[2] + Fp[0] * sg * 0.4), 0.003),
               qc + Rq[0] * 0.052 * sg - Rq[1] * 0.012]
        path = taut(sdf.spline(pts, 10), base, 0.0025)
        straps.append(ribbon(path, base, 0.043, 0.0022))
    v, q = merge(*straps)
    out.append(dict(name="Harness_Straps", v=v, q=q, mat="harness_seat", bone=None))
    v, q = mesh(adj, 0.0008, smooth=1)
    out.append(dict(name="Harness_Adjusters", v=v, q=q, mat="black", bone=None))
    ops = [(sdf.RoundBox(qc, (0.050, 0.040, 0.014), 0.012, Rq), 0.0, "union"),
           (sdf.Disc(qc + qn * 0.016, qn, 0.024, 0.004, 0.002), 0.002, "sub")]
    v, q = mesh(ops, 0.0012, smooth=2)
    out.append(dict(name="Harness_QRB", v=v, q=q, mat="dark_metal", bone=None))
    ops = [(sdf.Disc(qc + qn * 0.013, qn, 0.021, 0.004, 0.0015), 0.0, "union"),
           (sdf.RoundBox(qc + qn * 0.017, (0.014, 0.003, 0.0025), 0.0015, Rq), 0.001, "union")]
    v, q = mesh(ops, 0.0007, smooth=1)
    out.append(dict(name="Harness_Release", v=v, q=q, mat="steel_brushed", bone=None))
    return out


# ----------------------------------------------------------------------------------- suit details
def suit_detail_parts(j, F, arms, fb):
    out = []
    # the coverall's collar standing round the neck inside the LPU roll
    na, nb = j["neck"], j["head"]
    neck = sdf.RoundCone(na, nb, 0.061, 0.055)
    c = na + F["neck"][1] * 0.030
    ops = [(sdf.Offset(neck, 0.010), 0.0, "union"), (sdf.Offset(neck, 0.004), 0.0, "sub"),
           (sdf.Tube(ring(c, F["neck"][1], 0.068), 0.022, band=0.02), 0.002, "inter"),
           (side(c - F["neck"][2] * 0.075, -F["neck"][2] + F["neck"][1] * 0.6), 0.004, "sub")]
    v, q = mesh(ops, 0.0025, smooth=2, lo=c - 0.12, hi=c + 0.12)
    out.append(dict(name="Suit_Collar", v=v, q=q, mat="suit", bone=None))
    # tablet kneeboard on the right thigh: a black board holding a tablet, on an elastic strap
    R = F["thigh.R"]
    p = on(fb, j, F, "thigh.R", 0.0, 0.58, R[2])
    ops = [(sdf.RoundBox(p + R[2] * 0.0085, (0.088, 0.128, 0.0065), 0.004, R), 0.0, "union"),
           (sdf.RoundBox(p + R[2] * 0.0160, (0.074, 0.110, 0.0016), 0.003, R), 0.002, "union")]
    v, q = mesh(ops, 0.0014, smooth=1)
    out.append(dict(name="Kneeboard", v=v, q=q, mat="kneeboard", bone="thigh.R"))
    # the glass: a flat sheet just proud of the tablet's face (0.0176)
    v, q = flat_grid(p + R[2] * 0.0180, R[0], R[1], 0.066, 0.100, 4, 6, R[2])
    rel = v - p
    # screen UVs as the seated pilot reads it: u to the pilot's right, v (up) towards the knee
    uv = np.c_[0.5 + (rel @ -R[0]) / 0.132, 0.5 + (rel @ R[1]) / 0.200]
    out.append(dict(name="Kneeboard_Screen", v=v, q=q, mat="screen", bone="thigh.R", uv=uv))
    v, q = band(fb, around(fb, j, F, "thigh.R", 0.44), 0.032, thick=0.003, h=0.002)
    out.append(dict(name="Kneeboard_Strap", v=v, q=q, mat="webbing_black", bone=None))
    # wrist watch on the left forearm over the jacket sleeve, just above the glove's gauntlet
    sl = sdf.Offset(arms["L"], JACKET_T)
    Rf = F["forearm.L"]
    o = place(j, F, "forearm.L", 0.0, 0.66, 0.0)
    d = Rf[0]                                   # back of the left wrist (standing: palm faces in)
    p = surface(sl, o, d)
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
    v, q = band(sl, around(sl, j, F, "forearm.L", 0.66), 0.018, thick=0.003, h=0.0012)
    out.append(dict(name="Watch_Band", v=v, q=q, mat="steel_brushed", bone="forearm.L"))
    # the dial: a flat disc under the bezel (top of the case at 0.0090)
    v, q = flat_grid(p + d * 0.0090, right, up, 0.0155, 0.0155, 12, 12, d, disc=True)
    rel = v - p
    uv = np.c_[0.5 + (rel @ right) / 0.031, 0.5 + (rel @ up) / 0.031]
    out.append(dict(name="Watch_Face", v=v, q=q, mat="watch_face", bone="forearm.L", uv=uv))
    return out


def parts(j, F, cable_end=None, seat_harness=False, timings=None):
    """All the gear for joints j / frames F.  seat_harness: the seat's straps (cockpit only);
    cable_end: where the PEC's lead plugs into the seat."""
    import time
    tm = timings if timings is not None else {}
    t = time.time()
    torso, arms, legs = lofts(j, F)
    jb, tf = jacket_fields(j, F, torso, arms)
    out, extra = jacket_parts(j, F, jb, tf, arms)
    tm["jacket"] = round(time.time() - t, 1)
    t = time.time()
    lp, lpu = lpu_parts(j, F, jb)
    tm["lpu"] = round(time.time() - t, 1)
    t = time.time()
    fc, fb = fcags_parts(j, F, torso, legs)
    tm["fcags"] = round(time.time() - t, 1)
    t = time.time()
    pp, pec = pec_parts(j, F, fb, sdf.Offset(legs["L"], FCAGS_T), cable_end)
    top = sdf.Union([jb, lpu] + extra)
    out += lp + fc + pp + hose_parts(j, F, top, fb, pec)
    tm["pec_hoses"] = round(time.time() - t, 1)
    t = time.time()
    out += suit_detail_parts(j, F, arms, fb)
    if seat_harness:
        out += seat_harness_parts(j, F, sdf.Union([top, fb]))
    tm["details"] = round(time.time() - t, 1)
    return out
