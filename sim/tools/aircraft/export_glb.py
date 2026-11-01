"""Export the procedural F-35I 'Adir' (scripts/build_f35i.py) for the browser flight sim.

Writes, per sim/DESIGN.md:
    <out>/f35i.glb        the aircraft in glTF 2.0 (body skin baked into UV atlases, moving parts as
                          separate nodes, the seated pilot decimated)
    <out>/f35i_rig.json   controls -> node transforms sampled from the Blender rig (F35I_Rig), and the
                          reference data the app needs: eye point, gear contacts, nozzle, lights,
                          dimensions (sim/tools/aircraft/README.md describes the format)

Run (from the repository root):
    python3 sim/tools/aircraft/export_glb.py [--out sim/data/aircraft]          (bpy 5.1 as a module)
    blender -b --factory-startup -P sim/tools/aircraft/export_glb.py -- [--out sim/data/aircraft]

Options:
    --out DIR           output folder (default: sim/data/aircraft)
    --atlas N           skin atlas size in px (default 4096; 1024 for a quick test)
    --pilot-tris N      triangle budget for the seated pilot (default 60000)
    --blend PATH        skip the build: use an already built .blend (as saved by build_f35i.py)
    --save-blend PATH   also save the export scene (debugging)
    --work DIR          scratch folder for the baked images (default: a temp folder)
    --no-ao             no ambient occlusion (ORM R stays 1, no COLOR_0): the export of before
"""
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import common  # noqa: E402
from common import log, rnd  # noqa: E402

common.ensure_paths()

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix  # noqa: E402

PARTS = ["fuselage", "wings", "tails", "nozzle", "canopy", "cockpit", "gear", "bays", "details", "pilot",
         "markings", "panels", "rig"]           # everything but the damage model and the scene


