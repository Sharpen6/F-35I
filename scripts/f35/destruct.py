"""Destructible F-35I: damage zones, hitboxes, breakable parts.

The physics lives in ``scripts/damage/f35_damage.py`` (pure Python); this
module ties it to the Blender model.

prepare(ctx)  runs before the rig.  It fractures the breakable parts with
              jagged cutters (exact booleans): every cut object X gets
              ``X_Stub_<comp>`` (what stays on the aircraft, burnt edge)
              and ``X_Frag_<comp>`` (the piece that breaks away).  It also
              writes damage-zone weights on the fuselage and wings, and
              adds the smoke / fuel-vapour trails.
build(ctx)    runs after the rig.  It adds ``health_<comp>`` (0..1) and
              ``break_frame_<comp>`` properties to F35I_Rig and drives with
              them: soot on the skin, which variant of each part is shown,
              the ballistic motion of the pieces that break off, smoke,
              and the collapse of a destroyed landing-gear leg.  It fits an
              oriented hitbox to every component (``HB_<comp>`` wire boxes,
              not rendered), measures the ground attitude after a gear
              collapse, and exports everything to data/damage_model.json.

Helpers for animation scripts (run inside Blender):
    set_health(comp, value, frame)     break_off(comp, frame)
    impact(origin, direction, hp, frame)  -> scorch decal + health loss
    blast(centre, hp, radius, frame)
    flight_response(frame, mach, alt)  -> keys bank / sideslip from the simulator
    collapse_gear(comp, frame)
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

from .geom import GROUND_Z, P, Y0, boolean, get_collection, mesh_object, set_origin

HERE = os.path.dirname(os.path.abspath(__file__))
DAMAGE_DIR = os.path.join(os.path.dirname(HERE), "damage")
if DAMAGE_DIR not in sys.path:
    sys.path.insert(0, DAMAGE_DIR)
import f35_damage as sim  # noqa: E402

FPS = 24
DEBRIS_LIFE = 96            # frames a broken-off piece stays visible
RANK = {"wing_root": 3, "lef": 2, "flaperon": 2, "wing_outer": 1}


def _rank(comp):
    for k, v in RANK.items():
        if comp.startswith(k):
            return v
    return 1


# ------------------------------------------------------------- materials
def burnt_material():
    name = "F35_Burnt"
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    b = nodes["Principled BSDF"]
    tc = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 16.0
    noise.inputs["Detail"].default_value = 8.0
    noise.inputs["Roughness"].default_value = 0.7
    links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.30
    ramp.color_ramp.elements[0].color = (0.010, 0.009, 0.008, 1)
    ramp.color_ramp.elements[1].position = 0.80
    ramp.color_ramp.elements[1].color = (0.13, 0.11, 0.09, 1)
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.85
    b.inputs["Metallic"].default_value = 0.45
    # glowing embers in the cracks, object property 'embers' (0..1)
    emb = nodes.new("ShaderNodeAttribute")
    emb.attribute_type = 'OBJECT'
    emb.attribute_name = "embers"
    cr = nodes.new("ShaderNodeMapRange")
    cr.inputs["From Min"].default_value = 0.58
    cr.inputs["From Max"].default_value = 0.72
    links.new(noise.outputs["Fac"], cr.inputs["Value"])
    mul = nodes.new("ShaderNodeMath")
    mul.operation = 'MULTIPLY'
    links.new(cr.outputs["Result"], mul.inputs[0])
    links.new(emb.outputs["Fac"], mul.inputs[1])
    mul2 = nodes.new("ShaderNodeMath")
    mul2.operation = 'MULTIPLY'
    mul2.inputs[1].default_value = 12.0
    links.new(mul.outputs[0], mul2.inputs[0])
    b.inputs["Emission Color"].default_value = (1.0, 0.33, 0.05, 1)
    links.new(mul2.outputs[0], b.inputs["Emission Strength"])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], b.inputs["Normal"])
    mat.diffuse_color = (0.03, 0.028, 0.025, 1)
    return mat


def scorch_material():
    """Impact mark for decals: torn hole, scorched ring, fading soot."""
    name = "F35_Scorch"
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    b = nodes["Principled BSDF"]
    tc = nodes.new("ShaderNodeTexCoord")
    sub = nodes.new("ShaderNodeVectorMath")
    sub.operation = 'SUBTRACT'
    sub.inputs[1].default_value = (0.5, 0.5, 0.0)
    links.new(tc.outputs["UV"], sub.inputs[0])
    ln = nodes.new("ShaderNodeVectorMath")
    ln.operation = 'LENGTH'
    links.new(sub.outputs[0], ln.inputs[0])
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 9.0
    noise.inputs["Detail"].default_value = 6.0
    links.new(tc.outputs["UV"], noise.inputs["Vector"])
    jit = nodes.new("ShaderNodeMath")              # r + (noise - 0.5) * 0.16
    jit.operation = 'MULTIPLY_ADD'
    jit.inputs[1].default_value = 0.16
    jit.inputs[2].default_value = -0.08
    links.new(noise.outputs["Fac"], jit.inputs[0])
    r = nodes.new("ShaderNodeMath")
    r.operation = 'ADD'
    links.new(ln.outputs["Value"], r.inputs[0])
    links.new(jit.outputs[0], r.inputs[1])
    hole = nodes.new("ShaderNodeMapRange")
    hole.interpolation_type = 'SMOOTHSTEP'
    hole.inputs["From Min"].default_value = 0.11
    hole.inputs["From Max"].default_value = 0.08
    links.new(r.outputs[0], hole.inputs["Value"])
    soot = nodes.new("ShaderNodeMapRange")
    soot.interpolation_type = 'SMOOTHSTEP'
    soot.inputs["From Min"].default_value = 0.47
    soot.inputs["From Max"].default_value = 0.14
    links.new(r.outputs[0], soot.inputs["Value"])
    col = nodes.new("ShaderNodeMix")
    col.data_type = 'RGBA'
    col.inputs["A"].default_value = (0.025, 0.022, 0.019, 1)
    col.inputs["B"].default_value = (0.0, 0.0, 0.0, 1)
    links.new(hole.outputs["Result"], col.inputs["Factor"])
    links.new(col.outputs["Result"], b.inputs["Base Color"])
    a = nodes.new("ShaderNodeMath")
    a.operation = 'MAXIMUM'
    links.new(hole.outputs["Result"], a.inputs[0])
    links.new(soot.outputs["Result"], a.inputs[1])
    links.new(a.outputs[0], b.inputs["Alpha"])
    b.inputs["Roughness"].default_value = 0.95
    ring = nodes.new("ShaderNodeMapRange")          # hot rim around the hole
    ring.interpolation_type = 'SMOOTHSTEP'
    ring.inputs["From Min"].default_value = 0.17
    ring.inputs["From Max"].default_value = 0.10
    links.new(r.outputs[0], ring.inputs["Value"])
    rr = nodes.new("ShaderNodeMath")
    rr.operation = 'SUBTRACT'
    links.new(ring.outputs["Result"], rr.inputs[0])
    links.new(hole.outputs["Result"], rr.inputs[1])
    emb = nodes.new("ShaderNodeAttribute")
    emb.attribute_type = 'OBJECT'
    emb.attribute_name = "embers"
    em = nodes.new("ShaderNodeMath")
    em.operation = 'MULTIPLY'
    links.new(rr.outputs[0], em.inputs[0])
    links.new(emb.outputs["Fac"], em.inputs[1])
    em2 = nodes.new("ShaderNodeMath")
    em2.operation = 'MULTIPLY'
    em2.inputs[1].default_value = 14.0
    links.new(em.outputs[0], em2.inputs[0])
    b.inputs["Emission Color"].default_value = (1.0, 0.36, 0.06, 1)
    links.new(em2.outputs[0], b.inputs["Emission Strength"])
    try:
        mat.surface_render_method = 'DITHERED'
    except Exception:
        pass
    mat.diffuse_color = (0.02, 0.02, 0.02, 1)
    return mat


def hitbox_material():
    name = "F35_Hitbox"
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    for n in list(nodes):
        nodes.remove(n)
    out = nodes.new("ShaderNodeOutputMaterial")
    info = nodes.new("ShaderNodeObjectInfo")
    em = nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 3.0
    links.new(info.outputs["Color"], em.inputs["Color"])
    links.new(em.outputs["Emission"], out.inputs["Surface"])
    mat.diffuse_color = (1.0, 0.5, 0.1, 1)
    return mat


def smoke_material(name, color, emission=None):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    for n in list(nodes):
        nodes.remove(n)
    out = nodes.new("ShaderNodeOutputMaterial")
    vol = nodes.new("ShaderNodeVolumePrincipled")
    vol.inputs["Color"].default_value = (*color, 1)
    vol.inputs["Anisotropy"].default_value = 0.3
    tc = nodes.new("ShaderNodeTexCoord")
    mp = nodes.new("ShaderNodeMapping")                 # stretch the noise along the trail
    mp.inputs["Scale"].default_value = (1.6, 0.25, 1.6)
    links.new(tc.outputs["Object"], mp.inputs["Vector"])
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 2.5
    noise.inputs["Detail"].default_value = 6.0
    noise.inputs["Roughness"].default_value = 0.65
    links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    shape = nodes.new("ShaderNodeMapRange")
    shape.inputs["From Min"].default_value = 0.42
    shape.inputs["From Max"].default_value = 0.72
    links.new(noise.outputs["Fac"], shape.inputs["Value"])
    # fade along the trail: Generated Y (0 at the source, 1 at the end)
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(tc.outputs["Generated"], sep.inputs[0])
    fade = nodes.new("ShaderNodeMapRange")
    fade.interpolation_type = 'SMOOTHSTEP'
    fade.inputs["From Min"].default_value = 1.0
    fade.inputs["From Max"].default_value = 0.0
    links.new(sep.outputs["Y"], fade.inputs["Value"])
    attr = nodes.new("ShaderNodeAttribute")
    attr.attribute_type = 'OBJECT'
    attr.attribute_name = "smoke"
    m1 = nodes.new("ShaderNodeMath")
    m1.operation = 'MULTIPLY'
    links.new(shape.outputs["Result"], m1.inputs[0])
    links.new(fade.outputs["Result"], m1.inputs[1])
    m2 = nodes.new("ShaderNodeMath")
    m2.operation = 'MULTIPLY'
    links.new(m1.outputs[0], m2.inputs[0])
    links.new(attr.outputs["Fac"], m2.inputs[1])
    m3 = nodes.new("ShaderNodeMath")
    m3.operation = 'MULTIPLY'
    m3.inputs[1].default_value = 6.0
    links.new(m2.outputs[0], m3.inputs[0])
    links.new(m3.outputs[0], vol.inputs["Density"])
    if emission is not None:      # fire glow near the source
        glow = nodes.new("ShaderNodeMapRange")
        glow.inputs["From Min"].default_value = 0.12
        glow.inputs["From Max"].default_value = 0.0
        links.new(sep.outputs["Y"], glow.inputs["Value"])
        fire = nodes.new("ShaderNodeAttribute")
        fire.attribute_type = 'OBJECT'
        fire.attribute_name = "fire"
        g1 = nodes.new("ShaderNodeMath")
        g1.operation = 'MULTIPLY'
        links.new(glow.outputs["Result"], g1.inputs[0])
        links.new(fire.outputs["Fac"], g1.inputs[1])
        g2 = nodes.new("ShaderNodeMath")
        g2.operation = 'MULTIPLY'
        g2.inputs[1].default_value = 30.0
        links.new(g1.outputs[0], g2.inputs[0])
        vol.inputs["Emission Color"].default_value = (*emission, 1)
        links.new(g2.outputs[0], vol.inputs["Emission Strength"])
    links.new(vol.outputs["Volume"], out.inputs["Volume"])
    return mat


# --------------------------------------------------------------- cutters
def _jag(points, amp, step, rng):
    """2-D polyline through `points` with a random zig-zag across it."""
    out = [Vector(points[0])]
    for a, b in zip(points[:-1], points[1:]):
        a, b = Vector(a), Vector(b)
        L = (b - a).length
        n = max(2, int(round(L / step)))
        d = (b - a) / L
        perp = Vector((-d.y, d.x))
        for i in range(1, n):
            t = i / n
            sgn = 1.0 if i % 2 else -1.0
            off = amp * sgn * (0.35 + 0.65 * rng.random())
            out.append(a + (b - a) * t + perp * off + d * (rng.uniform(-0.25, 0.25) * L / n))
        out.append(b)
    return out


def _prism(name, poly, to3d, w0, w1, mat, coll):
    """Closed prism: 2-D polygon `poly` extruded from w0 to w1 via to3d(u, v, w)."""
    n = len(poly)
    bm = bmesh.new()
    lo = [bm.verts.new(to3d(p.x, p.y, w0)) for p in poly]
    hi = [bm.verts.new(to3d(p.x, p.y, w1)) for p in poly]
    bm.faces.new(lo[::-1])
    bm.faces.new(hi)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    me.materials.append(mat)
    ob.hide_render = True
    ob.display_type = 'WIRE'
    return ob


def cutter_wing_outer(sd, coll, mat, rng):
    """Outboard of a diagonal tear from the LEF (x 3.75) to just outboard of
    the flaperon tip (x 4.32), then straight aft through the trailing edge."""
    line = _jag([(3.66, 8.30), (4.32, 11.28), (4.32, 12.70)], 0.045, 0.22, rng)
    poly = line + [Vector((7.5, 12.70)), Vector((7.5, 8.30))]
    return _prism("Cut_wing_outer", poly, lambda x, s, z: Vector((sd * x, s - Y0, z)), -0.6, 1.3, mat, coll)


def cutter_wing_root(sd, coll, mat, rng):
    line = _jag([(2.12, 6.40), (2.12, 13.20)], 0.06, 0.30, rng)
    poly = line + [Vector((7.5, 13.20)), Vector((7.5, 6.40))]
    return _prism("Cut_wing_root", poly, lambda x, s, z: Vector((sd * x, s - Y0, z)), -0.6, 1.3, mat, coll)


def cutter_stab(sd, coll, mat, rng):
    line = _jag([(1.32, 12.30), (1.32, 16.10)], 0.04, 0.25, rng)
    poly = line + [Vector((5.0, 16.10)), Vector((5.0, 12.30))]
    return _prism("Cut_stab", poly, lambda x, s, z: Vector((sd * x, s - Y0, z)), -0.6, 1.0, mat, coll)


def cutter_fin(sd, coll, mat, rng):
    """Above a tear ~0.3 m up the canted fin (in the fin plane)."""
    from .tails import FIN_CANT, FIN_ROOT
    c, s_ = math.cos(FIN_CANT), math.sin(FIN_CANT)
    x0, z0 = FIN_ROOT
    line = _jag([(10.80, 0.30), (15.40, 0.30)], 0.05, 0.25, rng)      # (s, a)
    poly = line + [Vector((15.40, 4.0)), Vector((10.80, 4.0))]

    def to3d(s, a, w):
        x = x0 + a * s_ + w * c
        z = z0 + a * c - w * s_
        return Vector((sd * x, s - Y0, z))
    return _prism("Cut_fin", poly, to3d, -0.6, 0.6, mat, coll)


def cutter_radome(coll, mat, rng, s_cut=1.20, n=28, R=1.2):
    """Region ahead of a jagged ring tear at the radome joint."""
    bm = bmesh.new()
    ctr = bm.verts.new(P(s_cut, 0.0, 0.0))
    front = bm.verts.new(P(-1.0, 0.0, 0.0))
    rim, fr = [], []
    for i in range(n):
        a = 2 * math.pi * i / n
        ds = 0.05 * (1.0 if i % 2 else -1.0) * (0.35 + 0.65 * rng.random())
        rim.append(bm.verts.new(P(s_cut + ds, R * math.cos(a), R * math.sin(a))))
        fr.append(bm.verts.new(P(-1.0, R * math.cos(a), R * math.sin(a))))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((ctr, rim[i], rim[j]))
        bm.faces.new((rim[j], rim[i], fr[i], fr[j]))
        bm.faces.new((front, fr[j], fr[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("Cut_radome")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Cut_radome", me)
    coll.objects.link(ob)
    me.materials.append(mat)
    ob.hide_render = True
    ob.display_type = 'WIRE'
    return ob


# ------------------------------------------------------------- fractures
HINGE_KEYS = ("hinge_p0", "hinge_p1", "hinge_kind", "limit_min", "limit_max", "side", "door", "want")


def _clone(src, name, coll):
    ob = src.copy()
    ob.data = src.data.copy()
    ob.name = name
    ob.data.name = name
    for k in HINGE_KEYS:
        if k in ob:
            del ob[k]
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    coll.objects.link(ob)
    ob.parent = None
    ob.matrix_world = src.matrix_world.copy()
    ob["variant_of"] = src.name
    return ob


def _centroid(ob):
    mw = ob.matrix_world
    vs = [mw @ v.co for v in ob.data.vertices]
    return sum(vs, Vector()) / max(1, len(vs))


def fracture_specs():
    sp = {"radome": dict(cutter="radome", side=0, cut=["Fuselage"], whole=[])}
    for tag, sd in (("L", 1), ("R", -1)):
        sp[f"wing_outer_{tag}"] = dict(cutter="wing_outer", side=sd, cut=[f"Wing_{tag}", f"LEF_{tag}"], whole=[])
        sp[f"wing_root_{tag}"] = dict(cutter="wing_root", side=sd, cut=[f"Wing_{tag}"],
                                      whole=[f"LEF_{tag}", f"Flaperon_{tag}"])
        sp[f"fin_{tag}"] = dict(cutter="fin", side=sd, cut=[f"Fin_{tag}", f"Rudder_{tag}"], whole=[])
        sp[f"stab_{tag}"] = dict(cutter="stab", side=sd, cut=[f"Stabilator_{tag}"], whole=[])
        sp[f"flaperon_{tag}"] = dict(cutter=None, side=sd, cut=[], whole=[f"Flaperon_{tag}"])
        sp[f"lef_{tag}"] = dict(cutter=None, side=sd, cut=[], whole=[f"LEF_{tag}"])
    return sp


# owner component of each visual object (soot)
def owner_of(name):
    table = {"Wing": "wing_root", "LEF": "lef", "Flaperon": "flaperon", "Fin": "fin", "Rudder": "fin",
             "Stabilator": "stab", "BayDoor_Inner": "weapon_bay", "BayDoor_Outer": "weapon_bay",
             "MainGearDoor": "main_gear"}
    base = name.split("_Stub_")[0].split("_Frag_")[0].split("_Whole_")[0]
    for k, comp in table.items():
        if base.startswith(k + "_"):
            return f"{comp}_{base[-1]}"
    if base.startswith("NoseGearDoor"):
        return "nose_gear"
    if base in ("GunDoor", "GunFairing"):
        return "gun"
    if base == "Canopy_Frame":
        return "cockpit"
    return None


def _zone_weights(ob, kind, sd=0, cut_line=None):
    """Point attributes zone_<z> (0..1) for the skin material."""
    me = ob.data
    mw = ob.matrix_world
    co = [mw @ v.co for v in me.vertices]

    def ss(e0, e1, x):
        t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
        return t * t * (3 - 2 * t)
    if kind == "fuselage":
        bands = {"nose": (-1, 1.20), "fwd": (1.20, 5.20), "center": (5.20, 10.60), "aft": (10.60, 99)}
        for z, (a, b) in bands.items():
            at = me.attributes.get("zone_" + z) or me.attributes.new("zone_" + z, 'FLOAT', 'POINT')
            vals = []
            for p in co:
                s = p.y + Y0
                vals.append(ss(a - 0.25, a + 0.25, s) * (1 - ss(b - 0.25, b + 0.25, s)))
            at.data.foreach_set("value", vals)
    elif kind == "wing":
        at = me.attributes.get("zone_outer") or me.attributes.new("zone_outer", 'FLOAT', 'POINT')
        vals = []
        for p in co:
            s = p.y + Y0
            # straight approximation of the tear line
            xc = 3.66 + (4.32 - 3.66) * min(1.0, max(0.0, (s - 8.30) / (11.28 - 8.30)))
            vals.append(ss(xc - 0.20, xc + 0.05, abs(p.x)))
        at.data.foreach_set("value", vals)


def prepare(ctx):
    """Create stubs / fragments / whole-part copies and the smoke trails."""
    root = ctx["root"]
    coll = get_collection("Damage", root)
    helpers = ctx["helpers"]
    burnt = burnt_material()
    rng = random.Random(35)
    specs = fracture_specs()
    variants = {}       # source name -> list of (variant object, comp, kind)
    debris = {}         # comp -> list of piece objects
    builders = {"wing_outer": cutter_wing_outer, "wing_root": cutter_wing_root,
                "stab": cutter_stab, "fin": cutter_fin}
    # zone weights on the intact meshes first (copied into every variant)
    if "Fuselage" in bpy.data.objects:
        _zone_weights(bpy.data.objects["Fuselage"], "fuselage")
    for tag in ("L", "R"):
        w = bpy.data.objects.get(f"Wing_{tag}")
        if w:
            _zone_weights(w, "wing")
        lef = bpy.data.objects.get(f"LEF_{tag}")
        if lef:
            _zone_weights(lef, "wing")
    for comp, sp in specs.items():
        if not all(n in bpy.data.objects for n in sp["cut"] + sp["whole"]):
            continue
        pieces = []
        if sp["cutter"]:
            if sp["cutter"] == "radome":
                cut = cutter_radome(helpers, burnt, rng)
            else:
                cut = builders[sp["cutter"]](sp["side"], helpers, burnt, rng)
            cut.name = f"Cut_{comp}"
            for name in sp["cut"]:
                src = bpy.data.objects[name]
                stub = _clone(src, f"{name}_Stub_{comp}", coll)
                boolean(stub, cut, 'DIFFERENCE')
                frag = _clone(src, f"{name}_Frag_{comp}", coll)
                boolean(frag, cut, 'INTERSECT')
                if len(frag.data.vertices) == 0:
                    bpy.data.objects.remove(frag)
                    frag = None
                variants.setdefault(name, []).append((stub, comp, "stub"))
                if frag is not None:
                    variants.setdefault(name, []).append((frag, comp, "frag"))
                    pieces.append(frag)
                stub["embers_comp"] = comp
        for name in sp["whole"]:
            src = bpy.data.objects[name]
            cp = _clone(src, f"{name}_Whole_{comp}", coll)
            variants.setdefault(name, []).append((cp, comp, "frag"))
            pieces.append(cp)
        if pieces:
            c = sum((_centroid(p) for p in pieces), Vector()) / len(pieces)
            emp = bpy.data.objects.new(f"Debris_{comp}", None)
            coll.objects.link(emp)
            emp.empty_display_type = 'SPHERE'
            emp.empty_display_size = 0.2
            emp.location = c
            bpy.context.view_layer.update()
            for p in pieces:
                set_origin(p, _centroid(p))
                mw = p.matrix_world.copy()
                p.parent = emp
                p.matrix_parent_inverse = emp.matrix_world.inverted()
                p.matrix_world = mw
            debris[comp] = pieces
            emp["comp"] = comp
    # smoke / vapour trails
    from .nozzle import S_EXIT
    from .fuselage import NOZ_Z
    trails = {}
    trails["Smoke_Engine"] = _trail("Smoke_Engine", coll, P(S_EXIT + 0.05, 0, NOZ_Z), 34.0, 0.45, 3.2,
                                    smoke_material("F35_Smoke", (0.05, 0.05, 0.05), emission=(1.0, 0.4, 0.08)))
    for tag, sd in (("L", 1), ("R", -1)):
        trails[f"Vapour_Wing_{tag}"] = _trail(f"Vapour_Wing_{tag}", coll, P(12.25, sd * 3.1, 0.24), 26.0, 0.10, 1.4,
                                              smoke_material("F35_FuelVapour", (0.85, 0.86, 0.88)))
    ctx["damage_prep"] = {"variants": variants, "debris": debris, "trails": trails}
    return ctx["damage_prep"]


def _trail(name, coll, start, length, r0, r1, mat, n=24, rings=10):
    verts, faces = [], []
    for j in range(rings + 1):
        t = j / rings
        r = r0 + (r1 - r0) * t ** 0.8
        for i in range(n):
            a = 2 * math.pi * i / n
            verts.append(start + Vector((r * math.cos(a), length * t, r * math.sin(a))))
    for j in range(rings):
        for i in range(n):
            a0, a1 = j * n + i, j * n + (i + 1) % n
            faces.append((a0, a1, a1 + n, a0 + n))
    faces.append(tuple(range(n))[::-1])
    faces.append(tuple(rings * n + i for i in range(n)))
    ob = mesh_object(name, verts, faces, coll, mat, smooth=False)
    ob["smoke"] = 0.0
    ob["fire"] = 0.0
    ob.visible_shadow = False
    return ob


# --------------------------------------------------------------- drivers
def _drv(owner, path, expr, arm, comps, index=None, extra=()):
    fc = owner.driver_add(path, index) if index is not None else owner.driver_add(path)
    d = fc.driver
    d.type = 'SCRIPTED'
    for vn, comp in comps.items():
        v = d.variables.new()
        v.name = vn
        v.type = 'SINGLE_PROP'
        v.targets[0].id_type = 'OBJECT'
        v.targets[0].id = arm
        v.targets[0].data_path = f'["{comp}"]'
    for vn, idt, p in extra:
        v = d.variables.new()
        v.name = vn
        v.type = 'SINGLE_PROP'
        v.targets[0].id_type = 'OBJECT'
        v.targets[0].id = idt
        v.targets[0].data_path = p
    d.expression = expr
    return d


SCALE_OFF = 0.00001


def _visibility(ob, vis_expr, arm, comps):
    """Show / hide through delta_scale (1 or ~0).

    Drivers on hide_render / hide_viewport are evaluated in the depsgraph's
    visibility pass, before the rig's properties can be read, and get
    flagged invalid; transform drivers do not have that problem."""
    for i in range(3):
        _drv(ob, "delta_scale", f"{SCALE_OFF} + {1 - SCALE_OFF}*({vis_expr})", arm, comps, i)


def _visible_expr(src_name, variant, comp, kind, specs):
    """Expression (1 = visible) for a variant of src_name and the intact object."""
    cuts = [c for c, s in specs.items() if src_name in s["cut"]]
    wholes = [c for c, s in specs.items() if src_name in s["whole"]]
    allc = cuts + wholes
    names = {c: f"h{i}" for i, c in enumerate(allc)}
    comps = {names[c]: f"health_{c}" for c in allc}
    if variant is None:                                   # intact object
        expr = "*".join(f"({names[c]} > 0)" for c in allc) or "1"
        return expr, comps
    if kind == "stub":
        higher = [c for c in allc if c != comp and _rank(c) >= _rank(comp)]
        expr = f"({names[comp]} <= 0)" + "".join(f"*({names[c]} > 0)" for c in higher)
        return expr, comps
    # fragments / whole copies: only while flying away
    comps = {"h": f"health_{comp}", "bf": f"break_frame_{comp}"}
    return f"(h <= 0)*(frame >= bf)*(frame < bf + {DEBRIS_LIFE})", comps


def _debris_motion(emp, arm, comp, sd, rng):
    """Ballistic motion of a broken-off piece in the aircraft frame."""
    vx = sd * rng.uniform(1.5, 3.0) if sd else rng.uniform(-0.5, 0.5)
    vz = rng.uniform(0.5, 2.0)
    a_aft = rng.uniform(45.0, 70.0)
    gz = (GROUND_Z + 0.08) - emp.matrix_world.translation.z
    t = f"(max(frame - bf, 0)/{FPS})"
    comps = {"bf": f"break_frame_{comp}", "grd": "debris_ground"}
    _drv(emp, "delta_location", f"{vx:.3f}*{t}", arm, comps, 0)
    _drv(emp, "delta_location", f"(1 - grd)*{0.5 * a_aft:.3f}*{t}*{t}", arm, comps, 1)
    _drv(emp, "delta_location", f"max({vz:.3f}*{t} - 4.903*{t}*{t}, {gz:.3f} - 1000*(1 - grd))", arm, comps, 2)
    for i in range(3):
        w = rng.uniform(-9.0, 9.0) * (1.0 if i != 1 else 1.6)
        _drv(emp, "delta_rotation_euler", f"{w:.3f}*{t}*(1 - 0.85*grd*({t} > 0.6))", arm, comps, i)


def zone_driver_specs():
    """dmg_<zone> on the fuselage and wings: 1 - min(health of what is inside)."""
    return {
        "nose": ["radome"],
        "fwd": ["fwd_fuselage", "cockpit"],
        "center": ["center_fuselage", "inlet_L", "inlet_R", "weapon_bay_L", "weapon_bay_R", "fuel_feed", "gun"],
        "aft": ["aft_fuselage", "engine", "nozzle", "ipp"],
    }


def build(ctx):
    arm = bpy.data.objects.get("F35I_Rig")
    if arm is None:
        raise RuntimeError("destruct.build needs the rig")
    prep = ctx.get("damage_prep") or {"variants": {}, "debris": {}, "trails": {}}
    specs = fracture_specs()
    rng = random.Random(7)
    # ------------------------------------------------ health properties
    for comp, c in sim.COMPONENTS.items():
        k = f"health_{comp}"
        arm[k] = 1.0
        arm.id_properties_ui(k).update(min=0.0, max=1.0, soft_min=0.0, soft_max=1.0,
                                       description=f"{c['label']}: 1 intact, 0 destroyed"
                                       + (" (breaks off)" if c.get("detach") else ""))
        if c.get("detach"):
            k2 = f"break_frame_{comp}"
            arm[k2] = -1000.0
            arm.id_properties_ui(k2).update(description="Frame the part breaks off (debris flies from here)")
    arm["debris_ground"] = 0.0
    arm.id_properties_ui("debris_ground").update(min=0.0, max=1.0,
                                                 description="1 = parked on the ground: debris falls and stops on the apron")
    # new ID properties reach the evaluated (copy-on-write) rig only after a
    # tagged update; a driver evaluated before that reads nothing and is
    # flagged invalid for good
    arm.update_tag()
    bpy.context.view_layer.update()
    # --------------------------------------- parent stubs to the source bones
    from .rig import parent_keep
    for src_name, lst in prep["variants"].items():
        src = bpy.data.objects[src_name]
        for ob, comp, kind in lst:
            if kind == "stub":
                if src.parent is arm and src.parent_type == 'BONE':
                    parent_keep(ob, arm, src.parent_bone)
                elif src.parent is not None:
                    mw = ob.matrix_world.copy()
                    ob.parent = src.parent
                    ob.matrix_world = mw
    # ------------------------------------------------ visibility drivers
    for src_name, lst in prep["variants"].items():
        src = bpy.data.objects[src_name]
        expr, comps = _visible_expr(src_name, None, None, None, specs)
        _visibility(src, expr, arm, comps)
        for ob, comp, kind in lst:
            expr, comps = _visible_expr(src_name, ob, comp, kind, specs)
            _visibility(ob, expr, arm, comps)
            if kind == "stub":
                ob["embers"] = 0.0
                _drv(ob, '["embers"]', f"(h <= 0)*max(0, 1 - (frame - bf)/240)*(frame >= bf)", arm,
                     {"h": f"health_{comp}", "bf": f"break_frame_{comp}"})
    # decals sit on parts that can be hidden (scaled away): move them to the Root
    # bone, hide them when the piece under them breaks, clone them onto that piece
    from .rig import parent_keep as _pk
    muted = _mute_visibility(True)                 # measure every piece at full size
    bpy.context.view_layer.update()
    for src_name, lst in prep["variants"].items():
        src = bpy.data.objects[src_name]
        bone = src.parent_bone if (src.parent is arm and src.parent_type == 'BONE') else "Root"
        for kid in [k for k in src.children if k.name.startswith(("Eagle_", "Roundel_", "Serial_", "Rescue_",
                                                                  "EjectWarn_"))]:
            _pk(kid, arm, bone)                    # a rudder decal keeps following the rudder
            holders = [(ob, comp) for ob, comp, kind in lst if kind == "frag" and _inside(kid, ob)]
            if not holders:
                continue
            names = {comp: f"h{i}" for i, (_, comp) in enumerate(holders)}
            vm = {names[c]: f"health_{c}" for _, c in holders}
            _visibility(kid, "*".join(f"({names[c]} > 0)" for _, c in holders), arm, vm)
            for frag, comp in holders:
                cp = kid.copy()
                cp.data = kid.data
                cp.name = f"{kid.name}_Frag_{comp}"
                if cp.animation_data:
                    cp.animation_data_clear()
                for c in kid.users_collection:
                    c.objects.link(cp)
                mw = kid.matrix_world.copy()
                cp.parent = frag                      # inherits the fragment's visibility
                cp.parent_type = 'OBJECT'
                cp.matrix_world = mw
    _mute_visibility(False, muted)
    # ------------------------------------------------- debris motion
    for comp, pieces in prep["debris"].items():
        emp = bpy.data.objects.get(f"Debris_{comp}")
        if emp is not None:
            _debris_motion(emp, arm, comp, specs[comp]["side"], rng)
    # ---------------------------------------------------- soot drivers
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        own = owner_of(ob.name)
        if own and f"health_{own}" in arm:
            ob["damage"] = 0.0
            _drv(ob, '["damage"]', "1 - h", arm, {"h": f"health_{own}"})
        base = ob.get("variant_of", ob.name)
        if base == "Fuselage":
            for z, comps in zone_driver_specs().items():
                ob[f"dmg_{z}"] = 0.0
                own_c, inner = comps[0], comps[1:]
                vm = {"h": f"health_{own_c}"}
                if inner:
                    vm.update({f"i{i}": f"health_{c}" for i, c in enumerate(inner)})
                    inner_min = "min(" + ", ".join(f"i{i}" for i in range(len(inner))) + ")" \
                        if len(inner) > 1 else "i0"
                    expr = f"1 - min(h, 0.35 + 0.65*{inner_min})"
                else:
                    expr = "1 - h"
                _drv(ob, f'["dmg_{z}"]', expr, arm, vm)
        if base.startswith(("Wing_", "LEF_")) and base[-1] in "LR":
            ob["dmg_outer"] = 0.0
            _drv(ob, '["dmg_outer"]', "1 - h", arm, {"h": f"health_wing_outer_{base[-1]}"})
    # ----------------------------------------------------- smoke trails
    tr = prep["trails"]
    if "Smoke_Engine" in tr:
        ob = tr["Smoke_Engine"]
        vm = {"e": "health_engine", "n": "health_nozzle", "f": "health_fuel_feed"}
        _drv(ob, '["smoke"]', "clamp(1.6*(1 - min(e, n)) - 0.25, 0, 1)", arm, vm)
        _drv(ob, '["fire"]', "clamp(((e < 0.5)*(f < 0.6) + (e < 0.2))*1.0, 0, 1)", arm, vm)
        _visibility(ob, "min(e, n) <= 0.84", arm, vm)
    for tag in ("L", "R"):
        ob = tr.get(f"Vapour_Wing_{tag}")
        if ob is None:
            continue
        vm = {"h": f"health_wing_root_{tag}"}
        _drv(ob, '["smoke"]', "(h > 0)*clamp(1.4*(1 - h), 0, 1)", arm, vm)
        _visibility(ob, "(h <= 0.97)*(h > 0)", arm, vm)
    # ---------------------------------------------- gear collapse drivers
    _gear_collapse_drivers(arm)
    # ------------------------------------------------------- hitboxes
    # measure with every piece at rest (no debris flight)
    saved = {k: arm[k] for k in arm.keys() if k.startswith("break_frame_")}
    for k in saved:
        arm[k] = 1.0e9
    muted = _mute_visibility(True)
    arm.update_tag()
    bpy.context.scene.frame_set(bpy.context.scene.frame_current)
    bpy.context.view_layer.update()
    boxes = fit_hitboxes(prep)
    hb_objects(boxes, arm, ctx["root"])
    lift = lift_split(prep)
    ground = ground_attitudes()
    for k, v in saved.items():
        arm[k] = v
    _mute_visibility(False, muted)
    arm.update_tag()
    bpy.context.scene.frame_set(bpy.context.scene.frame_current)
    sim.GROUND_ATTITUDE.update({k: v for k, v in ground.items()})
    sim.set_lift_split(lift)
    path = sim.export_json(boxes, extra={"lift_split": lift, "ground_attitude": ground,
                                          "blender": blender_map(prep)})
    from .rig import check_drivers
    bad = check_drivers(arm)
    invalid = refresh_drivers()
    ctx["damage_info"] = {"hitboxes": len(boxes), "json": path, "non_simple_drivers": bad,
                          "invalid_drivers": invalid,
                          "variants": sum(len(v) for v in prep["variants"].values()),
                          "debris": len(prep["debris"]), "lift_split": lift, "ground": ground}
    return ctx["damage_info"]


def _mute_visibility(on, fcs=None):
    """Show every variant at full size while measuring (mute the delta_scale drivers)."""
    if on:
        fcs = []
        for ob in bpy.data.objects:
            ad = ob.animation_data
            if not ad:
                continue
            for fc in ad.drivers:
                if fc.data_path == "delta_scale":
                    fc.mute = True
                    fcs.append(fc)
            if any(fc.data_path == "delta_scale" for fc in ad.drivers):
                ob.delta_scale = (1.0, 1.0, 1.0)
        return fcs
    for fc in fcs or []:
        fc.mute = False
    return fcs


def refresh_drivers():
    """Re-arm every driver that a too-early evaluation flagged invalid; return the ones still invalid."""
    def all_drivers():
        for idb in list(bpy.data.objects) + list(bpy.data.meshes) + list(bpy.data.shape_keys):
            ad = getattr(idb, "animation_data", None)
            if ad:
                for fc in ad.drivers:
                    yield idb, fc
    for idb, fc in all_drivers():
        if not fc.driver.is_valid:
            fc.driver.expression = fc.driver.expression
    sc = bpy.context.scene
    f = sc.frame_current
    sc.frame_set(f + 1)
    sc.frame_set(f)
    return [f"{idb.name}:{fc.data_path}[{fc.array_index}]" for idb, fc in all_drivers() if not fc.driver.is_valid]


def _inside(kid, frag):
    """Is the decal's centre inside the fragment's bounding box?"""
    c = _centroid(kid)
    bb = [frag.matrix_world @ Vector(v) for v in frag.bound_box]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    return all(lo[i] - 0.05 <= c[i] <= hi[i] + 0.05 for i in range(3))


def _gear_collapse_drivers(arm):
    """A gear leg with health < 0.25 folds part-way (broken drag brace)."""
    for bone, comp in (("NG_Strut", "nose_gear"), ("MG_Strut_L", "main_gear_L"), ("MG_Strut_R", "main_gear_R")):
        pb = arm.pose.bones.get(bone)
        if pb is None or arm.animation_data is None:
            continue
        for fc in arm.animation_data.drivers:
            if fc.data_path == f'pose.bones["{bone}"].rotation_euler' and fc.array_index == 1:
                d = fc.driver
                v = d.variables.new()
                v.name = "hc"
                v.type = 'SINGLE_PROP'
                v.targets[0].id_type = 'OBJECT'
                v.targets[0].id = arm
                v.targets[0].data_path = f'["health_{comp}"]'
                # "<ang>*(1 - smoothstep(...))*<D2R>": a broken leg folds 45 % of the way up
                d.expression = d.expression.replace("*(1 - ", "*(0.45*(hc < 0.25) + 1 - ", 1)


# --------------------------------------------------------------- hitboxes
def _np_points(objs):
    pts = []
    for ob in objs:
        if ob is None or ob.type != 'MESH':
            continue
        dg = bpy.context.evaluated_depsgraph_get()
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        mw = np.array(ev.matrix_world)
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        co = co @ mw[:3, :3].T + mw[:3, 3]
        ev.to_mesh_clear()
        pts.append(co)
    if not pts:
        return np.zeros((0, 3))
    a = np.concatenate(pts)
    return np.stack([a[:, 0], a[:, 1] + Y0, a[:, 2]], axis=1)      # (x, s, z)


def fit_obb(pts, yaw_range=(-60, 60), roll_range=(-35, 35)):
    """Smallest box over yaw (about z) then roll (about s), as f35_damage._to_box uses."""
    if len(pts) == 0:
        return None
    if len(pts) > 20000:
        pts = pts[:: len(pts) // 20000 + 1]

    def frame(yaw, roll):
        cy, sy = math.cos(math.radians(-yaw)), math.sin(math.radians(-yaw))
        x1 = pts[:, 0] * cy - pts[:, 1] * sy
        s1 = pts[:, 0] * sy + pts[:, 1] * cy
        cr, sr = math.cos(math.radians(-roll)), math.sin(math.radians(-roll))
        x2 = x1 * cr - pts[:, 2] * sr
        z2 = x1 * sr + pts[:, 2] * cr
        b = np.stack([x2, s1, z2], axis=1)
        lo, hi = b.min(axis=0), b.max(axis=0)
        return lo, hi, float(np.prod(np.maximum(hi - lo, 1e-3)))

    best = None
    for step, rng_ in ((5, None), (1, 6)):
        if rng_ is None:
            ys = range(yaw_range[0], yaw_range[1] + 1, step)
            rs = range(roll_range[0], roll_range[1] + 1, step)
        else:
            ys = range(int(best[0]) - rng_, int(best[0]) + rng_ + 1, step)
            rs = range(int(best[1]) - rng_, int(best[1]) + rng_ + 1, step)
        for yw in ys:
            for rl in rs:
                lo, hi, vol = frame(yw, rl)
                if best is None or vol < best[2] - 1e-9 or (abs(vol - best[2]) < 1e-9 and abs(yw) + abs(rl) < abs(best[0]) + abs(best[1])):
                    best = (yw, rl, vol, lo, hi)
    yaw, roll, vol, lo, hi = best
    cb = (lo + hi) / 2.0
    half = (hi - lo) / 2.0
    # back to aircraft axes: d = Ryaw(+yaw) Rroll(+roll) cb
    cr, sr = math.cos(math.radians(roll)), math.sin(math.radians(roll))
    x1 = cb[0] * cr - cb[2] * sr
    z1 = cb[0] * sr + cb[2] * cr
    cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    x0 = x1 * cy - cb[1] * sy
    s0 = x1 * sy + cb[1] * cy
    return ((float(x0), float(s0), float(z1)), tuple(float(h) + 0.01 for h in half), float(yaw), float(roll))


def _gear_side(name):
    """'L' / 'R' for main-gear part names (MG_DragBrace_L_R is the right lower brace)."""
    if "_Wheel_L_" in name or name.endswith("_L"):
        return "L"
    if "_Wheel_R_" in name or name.endswith("_R"):
        return "R"
    return None


def _objs(*names):
    return [bpy.data.objects.get(n) for n in names if bpy.data.objects.get(n)]


def _prefix(*prefixes):
    return [o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith(prefixes)
            and "_Stub_" not in o.name and "_Frag_" not in o.name and "_Whole_" not in o.name]


def _fuselage_band(s0, s1, xmin=None):
    pts = _np_points(_objs("Fuselage"))
    m = (pts[:, 1] >= s0) & (pts[:, 1] <= s1)
    if xmin is not None:
        m &= pts[:, 0] * np.sign(xmin) >= abs(xmin)
    return pts[m]


def fit_hitboxes(prep):
    """Hitbox per damage component (aircraft axes x=left, s=aft, z=up)."""
    from .bays import BAY_S, BAY_X, BAY_Z
    out = {}

    def put(comp, pts, **kw):
        b = fit_obb(pts, **kw)
        if b is not None:
            out[comp] = b
    put("radome", _np_points(_objs("Fuselage_Frag_radome")), yaw_range=(0, 0), roll_range=(0, 0))
    put("fwd_fuselage", _fuselage_band(1.20, 5.20), yaw_range=(0, 0), roll_range=(0, 0))
    put("center_fuselage", _fuselage_band(5.20, 10.60), yaw_range=(0, 0), roll_range=(0, 0))
    put("aft_fuselage", _fuselage_band(10.60, 14.40), yaw_range=(0, 0), roll_range=(0, 0))
    put("nozzle", _np_points(_objs("Nozzle")), yaw_range=(0, 0), roll_range=(0, 0))
    put("pilot", _np_points(_prefix("Pilot_")), yaw_range=(0, 0), roll_range=(0, 0))
    put("gun", _np_points(_prefix("Gun_")), yaw_range=(-10, 10), roll_range=(-10, 10))
    put("nose_gear", _np_points(_prefix("NG_")), yaw_range=(0, 0), roll_range=(0, 0))
    for tag, sd in (("L", 1), ("R", -1)):
        put(f"wing_root_{tag}", _np_points(_objs(f"Wing_{tag}_Stub_wing_outer_{tag}")), roll_range=(0, 0))
        put(f"wing_outer_{tag}", _np_points(_objs(f"Wing_{tag}_Frag_wing_outer_{tag}",
                                                  f"LEF_{tag}_Frag_wing_outer_{tag}")), roll_range=(0, 0))
        put(f"lef_{tag}", _np_points(_objs(f"LEF_{tag}")), roll_range=(0, 0))
        put(f"flaperon_{tag}", _np_points(_objs(f"Flaperon_{tag}")), roll_range=(0, 0))
        put(f"stab_{tag}", _np_points(_objs(f"Stabilator_{tag}")), roll_range=(-5, 5))
        put(f"fin_{tag}", _np_points(_objs(f"Fin_{tag}", f"Rudder_{tag}")), yaw_range=(-15, 15))
        put(f"main_gear_{tag}", _np_points([o for o in _prefix("MG_") if _gear_side(o.name) == tag]),
            yaw_range=(-30, 30))
        # weapon bay from the bay constants
        xs = sorted((sd * BAY_X[0], sd * BAY_X[1]))
        out[f"weapon_bay_{tag}"] = (((xs[0] + xs[1]) / 2, (BAY_S[0] + BAY_S[1]) / 2, (BAY_Z[0] + BAY_Z[1]) / 2),
                                    ((xs[1] - xs[0]) / 2, (BAY_S[1] - BAY_S[0]) / 2, (BAY_Z[1] - BAY_Z[0]) / 2),
                                    0.0, 0.0)
    # internal components keep the explicit boxes of the simulator
    for comp, c in sim.COMPONENTS.items():
        if comp not in out and "box" in c:
            b = c["box"]
            out[comp] = (tuple(b[0]), tuple(b[1]), b[2], b[3] if len(b) > 3 else 0.0)
    return out


HB_COLORS = {"structure": (1.0, 0.55, 0.10), "propulsion": (1.0, 0.12, 0.08), "control": (0.10, 0.85, 1.0),
             "systems": (1.0, 0.90, 0.15), "crew": (1.0, 0.25, 0.85), "gear": (0.55, 1.0, 0.30)}


def hb_category(comp):
    if comp in ("engine", "nozzle", "inlet_L", "inlet_R", "fuel_feed"):
        return "propulsion"
    if comp.startswith(("lef_", "flaperon_", "stab_", "fin_")):
        return "control"
    if comp in ("cockpit", "pilot"):
        return "crew"
    if "gear" in comp:
        return "gear"
    if comp in ("radome", "ipp", "gun") or comp.startswith("weapon_bay"):
        return "systems"
    return "structure"


def hb_bone(comp):
    m = {"lef": "H_LEF_", "flaperon": "H_Flaperon_", "stab": "H_Stabilator_"}
    for k, v in m.items():
        if comp.startswith(k + "_"):
            return v + comp[-1]
    if comp == "nose_gear":
        return "NG_Strut"
    if comp.startswith("main_gear_"):
        return "MG_Strut_" + comp[-1]
    return "Root"


def hb_objects(boxes, arm, root):
    from .rig import parent_keep
    coll = get_collection("Hitboxes", root)
    coll.hide_render = True
    mat = hitbox_material()
    for comp, (c, h, yaw, roll) in boxes.items():
        name = f"HB_{comp}"
        if name in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[name])
        verts = []
        for dx in (-1, 1):
            for ds in (-1, 1):
                for dz in (-1, 1):
                    b = Vector((dx * h[0], ds * h[1], dz * h[2]))
                    # box frame -> aircraft axes (roll about s, then yaw about z)
                    R = Matrix.Rotation(math.radians(yaw), 3, 'Z') @ Matrix.Rotation(-math.radians(roll), 3, 'Y')
                    d = R @ b
                    verts.append(Vector((c[0] + d.x, c[1] + d.y - Y0, c[2] + d.z)))
        faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        ob = mesh_object(name, verts, faces, coll, mat, smooth=False)
        wf = ob.modifiers.new("Wire", 'WIREFRAME')
        wf.thickness = 0.014
        wf.use_replace = True
        ob.color = (*HB_COLORS[hb_category(comp)], 1.0)
        ob.display_type = 'WIRE'
        ob.hide_render = True
        ob.visible_shadow = False
        ob["component"] = comp
        ob["hp"] = sim.COMPONENTS[comp]["hp"]
        bone = hb_bone(comp)
        if bone not in arm.pose.bones:
            bone = "Root"
        parent_keep(ob, arm, bone)


def _check_box_math():
    """Self-test: HB mesh corners must be inside the box per the simulator."""
    ok = True
    for ob in bpy.data.objects:
        if ob.name.startswith("HB_") and ob.type == 'MESH':
            comp = ob["component"]
            data = sim.load_hitboxes()
            if comp not in data:
                continue
            for v in ob.data.vertices:
                p = ob.matrix_world @ v.co
                if sim.box_distance((p.x, p.y + Y0, p.z), data[comp]) > 0.02:
                    ok = False
    return ok


# ------------------------------------------------------- lift split
def _planform(ob, xmin=1.75):
    """Upper-surface planform area and area-weighted |x| centroid."""
    me = ob.data
    mw = ob.matrix_world
    A = Ax = 0.0
    for p in me.polygons:
        n = (mw.to_3x3() @ p.normal)
        if n.z <= 0.3:
            continue
        c = mw @ p.center
        if abs(c.x) < xmin:
            continue
        a = p.area * n.normalized().z
        A += a
        Ax += a * abs(c.x)
    return A, (Ax / A if A > 0 else 0.0)


def lift_split(prep):
    """Share of one wing panel's lift outboard of the tear, from the mesh."""
    tag = "L"
    inner = [bpy.data.objects.get(f"Wing_{tag}_Stub_wing_outer_{tag}"), bpy.data.objects.get(f"LEF_{tag}_Stub_wing_outer_{tag}"),
             bpy.data.objects.get(f"Flaperon_{tag}")]
    outer = [bpy.data.objects.get(f"Wing_{tag}_Frag_wing_outer_{tag}"), bpy.data.objects.get(f"LEF_{tag}_Frag_wing_outer_{tag}")]
    if not all(inner + outer):
        return {}
    Ai = sum(_planform(o)[0] for o in inner)
    Axi = sum(_planform(o)[0] * _planform(o)[1] for o in inner)
    Ao = sum(_planform(o)[0] for o in outer)
    Axo = sum(_planform(o)[0] * _planform(o)[1] for o in outer)
    # outboard sections run a slightly higher local CL on a tapered swept wing
    lo = 1.08
    share = Ao * lo / (Ao * lo + Ai)
    return {"outer_share": round(share, 4), "outer_arm": round(Axo / Ao, 3), "root_arm": round(Axi / Ai, 3),
            "panel_area_m2": round(Ai + Ao, 3), "outer_area_m2": round(Ao, 3)}


