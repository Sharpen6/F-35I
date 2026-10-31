"""Presentation scene: airfield HDRI (or a physical sky) + sun, concrete apron, named cameras,
render settings (Cycles by default, EEVEE ready)."""
import json
import math
import os

import bpy
from mathutils import Vector

from .geom import GROUND_Z, get_collection, mesh_object

CAMERAS = {
    # name: (location, target, lens)
    "Cam_Hero_FrontLeft": ((10.5, -15.0, 0.4), (0.3, -1.0, -0.2), 55),
    "Cam_Hero_FrontRight": ((-10.5, -15.0, 0.4), (-0.3, -1.0, -0.2), 55),
    "Cam_Side_Left": ((24.0, 0.2, -0.2), (0.0, 0.2, -0.2), 50),
    "Cam_Rear_Quarter": ((-9.5, 15.5, 1.8), (0.0, 1.5, 0.0), 50),
    "Cam_Top": ((0.0, 0.0, 34.0), (0.0, 0.0, 0.0), 45),
    "Cam_Front_Low": ((0.0, -19.0, -0.9), (0.0, 0.0, -0.4), 60),
    "Cam_Cockpit_Over": ((0.95, -2.6, 2.35), (0.0, -4.2, 0.65), 28),
    "Cam_Cockpit_Pilot": ((0.0, -3.95, 1.14), (0.0, -5.2, 0.62), 18),
    "Cam_Gear_Main": ((-5.6, -1.0, -1.25), (-1.9, 2.3, -0.9), 32),
    "Cam_Gear_Nose": ((-2.6, -7.6, -1.1), (0.0, -3.6, -0.9), 35),
    "Cam_Belly": ((-3.0, -4.0, -1.55), (0.0, 1.5, -0.8), 22),
    "Cam_Nozzle": ((-4.2, 12.5, 0.6), (0.0, 6.2, 0.15), 45),
}


def _look(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def concrete_material():
    mat = bpy.data.materials.get("F35_Apron") or bpy.data.materials.new("F35_Apron")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 0.35
    noise.inputs["Detail"].default_value = 8.0
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.30, 0.30, 0.29, 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (0.46, 0.45, 0.43, 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    # 5 m slabs with dark expansion joints
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.offset = 0.0
    brick.squash = 1.0
    brick.inputs["Scale"].default_value = 0.2
    brick.inputs["Mortar Size"].default_value = 0.004
    brick.inputs["Brick Width"].default_value = 1.0
    brick.inputs["Row Height"].default_value = 1.0
    brick.inputs["Color1"].default_value = (1, 1, 1, 1)
    brick.inputs["Color2"].default_value = (0.95, 0.95, 0.95, 1)
    brick.inputs["Mortar"].default_value = (0.25, 0.25, 0.25, 1)
    nt.links.new(tc.outputs["Object"], brick.inputs["Vector"])
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs["Factor"].default_value = 1.0
    nt.links.new(ramp.outputs["Color"], mul.inputs["A"])
    nt.links.new(brick.outputs["Color"], mul.inputs["B"])
    nt.links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.88
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.15
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    mat.diffuse_color = (0.38, 0.38, 0.37, 1)
    return mat


SUN_ELEV, SUN_ROT = 48.0, 200.0       # mid-morning desert sun (deg)

# Real sky for lighting and reflections: a CC0 HDRI from Poly Haven (scripts/tools/get_hdri.py).
# The sun is cut out of the HDRI (clamped) and replaced by a sun lamp with the same direction and
# irradiance, so shadows stay crisp and noise free.  The HDRI is turned so that its sun sits at
# SUN_ROT.  Without the file the procedural sky below is used.
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HDRI_DIR = os.path.join(REPO, "references", "hdri")
HDRI = "kloofendal_48d_partly_cloudy"   # open horizon, bright cumulus, sun at 48 deg
HDRI_SIZES = ("2k",)                  # the size the saved blend uses (the 2k file is in git)
HDRI_SUN_REL = 40.0                   # pixels brighter than 40 x the median sky count as sun
HDRI_SUN_TINT = 0.5                   # keep half of the measured sun colour (the HDRI's is very warm)


def hdri_file(name=None, sizes=None):
    name = name or HDRI
    for size in sizes or HDRI_SIZES:
        for ext in ("hdr", "exr"):
            p = os.path.join(HDRI_DIR, f"{name}_{size}.{ext}")
            if os.path.exists(p):
                return p
    return None


def _equirect_dir(u, v):
    """Cycles' equirectangular mapping: u = (pi - atan2(y, x)) / 2pi, v = 0.5 + elevation / pi."""
    az = math.pi - 2.0 * math.pi * u
    el = (v - 0.5) * math.pi
    return Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))


