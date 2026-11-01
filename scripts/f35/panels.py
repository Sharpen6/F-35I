"""Panel lines, fastener rows, door outlines and coating patches.

The skin has no UV map.  Instead every skin mesh stores where each of its
vertices sits with the aircraft at rest (``rest_p``, world position, point
domain) and the rest-pose face normal (``rest_n``, face domain).  Three
projection maps are painted here with numpy:

    top     (s, x)  seen from above
    bottom  (s, x)  seen from below
    side    (s, z)  right half (x < 0) in v = 0..0.5, left half in v = 0.5..1

and the skin shader (materials.skin_material) blends them by the rest normal.
Because the lookup uses the stored rest position, the lines stay glued to
doors, control surfaces and the canopy when they move, and to fragments when
parts break off.

Channels: R = panel line / fastener (darker, slight groove),
          G = sealant tape along sawtooth edges (darker band),
          B = lighter coating (radome, leading-edge strips, repair squares).

Everything is painted from the geometry: door and control-surface outlines
come from the real door meshes and hinge lines, authored lines are ray-cast
onto the skin, so every line lies exactly on the surface in all three maps.
The layout follows public photos of F-35A / F-35I aircraft (see
docs/research.md); it is representative, not a drawing of the real panel
breakdown.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .geom import Y0

# ------------------------------------------------------------------ map spec
S0, S1 = -0.20, 16.30          # station range
XMIN, XMAX = -5.70, 5.70       # span range (top / bottom)
Z0, Z1 = -1.25, 2.85           # height range (side)
RES = 0.003                    # metres per pixel
K = 4.0                        # projection blend sharpness (shader uses the same)

W = int(round((S1 - S0) / RES))
H_TB = int(round((XMAX - XMIN) / RES))
H_SIDE = 2 * int(round((Z1 - Z0) / RES))
MAPS = {"top": (W, H_TB), "bottom": (W, H_TB), "side": (W, H_SIDE)}
IMG_NAMES = {"top": "F35_Panels_Top", "bottom": "F35_Panels_Bottom", "side": "F35_Panels_Side"}
R, G, B = 0, 1, 2

LINE_W = 1.35                  # panel line width (px)
TAPE_W = 11.0                  # sealant tape band width along door outlines (px, ~3.3 cm; ref_03 4-5 cm)
FRAME_W = 21.0                 # RAM tape frames over the upper fuselage seams (px, ~6.3 cm)


def images():
    """Create (or fetch) the three map images; black = no detail."""
    out = {}
    for m, (w, h) in MAPS.items():
        img = bpy.data.images.get(IMG_NAMES[m])
        if img is None or tuple(img.size) != (w, h):
            if img is not None:
                bpy.data.images.remove(img)
            img = bpy.data.images.new(IMG_NAMES[m], w, h, alpha=False, float_buffer=False)
            img.generated_color = (0.0, 0.0, 0.0, 1.0)
        img.colorspace_settings.name = 'Non-Color'
        out[m] = img
    return out


# ------------------------------------------------------------- projections
def uv(m, p):
    u = (p[1] + Y0 - S0) / (S1 - S0)
    if m == "side":
        t = min(max((p[2] - Z0) / (Z1 - Z0), 0.0), 1.0)
        return u, 0.5 * t + (0.5 if p[0] > 0 else 0.0)
    return u, (p[0] - XMIN) / (XMAX - XMIN)


def weights(n):
    t = max(n[2], 0.0) ** K
    b = max(-n[2], 0.0) ** K
    s = abs(n[0]) ** K
    tot = t + b + s + 1e-6
    return {"top": t / tot, "bottom": b / tot, "side": s / tot}


# ------------------------------------------------------------- rasteriser
class Canvas:
    def __init__(self):
        self.ch = {m: np.zeros((3, h, w), np.uint8) for m, (w, h) in MAPS.items()}

    def _put(self, m, c, ya, yb, xa, xb, cov, value):
        win = self.ch[m][c, ya:yb, xa:xb]
        np.maximum(win, (np.clip(cov, 0, 1) * value * 255.0).astype(np.uint8), out=win)

    def seg(self, m, c, p0, p1, width, value):
        w, h = MAPS[m]
        (x0, y0), (x1, y1) = p0, p1
        r = width * 0.5 + 1.5
        xa = max(0, int(math.floor(min(x0, x1) - r)))
        xb = min(w, int(math.ceil(max(x0, x1) + r)) + 1)
        ya = max(0, int(math.floor(min(y0, y1) - r)))
        yb = min(h, int(math.ceil(max(y0, y1) + r)) + 1)
        if xa >= xb or ya >= yb:
            return
        yy, xx = np.mgrid[ya:yb, xa:xb].astype(np.float32)
        xx += 0.5
        yy += 0.5
        dx, dy = x1 - x0, y1 - y0
        l2 = dx * dx + dy * dy
        if l2 < 1e-9:
            t = 0.0
        else:
            t = np.clip(((xx - x0) * dx + (yy - y0) * dy) / l2, 0.0, 1.0)
        d = np.hypot(xx - (x0 + t * dx), yy - (y0 + t * dy))
        self._put(m, c, ya, yb, xa, xb, width * 0.5 + 0.5 - d, value)

    def disc(self, m, c, ctr, rad, value):
        self.seg(m, c, ctr, ctr, 2 * rad, value)

    def fill(self, m, c, poly, value, feather=1.5):
        w, h = MAPS[m]
        P = np.asarray(poly, np.float64)
        xa = max(0, int(P[:, 0].min()) - 3)
        xb = min(w, int(P[:, 0].max()) + 4)
        ya = max(0, int(P[:, 1].min()) - 3)
        yb = min(h, int(P[:, 1].max()) + 4)
        if xa >= xb or ya >= yb:
            return
        yy, xx = np.mgrid[ya:yb, xa:xb].astype(np.float64)
        xx += 0.5
        yy += 0.5
        inside = np.zeros(xx.shape, bool)
        dmin = np.full(xx.shape, 1e9)
        n = len(P)
        for i in range(n):
            x0, y0 = P[i]
            x1, y1 = P[(i + 1) % n]
            cond = (y0 > yy) != (y1 > yy)
            with np.errstate(divide='ignore', invalid='ignore'):
                xi = x0 + (yy - y0) * (x1 - x0) / (y1 - y0)
            inside ^= cond & (xx < xi)
            dx, dy = x1 - x0, y1 - y0
            l2 = dx * dx + dy * dy
            t = np.clip(((xx - x0) * dx + (yy - y0) * dy) / max(l2, 1e-12), 0, 1)
            dmin = np.minimum(dmin, np.hypot(xx - (x0 + t * dx), yy - (y0 + t * dy)))
        sd = np.where(inside, dmin, -dmin)
        self._put(m, c, ya, yb, xa, xb, (sd + feather * 0.5) / feather, value)


# ------------------------------------------------------------- the painter
class Painter:
    def __init__(self, objs):
        self.canvas = Canvas()
        dg = bpy.context.evaluated_depsgraph_get()
        verts, polys = [], []
        for ob in objs:
            ev = ob.evaluated_get(dg)
            me = ev.to_mesh()
            mw = ev.matrix_world
            base = len(verts)
            verts.extend(mw @ v.co for v in me.vertices)
            polys.extend([base + i for i in p.vertices] for p in me.polygons)
            ev.to_mesh_clear()
        self.bvh = BVHTree.FromPolygons(verts, polys)

    # -- ray casting -----------------------------------------------------
    def cast(self, kind, a, b, side=1):
        if kind == "top":
            o, d = Vector((b, a - Y0, 9.0)), Vector((0, 0, -1))
        elif kind == "bottom":
            o, d = Vector((b, a - Y0, -9.0)), Vector((0, 0, 1))
        else:
            o, d = Vector((side * 9.0, a - Y0, b)), Vector((-side, 0, 0))
        hit = self.bvh.ray_cast(o, d, 30.0)
        if hit[0] is None:
            return None
        n = hit[1]
        if n.dot(d) > 0:
            n = -n
        return hit[0], n

    def visible(self, m, p, tol=0.015):
        if m == "top":
            hit = self.bvh.ray_cast(Vector((p[0], p[1], 9.0)), Vector((0, 0, -1)), 30.0)
        elif m == "bottom":
            hit = self.bvh.ray_cast(Vector((p[0], p[1], -9.0)), Vector((0, 0, 1)), 30.0)
        else:
            sg = 1.0 if p[0] > 0 else -1.0
            hit = self.bvh.ray_cast(Vector((sg * 9.0, p[1], p[2])), Vector((-sg, 0, 0)), 30.0)
        return hit[0] is not None and (hit[0] - Vector(p)).length < tol

    def trace(self, kind, pts, side=1, step=0.01):
        """2-D authoring polyline -> runs of (point, normal) on the skin."""
        dense = _resample(pts, step)
        runs, cur = [], []
        for a, b in dense:
            h = self.cast(kind, a, b, side)
            if h is None:
                if len(cur) > 1:
                    runs.append(cur)
                cur = []
            else:
                cur.append(h)
        if len(cur) > 1:
            runs.append(cur)
        return runs

    # -- drawing 3-D polylines -------------------------------------------
    def stroke(self, run, c=R, width=LINE_W, value=1.0, maps=("top", "bottom", "side")):
        info = []
        for p, n in run:
            wt = weights(n)
            info.append({m: (wt[m] > 0.02 and self.visible(m, p)) for m in maps})
        for m in maps:
            w, h = MAPS[m]
            for (p0, _), (p1, _), i0, i1 in zip(run, run[1:], info, info[1:]):
                if not (i0[m] and i1[m]):
                    continue
                u0, v0 = uv(m, p0)
                u1, v1 = uv(m, p1)
                if m == "side" and (v0 >= 0.5) != (v1 >= 0.5):
                    continue
                self.canvas.seg(m, c, (u0 * w, v0 * h), (u1 * w, v1 * h), width, value)

    def dots(self, run, pitch=0.03, rad=0.9, value=0.75, maps=("top", "bottom", "side")):
        acc = 0.0
        for (p0, n0), (p1, _) in zip(run, run[1:]):
            acc += (p1 - p0).length
            if acc < pitch:
                continue
            acc = 0.0
            wt = weights(n0)
            for m in maps:
                if wt[m] > 0.05 and self.visible(m, p0):
                    w, h = MAPS[m]
                    u, v = uv(m, p0)
                    self.canvas.disc(m, R, (u * w, v * h), rad, value)

    # -- authoring API ---------------------------------------------------
    def line(self, kind, pts, mirror=True, closed=False, saw=None, width=LINE_W, value=1.0,
             tape=False, rivets=None, side=1):
        """kind: 'top' / 'bottom' -> pts are (s, x); 'side' -> pts are (s, z).
        saw=(teeth, amplitude) turns every segment into a sawtooth.
        rivets=(offset, pitch) adds a fastener row parallel to the line."""
        pts = list(pts)
        if closed:
            pts = pts + [pts[0]]
        if saw:
            pts = sawtooth(pts, *saw)
        variants = []
        if kind == "side":
            variants = [(pts, 1), (pts, -1)] if mirror else [(pts, side)]
        else:
            variants = [(pts, 1)]
            if mirror:
                variants.append(([(a, -b) for a, b in pts], 1))
        for vp, sd in variants:
            for run in self.trace(kind, vp, sd):
                self.stroke(run, R, width, value)
                if tape:
                    self.stroke(run, G, TAPE_W, 0.55)
            if rivets:
                off, pitch = rivets
                for run in self.trace(kind, offset_polyline(vp, off), sd):
                    self.dots(run, pitch)

    def frame(self, kind, pts, mirror=True, step=0.09, amp=0.014, width=FRAME_W, value=0.8, rivets=None,
              side=1):
        """RAM tape frame over a seam (photos ref_05, ref_06 of 901, c14, c51, c53): the seam itself
        (R) under a band whose edges step every ~9 cm (G), stepped on both sides."""
        self.line(kind, pts, mirror=mirror, rivets=rivets, side=side)
        sq = square_wave(list(pts), step, amp)
        if kind == "side":
            variants = [(sq, 1), (sq, -1)] if mirror else [(sq, side)]
        else:
            variants = [(sq, 1)]
            if mirror:
                variants.append(([(a, -b) for a, b in sq], 1))
        for vp, sd in variants:
            for run in self.trace(kind, vp, sd, step=0.006):
                self.stroke(run, G, width, value)

    def patch(self, kind, poly, c=B, value=0.5, mirror=True, side=1):
        """Filled coating patch, drawn directly in its own map (no ray cast)."""
        polys = []
        if kind == "side":
            sides = (1, -1) if mirror else (side,)
            for sd in sides:
                polys.append([Vector((sd * 0.5, a - Y0, b)) for a, b in poly])
            m = "side"
        else:
            polys.append([Vector((b, a - Y0, 0.0)) for a, b in poly])
            if mirror:
                polys.append([Vector((-b, a - Y0, 0.0)) for a, b in poly])
            m = kind
        w, h = MAPS[m]
        for pp in polys:
            px = []
            for p in pp:
                u, v = uv(m, p)
                px.append((u * w, v * h))
            self.canvas.fill(m, c, px, value)

    def outline_object(self, ob, value=1.0, tape=False):
        """Boundary loops of an open surface mesh (doors, canopy frame)."""
        for loop in boundary_loops(ob):
            run = [(p, n) for p, n in loop]
            self.stroke(run, R, LINE_W, value)
            if tape:
                self.stroke(run, G, TAPE_W, 0.55)

    def save(self):
        imgs = images()
        for m, img in imgs.items():
            w, h = MAPS[m]
            ch = self.canvas.ch[m]
            px = np.empty((h, w, 4), np.float32)
            px[:, :, 0] = ch[R] / 255.0
            px[:, :, 1] = ch[G] / 255.0
            px[:, :, 2] = ch[B] / 255.0
            px[:, :, 3] = 1.0
            img.pixels.foreach_set(px.ravel())
            img.update()
            img.pack()
        return imgs


# ------------------------------------------------------------- 2-D helpers
def _resample(pts, step):
    out = [pts[0]]
    for (a0, b0), (a1, b1) in zip(pts, pts[1:]):
        L = math.hypot(a1 - a0, b1 - b0)
        n = max(1, int(math.ceil(L / step)))
        for i in range(1, n + 1):
            t = i / n
            out.append((a0 + (a1 - a0) * t, b0 + (b1 - b0) * t))
    return out


def sawtooth(pts, teeth, amp):
    """Replace each segment by `teeth` triangular teeth of height amp
    (positive = to the left of the direction of travel)."""
    out = [pts[0]]
    for (a0, b0), (a1, b1) in zip(pts, pts[1:]):
        L = math.hypot(a1 - a0, b1 - b0)
        if L < 1e-6:
            continue
        ta, tb = (a1 - a0) / L, (b1 - b0) / L
        na, nb = -tb, ta
        n = max(1, int(teeth))
        for i in range(n):
            t0 = (i + 0.5) / n
            out.append((a0 + (a1 - a0) * t0 + na * amp, b0 + (b1 - b0) * t0 + nb * amp))
            t1 = (i + 1) / n
            out.append((a0 + (a1 - a0) * t1, b0 + (b1 - b0) * t1))
    return out


def square_wave(pts, step, amp):
    """Polyline -> a square wave about it: runs of `step` length offset alternately by +amp and
    -amp, joined by short square shoulders."""
    out = []
    k = 0
    for (a0, b0), (a1, b1) in zip(pts, pts[1:]):
        L = math.hypot(a1 - a0, b1 - b0)
        if L < 1e-6:
            continue
        ta, tb = (a1 - a0) / L, (b1 - b0) / L
        na, nb = -tb, ta
        n = max(1, int(round(L / step)))
        for i in range(n):
            o = amp if k % 2 == 0 else -amp
            t0, t1 = i / n, (i + 1) / n
            out.append((a0 + (a1 - a0) * t0 + na * o, b0 + (b1 - b0) * t0 + nb * o))
            out.append((a0 + (a1 - a0) * t1 + na * o, b0 + (b1 - b0) * t1 + nb * o))
            k += 1
    return out


def offset_polyline(pts, d):
    out = []
    n = len(pts)
    for i in range(n):
        a, b = pts[i]
        if i == 0:
            da, db = pts[1][0] - a, pts[1][1] - b
        elif i == n - 1:
            da, db = a - pts[i - 1][0], b - pts[i - 1][1]
        else:
            da, db = pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]
        L = math.hypot(da, db) or 1.0
        out.append((a - db / L * d, b + da / L * d))
    return out


def rect(s0, s1, a0, a1):
    return [(s0, a0), (s1, a0), (s1, a1), (s0, a1)]


def hexa(s0, s1, a0, a1, cut):
    """Rectangle with all four corners cut at 45 deg (the typical F-35 panel)."""
    return [(s0 + cut, a0), (s1 - cut, a0), (s1, a0 + cut), (s1, a1 - cut),
            (s1 - cut, a1), (s0 + cut, a1), (s0, a1 - cut), (s0, a0 + cut)]


def chevron(s0, s1, a0, a1, tip):
    """Panel whose fore and aft edges are swept back into a shallow 'V'."""
    am = 0.5 * (a0 + a1)
    return [(s0, a0), (s1, a0), (s1 + tip, am), (s1, a1), (s0, a1), (s0 + tip, am)]


# ------------------------------------------------------------- 3-D helpers
def boundary_loops(ob):
    """Ordered boundary loops of the base mesh, world space, with normals."""
    mw = ob.matrix_world
    nm = mw.to_3x3().inverted_safe().transposed()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    edges = [e for e in bm.edges if len(e.link_faces) == 1]
    adj = {}
    for e in edges:
        a, b = e.verts
        adj.setdefault(a.index, []).append(b.index)
        adj.setdefault(b.index, []).append(a.index)
    co = {v.index: (mw @ v.co, (nm @ v.normal).normalized()) for v in bm.verts}
    bm.free()
    seen = set()
    loops = []
    for start in adj:
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        prev, cur = None, start
        while True:
            nxt = [v for v in adj[cur] if v != prev and v not in seen]
            if not nxt:
                if start in adj[cur] and len(loop) > 2:
                    loop.append(start)
                break
            prev, cur = cur, nxt[0]
            loop.append(cur)
            seen.add(cur)
        loops.append([co[i] for i in loop])
    return loops


def store_rest(objs):
    """Rest-pose world position (point) and normal (face) on each mesh."""
    for ob in objs:
        me = ob.data
        if me.users > 1:
            ob.data = me = me.copy()
        mw = np.array(ob.matrix_world, np.float64)
        nv = len(me.vertices)
        co = np.empty(nv * 3, np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3).astype(np.float64)
        wp = co @ mw[:3, :3].T + mw[:3, 3]
        a = me.attributes.get("rest_p") or me.attributes.new("rest_p", 'FLOAT_VECTOR', 'POINT')
        a.data.foreach_set("vector", wp.astype(np.float32).ravel())
        npoly = len(me.polygons)
        if npoly:
            fn = np.empty(npoly * 3, np.float32)
            me.polygons.foreach_get("normal", fn)
            nmat = np.linalg.inv(mw[:3, :3]).T
            fn = fn.reshape(-1, 3).astype(np.float64) @ nmat.T
            fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-9)
            b = me.attributes.get("rest_n") or me.attributes.new("rest_n", 'FLOAT_VECTOR', 'FACE')
            b.data.foreach_set("vector", fn.astype(np.float32).ravel())


def skin_objects():
    out = []
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        if any(s.material and s.material.name == "F35_Skin_RAM" for s in ob.material_slots):
            out.append(ob)
    return out


# ------------------------------------------------------------- the layout
def layout(pt):
    """Representative F-35A/I panel breakdown (left side, mirrored)."""
    from . import wings as WG
    from . import tails as TL

    # ---- radome joint (raked) and lighter radome ---------------------
    pt.line("side", [(1.255, -0.55), (1.30, 0.0), (1.345, 0.55)])
    for kind in ("top", "bottom"):
        pt.line(kind, [(1.34 if kind == "top" else 1.27, -0.65), (1.34 if kind == "top" else 1.27, 0.65)],
                mirror=False)
    pt.patch("top", rect(-0.2, 1.33, -0.8, 0.8), B, 0.32, mirror=False)
    pt.patch("bottom", rect(-0.2, 1.27, -0.8, 0.8), B, 0.32, mirror=False)
    pt.patch("side", [(-0.2, -0.8), (1.25, -0.8), (1.25, -0.45), (1.38, 0.6), (1.38, 0.9), (-0.2, 0.9)],
             B, 0.32)

    # ---- forebody sides: avionics bay doors below the chine -------------
    # (close photos of both sides, ref_03 / ref_05 = Adir 901, c34, c51, c53): one big access
    # panel with a stepped outline and fastener rows, the cheek DAS window in its aft-upper
    # part; ahead of and below it a small square panel round the air-data probe root and a
    # darker trapezoid (both stencilled CAUTION HOT); a fastener strip along the bottom
    pt.line("side", [(1.55, 0.12), (2.16, 0.18), (2.22, 0.07), (2.36, 0.06), (2.42, -0.06),
                     (2.48, -0.08), (2.48, -0.33), (2.40, -0.40), (1.99, -0.40), (1.99, -0.36),
                     (1.73, -0.36), (1.68, -0.30), (1.56, -0.30), (1.50, -0.12), (1.52, 0.02)],
            closed=True, rivets=(0.022, 0.034))
    pt.line("side", rect(1.73, 1.99, -0.36, -0.15), closed=True, rivets=(0.018, 0.03))
    trap = [(1.36, -0.12), (1.68, -0.10), (1.70, -0.32), (1.42, -0.31)]
    pt.patch("side", trap, G, 0.55)
    pt.line("side", trap, closed=True)
    pt.line("side", [(1.50, -0.43), (2.46, -0.43)], rivets=(0.018, 0.034))
    # left side only: the rescue / ladder door, two stacked hexagons (the upper one 5 cm further
    # aft), its top ~0.08 m under the chine (c34, c20, ref_05, ref_07); the right side has none
    pt.line("side", hexa(3.20, 3.80, -0.05, 0.30, 0.06), mirror=False, closed=True, side=1)
    pt.line("side", hexa(3.15, 3.75, -0.40, -0.05, 0.06), mirror=False, closed=True, side=1)
    pt.line("side", [(2.5, -0.38), (3.10, -0.38)], mirror=False, side=1)
    pt.line("side", [(2.5, -0.38), (3.7, -0.38), (3.85, -0.48)], mirror=False, side=-1)
    # the canopy frame band reads a shade lighter than the fuselage side in the photos (c34, c51,
    # c09): a light coating over the band and the rear frame, in side view between the sill and
    # the glass edge, back to the frame's aft edge
    from .canopy import sill_z, glass_edge_z, rear_edge_s, CREST, FRAME_W
    s_aft = rear_edge_s(sill_z(4.7)) + FRAME_W
    lo = [(s, sill_z(s) - 0.004) for s in np.linspace(1.86, s_aft, 70)]
    z_top = CREST(s_aft) + 0.03
    aft = [(rear_edge_s(z) + FRAME_W, z) for z in np.linspace(sill_z(s_aft), z_top, 12)]
    top = [(s, min(glass_edge_z(s), CREST(s) + 0.03)) for s in np.linspace(rear_edge_s(z_top) + FRAME_W, 1.86, 110)]
    pt.patch("side", lo + aft + top, B, 0.35)
    # under-canopy sill panels (~8 cm below the canopy's sill, which is ~0.55 m up from the
    # windscreen to the bow) and the sawtooth behind the canopy
    pt.line("side", [(1.95, 0.47), (3.0, 0.47), (4.30, 0.60)], rivets=(-0.025, 0.035))
    pt.line("side", [(4.78, 0.98), (4.36, 0.34)], saw=(4, 0.05), tape=True)
    pt.line("side", [(3.55, 0.36), (4.30, 0.36)])
    # inlet cowl: line parallel to the lip
    pt.line("side", [(4.52, 0.30), (4.74, -0.05), (4.92, -0.42)], tape=True)

    # ---- mid fuselage sides below the wing root (photo c51) -------------
    pt.line("side", hexa(5.72, 6.55, -0.28, 0.05, 0.08), closed=True, tape=True)     # c51, c20
    pt.line("side", hexa(6.50, 8.55, -0.42, -0.06, 0.14), closed=True)
    pt.line("side", hexa(6.95, 8.65, -0.64, -0.48, 0.07), closed=True)
    pt.line("side", [(4.95, -0.05), (5.50, -0.05)])
    pt.line("side", [(8.75, -0.10), (10.40, -0.12), (10.55, -0.30)])
    # aft fuselage sides
    pt.line("side", hexa(10.9, 12.9, -0.30, 0.05, 0.12), closed=True)
    pt.line("side", hexa(13.0, 14.6, -0.22, 0.10, 0.10), closed=True)
    pt.line("side", [(10.6, 0.22), (14.9, 0.22)], rivets=(0.025, 0.04))

    # ---- top: forebody, spine, shoulders --------------------------------
    # The upper fuselage panels are outlined by stair-stepped RAM tape frames from just aft of the
    # canopy over both shoulders and along the spine to the aft deck (photos ref_05, ref_06 of 901,
    # c14, c51, c53).  They read darker or lighter than the paint depending on the light.
    pt.line("top", rect(1.55, 1.90, -0.22, 0.22), mirror=False, closed=True)
    pt.frame("top", [(5.10, 0.30), (11.2, 0.30)], rivets=(0.045, 0.035))
    for s in (6.6, 8.0, 9.4):
        pt.frame("top", [(s, -0.30), (s, 0.30)], mirror=False)
    pt.line("top", [(4.95, 0.52), (4.95, 1.48)], saw=(5, 0.06), tape=True)
    pt.frame("top", [(5.0, 0.80), (10.8, 0.86)], rivets=(0.045, 0.035))
    for s in (6.4, 7.9, 9.5):
        pt.frame("top", [(s, 0.32), (s, 1.45)])
    pt.line("top", [(5.05, 1.40), (6.80, 1.55), (8.20, 1.66)], rivets=(-0.03, 0.035))
    # gun fairing (left only): a rectangular access panel two-thirds of the way aft, lighter in
    # c20 and ref_05 (901), and the fastener row along its inboard foot
    pt.line("top", rect(7.00, 7.70, 1.17, 1.40), mirror=False, closed=True, rivets=(0.025, 0.035))
    pt.patch("top", rect(7.00, 7.70, 1.17, 1.40), B, 0.45, mirror=False)
    pt.line("top", [(5.85, 1.125), (8.60, 1.125)], mirror=False, value=0.5, rivets=(0.02, 0.04))
    # vent fairing (right only): two grille panels on its top, fasteners round the aft taper
    for s0, s1 in ((6.40, 6.72), (6.78, 7.10)):
        pt.line("top", rect(s0, s1, -1.565, -1.675), mirror=False, closed=True)
        for s in np.arange(s0 + 0.03, s1 - 0.01, 0.03):
            pt.line("top", [(s, -1.575), (s, -1.665)], mirror=False, value=0.75)
    pt.line("top", [(7.15, -1.53), (7.75, -1.60), (7.15, -1.70)], mirror=False, value=0.6,
            rivets=(0.02, 0.035))
    # inlet top: line parallel to the cowl lip
    pt.line("top", [(4.62, 0.98), (4.82, 1.50)], tape=True)

    # ---- top: engine bay and aft deck ------------------------------------
    pt.frame("top", [(11.2, 0.62), (13.9, 0.62)], rivets=(0.045, 0.04))
    for s in (11.2, 12.5):
        pt.frame("top", [(s, -0.62), (s, 0.62)], mirror=False)
    pt.line("top", [(13.9, -0.62), (13.9, 0.62)], saw=(6, 0.07), mirror=False, tape=True)
    pt.line("top", [(11.2, 0.62), (11.2, 1.25), (12.6, 1.30)])

    # ---- bottom: belly panels ---------------------------------------------
    pt.line("bottom", chevron(4.75, 6.40, -0.36, 0.36, 0.12), mirror=False, tape=True)
    pt.line("bottom", [(10.85, -0.55), (10.85, 0.55)], saw=(7, 0.07), mirror=False, tape=True)
    pt.line("bottom", [(10.85, 0.55), (14.3, 0.55)], rivets=(0.03, 0.04))
    pt.line("bottom", [(12.6, -0.55), (12.6, 0.55)], mirror=False)
    pt.line("bottom", rect(13.4, 14.6, -0.16, 0.16), mirror=False, tape=True)
    pt.line("bottom", [(8.62, 1.30), (10.60, 1.30)])

    # ---- wings: control-surface hinge lines, spar lines, LE strip --------
    # The close top view ref_06 shows only the LEF and flaperon outlines, the roundel patch and a
    # small U-shaped panel on the fixed tip TE; the spar lines are kept very faint on the underside.
    for kind in ("top", "bottom"):
        a, b = WG.LEF_HW
        pt.line(kind, [(WG.lef_hinge(hw), hw) for hw in np.linspace(a, b, 12)])
        for hw in (a, b):
            pt.line(kind, [(WG.le(hw) - 0.05, hw), (WG.lef_hinge(hw), hw)])
        a, b = WG.FLAP_HW
        pt.line(kind, [(WG.flap_hinge(hw), hw) for hw in np.linspace(a, b, 12)])
        for hw in (a, b):
            pt.line(kind, [(WG.flap_hinge(hw), hw), (WG.te(hw) + 0.05, hw)])
        h0, h1 = WG.FLAP_HW[1] + 0.07, WG.FLAP_HW[1] + 0.42
        pt.line(kind, [(WG.te(h0) + 0.05, h0), (WG.te(h0) - 0.38, h0), (WG.te(h1) - 0.38, h1),
                       (WG.te(h1) + 0.05, h1)])
    sp = [(WG.le(hw) + 0.48 * (WG.te(hw) - WG.le(hw)), hw) for hw in np.linspace(1.95, 4.6, 12)]
    pt.line("bottom", sp, value=0.45)
    # lighter rectangular patch under each upper-wing roundel (ref_06: about 0.95 x 0.5 m)
    from .markings import WING_ROUNDEL
    ws, wx, _ = WING_ROUNDEL
    pt.patch("top", rect(ws - 0.25, ws + 0.25, wx - 0.475, wx + 0.475), B, 0.80)
    for kind in ("top", "bottom"):
        # lighter leading-edge strip
        le_pts = [(WG.le(hw), hw) for hw in np.linspace(1.80, 5.37, 30)]
        strip = [(s - 0.02, hw) for s, hw in le_pts] + [(s + 0.09, hw) for s, hw in reversed(le_pts)]
        pt.patch(kind, strip, B, 0.45)

    # ---- stabilators -------------------------------------------------------
    for kind in ("top", "bottom"):
        le_pts = [(TL._STAB_LE(hw), hw) for hw in np.linspace(1.0, TL.STAB_TIP_HW, 20)]
        strip = [(s - 0.02, hw) for s, hw in le_pts] + [(s + 0.08, hw) for s, hw in reversed(le_pts)]
        pt.patch(kind, strip, B, 0.45)
        sp = [(TL._STAB_LE(hw) + 0.35 * (TL._STAB_TE(hw) - TL._STAB_LE(hw)), hw)
              for hw in np.linspace(1.05, 3.3, 10)]
        pt.line(kind, sp)

    # ---- fins: rudder outline, LE strip ------------------------------------
    sc, cc = math.sin(TL.FIN_CANT), math.cos(TL.FIN_CANT)

    def fin_pt(u, s):
        return (s, TL.FIN_ROOT[1] + u * cc)

    a, b = 0.12, TL.FIN_SPAN - 0.06
    hinge = lambda u: TL.RUD_HINGE[0] + (TL.RUD_HINGE[1] - TL.RUD_HINGE[0]) * u / TL.FIN_SPAN
    te = lambda u: TL.FIN_TE[0] + (TL.FIN_TE[1] - TL.FIN_TE[0]) * u / TL.FIN_SPAN
    le = lambda u: TL.FIN_LE[0] + (TL.FIN_LE[1] - TL.FIN_LE[0]) * u / TL.FIN_SPAN
    pt.line("side", [fin_pt(a, te(a) + 0.03), fin_pt(a, hinge(a)), fin_pt(b, hinge(b)), fin_pt(b, te(b) + 0.03)])
    us = np.linspace(0.05, TL.FIN_SPAN, 16)
    strip = [fin_pt(u, le(u) - 0.02) for u in us] + [fin_pt(u, le(u) + 0.09) for u in reversed(us)]
    pt.patch("side", strip, B, 0.45)
    pt.line("side", [fin_pt(u, le(u) + 0.40 * (te(u) - le(u))) for u in np.linspace(0.15, TL.FIN_SPAN - 0.1, 10)],
            rivets=(0.03, 0.045))


def build(ctx):
    objs = skin_objects()
    store_rest(objs)
    pt = Painter(objs)
    # door / canopy outlines straight from their meshes
    for ob in objs:
        n = ob.name
        if n.startswith(("BayDoor_", "NoseGearDoor_", "MainGearDoor_", "GunDoor", "RefuelDoor")):
            pt.outline_object(ob, tape=n.startswith(("BayDoor_", "NoseGearDoor_", "MainGearDoor_")))
        elif n == "Canopy_Frame":
            pt.outline_object(ob, value=0.8)
    layout(pt)
    imgs = pt.save()
    return {"maps": {m: list(MAPS[m]) for m in MAPS}, "objects": len(objs),
            "images": [i.name for i in imgs.values()]}
