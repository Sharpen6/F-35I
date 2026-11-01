"""Israeli Air Force markings as decals that hug the skin:

* low-visibility roundels (Star of David) on the forward fuselage sides,
  upper and lower wing surfaces
* three-digit IAF serial (9xx) on the nose sides
* squadron eagle on the outer faces of both fins and on the inlet sides
  (an original stylised drawing, not a copy of the real emblem artwork)
* canopy-frame warning, RESCUE stencils (different on the two sides), DANGER EJECTION SEAT and
  DANGER JET INTAKE triangles, laid out from close photos of an Adir (right side) and an F-35A
  (left side)
* white crescent index marks on the fasteners of the left rescue door and the inlet-side panels

Images are painted procedurally with the small numpy rasteriser and packed
into the .blend, so the model has no external texture dependencies.
"""
import math
import numpy as np
import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .geom import P, get_collection, mesh_object
from .textures import Canvas, roundel_image, _FONT
from . import materials as M

SERIAL = "901"
# low-vis roundel: a light blue-grey disc (about 1.7-2x the skin in photos ref_01, ref_06, ref_08)
# with the star left open, so it is the airframe grey (sRGB values: the decal images are 8-bit)
DISC = (0.60, 0.65, 0.69)
MARK_WHITE = (0.82, 0.84, 0.86)
WING_ROUNDEL = (10.35, 3.70, 0.47)     # station, half span, decal size (disc = 0.96 x size)


# ---------------------------------------------------------------- painting
def _stroke(c, pts, t, col=(1, 1, 1)):
    for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
        c.line(x0, y0, x1, y1, col, t)
    for x, y in pts:
        c.circle(x, y, t / 2, col)


def _alpha_from_rgb(c):
    m = c.px[:, :, :3].max(axis=2) > 0.02
    c.px[:, :, 3] = m.astype(np.float32)


# Serial digits: the IAF block font seen on 901's nose (ref_05; ref_03 of 905, ref_07 of 919):
# square digits about 0.85 as wide as tall, a stroke ~15 % of the height, chamfered outer corners,
# chamfered holes, a "1" that is a plain bar, and wide spacing.  Each glyph is drawn on a
# 6.8 x 8 grid (y down) as a union of bars, then chamfered.
_GW, _GH, _GT = 6.8, 8.0, 1.2          # glyph width, height, stroke
_GC, _Gc = 1.5, 0.7                    # outer chamfer, inner (hole) chamfer
_GADV = 8.4                            # advance per digit


def _glyph_bars(ch):
    W, H, T = _GW, _GH, _GT
    m0, m1 = H / 2 - T / 2 - 0.15, H / 2 + T / 2 - 0.15        # middle bar, a little above centre
    bar = {"t": (0, 0, W, T), "b": (0, H - T, W, H), "m": (0, m0, W, m1),
           "lu": (0, 0, T, m1), "ll": (0, m0, T, H), "ru": (W - T, 0, W, m1), "rl": (W - T, m0, W, H)}
    segs = {"0": "t b lu ll ru rl", "2": "t ru m ll b", "3": "t ru m rl b", "4": "lu m ru rl",
            "5": "t lu m rl b", "6": "t lu ll m rl b", "7": "t ru rl", "8": "t b m lu ll ru rl",
            "9": "t lu ru m rl b"}
    if ch == "1":                      # a plain bar, a little heavier, left of the cell's centre (ref_05)
        return [(1.3, 0, 2.9, H)], [], [], (m0, m1)
    bars = [bar[k] for k in segs.get(ch, "").split()]
    # outer corners to chamfer (corner, directions into the glyph) and concave corners to fill
    outer = [(0, 0, 1, 1), (W, 0, -1, 1), (0, H, 1, -1), (W, H, -1, -1)]
    inner = []
    if ch == "9":
        outer.append((0, m1, 1, -1))                                   # bowl's lower left
        inner += [(W - T, m1, -1, 1), (W - T, H - T, -1, -1)]          # where the stem meets the bars
    if ch in "069" and ch:
        lo = H - T if ch == "0" else m0
        inner += [(T, T, 1, 1), (W - T, T, -1, 1), (T, lo, 1, -1), (W - T, lo, -1, -1)]   # hole corners
    if ch == "6":
        inner += [(T, m0, 1, -1), (T, m1, 1, 1), (W - T, m1, -1, 1), (T, H - T, 1, -1), (W - T, H - T, -1, -1)]
    return bars, outer, inner, (m0, m1)