# ----------------------------------------------------- ground attitude
def _lowest_point(names):
    pts = _np_points(_objs(*names))
    i = int(np.argmin(pts[:, 2]))
    x, s, z = pts[i]
    return np.array([x, s - Y0, z])


SKIP_COLLECTIONS = {"Hitboxes", "Damage", "Markings", "Lights", "Scene", "Cameras", "Helpers", "Pilot",
                    "Cockpit", "Impacts", "Rig"}


def _airframe_points(exclude):
    obs = []
    for ob in bpy.data.objects:
        if ob.type != 'MESH' or ob.hide_render:
            continue
        if {c.name for c in ob.users_collection} & SKIP_COLLECTIONS:
            continue
        if exclude(ob.name):
            continue
        obs.append(ob)
    pts = _np_points(obs)
    return np.stack([pts[:, 0], pts[:, 1] - Y0, pts[:, 2]], axis=1)


def _tip_angle(pts, A, u, G, max_deg=40.0):
    """Smallest rotation about axis (A, u) that brings any point down to z=G."""
    r = pts - A
    rpar = np.outer(r @ u, u)
    rperp = r - rpar
    w = np.cross(u, rperp)
    base = A[2] + rpar[:, 2]

    def zmin(deg):
        th = math.radians(deg)
        return base + rperp[:, 2] * math.cos(th) + w[:, 2] * math.sin(th)
    prev = 0.0
    for deg in np.arange(0.05, max_deg, 0.05):
        if zmin(deg).min() <= G:
            lo, hi = prev, float(deg)
            for _ in range(30):
                mid = 0.5 * (lo + hi)
                if zmin(mid).min() <= G:
                    hi = mid
                else:
                    lo = mid
            j = int(np.argmin(zmin(hi)))
            return hi, pts[j]
        prev = float(deg)
    return None, None


