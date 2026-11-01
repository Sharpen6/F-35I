"""Review shots of the current model in a background Blender, so they do not hold the
interactive session (or its MCP call) while another render is using the GPU.

    blender -b --factory-startup --python scripts/render/shots_bg.py -- \
        --views canopy_c34,stencil_l,stencil_r --prefix s35_ --res 1920x1080 --samples 128

Views are the names in review.VIEWS; --matches renders the photo-matched cameras in
data/camera_matches (review.match). Output: renders/review/<prefix><view>.png and
renders/review/<prefix>match_<name>.png.
"""
import argparse
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
from history_stills import fix_sky   # noqa: E402


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--views", default="")
    ap.add_argument("--matches", default="", help="comma list of data/camera_matches names, e.g. c20,c29")
    ap.add_argument("--match-scale", type=float, default=0.5)
    ap.add_argument("--prefix", default="bg_")
    ap.add_argument("--res", default="1920x1080")
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--blend", default=os.path.join(ROOT, "blend", "F-35I_Adir.blend"))
    args = ap.parse_args(argv)
    res = tuple(int(v) for v in args.res.lower().split("x"))
    bpy.ops.wm.open_mainfile(filepath=args.blend)
    print("SHOT open", os.path.basename(args.blend), "sky fixed:", fix_sky(), flush=True)
    clips.setup_render(res, args.samples, 24, "CYCLES", ("4k",))
    sc = bpy.context.scene
    for ob in bpy.data.objects:
        if ob.name.startswith(review.HIDE_PREFIX):
            ob.hide_render = True
    cam = review._camera("ShotCam")
    sc.camera = cam
    os.makedirs(review.OUT, exist_ok=True)
    for v in [v for v in args.views.split(",") if v]:
        loc, tgt, lens = review.VIEWS[v]
        cam.location = loc
        cam.data.lens = lens
        cam.data.sensor_fit = 'AUTO'
        cam.data.sensor_width = 36.0
        review._look(cam, tgt)
        sc.render.filepath = os.path.join(review.OUT, f"{args.prefix}{v}.png")
        t = time.time()
        bpy.ops.render.render(write_still=True)
        print("SHOT", v, f"{time.time() - t:.1f}s", sc.render.filepath, flush=True)
    for m in [m for m in args.matches.split(",") if m]:
        t = time.time()
        path, _ = review.match(m, engine="CYCLES", samples=args.samples, scale=args.match_scale,
                               prefix=f"{args.prefix}match_")
        print("SHOT match", m, f"{time.time() - t:.1f}s", path, flush=True)
    print("SHOT done", flush=True)


if __name__ == "__main__":
    main()