def _glyph_mask(ch, gx, gy):
    bars, outer, inner, _ = _glyph_bars(ch)
    m = np.zeros(gx.shape, dtype=bool)
    for x0, y0, x1, y1 in bars:
        m |= (gx >= x0) & (gx <= x1) & (gy >= y0) & (gy <= y1)
    for cx, cy, sx, sy in inner:
        dx, dy = sx * (gx - cx), sy * (gy - cy)
        m |= (dx >= 0) & (dy >= 0) & (dx + dy < _Gc)
    for cx, cy, sx, sy in outer:
        m &= ~((sx * (gx - cx) + sy * (gy - cy)) < _GC)
    return m


def serial_image(text, name, w=768, h=288, col=MARK_WHITE):
    c = Canvas(w, h, (0, 0, 0))

    def extent(ch):
        bars = _glyph_bars(ch)[0]
        return (min(b[0] for b in bars), max(b[2] for b in bars)) if bars else (0.0, _GW)
    left = extent(text[0])[0] if text else 0.0
    span = _GADV * (len(text) - 1) + (extent(text[-1])[1] if text else _GW) - left
    sc = min(0.92 * h / _GH, 0.95 * w / max(span, 1e-6))
    x0 = (w - span * sc) / 2 - left * sc
    y0 = (h - _GH * sc) / 2
    for k, ch in enumerate(text):
        gx = (c.xx - (x0 + k * _GADV * sc)) / sc
        gy = (c.yy - y0) / sc
        c.px[_glyph_mask(ch, gx, gy), :3] = col
    _alpha_from_rgb(c)
    return c.to_image(name)


# Squadron emblems: original stylised line drawings on a 100 x 100 grid (y down), the head facing
# +x, which the decals turn towards the nose.  The photos (ref_04, ref_05, ref_06, ref_07) show a
# perched eagle filling most of each fin and a flying eagle with raised wings on the inlet sides.
_PERCHED = [
    [(46, 31), (49, 22), (55, 15), (63, 11), (71, 10), (78, 11), (84, 14), (89, 18), (93, 24), (94, 30), (91, 35),
     (89, 30), (85, 28)],                                                         # head and hooked beak
    [(85, 28), (80, 29), (75, 28)], [(88, 31), (84, 34), (78, 35)],               # gape, jaw
    [(78, 35), (77, 44), (75, 54), (71, 64), (65, 72), (58, 78), (52, 81)],     # breast
    [(46, 31), (42, 36), (45, 37), (40, 42), (35, 50), (30, 60), (26, 70), (22, 80), (17, 91)],   # nape, back
    [(52, 34), (60, 41), (64, 51), (63, 61), (58, 70), (49, 78), (38, 86), (27, 93)],              # folded wing
    [(53, 46), (57, 54), (55, 63)], [(42, 63), (50, 67)], [(37, 71), (45, 75)], [(32, 79), (40, 83)],
    [(17, 91), (22, 97), (27, 93)],                                               # tail
    [(55, 80), (55, 87)], [(64, 75), (66, 87)],                                   # legs
    [(51, 90), (53, 87), (58, 87), (60, 90)], [(62, 90), (64, 87), (69, 87), (71, 90)],          # talons
    [(40, 91), (86, 91)],                                                         # perch
    [(63, 16), (71, 16), (82, 21)],                                               # brow
]
_PERCHED_EYE = (73.0, 21.5, 2.6)
_FLYING = [
    [(42, 58), (52, 52), (62, 48), (70, 46), (76, 42), (82, 40), (88, 41), (92, 45), (94, 50), (91, 54), (89, 49),
     (85, 50)],                                                                   # back, head, beak
    [(90, 52), (86, 56), (80, 58), (74, 64), (64, 70), (52, 71), (44, 67), (42, 64)],             # throat, belly
    [(42, 58), (28, 55), (23, 61), (28, 68), (42, 64)],                           # tail
    [(66, 47), (70, 37), (73, 26), (74, 15), (73, 6), (68, 1), (66, 8), (61, 3), (60, 10), (55, 6), (55, 14),
     (50, 11), (51, 20), (47, 24), (52, 28), (48, 33), (53, 37), (50, 42), (56, 46), (57, 50)],  # near wing
    [(48, 54), (44, 42), (40, 31), (35, 21), (29, 12), (26, 17), (22, 11), (21, 20), (17, 16), (19, 25), (15, 23),
     (21, 32), (27, 40), (33, 47), (40, 55)],                                     # far wing
    [(58, 70), (60, 80)], [(66, 68), (69, 79)],                                   # legs
    [(57, 83), (60, 80), (63, 83)], [(66, 82), (69, 79), (72, 82)],               # talons
]
_FLYING_EYE = (84.0, 45.0, 2.0)