def ground_attitudes():
    """Resting attitude after one gear leg collapses: the jet pivots about the
    line through the two remaining tyre contacts until the airframe touches."""
    G = GROUND_Z
    N = _lowest_point(["NG_Wheel_Tyre"])
    L = _lowest_point(["MG_Wheel_L_Tyre"])
    R = _lowest_point(["MG_Wheel_R_Tyre"])
    # the broken leg (and its door) is ignored, and so are the two wheels the jet still stands on
    cases = {
        "main_gear_L": (N, R, L, lambda n: (n.startswith("MG_") and _gear_side(n) == "L") or n == "MainGearDoor_L"
                        or n.startswith(("NG_Wheel_", "MG_Wheel_R_"))),
        "main_gear_R": (N, L, R, lambda n: (n.startswith("MG_") and _gear_side(n) == "R") or n == "MainGearDoor_R"
                        or n.startswith(("NG_Wheel_", "MG_Wheel_L_"))),
        "nose_gear": (L, R, N, lambda n: n.startswith(("NG_", "NoseGearDoor", "MG_Wheel_"))),
    }
    out = {}
    for comp, (A, B, drop, excl) in cases.items():
        pts = _airframe_points(excl)
        u = (B - A) / np.linalg.norm(B - A)
        r = drop - A
        rperp = r - (r @ u) * u
        if np.cross(u, rperp)[2] > 0:           # positive rotation must lower the broken corner
            u = -u
        far = np.linalg.norm(np.cross(pts - A, u), axis=1) > 0.05      # not the supporting tyres
        pts = pts[far & (pts[:, 2] > G + 0.02)]
        ang, touch = _tip_angle(pts, A, u, G)
        if ang is None:
            continue
        Rm = Matrix.Rotation(math.radians(ang), 3, Vector(u))
        xl = Rm @ Vector((1, 0, 0))
        nose = Rm @ Vector((0, -1, 0))
        out[comp] = {"roll_deg": round(math.degrees(-math.asin(max(-1, min(1, xl.z)))), 2),
                     "pitch_deg": round(math.degrees(math.asin(max(-1, min(1, nose.z)))), 2),
                     "angle_deg": round(ang, 2), "axis_point": [round(float(v), 4) for v in A],
                     "axis_dir": [round(float(v), 5) for v in u],
                     "touch_point_xsz": [round(float(touch[0]), 3), round(float(touch[1] + Y0), 3),
                                         round(float(touch[2]), 3)]}
    return out


