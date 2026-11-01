"""Animated clips of the rig (gear, canopy, pilot, controls, bays, turntable).

Each clip keys the F35I_Rig controls, renders a PNG sequence (kept in
renders/frames/<clip> for editing) and writes an MP4 (renders/animation) for
the making-of video, plus a GIF preview (renders/gifs) when Pillow is present.

Local GPU (recommended), from a Windows / Linux shell or from Blender itself:
    blender -b --factory-startup --python scripts/render/clips.py -- turntable
            --engine CYCLES --res 1280x720 --samples 48 --fps 24
Headless bpy module:
    python3 scripts/render/clips.py [clip ...] --engine EEVEE --res 640x360 --samples 12

Clips: afterburner, walkaround, startup, destruction, gear_retract, canopy_open, pilot_look,
       controls, weapon_bays, turntable
"""
import argparse
import math
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))

import bpy                              # noqa: E402
from mathutils import Vector            # noqa: E402


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def rig():
    return bpy.data.objects["F35I_Rig"]


def key(prop, value, frame, interp='BEZIER'):
    arm = rig()
    arm[prop] = float(value)
    arm.keyframe_insert(f'["{prop}"]', frame=frame)
    ad = arm.animation_data
    if ad and ad.action:
        from f35.anim import fcurves
        for fc in fcurves(ad.action):
            if fc.data_path == f'["{prop}"]':
                for kp in fc.keyframe_points:
                    if abs(kp.co.x - frame) < 1e-3:
                        kp.interpolation = interp


def path(prop, points):
    """points: [(frame, value), ...] eased keys."""
    for f, v in points:
        key(prop, v, f)


def clear_rig_animation():
    """Drop the rig's action but keep its drivers (they live in the same AnimData)."""
    arm = rig()
    if arm.animation_data:
        arm.animation_data.action = None