def emblem_image(name, polys, eye, size=1024, col=MARK_WHITE, t=2.6):
    c = Canvas(size, size, (0, 0, 0))
    s = size / 100.0
    for poly in polys:
        _stroke(c, [(x * s, y * s) for x, y in poly], t * s)
    ex, ey, er = eye
    c.circle(ex * s, ey * s, er * s, col)
    c.circle((ex + 0.5) * s, (ey + 0.2) * s, er * 0.42 * s, (0, 0, 0))
    _alpha_from_rgb(c)
    c.px[:, :, :3] = np.where(c.px[:, :, 3:4] > 0, np.array(col, dtype=np.float32), 0.0)
    return c.to_image(name)


def _text_w(text, scale):
    return len(text) * 6 * scale - scale


def _centred(c, cx, y, text, scale, col=MARK_WHITE):
    c.text(int(cx - _text_w(text, scale) / 2), int(y), text, col, scale=scale)


def canopy_warning_image(name, w=1024, h=112):
    """Two lines on the canopy frame band (both sides)."""
    c = Canvas(w, h, (0, 0, 0))
    sc = 5
    top = (h - (2 * 7 * sc + 14)) // 2
    _centred(c, w / 2, top, "WARNING - DO NOT CUT CANOPY", sc)
    _centred(c, w / 2, top + 7 * sc + 14, "WITHIN 3 INCHES OF CANOPY FRAME", sc)
    _alpha_from_rgb(c)
    return c.to_image(name)


