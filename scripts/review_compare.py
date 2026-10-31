"""Render orthographic silhouettes of the model registered to the public
3-view drawing and composite them for visual / numeric comparison.

usage (headless):
    python3 scripts/review_compare.py <blend-or-'build'> <reference.png> <out_dir>
"""
import os
import sys
import math

import bpy
from mathutils import Euler

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SC = 708 / 15.67           # px per metre in the 3-view drawing
W, H = 1115, 786
Y0 = 15.67 / 2

VIEWS = {
    # name: (rotation, location, crop box)
    "top":   ((0, 0, math.pi), (5.909, 0.598, 30.0), (570, 0, 1095, 735)),
    "side":  ((math.pi / 2, 0, math.pi / 2), (30.0, 4.350, -1.848), (0, 180, 730, 370)),
    "front": ((math.pi / 2, 0, 0), (6.563, -30.0, -5.722), (0, 0, 520, 195)),
}


def setup_render(scene):
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'FLAT'
    scene.display.shading.color_type = 'SINGLE'
    scene.display.shading.single_color = (1, 1, 1)
    scene.render.film_transparent = True
    scene.render.resolution_x = W
    scene.render.resolution_y = H
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'


def render_views(out_dir, exclude=()):
    scene = bpy.context.scene
    setup_render(scene)
    hidden = []
    for ob in scene.objects:
        if any(ob.name.startswith(p) for p in exclude) and not ob.hide_render:
            ob.hide_render = True
            hidden.append(ob)
    cam_data = bpy.data.cameras.new("CompareCam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = W / SC
    cam_data.clip_end = 100
    cam = bpy.data.objects.new("CompareCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    paths = {}
    for name, (rot, loc, _) in VIEWS.items():
        cam.rotation_euler = Euler(rot)
        cam.location = loc
        scene.render.filepath = os.path.join(out_dir, f"sil_{name}.png")
        bpy.ops.render.render(write_still=True)
        paths[name] = scene.render.filepath
    bpy.data.objects.remove(cam)
    for ob in hidden:
        ob.hide_render = False
    return paths


def composite(ref_path, sil_paths, out_dir):
    import numpy as np
    from PIL import Image
    ref = Image.open(ref_path).convert('RGB')
    refa = np.asarray(ref).astype(np.float32)
    ref_mask = refa.sum(axis=2) < 3 * 238
    report = {}
    tiles = []
    for name, (_, _, box) in VIEWS.items():
        sil = np.asarray(Image.open(sil_paths[name]))[:, :, 3] > 127
        x0, y0, x1, y1 = box
        rm = ref_mask[y0:y1, x0:x1]
        sm = sil[y0:y1, x0:x1]
        inter = (rm & sm).sum()
        union = (rm | sm).sum()
        report[name] = dict(iou=float(inter / max(1, union)),
                            ref_only=int((rm & ~sm).sum()),
                            model_only=int((sm & ~rm).sum()))
        g = refa[y0:y1, x0:x1].mean(axis=2, keepdims=True).repeat(3, axis=2)
        img = g * 0.55 + 255 * 0.45
        # model-only = red, reference-only = blue, overlap = grey-green
        img[sm & ~rm] = [235, 60, 50]
        img[rm & ~sm] = [40, 90, 230]
        img[sm & rm] = img[sm & rm] * 0.6 + np.array([60, 160, 70]) * 0.4
        # model outline
        edge = sm ^ np.roll(sm, 1, axis=0) | sm ^ np.roll(sm, 1, axis=1)
        img[edge] = [0, 0, 0]
        tiles.append(Image.fromarray(img.clip(0, 255).astype('uint8')))
    # stack
    wmax = max(t.width for t in tiles)
    htot = sum(t.height for t in tiles)
    canvas = Image.new('RGB', (wmax, htot), (255, 255, 255))
    y = 0
    for t in tiles:
        canvas.paste(t, (0, y))
        y += t.height
    canvas = canvas.resize((wmax * 2, htot * 2), Image.LANCZOS)
    out = os.path.join(out_dir, "compare_3view.png")
    canvas.save(out)
    return out, report


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    src, ref, out_dir = argv[0], argv[1], argv[2]
    os.makedirs(out_dir, exist_ok=True)
    if src.endswith('.blend'):
        bpy.ops.wm.open_mainfile(filepath=src)
    else:
        import build_f35i
        build_f35i.build(parts=src.split(',') if src != 'build' else None)
    paths = render_views(out_dir, exclude=("Ground", "Pilot", "Hitbox", "HB_"))
    out, rep = composite(ref, paths, out_dir)
    print("COMPARE", out)
    for k, v in rep.items():
        print("IOU", k, v)