def hdri_sun(path, rel=None):
    """Sun of an equirectangular HDRI: direction (texture space), RGB irradiance of the pixels
    above the clamp level, and that level.  Cached in <file>.sun.json."""
    rel = rel or HDRI_SUN_REL
    cache = os.path.splitext(path)[0] + ".sun.json"
    if os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(path):
        with open(cache) as f:
            c = json.load(f)
        if c.get("rel") == rel:
            return c
    import numpy as np
    img = bpy.data.images.load(path, check_existing=True)
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    rgb = px.reshape(H, W, 4)[:, :, :3].astype(np.float64)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    el = ((np.arange(H) + 0.5) / H - 0.5) * math.pi
    d_omega = (2 * math.pi / W) * (math.pi / H) * np.cos(el)            # solid angle per pixel, by row
    level = float(np.median(lum[H // 2:])) * rel
    mask = lum > level
    rows, cols = np.nonzero(mask)
    excess = (rgb[rows, cols] - level).clip(0.0) * d_omega[rows, None]  # W/m2 per pixel and channel
    irr = excess.sum(axis=0)
    wsum = excess @ np.array([0.2126, 0.7152, 0.0722])
    d = Vector((0.0, 0.0, 0.0))
    for r, c_, w in zip(rows, cols, wsum):
        d += _equirect_dir((c_ + 0.5) / W, (r + 0.5) / H) * float(w)
    d.normalize()
    c = {"rel": rel, "level": level, "dir": list(d), "irradiance": [float(x) for x in irr],
         "elevation_deg": math.degrees(math.asin(d.z)), "pixels": int(mask.sum()),
         "peak": float(lum.max()), "sky_median": float(np.median(lum[H // 2:])), "size": [W, H]}
    with open(cache, "w") as f:
        json.dump(c, f, indent=1)
    return c


def _sun_lamp_rotation(elev_deg, rot_deg):
    return (math.radians(90 - elev_deg), 0.0, math.radians(rot_deg - 90.0))


def build_world(sun_elev=SUN_ELEV, sun_rot=SUN_ROT, strength=0.05, hdri=True):
    """World shader.  Returns (world, sun) where sun = dict(elev, rot, strength, color) for the
    lamp: from the HDRI when one is used, else the defaults for the procedural sky."""
    sc = bpy.context.scene
    world = bpy.data.worlds.get("F35_World") or bpy.data.worlds.new("F35_World")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    path = hdri_file() if hdri else None
    if path:
        info = hdri_sun(path)
        d = Vector(info["dir"])
        az_tex = math.atan2(d.y, d.x)
        az_want = math.radians(sun_rot - 180.0)          # azimuth of the lamp's sun (see build)
        rho = az_tex - az_want                           # texture lookup = Rz(rho) . world direction
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Rotation"].default_value = (0.0, 0.0, rho)
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(path, check_existing=True)   # build_f35i.save stores it relative
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], env.inputs["Vector"])
        clamp = nt.nodes.new("ShaderNodeVectorMath")      # sun removed for lighting ...
        clamp.operation = 'MINIMUM'
        lv = info["level"]
        clamp.inputs[1].default_value = (lv, lv, lv)
        nt.links.new(env.outputs["Color"], clamp.inputs[0])
        lp = nt.nodes.new("ShaderNodeLightPath")           # ... but kept for the camera
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = 'RGBA'
        nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Factor"])
        nt.links.new(clamp.outputs["Vector"], mix.inputs["A"])
        nt.links.new(env.outputs["Color"], mix.inputs["B"])
        nt.links.new(mix.outputs["Result"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = 1.0
        nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
        irr = info["irradiance"]
        lum = 0.2126 * irr[0] + 0.7152 * irr[1] + 0.0722 * irr[2]
        irr = [lum + HDRI_SUN_TINT * (x - lum) for x in irr]
        peak = max(irr)
        world["hdri"] = os.path.basename(path)
        world["hdri_rotation_deg"] = math.degrees(rho)
        sun = dict(elev=info["elevation_deg"], rot=sun_rot, strength=peak,
                   color=tuple(x / peak for x in irr))
        return world, sun
    sky = nt.nodes.new("ShaderNodeTexSky")
    try:
        sky.sky_type = 'MULTIPLE_SCATTERING'
    except Exception:
        sky.sky_type = 'NISHITA'
    sky.sun_elevation = math.radians(sun_elev)
    sky.sun_rotation = math.radians(sun_rot)
    sky.sun_disc = False
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return world, dict(elev=sun_elev, rot=sun_rot, strength=4.0, color=(1.0, 1.0, 1.0))


def use_hdri_size(*sizes):
    """Swap the world's HDRI for a bigger copy of the same file, e.g. use_hdri_size("8k", "4k"),
    for sharper backgrounds in final renders (the sun lamp and the clamp level stay the same).
    The saved blend uses the 2k file that is kept in git.  Returns the path used."""
    w = bpy.context.scene.world
    if not (w and w.use_nodes):
        return None
    for n in w.node_tree.nodes:
        if n.type != 'TEX_ENVIRONMENT' or not n.image:
            continue
        p = bpy.path.abspath(n.image.filepath)
        stem, ext = os.path.splitext(p)
        base = stem.rsplit("_", 1)[0]
        for size in sizes:
            for e in (ext, ".hdr", ".exr"):
                q = f"{base}_{size}{e}"
                if os.path.exists(q):
                    if os.path.normcase(os.path.abspath(q)) != os.path.normcase(os.path.abspath(p)):
                        n.image = bpy.data.images.load(q, check_existing=True)
                    return q
        return p
    return None


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Scene", root)
    sc = bpy.context.scene
    world, sinfo = build_world()
    # sun lamp matching the sky (direction and irradiance taken from the HDRI when there is one)
    sd = bpy.data.lights.new("Sun", 'SUN')
    sd.energy = sinfo["strength"]
    sd.color = sinfo["color"]
    sd.angle = math.radians(0.55)
    sun = bpy.data.objects.new("Sun", sd)
    coll.objects.link(sun)
    sun.rotation_euler = _sun_lamp_rotation(sinfo["elev"], sinfo["rot"])
    # apron
    R = 220.0
    z = GROUND_Z
    ground = mesh_object("Ground_Apron", [(-R, -R, z), (R, -R, z), (R, R, z), (-R, R, z)], [(0, 1, 2, 3)],
                         coll, concrete_material(), smooth=False)
    ground["is_ground"] = True
    # cameras
    cams = get_collection("Cameras", root)
    first = None
    for name, (loc, tgt, lens) in CAMERAS.items():
        cd = bpy.data.cameras.new(name)
        cd.lens = lens
        cd.clip_start = 0.05
        cd.clip_end = 1000
        cam = bpy.data.objects.new(name, cd)
        cams.objects.link(cam)
        cam.location = loc
        _look(cam, tgt)
        first = first or cam
    # turntable rig: empty at the aircraft centre, camera on a 19 m radius
    piv = bpy.data.objects.new("Turntable_Pivot", None)
    cams.objects.link(piv)
    piv.location = (0.0, 0.3, -0.4)
    cd = bpy.data.cameras.new("Cam_Turntable")
    cd.lens = 50
    tt = bpy.data.objects.new("Cam_Turntable", cd)
    cams.objects.link(tt)
    tt.parent = piv
    tt.location = (0.0, -19.5, 3.4)
    tt.rotation_euler = (math.radians(81.5), 0, 0)
    piv["turntable_frames"] = 240
    fc_owner = piv
    piv.rotation_euler = (0, 0, 0)
    piv.keyframe_insert("rotation_euler", index=2, frame=1)
    piv.rotation_euler = (0, 0, 2 * math.pi)
    piv.keyframe_insert("rotation_euler", index=2, frame=241)
    try:
        for fc in piv.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'
    except Exception:
        try:
            for layer in piv.animation_data.action.layers:
                for strip in layer.strips:
                    for cb in strip.channelbags:
                        for fc in cb.fcurves:
                            for kp in fc.keyframe_points:
                                kp.interpolation = 'LINEAR'
        except Exception:
            pass
    sc.camera = bpy.data.objects["Cam_Hero_FrontLeft"]
    # render defaults
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    sc.render.fps = 24
    sc.frame_start, sc.frame_end = 1, 240
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 160
    sc.cycles.use_denoising = True
    try:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except Exception:
        try:
            sc.view_settings.look = 'Medium High Contrast'
        except Exception:
            pass
    ctx["objects"]["Ground_Apron"] = ground
    return ground
