"""Background job: build the detailed standing pilot in the studio scene, save
blend/F-35I_Pilot.blend and render studio views to renders/pilot/.

    blender -b --factory-startup --python scripts/pilot/run_studio.py -- \
        --views front34,side,back34,head34 --samples 64 --scale 1.0 [--prefix v2_] [--no-save]
    # renders from the saved studio (no rebuild) and a 120-frame turntable:
    blender -b --factory-startup --python scripts/pilot/run_studio.py -- \
        --open blend/F-35I_Pilot.blend --views "" --turntable 120 --samples 48

From a running Blender (e.g. the MCP) start it with pilot.run_studio.launch(...), which returns
at once; progress lines start with PILOT in the log under renders/frames/.
"""
import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
REPO = os.path.dirname(SCRIPTS)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


def log(*a):
    print("PILOT", *a, flush=True)


def enable_gpu():
    import bpy
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


def main(argv):
    import bpy
    ap = argparse.ArgumentParser()
    ap.add_argument("--views", default="front34,side,back34,head34")
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--prefix", default="")
    ap.add_argument("--no-save", action="store_true")
    ap.add_argument("--h", type=float, default=0.004)
    ap.add_argument("--ratio", type=float, default=1.0)
    ap.add_argument("--open", default="", help="render from this saved studio blend instead of building")
    ap.add_argument("--turntable", type=int, default=0, help="frames of a turntable (0 = none)")
    ap.add_argument("--first", type=int, default=1, help="first turntable frame (resume)")
    a = ap.parse_args(argv)
    t0 = time.time()
    from pilot import build_pilot, studio
    if a.open:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(a.open))
        log("opened", a.open)
    log("gpu", enable_gpu())
    if not a.open:
        # the factory scene's cube, light and camera are not wanted
        for ob in list(bpy.data.objects):
            bpy.data.objects.remove(ob)
        studio.adopt(bpy.context.scene)
        res = build_pilot.standing(h=a.h, ratio=a.ratio)
        log("built", res, round(time.time() - t0, 1))
        if not a.no_save:
            path = build_pilot.save_blend()
            log("saved", path, round(time.time() - t0, 1))
    views = [v for v in a.views.split(",") if v]
    sc, _coll = studio.scene()
    sc.cycles.device = 'GPU'
    for v in views:
        t = time.time()
        out = studio.render([v], samples=a.samples, prefix=a.prefix, scale=a.scale)
        log("render", v, out.get(v), round(time.time() - t, 1))
    if a.turntable:
        t = time.time()
        d = studio.turntable(frames=a.turntable, samples=a.samples, first=a.first,
                             out_dir=os.path.join(REPO, "renders", "frames", "pilot_turntable" + ("_" + a.prefix.rstrip("_") if a.prefix else "")))
        log("turntable", d, a.turntable, round(time.time() - t, 1))
    log("done", round(time.time() - t0, 1))


def launch(views="front34,side,back34,head34", samples=64, scale=1.0, prefix="", save=True, h=0.004, ratio=1.0,
           open_blend="", turntable=0, first=1):
    """Start the job in a background Blender (call from a running Blender); returns pid and log."""
    import subprocess
    import bpy
    logs = os.path.join(REPO, "renders", "frames")
    os.makedirs(logs, exist_ok=True)
    log_path = os.path.join(logs, f"log_pilot_studio_{int(time.time())}.txt")
    cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python", os.path.abspath(__file__), "--",
           "--views", views, "--samples", str(samples), "--scale", str(scale), "--h", str(h),
           "--ratio", str(ratio)]
    if prefix:
        cmd += ["--prefix", prefix]
    if not save:
        cmd += ["--no-save"]
    if open_blend:
        cmd += ["--open", open_blend]
    if turntable:
        cmd += ["--turntable", str(turntable), "--first", str(first)]
    flags = 0
    if os.name == "nt":
        flags = subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS
    fh = open(log_path, "w")
    p = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT, cwd=REPO, creationflags=flags)
    return {"pid": p.pid, "log": log_path}


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    main(argv)
