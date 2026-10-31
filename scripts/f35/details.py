"""Small but characteristic details placed on the finished skin:

* EOTS faceted sapphire window under the chin
* six DAS (distributed aperture system) windows
* blade / flush antennas
* position (red / green / white), formation strip and anti-collision lights
* semi-recessed arresting hook (rigged)
* GAU-22/A barrels behind the gun door, refuelling receptacle
* afterburner plume (core + outer glow) driven by the throttle
"""
import math
import bmesh
import bpy
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

from .geom import P, get_collection, mesh_object, cylinder, uv_sphere, add_solidify, loft_rings
from .surfaces import set_hinge
from .nozzle import S_EXIT, R_EXIT
from .fuselage import NOZ_Z
from . import materials as M


class Skin:
    def __init__(self, ob):
        dg = bpy.context.evaluated_depsgraph_get()
        self.bvh = BVHTree.FromObject(ob, dg)

    def hit(self, origin, direction):
        d = Vector(direction).normalized()
        h = self.bvh.ray_cast(Vector(origin), d, 30.0)
        return (h[0], h[1]) if h[0] is not None else (None, None)

    def top(self, s, x):
        return self.hit(P(s, x, 5.0), (0, 0, -1))

    def bottom(self, s, x):
        return self.hit(P(s, x, -5.0), (0, 0, 1))

    def side(self, s, z, sign):
        return self.hit(P(s, sign * 5.0, z), (-sign, 0, 0))


