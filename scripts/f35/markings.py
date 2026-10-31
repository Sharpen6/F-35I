"""Israeli Air Force markings as decals that hug the skin:

* low-visibility roundels (Star of David) on the forward fuselage sides,
  upper and lower wing surfaces
* three-digit IAF serial (9xx) on the nose sides
* squadron eagle on the outer faces of both fins and on the inlet sides
  (an original stylised drawing, not a copy of the real emblem artwork)
* RESCUE stencil and ejection-seat warning triangle below the canopy

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
STAR_BLUE = (0.12, 0.20, 0.42)
DISC = (0.80, 0.83, 0.86)
MARK_WHITE = (0.82, 0.84, 0.86)


# ---------------------------------------------------------------- painting
def _stroke(c, pts, t, col=(1, 1, 1)):
    for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
        c.line(x0, y0, x1, y1, col, t)
    for x, y in pts:
        c.circle(x, y, t / 2, col)


def _alpha_from_rgb(c):
    m = c.px[:, :, :3].max(axis=2) > 0.02
    c.px[:, :, 3] = m.astype(np.float32)


# stroke font for the serial: digits as polylines on a 4 x 7 grid
_DIGITS = {
    "0": [[(0, 0.6), (0, 6.4), (0.6, 7), (3.4, 7), (4, 6.4), (4, 0.6), (3.4, 0), (0.6, 0), (0, 0.6)]],
    "1": [[(1.2, 1.0), (2.4, 0), (2.4, 7)], [(1.2, 7), (3.6, 7)]],
    "2": [[(0, 1.0), (0.8, 0), (3.2, 0), (4, 0.9), (4, 2.6), (0, 7), (4, 7)]],
    "3": [[(0, 0.6), (0.6, 0), (3.4, 0), (4, 0.6), (4, 2.8), (3.3, 3.5), (1.4, 3.5)],
          [(3.3, 3.5), (4, 4.2), (4, 6.4), (3.4, 7), (0.6, 7), (0, 6.4)]],
    "4": [[(3.0, 7), (3.0, 0), (0, 4.8), (4, 4.8)]],
    "5": [[(4, 0), (0.2, 0), (0, 3.2), (3.2, 3.0), (4, 3.8), (4, 6.3), (3.3, 7), (0.6, 7), (0, 6.4)]],
    "6": [[(3.6, 0.2), (1.4, 0), (0, 1.6), (0, 6.4), (0.6, 7), (3.4, 7), (4, 6.4), (4, 4.0), (3.4, 3.4),
           (0.6, 3.4), (0, 4.0)]],
    "7": [[(0, 0), (4, 0), (4, 0.8), (1.4, 7)]],
    "8": [[(0.6, 3.5), (0, 2.9), (0, 0.6), (0.6, 0), (3.4, 0), (4, 0.6), (4, 2.9), (3.4, 3.5), (0.6, 3.5),
           (0, 4.1), (0, 6.4), (0.6, 7), (3.4, 7), (4, 6.4), (4, 4.1), (3.4, 3.5)]],
    "9": [[(4, 3.0), (3.4, 3.6), (0.6, 3.6), (0, 3.0), (0, 0.6), (0.6, 0), (3.4, 0), (4, 0.6), (4, 5.4),
           (2.6, 7), (0.4, 6.8)]],
}


def serial_image(text, name, w=768, h=288, col=MARK_WHITE):
    c = Canvas(w, h, (0, 0, 0))
    gh = h * 0.78
    sc = gh / 7.0
    adv = sc * 5.6
    x0 = (w - adv * len(text) + sc * 1.6) / 2
    y0 = (h - gh) / 2
    for k, ch in enumerate(text):
        for poly in _DIGITS.get(ch, []):
            _stroke(c, [(x0 + k * adv + px * sc, y0 + py * sc) for px, py in poly], sc * 0.95, col)
    _alpha_from_rgb(c)
    return c.to_image(name)


def eagle_image(name, size=1024, col=MARK_WHITE, t=None):
    """Original stylised bird-of-prey head (outline style used on IAF jets)."""
    c = Canvas(size, size, (0, 0, 0))
    s = size / 100.0
    t = t or 2.6 * s

    def S(pts):
        return [(x * s, y * s) for x, y in pts]
    # back of head/neck -> crown -> brow -> hooked upper beak
    upper = [(18, 94), (15, 80), (16, 66), (21, 52), (29, 40), (39, 30), (51, 23), (62, 20), (71, 21),
             (78, 24), (84, 28), (89, 32), (93, 37), (96, 43), (96, 50), (93, 54), (91, 50), (88, 47)]
    gape = [(88, 47), (80, 47), (71, 45)]
    lower = [(88, 47), (85, 51), (78, 53), (71, 52)]
    throat = [(71, 52), (64, 58), (57, 67), (52, 78), (49, 90), (48, 97)]
    brow = [(56, 28), (64, 25), (72, 26), (78, 30)]
    nare = [(84, 36), (87, 38)]
    feathers = [[(28, 62), (36, 70), (31, 78)], [(36, 52), (44, 60), (40, 69)], [(26, 78), (33, 86), (28, 94)],
                [(42, 72), (47, 80), (43, 90)]]
    for poly in [upper, gape, lower, throat, brow, nare] + feathers:
        _stroke(c, S(poly), t)
    c.circle(68 * s, 33 * s, 3.4 * s, col)              # eye
    c.circle(68.6 * s, 33 * s, 1.5 * s, (0, 0, 0))
    _alpha_from_rgb(c)
    c.px[:, :, :3] = np.where(c.px[:, :, 3:4] > 0, np.array(col, dtype=np.float32), 0.0)
    return c.to_image(name)


def rescue_image(name, w=512, h=256):
    c = Canvas(w, h, (0, 0, 0))
    c.rect(8, 8, w - 8, h - 8, MARK_WHITE, fill=False, t=8)
    c.text(52, 38, "RESCUE", MARK_WHITE, scale=11)
    c.line(60, 160, 420, 160, MARK_WHITE, 12)
    c.line(420, 160, 380, 130, MARK_WHITE, 12)
    c.line(420, 160, 380, 190, MARK_WHITE, 12)
    _alpha_from_rgb(c)
    return c.to_image(name)


def triangle_image(name, size=256):
    c = Canvas(size, size, (0, 0, 0))
    cx = size / 2

    def tri(r, col):
        pts = [(cx - r, size * 0.16), (cx + r, size * 0.16), (cx, size * 0.16 + r * 1.732)]
        m = np.ones((size, size), dtype=bool)
        for i in range(3):
            (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % 3]
            cr = (x1 - x0) * (c.yy - y0) - (y1 - y0) * (c.xx - x0)
            m &= cr <= 0
        c.px[m, :3] = col
    tri(size * 0.42, MARK_WHITE)
    tri(size * 0.30, (0.55, 0.06, 0.04))
    tri(size * 0.12, MARK_WHITE)
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
    roundel = decal_material("F35_Decal_Roundel", roundel_image("IAF_Roundel", 512, STAR_BLUE, DISC))
    serial = decal_material("F35_Decal_Serial", serial_image(SERIAL, "IAF_Serial"))
    eagle = decal_material("F35_Decal_Eagle", eagle_image("Sqn_Eagle"))
    rescue = decal_material("F35_Decal_Rescue", rescue_image("Rescue_Stencil"))
    tri = decal_material("F35_Decal_Triangle", triangle_image("Eject_Warning"))
    out = []
    for side, tag in ((1, "L"), (-1, "R")):
        ray = Vector((-side, 0, 0))
        fwd = Vector((0, -1, 0))
        # decal "u" runs towards the nose on the left side, aft on the right,
        # so text reads correctly from both sides
        u = -fwd if side > 0 else fwd          # text reads left-to-right from outside
        u_bird = fwd                            # emblems face the nose on both sides
        out.append(decal(f"Roundel_Fus_{tag}", coll, fus, P(2.80, side * 1.2, 0.02), u, (0, 0, 1), ray,
                         0.56, 0.56, roundel))
        out.append(decal(f"Serial_{tag}", coll, fus, P(2.10, side * 1.2, 0.38), u, (0, 0.10, 1), ray,
                         0.62, 0.232, serial))
        out.append(decal(f"Rescue_{tag}", coll, fus, P(3.55, side * 1.2, 0.30), u, (0, 0, 1), ray,
                         0.30, 0.15, rescue))
        out.append(decal(f"EjectWarn_{tag}", coll, fus, P(4.15, side * 1.2, 0.24), u, (0, 0, 1), ray,
                         0.17, 0.17, tri))
        # wings: upper + lower roundels
        wing = obj.get(f"Wing_{tag}")
        if wing is not None:
            out.append(decal(f"Roundel_WingTop_{tag}", coll, wing, P(10.35, side * 3.0, 0.6), (side, 0, 0),
                             (0, -1, 0), (0, 0, -1), 1.0, 1.0, roundel))
            out.append(decal(f"Roundel_WingBot_{tag}", coll, wing, P(10.35, side * 3.0, -0.2), (-side, 0, 0),
                             (0, -1, 0), (0, 0, 1), 1.0, 1.0, roundel))
        # fins: eagle on the outer face
        fin = obj.get(f"Fin_{tag}")
        if fin is not None:
            cant = math.radians(20.0)
            span = Vector((side * math.sin(cant), 0, math.cos(cant)))
            nrm = Vector((side * math.cos(cant), 0, -math.sin(cant)))
            centre = P(13.32, side * 1.42, 0.35) + span * 1.35
            out.append(decal(f"Eagle_Fin_{tag}", coll, fin, centre + nrm * 0.3, u_bird, span, -nrm, 1.36, 1.36,
                             eagle))
        # inlet side eagle (smaller)
        out.append(decal(f"Eagle_Inlet_{tag}", coll, fus, P(6.85, side * 2.0, -0.18), u_bird, (0, 0, 1), ray,
                         0.55, 0.55, eagle))
    ctx["objects"].update({o.name: o for o in out})
    return out
