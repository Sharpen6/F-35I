"""A small photo studio for the pilot on its own: a separate Blender scene with a curved
backdrop, three area lights and the project's sky for reflections; renders go to renders/pilot/."""
import math
import os

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "renders", "pilot")
SCENE = "Pilot_Studio"

# name: (camera location, look-at target, lens mm, resolution)
VIEWS = {
    "front34": ((-1.55, -3.55, 1.25), (0.0, 0.0, 0.95), 70, (900, 1200)),
    "front": ((0.0, -4.2, 1.05), (0.0, 0.0, 0.95), 70, (900, 1200)),
    "side": ((-4.2, 0.0, 1.05), (0.0, 0.0, 0.95), 70, (900, 1200)),
    "back34": ((1.6, 3.5, 1.30), (0.0, 0.0, 0.95), 70, (900, 1200)),
    "head34": ((-0.55, -0.95, 1.78), (0.0, 0.0, 1.66), 85, (1000, 1000)),
    "head_side": ((-1.05, -0.05, 1.70), (0.0, 0.0, 1.66), 85, (1000, 1000)),
    "head_back": ((0.45, 0.95, 1.85), (0.0, 0.0, 1.66), 85, (1000, 1000)),
    "torso": ((-0.65, -1.45, 1.45), (0.0, 0.0, 1.20), 70, (1000, 1000)),
    "legs": ((-0.8, -1.6, 0.65), (0.0, 0.0, 0.50), 60, (1000, 1000)),
    "hands": ((-0.75, -0.95, 0.95), (0.18, 0.0, 0.80), 85, (1000, 1000)),
}


def scene():
    """The studio scene (created on first use) and its 'Pilot' collection."""
    sc = bpy.data.scenes.get(SCENE)
    if sc is None:
        sc = bpy.data.scenes.new(SCENE)
        _setup(sc)
    coll = sc.collection.children.get("Pilot")
    if coll is None:
        coll = bpy.data.collections.new("Pilot")
        sc.collection.children.link(coll)
    return sc, coll


def adopt(sc):
    """Turn an existing (e.g. the factory default) scene into the studio: in a background Blender
    there is no window to switch scenes, so the context scene itself must be the studio."""
    if sc.name != SCENE:
        old = bpy.data.scenes.get(SCENE)
        if old is not None and old != sc:
            old.name = SCENE + "_old"
        sc.name = SCENE
    if sc.collection.children.get("Pilot_Stage") is None:
        _setup(sc)
    return scene()


def clear(coll):
    for ob in list(coll.all_objects):
        me = ob.data if ob.type == 'MESH' else None
        bpy.data.objects.remove(ob)
        if me is not None and me.users == 0:
            bpy.data.meshes.remove(me)
    for ch in list(coll.children):
        clear(ch)
        bpy.data.collections.remove(ch)


