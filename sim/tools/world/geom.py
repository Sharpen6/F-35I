"""Small 2D geometry helpers for the world builders (numpy only).

Rings are (n, 2) float64 arrays of world X, Z (metres, sim/DESIGN.md), not closed (the first
vertex is not repeated). Orientation: the signed area of a ring in X/Z,
    A = 0.5 * sum(x_i * z_{i+1} - x_{i+1} * z_i),
is negative for a ring that runs counter-clockwise on a north-up map (X east, Z = -north).
Outer rings are stored with A < 0 and holes with A > 0; for both, the outward normal of the
wall from p_i to p_{i+1} (pointing away from the building's material) is (-dz, dx) / |d|.
"""
import math
import struct

import numpy as np


# ---- WKB --------------------------------------------------------------------------------------

def wkb_polygons(b):
    """Polygons of a 2D WKB Polygon / MultiPolygon (other types: []): [[ring (n, 2) lon/lat, ...], ...]."""
    out = []

    def rd(o):
        bo = '<' if b[o] == 1 else '>'
        t = struct.unpack_from(bo + 'I', b, o + 1)[0]
        # ISO WKB: 1000s digit 0 = XY, 1 = XYZ, 2 = XYM, 3 = XYZM; EWKB: Z / M flag bits
        dim = 2 + (1 if t & 0x80000000 else 0) + (1 if t & 0x40000000 else 0)
        t &= 0x0FFFFFFF
        dim += {0: 0, 1: 1, 2: 1, 3: 2}.get(t // 1000, 0)
        t %= 1000
        o += 5
        if t == 3:
            nr = struct.unpack_from(bo + 'I', b, o)[0]
            o += 4
            rings = []
            for _ in range(nr):
                n = struct.unpack_from(bo + 'I', b, o)[0]
                a = np.frombuffer(b, bo + 'f8', dim * n, o + 4).reshape(n, dim)[:, :2]
                rings.append(a)
                o += 4 + 8 * dim * n
            out.append(rings)
            return o
        if t in (6, 7):
            n = struct.unpack_from(bo + 'I', b, o)[0]
            o += 4
            for _ in range(n):
                o = rd(o)
            return o
        return len(b)    # points / lines: ignored

    rd(0)
    return out


# ---- rings ------------------------------------------------------------------------------------

def signed_area(r):
    x, z = r[:, 0], r[:, 1]
    return 0.5 * float(np.dot(x, np.roll(z, -1)) - np.dot(np.roll(x, -1), z))


def centroid(r):
    """Area centroid of a ring (falls back to the vertex mean for degenerate rings)."""
    x, z = r[:, 0], r[:, 1]
    x1, z1 = np.roll(x, -1), np.roll(z, -1)
    c = x * z1 - x1 * z
    a = c.sum() * 0.5
    if abs(a) < 1e-9:
        return float(x.mean()), float(z.mean())
    return float(((x + x1) * c).sum() / (6 * a)), float(((z + z1) * c).sum() / (6 * a))


def _dp(pts, tol):
    """Douglas-Peucker on an open polyline; returns the kept indices (first and last included)."""
    n = len(pts)
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        a, b = pts[i], pts[j]
        d = b - a
        L = math.hypot(d[0], d[1])
        seg = pts[i + 1:j] - a
        if L < 1e-9:
            dist = np.hypot(seg[:, 0], seg[:, 1])
        else:
            dist = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return np.nonzero(keep)[0]


def clean_ring(r, tol=0.5, min_edge=0.25):
    """Drop the closing vertex and duplicates, simplify (Douglas-Peucker, tol metres) and remove
    nearly collinear vertices. Orientation is kept. Returns None if fewer than 3 vertices remain."""
    if len(r) > 1 and np.allclose(r[0], r[-1]):
        r = r[:-1]
    if len(r) < 3:
        return None
    # consecutive duplicates
    d = np.hypot(*(np.roll(r, -1, 0) - r).T)
    r = r[d > 1e-3]
    if len(r) < 3:
        return None
    if len(r) > 4 and tol > 0:
        # split the closed ring at the vertex farthest from vertex 0, simplify both halves
        dd = np.hypot(*(r - r[0]).T)
        f = int(np.argmax(dd))
        a = r[:f + 1]
        b = np.vstack([r[f:], r[:1]])
        ka = _dp(a, tol)
        kb = _dp(b, tol)
        r = np.vstack([a[ka[:-1]], b[kb[:-1]]])
    # nearly collinear vertices and very short edges (repeat: removing one can expose another)
    for _ in range(4):
        if len(r) < 3:
            return None
        p, nx = np.roll(r, 1, 0), np.roll(r, -1, 0)
        e1, e2 = r - p, nx - r
        l1, l2 = np.hypot(*e1.T), np.hypot(*e2.T)
        cross = np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])
        # deviation of the vertex from the line p -> nx
        base = np.hypot(*(nx - p).T)
        dev = cross / np.maximum(base, 1e-9)
        drop = (dev < 0.08) | (l1 < min_edge)
        if not drop.any():
            break
        if drop.all():
            return None
        # never drop two neighbours at once (keeps the shape stable)
        idx = np.nonzero(drop)[0]
        keep = np.ones(len(r), bool)
        last = -10
        for i in idx:
            if i != last + 1:
                keep[i] = False
                last = i
        r = r[keep]
    if len(r) < 3:
        return None
    return r


