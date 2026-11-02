"""Per-vertex ambient occlusion for the parts outside the skin atlases (gear, wells, bays, cockpit,
pilot, details), exported as the glTF COLOR_0 attribute.

The skin and the other atlas parts carry their occlusion in the ORM texture (bake.py); everything
else gets it per vertex here: from every vertex, RAYS cosine-weighted rays into the hemisphere
around its normal are cast against the whole model at the rest pose (every control at its default:
gear down with its doors open, canopy, weapon bays, gun and refuelling doors shut), glass and
decals left out. A hit at distance d counts 1 - (d / DISTANCE)^2, so near walls shade more than far
ones (an obscurance, no hard cut-off). One smoothing pass along the edges takes the sampling noise
out.

Two exceptions, so that every part is baked as it is seen:
  * the doors shut at the rest pose whose insides are only ever seen open (SHUT_DOORS: the weapon
    bays', the gun port's, the refuelling receptacle's) are left out altogether: the bays and the
    recesses are baked open (with the doors shut they would be closed boxes, near black once the
    doors open), the doors' insides get no occlusion of their own;
  * the cockpit interior and the pilot (COCKPIT, PILOT) only occlude: the app's cockpit computes
    its own occlusion of the tub (js/aircraft/pcd/interior.js: lit by the sky through the canopy
    only) and a second one here would darken it twice. The app ignores COLOR_0 on these materials
    too (js/aircraft/materials.js, COCKPIT_AO), whatever export it loads.

The value goes into a colour attribute "AO" (point domain, R = G = B = occlusion, 1 = open) that
is made the active and render colour of every copy of a node that has such parts (the others in
that node get white: joining meshes fills a missing attribute with black). Other colour attributes
are removed (the exporter writes the active one as COLOR_0, and the app reads COLOR_0 as occlusion).
The app (js/aircraft/materials.js) applies it to the ambient light only, as three.js does aoMap.
"""
import math
import time

import bpy
import numpy as np
from mathutils.bvhtree import BVHTree

from common import log

DISTANCE = 0.6                 # m
RAYS = 24
EPS = 0.004                    # m: ray origins lifted off the surface
ATLAS = ("F35_Skin_A", "F35_Skin_B", "F35_Misc_B")
GLASS = ("F35_canopy", "F35_eots_glass", "F35_das_window", "P2_Visor", "P2_Lens")
NOT_GLASS = ("F35_canopy_bow", "F35_canopy_frame")
ATTR = "AO"
# occluders only (see the docstring); names as the cockpit's interior.js knows them
COCKPIT = ("F35_cockpit", "F35_cockpit_panel", "F35_canopy_bow", "F35_glare_pad", "F35_seat",
           "F35_seat_cushion", "F35_yellow_black", "F35_switch_guard", "F35_switch", "F35_gear_handle",
           "F35_SwitchLED")
PILOT = ("P2_",)
# rig nodes shut at the rest pose and seen open only: neither occluders nor receivers
SHUT_DOORS = ("BayDoor_", "GunDoor", "RefuelDoor")


def _is_glass(m):
    if m is None:
        return False
    if m.name.startswith(NOT_GLASS):
        return False
    if m.name.startswith(GLASS):
        return True
    if m.use_nodes and m.node_tree:
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED':
                inp = n.inputs.get("Transmission Weight")
                if inp is not None and not inp.is_linked and inp.default_value > 0.5:
                    return True
    return False


def _kind(m, node=""):
    """'atlas' (occlusion in the ORM), 'skip' (glass, decals, shut doors: neither occluder nor
    receiver), 'occl' (cockpit interior, pilot: occluder only), 'recv'."""
    if node.startswith(SHUT_DOORS):
        return 'skip'
    if m is None:
        return 'recv'
    if m.name.startswith(ATLAS):
        return 'atlas'
    if m.name.startswith("F35_Decal_") or _is_glass(m):
        return 'skip'
    if m.name.startswith(COCKPIT) or m.name.startswith(PILOT):
        return 'occl'
    return 'recv'


