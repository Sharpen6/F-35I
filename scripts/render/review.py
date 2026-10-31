"""Review renders inside a running Blender (local GPU), e.g. via the Blender MCP.

    import sys; sys.path.insert(0, r"<repo>/scripts/render")
    import review
    review.shots(["fl34", "side"], engine="CYCLES", samples=64)
    review.match("c51", engine="CYCLES")        # render from a photo-matched camera

Outputs go to <repo>/renders/review/<prefix><view>.png.
"""
import json
import math
import os
import time

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, "renders", "review")

VIEWS = {
    # name: (location, target, lens)
    "fl34":   ((9.0, -14.0, 4.0), (0.0, -0.5, 0.0), 50),
    "fr34":   ((-9.0, -14.0, 4.0), (0.0, -0.5, 0.0), 50),
    "fl34_low": ((10.5, -15.0, 0.4), (0.3, -1.0, -0.2), 55),
    "rr34":   ((-9.0, 14.0, 4.5), (0.0, 1.0, 0.3), 50),
    "rl34":   ((9.0, 14.0, 4.5), (0.0, 1.0, 0.3), 50),
    "front":  ((0.0, -22.0, 0.6), (0.0, 0.0, 0.2), 60),
    "side":   ((24.0, 0.0, 0.5), (0.0, 0.0, 0.2), 50),
    "side_r": ((-24.0, 0.0, 0.5), (0.0, 0.0, 0.2), 50),
    "top":    ((0.0, 0.0, 30.0), (0.0, 0.0, 0.0), 50),
    "top34":  ((7.0, 3.0, 13.0), (0.0, 0.5, 0.0), 50),
    "bottom": ((-6.0, -6.0, -9.0), (0.0, 0.0, -0.4), 40),
    "nose":   ((4.5, -9.5, 1.2), (0.0, -5.6, 0.3), 45),
    "spine":  ((2.5, 4.0, 4.5), (0.0, -1.0, 0.6), 35),
    "inlet":  ((-4.5, -9.5, 0.6), (-1.0, -3.2, 0.1), 50),
    "tail":   ((-6.0, 12.0, 2.5), (0.0, 5.5, 0.6), 50),
    "cockpit": ((-1.6, -6.4, 2.2), (0.0, -4.0, 0.6), 35),
    # afterburner and nozzle (the flame runs from y = 6.2 to about 10.8)
    "ab_rear34": ((-7.5, 19.0, 0.4), (0.0, 8.3, 0.0), 45),
    "ab_side":   ((-15.0, 8.4, 0.3), (0.0, 8.4, 0.1), 50),
    "ab_rear":   ((-1.2, 24.0, 0.6), (0.0, 7.0, 0.1), 60),
    "nozzle_side": ((-4.2, 6.0, -0.55), (0.0, 5.9, 0.05), 50),
    "ab_close":  ((-3.8, 9.8, -0.15), (0.0, 7.4, 0.1), 40),
    "nozzle_rear34": ((-2.6, 10.2, 0.9), (0.0, 6.0, 0.12), 50),
}

HIDE_PREFIX = ("HB_", "Hitbox", "Smoke", "Vapour", "Cut_", "CompareCam", "PrevCam", "MatchCam")


