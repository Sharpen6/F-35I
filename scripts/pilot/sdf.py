"""Signed-distance modelling for the pilot: smooth unions of simple solids evaluated on a grid,
turned into a quad mesh by surface nets and smoothed.  Pure numpy, no Blender needed.

A Field covers a box with a regular grid.  Each solid only touches the grid cells inside its own
bounding box (plus the blend radius), so a body made of a hundred solids stays fast.

    f = Field(lo, hi, h=0.004)
    f.add(RoundCone(a, b, 0.05, 0.04), k=0.02)          # smooth union, blend radius k
    f.add(Ellipsoid(c, (0.1, 0.05, 0.08), R), k=0.01, op="sub")
    verts, quads = f.mesh(smooth=6)

Distances are in metres.  Inside is negative.
"""
import numpy as np


# --------------------------------------------------------------------------------- blending
def smin(a, b, k):
    """Polynomial smooth minimum (union) with blend radius k."""
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b + (a - b) * h - k * h * (1.0 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def _frame(R):
    """3x3 rotation (rows = local X, Y, Z axes in world) or None."""
    return None if R is None else np.asarray(R, dtype=np.float64)


def _local(P, c, R):
    """World points P (..., 3) to the local frame of a solid centred at c with axes R (rows)."""
    q = P - c
    if R is None:
        return q
    return q @ R.T


# --------------------------------------------------------------------------------- solids
class Solid:
    """Base: `dist(P)` for points P (..., 3); `aabb()` -> (lo, hi) world bounds of the solid."""
    def aabb(self):
        raise NotImplementedError

    def dist(self, P):
        raise NotImplementedError


class Sphere(Solid):
    def __init__(self, c, r):
        self.c, self.r = np.asarray(c, float), float(r)

    def aabb(self):
        return self.c - self.r, self.c + self.r

    def dist(self, P):
        return np.linalg.norm(P - self.c, axis=-1) - self.r


class RoundCone(Solid):
    """Capsule from a (radius ra) to b (radius rb), exact distance (i. quilez)."""
    def __init__(self, a, b, ra, rb):
        self.a, self.b = np.asarray(a, float), np.asarray(b, float)
        self.ra, self.rb = float(ra), float(rb)

    def aabb(self):
        r = max(self.ra, self.rb)
        return np.minimum(self.a, self.b) - r, np.maximum(self.a, self.b) + r

    def dist(self, P):
        a, b, r1, r2 = self.a, self.b, self.ra, self.rb
        ba = b - a
        l2 = float(ba @ ba)
        if l2 < 1e-12:
            return np.linalg.norm(P - a, axis=-1) - max(r1, r2)
        rr = r1 - r2
        a2 = l2 - rr * rr
        il2 = 1.0 / l2
        pa = P - a
        y = pa @ ba
        z = y - l2
        x = pa * l2 - y[..., None] * ba
        x2 = (x * x).sum(-1)
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        out = (np.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1
        m1 = np.sign(z) * a2 * z2 > k
        m2 = np.sign(y) * a2 * y2 < k
        out = np.where(m1, np.sqrt(x2 + z2) * il2 - r2, out)
        out = np.where(~m1 & m2, np.sqrt(x2 + y2) * il2 - r1, out)
        return out


class Ellipsoid(Solid):
    """Ellipsoid with semi-axes r (local X, Y, Z), centre c, axes R (rows); bound-correct
    approximation (exact on the axes)."""
    def __init__(self, c, r, R=None):
        self.c, self.r, self.R = np.asarray(c, float), np.asarray(r, float), _frame(R)

    def aabb(self):
        if self.R is None:
            e = self.r
        else:
            e = np.sqrt(((self.R.T * self.r[None, :]) ** 2).sum(1))
        return self.c - e, self.c + e

    def dist(self, P):
        q = _local(P, self.c, self.R)
        k0 = np.linalg.norm(q / self.r, axis=-1)
        k1 = np.linalg.norm(q / (self.r * self.r), axis=-1)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


class RoundBox(Solid):
    """Box with half sizes s (local), edges rounded by radius rr (included in s)."""
    def __init__(self, c, s, rr, R=None):
        self.c, self.s, self.rr, self.R = np.asarray(c, float), np.asarray(s, float), float(rr), _frame(R)

    def aabb(self):
        e = self.s if self.R is None else np.sqrt(((self.R.T * self.s[None, :]) ** 2).sum(1))
        return self.c - e, self.c + e

    def dist(self, P):
        q = np.abs(_local(P, self.c, self.R)) - (self.s - self.rr)
        out = np.linalg.norm(np.maximum(q, 0.0), axis=-1) + np.minimum(q.max(-1), 0.0)
        return out - self.rr


class SuperEllipsoid(Solid):
    """Rounded-box-like solid |x/a|^n + |y/b|^n + |z/c|^n = 1 with separate front/back and
    top/bottom semi-axes: r = (x, y_neg, y_pos, z_neg, z_pos).  Distance is the implicit value
    scaled by the smallest semi-axis (good near the surface, which is all surface nets need)."""
    def __init__(self, c, r, n=2.5, R=None):
        self.c, self.r, self.n, self.R = np.asarray(c, float), np.asarray(r, float), float(n), _frame(R)

    def aabb(self):
        x, yn, yp, zn, zp = self.r
        lo_l, hi_l = np.array([-x, -yn, -zn]), np.array([x, yp, zp])
        if self.R is None:
            return self.c + lo_l, self.c + hi_l
        corners = np.array([[a, b, c] for a in (lo_l[0], hi_l[0]) for b in (lo_l[1], hi_l[1])
                            for c in (lo_l[2], hi_l[2])]) @ self.R
        return self.c + corners.min(0), self.c + corners.max(0)

    def dist(self, P):
        q = _local(P, self.c, self.R)
        x, yn, yp, zn, zp = self.r
        ax = np.full(q.shape[:-1], x)
        ay = np.where(q[..., 1] < 0, yn, yp)
        az = np.where(q[..., 2] < 0, zn, zp)
        n = self.n
        s = (np.abs(q[..., 0] / ax) ** n + np.abs(q[..., 1] / ay) ** n + np.abs(q[..., 2] / az) ** n) ** (1.0 / n)
        # distance-like: (s - 1) times the local radius along the ray
        rad = np.linalg.norm(q, axis=-1) / np.maximum(s, 1e-9)     # centre-to-surface along the ray
        return (s - 1.0) * rad


def _cap(d, c, rr):
    """Intersect a field with a cap half-space (c > 0 outside); rr > 0 rounds the edge."""
    if rr <= 0.0:
        return np.maximum(d, c)
    a, b = d + rr, c + rr
    return np.minimum(np.maximum(a, b), 0.0) + np.sqrt(np.maximum(a, 0.0) ** 2 + np.maximum(b, 0.0) ** 2) - rr


class Loft(Solid):
    """Superelliptic cross-sections swept along a smooth axis: torso, limbs, boots.

    stations: list of dicts with
        p      point on the axis (world)
        Z      'front' direction of the section (anterior; for a foot: up)
        w      half width (along X = Y x Z, flipped to agree with `left` when given)
        f, b   half depth to the front (+Z) and to the back (-Z)
        n      superellipse exponent (2 = ellipse, larger = boxier)
        x0, z0 shift of the section centre from the axis along X and Z
    The stations are interpolated with Catmull-Rom splines (axis, directions and section sizes)
    into `sub` pieces per span; each piece is straight with linearly varying sections and meets its
    neighbours on the bisector planes (mitred), so bends leave no gaps and no visible rings.
    round0 / round1 round off the first / last end (0 = flat cut)."""
    KEYS = ("w", "f", "b", "n", "x0", "z0")

    def __init__(self, stations, round0=0.0, round1=0.0, left=None, sub=4, band=0.05, overlap=0.0):
        st = []
        for s in stations:
            d = {"n": 2.0, "x0": 0.0, "z0": 0.0}
            d.update(s)
            d["p"] = np.asarray(d["p"], float)
            d["Z"] = np.asarray(d["Z"], float)
            st.append(d)
        self.st = _densify(st, sub) if sub > 1 and len(st) > 2 else st
        self.round0, self.round1, self.band = float(round0), float(round1), float(band)
        self.overlap = float(overlap)
        self.left = None if left is None else np.asarray(left, float)
        self.seg = []
        P = [s["p"] for s in self.st]
        dirs = [P[i + 1] - P[i] for i in range(len(P) - 1)]
        dirs = [d / max(np.linalg.norm(d), 1e-12) for d in dirs]
        self.end0, self.end1 = dirs[0], dirs[-1]
        for i in range(len(P) - 1):
            Y = dirs[i]
            n0 = Y if i == 0 else (dirs[i - 1] + Y) / max(np.linalg.norm(dirs[i - 1] + Y), 1e-9)
            n1 = Y if i == len(P) - 2 else (Y + dirs[i + 1]) / max(np.linalg.norm(Y + dirs[i + 1]), 1e-9)
            Zm = self.st[i]["Z"] + self.st[i + 1]["Z"]
            Z = Zm - Y * (Zm @ Y)
            Z /= max(np.linalg.norm(Z), 1e-12)
            X = np.cross(Y, Z)
            if self.left is not None and X @ self.left < 0:
                X = -X
            s0, s1 = self.st[i], self.st[i + 1]
            r = max(max(s[k] for k in ("w", "f", "b")) + abs(s["x0"]) + abs(s["z0"]) for s in (s0, s1))
            lo = np.minimum(s0["p"], s1["p"]) - r - self.band
            hi = np.maximum(s0["p"], s1["p"]) + r + self.band
            self.seg.append(dict(a=P[i], b=P[i + 1], L=float(np.linalg.norm(P[i + 1] - P[i])), X=X, Y=Y, Z=Z,
                                 n0=n0, n1=n1, s0=s0, s1=s1, lo=lo, hi=hi,
                                 first=(i == 0), last=(i == len(P) - 2),
                                 r0=self.round0 if i == 0 else 0.0,
                                 r1=self.round1 if i == len(P) - 2 else 0.0))

    def aabb(self):
        lo = np.min([g["lo"] for g in self.seg], axis=0) + self.band
        hi = np.max([g["hi"] for g in self.seg], axis=0) - self.band
        return lo, hi

    def dist(self, P):
        shp = P.shape[:-1]
        Q = P.reshape(-1, 3)
        out = np.full(len(Q), self.band, np.float64)
        for g in self.seg:
            m = np.nonzero(((Q >= g["lo"]) & (Q <= g["hi"])).all(1))[0]
            if not len(m):
                continue
            Pm = Q[m]
            q = Pm - g["a"]
            y = q @ g["Y"]
            u = np.clip(y / max(g["L"], 1e-9), 0.0, 1.0)
            prm = {k: g["s0"][k] + (g["s1"][k] - g["s0"][k]) * u for k in self.KEYS}
            x = q @ g["X"] - prm["x0"]
            z = q @ g["Z"] - prm["z0"]
            dz = np.where(z >= 0.0, prm["f"], prm["b"])
            n = prm["n"]
            s = (np.abs(x / prm["w"]) ** n + np.abs(z / dz) ** n) ** (1.0 / n)
            r2 = np.sqrt(x * x + z * z)
            rad = np.where(s > 1e-9, r2 / np.maximum(s, 1e-9), np.minimum(prm["w"], dz))
            d2 = (s - 1.0) * rad
            # each piece owns the slab between its mitre planes and gives the section distance
            # there; outside its slab it gives nothing.  (Capping a piece with its inner mitre
            # planes instead makes those internal faces count as surface: the zero level set is
            # the same, but offsets of it, e.g. a garment over the body, get a sawtooth.)
            c0 = -(q @ g["n0"]) - (0.0 if g["first"] else self.overlap)
            c1 = (Pm - g["b"]) @ g["n1"] - (0.0 if g["last"] else self.overlap)
            d = d2
            if not g["first"]:
                d = np.where(c0 > 0.0, np.inf, d)
            if not g["last"]:
                d = np.where(c1 > 0.0, np.inf, d)
            # the two real ends: flat cut or rounded, measured from the end planes so a rounding
            # longer than one piece still runs smoothly over several pieces
            d = _cap(d, -((Pm - self.st[0]["p"]) @ self.end0), self.round0)
            d = _cap(d, (Pm - self.st[-1]["p"]) @ self.end1, self.round1)
            out[m] = np.minimum(out[m], d)
        return out.reshape(shp)


def _cr(p0, p1, p2, p3, u):
    """Catmull-Rom between p1 and p2."""
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u +
                  (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)


def _densify(st, sub):
    """Stations spline-interpolated `sub` times per span (ends extrapolated linearly)."""
    n = len(st)

    def get(i, key):
        if 0 <= i < n:
            return st[i][key]
        a, b = (st[0], st[1]) if i < 0 else (st[-1], st[-2])
        return 2 * a[key] - b[key]
    out = []
    for i in range(n - 1):
        for k in range(sub):
            u = k / sub
            d = {}
            for key in ("p", "Z") + Loft.KEYS:
                d[key] = _cr(get(i - 1, key), get(i, key), get(i + 1, key), get(i + 2, key), u)
            d["Z"] = d["Z"] / max(np.linalg.norm(d["Z"]), 1e-12)
            for key in ("w", "f", "b"):
                d[key] = max(d[key], 1e-4)
            d["n"] = max(d["n"], 1.2)
            out.append(d)
    out.append(dict(st[-1]))
    return out


class Sampled(Solid):
    """A precomputed Field used as a solid (trilinear samples): cheap to query many times."""
    def __init__(self, field, outside=0.05):
        self.f, self.outside = field, float(outside)

    def aabb(self):
        return self.f.lo.copy(), self.f.lo + self.f.h * (self.f.n - 1)

    def dist(self, P):
        shp = P.shape[:-1]
        Q = P.reshape(-1, 3)
        lo, hi = self.aabb()
        m = ((Q >= lo) & (Q <= hi)).all(1)
        out = np.full(len(Q), self.outside)
        if m.any():
            out[m] = self.f.sample(Q[m])
        return out.reshape(shp)


def sampled(solid, h=0.005, pad=0.04):
    """Evaluate a solid once on a grid and wrap it as a Sampled solid."""
    lo, hi = solid.aabb()
    f = Field(lo - pad, hi + pad, h)
    f.add(solid, 0.0)
    return Sampled(f)


class Offset(Solid):
    """Solid s grown by t (shrunk if t < 0)."""
    def __init__(self, s, t):
        self.s, self.t = s, float(t)

    def aabb(self):
        lo, hi = self.s.aabb()
        return lo - max(self.t, 0.0), hi + max(self.t, 0.0)

    def dist(self, P):
        return self.s.dist(P) - self.t


class Union(Solid):
    """Smooth union of solids (blend radius k), evaluated as one solid."""
    def __init__(self, solids, k=0.0):
        self.solids, self.k = list(solids), float(k)

    def aabb(self):
        lo = np.min([s.aabb()[0] for s in self.solids], axis=0) - self.k
        hi = np.max([s.aabb()[1] for s in self.solids], axis=0) + self.k
        return lo, hi

    def dist(self, P):
        d = None
        for s in self.solids:
            di = s.dist(P)
            d = di if d is None else smin(d, di, self.k)
        return d


class Tube(Solid):
    """A tube along a polyline: radius per point (interpolated), optional corrugation
    (radius + amp * sin(2 pi s / pitch), s = arc length).  Union of capsule pieces."""
    def __init__(self, pts, radii, amp=0.0, pitch=0.01, band=0.02):
        self.p = np.asarray(pts, float)
        r = np.asarray(radii, float)
        self.r = np.full(len(self.p), float(r)) if r.ndim == 0 else r
        seg = np.linalg.norm(np.diff(self.p, axis=0), axis=1)
        self.s = np.r_[0.0, np.cumsum(seg)]
        self.amp, self.pitch, self.band = float(amp), float(pitch), float(band)

    def aabb(self):
        m = self.r.max() + self.amp
        return self.p.min(0) - m, self.p.max(0) + m

    def dist(self, P):
        shp = P.shape[:-1]
        Q = P.reshape(-1, 3)
        out = np.full(len(Q), self.band)
        m = self.r.max() + self.amp + self.band
        for i in range(len(self.p) - 1):
            a, b = self.p[i], self.p[i + 1]
            lo, hi = np.minimum(a, b) - m, np.maximum(a, b) + m
            idx = np.nonzero(((Q >= lo) & (Q <= hi)).all(1))[0]
            if not len(idx):
                continue
            q = Q[idx]
            ab = b - a
            L2 = max(float(ab @ ab), 1e-12)
            t = np.clip(((q - a) @ ab) / L2, 0.0, 1.0)
            c = a + t[:, None] * ab
            r = self.r[i] + (self.r[i + 1] - self.r[i]) * t
            if self.amp:
                s = self.s[i] + (self.s[i + 1] - self.s[i]) * t
                r = r + self.amp * np.sin(2 * np.pi * s / self.pitch)
            d = np.linalg.norm(q - c, axis=1) - r
            out[idx] = np.minimum(out[idx], d)
        return out.reshape(shp)


def bezier(p0, p1, p2, p3, n=40):
    """Points of a cubic Bezier curve."""
    t = np.linspace(0.0, 1.0, n)[:, None]
    p0, p1, p2, p3 = (np.asarray(x, float) for x in (p0, p1, p2, p3))
    return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3


def spline(points, n_per=12):
    """Catmull-Rom curve through points (ends extended linearly)."""
    P = [np.asarray(p, float) for p in points]
    P = [2 * P[0] - P[1]] + P + [2 * P[-1] - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        for k in range(n_per):
            out.append(_cr(P[i - 1], P[i], P[i + 1], P[i + 2], k / n_per))
    out.append(P[-2])
    return np.array(out)


class Disc(Solid):
    """Capped cylinder: centre c, axis direction, radius R, half height H, edge rounding rr."""
    def __init__(self, c, axis, R, H, rr=0.0):
        self.c = np.asarray(c, float)
        a = np.asarray(axis, float)
        self.a = a / np.linalg.norm(a)
        self.R, self.H, self.rr = float(R), float(H), float(rr)

    def aabb(self):
        e = max(self.R, self.H)
        return self.c - e, self.c + e

    def dist(self, P):
        q = P - self.c
        y = q @ self.a
        x = np.linalg.norm(q - y[..., None] * self.a, axis=-1)
        dx = x - (self.R - self.rr)
        dy = np.abs(y) - (self.H - self.rr)
        return np.minimum(np.maximum(dx, dy), 0.0) + np.sqrt(np.maximum(dx, 0.0) ** 2 + np.maximum(dy, 0.0) ** 2) - self.rr


class Plane(Solid):
    """Half space n . (p - c) > 0 is outside (unbounded: give a box to limit its effect)."""
    def __init__(self, c, n, lo, hi):
        self.c, self.n = np.asarray(c, float), np.asarray(n, float) / np.linalg.norm(n)
        self.lo, self.hi = np.asarray(lo, float), np.asarray(hi, float)

    def aabb(self):
        return self.lo, self.hi

    def dist(self, P):
        return (P - self.c) @ self.n


class Custom(Solid):
    """Any distance function f(P) with given bounds."""
    def __init__(self, f, lo, hi):
        self.f, self.lo, self.hi = f, np.asarray(lo, float), np.asarray(hi, float)

    def aabb(self):
        return self.lo, self.hi

    def dist(self, P):
        return self.f(P)


# --------------------------------------------------------------------------------- the grid
class Field:
    def __init__(self, lo, hi, h):
        self.lo = np.asarray(lo, float)
        self.h = float(h)
        self.n = (np.ceil((np.asarray(hi, float) - self.lo) / h).astype(int) + 1)
        self.d = np.full(tuple(self.n), 1.0, np.float32)

    def _block(self, lo, hi):
        i0 = np.clip(np.floor((lo - self.lo) / self.h).astype(int), 0, self.n - 1)
        i1 = np.clip(np.ceil((hi - self.lo) / self.h).astype(int) + 1, 0, self.n)
        if np.any(i1 <= i0):
            return None, None
        sl = tuple(slice(a, b) for a, b in zip(i0, i1))
        ax = [self.lo[k] + self.h * np.arange(i0[k], i1[k]) for k in range(3)]
        P = np.stack(np.meshgrid(*ax, indexing="ij"), axis=-1)
        return sl, P

    def add(self, s, k=0.0, op="union", band=None):
        """Combine solid s with the field: op union | sub | inter; k = blend radius."""
        lo, hi = s.aabb()
        m = k + 2.0 * self.h + (band or 0.0)
        if op == "inter":                       # intersection touches everything
            lo, hi = self.lo, self.lo + self.h * (self.n - 1)
        sl, P = self._block(lo - m, hi + m)
        if sl is None:
            return
        di = s.dist(P).astype(np.float32)
        d = self.d[sl]
        if op == "union":
            self.d[sl] = smin(d, di, k)
        elif op == "sub":
            self.d[sl] = smax(d, -di, k)
        elif op == "inter":
            self.d[sl] = smax(d, di, k)
        else:
            raise ValueError(op)

    def offset(self, dd):
        self.d -= dd

    def apply(self, fn, lo=None, hi=None):
        """d = fn(P, d) inside a box (displacement, folds ...)."""
        lo = self.lo if lo is None else np.asarray(lo, float)
        hi = self.lo + self.h * (self.n - 1) if hi is None else np.asarray(hi, float)
        sl, P = self._block(lo, hi)
        if sl is None:
            return
        self.d[sl] = fn(P, self.d[sl]).astype(np.float32)

    def sample(self, P):
        """Trilinear value of the field at points P (N x 3)."""
        g = (np.asarray(P, float) - self.lo) / self.h
        i = np.clip(np.floor(g).astype(int), 0, self.n - 2)
        t = np.clip(g - i, 0.0, 1.0)
        d = self.d
        out = 0.0
        for cx in (0, 1):
            wx = t[:, 0] if cx else 1.0 - t[:, 0]
            for cy in (0, 1):
                wy = t[:, 1] if cy else 1.0 - t[:, 1]
                for cz in (0, 1):
                    wz = t[:, 2] if cz else 1.0 - t[:, 2]
                    out = out + wx * wy * wz * d[i[:, 0] + cx, i[:, 1] + cy, i[:, 2] + cz]
        return out

    def project(self, v, steps=2):
        """Move vertices onto the zero level of the trilinear field (Newton steps along the
        gradient): removes the terracing of the surface-nets vertex placement."""
        e = 0.5 * self.h
        for _ in range(steps):
            d = self.sample(v)
            g = np.stack([(self.sample(v + o) - self.sample(v - o)) / (2 * e)
                          for o in (np.array([e, 0, 0]), np.array([0, e, 0]), np.array([0, 0, e]))], axis=1)
            g2 = np.maximum((g * g).sum(1), 1e-6)
            step = (d / g2)[:, None] * g
            # never move further than half a cell (keeps the topology of the net)
            ln = np.linalg.norm(step, axis=1, keepdims=True)
            step = np.where(ln > 0.5 * self.h, step * (0.5 * self.h / np.maximum(ln, 1e-12)), step)
            v = v - step
        return v

    def mesh(self, smooth=4, lam=0.5, mu=-0.53, project=2):
        v, q = surface_nets(self.d, self.lo, self.h)
        if project and len(v):
            v = self.project(v, project)
        if smooth and len(v):
            v = taubin(v, q, smooth, lam, mu)
        return v, q


# --------------------------------------------------------------------------------- meshing
_CORNERS = np.array([[i, j, k] for i in (0, 1) for j in (0, 1) for k in (0, 1)])
_EDGES = [(a, b) for a in range(8) for b in range(a + 1, 8)
          if np.abs(_CORNERS[a] - _CORNERS[b]).sum() == 1]


def surface_nets(d, lo, h):
    """Naive surface nets: one vertex per cell the surface crosses (mean of the edge crossings),
    one quad per grid edge with a sign change.  Returns (verts N x 3, quads M x 4)."""
    nx, ny, nz = d.shape
    inside = d < 0
    c = [inside[i:nx - 1 + i, j:ny - 1 + j, k:nz - 1 + k] for i, j, k in _CORNERS]
    cnt = sum(x.astype(np.int8) for x in c)
    active = (cnt > 0) & (cnt < 8)
    idx = np.argwhere(active)
    if not len(idx):
        return np.zeros((0, 3)), np.zeros((0, 4), int)
    vid = np.full(active.shape, -1, np.int64)
    vid[tuple(idx.T)] = np.arange(len(idx))
    acc = np.zeros((len(idx), 3))
    num = np.zeros(len(idx))
    I, J, K = idx.T
    for a, b in _EDGES:
        ca, cb = _CORNERS[a], _CORNERS[b]
        da = d[I + ca[0], J + ca[1], K + ca[2]].astype(np.float64)
        db = d[I + cb[0], J + cb[1], K + cb[2]].astype(np.float64)
        m = (da < 0) != (db < 0)
        t = np.where(m, da / np.where(m, da - db, 1.0), 0.0)
        p = ca[None, :] + t[:, None] * (cb - ca)[None, :]
        acc += np.where(m[:, None], p, 0.0)
        num += m
    verts = lo + h * (idx + acc / np.maximum(num, 1)[:, None])
    quads = []
    # x edges: between (i,j,k) and (i+1,j,k); cells sharing it: (i, j-1|j, k-1|k)
    for axis in range(3):
        o = [0, 0, 0]
        o[axis] = 1
        a = inside[:nx - o[0], :ny - o[1], :nz - o[2]]
        b = inside[o[0]:, o[1]:, o[2]:]
        ch = a != b
        # the edge must have all four neighbouring cells inside the grid
        e = np.argwhere(ch)
        u, w = [ax for ax in range(3) if ax != axis]
        ok = (e[:, u] >= 1) & (e[:, w] >= 1) & (e[:, u] <= d.shape[u] - 2) & (e[:, w] <= d.shape[w] - 2) & \
             (e[:, axis] <= d.shape[axis] - 2)
        e = e[ok]
        if not len(e):
            continue
        flip = a[tuple(e.T)]                       # inside -> outside along +axis

        def cell(du, dw):
            g = e.copy()
            g[:, u] -= du
            g[:, w] -= dw
            return vid[tuple(g.T)]
        v00, v10, v11, v01 = cell(1, 1), cell(0, 1), cell(0, 0), cell(1, 0)
        q = np.stack([v00, v10, v11, v01], axis=1)
        # orientation: normals point outward (+axis when the start is inside)
        sgn = (axis == 1)
        q = np.where((flip ^ sgn)[:, None], q, q[:, ::-1])
        quads.append(q)
    quads = np.concatenate(quads) if quads else np.zeros((0, 4), int)
    quads = quads[(quads >= 0).all(1)]
    return verts, quads


def _adjacency(nv, quads):
    e = np.concatenate([quads[:, [0, 1]], quads[:, [1, 2]], quads[:, [2, 3]], quads[:, [3, 0]]])
    e = np.sort(e, axis=1)
    e = np.unique(e, axis=0)
    return e


def taubin(v, quads, it=4, lam=0.5, mu=-0.53):
    """Taubin smoothing (shrink-free Laplacian)."""
    e = _adjacency(len(v), quads)
    deg = np.bincount(e.ravel(), minlength=len(v)).astype(float)
    deg = np.maximum(deg, 1)
    v = v.copy()
    for _ in range(it):
        for f in (lam, mu):
            s = np.zeros_like(v)
            np.add.at(s, e[:, 0], v[e[:, 1]])
            np.add.at(s, e[:, 1], v[e[:, 0]])
            v += f * (s / deg[:, None] - v)
    return v
