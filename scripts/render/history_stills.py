"""Render every milestone blend in blend/history from the same cameras, so the making-of video
can show the model's evolution step by step.  Background Blender, from the repository root:

    blender -b --factory-startup --python scripts/render/history_stills.py -- --views fl34,side,rr34

Output: renders/history/<NN>_<view>.png (files already there are kept unless --force).
The sky image of the newer blends is linked relative to blend/, so copies in blend/history look
for it in the wrong place; it is pointed back at references/hdri before rendering.
"""
import argparse
import glob
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import bpy                  # noqa: E402
import clips                # noqa: E402
import review               # noqa: E402


def fix_sky():
    """Re-link file images that are missing (the HDRI) to references/hdri/<same file name>."""
    fixed = []
    for img in bpy.data.images:
        if img.source != 'FILE' or not img.filepath:
            continue
        p = bpy.path.abspath(img.filepath)
        if os.path.exists(p):
            continue
        q = os.path.join(ROOT, "references", "hdri", os.path.basename(p))
        if os.path.exists(q):
            img.filepath = q
            img.reload()
            fixed.append(os.path.basename(q))
    return fixed


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--views", default="fl34,side,rr34")
    ap.add_argument("--res", default="1280x720")
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--only", default="", help="comma list of history numbers, e.g. 01,07,14")
    ap.add_argument("--out", default=os.path.join(ROOT, "renders", "history"))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    views = [v for v in args.views.split(",") if v]
    res = tuple(int(v) for v in args.res.lower().split("x"))
    only = {v for v in args.only.split(",") if v}
    os.makedirs(args.out, exist_ok=True)
    for f in sorted(glob.glob(os.path.join(ROOT, "blend", "history", "*.blend"))):
        nn = os.path.basename(f)[:2]
        if only and nn not in only:
            continue
        todo = [v for v in views
                if args.force or not os.path.exists(os.path.join(args.out, f"{nn}_{v}.png"))]
        if not todo:
            continue
        bpy.ops.wm.open_mainfile(filepath=f)
        print("HIST open", os.path.basename(f), "sky fixed:", fix_sky(), flush=True)
        clips.setup_render(res, args.samples, 24, "CYCLES", ("4k",))
        sc = bpy.context.scene
        for ob in bpy.data.objects:
            if ob.name.startswith(review.HIDE_PREFIX):
                ob.hide_render = True
        cam = review._camera("HistCam")
        sc.camera = cam
        for v in todo:
            loc, tgt, lens = review.VIEWS[v]
            cam.location = loc
            cam.data.lens = lens
            review._look(cam, tgt)
            sc.render.filepath = os.path.join(args.out, f"{nn}_{v}.png")
            t = time.time()
            bpy.ops.render.render(write_still=True)
            print("HIST", nn, v, f"{time.time() - t:.1f}s", flush=True)
    print("HIST done", flush=True)


if __name__ == "__main__":
    main()
