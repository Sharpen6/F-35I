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


AB_LEN = 4.6            # visible afterburner flame behind the nozzle exit (m)
AB_IN = 13.10           # the glowing gas starts just behind the flame holder (station)
AB_DIAMOND_0 = 0.50     # first shock diamond behind the nozzle exit (m)
AB_DIAMOND_STEP = 0.78  # spacing of the shock cells (about 0.75 nozzle exit diameters)
AB_BODY = 3.6           # emission of the flame envelope at the exit (1/m)
AB_DIAMOND = 18.0       # emission inside the first shock diamond (1/m)


def flame_volume_material(name="F35_AB_Flame"):
    """Afterburner flame as a glowing volume (no surface).

    A cone of hot gas tapers from the nozzle exit: orange near the nozzle, turning pink and fading
    downstream, with a row of yellow-white shock diamonds on the axis that get weaker and smaller.
    A 4D noise that drifts downstream (driven by the frame) makes the envelope flicker; the diamonds
    stay put, as standing shock waves do.  The inside of the nozzle glows as well.
    Strength = object property 'ab' (0..1, driven by the throttle above MIL)."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    for n in list(nodes):
        nodes.remove(n)
    out = nodes.new("ShaderNodeOutputMaterial")
    tc = nodes.new("ShaderNodeTexCoord")
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(tc.outputs["Object"], sep.inputs[0])          # object at the origin: world coordinates

    def m(op, a, b=None, clamp=False):
        n = nodes.new("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = float(v)
            else:
                links.new(v, n.inputs[i])
        return n.outputs[0]

    def frame_value(label, expr):
        """A Value node driven by the frame (simple expression: works with auto-run off)."""
        v = nodes.new("ShaderNodeValue")
        v.label = label
        fc = v.outputs[0].driver_add("default_value")
        fc.driver.type = 'SCRIPTED'
        fc.driver.expression = expr
        return v.outputs[0]

    y_exit = P(S_EXIT, 0.0, 0.0)[1]
    X, Y, Z = sep.outputs["X"], sep.outputs["Y"], sep.outputs["Z"]
    d = m('SUBTRACT', Y, y_exit)                                  # metres behind the exit (< 0 inside)
    t01 = m('DIVIDE', d, AB_LEN, clamp=True)
    dz = m('SUBTRACT', Z, NOZ_Z)
    r = m('SQRT', m('ADD', m('MULTIPLY', X, X), m('MULTIPLY', dz, dz)))
    R = m('ADD', m('MULTIPLY', m('POWER', m('SUBTRACT', 1.0, t01), 0.75), 0.47), 0.03)
    q = m('DIVIDE', r, R)

    # turbulence: 4D noise advected downstream, evolving with the frame
    comb = nodes.new("ShaderNodeCombineXYZ")
    links.new(X, comb.inputs["X"])
    links.new(m('SUBTRACT', Y, frame_value("drift", "frame*0.11")), comb.inputs["Y"])
    links.new(Z, comb.inputs["Z"])
    nz = nodes.new("ShaderNodeTexNoise")
    nz.noise_dimensions = '4D'
    nz.inputs["Scale"].default_value = 1.6
    nz.inputs["Detail"].default_value = 3.0
    nz.inputs["Roughness"].default_value = 0.55
    links.new(comb.outputs[0], nz.inputs["Vector"])
    links.new(frame_value("boil", "frame*0.09"), nz.inputs["W"])
    n01 = m('ADD', m('MULTIPLY', m('SUBTRACT', nz.outputs["Fac"], 0.5), 2.2), 0.5, clamp=True)
    qt = m('MULTIPLY', q, m('SUBTRACT', 1.12, m('MULTIPLY', n01, 0.24)))   # ragged edge
    body = m('POWER', m('DIVIDE', m('SUBTRACT', 1.0, qt), 0.35, clamp=True), 1.2)   # plateau, soft rim
    body = m('MULTIPLY', body, m('ADD', 0.55, m('MULTIPLY', n01, 0.9)))     # patchy glow
    fade = m('POWER', m('SUBTRACT', 1.0, t01), 1.5)

    # shock diamonds: a row of double cones on the axis (seen from the side each one is a rhombus,
    # widest at its centre), one every AB_DIAMOND_STEP from AB_DIAMOND_0, shrinking and fading
    ph = m('DIVIDE', m('SUBTRACT', d, AB_DIAMOND_0), AB_DIAMOND_STEP)
    u = m('SUBTRACT', m('FRACT', m('ADD', ph, 0.5)), 0.5)        # -0.5..0.5, 0 at a diamond centre
    k = m('SUBTRACT', ph, u)                                       # diamond index 0, 1, 2 ...
    started = m('GREATER_THAN', ph, -0.45)
    rd = m('MULTIPLY', R, m('MULTIPLY', m('SUBTRACT', 1.0, m('MULTIPLY', k, 0.09), clamp=True), 0.52))
    w = m('MULTIPLY', rd, m('SUBTRACT', 1.0, m('DIVIDE', m('ABSOLUTE', u), 0.40), clamp=True))
    inside = m('DIVIDE', m('SUBTRACT', w, r), 0.07, clamp=True)    # 7 cm soft edge
    dfade = m('POWER', m('SUBTRACT', 1.0, t01), 1.6)
    dia = m('MULTIPLY', m('MULTIPLY', inside, started), dfade)

    attr = nodes.new("ShaderNodeAttribute")
    attr.attribute_type = 'OBJECT'
    attr.attribute_name = "ab"
    e_body = m('MULTIPLY', m('MULTIPLY', body, fade), AB_BODY)
    e_dia = m('MULTIPLY', dia, AB_DIAMOND)

    ramp = nodes.new("ShaderNodeValToRGB")                     # envelope: orange -> pink downstream
    cr = ramp.color_ramp
    cr.elements[0].position = 0.0
    cr.elements[0].color = (1.0, 0.50, 0.16, 1)
    cr.elements[1].position = 1.0
    cr.elements[1].color = (0.85, 0.28, 0.42, 1)
    mid = cr.elements.new(0.35)
    mid.color = (1.0, 0.38, 0.22, 1)
    links.new(t01, ramp.inputs["Fac"])
    em_b = nodes.new("ShaderNodeEmission")
    links.new(ramp.outputs["Color"], em_b.inputs["Color"])
    links.new(m('MULTIPLY', e_body, attr.outputs["Fac"]), em_b.inputs["Strength"])
    em_d = nodes.new("ShaderNodeEmission")                     # diamonds: yellow-white
    em_d.inputs["Color"].default_value = (1.0, 0.80, 0.50, 1)
    links.new(m('MULTIPLY', e_dia, attr.outputs["Fac"]), em_d.inputs["Strength"])
    add = nodes.new("ShaderNodeAddShader")
    links.new(em_b.outputs[0], add.inputs[0])
    links.new(em_d.outputs[0], add.inputs[1])
    links.new(add.outputs[0], out.inputs["Volume"])
    for key, val in (("homogeneous_volume", False),         # Blender 4.x only
                     ("volume_step_rate", 0.5)):             # diamonds are ~0.15 m thick
        if hasattr(mat.cycles, key):
            setattr(mat.cycles, key, val)
    mat.diffuse_color = (1.0, 0.5, 0.1, 0.3)
    return mat


def build_flame(coll):
    """One closed mesh holds the flame volume: from behind the flame holder, through the nozzle,
    to AB_LEN behind the exit."""
    prof = [(AB_IN, 0.44), (13.62, 0.44), (S_EXIT, 0.52), (S_EXIT + 0.6, 0.53), (S_EXIT + 1.8, 0.47),
            (S_EXIT + 3.2, 0.36), (S_EXIT + AB_LEN, 0.20), (S_EXIT + AB_LEN + 0.15, 0.05)]
    rings = [[P(s_, r * math.cos(2 * math.pi * k / 32), NOZ_Z + r * math.sin(2 * math.pi * k / 32))
              for k in range(32)] for s_, r in prof]
    v, f = loft_rings(rings, True, True, True)
    ob = mesh_object("AB_Flame", v, f, coll, flame_volume_material(), smooth=True)
    bm = bmesh.new()                         # Cycles needs outward normals to know the inside of a volume
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob["ab"] = 0.0
    ob["light"] = "afterburner"
    ob.visible_shadow = False
    ob.visible_diffuse = False               # no noisy glow on the apron; reflections still see it
    return [ob]


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
