"""From the built Blender scene to the export scene: which objects go out, which rig node each one
follows, and plain mesh copies of them (modifiers applied at the rest pose, the pilot decimated)
that are finally joined into one object per node.

Node names (the glTF node names the app addresses):
  Airframe                 everything that never moves relative to the airframe (incl. the
                           seated pilot's body, frozen in its pose)
  <Surface> / <Door>       hinged parts, named after their Blender object (H_<name> bone):
                           Stabilator_L, Flaperon_R, LEF_L, Rudder_R, NoseGearDoor_L, BayDoor_Outer_R,
                           MainGearDoor_Fwd_L, GunDoor, RefuelDoor, Tailhook, Canopy (glass + frame + bow)
  NG_* / MG_*_L / MG_*_R   landing-gear parts, named after their rig bones (Strut, Steer/Oleo, Wheel,
                           BraceUp/Lo, ActBarrel/ActRod, ...)
  Stick, Throttle, Pedal_L, Pedal_R      cockpit controls
  Pilot_Head, Pilot_Hand_L, Pilot_Hand_R  rigid pilot parts that follow the head look and the grips
  Nozzle                   static, with the AB_Open morph target (afterburner petals)
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from common import log

STATIC = "Airframe"
EXCLUDE = {"AB_Flame"}                 # the app draws its own afterburner flame
PILOT_BONES = {"head": "Pilot_Head", "neck": "Pilot_Neck", "hand.L": "Pilot_Hand_L", "hand.R": "Pilot_Hand_R"}
RENAME = {"Canopy_Glass": "Canopy"}


def export_objects():
    out = []
    for ob in bpy.data.objects:
        if ob.type != 'MESH' or ob.name in EXCLUDE or ob.hide_render:
            continue
        if any(c.name == "Helpers" for c in ob.users_collection):
            continue
        out.append(ob)
    return out


def is_pilot(ob):
    return any(c.name == "Pilot" for c in ob.users_collection)


def _bone_node(arm, bone):
    if arm.name == "F35I_Rig":
        if bone == "Root":
            return None
        if bone.startswith("H_"):
            n = bone[2:]
            return RENAME.get(n, n)
        return bone
    if arm.name == "Pilot_Rig":
        return PILOT_BONES.get(bone)
    return None


def _driven_keys(ob):
    sk = ob.data.shape_keys if ob.type == 'MESH' else None
    return sk is not None and sk.animation_data is not None and len(sk.animation_data.drivers) > 0


def node_of(ob):
    """(node name, armature, bone) the object follows; (STATIC, None, None) for fixed parts.
    A fixed part with driven shape keys (the nozzle) gets a node of its own, so only it carries
    morph targets."""
    o = ob
    found = (STATIC, None, None)
    while o is not None:
        p = o.parent
        if p is None:
            break
        if p.type == 'ARMATURE':
            if o.parent_type == 'BONE':
                n = _bone_node(p, o.parent_bone)
                if n:
                    found = (n, p, o.parent_bone)
            break                                # skinned to an armature (pilot garments): frozen
        o = p
    if found[0] == STATIC and _driven_keys(ob):
        return (ob.name, None, None)
    return found


def find_groups(objs):
    groups = {}
    for ob in objs:
        name, arm, bone = node_of(ob)
        g = groups.setdefault(name, {"objects": [], "arm": arm, "bone": bone})
        g["objects"].append(ob)
    for name, g in groups.items():
        if g["arm"] is not None:
            pb = g["arm"].pose.bones[g["bone"]]
            g["pivot"] = np.array(g["arm"].matrix_world @ pb.head, float)
            g["bone_y"] = np.array((g["arm"].matrix_world.to_3x3() @ pb.y_axis).normalized(), float)
        else:
            g["pivot"] = np.zeros(3)
            g["bone_y"] = None
        lo = np.full(3, 1e9)
        hi = np.full(3, -1e9)
        for ob in g["objects"]:
            for c in ob.bound_box:
                w = np.array(ob.matrix_world @ Vector(c), float)
                lo = np.minimum(lo, w)
                hi = np.maximum(hi, w)
        corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
        g["probe"] = corners - g["pivot"]
    return groups


def hinge_limits(groups):
    """Driver clamp limits of the hinged surfaces: node -> (min_deg, max_deg, bone Y axis)."""
    out = {}
    for name, g in groups.items():
        if g["arm"] is None or not g["bone"].startswith("H_"):
            continue
        src = bpy.data.objects.get(g["bone"][2:])
        if src is not None and "limit_min" in src and "limit_max" in src:
            out[name] = (float(src["limit_min"]), float(src["limit_max"]), g["bone_y"])
    return out


def merge_static(groups, moving):
    """Groups that never move join the static group."""
    out = {}
    for name, g in groups.items():
        if name == STATIC or name in moving or (g["arm"] is None and name != STATIC):
            out.setdefault(name, g)
            continue
        st = out.setdefault(STATIC, groups.get(STATIC) or {"objects": [], "arm": None, "bone": None,
                                                             "pivot": np.zeros(3), "probe": None})
        st["objects"] = st["objects"] + g["objects"]
        log(f"  node {name} never moves: merged into {STATIC}")
    return out


# --------------------------------------------------------------------------- mesh copies
def set_modifiers(objs, on):
    for ob in objs:
        for m in ob.modifiers:
            m.show_viewport = on


def _tri_count(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def pilot_ratios(objs, budget):
    """Per-object decimation ratios that bring the pilot to about `budget` triangles: small parts keep
    proportionally more (they would collapse to nothing), big garments take the cut."""
    dg = bpy.context.evaluated_depsgraph_get()
    tris = {}
    for ob in objs:
        if is_pilot(ob):
            me = ob.evaluated_get(dg).to_mesh()
            tris[ob.name] = _tri_count(me)
            ob.evaluated_get(dg).to_mesh_clear()
    total = sum(tris.values())
    if total <= budget:
        return {k: 1.0 for k in tris}
    r = budget / total
    for _ in range(30):                      # solve for the global ratio including the per-part floors
        got = sum(min(1.0, max(r, 300.0 / max(t, 1))) * t for t in tris.values())
        r *= budget / max(got, 1)
        r = min(r, 1.0)
    out = {k: min(1.0, max(r, 300.0 / max(t, 1))) for k, t in tris.items()}
    log(f"  pilot: {total} tris, global ratio {r:.3f} -> ~{int(sum(out[k] * tris[k] for k in tris))}")
    return out


def mesh_copy(ob, node_pivot, decimate=1.0):
    """Plain mesh of ob at the rest pose (modifiers applied, shape keys kept when there are no
    modifiers), expressed in the node frame (origin at node_pivot, Blender axes)."""
    keys = ob.data.shape_keys is not None and len(ob.data.shape_keys.key_blocks) > 1
    dec = None
    if decimate < 0.999:
        dec = ob.modifiers.new("ExportDecimate", 'DECIMATE')
        dec.ratio = decimate
        dec.use_collapse_triangulate = True
    if keys and not any(m.show_viewport for m in ob.modifiers):
        me = ob.data.copy()
    else:
        if keys:
            log(f"  WARNING {ob.name}: shape keys dropped (modifiers)")
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    if dec is not None:
        ob.modifiers.remove(dec)
    N = Matrix.Translation(Vector(node_pivot))
    me.transform(N.inverted() @ ob.matrix_world, shape_keys=True)
    if ob.matrix_world.determinant() < 0:
        me.flip_normals()
    _triangulate_ngons(me)
    me.validate(clean_customdata=False)          # degenerate bits left by modifiers / decimation
    me.name = ob.name
    return me


def _triangulate_ngons(me):
    """Split faces with more than 4 corners.  Tangents (MikkTSpace) need tris and quads; doing it
    here means the normal-map bake and the glTF export see the same faces.  Shape keys survive
    (bmesh keeps them as layers; no vertices are added)."""
    if not any(len(p.vertices) > 4 for p in me.polygons):
        return
    bm = bmesh.new()
    bm.from_mesh(me)
    ngons = [f for f in bm.faces if len(f.verts) > 4]
    bmesh.ops.triangulate(bm, faces=ngons, quad_method='BEAUTY', ngon_method='BEAUTY')
    bm.to_mesh(me)
    bm.free()


def build_copies(groups, coll, ratios):
    """One plain object per source object, at its node's pivot, in collection coll.
    Returns {node: [objects]}."""
    out = {}
    for name, g in groups.items():
        lst = out.setdefault(name, [])
        for ob in g["objects"]:
            me = mesh_copy(ob, g["pivot"], ratios.get(ob.name, 1.0))
            if len(me.polygons) == 0:
                bpy.data.meshes.remove(me)
                continue
            o = bpy.data.objects.new(ob.name + ".x", me)
            o.location = Vector(g["pivot"])
            o["src"] = ob.name
            o["node"] = name
            coll.objects.link(o)
            lst.append(o)
    return out


def unify_uvs(o):
    """Keep at most one UV layer, named UVMap (joined meshes then share TEXCOORD_0)."""
    me = o.data
    if not me.uv_layers:
        return
    act = me.uv_layers.active_index if me.uv_layers.active is not None else 0
    keep = me.uv_layers[act].name
    for uv in list(me.uv_layers):
        if uv.name != keep:
            me.uv_layers.remove(uv)
    me.uv_layers[0].name = "UVMap"


def join(objs, name, coll):
    """Join objects (all at the same location) into one, named `name`."""
    for o in objs:
        unify_uvs(o)
    if len(objs) == 1:
        o = objs[0]
    else:
        # give everyone a UV layer so join keeps one consistent TEXCOORD_0
        if any(o.data.uv_layers for o in objs):
            for o in objs:
                if not o.data.uv_layers:
                    o.data.uv_layers.new(name="UVMap")
        o = objs[0]
        with bpy.context.temp_override(active_object=o, selected_editable_objects=objs, object=o,
                                       selected_objects=objs):
            bpy.ops.object.join()
    old = bpy.data.objects.get(name)
    if old is not None and old != o:           # the source object of the same name: step aside
        old.name = name + ".src"
    o.name = name
    o.data.name = name
    return o