def _look(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def setup(engine="CYCLES", samples=64, res=(1280, 720), ground=True, hdri=("4k",)):
    sc = bpy.context.scene
    if hdri:
        try:
            from f35 import scene as f35_scene
            f35_scene.use_hdri_size(*hdri)       # sharper background than the 2k in the blend
        except Exception:
            pass
    for ob in bpy.data.objects:
        if ob.name.startswith(HIDE_PREFIX):
            ob.hide_render = True
        if ob.name.startswith(("Ground", "Apron")):
            ob.hide_render = not ground
    if engine == "CYCLES":
        sc.render.engine = 'CYCLES'
        sc.cycles.device = 'GPU'
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
    elif engine == "EEVEE":
        sc.render.engine = 'BLENDER_EEVEE'
        sc.eevee.taa_render_samples = samples
    else:
        sc.render.engine = 'BLENDER_WORKBENCH'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'
    return sc


def _camera(name="ReviewCam"):
    cam = bpy.data.objects.get(name)
    if cam is None:
        cd = bpy.data.cameras.new(name)
        cam = bpy.data.objects.new(name, cd)
        bpy.context.scene.collection.objects.link(cam)
    cam.data.clip_start = 0.05
    cam.data.clip_end = 2000
    return cam


def shots(views, engine="CYCLES", samples=64, res=(1280, 720), prefix="", ground=True, out=OUT):
    os.makedirs(out, exist_ok=True)
    sc = setup(engine, samples, res, ground)
    cam = _camera()
    sc.camera = cam
    done = {}
    for v in views:
        loc, tgt, lens = VIEWS[v] if isinstance(v, str) else v[1]
        name = v if isinstance(v, str) else v[0]
        below = loc[2] < -1.7                 # looking up from under the apron
        for ob in bpy.data.objects:
            if ob.name.startswith(("Ground", "Apron")):
                ob.hide_render = below or not ground
        cam.location = loc
        cam.data.lens = lens
        cam.data.sensor_fit = 'AUTO'
        cam.data.sensor_width = 36.0
        _look(cam, tgt)
        t = time.time()
        sc.render.filepath = os.path.join(out, f"{prefix}{name}.png")
        bpy.ops.render.render(write_still=True)
        done[name] = (sc.render.filepath, round(time.time() - t, 1))
    return done


def match(name, engine="CYCLES", samples=96, scale=0.5, prefix="match_", out=OUT, transparent=False):
    """Render from a photo-matched camera stored in data/camera_matches/<name>.json."""
    m = json.load(open(os.path.join(REPO, "data", "camera_matches", name + ".json")))
    s = m["solve"]
    W, H = m["size"]
    sc = setup(engine, samples, (int(W * scale), int(H * scale)), ground=not transparent)
    sc.render.film_transparent = transparent
    if transparent:
        sc.render.image_settings.color_mode = 'RGBA'
    cam = _camera("MatchCam")
    cam.data.lens = s["lens"]
    cam.data.sensor_width = 36.0
    cam.data.sensor_fit = 'HORIZONTAL'
    cam.matrix_world = Matrix.Translation(Vector(s["cam"])) @ Matrix(s["rot"]).to_4x4()
    sc.camera = cam
    os.makedirs(out, exist_ok=True)
    sc.render.filepath = os.path.join(out, f"{prefix}{name}.png")
    t = time.time()
    bpy.ops.render.render(write_still=True)
    return sc.render.filepath, round(time.time() - t, 1)


def match_edges(name, scale=0.5, out=OUT):
    """Workbench render (studio light, cavity, object outlines, transparent
    background) from the matched camera.  Edge-detected and drawn over the
    photo afterwards (tools/overlay.py) to compare the shapes line by line."""
    sc = bpy.context.scene
    sh = sc.display.shading
    keep = (sh.light, sh.color_type, tuple(sh.single_color), sh.show_cavity, sh.show_object_outline)
    sh.light = 'STUDIO'
    sh.color_type = 'SINGLE'
    sh.single_color = (0.8, 0.8, 0.8)
    sh.show_cavity = True
    sh.cavity_type = 'BOTH'
    sh.show_object_outline = True
    sh.object_outline_color = (0.0, 0.0, 0.0)
    try:
        return match(name, engine="WORKBENCH", scale=scale, prefix="edges_", out=out, transparent=True)
    finally:
        sh.light, sh.color_type, sh.single_color, sh.show_cavity, sh.show_object_outline = keep


def project(name, points):
    """World points -> pixel coordinates in the photo of camera match <name>."""
    m = json.load(open(os.path.join(REPO, "data", "camera_matches", name + ".json")))
    s = m["solve"]
    W, H = m["size"]
    R = Matrix(s["rot"])
    c = Vector(s["cam"])
    out = []
    for p in points:
        q = R.transposed() @ (Vector(p) - c)
        out.append((W / 2 + s["f_px"] * q.x / -q.z, H / 2 - s["f_px"] * q.y / -q.z))
    return out


ORTHO = {
    # view: (camera rotation, axis along the view, image-right axis, image-up axis)
    "front": ((math.pi / 2, 0.0, 0.0), Vector((0, -40, 0)), 0, 2),
    "back":  ((math.pi / 2, 0.0, math.pi), Vector((0, 40, 0)), 0, 2),
    "side":  ((math.pi / 2, 0.0, math.pi / 2), Vector((40, 0, 0)), 1, 2),
    "top":   ((0.0, 0.0, 0.0), Vector((0, 0, 40)), 0, 1),
}


def ortho(view="front", ppm=200.0, res=(2400, 1100), center=(0.0, 0.3), prefix="ortho_",
          out=OUT, edges=True, gear_up=True):
    """Orthographic render at `ppm` pixels per metre, image centre at `center`
    (world coordinates along the image right / up axes).  Workbench with
    studio light, cavity and outlines on a transparent background (edges=True)
    to lay over a drawing; or Cycles otherwise.  A world point maps to pixel
    (W/2 + sx * ppm * (p[right] - center[0]), H/2 - ppm * (p[up] - center[1])),
    sx = -1 for the back view (its image right is -X), +1 otherwise (side: +Y,
    seen from the left; top: +X with the nose down the image)."""
    rot, off, ax_r, ax_u = ORTHO[view]
    sc = bpy.context.scene
    sh = sc.display.shading
    keep = (sh.light, sh.color_type, tuple(sh.single_color), sh.show_cavity, sh.show_object_outline)
    rig = bpy.data.objects.get("F35I_Rig")
    gear = rig.get("gear") if rig else None
    if gear_up and rig is not None:
        rig["gear"] = 0.0
        rig.update_tag()
        sc.frame_set(sc.frame_current)
    try:
        if edges:
            sh.light = 'STUDIO'
            sh.color_type = 'SINGLE'
            sh.single_color = (0.8, 0.8, 0.8)
            sh.show_cavity = True
            sh.cavity_type = 'BOTH'
            sh.show_object_outline = True
            sh.object_outline_color = (0.0, 0.0, 0.0)
            setup("WORKBENCH", 1, res, ground=False)
            sc.render.film_transparent = True
            sc.render.image_settings.color_mode = 'RGBA'
        else:
            setup("CYCLES", 64, res, ground=False)
        cam = _camera("OrthoCam")
        cam.data.type = 'ORTHO'
        cam.data.sensor_fit = 'HORIZONTAL'
        cam.data.ortho_scale = res[0] / ppm
        cam.rotation_euler = rot
        loc = Vector(off)
        loc[ax_r] = center[0]
        loc[ax_u] = center[1]
        cam.location = loc
        sc.camera = cam
        os.makedirs(out, exist_ok=True)
        sc.render.filepath = os.path.join(out, f"{prefix}{view}.png")
        bpy.ops.render.render(write_still=True)
        return sc.render.filepath
    finally:
        sh.light, sh.color_type, sh.single_color, sh.show_cavity, sh.show_object_outline = keep
        if gear_up and rig is not None and gear is not None:
            rig["gear"] = gear
            rig.update_tag()
            sc.frame_set(sc.frame_current)