def rescue_image(name, side):
    """Left side (rescue access): an arrow pointing forward round a RESCUE box, with the latch
    instructions under it. Right side: a RESCUE box and 'release on other side'.
    The decal's u axis runs aft on the left side, so 'forward' is towards the image's left there."""
    if side > 0:
        w, h = 768, 352
        c = Canvas(w, h, (0, 0, 0))
        t = 6
        tip, x1, y0, y1, hy0, hy1 = 14, w - 14, 40, 128, 14, 154      # shaft y0..y1, head hy0..hy1
        xh = 96                                                         # head base
        for a, b in (((tip, (hy0 + hy1) / 2), (xh, hy0)), ((tip, (hy0 + hy1) / 2), (xh, hy1)),
                     ((xh, hy0), (xh, y0)), ((xh, hy1), (xh, y1)), ((xh, y0), (x1, y0)), ((xh, y1), (x1, y1)),
                     ((x1, y0), (x1, y1))):
            c.line(a[0], a[1], b[0], b[1], MARK_WHITE, t)
        bx0, bx1 = 300, 700
        c.rect(bx0, y0 + 12, bx1, y1 - 12, MARK_WHITE, fill=False, t=5)
        _centred(c, (bx0 + bx1) / 2, (y0 + y1) / 2 - 3.5 * 7, "RESCUE", 7)
        for k, line in enumerate(("TURN FWD MASTER LATCH", "AND AFT MASTER LATCH", "TO OPEN DOOR")):
            _centred(c, w / 2, 186 + k * 54, line, 5)
    else:
        w, h = 640, 280
        c = Canvas(w, h, (0, 0, 0))
        bx0, bx1 = 120, 520
        c.rect(bx0, 14, bx1, 118, MARK_WHITE, fill=False, t=6)
        _centred(c, w / 2, 66 - 3.5 * 8, "RESCUE", 8)
        _centred(c, w / 2, 152, "EMERGENCY CANOPY", 5)
        _centred(c, w / 2, 206, "RELEASE ON OTHER SIDE", 5)
    _alpha_from_rgb(c)
    return c.to_image(name)


def danger_triangle_image(name, lines, size=256):
    """Low-visibility warning: DANGER above a point-down white outline triangle with the hazard
    written inside it (photos: 'EJECTION SEAT' below the canopy, 'JET INTAKE' on the inlet)."""
    h = int(size * 1.125)
    c = Canvas(size, h, (0, 0, 0))
    _centred(c, size / 2, 6, "DANGER", 4)
    top, half, depth, t = 46, size * 0.46, size * 0.80, 7
    pts = [(size / 2 - half, top), (size / 2 + half, top), (size / 2, top + depth)]
    for i in range(3):
        a, b = pts[i], pts[(i + 1) % 3]
        c.line(a[0], a[1], b[0], b[1], MARK_WHITE, t)
    for k, line in enumerate(lines):
        _centred(c, size / 2, top + 22 + k * 34, line, 4 if len(line) <= 5 else 3)
    _alpha_from_rgb(c)
    return c.to_image(name)


# white crescent index marks on quick-release fasteners (photos: c34 of the left rescue door, c51 and
# c20 of the inlet-side panels): (s, z) of each mark, about 3 cm across
DOOR_MARKS = [(3.45, 0.21), (3.65, 0.125), (3.39, -0.06), (3.34, -0.285), (3.56, -0.26)]
DOOR_LABELS = [((3.34, -0.215), ("FWD MASTER", "LATCH F30 HEX")), ((3.555, -0.205), ("AFT MASTER", "LATCH F30 HEX"))]
INLET_MARKS = [(6.38, -0.02), (6.16, -0.02), (5.955, -0.015), (5.83, -0.07), (5.83, -0.145), (6.455, -0.05),
               (6.47, -0.145), (6.38, -0.218), (6.22, -0.218), (6.065, -0.218), (5.877, -0.212)]


def index_marks_image(name, side, s_c, z_c, size_u, size_v, marks, labels=(), ppm=1000):
    """White crescents (and small stencils) for one panel, laid out in (s, z).  The decal's u axis
    runs aft on the left side and forwards on the right (decal_on), image y runs down."""
    w, h = int(round(size_u * ppm)), int(round(size_v * ppm))
    c = Canvas(w, h, (0, 0, 0))

    def px(s, z):
        x = (s - (s_c - size_u / 2)) if side > 0 else ((s_c + size_u / 2) - s)
        return x * ppm, ((z_c + size_v / 2) - z) * ppm
    r = 0.015 * ppm
    for k, (s, z) in enumerate(marks):
        x, y = px(s, z)
        c.circle(x, y, r, MARK_WHITE)
        a = 0.6 + 1.9 * k                      # the open side of each crescent turns a little
        c.circle(x + 0.42 * r * math.cos(a), y + 0.42 * r * math.sin(a), 0.74 * r, (0, 0, 0))
    for (s, z), lines in labels:
        x, y = px(s, z)
        sc = 2
        for k, line in enumerate(lines):
            _centred(c, x, y - 7 * sc - 3 + k * (7 * sc + 6), line, sc)
    _alpha_from_rgb(c)
    return c.to_image(name)