def blender_map(prep):
    m = {}
    for comp, c in sim.COMPONENTS.items():
        m[comp] = {"objects": c.get("objects", []), "hitbox_object": f"HB_{comp}",
                   "health_property": f'F35I_Rig["health_{comp}"]'}
        if c.get("detach"):
            m[comp]["break_frame_property"] = f'F35I_Rig["break_frame_{comp}"]'
            m[comp]["debris_empty"] = f"Debris_{comp}" if comp in prep["debris"] else None
    return m


# ===================================================== runtime helpers
def _rig():
    return bpy.data.objects["F35I_Rig"]


def _key(arm, prop, value, frame, interp='CONSTANT'):
    arm[prop] = value
    if frame is None:
        return
    arm.keyframe_insert(data_path=f'["{prop}"]', frame=frame)
    ad = arm.animation_data
    if ad and ad.action:
        for fc in _fcurves(ad.action):
            if fc.data_path == f'["{prop}"]':
                for kp in fc.keyframe_points:
                    if abs(kp.co.x - frame) < 0.5:
                        kp.interpolation = interp


def _fcurves(action):
    try:
        return list(action.fcurves)
    except Exception:
        out = []
        for layer in action.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    out.extend(cb.fcurves)
        return out


def state_from_rig(arm=None):
    arm = arm or _rig()
    return {k: float(arm.get(f"health_{k}", 1.0)) for k in sim.COMPONENTS}