def _mesh_arrays(o):
    me = o.data
    nv, nf = len(me.vertices), len(me.polygons)
    co = np.empty(nv * 3, np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(nv, 3)
    nrm = np.empty(nv * 3, np.float64)
    try:
        me.vertex_normals.foreach_get("vector", nrm)
    except AttributeError:
        me.vertices.foreach_get("normal", nrm)
    nrm = nrm.reshape(nv, 3)
    M = np.array(o.matrix_world, np.float64)
    co = co @ M[:3, :3].T + M[:3, 3]
    nrm = nrm @ np.linalg.inv(M[:3, :3])                # normals: inverse transpose
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    mi = np.empty(nf, np.int32)
    me.polygons.foreach_get("material_index", mi)
    ls = np.empty(nf, np.int32)
    me.polygons.foreach_get("loop_start", ls)
    lt = np.empty(nf, np.int32)
    me.polygons.foreach_get("loop_total", lt)
    lv = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get("vertex_index", lv)
    node = str(o.get("node", o.name))
    kinds = [_kind(m, node) for m in me.materials] or [_kind(None, node)]
    fk = np.array([kinds[min(i, len(kinds) - 1)] for i in mi]) if nf else np.array([], dtype='<U5')
    return co, nrm, fk, ls, lt, lv


def _directions(n):
    """n cosine-weighted directions on the +Z hemisphere (Hammersley)."""
    out = []
    for i in range(n):
        u1 = (i + 0.5) / n
        b, f, u2 = i, 0.5, 0.0
        while b:
            u2 += f * (b & 1)
            b >>= 1
            f *= 0.5
        r, phi = math.sqrt(u1), 2 * math.pi * u2
        out.append((r * math.cos(phi), r * math.sin(phi), math.sqrt(max(0.0, 1 - u1))))
    return np.array(out, np.float64)


def bake_vertex_ao(copies, distance=DISTANCE, rays=RAYS):
    """copies: all export copies (after bake.py and gltf_materials.py).  Returns the number of
    vertices that got occlusion (0: nothing written)."""
    t0 = time.time()
    data = {o.name: _mesh_arrays(o) for o in copies if o.type == 'MESH' and len(o.data.polygons)}
    # ---------------------------------------------------------------- occluders: one BVH
    verts, polys, off = [], [], 0
    for o in copies:
        if o.name not in data:
            continue
        co, nrm, fk, ls, lt, lv = data[o.name]
        for p in np.nonzero(fk != 'skip')[0]:
            polys.append((lv[ls[p]:ls[p] + lt[p]] + off).tolist())
        verts.append(co)
        off += len(co)
    if not polys:
        return 0
    allv = np.concatenate(verts)
    bvh = BVHTree.FromPolygons(allv.tolist(), polys, all_triangles=False, epsilon=0.0)
    log(f"  occluders: {len(polys)} faces, {len(allv)} vertices ({time.time() - t0:.0f} s)")
    # ---------------------------------------------------------------- receivers
    local = _directions(rays)
    nodes_with = set()
    result = {}
    total = 0
    for o in copies:
        if o.name not in data:
            continue
        co, nrm, fk, ls, lt, lv = data[o.name]
        recv = np.zeros(len(co), bool)
        for p in np.nonzero(fk == 'recv')[0]:
            recv[lv[ls[p]:ls[p] + lt[p]]] = True
        idx = np.nonzero(recv)[0]
        if not len(idx):
            continue
        n = nrm[idx]
        # tangent frames, turned by a per-vertex angle (no banding between neighbours)
        a = np.where(np.abs(n[:, 2:3]) < 0.9, np.array([[0.0, 0.0, 1.0]]), np.array([[1.0, 0.0, 0.0]]))
        t = np.cross(a, n)
        t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-12)
        b = np.cross(n, t)
        ang = (idx * 2.399963) % (2 * math.pi)
        c, s = np.cos(ang)[:, None], np.sin(ang)[:, None]
        t, b = c * t + s * b, -s * t + c * b
        dirs = local[None, :, 0:1] * t[:, None, :] + local[None, :, 1:2] * b[:, None, :] + local[None, :, 2:3] * n[:, None, :]
        org = (co[idx] + n * EPS).tolist()
        dirs = dirs.tolist()
        occ = np.zeros(len(idx), np.float64)
        ray_cast = bvh.ray_cast
        inv = 1.0 / distance
        for i in range(len(idx)):
            oi = org[i]
            acc = 0.0
            for d in dirs[i]:
                hit = ray_cast(oi, d, distance)
                if hit[0] is not None:
                    q = hit[3] * inv
                    acc += 1.0 - q * q
            occ[i] = acc
        ao = np.ones(len(co), np.float64)
        ao[idx] = 1.0 - occ / rays
        # one smoothing pass along the edges (receivers only)
        me = o.data
        ev = np.empty(len(me.edges) * 2, np.int32)
        me.edges.foreach_get("vertices", ev)
        ev = ev.reshape(-1, 2)
        if len(ev):
            sm = np.zeros(len(co))
            cnt = np.zeros(len(co))
            np.add.at(sm, ev[:, 0], ao[ev[:, 1]])
            np.add.at(sm, ev[:, 1], ao[ev[:, 0]])
            np.add.at(cnt, ev[:, 0], 1)
            np.add.at(cnt, ev[:, 1], 1)
            has = (cnt > 0) & recv
            ao[has] = 0.5 * ao[has] + 0.5 * sm[has] / cnt[has]
        result[o.name] = np.clip(ao, 0.0, 1.0)
        nodes_with.add(o.get("node", o.name))
        total += len(idx)
    log(f"  occlusion of {total} vertices on {len(result)} objects ({rays} rays, {distance} m, "
        f"{time.time() - t0:.0f} s)")
    # ---------------------------------------------------------------- attributes
    for o in copies:
        if o.type != 'MESH':
            continue
        me = o.data
        for ca in list(me.color_attributes):
            me.color_attributes.remove(ca)
        if o.get("node", o.name) not in nodes_with:
            continue
        nv = len(me.vertices)
        ao = result.get(o.name)
        col = np.ones((nv, 4), np.float32)
        if ao is not None:
            col[:, 0] = col[:, 1] = col[:, 2] = ao
        attr = me.color_attributes.new(ATTR, 'BYTE_COLOR', 'POINT')
        attr.data.foreach_set("color", col.ravel())
        set_active_color(me)
    return total


def set_active_color(me):
    """Make the AO attribute the active and the render colour (the exporter's 'ACTIVE' choice)."""
    attr = me.color_attributes.get(ATTR)
    if attr is None:
        return False
    try:
        me.color_attributes.active_color = attr
    except Exception:
        pass
    names = [a.name for a in me.color_attributes]
    i = names.index(ATTR)
    for prop, val in (("active_color_index", i), ("render_color_index", i), ("active_color_name", ATTR),
                      ("default_color_name", ATTR)):
        try:
            setattr(me.color_attributes, prop, val)
        except Exception:
            pass
    return True