def decal_material(name, img):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    b = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = 'Cubic'
    nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
    nt.links.new(tex.outputs["Alpha"], b.inputs["Alpha"])
    b.inputs["Roughness"].default_value = 0.55
    b.inputs["Metallic"].default_value = 0.1
    try:
        mat.surface_render_method = 'DITHERED'
    except Exception:
        pass
    mat.diffuse_color = (0.8, 0.8, 0.8, 1)
    return mat


# ---------------------------------------------------------------- decals
def surface_frame(target, s, side, z):
    """Point and outward normal where a ray from the given side at station s, height z hits target."""
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(target, dg)
    mw = target.matrix_world
    inv = mw.inverted()
    o = P(s, side * 4.0, z)
    d = (inv.to_3x3() @ Vector((-side, 0, 0))).normalized()
    hit, nrm, _, _ = bvh.ray_cast(inv @ o, d, 8.0)
    if hit is None:
        return None, None
    n = (mw.to_3x3().inverted().transposed() @ nrm).normalized()
    if n.x * side < 0:
        n = -n
    return mw @ hit, n


def decal_on(name, coll, target, s, side, z, size_u, size_v, mat, nu=18, nv=18):
    """A decal laid square to the surface at (s, z): text reads left-to-right from outside."""
    hit, n = surface_frame(target, s, side, z)
    if hit is None:
        print("decal_on: no surface for", name)
        return None
    up = Vector((0, 0, 1))
    v = (up - n * up.dot(n)).normalized()             # "up" on the surface: text stays level
    u = n.cross(v)                                     # horizontal (no z component)
    if u.dot(Vector((0, side, 0))) < 0:                # left side reads aft-wards, right side forwards
        u = -u
    return decal(name, coll, target, hit, u, v, -n, size_u, size_v, mat, nu, nv)


