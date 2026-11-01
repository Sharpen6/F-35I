"""Bake the procedural skin into UV atlases that glTF can carry.

The Blender skin (materials.skin_material) has no UVs: three panel-line maps (top / bottom / side,
scripts/f35/panels.py) are projected through stored rest positions and blended by the rest normal,
over a noise mottle, with RAM tape, light coating patches, roughness variation and panel-line
grooves.  Here the skin copies get a UV atlas (Smart UV Project, then packed), and Cycles bakes
that shader into images:

    atlas A  "body":   fuselage, fillets, fairings, canopy frame and sill, all doors
    atlas B  "wings":  wings, stabilators, fins, flaperons, LEFs, rudders,
                       plus the inlet duct lining and the nozzle (own material, no clear coat)

    <atlas>_base.jpg   base colour (sRGB)                    EMIT pass of the Base Color input
    <atlas>_orm.png    R = ambient occlusion, G = roughness, B = metallic
                                                           AO node / EMIT passes of those inputs
    <atlas>_nrm.png    tangent-space normals: panel-line grooves and fastener heads (NORMAL pass)

The colour passes use Emission rewiring, so what is baked is exactly the BSDF input (no lighting).
The occlusion pass (an Ambient Occlusion node into the Emission) is the airframe's occlusion of
itself within AO_DISTANCE: wing roots, intakes, fins, the fuselage between the tails. The doors are
moved out of the way for it (closed in flight, they must not shade the skin beside them) and the
gear is not there at all (in its wells in flight); the image material wires R into the glTF
exporter's "glTF Material Output" Occlusion socket, so the glb carries an occlusionTexture that
shares the ORM image. With ao_spp=0 R stays 1, as before.
"""
import math
import os
import time

import bpy
import numpy as np
from mathutils import Vector

from common import log

SKIN = "F35_Skin_RAM"
MISC = {"F35_intake": "Bake_Intake", "F35_nozzle": "Bake_Nozzle", "F35_nozzle_ceramic": "Bake_NozzleCeramic"}
ATLAS_B_OBJECTS = ("Wing_", "Stabilator_", "Fin_", "Flaperon_", "LEF_", "Rudder_")
AO_DISTANCE = 0.8              # m: how far the skin's occlusion looks
AO_RAYS = 16                   # rays per shader evaluation of the AO node (x the bake samples)
DOOR_SHIFT = 1000.0            # m: doors moved away from the airframe for the occlusion pass


def atlas_of(src_name):
    return "B" if src_name.startswith(ATLAS_B_OBJECTS) else "A"


def _bsdf(mat):
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            return n
    return None


def _out(mat):
    for n in mat.node_tree.nodes:
        if n.type == 'OUTPUT_MATERIAL' and n.is_active_output:
            return n
    for n in mat.node_tree.nodes:
        if n.type == 'OUTPUT_MATERIAL':
            return n
    return None


def _source(mat, input_name):
    """The socket feeding a BSDF input, or a constant node holding its value."""
    b = _bsdf(mat)
    nt = mat.node_tree
    inp = b.inputs[input_name]
    if inp.is_linked:
        return inp.links[0].from_socket
    v = inp.default_value
    if hasattr(v, "__len__"):
        n = nt.nodes.new("ShaderNodeRGB")
        n.outputs[0].default_value = tuple(v)
    else:
        n = nt.nodes.new("ShaderNodeValue")
        n.outputs[0].default_value = float(v)
    n["bake_tmp"] = 1
    return n.outputs[0]


class Atlas:
    def __init__(self, key, size, nrm_size, orm_size):
        self.key = key
        self.size = size
        self.img = {}
        self.ao_baked = False
        for p, s, cs in (("base", size, 'sRGB'), ("rough", orm_size, 'Non-Color'), ("metal", orm_size, 'Non-Color'),
                         ("nrm", nrm_size, 'Non-Color'), ("ao", orm_size, 'Non-Color')):
            name = f"F35_Atlas{key}_{p}"
            old = bpy.data.images.get(name)
            if old is not None:
                bpy.data.images.remove(old)
            img = bpy.data.images.new(name, s, s, alpha=False, float_buffer=False)
            img.colorspace_settings.name = cs
            self.img[p] = img


def _select_faces(objs, mat_names):
    for o in objs:
        me = o.data
        idx = {i for i, m in enumerate(me.materials) if m is not None and m.name in mat_names}
        sel = np.array([p.material_index in idx for p in me.polygons], bool)
        me.polygons.foreach_set("select", sel)
        me.vertices.foreach_set("select", np.zeros(len(me.vertices), bool))
        me.edges.foreach_set("select", np.zeros(len(me.edges), bool))
        for p in me.polygons:
            if p.select:
                for v in p.vertices:
                    me.vertices[v].select = True
        me.update()