def set_health(comp, value, frame=None, interp='LINEAR', arm=None):
    arm = arm or _rig()
    if frame is not None:
        fc_exists = False
        ad = arm.animation_data
        if ad and ad.action:
            fc_exists = any(fc.data_path == f'["health_{comp}"]' for fc in _fcurves(ad.action))
        if not fc_exists:
            _key(arm, f"health_{comp}", float(arm.get(f"health_{comp}", 1.0)), frame - 1, interp)
    _key(arm, f"health_{comp}", float(value), frame, interp)


def break_off(comp, frame, arm=None):
    """Destroy a detachable part at `frame`: it tears off and tumbles away."""
    arm = arm or _rig()
    c = sim.COMPONENTS[comp]
    if not c.get("detach"):
        raise ValueError(f"{comp} is not detachable")
    _key(arm, f"health_{comp}", float(arm.get(f"health_{comp}", 1.0)), frame - 1, 'CONSTANT')
    _key(arm, f"health_{comp}", 0.0, frame, 'CONSTANT')
    _key(arm, f"break_frame_{comp}", float(frame), frame - 1, 'CONSTANT')


def _shown(o):
    return not o.hide_render and o.matrix_world.to_scale().x > 0.01


def _skin_objects():
    return [o for o in bpy.data.objects if o.type == 'MESH' and _shown(o) and
            any(m and m.name == "F35_Skin_RAM" for m in o.data.materials) and "_Frag_" not in o.name
            and "_Whole_" not in o.name]


