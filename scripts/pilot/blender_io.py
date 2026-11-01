"""Blender helpers for the pilot: numpy meshes -> objects, armature from the skeleton, skinning,
and a small studio scene for renders of the pilot on its own."""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import skeleton as S


def get_coll(name, parent=None):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(c)
    return c


def mesh_obj(name, verts, faces, coll, mat=None, smooth=True):
    """Object from numpy verts (N x 3) and faces (M x k, all the same k) or a list of tuples."""
    old = bpy.data.objects.get(name)
    if old is not None:
        me = old.data
        bpy.data.objects.remove(old)
        if me is not None and me.users == 0:
            bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name)
    verts = np.asarray(verts, dtype=np.float64)
    if isinstance(faces, np.ndarray) and faces.ndim == 2:
        k = faces.shape[1]
        me.vertices.add(len(verts))
        me.vertices.foreach_set("co", verts.astype(np.float32).ravel())
        me.loops.add(faces.size)
        me.loops.foreach_set("vertex_index", faces.astype(np.int32).ravel())
        me.polygons.add(len(faces))
        me.polygons.foreach_set("loop_start", (np.arange(len(faces)) * k).astype(np.int32))
        me.polygons.foreach_set("loop_total", np.full(len(faces), k, np.int32))
        me.update(calc_edges=True)
    else:
        me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
        me.update()
    if isinstance(mat, (list, tuple)):
        for m in mat:
            me.materials.append(m)
    elif mat is not None:
        me.materials.append(mat)
    if smooth:
        me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), bool))
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    return ob


def armature(name, j, F, coll, extra_bones=()):
    """Armature whose rest pose is joints j (one bone per skeleton.BONES entry).  Bone rolls
    follow the frames: the bone's local Z axis = the frame's anterior axis."""
    old = bpy.data.objects.get(name)
    if old is not None:
        bpy.data.objects.remove(old)
    ad = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, ad)
    coll.objects.link(arm)
    ad.display_type = 'STICK'
    vl = bpy.context.view_layer
    prev = vl.objects.active
    vl.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = ad.edit_bones
    for n, h, t, parent in S.BONES:
        b = eb.new(n)
        b.head = Vector(j[h])
        b.tail = Vector(j[t])
        b.align_roll(Vector(F[n][2]))
        if parent:
            b.parent = eb[parent]
            b.use_connect = (eb[parent].tail - b.head).length < 1e-5
    for n, head, tail, parent, roll_axis, deform in extra_bones:
        b = eb.new(n)
        b.head, b.tail = Vector(head), Vector(tail)
        if roll_axis is not None:
            b.align_roll(Vector(roll_axis))
        if parent:
            b.parent = eb[parent]
        b.use_deform = deform
    bpy.ops.object.mode_set(mode='OBJECT')
    if prev is not None:
        vl.objects.active = prev
    return arm


def skin(ob, arm, j, names=None, falloff=0.03, reach=None):
    """Vertex groups by distance to the bone segments (inverse 4th power among the bones within
    `falloff` of the nearest) + an Armature modifier."""
    me = ob.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = (np.array(ob.matrix_world) @ np.c_[co.reshape(-1, 3), np.ones(len(me.vertices))].T).T[:, :3]
    bones = [b for b in S.BONES if names is None or b[0] in names]
    A = np.array([j[h] for _n, h, _t, _p in bones])
    B = np.array([j[t] for _n, _h, t, _p in bones])
    AB = B - A
    L2 = np.maximum((AB * AB).sum(1), 1e-9)
    t0 = np.einsum("nbk,bk->nb", co[:, None, :] - A[None], AB) / L2[None]
    t = np.clip(t0, 0.0, 1.0)
    d = np.linalg.norm(co[:, None, :] - (A[None] + t[..., None] * AB[None]), axis=2)
    d = d + 1.5 * np.maximum(-t0, 0.0) * np.sqrt(L2)[None]
    if reach:
        r = np.array([reach.get(b[0].split(".")[0], 9.0) for b in bones])[None]
        d = np.where(d < r, d, d + 1.0)
    dmin = d.min(1, keepdims=True)
    w = np.where(d < dmin + falloff, 1.0 / np.maximum(d, 0.01) ** 4, 0.0)
    w /= w.sum(1, keepdims=True)
    q = np.round(w * 32) / 32
    for k, b in enumerate(bones):
        vg = ob.vertex_groups.get(b[0]) or ob.vertex_groups.new(name=b[0])
        col = q[:, k]
        for val in np.unique(col[col > 0]):
            vg.add(np.nonzero(col == val)[0].tolist(), float(val), 'REPLACE')
    mw = ob.matrix_world.copy()
    ob.parent = arm
    ob.matrix_world = mw
    m = ob.modifiers.new("Armature", 'ARMATURE')
    m.object = arm
    return ob


def parent_bone(ob, arm, bone):
    mw = ob.matrix_world.copy()
    ob.parent = arm
    ob.parent_type = 'BONE'
    ob.parent_bone = bone
    bpy.context.view_layer.update()
    ob.matrix_world = mw


def set_face_materials(ob, mi):
    """Material slot per face (numpy int array, one per polygon)."""
    ob.data.polygons.foreach_set("material_index", np.asarray(mi, np.int32))
    ob.data.update()


def set_uv(ob, uv, name="UVMap"):
    """Per-vertex UVs (N x 2) -> a UV map (per loop)."""
    me = ob.data
    lay = me.uv_layers.get(name) or me.uv_layers.new(name=name)
    vi = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get("vertex_index", vi)
    lay.data.foreach_set("uv", np.asarray(uv, np.float32)[vi].ravel())
    return lay
