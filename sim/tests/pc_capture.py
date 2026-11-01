"""Film the flight sim on this PC's graphics card: a scripted flight, frame by frame.

Standard library only (py -3, python3 or Blender's Python), next to pc_check.py.

    py -3 sim\\tests\\pc_capture.py [--scenario first_flight] [--size 1920x1080] [--fps 30]
                                    [--out <folder>] [--quality high] [--browser <chrome.exe>]

Opens index.html?test=1 in headless Chrome or Edge (GPU on) through the DevTools protocol and
flies a scripted scenario through the test hook (window.__sim): each frame steps the simulation
by exactly 1/fps s, draws it and saves a JPEG (frames/0001.jpg ...), so the film runs smoothly
whatever the capture speed.  Keys go in as real key events (Shift+B parking brake, Page Up
afterburner, G gear).  Encode the frames with scripts/video/encode_frames.py (Blender) or ffmpeg.
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from pc_check import CDP, find_browser, free_port  # noqa: E402

KEYS = {  # name: (code, key, windows virtual key code)
    "B": ("KeyB", "b", 66), "G": ("KeyG", "g", 71), "PageUp": ("PageUp", "PageUp", 33),
    "PageDown": ("PageDown", "PageDown", 34), "L": ("KeyL", "l", 76), "Shift": ("ShiftLeft", "Shift", 16),
}


def press(cdp, name, shift=False):
    mods = 8 if shift else 0
    if shift:
        c, k, vk = KEYS["Shift"]
        cdp.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", "code": c, "key": k,
                                            "windowsVirtualKeyCode": vk, "modifiers": 8})
    c, k, vk = KEYS[name]
    for t in ("rawKeyDown", "keyUp"):
        cdp.call("Input.dispatchKeyEvent", {"type": t, "code": c, "key": k.upper() if shift and len(k) == 1 else k,
                                            "windowsVirtualKeyCode": vk, "modifiers": mods})
    if shift:
        c, k, vk = KEYS["Shift"]
        cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "code": c, "key": k, "windowsVirtualKeyCode": vk})


# ----------------------------------------------------------------------------------------------
# scenarios: segments of (start point, time of day, seconds, camera schedule, pilot)
def takeoff_pilot(t, s, mem):
    """Brakes off, full burner, rotate at 150 kt to 12 deg, gear up above 25 m, then a 12 deg climb
    easing to 8 deg and a gentle right turn after 20 s (toward the coast)."""
    out = {"keys": []}
    if t >= 0.4 and not mem.get("go"):
        mem["go"] = True
        out["keys"] += [("B", True), ("PageUp", False)]
    if not mem.get("rot") and s.get("onGround") and s.get("ias_kt", 0) > 150:
        mem["rot"] = True
    pitch = 0.0
    roll = 0.0
    if mem.get("rot"):
        target = 12.0 if t < 22 else 8.0
        # Flight track: until the gear goes up the take-off law holds the pitch attitude the raw
        # stick sets (0.6 aft or more: the full 12 deg), so the small pull of the pitch loop below
        # only gave about 6 deg there and the jet stayed at 10-30 m into the turn.  Hold the
        # rotation pull until the gear is up, then fly the pitch.
        if s.get("onGround") or not mem.get("gear"):
            pitch = 0.7
        else:
            pitch = max(-0.4, min(0.75, (target - s.get("pitch_deg", 0)) * 0.05))
    if mem.get("rot") and not mem.get("gear") and not s.get("onGround") and s.get("agl_m", 0) > 25:
        mem["gear"] = True
        out["keys"].append(("G", False))
    if t > 20:
        roll = 0.25 if t < 23 else 0.0
    out["input"] = {"pitch": pitch, "roll": roll}
    return out


def cruise_pilot(bank_in=0.3, bank_s=2.0):
    def f(t, s, mem):
        roll = bank_in if t < bank_s else 0.0
        return {"input": {"roll": roll, "pitch": max(-0.3, min(0.3, (3.0 - s.get("pitch_deg", 0)) * 0.03))}}
    return f


SCENARIOS = {
    "first_flight": [
        {"spawn": "telnof_36", "time": 16.8, "seconds": 26, "cams": [(0, "chase"), (11, "flyby"), (17, "cockpit")],
         "pilot": takeoff_pilot, "settle_ms": 6000},
        {"spawn": "tlv_3000", "time": 12.5, "seconds": 9, "cams": [(0, "orbit")], "pilot": cruise_pilot(0.25, 2.5),
         "settle_ms": 5000},
        {"spawn": "jerusalem_sunset", "seconds": 12, "cams": [(0, "chase"), (6, "cockpit")],
         "pilot": cruise_pilot(-0.2, 2.0), "settle_ms": 5000},
        {"spawn": "deadsea_low", "time": 9.0, "seconds": 7, "cams": [(0, "chase")], "pilot": cruise_pilot(0.0, 0.0),
         "settle_ms": 5000},
    ],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="first_flight", choices=sorted(SCENARIOS))
    ap.add_argument("--browser", default=None)
    ap.add_argument("--port", type=int, default=8037)
    ap.add_argument("--debug-port", type=int, default=9334)
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--quality", default="high")
    ap.add_argument("--jpeg", type=int, default=90)
    ap.add_argument("--out", default=os.path.join(SIM, "data", "capture"))
    ap.add_argument("--swiftshader", action="store_true")
    ap.add_argument("--max-frames", type=int, default=0, help="stop after this many frames (tests)")
    a = ap.parse_args()

    frames = os.path.join(a.out, "frames")
    if os.path.isdir(frames):
        shutil.rmtree(frames, ignore_errors=True)
    os.makedirs(frames, exist_ok=True)
    log = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "args": vars(a), "segments": [], "errors": []}
    browser = a.browser or find_browser()
    if not browser:
        sys.exit("no Chrome or Edge found; pass --browser")
    w, h = (int(v) for v in a.size.lower().split("x"))
    port, dport = free_port(a.port), free_port(a.debug_port)
    srv = subprocess.Popen([sys.executable, os.path.join(SIM, "serve.py"), "--port", str(port)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=SIM)
    base = f"http://127.0.0.1:{port}/"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "index.html", timeout=2).read(10)
            break
        except Exception:
            time.sleep(0.2)
    prof = tempfile.mkdtemp(prefix="f35i_capture_")
    args = [browser, "--headless=new", f"--remote-debugging-port={dport}", f"--user-data-dir={prof}",
            f"--window-size={w},{h}", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            "--ignore-gpu-blocklist", "--mute-audio", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "about:blank"]
    if a.swiftshader:
        args[2:2] = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    else:
        args[2:2] = ["--enable-gpu"] + (["--use-angle=d3d11"] if os.name == "nt" else [])
    if os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() == 0:
        args.insert(1, "--no-sandbox")
    br = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    n = 0
    t_wall = time.time()
    try:
        page = None
        for _ in range(100):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{dport}/json/list", timeout=2).read())
                page = next((t for t in tabs if t.get("type") == "page"), None)
                if page:
                    break
            except Exception:
                pass
            time.sleep(0.2)
        cdp = CDP(page["webSocketDebuggerUrl"])
        for m in ("Page.enable", "Runtime.enable"):
            cdp.call(m)
        cdp.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})
        cdp.call("Page.navigate", {"url": f"{base}index.html?test=1&quality={a.quality}&wingmen=0"})
        t0 = time.time()
        while time.time() - t0 < 180:
            st = cdp.js("window.__sim ? {ready: window.__sim.ready, error: window.__sim.error} : null")
            if st and (st.get("ready") or st.get("error")):
                break
            time.sleep(0.5)
        if not st or st.get("error"):
            raise RuntimeError(f"app did not load: {st}")
        spawns = cdp.js("window.__sim.spawns()")
        dt = 1.0 / a.fps
        for seg in SCENARIOS[a.scenario]:
            if seg["spawn"] not in spawns:
                log["errors"].append(f"no spawn {seg['spawn']}")
                continue
            cams = seg["cams"]
            opts = {"camera": cams[0][1]}
            if seg.get("time") is not None:
                opts["time"] = seg["time"]
            cdp.js(f"window.__sim.setLive(false); window.__sim.setInput(null); "
                   f"window.__sim.start({json.dumps(seg['spawn'])}, {json.dumps(opts)}); "
                   f"window.__sim.camera({json.dumps(cams[0][1])}); true")
            # let the terrain around the start point stream in before filming
            s = cdp.js(f"window.__sim.settle({int(seg.get('settle_ms', 4000))})", timeout=120)
            mem, cam_i, t = {}, 0, 0.0
            seg_log = {"spawn": seg["spawn"], "first_frame": n + 1, "states": []}
            while t < seg["seconds"] - 1e-6:
                while cam_i + 1 < len(cams) and t >= cams[cam_i + 1][0]:
                    cam_i += 1
                    cdp.js(f"window.__sim.camera({json.dumps(cams[cam_i][1])}); true")
                act = seg["pilot"](t, s, mem)
                for k, shift in act.get("keys", []):
                    press(cdp, k, shift)
                cdp.js(f"window.__sim.setInput({json.dumps(act.get('input', {}))}); true")
                s = cdp.js(f"window.__sim.advance({dt})")
                shot = cdp.call("Page.captureScreenshot", {"format": "jpeg", "quality": a.jpeg}, timeout=60)
                n += 1
                with open(os.path.join(frames, f"{n:04d}.jpg"), "wb") as fh:
                    fh.write(base64.b64decode(shot["data"]))
                if n % a.fps == 0:
                    seg_log["states"].append({"t": round(t, 2), **s})
                    print(f"frame {n} {seg['spawn']} t={t:.1f} {json.dumps(s)}", flush=True)
                if s.get("crashed"):
                    log["errors"].append(f"crashed at {seg['spawn']} t={t:.1f}: {s.get('crashReason')}")
                    break
                t += dt
                if a.max_frames and n >= a.max_frames:
                    break
            seg_log["last_frame"] = n
            log["segments"].append(seg_log)
            if a.max_frames and n >= a.max_frames:
                break
    except Exception as e:
        log["errors"].append("capture failed: " + repr(e))
    finally:
        try:
            br.terminate()
            br.wait(10)
        except Exception:
            br.kill()
        srv.terminate()
        shutil.rmtree(prof, ignore_errors=True)
        log["frames"] = n
        log["fps"] = a.fps
        log["wall_s"] = round(time.time() - t_wall, 1)
        log["ended"] = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(os.path.join(a.out, "capture.json"), "w") as fh:
            json.dump(log, fh, indent=1)
        print("frames:", n, "errors:", log["errors"], flush=True)


if __name__ == "__main__":
    main()