def impact(origin, direction, hp, frame=None, size=None, arm=None):
    """Ray-cast a hit onto the skin: scorch decal + health loss via the hitboxes."""
    from .markings import decal
    arm = arm or _rig()
    origin, direction = Vector(origin), Vector(direction).normalized()
    best = None
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in _skin_objects():
        ev = ob.evaluated_get(dg)
        mw = ev.matrix_world
        inv = mw.inverted()
        bvh = BVHTree.FromObject(ev, dg)
        o = inv @ origin
        d = (inv.to_3x3() @ direction).normalized()
        loc, nrm, idx, dist = bvh.ray_cast(o, d, 200.0)
        if loc is None:
            continue
        w = mw @ loc
        dd = (w - origin).length
        if best is None or dd < best[0]:
            best = (dd, ob, w, (mw.to_3x3() @ nrm).normalized())
    if best is None:
        return None
    _, ob, w, n = best
    size = size or min(0.9, 0.12 + 0.0022 * hp)
    up = Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((0, 1, 0))
    u = n.cross(up).normalized()
    v = n.cross(u).normalized()
    coll = get_collection("Impacts", bpy.data.collections.get("F-35I_Adir"))
    k = len([o for o in bpy.data.objects if o.name.startswith("Impact_")])
    dec = decal(f"Impact_{k:03d}", coll, ob, w + n * 0.02, u, v, -n, size, size, scorch_material(), nu=10, nv=10,
                lift=0.0025)
    dec["embers"] = 0.0
    if frame is not None:
        dec["impact_frame"] = float(frame)
        for i in range(3):
            d1 = dec.driver_add("delta_scale", i).driver
            d1.type = 'SCRIPTED'
            vv = d1.variables.new()
            vv.name = "f0"
            vv.targets[0].id_type = 'OBJECT'
            vv.targets[0].id = dec
            vv.targets[0].data_path = '["impact_frame"]'
            d1.expression = f"{SCALE_OFF} + {1 - SCALE_OFF}*(frame >= f0)"
        d2 = dec.driver_add('["embers"]').driver
        d2.type = 'SCRIPTED'
        vv = d2.variables.new()
        vv.name = "f0"
        vv.targets[0].id_type = 'OBJECT'
        vv.targets[0].id = dec
        vv.targets[0].data_path = '["impact_frame"]'
        d2.expression = "(frame >= f0)*max(0, 1 - (frame - f0)/96)"
    # aircraft coordinates of the hit (undo the rig's object transform)
    pa = arm.matrix_world.inverted() @ w
    st0 = state_from_rig(arm)
    st1, comps = sim.apply_hit(st0, (pa.x, pa.y + Y0, pa.z), hp)
    for c in comps:
        set_health(c, st1[c], frame, 'CONSTANT', arm)
        if st1[c] <= 0.0 and sim.COMPONENTS[c].get("detach") and frame is not None:
            _key(arm, f"break_frame_{c}", float(frame), frame - 1, 'CONSTANT')
    return {"object": ob.name, "point_world": tuple(w), "components": comps,
            "health": {c: round(st1[c], 3) for c in comps}, "decal": dec.name}