def _unwrap(objs, mat_names, label):
    """Smart-project the faces using mat_names on objs into one shared 0..1 UV space."""
    objs = [o for o in objs if any(m is not None and m.name in mat_names for m in o.data.materials)]
    if not objs:
        return
    for o in objs:
        if "UVMap" not in o.data.uv_layers:
            o.data.uv_layers.new(name="UVMap")
        o.data.uv_layers.active = o.data.uv_layers["UVMap"]
    t0 = time.time()
    _select_faces(objs, mat_names)
    vl = bpy.context.view_layer
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    vl.objects.active = objs[0]
    with bpy.context.temp_override(active_object=objs[0], object=objs[0], selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(60.0), island_margin=0.0, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
        try:
            bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, scale=True, margin_method='FRACTION',
                                    margin=0.0022, shape_method='CONCAVE')
        except TypeError:
            bpy.ops.uv.pack_islands(rotate=True, margin=0.0022)
        bpy.ops.object.mode_set(mode='OBJECT')
    log(f"  unwrapped atlas {label}: {len(objs)} objects ({time.time() - t0:.0f} s)")


def _uv_fill(objs, mat_names):
    """Fraction of the UV square covered by the faces of mat_names (packing check)."""
    tot = 0.0
    for o in objs:
        me = o.data
        uv = me.uv_layers.get("UVMap")
        if uv is None:
            continue
        idx = {i for i, m in enumerate(me.materials) if m is not None and m.name in mat_names}
        for p in me.polygons:
            if p.material_index not in idx:
                continue
            pts = [uv.data[li].uv for li in p.loop_indices]
            a = 0.0
            for i in range(1, len(pts) - 1):
                a += abs((pts[i].x - pts[0].x) * (pts[i + 1].y - pts[0].y) -
                         (pts[i + 1].x - pts[0].x) * (pts[i].y - pts[0].y)) * 0.5
            tot += a
    return tot