def obb(r):
    """Minimum-area oriented box of a ring: (cx, cz, half_a, half_b, angle) with a >= b; angle is
    the direction of the long side 'a' from +X towards +Z, in [0, pi)."""
    pts = r
    e = np.roll(pts, -1, 0) - pts
    L = np.hypot(e[:, 0], e[:, 1])
    ang = np.arctan2(e[:, 1], e[:, 0])[L > 1e-6] % (math.pi / 2)
    if ang.size == 0:
        ang = np.array([0.0])
    ang = np.unique(np.round(ang, 4))
    c, s = np.cos(ang), np.sin(ang)
    u = pts[:, 0][None, :] * c[:, None] + pts[:, 1][None, :] * s[:, None]
    v = -pts[:, 0][None, :] * s[:, None] + pts[:, 1][None, :] * c[:, None]
    du = u.max(1) - u.min(1)
    dv = v.max(1) - v.min(1)
    k = int(np.argmin(du * dv))
    a0 = float(ang[k])
    umid = 0.5 * (u[k].max() + u[k].min())
    vmid = 0.5 * (v[k].max() + v[k].min())
    cx = umid * math.cos(a0) - vmid * math.sin(a0)
    cz = umid * math.sin(a0) + vmid * math.cos(a0)
    ha, hb = 0.5 * float(du[k]), 0.5 * float(dv[k])
    if hb > ha:
        ha, hb = hb, ha
        a0 += math.pi / 2
    return cx, cz, ha, hb, a0 % math.pi


def points_in_ring(px, pz, r):
    """Even-odd point-in-polygon for arrays of points against one ring."""
    x, z = r[:, 0], r[:, 1]
    x1, z1 = np.roll(x, -1), np.roll(z, -1)
    inside = np.zeros(px.shape, bool)
    for i in range(len(x)):
        a, b = z[i], z1[i]
        cond = (a > pz) != (b > pz)
        if not cond.any():
            continue
        xc = x[i] + (pz - a) * (x1[i] - x[i]) / np.where(b - a == 0, 1e-12, b - a)
        inside ^= cond & (px < xc)
    return inside


def points_in_polygon(px, pz, rings):
    """Points inside the outer ring and outside the holes."""
    ins = points_in_ring(px, pz, rings[0])
    for h in rings[1:]:
        ins &= ~points_in_ring(px, pz, h)
    return ins


def segment_distance(px, pz, ax, az, bx, bz):
    """Distance from points to a segment."""
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    t = np.clip(((px - ax) * dx + (pz - az) * dz) / (L2 if L2 > 0 else 1.0), 0.0, 1.0)
    return np.hypot(px - (ax + t * dx), pz - (az + t * dz))
