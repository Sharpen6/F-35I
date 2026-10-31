"""Start a background Blender render from a running Blender (e.g. via the MCP),
so long renders do not block the interactive session.

    import sys; sys.path.insert(0, r"<repo>/scripts/render")
    import launch
    launch.clips(["turntable"], engine="CYCLES", res="1280x720", samples=48, fps=24)
    launch.status()            # tail of the newest log
"""
import glob
import os
import subprocess
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
LOGS = os.path.join(REPO, "renders", "frames")


def clips(names, engine="CYCLES", res="1280x720", samples=48, fps=24, suffix="", extra=()):
    os.makedirs(LOGS, exist_ok=True)
    log = os.path.join(LOGS, f"log_{'_'.join(names)}{suffix}_{int(time.time())}.txt")
    cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python", os.path.join(HERE, "clips.py"), "--",
           *names, "--engine", engine, "--res", res, "--samples", str(samples), "--fps", str(fps)]
    if suffix:
        cmd += ["--suffix", suffix]
    cmd += list(extra)
    flags = 0
    if os.name == "nt":
        flags = subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS
    fh = open(log, "w")
    p = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT, cwd=REPO, creationflags=flags)
    return {"pid": p.pid, "log": log, "cmd": cmd}


def status(pattern="", lines=6):
    """Tails of the newest render logs (log_<pattern>*.txt)."""
    logs = sorted(glob.glob(os.path.join(LOGS, f"log_{pattern}*.txt")), key=os.path.getmtime)
    out = {}
    for lg in logs[-3:]:
        with open(lg, errors="replace") as f:
            txt = [l.rstrip() for l in f if l.startswith(("FRAME", "CLIP", "CYCLES", "Traceback", "Error"))
                   or "Error" in l]
        out[os.path.basename(lg)] = txt[-lines:]
    return out
