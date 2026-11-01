"""Run background render steps one after another, optionally after another process has finished.
Each step is its own background Blender run with its own log; progress goes to a status file.

    import launch
    launch.script("chain.py", ["--wait-pid", "696", "--steps", r"renders\\frames\\chain_steps.json"])

steps json: [{"script": "clips.py", "args": ["canopy_open", "--suffix", "_v6"], "tag": "pilot_v6"}, ...]
(script paths are relative to scripts/render). Status: renders/frames/chain_status.json.
"""
import json
import os
import subprocess
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
LOGS = os.path.join(REPO, "renders", "frames")
STATUS = os.path.join(LOGS, "chain_status.json")
NO_WINDOW = 0x08000000
LOW = 0x00004000          # BELOW_NORMAL_PRIORITY_CLASS


def alive(pid):
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True,
                             text=True, creationflags=NO_WINDOW).stdout
        return f'"{pid}"' in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def write_status(st):
    st["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(STATUS + ".tmp", "w") as f:
        json.dump(st, f, indent=1)
    os.replace(STATUS + ".tmp", STATUS)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    wait_pid, steps_path = None, None
    i = 0
    while i < len(argv):
        if argv[i] == "--wait-pid":
            wait_pid = int(argv[i + 1])
            i += 2
        elif argv[i] == "--steps":
            steps_path = argv[i + 1]
            i += 2
        else:
            i += 1
    if not os.path.isabs(steps_path):
        steps_path = os.path.join(REPO, steps_path)
    with open(steps_path) as f:
        steps = json.load(f)
    st = {"pid": os.getpid(), "waiting_for": wait_pid, "steps": [s.get("tag", s["script"]) for s in steps],
          "done": [], "current": None}
    write_status(st)
    while wait_pid and alive(wait_pid):
        time.sleep(30)
        write_status(st)
    st["waiting_for"] = None
    for s in steps:
        tag = s.get("tag") or os.path.splitext(os.path.basename(s["script"]))[0]
        log = os.path.join(LOGS, f"log_{tag}_{int(time.time())}.txt")
        cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python", os.path.join(HERE, s["script"]), "--",
               *[str(a) for a in s.get("args", [])]]
        st["current"] = {"tag": tag, "log": log, "started": time.strftime("%H:%M:%S")}
        write_status(st)
        print("CHAIN start", tag, flush=True)
        with open(log, "w") as fh:
            rc = subprocess.run(cmd, stdout=fh, stderr=subprocess.STDOUT, cwd=REPO,
                                creationflags=(NO_WINDOW | LOW) if os.name == "nt" else 0).returncode
        st["done"].append({"tag": tag, "rc": rc, "log": log, "ended": time.strftime("%H:%M:%S")})
        st["current"] = None
        write_status(st)
        print("CHAIN done", tag, rc, flush=True)
    st["finished"] = True
    write_status(st)


main()