def _fix(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()


def disc_on_skin(name, coll, mat, p, n, r, h=0.004, seg=20):
    """Flush window: short cylinder sitting on the skin, axis = normal."""
    n = Vector(n).normalized()
    return cylinder(name, p - n * 0.01, p + n * h, r, r * 0.97, coll, mat, segments=seg)


def strip_on_skin(name, coll, mat, p, n, along, length, width, h=0.004):
    n = Vector(n).normalized()
    a = Vector(along)
    a = (a - n * a.dot(n)).normalized()
    b = n.cross(a)
    v = []
    for i in (-0.5, 0.5):
        for j in (-0.5, 0.5):
            for k in (-1.0, 1.0):
                v.append(p + a * (length * i) + b * (width * j) + n * (h if k > 0 else -0.01))
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    ob = mesh_object(name, v, f, coll, mat, smooth=False)
    _fix(ob)
    return ob


def blade(name, coll, base, n, along, height, chord, sweep=0.5, thick=0.012, mat=None):
    n = Vector(n).normalized()
    a = Vector(along)
    a = (a - n * a.dot(n)).normalized()
    pts = [base - a * chord * 0.5, base + a * chord * 0.5,
           base + a * (chord * 0.5 + sweep * height * 0.3) + n * height * 0.9,
           base + a * (-chord * 0.1 + sweep * height) + n * height]
    ob = mesh_object(name, pts, [(0, 1, 2, 3)], coll, mat or M.get("skin"), smooth=False)
    add_solidify(ob, thick, 0.0)
    return ob


def build_eots(coll, skin):
    """Faceted EOTS window cluster under the chin (7 facets)."""
    s0, s1 = 1.98, 2.58
    p, n = skin.bottom(2.28, 0.0)
    if p is None:
        return []
    zc = p.z
    # facet ring: heptagonal frustum hanging below the chin
    top_w, bot_w, depth = 0.17, 0.09, 0.105
    ring_top, ring_bot = [], []
    for k in range(7):
        a = math.pi * (0.5 + 2 * k / 7)
        ring_top.append(P(2.30 + 0.24 * math.sin(a), top_w * math.cos(a), zc + 0.03))
        ring_bot.append(P(2.25 + 0.12 * math.sin(a), bot_w * math.cos(a), zc - depth))
    v, f = loft_rings([ring_top, ring_bot], True, True, True)
    glass = mesh_object("EOTS_Window", v, f, coll, M.get("eots_glass"), smooth=False)
    _fix(glass)
    # fairing ahead/behind the window
    fair = []
    for s, w, d in ((s0, 0.02, 0.0), (2.12, 0.15, 0.06), (2.46, 0.19, 0.08), (s1, 0.06, 0.0)):
        ring = []
        for k in range(12):
            a = 2 * math.pi * k / 12
            ring.append(P(s, w * math.cos(a), zc + 0.02 - d * max(0.0, -math.sin(a)) + 0.02 * math.sin(a)))
        fair.append(ring)
    v, f = loft_rings(fair, True, True, True)
    fo = mesh_object("EOTS_Fairing", v, f, coll, M.get("skin"), smooth=True, sharp_angle=40)
    _fix(fo)
    return [glass, fo]


def build_das(coll, skin):
    out = []
    mat = M.get("das_window")
    spots = [("DAS_UpperFwd", skin.top(1.60, 0.0)), ("DAS_UpperAft", skin.top(5.12, 0.0)),
             ("DAS_Cheek_L", skin.side(3.55, 0.10, 1)), ("DAS_Cheek_R", skin.side(3.55, 0.10, -1)),
             ("DAS_Chin_L", skin.bottom(2.95, 0.36)), ("DAS_Chin_R", skin.bottom(2.95, -0.36))]
    for name, (p, n) in spots:
        if p is None:
            continue
        out.append(disc_on_skin(name, coll, mat, p, n, 0.062))
    return out


def build_antennas(coll, skin):
    out = []
    for name, (p, n), along, h in (
            ("Antenna_Spine", skin.top(9.6, 0.0), (0, 1, 0), 0.10),
            ("Antenna_Belly_Fwd", skin.bottom(5.75, 0.0), (0, 1, 0), 0.085),
            ("Antenna_Belly_Aft", skin.bottom(11.6, 0.0), (0, 1, 0), 0.08)):
        if p is None:
            continue
        out.append(blade(name, coll, p, n, along, h, 0.16))
    return out


def build_lights(coll, skin):
    out = []
    # position lights: red port (left, +x), green starboard, white tail
    for name, sign, mat in (("NavLight_L", 1, "nav_red"), ("NavLight_R", -1, "nav_green")):
        p, n = skin.side(12.45, 0.18, sign)
        if p is not None:
            ob = uv_sphere(name, p + n * 0.01, (0.035, 0.05, 0.03), coll, M.get(mat), seg=16, rings=8)
            ob["light"] = "nav"
            out.append(ob)
    p, n = skin.top(14.2, 0.0)
    if p is not None:
        ob = uv_sphere("NavLight_Tail", p + n * 0.012, (0.03, 0.04, 0.025), coll, M.get("nav_white"), seg=16,
                       rings=8)
        ob["light"] = "nav"
        out.append(ob)
    # formation strips: forward fuselage sides + aft fuselage sides
    for sign, tag in ((1, "L"), (-1, "R")):
        for k, (s, z, ln) in enumerate(((3.85, 0.30, 0.42), (10.9, 0.18, 0.50))):
            p, n = skin.side(s, z, sign)
            if p is None:
                continue
            ob = strip_on_skin(f"FormLight_{tag}{k}", coll, M.get("formation"), p, n, (0, 1, 0.12), ln, 0.035)
            ob["light"] = "formation"
            out.append(ob)
    # anti-collision beacons (spine + belly)
    for name, (p, n) in (("Beacon_Top", skin.top(6.70, 0.0)), ("Beacon_Bottom", skin.bottom(6.30, 0.0))):
        if p is not None:
            ob = uv_sphere(name, p + n * 0.012, (0.05, 0.07, 0.03), coll, M.get("beacon"), seg=16, rings=8)
            ob["light"] = "beacon"
            out.append(ob)
    return out


def build_tailhook(coll, skin):
    """Arresting hook stowed flush under the aft fuselage, hinged at its front;
    it follows the lower contour up toward the nozzle."""
    p0, n0 = skin.bottom(11.95, 0.0)
    p1, n1 = skin.bottom(13.05, 0.0)
    if p0 is None or p1 is None:
        return []
    hinge = p0 + Vector((0, 0, 0.05))
    tip = p1 + Vector((0, 0, 0.035))
    arm = cylinder("Tailhook", hinge, tip, 0.045, 0.040, coll, M.get("marking_grey"), segments=12)
    shoe = cylinder("Tailhook_Shoe", tip + Vector((0, -0.05, 0.01)), tip + Vector((0, 0.10, -0.06)), 0.055,
                    0.035, coll, M.get("chrome"), segments=12)
    shoe.parent = arm
    # bright hook-point stripe (yellow/black is typical)
    band = cylinder("Tailhook_Band", tip - Vector((0, 0.25, 0)), tip - Vector((0, 0.10, 0)), 0.047, None, coll,
                    M.get("marking_yellow"), segments=12)
    band.parent = arm
    a = hinge + Vector((0.3, 0, 0))
    b = hinge + Vector((-0.3, 0, 0))
    set_hinge(arm, a, b, "tailhook", (0.0, 55.0), {"want": [0, 0, -1]})
    return [arm, shoe, band]


def build_gun(coll):
    """GAU-22/A barrel cluster behind the gun door (left shoulder), inside
    the shoulder above the inlet duct (duct top ~0.34 here, skin ~0.54)."""
    out = []
    c0 = P(5.10, 1.30, 0.455)
    for k in range(4):
        a = 2 * math.pi * k / 4 + math.pi / 4
        off = Vector((0.032 * math.cos(a), 0, 0.032 * math.sin(a)))
        out.append(cylinder(f"Gun_Barrel{k}", c0 + off, c0 + off + Vector((0, 0.70, 0)), 0.014, None, coll,
                            M.get("marking_black"), segments=10))
    out.append(cylinder("Gun_Clamp", c0 + Vector((0, 0.05, 0)), c0 + Vector((0, 0.10, 0)), 0.058, None, coll,
                        M.get("gear"), segments=16))
    return out


def build_receptacle(coll):
    p = P(5.80, 0.0, 1.08)
    d = Vector((0, -0.6, 0.8)).normalized()
    return [cylinder("Refuel_Receptacle", p - d * 0.08, p + d * 0.05, 0.05, 0.035, coll, M.get("chrome"),
                     segments=16)]


def flame_material(name, core):
    """Emission shell, fades along the plume; strength = object 'ab' prop."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    mix = nt.nodes.new("ShaderNodeMixShader")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    em = nt.nodes.new("ShaderNodeEmission")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    # t = 0 at nozzle, 1 at plume end (plume runs along +Y)
    # diamonds: 0.55 + 0.45 * cos^2(pi * 6 t)
    m1 = nt.nodes.new("ShaderNodeMath")
    m1.operation = 'MULTIPLY'
    m1.inputs[1].default_value = math.pi * 6
    nt.links.new(sep.outputs["Y"], m1.inputs[0])
    cs = nt.nodes.new("ShaderNodeMath")
    cs.operation = 'COSINE'
    nt.links.new(m1.outputs[0], cs.inputs[0])
    sq = nt.nodes.new("ShaderNodeMath")
    sq.operation = 'MULTIPLY'
    nt.links.new(cs.outputs[0], sq.inputs[0])
    nt.links.new(cs.outputs[0], sq.inputs[1])
    dia = nt.nodes.new("ShaderNodeMath")
    dia.operation = 'MULTIPLY_ADD'
    dia.inputs[1].default_value = 0.45 if core else 0.15
    dia.inputs[2].default_value = 0.55 if core else 0.85
    nt.links.new(sq.outputs[0], dia.inputs[0])
    # fade = (1 - t)^1.6
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = 'SUBTRACT'
    inv.inputs[0].default_value = 1.0
    nt.links.new(sep.outputs["Y"], inv.inputs[1])
    fade = nt.nodes.new("ShaderNodeMath")
    fade.operation = 'POWER'
    fade.inputs[1].default_value = 1.6 if core else 2.2
    fade.use_clamp = True
    nt.links.new(inv.outputs[0], fade.inputs[0])
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_type = 'OBJECT'
    attr.attribute_name = "ab"
    k = nt.nodes.new("ShaderNodeMath")
    k.operation = 'MULTIPLY'
    nt.links.new(fade.outputs[0], k.inputs[0])
    nt.links.new(attr.outputs["Fac"], k.inputs[1])
    strength = nt.nodes.new("ShaderNodeMath")
    strength.operation = 'MULTIPLY'
    nt.links.new(k.outputs[0], strength.inputs[0])
    nt.links.new(dia.outputs[0], strength.inputs[1])
    gain = nt.nodes.new("ShaderNodeMath")
    gain.operation = 'MULTIPLY'
    gain.inputs[1].default_value = 10.0 if core else 3.0
    nt.links.new(strength.outputs[0], gain.inputs[0])
    nt.links.new(gain.outputs[0], em.inputs["Strength"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    if core:
        cr.elements[0].color = (0.75, 0.85, 1.0, 1)
        cr.elements[1].color = (1.0, 0.55, 0.18, 1)
    else:
        cr.elements[0].color = (1.0, 0.62, 0.25, 1)
        cr.elements[1].color = (1.0, 0.30, 0.05, 1)
    nt.links.new(sep.outputs["Y"], ramp.inputs[0])
    nt.links.new(ramp.outputs["Color"], em.inputs["Color"])
    a = nt.nodes.new("ShaderNodeMath")
    a.operation = 'MULTIPLY'
    a.inputs[1].default_value = 0.65 if core else 0.22
    a.use_clamp = True
    nt.links.new(k.outputs[0], a.inputs[0])
    nt.links.new(a.outputs[0], mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    try:
        mat.surface_render_method = 'BLENDED'
    except Exception:
        pass
    mat.diffuse_color = (1.0, 0.5, 0.1, 0.3)
    return mat


def build_flame(coll):
    out = []
    for name, length, r0, r1, core in (("AB_Flame_Core", 3.0, 0.26, 0.04, True),
                                       ("AB_Flame_Outer", 4.4, 0.40, 0.08, False)):
        rings = []
        n = 24
        for i in range(n + 1):
            t = i / n
            s = S_EXIT + 0.02 + length * t
            r = r0 + (r1 - r0) * (t ** 0.8) + (0.04 if not core else 0.0) * math.sin(math.pi * t)
            rings.append([P(s, r * math.cos(2 * math.pi * k / 28), NOZ_Z + r * math.sin(2 * math.pi * k / 28))
                          for k in range(28)])
        v, f = loft_rings(rings, True, True, True)
        ob = mesh_object(name, v, f, coll, flame_material("F35_" + name, core), smooth=True)
        ob["ab"] = 0.0
        ob["light"] = "afterburner"
        ob.visible_shadow = False
        try:
            ob.visible_volume_scatter = False
        except Exception:
            pass
        out.append(ob)
    return out


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Details", root)
    lights = get_collection("Lights", root)
    fus = ctx["objects"]["Fuselage"]
    skin = Skin(fus)
    objs = {}
    for ob in (build_eots(coll, skin) + build_das(coll, skin) + build_antennas(coll, skin)
               + build_gun(coll) + build_receptacle(coll)):
        objs[ob.name] = ob
    for ob in build_lights(lights, skin) + build_flame(lights):
        objs[ob.name] = ob
    hook = build_tailhook(coll, skin)
    if hook:
        objs["Tailhook"] = hook[0]
    ctx["objects"].update(objs)
    return objs