def _setup(sc):
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'GPU'
    sc.cycles.samples = 48
    sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.view_settings.exposure = -0.35
    sc.render.film_transparent = False
    # world: the project's airfield HDRI (references/hdri) lights the pilot softly and fills the
    # visor and the steel with real sky reflections; the camera itself sees a plain grey studio
    w = bpy.data.worlds.new("Pilot_World")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_WORLD')
    bg = next((n for n in nt.nodes if n.type == 'BACKGROUND'), None) or nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.35
    hdri = _hdri_file()
    if hdri:
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(hdri, check_existing=True)
        nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    else:
        bg.inputs["Color"].default_value = (0.55, 0.6, 0.7, 1.0)
    grey = nt.nodes.new("ShaderNodeBackground")
    grey.inputs["Color"].default_value = (0.16, 0.165, 0.17, 1.0)
    grey.inputs["Strength"].default_value = 1.0
    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(bg.outputs[0], mix.inputs[1])
    nt.links.new(grey.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    stage = bpy.data.collections.new("Pilot_Stage")
    sc.collection.children.link(stage)
    # cyclorama: floor + curved wall behind (y > 0) and to the right
    import bmesh
    bm = bmesh.new()
    prof = []
    for i in range(13):
        a = math.radians(90 * i / 12)
        prof.append((3.0 + 1.0 * math.sin(a), 1.0 - 1.0 * math.cos(a)))
    prof = [(-6.0, 0.0)] + prof + [(4.0, 6.0)]
    rows = []
    for x in (-7.0, 7.0):
        rows.append([bm.verts.new((x, y, z)) for y, z in prof])
    for i in range(len(prof) - 1):
        bm.faces.new((rows[0][i], rows[1][i], rows[1][i + 1], rows[0][i + 1]))
    me = bpy.data.meshes.new("Pilot_Cyclorama")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    cy = bpy.data.objects.new("Pilot_Cyclorama", me)
    stage.objects.link(cy)
    mat = bpy.data.materials.new("Pilot_Backdrop")
    mat.use_nodes = True
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.18, 0.185, 0.19, 1)
    b.inputs["Roughness"].default_value = 0.9
    me.materials.append(mat)
    # lights
    for name, loc, energy, size, color in (
            ("Pilot_Key", (-2.2, -2.4, 3.0), 480.0, 1.6, (1.0, 0.97, 0.92)),
            ("Pilot_Fill", (2.6, -2.0, 1.6), 180.0, 2.2, (0.92, 0.96, 1.0)),
            ("Pilot_Rim", (1.2, 2.4, 2.6), 450.0, 1.0, (1.0, 1.0, 1.0))):
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy = energy * 0.75
        ld.shape = 'DISK'            # round softboxes: no hard rectangles in the visor
        ld.size = size
        ld.color = color
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        _look(lo, Vector((0, 0, 1.0)))
        if name == "Pilot_Fill":
            # the fill only lifts the shadows: no white disc of it in the visor and the steel
            lo.visible_glossy = False
        stage.objects.link(lo)
    cam = bpy.data.cameras.new("Pilot_Cam")
    co = bpy.data.objects.new("Pilot_Cam", cam)
    stage.objects.link(co)
    sc.camera = co


def _hdri_file():
    import glob
    d = os.path.join(ROOT, "references", "hdri")
    for pat in ("*_2k.exr", "*_2k.hdr", "*.exr", "*.hdr"):
        f = sorted(glob.glob(os.path.join(d, pat)))
        if f:
            return f[0]
    return None


def _look(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def turntable(frames=120, samples=48, res=(1280, 720), out_dir=None, cam=((0.0, -5.0, 1.30), (0.0, 0.0, 0.90), 50),
              start_deg=-35.0, rig="Pilot_Rig", first=1):
    """The pilot turns once on the spot in front of a fixed camera (the lights stay put, as on a
    real turntable): frames <out_dir>/0001.png ...  Returns the folder."""
    sc, _coll = scene()
    arm = bpy.data.objects[rig]
    out_dir = out_dir or os.path.join(ROOT, "renders", "frames", "pilot_turntable")
    os.makedirs(out_dir, exist_ok=True)
    win = bpy.context.window
    prev = win.scene if win else None
    if win:
        win.scene = sc
    c = sc.camera
    c.location = cam[0]
    _look(c, cam[1])
    c.data.lens = cam[2]
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.cycles.samples = samples
    rz = arm.rotation_euler.z
    try:
        for f in range(first - 1, frames):
            arm.rotation_euler.z = math.radians(start_deg + 360.0 * f / frames)
            sc.render.filepath = os.path.join(out_dir, f"{f + 1:04d}.png")
            bpy.ops.render.render(write_still=True, scene=sc.name)
    finally:
        arm.rotation_euler.z = rz
        if win and prev:
            win.scene = prev
    return out_dir


def render(views, samples=48, prefix="", scale=1.0):
    """Render views of the studio scene to renders/pilot/<prefix><view>.png."""
    sc, _coll = scene()
    os.makedirs(OUT, exist_ok=True)
    win = bpy.context.window
    prev = win.scene if win else None
    if win:
        win.scene = sc
    sc.cycles.samples = samples
    out = {}
    try:
        for v in views:
            loc, tgt, lens, res = VIEWS[v]
            cam = sc.camera
            cam.location = loc
            _look(cam, tgt)
            cam.data.lens = lens
            sc.render.resolution_x = int(res[0] * scale)
            sc.render.resolution_y = int(res[1] * scale)
            sc.render.filepath = os.path.join(OUT, f"{prefix}{v}.png")
            bpy.ops.render.render(write_still=True, scene=sc.name)
            out[v] = sc.render.filepath
    finally:
        if win and prev:
            win.scene = prev
    return out
