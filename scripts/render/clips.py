"""Animated clips of the rig (gear, canopy, pilot, controls, bays, turntable).

Each clip keys the F35I_Rig controls, renders a PNG sequence (kept in
renders/frames/<clip> for editing) and writes an MP4 (renders/animation) for
the making-of video, plus a GIF preview (renders/gifs) when Pillow is present.

Local GPU (recommended), from a Windows / Linux shell or from Blender itself:
    blender -b --factory-startup --python scripts/render/clips.py -- turntable
            --engine CYCLES --res 1280x720 --samples 48 --fps 24
Headless bpy module:
    python3 scripts/render/clips.py [clip ...] --engine EEVEE --res 640x360 --samples 12

Clips: afterburner, gear_retract, canopy_open, pilot_look, controls, weapon_bays, turntable
"""
import argparse
import math
import os
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
    camera((3.4, -1.2, 2.5), (0.0, -4.3, 0.95), 30)
    n = int(7.0 * fps)
    path("canopy", [(1, 0.0), (int(0.5 * fps), 0.0), (int(5.0 * fps), 1.0), (n, 1.0)])
    path("head_yaw", [(1, 0.0), (int(4.0 * fps), 0.0), (int(5.0 * fps), 55.0), (n, 55.0)])
    path("head_pitch", [(1, 0.0), (int(4.0 * fps), 0.0), (int(5.0 * fps), 10.0), (n, 10.0)])
    return n, "canopy opening"


def clip_pilot_look(fps):
    """Pilot head: left, right, up, down, tilt (degrees, + yaw = left); canopy open."""
    set_visibility()
    camera((2.7, -5.5, 1.45), (0.0, -3.9, 1.05), 36)
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


CLIPS = {
    "afterburner": clip_afterburner,
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
    if args.test:
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
    args = ap.parse_args(argv)
    args.res = tuple(int(v) for v in args.res.lower().split("x"))
    args.hdri = tuple(v for v in args.hdri.split(",") if v)
    args.gif_width = args.gif_width or None
    os.makedirs(os.path.join(ROOT, "renders", "gifs"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "renders", "animation"), exist_ok=True)
    for name in (args.clips or list(CLIPS)):
        render_clip(name, args)


if __name__ == "__main__":
    main()