def decal(name, coll, target, origin, u_axis, v_axis, ray, size_u, size_v, mat, nu=18, nv=18, lift=0.0018):
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(target, dg)
    mw = target.matrix_world
    inv = mw.inverted()
    u_axis, v_axis, ray = Vector(u_axis).normalized(), Vector(v_axis).normalized(), Vector(ray).normalized()
    verts, uvs, hits = [], [], []
    for j in range(nv):
        for i in range(nu):
            fu, fv = i / (nu - 1), j / (nv - 1)
            p = Vector(origin) + u_axis * ((fu - 0.5) * size_u) + v_axis * ((fv - 0.5) * size_v)
            o_local = inv @ (p - ray * 1.5)
            d_local = (inv.to_3x3() @ ray).normalized()
            hit = bvh.ray_cast(o_local, d_local, 4.0)
            q = mw @ hit[0] if hit[0] is not None else p
            verts.append(q - ray * lift)
            uvs.append((fu, fv))
            hits.append(hit[0] is not None)
    # keep only quads whose four corners landed on the surface: a corner that missed
    # (past a leading edge or fin tip) would otherwise float on the projection plane
    faces = []
    for j in range(nv - 1):
        for i in range(nu - 1):
            a = j * nu + i
            q = (a, a + 1, a + nu + 1, a + nu)
            if all(hits[k] for k in q):
                faces.append(q)
    used = sorted({k for f in faces for k in f})
    remap = {k: n for n, k in enumerate(used)}
    verts = [verts[k] for k in used]
    uvs = [uvs[k] for k in used]
    faces = [tuple(remap[k] for k in f) for f in faces]
    ob = mesh_object(name, verts, faces, coll, mat, smooth=True)
    uv = ob.data.uv_layers.new(name="UVMap")
    for poly in ob.data.polygons:
        for li in poly.loop_indices:
            vi = ob.data.loops[li].vertex_index
            uv.data[li].uv = uvs[vi]
    if ob.data.polygons and ob.data.polygons[0].normal.dot(ray) > 0:
        ob.data.flip_normals()
    ob.visible_shadow = False
    mwd = ob.matrix_world.copy()
    ob.parent = target
    ob.matrix_world = mwd
    return ob


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Markings", root)
    obj = ctx["objects"]
    fus = obj["Fuselage"]
    roundel = decal_material("F35_Decal_Roundel", roundel_image("IAF_Roundel", 512, None, DISC))
    serial = decal_material("F35_Decal_Serial", serial_image(SERIAL, "IAF_Serial"))
    eagle_fin = decal_material("F35_Decal_Eagle", emblem_image("Sqn_Eagle_Perched", _PERCHED, _PERCHED_EYE))
    eagle = decal_material("F35_Decal_Eagle_Flying", emblem_image("Sqn_Eagle_Flying", _FLYING, _FLYING_EYE))
    rescue = {1: decal_material("F35_Decal_Rescue_L", rescue_image("Rescue_Stencil_L", 1)),
              -1: decal_material("F35_Decal_Rescue_R", rescue_image("Rescue_Stencil_R", -1))}
    seat = decal_material("F35_Decal_EjectSeat", danger_triangle_image("Danger_EjectSeat", ("EJECTION", "SEAT")))
    intake = decal_material("F35_Decal_JetIntake", danger_triangle_image("Danger_JetIntake", ("JET", "INTAKE")))
    canopy_warn = decal_material("F35_Decal_CanopyWarning", canopy_warning_image("Canopy_Warning"))
    out = []
    for side, tag in ((1, "L"), (-1, "R")):
        ray = Vector((-side, 0, 0))
        fwd = Vector((0, -1, 0))
        # decal "u" runs towards the nose on the left side, aft on the right,
        # so text reads correctly from both sides
        u = -fwd if side > 0 else fwd          # text reads left-to-right from outside
        u_bird = fwd                            # emblems face the nose on both sides
        # disc ~0.44 m on the IAF jets (c34, c20, ref_05, c51, ref_03), its centre ~0.32 m under the chine
        out.append(decal(f"Roundel_Fus_{tag}", coll, fus, P(2.80, side * 1.2, 0.02), u, (0, 0, 1), ray,
                         0.46, 0.46, roundel))
        out.append(decal(f"Serial_{tag}", coll, fus, P(2.10, side * 1.2, 0.38), u, (0, 0.10, 1), ray,
                         0.62, 0.232, serial))
        # stencils (photos: F-35A c34 for the left side, Adir 926 at Red Flag for the right side)
        # left: the arrow points at the rescue door's upper-aft corner; right: the box over s ~3.5
        if side > 0:
            out.append(decal_on("Rescue_L", coll, fus, 3.97, side, 0.34, 0.66, 0.3025, rescue[side], nu=24, nv=14))
        else:
            out.append(decal_on("Rescue_R", coll, fus, 3.48, side, 0.20, 0.60, 0.2625, rescue[side], nu=24,
                                nv=14))
        out.append(decal_on(f"EjectWarn_{tag}", coll, fus, 3.82, side, 0.68, 0.26, 0.2925, seat))
        # JET INTAKE: on the forebody / bump side ahead of the inlet lip, aft of the door (not on the cowl)
        out.append(decal_on(f"EjectWarn_Intake_{tag}", coll, fus, 4.10 if side > 0 else 4.00, side,
                            -0.20 if side > 0 else -0.15, 0.30, 0.3375, intake))
        band = obj.get("Canopy_Frame") or bpy.data.objects.get("Canopy_Frame")
        if band is not None:                          # on the frame band (photo c34): opens with the canopy
            from .canopy import sill_z, glass_edge_z
            zw = 0.5 * (sill_z(2.68) + glass_edge_z(2.68))     # middle of the frame band
            out.append(decal_on(f"Stencil_CanopyWarn_{tag}", coll, band, 2.68, side, zw, 0.64, 0.065,
                                canopy_warn, nu=28, nv=6))
        # wings: upper + lower roundels, a 0.45 m disc at about 47 % chord (photos ref_06 of 901 from
        # above, ref_07 of 919 from below); the upper ones sit on a lighter patch (panels.layout)
        wing = obj.get(f"Wing_{tag}")
        if wing is not None:
            out.append(decal(f"Roundel_WingTop_{tag}", coll, wing, P(WING_ROUNDEL[0], side * WING_ROUNDEL[1], 0.6),
                             (side, 0, 0), (0, -1, 0), (0, 0, -1), WING_ROUNDEL[2], WING_ROUNDEL[2], roundel))
            out.append(decal(f"Roundel_WingBot_{tag}", coll, wing, P(WING_ROUNDEL[0], side * WING_ROUNDEL[1], -0.2),
                             (-side, 0, 0), (0, -1, 0), (0, 0, 1), WING_ROUNDEL[2], WING_ROUNDEL[2], roundel))
        # fins: a perched eagle over most of the outer face, aft of the formation-light strip (LE + 0.21 m)
        # and running onto the rudder (its part is a second decal that moves with the rudder), and the
        # serial low on the fin near mid-chord (photos ref_06 of 901, ref_07 of 919)
        fin = obj.get(f"Fin_{tag}")
        if fin is not None:
            from .tails import FIN_CANT, FIN_ROOT
            span = Vector((side * math.sin(FIN_CANT), 0, math.cos(FIN_CANT)))
            nrm = Vector((side * math.cos(FIN_CANT), 0, -math.sin(FIN_CANT)))
            root = P(0.0, side * FIN_ROOT[0], FIN_ROOT[1])
            centre = root + Vector((0, 13.52, 0)) + span * 1.02
            for part, target in (("", fin), ("_Rudder", obj.get(f"Rudder_{tag}"))):
                if target is not None:
                    out.append(decal(f"Eagle_Fin{part}_{tag}", coll, target, centre + nrm * 0.3, u_bird, span, -nrm,
                                     1.40, 1.40, eagle_fin, nu=32, nv=32))
            sc = root + Vector((0, 12.45, 0)) + span * 0.36
            out.append(decal(f"Serial_Fin_{tag}", coll, fin, sc + nrm * 0.3, u, span, -nrm, 0.68, 0.255, serial,
                             nu=24, nv=10))
        # crescent index marks: round the left rescue door (with its two latch stencils) and round the
        # fastened access panel on each inlet side
        if side > 0:
            img = index_marks_image("Index_Marks_Door_L", side, 3.475, -0.05, 0.72, 0.76, DOOR_MARKS, DOOR_LABELS)
            out.append(decal_on("IndexMarks_Door_L", coll, fus, 3.475, side, -0.05, 0.72, 0.76,
                                decal_material("F35_Decal_IndexMarks_Door_L", img), nu=24, nv=24))
        img = index_marks_image(f"Index_Marks_Inlet_{tag}", side, 6.135, -0.115, 0.90, 0.40, INLET_MARKS)
        out.append(decal_on(f"IndexMarks_Inlet_{tag}", coll, fus, 6.135, side, -0.115, 0.90, 0.40,
                            decal_material(f"F35_Decal_IndexMarks_Inlet_{tag}", img), nu=28, nv=14))
        # inlet side eagle (smaller): under the forward formation strip, just ahead of the fastened
        # access panel (photos ref_04, ref_05, ref_07 of three IAF jets)
        out.append(decal(f"Eagle_Inlet_{tag}", coll, fus, P(5.10, side * 2.0, -0.18), u_bird, (0, 0, 1), ray,
                         0.55, 0.55, eagle))
    out = [o for o in out if o is not None]
    ctx["objects"].update({o.name: o for o in out})
    return out