def parse(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = argv[1:]
    opt = {"out": os.path.join(common.REPO, "sim", "data", "aircraft"), "atlas": 4096, "pilot_tris": 60000,
           "blend": None, "save_blend": None, "work": None, "ao": True}
    i = 0
    while i < len(argv):
        k = argv[i]
        if k in ("--out", "--blend", "--save-blend", "--work"):
            opt[k[2:].replace("-", "_")] = argv[i + 1]
            i += 2
        elif k == "--no-ao":
            opt["ao"] = False
            i += 1
        elif k in ("--atlas", "--pilot-tris"):
            opt[k[2:].replace("-", "_")] = int(argv[i + 1])
            i += 2
        else:
            raise SystemExit(f"unknown option {k}\n{__doc__}")
    return opt


def build_model(opt):
    if opt["blend"]:
        log("loading", opt["blend"])
        bpy.ops.wm.open_mainfile(filepath=opt["blend"])
    else:
        import build_f35i
        log("building the model (scripts/build_f35i.py, parts:", ",".join(PARTS) + ")")
        info = build_f35i.build(PARTS)
        log("built:", info)
    arm = bpy.data.objects["F35I_Rig"]
    # the rig root carries the static ground stance; the sim sets the attitude itself
    arm.matrix_world = Matrix.Identity(4)
    for name in ("Ground", "Apron"):
        ob = bpy.data.objects.get(name)
        if ob is not None:
            bpy.data.objects.remove(ob)
    bpy.context.view_layer.update()
    return arm


def export(opt):
    import prepare
    import rigsample
    import info as INFO
    import bake as BAKE
    import gltf_materials as GM
    import glb as GLB
    import vertex_ao as VAO
    from f35 import gear as G

    t0 = time.time()
    work = opt["work"] or tempfile.mkdtemp(prefix="f35i_export_")
    os.makedirs(opt["out"], exist_ok=True)
    arm = build_model(opt)
    # ------------------------------------------------------------------------ rig sampling
    objs = prepare.export_objects()
    prepare.set_modifiers(objs, False)                 # transforms only: much faster evaluation
    groups = prepare.find_groups(objs)
    struts = rigsample.add_strut_controls(arm, {"NG_Steer": G.NG_SLIDE, "MG_Oleo_L": G.MG_SLIDE,
                                                "MG_Oleo_R": G.MG_SLIDE})
    specs = rigsample.control_specs(arm, struts)
    log(f"sampling the rig: {len(specs)} controls, {len(groups)} candidate nodes")
    controls, nodes, morphs_obj = rigsample.sample_rig(arm, groups, specs, prepare.hinge_limits(groups))
    moving = set(nodes)
    groups = prepare.merge_static(groups, moving)
    node_of_obj = {ob.name: name for name, g in groups.items() for ob in g["objects"]}
    morphs = {}
    for obn, keys in morphs_obj.items():
        morphs.setdefault(node_of_obj.get(obn, obn), {}).update(keys)
    prepare.set_modifiers(objs, True)
    bpy.context.view_layer.update()
    # ------------------------------------------------------------------------ reference data
    log("reference data")
    ref = INFO.gather(arm, groups, lambda ob: node_of_obj[ob.name], struts, objs)
    # ------------------------------------------------------------------------ export copies
    log("mesh copies (modifiers applied, pilot decimated)")
    coll = bpy.data.collections.new("F35I_Export")
    bpy.context.scene.collection.children.link(coll)
    ratios = prepare.pilot_ratios(objs, opt["pilot_tris"])
    copies = prepare.build_copies(groups, coll, ratios)
    all_copies = [o for lst in copies.values() for o in lst]
    log(f"  {len(all_copies)} copies")
    # ------------------------------------------------------------------------ skin bake
    log(f"baking the skin atlases ({opt['atlas']} px)")
    files = BAKE.bake_skin(all_copies, os.path.join(work, "bake"), size=opt["atlas"], nrm_size=opt["atlas"],
                           orm_size=max(512, opt["atlas"] // 2), ao_spp=8 if opt["ao"] else 0)
    log("  baked:", files)
    ao_orm = bool(files.get("A", {}).get("ao") and files.get("B", {}).get("ao"))
    # ------------------------------------------------------------------------ materials, join
    GM.convert_all(all_copies)
    # per-vertex occlusion of the parts outside the atlases (gear, wells, bays, cockpit, pilot ...)
    ao_vertex = 0
    if opt["ao"]:
        log("vertex occlusion (parts outside the skin atlases)")
        try:
            ao_vertex = VAO.bake_vertex_ao(all_copies)
        except Exception as e:                     # the export goes on without it
            log(f"WARNING vertex occlusion failed: {e}")
            ao_vertex = 0
    node_objs = []
    for name, lst in copies.items():
        if not lst:
            continue
        o = prepare.join(lst, name, coll)
        if ao_vertex:
            VAO.set_active_color(o.data)           # (join keeps the first object's active colour)
        node_objs.append(o)
    log(f"{len(node_objs)} nodes:", ", ".join(sorted(o.name for o in node_objs)))
    # only the export collection is exported
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in node_objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = node_objs[0]
    if opt["save_blend"]:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(opt["save_blend"]), copy=True, compress=True)
        log("saved", opt["save_blend"])
    # ------------------------------------------------------------------------ glTF
    glb_path = os.path.join(opt["out"], "f35i.glb")
    tmp_glb = os.path.join(work, "f35i.glb")
    log("writing glTF")
    gltf_kw = dict(
        filepath=tmp_glb, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
        export_texcoords=True, export_normals=True, export_tangents=True, export_materials='EXPORT',
        export_image_format='AUTO', export_jpeg_quality=92, export_image_quality=92,
        export_animations=False, export_skins=False, export_morph=True,
        export_morph_normal=True, export_try_sparse_sk=False, export_lights=False, export_cameras=False,
        export_extras=False, export_attributes=False)
    # the vertex occlusion goes out as COLOR_0: the active colour attribute ("AO", vertex_ao.py)
    try:
        bpy.ops.export_scene.gltf(**gltf_kw, export_vertex_color='ACTIVE' if ao_vertex else 'NONE')
    except TypeError as e:
        if not ao_vertex:
            raise
        log(f"WARNING the glTF exporter refused export_vertex_color='ACTIVE' ({e}): no vertex occlusion")
        ao_vertex = 0
        bpy.ops.export_scene.gltf(**gltf_kw, export_vertex_color='NONE')
    doc, binc = GLB.read(tmp_glb)
    prims = [p for m in doc.get("meshes", []) for p in m.get("primitives", [])]
    color0 = sum(1 for p in prims if "COLOR_0" in p.get("attributes", {}))
    occl = sum(1 for m in doc.get("materials", []) if "occlusionTexture" in m)
    log(f"  occlusion: ORM {'yes' if ao_orm else 'no'} ({occl} materials with occlusionTexture), "
        f"COLOR_0 on {color0} of {len(prims)} primitives")
    if ao_vertex and not color0:
        log("WARNING no COLOR_0 in the glb: the vertex occlusion did not export")
        ao_vertex = 0
    patch_doc(doc)
    GLB.write(glb_path, doc, binc)
    st = GLB.stats(doc)
    size_mb = os.path.getsize(glb_path) / 1e6
    log(f"glb: {size_mb:.1f} MB, {st['triangles']} triangles, {st['nodes']} nodes, {st['primitives']} primitives, "
        f"{st['materials']} materials, morph targets {st['morph_targets']}")
    for im in st["images"]:
        log("   image", im)
    # ------------------------------------------------------------------------ rig json
    rest = {}
    for n in doc["nodes"]:
        rest[n["name"]] = n.get("translation", [0.0, 0.0, 0.0])
    for name, nd in nodes.items():
        nd["rest"] = rnd(rest.get(name, [0, 0, 0]), 6)
        if name not in rest:
            log(f"WARNING rig node {name} is not in the glb")
    mats = sorted({m["name"] for m in doc.get("materials", [])})
    rig = {
        "format": "f35i-rig",
        "version": 1,
        "generator": "sim/tools/aircraft/export_glb.py",
        "git": common.git_commit(),
        "blender": bpy.app.version_string,
        "glb": "f35i.glb",
        "frames": {
            "model": "glTF scene frame (Blender's exporter, Y up): +X left, +Y up, +Z forward. Node rest "
                     "translations, hinge pivots / axes and delta transforms are in this frame, relative to "
                     "each node's rest position (no rest rotation).",
            "body": "+X right wing, +Y up, -Z forward (sim/DESIGN.md): the model turned 180 deg about Y. "
                    "Everything under info is in this frame.",
        },
        "units": "m, rad (head_* controls in rad; roll_distance and strut_* in m)",
        "compose": [c for c in rigsample.COMPOSE if c in controls],
        "controls": controls,
        "nodes": nodes,
        "morphs": morphs,
        "materials": {
            "lights": {"F35_nav_red": "nav", "F35_nav_green": "nav", "F35_nav_white": "nav",
                       "F35_beacon": "anticoll", "F35_formation": "formation", "F35_landing_light": "landing"},
            "canopy": [m for m in mats if m.startswith("F35_canopy") and m != "F35_canopy_bow"
                       and m != "F35_canopy_frame"],
            "decals": [m for m in mats if m.startswith("F35_Decal_")],
            "all": mats,
        },
        "info": ref,
        "ao": {
            "orm": ao_orm,
            "vertex": bool(ao_vertex),
            "occlusionTexture": occl > 0,
            "distance_m": {"orm": BAKE.AO_DISTANCE, "vertex": VAO.DISTANCE},
            "note": "ambient occlusion, applied to ambient light only. orm: the skin atlases' ORM R "
                    "(the airframe on itself, doors and gear left out); vertex: COLOR_0.r of every "
                    "other part (rest pose, gear down; not a colour)",
        },
        "stats": {"triangles": st["triangles"], "nodes": st["nodes"], "primitives": st["primitives"],
                  "glb_mb": round(size_mb, 2), "seconds": round(time.time() - t0, 1)},
    }
    with open(os.path.join(opt["out"], "f35i_rig.json"), "w") as f:
        json.dump(rig, f, separators=(",", ":"))
    log(f"done in {time.time() - t0:.0f} s -> {opt['out']}")
    if not opt["work"]:
        shutil.rmtree(work, ignore_errors=True)
    return rig


def patch_doc(doc):
    """Small fixes on the exporter's JSON."""
    doc.setdefault("asset", {})["extras"] = {"f35i": "see f35i_rig.json"}
    for m in doc.get("materials", []):
        name = m.get("name", "")
        if name.startswith("F35_Decal_"):
            m["alphaMode"] = "BLEND"          # anti-aliased edges and thin stencil strokes


if __name__ == "__main__":
    export(parse(sys.argv))