def look_at(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def camera(loc, target, lens):
    sc = bpy.context.scene
    cd = bpy.data.cameras.get("ClipCam") or bpy.data.cameras.new("ClipCam")
    cam = bpy.data.objects.get("ClipCam") or bpy.data.objects.new("ClipCam", cd)
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    if cam.animation_data:
        cam.animation_data_clear()
    cd.lens = lens
    cd.clip_start = 0.05
    cd.clip_end = 400
    cam.location = loc
    look_at(cam, target)
    sc.camera = cam
    return cam


def orbit_camera(frames, radius, height, target, lens, start_deg=-35.0):
    """Key a full orbit around `target` (one turn over `frames`)."""
    cam = camera((0, -radius, height), target, lens)
    for f in range(1, frames + 1):
        a = math.radians(start_deg + 360.0 * (f - 1) / frames)
        cam.location = (target[0] + radius * math.sin(a), target[1] - radius * math.cos(a), height)
        look_at(cam, target)
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
    from f35.anim import fcurves
    for fc in fcurves(cam.animation_data.action):
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
    return cam


def set_visibility(hide_ground=False):
    for ob in bpy.data.objects:
        n = ob.name
        if n.startswith(("HB_", "Hitbox", "Smoke", "Vapour", "Cut_", "CompareCam", "PrevCam")):
            ob.hide_render = True
        if n.startswith("Ground") or n.startswith("Apron"):
            ob.hide_render = hide_ground


def enable_gpu():
    """Use every OptiX / CUDA / HIP / Metal / oneAPI device Cycles can find."""
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except Exception:
        return None
    for kind in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
        except Exception:
            continue
        devs = [d for d in prefs.devices if d.type == kind]
        if devs:
            for d in prefs.devices:
                d.use = d.type == kind
            return kind
    return None


def setup_render(res, samples, fps, engine="EEVEE", hdri=("4k",)):
    sc = bpy.context.scene
    if hdri:
        try:
            from f35 import scene as f35_scene
            print("HDRI", f35_scene.use_hdri_size(*hdri), flush=True)
        except Exception as e:                      # no HDRI or an old blend: keep what is there
            print("HDRI unchanged:", e, flush=True)
    if engine.upper() == "CYCLES":
        sc.render.engine = 'CYCLES'
        kind = enable_gpu()
        sc.cycles.device = 'GPU' if kind else 'CPU'
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
        print("CYCLES device", kind or "CPU", flush=True)
    else:
        sc.render.engine = 'BLENDER_EEVEE'
        try:
            sc.eevee.taa_render_samples = samples
        except Exception:
            pass
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.fps = fps
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'


# --------------------------------------------------------------------------
# clip definitions: each returns (frame_count, description); frames at `fps`
# --------------------------------------------------------------------------
def clip_gear_retract(fps):
    """Gear up: doors open, legs fold into the wells, doors close (6 s)."""
    set_visibility(hide_ground=True)
    camera((11.0, -9.0, -6.0), (0.0, 0.8, -0.8), 40)
    n = int(8.5 * fps)
    t0, t1 = int(0.8 * fps), int(0.8 * fps) + 6 * fps
    path("gear", [(1, 1.0), (t0, 1.0), (t1, 0.0), (n, 0.0)])
    return n, "gear retraction"


def clip_canopy_open(fps):
    """Canopy opens on its front hinge while the pilot turns to look out."""
    set_visibility()
    camera((3.4, -1.75, 2.5), (0.0, -4.85, 0.95), 30)
    n = int(7.0 * fps)
    path("canopy", [(1, 0.0), (int(0.5 * fps), 0.0), (int(5.0 * fps), 1.0), (n, 1.0)])
    path("head_yaw", [(1, 0.0), (int(4.0 * fps), 0.0), (int(5.0 * fps), 55.0), (n, 55.0)])
    path("head_pitch", [(1, 0.0), (int(4.0 * fps), 0.0), (int(5.0 * fps), 10.0), (n, 10.0)])
    return n, "canopy opening"


def clip_pilot_look(fps):
    """Pilot head: left, right, up, down, tilt (degrees, + yaw = left); canopy open."""
    set_visibility()
    camera((2.7, -6.05, 1.45), (0.0, -4.45, 1.05), 36)
    key("canopy", 1.0, 1)
    s = fps
    seq = [(0.0, 0, 0, 0), (0.6, 0, 0, 0), (1.4, 75, 5, 0), (2.4, 75, 5, 0), (3.4, -75, 5, 0),
           (4.4, -75, 5, 0), (5.2, 0, 35, 0), (6.0, 0, 35, 0), (6.8, 0, -35, 0), (7.6, 0, -35, 0),
           (8.4, 20, 0, 25), (9.2, -20, 0, -25), (10.0, 0, 0, 0), (10.6, 0, 0, 0)]
    for t, yaw, pitch, tilt in seq:
        f = 1 + int(round(t * s))
        key("head_yaw", yaw, f)
        key("head_pitch", pitch, f)
        key("head_tilt", tilt, f)
    return 1 + int(round(10.6 * s)), "pilot head look"


def clip_controls(fps):
    """Stick roll / pitch, pedals, flaps and speed brake (rear quarter)."""
    set_visibility()
    camera((-10.5, 14.5, 4.8), (0.0, 2.8, 0.2), 46)
    s = fps
    def T(t):
        return 1 + int(round(t * s))
    path("stick_roll", [(T(0), 0), (T(0.5), 0), (T(1.3), 1), (T(2.1), -1), (T(2.9), 0)])
    path("stick_pitch", [(T(0), 0), (T(2.9), 0), (T(3.7), 1), (T(4.5), -1), (T(5.3), 0)])
    path("pedals", [(T(0), 0), (T(5.3), 0), (T(6.1), 1), (T(6.9), -1), (T(7.7), 0)])
    path("flaps", [(T(0), 0), (T(7.7), 0), (T(8.7), 1), (T(9.7), 1), (T(10.5), 0)])
    path("speedbrake", [(T(0), 0), (T(10.5), 0), (T(11.3), 1), (T(12.1), 1), (T(12.9), 0)])
    return T(13.4), "flight controls"


def clip_weapon_bays(fps):
    """Both weapon bays open (doors swing down), hold, close."""
    set_visibility()
    camera((-2.3, -2.4, -1.50), (0.3, 3.0, -0.95), 22)
    s = fps
    def T(t):
        return 1 + int(round(t * s))
    path("weapon_bays", [(T(0), 0), (T(0.6), 0), (T(2.6), 1), (T(4.2), 1), (T(6.2), 0), (T(6.8), 0)])
    return T(6.8), "weapon bays"


def clip_turntable(fps):
    """One slow orbit, gear down, canopy closed."""
    set_visibility()
    n = 6 * fps
    orbit_camera(n, 21.0, 4.2, (0.0, 0.6, -0.5), 48)
    return n, "turntable"


def clip_afterburner(fps):
    """Engine run-up from the rear quarter: idle, MIL, full afterburner (the nozzle opens, the
    flame lights with its shock diamonds and flickers), then back to idle. Slow push in."""
    set_visibility()
    cam = camera((-8.2, 20.0, 0.35), (0.0, 8.0, 0.0), 40)
    def T(t):
        return 1 + int(round(t * fps))
    n = T(11.0)
    for f, loc in ((1, (-8.2, 20.0, 0.35)), (n, (-6.6, 17.2, 0.55))):
        cam.location = loc
        look_at(cam, (0.0, 8.0, 0.0))
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
    path("throttle", [(T(0), 0.0), (T(0.8), 0.0), (T(2.6), 0.75), (T(3.6), 0.75), (T(4.4), 1.0),
                      (T(8.2), 1.0), (T(9.4), 0.75), (T(10.2), 0.0), (n, 0.0)])
    return n, "afterburner"


def clip_walkaround(fps):
    """A slow walk round the parked jet at eye height: nose, left side, tail, right side (40 s)."""
    set_visibility()
    n = int(40 * fps)
    cy, a, b, z = 0.8, 11.0, 14.0, -0.12
    cam = camera((0.0, cy - b, z), (0.0, -5.0, -0.4), 28)
    for f in range(1, n + 1):
        th = math.radians(25.0 + 360.0 * (f - 1) / n)
        x, y = a * math.sin(th), cy - b * math.cos(th)
        cam.location = (x, y, z)
        look_at(cam, (0.2 * x, 0.35 * (y - cy), -0.55))
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
    from f35.anim import fcurves
    for fc in fcurves(cam.animation_data.action):
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
    return n, "walk-around"


def clip_startup(fps):
    """Cockpit power-up over the pilot's shoulder: the pilot looks at each console and flips battery,
    power, display, fuel, engine start, lights and sensors (LEDs and display light up, the
    anti-collision and position lights come on), then closes the canopy."""
    from f35 import anim
    set_visibility()
    key("canopy", 1.0, 1)
    camera((-1.22, -4.32, 1.48), (0.08, -5.02, 0.68), 24)      # right of the cockpit, pilot in profile
    end = anim.start_up(frame=int(0.8 * fps))
    return end + int(2.5 * fps), "cockpit start-up"


def _burst_material():
    """Volume ball for a hit: a brief orange fireball (object property 'fire') that turns into a
    billowing dark smoke puff ('smoke'); 'w' drifts the 4D noise so the puff boils."""
    mat = bpy.data.materials.get("FX_Burst")
    if mat:
        return mat
    mat = bpy.data.materials.new("FX_Burst")
    mat.use_nodes = True
    nt = mat.node_tree
    N, L = nt.nodes, nt.links
    for nd in list(N):
        N.remove(nd)
    out = N.new("ShaderNodeOutputMaterial")
    vol = N.new("ShaderNodeVolumePrincipled")
    vol.inputs["Color"].default_value = (0.05, 0.047, 0.045, 1)
    vol.inputs["Anisotropy"].default_value = 0.25
    vol.inputs["Emission Color"].default_value = (1.0, 0.40, 0.09, 1)

    def attr(name):
        a = N.new("ShaderNodeAttribute")
        a.attribute_type = 'OBJECT'
        a.attribute_name = name
        return a.outputs["Fac"]

    def op(kind, x, y=None):
        m = N.new("ShaderNodeMath")
        m.operation = kind
        for i, v in enumerate((x, y)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                m.inputs[i].default_value = v
            else:
                L.new(v, m.inputs[i])
        return m.outputs[0]

    def ramp(x, lo, hi):                       # clamp((x - lo) / (hi - lo))
        return op('MINIMUM', op('MAXIMUM', op('DIVIDE', op('SUBTRACT', x, lo), hi - lo), 0.0), 1.0)
    tc = N.new("ShaderNodeTexCoord")
    noise = N.new("ShaderNodeTexNoise")
    noise.noise_dimensions = '4D'
    noise.inputs["Scale"].default_value = 1.5
    noise.inputs["Detail"].default_value = 5.0
    noise.inputs["Roughness"].default_value = 0.62
    L.new(tc.outputs["Object"], noise.inputs["Vector"])
    L.new(attr("w"), noise.inputs["W"])
    vl = N.new("ShaderNodeVectorMath")
    vl.operation = 'LENGTH'
    L.new(tc.outputs["Object"], vl.inputs[0])
    inner = op('SUBTRACT', 1.0, vl.outputs["Value"])          # 1 at the centre, 0 at the shell
    nz = noise.outputs["Fac"]
    puff = op('MULTIPLY', ramp(inner, 0.0, 0.35), ramp(nz, 0.40, 0.62))
    core = op('MULTIPLY', ramp(inner, 0.15, 0.6), ramp(nz, 0.44, 0.60))
    L.new(op('MULTIPLY', op('MULTIPLY', puff, attr("smoke")), 2.4), vol.inputs["Density"])
    L.new(op('MULTIPLY', op('MULTIPLY', core, attr("fire")), 14.0), vol.inputs["Emission Strength"])
    L.new(vol.outputs["Volume"], out.inputs["Volume"])
    for k, v in (("homogeneous_volume", False), ("volume_step_rate", 0.5)):
        if hasattr(mat.cycles, k):
            setattr(mat.cycles, k, v)
    return mat


def _linear_keys(idb):
    from f35.anim import fcurves
    ad = idb.animation_data
    for fc in (fcurves(ad.action) if ad and ad.action else []):
        for kp in fc.keyframe_points:
            kp.interpolation = 'CONSTANT' if fc.data_path.startswith("hide_") else 'LINEAR'


def burst(loc, frame, fps, size=1.0, tag="Burst"):
    """Fireball + flash + rising smoke puff at `loc`, starting at `frame`."""
    import bmesh
    sc = bpy.context.scene
    k = len([o for o in bpy.data.objects if o.name.startswith(tag + "_") and o.type == 'MESH'])
    me = bpy.data.meshes.new(f"{tag}_{k}")
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(_burst_material())
    ob = bpy.data.objects.new(f"{tag}_{k}", me)
    sc.collection.objects.link(ob)
    ob.visible_shadow = False
    loc = Vector(loc)

    def s(t):
        return frame + int(round(t * fps))
    # hidden outside its life: Cycles aborts on a mesh volume scaled to (almost) nothing
    for f, hide in ((frame - 1, True), (frame, False), (s(5.5) + 1, True)):
        ob.hide_render = hide
        ob.keyframe_insert("hide_render", frame=f)
    #        time  scale  rise  fire  smoke
    for t, sc_, dz, fire, smoke in ((0.0, 0.30, 0.0, 1.0, 0.10),
                                    (0.15, 0.90, 0.10, 0.70, 0.80), (0.45, 1.15, 0.35, 0.0, 0.90),
                                    (3.0, 2.2, 2.4, 0.0, 0.50), (5.5, 2.8, 4.2, 0.0, 0.0)):
        f = s(t)
        ob.scale = (sc_ * size,) * 3
        ob.location = loc + Vector((0, 0, dz * size))
        ob["fire"], ob["smoke"] = fire, smoke
        for path in ("scale", "location", '["fire"]', '["smoke"]'):
            ob.keyframe_insert(path, frame=f)
    ob["w"] = 0.0
    ob.keyframe_insert('["w"]', frame=frame)
    ob["w"] = 2.2
    ob.keyframe_insert('["w"]', frame=s(5.5))
    _linear_keys(ob)
    # a short flash lights the skin and the apron
    ld = bpy.data.lights.new(f"{tag}_Flash_{k}", 'POINT')
    ld.color = (1.0, 0.55, 0.2)
    ld.shadow_soft_size = 0.5
    lo = bpy.data.objects.new(ld.name, ld)
    sc.collection.objects.link(lo)
    lo.location = loc + Vector((0, 0, 0.3))
    for f, e in ((frame - 1, 0.0), (frame, 700.0 * size), (s(0.15), 350.0 * size), (s(0.45), 0.0)):
        ld.energy = e
        ld.keyframe_insert("energy", frame=f)
    _linear_keys(ld)
    return ob


def bake_debris(comp, f_break, f_end, settle=5):
    """The debris of a broken-off part flies in the aircraft frame (drivers). Bake its world path
    from the break to `f_end` and let it come to rest lying flat on the apron, so it stays put
    when the jet itself moves later (e.g. settles on a collapsed gear leg)."""
    from mathutils import Matrix
    from f35.geom import GROUND_Z
    sc = bpy.context.scene
    emp = bpy.data.objects[f"Debris_{comp}"]
    sc.frame_set(f_break + 1)
    inv = emp.matrix_world.inverted()
    zmin = min((inv @ k.matrix_world @ v.co).z for k in emp.children if k.type == 'MESH'
               for v in k.data.vertices)
    path = []
    for f in range(f_break, f_end + 1):
        sc.frame_set(f)
        path.append(emp.matrix_world.copy())
    zs = [m.translation.z for m in path]
    land = next((i for i, z in enumerate(zs) if z <= min(zs) + 1e-4), len(path) - 1)
    m_land = path[land]
    xa = m_land.col[0].xyz
    yaw = math.atan2(xa.y, xa.x)
    rest = Matrix.Translation((m_land.translation.x, m_land.translation.y, GROUND_Z + 0.004 - zmin)) \
        @ Matrix.Rotation(yaw, 4, 'Z')
    for path_name in ("delta_location", "delta_rotation_euler"):
        emp.driver_remove(path_name)
    emp.delta_location = (0, 0, 0)
    emp.delta_rotation_euler = (0, 0, 0)
    emp.parent = None
    emp.rotation_mode = 'QUATERNION'

    def put(m, f):
        emp.matrix_world = m
        emp.keyframe_insert("location", frame=f)
        emp.keyframe_insert("rotation_quaternion", frame=f)
    put(path[0], f_break - 1)
    for i, m in enumerate(path[:land + 1]):
        put(m, f_break + i)
    l0, q0 = m_land.translation, m_land.to_quaternion()
    l1, q1 = rest.translation, rest.to_quaternion()
    for j in range(1, settle + 1):
        t = j / settle
        t = t * t * (3 - 2 * t)
        m = Matrix.Translation(l0.lerp(l1, t)) @ q0.slerp(q1, t).to_matrix().to_4x4()
        put(m, f_break + land + j)
    # keep the pieces on the apron for the rest of the clip (they normally vanish after a while),
    # and only scorch them lightly (a destroyed part is fully sooted by default)
    for k in emp.children:
        ad = k.animation_data
        for fc in (ad.drivers if ad else []):
            if fc.data_path == "delta_scale" and "frame < bf +" in fc.driver.expression:
                fc.driver.expression = re.sub(r"\*\(frame < bf \+ \d+\)", "", fc.driver.expression)
            elif fc.data_path == '["damage"]' or fc.data_path.startswith('["dmg_'):
                fc.driver.expression = f"0.4*({fc.driver.expression})"
    return {"landed_frame": f_break + land, "rest": tuple(round(v, 2) for v in rest.translation)}


def clip_destruction(fps):
    """Damage on the apron: a hit on the left wing tears the outer panel off (it tumbles onto the
    apron, the stub's edge glows); a second hit folds the left main gear and the jet settles."""
    from f35 import destruct
    set_visibility()
    arm = rig()
    arm["debris_ground"] = 1.0
    cam = camera((11.5, -9.5, 3.4), (1.6, -0.5, -0.7), 28)

    def T(t):
        return 1 + int(round(t * fps))
    cam.keyframe_insert("location", frame=1)
    cam.location = (10.4, -8.2, 3.0)
    cam.keyframe_insert("location", frame=T(10.0))
    log = lambda *a: print("DESTRUCTION", *a, flush=True)
    h1 = destruct.impact((7.0, 1.6, 0.6), (-1.0, 0.05, -0.12), hp=150, frame=T(1.0))
    log("hit 1", h1 and h1["components"])
    destruct.break_off("wing_outer_L", T(1.2))
    if h1:
        burst(h1["point_world"], T(1.0), fps, size=0.9)
    destruct.impact((4.5, 1.9, -0.8), (-1.0, 0.0, 0.1), hp=120, frame=T(4.6))
    log("hit 2")
    wheel = bpy.data.objects.get("MG_Wheel_L_Tyre")
    if wheel:
        bb = [wheel.matrix_world @ Vector(c) for c in wheel.bound_box]
        c = sum(bb, Vector()) / 8
        burst((c.x + 0.2, c.y, c.z + 0.45), T(4.6), fps, size=0.8)
    log("bursts")
    log("debris", bake_debris("wing_outer_L", T(1.2), T(4.7)))
    destruct.collapse_gear("main_gear_L", T(4.8), duration=int(0.5 * fps))
    log("gear")
    bpy.context.scene.frame_set(1)
    log("ready")
    return T(10.0), "destruction"


CLIPS = {
    "afterburner": clip_afterburner,
    "walkaround": clip_walkaround,
    "startup": clip_startup,
    "destruction": clip_destruction,
    "gear_retract": clip_gear_retract,
    "canopy_open": clip_canopy_open,
    "pilot_look": clip_pilot_look,
    "controls": clip_controls,
    "weapon_bays": clip_weapon_bays,
    "turntable": clip_turntable,
}


# --------------------------------------------------------------------------
def write_gif(frames_dir, n, gif_path, fps, width=None):
    try:
        from PIL import Image
    except ImportError:                   # Blender's own Python has no Pillow
        return None
    imgs = []
    for f in range(1, n + 1):
        p = os.path.join(frames_dir, f"{f:04d}.png")
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert("RGB")
        if width and im.width != width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        imgs.append(im)
    pal = imgs[len(imgs) // 2].quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    q = [im.quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG) for im in imgs]
    q[0].save(gif_path, save_all=True, append_images=q[1:], duration=int(1000 / fps), loop=0,
              optimize=True)
    return gif_path


def encode_mp4_blender(frames_dir, n, mp4_path, fps):
    """Encode the PNG sequence with Blender's own FFmpeg (sequencer)."""
    first = os.path.join(frames_dir, "0001.png")
    img = bpy.data.images.load(first)
    w, h = img.size
    bpy.data.images.remove(img)
    sc = bpy.data.scenes.new("Encode")
    sc.render.resolution_x, sc.render.resolution_y = w + (w % 2), h + (h % 2)
    sc.render.resolution_percentage = 100
    sc.render.fps = fps
    sc.frame_start, sc.frame_end = 1, n
    sc.view_settings.view_transform = 'Standard'
    se = sc.sequence_editor_create()
    strips = getattr(se, "strips", None) or se.sequences
    st = strips.new_image("frames", first, 1, 1)
    for f in range(2, n + 1):
        st.elements.append(f"{f:04d}.png")
    r = sc.render
    r.use_sequencer = True
    r.image_settings.file_format = 'FFMPEG'
    r.ffmpeg.format = 'MPEG4'
    r.ffmpeg.codec = 'H264'
    r.ffmpeg.constant_rate_factor = 'HIGH'
    r.ffmpeg.ffmpeg_preset = 'GOOD'
    r.filepath = mp4_path
    bpy.ops.render.render(animation=True, scene=sc.name)
    bpy.data.scenes.remove(sc)
    return mp4_path


def write_mp4(frames_dir, mp4_path, fps, n=None):
    ff = shutil.which("ffmpeg")
    if not ff:
        return encode_mp4_blender(frames_dir, n, mp4_path, fps)
    cmd = [ff, "-y", "-loglevel", "error", "-framerate", str(fps), "-i",
           os.path.join(frames_dir, "%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
           "-crf", "20", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", mp4_path]
    subprocess.run(cmd, check=True)
    return mp4_path


def render_clip(name, args):
    bpy.ops.wm.open_mainfile(filepath=args.blend)
    clear_rig_animation()
    setup_render(args.res, args.samples, args.fps, args.engine, args.hdri)
    n, desc = CLIPS[name](args.fps)
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, n
    frames_dir = os.path.join(args.work, name + args.suffix)
    os.makedirs(frames_dir, exist_ok=True)
    todo = range(1, n + 1)
    if args.frames:
        args.test = True
        todo = sorted({int(v) for v in args.frames.split(",") if 1 <= int(v) <= n})
    elif args.test:
        todo = sorted({1, n // 3, n // 2, (2 * n) // 3, n})
    for f in todo:
        out = os.path.join(frames_dir, f"{f:04d}.png")
        if os.path.exists(out) and not args.force:
            continue
        sc.frame_set(f)
        sc.render.filepath = out
        t = time.time()
        bpy.ops.render.render(write_still=True)
        print(f"FRAME {name} {f}/{n} {time.time() - t:.1f}s", flush=True)
    if args.test:
        print("TEST", name, n, "frames, rendered", list(todo), "->", frames_dir, flush=True)
        return
    gif = write_gif(frames_dir, n, os.path.join(ROOT, "renders", "gifs", f"{name}{args.suffix}.gif"), args.fps,
                    width=args.gif_width)
    mp4 = write_mp4(frames_dir, os.path.join(ROOT, "renders", "animation", f"{name}{args.suffix}.mp4"),
                    args.fps, n)
    print("CLIP", name, desc, n, "frames ->", gif, mp4, flush=True)


def main():
    import faulthandler                 # a hard crash in a background render still leaves a trace
    faulthandler.enable(all_threads=False)
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="*")
    ap.add_argument("--engine", default="CYCLES", choices=["CYCLES", "EEVEE"])
    ap.add_argument("--res", default="1280x720")
    ap.add_argument("--samples", type=int, default=48)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--gif-width", type=int, default=480)
    ap.add_argument("--suffix", default="", help="appended to the output names, e.g. _v2")
    ap.add_argument("--blend", default=os.path.join(ROOT, "blend", "F-35I_Adir.blend"))
    ap.add_argument("--work", default=os.path.join(ROOT, "renders", "frames"))
    ap.add_argument("--hdri", default="4k", help="HDRI sizes to try for the background, e.g. 8k,4k ('' keeps 2k)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--test", action="store_true", help="render 5 sample frames only")
    ap.add_argument("--frames", default="", help="render only these frames, e.g. 25,30,60 (no video)")
    args = ap.parse_args(argv)
    args.res = tuple(int(v) for v in args.res.lower().split("x"))
    args.hdri = tuple(v for v in args.hdri.split(",") if v)
    args.gif_width = args.gif_width or None
    print("CLIPARGS", {k: v for k, v in vars(args).items() if k not in ("blend", "work")}, flush=True)
    os.makedirs(os.path.join(ROOT, "renders", "gifs"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "renders", "animation"), exist_ok=True)
    for name in (args.clips or list(CLIPS)):
        render_clip(name, args)


if __name__ == "__main__":
    main()