def blast(centre, hp, radius, frame=None, arm=None):
    arm = arm or _rig()
    c = Vector(centre)
    pa = arm.matrix_world.inverted() @ c
    st0 = state_from_rig(arm)
    st1, hit = sim.apply_blast(st0, (pa.x, pa.y + Y0, pa.z), hp, radius)
    for comp, dmg in hit:
        set_health(comp, st1[comp], frame, 'CONSTANT', arm)
        if st1[comp] <= 0.0 and sim.COMPONENTS[comp].get("detach") and frame is not None:
            _key(arm, f"break_frame_{comp}", float(frame), frame - 1, 'CONSTANT')
    # a few scorch marks on the skin facing the blast
    rng = random.Random(int(hp + radius * 10))
    for _ in range(6):
        tgt = Vector((0.0, pa.y + rng.uniform(-1.0, 1.0), 0.2))
        impact(c, (arm.matrix_world @ tgt) - c, hp * 0.15, frame, size=rng.uniform(0.2, 0.45), arm=arm)
    return hit


def flight_response(frame, mach=0.45, alt_m=1000.0, settle_frames=36, arm=None, hold_frames=72):
    """Evaluate the simulator for the rig's current health and key the
    aircraft attitude: steady bank ('tilt') and sideslip if it can be
    trimmed, otherwise a continuous roll-off.  Also keys stick roll."""
    arm = arm or _rig()
    st = state_from_rig(arm)
    r = sim.evaluate(st, mach, alt_m)
    sgn = 1.0 if r["tilt_towards"] == "left" else (-1.0 if r["tilt_towards"] == "right" else 0.0)
    arm.rotation_mode = 'XYZ'
    base_rot = arm.rotation_euler.copy()
    arm.keyframe_insert("rotation_euler", frame=frame)
    stick = -sgn * min(1.0, r.get("roll_control_used") or 0.0)    # pilot / FCS holds against the roll
    _key(arm, "stick_roll", float(arm.get("stick_roll", 0.0)), frame, 'BEZIER')
    if r["controllable"]:
        phi = math.radians(r["tilt_bank_deg"] or 0.0) * sgn
        beta = math.radians(r["sideslip_deg"]) * sgn
        arm.rotation_euler = (base_rot.x, base_rot.y - phi, base_rot.z - beta)
        arm.keyframe_insert("rotation_euler", frame=frame + settle_frames)
        arm.keyframe_insert("rotation_euler", frame=frame + settle_frames + hold_frames)
        _key(arm, "stick_roll", stick, frame + 8, 'BEZIER')
    else:
        rate = math.radians(r["roll_off_rate_deg_s"]) * sgn
        T = (settle_frames + hold_frames) / FPS
        arm.rotation_euler = (base_rot.x, base_rot.y - rate * T, base_rot.z)
        arm.keyframe_insert("rotation_euler", frame=frame + settle_frames + hold_frames)
        _key(arm, "stick_roll", -sgn * 1.0, frame + 6, 'BEZIER')
    return r


def collapse_gear(comp, frame, duration=10, arm=None):
    """Destroy a gear leg at `frame`; the jet settles onto its wing / nose."""
    arm = arm or _rig()
    data = sim.GROUND_ATTITUDE.get(comp)
    if not data:
        raise ValueError("no ground attitude for " + comp)
    _key(arm, f"health_{comp}", float(arm.get(f"health_{comp}", 1.0)), frame - 1, 'CONSTANT')
    _key(arm, f"health_{comp}", 0.0, frame, 'CONSTANT')
    A = Vector(data["axis_point"])
    u = Vector(data["axis_dir"])
    M0 = arm.matrix_world.copy()
    for i in range(duration + 1):
        t = i / duration
        th = math.radians(data["angle_deg"]) * (t * t)
        Rm = Matrix.Translation(A) @ Matrix.Rotation(th, 4, u) @ Matrix.Translation(-A)
        arm.matrix_world = Rm @ M0
        arm.keyframe_insert("location", frame=frame + i)
        arm.keyframe_insert("rotation_euler", frame=frame + i)
    return data