def _rewire_emit(mat, input_name):
    """Material output <- Emission(<the BSDF input's source>). Returns an undo record."""
    nt = mat.node_tree
    out = _out(mat)
    old = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].is_linked else None
    em = nt.nodes.new("ShaderNodeEmission")
    em["bake_tmp"] = 1
    em.inputs["Strength"].default_value = 1.0
    nt.links.new(_source(mat, input_name), em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    return (mat, old)


def _rewire_ao(mat, distance, rays):
    """Material output <- Emission(Ambient Occlusion node's AO: 1 open .. 0 enclosed). Undo record."""
    nt = mat.node_tree
    out = _out(mat)
    old = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].is_linked else None
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao["bake_tmp"] = 1
    ao.samples = rays
    ao.inside = False
    ao.only_local = False
    ao.inputs["Distance"].default_value = distance
    em = nt.nodes.new("ShaderNodeEmission")
    em["bake_tmp"] = 1
    em.inputs["Strength"].default_value = 1.0
    nt.links.new(ao.outputs["AO"], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    return (mat, old)


def _is_door(o):
    return "Door" in str(o.get("node", "")) or "Door" in str(o.get("src", ""))


def _fill(img, value):
    n = img.size[0] * img.size[1] * 4
    img.pixels.foreach_set(np.full(n, value, np.float32))


def _blur3(a):
    """3 x 3 box blur (the occlusion's sampling noise), edges clamped."""
    p = np.pad(a, 1, mode='edge')
    return (p[:-2, :-2] + p[:-2, 1:-1] + p[:-2, 2:] + p[1:-1, :-2] + p[1:-1, 1:-1] + p[1:-1, 2:] +
            p[2:, :-2] + p[2:, 1:-1] + p[2:, 2:]) / 9.0


def _restore(rec):
    mat, old = rec
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.get("bake_tmp"):
            nt.nodes.remove(n)
    if old is not None:
        nt.links.new(old, _out(mat).inputs["Surface"])


def _set_target(mat, img):
    nt = mat.node_tree
    n = nt.nodes.get("BakeTarget")
    if n is None:
        n = nt.nodes.new("ShaderNodeTexImage")
        n.name = "BakeTarget"
        n.label = "BakeTarget"
    n.image = img
    for x in nt.nodes:
        x.select = False
    n.select = True
    nt.nodes.active = n


def _clear_target(mat):
    n = mat.node_tree.nodes.get("BakeTarget")
    if n is not None:
        mat.node_tree.nodes.remove(n)


def _bake(objs, kind, samples, margin, clear=True):
    sc = bpy.context.scene
    sc.cycles.samples = samples
    vl = bpy.context.view_layer
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    vl.objects.active = objs[0]
    kw = dict(type=kind, margin=margin, margin_type='EXTEND', use_clear=clear, target='IMAGE_TEXTURES')
    if kind == 'NORMAL':
        kw.update(normal_space='TANGENT', normal_r='POS_X', normal_g='POS_Y', normal_b='POS_Z')
    with bpy.context.temp_override(active_object=objs[0], object=objs[0], selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.bake(**kw)


def _make_proxy(targets, shift=None):
    """A temporary object holding copies of all bake targets in world space (they share the atlas
    UVs, so baking it fills the same texels).  Every other object is hidden from render.
    shift(o) -> (dx, dy, dz) or None moves a target's copy (the doors, for the occlusion pass).
    Returns (proxy, objects hidden)."""
    sc = bpy.context.scene
    dups = []
    for o in targets:
        d = o.copy()
        d.data = o.data.copy()
        sc.collection.objects.link(d)
        off = shift(o) if shift else None
        if off:
            d.location = d.location + Vector(off)
        dups.append(d)
    if shift:
        bpy.context.view_layer.update()     # the moved copies' matrices, for the join
    proxy = dups[0]                         # join into a copy: it carries the UV map and attributes
    proxy.name = "BakeProxy"
    with bpy.context.temp_override(active_object=proxy, object=proxy, selected_objects=dups,
                                   selected_editable_objects=dups):
        bpy.ops.object.join()
    proxy.data.uv_layers.active = proxy.data.uv_layers["UVMap"]
    hidden = []
    for o in sc.objects:
        if o is not proxy and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    log(f"  bake proxy: {len(proxy.data.polygons)} faces from {len(targets)} objects")
    return proxy, hidden


def _drop_proxy(proxy, hidden):
    for o in hidden:
        o.hide_render = False
    me = proxy.data
    bpy.data.objects.remove(proxy)
    bpy.data.meshes.remove(me)


def _mute_fine_bump(mat):
    """The skin's 180/m grain bump would alias in a 3 mm/texel normal map: bake the panel grooves only."""
    out = []
    for n in mat.node_tree.nodes:
        if n.type == 'BUMP' and not n.invert:
            out.append((n, n.inputs["Strength"].default_value))
            n.inputs["Strength"].default_value = 0.0
    return out


def bake_skin(copies, outdir, size=4096, nrm_size=4096, orm_size=2048, samples=4, ao_spp=8):
    """copies: all export copies (objects).  Bakes, saves the images in outdir and swaps the skin,
    intake and nozzle materials for image-based ones.  ao_spp: samples of the occlusion pass (0: none).
    Returns {atlas: {base, orm, nrm: image files, ao: whether ORM R holds the occlusion}}."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    try:
        sc.cycles.use_denoising = False
    except Exception:
        pass
    skin = bpy.data.materials[SKIN]
    bake_mats = {"A": skin.copy(), "B": skin.copy()}
    bake_mats["A"].name, bake_mats["B"].name = "Bake_Skin_A", "Bake_Skin_B"
    misc = {}
    for src, dst in MISC.items():
        m = bpy.data.materials.get(src)
        if m is not None:
            misc[src] = m.copy()
            misc[src].name = dst
    dummy_img = bpy.data.images.new("Bake_Dummy", 8, 8)
    dummy = bpy.data.materials.new("Bake_Dummy")
    dummy.use_nodes = True
    _set_target(dummy, dummy_img)
    # ---------------------------------------------------------- assign bake materials
    targets = []                   # objects that take part in the bake
    restore_slots = []
    for o in copies:
        me = o.data
        names = [m.name if m else None for m in me.materials]
        if SKIN not in names and not any(n in misc for n in names):
            continue
        targets.append(o)
        for i, m in enumerate(me.materials):
            if m is None:
                continue
            if m.name == SKIN:
                me.materials[i] = bake_mats[atlas_of(o["src"])]
            elif m.name in misc:
                me.materials[i] = misc[m.name]
            else:
                restore_slots.append((me, i, m))
                me.materials[i] = dummy
    atlases = {"A": Atlas("A", size, nrm_size, orm_size), "B": Atlas("B", size, nrm_size, orm_size)}
    # ---------------------------------------------------------- UVs
    for o in targets:
        for uv in list(o.data.uv_layers):
            o.data.uv_layers.remove(uv)
    a_objs = [o for o in targets if any(m is not None and m.name == "Bake_Skin_A" for m in o.data.materials)]
    b_names = {"Bake_Skin_B"} | {m.name for m in misc.values()}
    b_objs = [o for o in targets if any(m is not None and m.name in b_names for m in o.data.materials)]
    _unwrap(a_objs, {"Bake_Skin_A"}, "A")
    _unwrap(b_objs, b_names, "B")
    log(f"  UV fill: A {_uv_fill(a_objs, {'Bake_Skin_A'}):.2f}, B {_uv_fill(b_objs, b_names):.2f}")
    for o in targets:                                  # faces outside the atlases (dummy) keep uv 0,0
        if "UVMap" not in o.data.uv_layers:
            o.data.uv_layers.new(name="UVMap")
    mats_of = {"A": [bake_mats["A"]], "B": [bake_mats["B"]] + list(misc.values())}
    # ---------------------------------------------------------- passes
    # Cycles builds a render depsgraph of the whole scene for every object it bakes: bake one
    # joined stand-in of all targets, with everything else hidden from render.
    proxy, hidden = _make_proxy(targets)
    try:
        for p, inp, spp in (("base", "Base Color", samples), ("rough", "Roughness", max(1, samples // 2)),
                            ("metal", "Metallic", 1)):
            recs = []
            for key, mats in mats_of.items():
                for m in mats:
                    recs.append(_rewire_emit(m, inp))
                    _set_target(m, atlases[key].img[p])
            log(f"  baking {p} ({spp} spp)")
            _bake([proxy], 'EMIT', spp, 16)
            for r in recs:
                _restore(r)
        muted = _mute_fine_bump(bake_mats["A"]) + _mute_fine_bump(bake_mats["B"])
        for key, mats in mats_of.items():
            for m in mats:
                _set_target(m, atlases[key].img["nrm"])
        log("  baking normals")
        _bake([proxy], 'NORMAL', samples, 16)
        for n, v in muted:
            n.inputs["Strength"].default_value = v
    finally:
        _drop_proxy(proxy, hidden)
    # ---------------------------------------------------------- ambient occlusion -> ORM R
    if ao_spp > 0:
        try:
            _bake_ao(targets, mats_of, atlases, ao_spp)
        except Exception as e:                           # the export goes on without it (R = 1)
            log(f"  WARNING the occlusion bake failed, ORM R stays 1: {e}")
    # ---------------------------------------------------------- save
    os.makedirs(outdir, exist_ok=True)
    files = {}
    for key, at in atlases.items():
        files[key] = _save_atlas(at, outdir)
    # ---------------------------------------------------------- final materials
    final = {"A": image_material("F35_Skin_A", files["A"], coat=True),
             "B": image_material("F35_Skin_B", files["B"], coat=True),
             "M": image_material("F35_Misc_B", files["B"], coat=False)}
    for o in targets:
        me = o.data
        for i, m in enumerate(me.materials):
            if m is None:
                continue
            if m.name == "Bake_Skin_A":
                me.materials[i] = final["A"]
            elif m.name == "Bake_Skin_B":
                me.materials[i] = final["B"]
            elif m.name in b_names:
                me.materials[i] = final["M"]
    for me, i, m in restore_slots:
        me.materials[i] = m
    for m in list(bake_mats.values()) + list(misc.values()) + [dummy]:
        bpy.data.materials.remove(m)
    return files


def _bake_ao(targets, mats_of, atlases, spp):
    """The airframe's occlusion of itself into each atlas's "ao" image, the doors moved away."""
    for at in atlases.values():
        _fill(at.img["ao"], 1.0)                         # texels outside the islands stay open
    proxy, hidden = _make_proxy(targets, shift=lambda o: (0.0, 0.0, DOOR_SHIFT) if _is_door(o) else None)
    recs = []
    try:
        for key, mats in mats_of.items():
            for m in mats:
                recs.append(_rewire_ao(m, AO_DISTANCE, AO_RAYS))
                _set_target(m, atlases[key].img["ao"])
        log(f"  baking occlusion ({spp} spp x {AO_RAYS} rays, {AO_DISTANCE} m, doors moved away)")
        _bake([proxy], 'EMIT', spp, 16, clear=False)
        for at in atlases.values():
            at.ao_baked = True
    finally:
        for r in recs:
            _restore(r)
        _drop_proxy(proxy, hidden)


def _save_atlas(at, outdir):
    """base -> JPEG; occlusion + roughness + metallic -> one ORM PNG (R, G, B); normals -> PNG."""
    out = {}
    base = at.img["base"]
    path = os.path.join(outdir, f"f35i_skin{at.key}_base.jpg")
    base.file_format = 'JPEG'
    sc = bpy.context.scene
    st = sc.render.image_settings
    st.file_format = 'JPEG'
    st.quality = 92
    st.color_mode = 'RGB'
    base.save_render(path, scene=sc)
    out["base"] = path
    s = at.img["rough"].size[0]
    r = np.array(at.img["rough"].pixels[:], np.float32).reshape(s, s, 4)
    m = np.array(at.img["metal"].pixels[:], np.float32).reshape(s, s, 4)
    orm = np.ones((s, s, 4), np.float32)
    if at.ao_baked and at.img["ao"].size[0] == s:
        a = np.array(at.img["ao"].pixels[:], np.float32).reshape(s, s, 4)
        orm[:, :, 0] = np.clip(_blur3(a[:, :, 0]), 0.0, 1.0)
    orm[:, :, 1] = r[:, :, 0]
    orm[:, :, 2] = m[:, :, 0]
    img = bpy.data.images.new(f"F35_Atlas{at.key}_orm", s, s, alpha=False)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(orm.ravel())
    path = os.path.join(outdir, f"f35i_skin{at.key}_orm.png")
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    out["orm"] = path
    out["ao"] = bool(at.ao_baked)
    nrm = at.img["nrm"]
    path = os.path.join(outdir, f"f35i_skin{at.key}_nrm.png")
    nrm.filepath_raw = path
    nrm.file_format = 'PNG'
    nrm.save()
    out["nrm"] = path
    return out


def _gltf_output_group():
    """The node group Blender's glTF exporter reads extra outputs from (Occlusion, Thickness), as
    its own add-on creates it."""
    g = bpy.data.node_groups.get("glTF Material Output")
    if g is not None:
        return g
    g = bpy.data.node_groups.new("glTF Material Output", 'ShaderNodeTree')
    g.interface.new_socket("Occlusion", in_out='INPUT', socket_type='NodeSocketFloat')
    th = g.interface.new_socket("Thickness", in_out='INPUT', socket_type='NodeSocketFloat')
    th.default_value = 0.0
    g.nodes.new('NodeGroupOutput')
    g.nodes.new('NodeGroupInput')
    return g


def _load(path, colorspace):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


def image_material(name, files, coat):
    """Principled BSDF on the baked images, in the node layout Blender's glTF exporter maps to
    baseColorTexture, metallicRoughnessTexture, normalTexture (+ KHR_materials_clearcoat)."""
    old = bpy.data.materials.get(name)
    if old is not None:
        bpy.data.materials.remove(old)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    b = _bsdf(mat)
    tb = nt.nodes.new("ShaderNodeTexImage")
    tb.image = _load(files["base"], 'sRGB')
    nt.links.new(tb.outputs["Color"], b.inputs["Base Color"])
    to = nt.nodes.new("ShaderNodeTexImage")
    to.image = _load(files["orm"], 'Non-Color')
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(to.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], b.inputs["Metallic"])
    if files.get("ao"):
        # ORM R -> the exporter's occlusionTexture (it shares the ORM image with metallicRoughness)
        try:
            grp = nt.nodes.new("ShaderNodeGroup")
            grp.node_tree = _gltf_output_group()
            grp.label = "glTF Material Output"
            nt.links.new(sep.outputs["Red"], grp.inputs["Occlusion"])
        except Exception as e:
            log(f"  WARNING no occlusionTexture for {name}: {e}")
    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = _load(files["nrm"], 'Non-Color')
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    b.inputs["Specular IOR Level"].default_value = 0.5
    if coat:
        # satin top coat of the Have Glass paint (sky sheen at glancing angles) and a little sheen,
        # as in the Blender skin (coat 0.6, less on the RAM tape; sheen 0.15)
        b.inputs["Coat Weight"].default_value = 0.5
        b.inputs["Coat Roughness"].default_value = 0.3
        b.inputs["Coat IOR"].default_value = 1.5
        # (the glTF exporter writes the sheen tint as KHR_materials_sheen's colour and drops the weight:
        # weight 1 x tint 0.15 is the same sheen in Blender and survives the export)
        b.inputs["Sheen Weight"].default_value = 1.0
        b.inputs["Sheen Tint"].default_value = (0.15, 0.15, 0.15, 1.0)
        b.inputs["Sheen Roughness"].default_value = 0.5
    return mat
