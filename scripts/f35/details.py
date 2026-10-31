"""Small but characteristic details placed on the finished skin:

* EOTS faceted sapphire window under the chin
* six DAS (distributed aperture system) windows, L-shaped air-data probes
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


def hex_on_skin(name, coll, mat, p, n, along, rx, ry, h=0.004):
    """Flat hexagonal window on the skin (DAS aperture): rx along `along`, ry across."""
    n = Vector(n).normalized()
    a = Vector(along)
    a = (a - n * a.dot(n)).normalized()
    b = n.cross(a)
    ring = [(rx, 0.0), (0.5 * rx, ry), (-0.5 * rx, ry), (-rx, 0.0), (-0.5 * rx, -ry), (0.5 * rx, -ry)]
    rings = [[p + a * u + b * w - n * 0.01 for u, w in ring],
             [p + a * u + b * w + n * h for u, w in ring]]
    v, f = loft_rings(rings, True, True, True)
    ob = mesh_object(name, v, f, coll, mat, smooth=False)
    _fix(ob)
    return ob


# EOTS: the faceted window sits in a shallow fairing under the chin, its back
# about 0.25 m ahead of the nose-gear doors (photos c34, c51, c53: window at
# stations ~1.3-2.1 m).
EOTS_C = 1.78                     # window centre station (spans ~1.44-2.12)


def build_eots(coll, skin):
    """Faceted EOTS window in a shallow housing under the chin (photos c20, c34:
    a box-like housing whose flat facets face forward, sideways and down).
    The rings are planar, tilted with the chin line, so the facets stay flat;
    the housing collar fills the gap to the curved skin."""
    p, n = skin.bottom(EOTS_C, 0.0)
    if p is None:
        return []
    s0, s1 = EOTS_C - 0.33, EOTS_C + 0.34
    q0, _ = skin.bottom(s0, 0.0)
    q1, _ = skin.bottom(s1, 0.0)
    z0 = q0.z if q0 is not None else p.z
    z1 = q1.z if q1 is not None else p.z

    def plane(s):
        return z0 + (z1 - z0) * (s - s0) / (s1 - s0)

    def ring(cs, rs, rx):
        out = []
        for k in range(7):
            a = math.pi * (0.5 + 2 * k / 7)          # k = 0 at the aft centre; wide facet at the front
            out.append((cs + rs * math.sin(a), rx * math.cos(a)))
        return out

    def skin_dz(pts):
        d = []
        for s, x in pts:
            q, _ = skin.bottom(s, x)
            d.append((q.z if q is not None else plane(s)) - plane(s))
        return d

    top = ring(EOTS_C, 0.34, 0.165)
    mid = ring(EOTS_C + 0.01, 0.30, 0.140)
    bot = ring(EOTS_C + 0.06, 0.15, 0.075)
    d_top = max(skin_dz(top)) + 0.012            # inside the skin everywhere
    d_mid = min(skin_dz(mid)) - 0.006            # just outside it
    ring_top = [P(s, x, plane(s) + d_top) for s, x in top]
    ring_mid = [P(s, x, plane(s) + d_mid) for s, x in mid]
    ring_bot = [P(s, x, plane(s) + d_mid - 0.055) for s, x in bot]
    v, f = loft_rings([ring_top, ring_mid], True, True, False)
    frame = mesh_object("EOTS_Fairing", v, f, coll, M.get("skin"), smooth=False)
    _fix(frame)
    v, f = loft_rings([ring_mid, ring_bot], True, True, True)
    glass = mesh_object("EOTS_Window", v, f, coll, M.get("eots_glass"), smooth=False)
    _fix(glass)
    return [glass, frame]


def build_das(coll, skin):
    """Six DAS apertures.  Seen in photos: one ahead of the windscreen, one
    behind the canopy, one on each lower side of the nose just above the front
    of the nose-gear doors (a small hexagonal window with a pink / teal sheen,
    c34, c51, c53).  The two lower ones (chin and aft belly) are placed on the
    centre line; public photos do not show them clearly."""
    out = []
    mat = M.get("das_window")
    for name, (p, n) in (("DAS_UpperFwd", skin.top(1.60, 0.0)), ("DAS_UpperAft", skin.top(5.12, 0.0))):
        if p is not None:
            out.append(disc_on_skin(name, coll, mat, p, n, 0.062))
    for name, (p, n), along in (("DAS_Cheek_L", skin.side(2.36, -0.10, 1), (0, -1, 0)),
                                ("DAS_Cheek_R", skin.side(2.36, -0.10, -1), (0, -1, 0)),
                                ("DAS_Chin", skin.bottom(2.33, 0.0), (0, -1, 0)),
                                ("DAS_LowerAft", skin.bottom(11.2, 0.0), (0, -1, 0))):
        if p is not None:
            out.append(hex_on_skin(name, coll, mat, p, n, along, 0.068, 0.055))
    return out


def build_air_data(coll, skin):
    """L-shaped air-data probes on the lower sides of the nose (photos c20, c34:
    a short mast with a forward-pointing tube, by the CAUTION HOT panels)."""
    out = []
    mat = M.get("chrome")
    for side, tag in ((1, "L"), (-1, "R")):
        p, n = skin.side(1.95, -0.28, side)
        if p is None:
            continue
        n = Vector(n).normalized()
        elbow = p + n * 0.055
        tip = elbow + Vector((0, -1, 0)) * 0.10
        out.append(cylinder(f"AirData_Mast_{tag}", p - n * 0.01, elbow, 0.010, 0.007, coll, mat, segments=10))
        out.append(cylinder(f"AirData_Tube_{tag}", elbow + Vector((0, 0.008, 0)), tip, 0.007, 0.005, coll, mat,
                            segments=10))
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
    # formation strips: a pair on the outer side of each inlet, aft of the lip
    # (photos c20, c51, c53: stations ~4.9-5.9 m, ~0.16 m up), and the aft fuselage sides
    for sign, tag in ((1, "L"), (-1, "R")):
        for k, (s, z, ln) in enumerate(((5.08, 0.16, 0.34), (5.62, 0.165, 0.34), (10.9, 0.18, 0.50))):
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
    for ob in (build_eots(coll, skin) + build_das(coll, skin) + build_air_data(coll, skin)
               + build_antennas(coll, skin)
               + build_gun(coll) + build_receptacle(coll)):
        objs[ob.name] = ob
    for ob in build_lights(lights, skin) + build_flame(lights):
        objs[ob.name] = ob
    hook = build_tailhook(coll, skin)
    if hook:
        objs["Tailhook"] = hook[0]
    ctx["objects"].update(objs)
    return objs
