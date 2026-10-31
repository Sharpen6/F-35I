"""Quick Workbench previews from several angles (fast review renders).

usage: python3 scripts/preview.py <blend|build|parts,list> <out_dir> [views...]
"""
import os
import sys
import math
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

CAMS = {
    # name: (location, target, lens)
    "fr34":   ((-9.0, -14.0, 4.0), (0.0, -0.5, 0.0), 50),
    "fl34":   ((9.0, -14.0, 4.0), (0.0, -0.5, 0.0), 50),
    "rr34":   ((-9.0, 14.0, 4.5), (0.0, 1.0, 0.3), 50),
    "front":  ((0.0, -22.0, 0.6), (0.0, 0.0, 0.2), 60),
    "inlet":  ((-4.5, -9.5, 0.6), (-1.0, -3.2, 0.1), 50),
    "top":    ((0.0, 0.0, 30.0), (0.0, 0.0, 0.0), 50),
    "bottom": ((-6.0, -6.0, -9.0), (0.0, 0.0, -0.4), 40),
    "side":   ((24.0, 0.0, 0.5), (0.0, 0.0, 0.5), 50),
    "cockpit": ((-1.6, -6.4, 2.2), (0.0, -4.0, 0.6), 35),
    "cockpit_in": ((0.0, -4.05, 1.12), (0.0, -5.0, 0.62), 22),
    "cockpit_top": ((0.9, -3.2, 2.6), (0.0, -4.0, 0.5), 30),
    "pilot_side": ((3.2, -3.9, 0.9), (0.0, -3.9, 0.75), 35),
    "pilot_front": ((0.0, -5.6, 1.45), (0.0, -3.9, 0.85), 40),
    "tail":   ((-6.0, 12.0, 2.5), (0.0, 5.5, 0.6), 50),
    "gear":   ((-6.0, -3.0, -1.0), (0.0, 0.5, -1.0), 30),
    "gearside": ((-11.0, 1.5, -0.9), (0.0, 1.5, -0.9), 35),
    "noseL":  ((7.0, -7.0, 0.8), (0.0, -4.6, 0.1), 35),
    "finL":   ((9.0, 8.0, 3.5), (1.6, 5.4, 1.6), 40),
    "topL":   ((6.0, 4.0, 14.0), (2.0, 2.0, 0.0), 40),
    "gearfront": ((0.0, -14.0, -1.0), (0.0, 0.0, -0.9), 45),
    "belly":  ((0.0, 1.0, -14.0), (0.0, 1.0, 0.0), 50),
    "mainwell": ((-5.5, -2.5, -2.4), (-1.6, 2.0, -0.6), 35),
    "nosewell": ((-3.2, -7.5, -2.0), (0.0, -3.6, -0.7), 35),
    "inletF": ((-1.2, -14.0, 0.1), (-1.2, -3.0, 0.1), 120),
    "inletS": ((-12.0, -3.2, 0.1), (0.0, -3.2, 0.1), 80),
    "inletT": ((-1.2, -3.2, 12.0), (-1.2, -3.2, 0.0), 80),
    "inletB": ((-3.5, -6.5, -3.5), (-1.0, -3.0, -0.3), 45),
}


def look_at(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def render(out_dir, views, res=(1280, 720), engine='WORKBENCH', samples=32):
    sc = bpy.context.scene
    if engine == 'WORKBENCH':
        sc.render.engine = 'BLENDER_WORKBENCH'
        sh = sc.display.shading
        sh.light = 'STUDIO'
        sh.color_type = 'MATERIAL'
        sh.show_cavity = True
        sh.cavity_type = 'BOTH'
        sh.show_shadows = False
        sh.show_specular_highlight = True
        sc.display.render_aa = '8'
    elif engine == 'EEVEE':
        sc.render.engine = 'BLENDER_EEVEE'
        try:
            sc.eevee.taa_render_samples = samples
        except Exception:
            pass
    else:
        sc.render.engine = 'CYCLES'
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
        sc.cycles.device = 'CPU'
    sc.render.film_transparent = False
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'
    cd = bpy.data.cameras.new("PrevCam")
    cam = bpy.data.objects.new("PrevCam", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    out = []
    for v in views:
        loc, tgt, lens = CAMS[v]
        cam.location = loc
        cd.lens = lens
        cd.clip_end = 200
        look_at(cam, tgt)
        sc.render.filepath = os.path.join(out_dir, f"prev_{v}.png")
        bpy.ops.render.render(write_still=True)
        out.append(sc.render.filepath)
    bpy.data.objects.remove(cam)
    return out


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    src, out_dir = argv[0], argv[1]
    views = argv[2:] or ["fr34", "rr34", "inlet", "bottom"]
    os.makedirs(out_dir, exist_ok=True)
    if src.endswith('.blend'):
        bpy.ops.wm.open_mainfile(filepath=src)
    else:
        import build_f35i
        build_f35i.build(parts=src.split(',') if src != 'build' else None)
    eng = os.environ.get("PREVIEW_ENGINE", "WORKBENCH")
    pose = os.environ.get("PREVIEW_POSE", "")
    rig = bpy.data.objects.get("F35I_Rig")
    if pose and rig is not None:
        for kv in pose.split(","):
            k, v = kv.split("=")
            rig[k] = float(v)
        rig.hide_render = True
        bpy.context.view_layer.update()
    for pre in [p for p in os.environ.get("PREVIEW_HIDE", "").split(",") if p]:
        for ob in bpy.data.objects:
            if ob.name.startswith(pre):
                ob.hide_render = True
    for p in render(out_dir, views, engine=eng, samples=int(os.environ.get("PREVIEW_SAMPLES", "32"))):
        print("PREVIEW", p)
