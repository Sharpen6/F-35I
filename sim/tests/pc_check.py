"""Check the flight sim in a real browser on this PC's graphics card (Windows, macOS or Linux).

Standard library only: works with `py -3`, `python3` or Blender's bundled Python.

    py -3 sim\\tests\\pc_check.py [--browser <chrome.exe or msedge.exe>] [--port 8036]
                                  [--size 1920x1080] [--seconds 12] [--quality high]
                                  [--spawns telnof_36,tlv_3000,jerusalem_sunset] [--out <folder>]
                                  [--headful] [--uncapped]

It starts serve.py on its own port, opens index.html?test=1 in Chrome or Edge (headless, GPU on)
through the DevTools protocol, and for each start point flies live for `--seconds` (full throttle
on the runway starts), then saves a screenshot and the numbers: frames per second, draw calls,
triangles, textures, the GPU name, console errors.  Report: <out>/pc_check.json (+ .jpg shots).
Start-up hitches (js/env/warmup.js): the report has the shader warm-up's summary after loading,
the menu drawn live for 3 s, and for every scene the frames of its first 3 s (worst frame) and the
names of the shader programs made after the scene started ("programs_made"; each one is a stall of
0.1-0.8 s on ANGLE / Direct3D, so the lists should be empty).
Headless Chrome paces its frames at about 56-60 per second whatever the load; `--uncapped` turns
vsync and the frame-rate limit off, so the frame times show what a frame really costs.
"""
import argparse
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.dirname(HERE)


def find_browser():
    cands = []
    if os.name == "nt":
        for base in (os.environ.get("PROGRAMFILES", r"C:\Program Files"),
                     os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
                     os.environ.get("LOCALAPPDATA", "")):
            if base:
                cands += [os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
                          os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")]
    else:
        cands += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        for n in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
            p = shutil.which(n)
            if p:
                cands.append(p)
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


def free_port(start):
    for p in range(start, start + 50):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("no free port")


# ----------------------------------------------------------------------------------------------
# a minimal WebSocket client (RFC 6455), enough for the DevTools protocol
class WS:
    def __init__(self, url, timeout=60):
        assert url.startswith("ws://")
        hostport, path = url[5:].split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket handshake failed")
            resp += chunk
        head, self.buf = resp.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError("websocket handshake refused: " + head.decode(errors="replace"))

    def send(self, text):
        data = text.encode()
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(hdr) + body)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise RuntimeError("websocket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        parts = []
        while True:
            b0, b1 = self._read(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b1 & 0x80:
                mask = self._read(4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._read(n)))
            else:
                payload = self._read(n)
            if op == 0x9:                       # ping -> pong
                continue
            if op == 0x8:
                raise RuntimeError("websocket closed by the browser")
            parts.append(payload)
            if b0 & 0x80:
                return b"".join(parts).decode(errors="replace")


class CDP:
    def __init__(self, ws_url, slow=1):
        self.ws = WS(ws_url)
        self.next_id = 0
        self.events = []
        self.slow = slow                        # every timeout times this (SwiftShader)

    def call(self, method, params=None, timeout=120):
        self.next_id += 1
        mid = self.next_id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        timeout *= self.slow
        t0 = time.time()
        while time.time() - t0 < timeout:
            # (the socket waits as long as the call may: a page in a long frame sends nothing meanwhile)
            self.ws.sock.settimeout(max(1.0, timeout - (time.time() - t0)))
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            if "method" in msg:
                self.events.append(msg)
        raise TimeoutError(method)

    def js(self, expr, timeout=120):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True},
                      timeout=timeout)
        if r.get("exceptionDetails"):
            raise RuntimeError("JS: " + json.dumps(r["exceptionDetails"])[:600])
        return r.get("result", {}).get("value")


STATS_JS = r"""(() => {
  const a = window.__sim.app, r = a.renderer, i = r.info;
  let gpu = '';
  try { const gl = r.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) {}
  return { summary: window.__sim.summary(), calls: i.render.calls, triangles: i.render.triangles,
           geometries: i.memory.geometries, textures: i.memory.textures, programs: (i.programs || []).length,
           pixelRatio: r.getPixelRatio(), size: [innerWidth, innerHeight], gpu,
           heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null };
})()"""

# measure frame times in the page for `ms` milliseconds while the app runs live
FPS_JS = r"""new Promise((done) => {
  const t = []; let last = performance.now(); const t0 = last;
  function f(now) { t.push(now - last); last = now; if (now - t0 < %d) requestAnimationFrame(f); else {
    t.shift(); const s = [...t].sort((a, b) => b - a); const avg = t.reduce((a, b) => a + b, 0) / t.length;
    const p99 = s[Math.floor(s.length * 0.01)] || avg;
    done({ frames: t.length, avg_ms: +avg.toFixed(2), fps: +(1000 / avg).toFixed(1),
           low1_fps: +(1000 / p99).toFixed(1), worst_ms: +s[0].toFixed(1) }); } }
  requestAnimationFrame(f);
})"""

# the first `ms` of a scene: goes live in the same evaluation and keeps every frame (FPS_JS drops
# its first one, and a separate setLive call lets the first live frame pass unmeasured: that frame
# is where a start-up hitch shows). performance.now() in the callback: the app's frame, drawn just
# before it in the same animation frame, is inside each gap.
FIRST_JS = r"""new Promise((done) => {
  const t = []; let last = performance.now(); const t0 = last;
  window.__sim.setLive(true);
  function f() { const now = performance.now(); t.push(now - last); last = now; if (now - t0 < %d) requestAnimationFrame(f); else {
    const s = [...t].sort((a, b) => b - a); const avg = t.reduce((a, b) => a + b, 0) / t.length;
    done({ frames: t.length, avg_ms: +avg.toFixed(2), worst_ms: +s[0].toFixed(1), worst3_ms: s.slice(0, 3).map((x) => +x.toFixed(1)),
           over50: t.filter((x) => x > 50).length }); } }
  requestAnimationFrame(f);
})"""

# shader programs: a mark (the id the next one gets), the names of those made since a mark, the
# warm-up's summary (js/env/warmup.js; its "late" list says what made each program after start-up)
MARK_JS = "(() => { let id = -1; for (const p of window.__sim.app.renderer.info.programs) id = Math.max(id, p.id); return id + 1; })()"
MADE_JS = "window.__sim.app.renderer.info.programs.filter((p) => p.id >= %d).map((p) => p.name || p.type || '?')"
WARMUP_JS = "(() => { const w = window.__sim.app.warmup; return w && w.info ? w.info() : null; })()"
LATE_JS = "(() => { const w = window.__sim.app.warmup; return w ? w.late.slice(%d) : []; })()"
LATE_N_JS = "(() => { const w = window.__sim.app.warmup; return w ? w.late.length : 0; })()"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default=None)
    ap.add_argument("--port", type=int, default=8036)
    ap.add_argument("--debug-port", type=int, default=9333)
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--seconds", type=float, default=12.0)
    ap.add_argument("--quality", default="high")
    ap.add_argument("--spawns", default="telnof_36,tlv_3000,jerusalem_sunset,deadsea_low")
    ap.add_argument("--cameras", default="chase,cockpit")
    ap.add_argument("--out", default=os.path.join(SIM, "data", "pc_check"))
    ap.add_argument("--headful", action="store_true")
    ap.add_argument("--extra", default="", help="extra URL parameters, e.g. depth=reversed")
    ap.add_argument("--swiftshader", action="store_true", help="software WebGL (machines without a GPU)")
    ap.add_argument("--uncapped", action="store_true",
                    help="no vsync / frame-rate limit, so the frame times show the real cost (headless Chrome "
                         "otherwise paces frames at about 56-60 per second whatever the load)")
    a = ap.parse_args()
    # SwiftShader (no GPU): a scene's first frame can take minutes there (the DevTools calls wait longer)
    slow = 10 if a.swiftshader else 1

    os.makedirs(a.out, exist_ok=True)
    report = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "args": vars(a), "runs": [], "errors": []}
    browser = a.browser or find_browser()
    if not browser:
        sys.exit("no Chrome or Edge found; pass --browser")
    w, h = (int(v) for v in a.size.lower().split("x"))
    port = free_port(a.port)
    dport = free_port(a.debug_port)
    srv = subprocess.Popen([sys.executable, os.path.join(SIM, "serve.py"), "--port", str(port)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=SIM)
    base = f"http://127.0.0.1:{port}/"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "index.html", timeout=2).read(10)
            break
        except Exception:
            time.sleep(0.2)
    else:
        srv.kill()
        sys.exit("serve.py did not start")
    prof = tempfile.mkdtemp(prefix="f35i_pc_check_")
    args = [browser, f"--remote-debugging-port={dport}", f"--user-data-dir={prof}", f"--window-size={w},{h}",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--ignore-gpu-blocklist",
            "--enable-gpu-rasterization", "--autoplay-policy=no-user-gesture-required",
            "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows", "about:blank"]
    if not a.headful:
        args.insert(1, "--headless=new")
        if a.swiftshader:
            args[2:2] = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        else:
            args.insert(2, "--enable-gpu")
            if os.name == "nt":
                args.insert(3, "--use-angle=d3d11")
    if a.uncapped:
        args[1:1] = ["--disable-gpu-vsync", "--disable-frame-rate-limit"]
    if os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() == 0:
        args.insert(1, "--no-sandbox")          # Chrome refuses to run as root otherwise
    br = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        if not page:
            raise RuntimeError("browser did not open a page")
        cdp = CDP(page["webSocketDebuggerUrl"], slow)
        for m in ("Page.enable", "Runtime.enable", "Log.enable"):
            cdp.call(m)
        cdp.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})
        url = f"{base}index.html?test=1&quality={a.quality}&wingmen=0" + (f"&{a.extra}" if a.extra else "")
        t0 = time.time()
        cdp.call("Page.navigate", {"url": url})
        while time.time() - t0 < 180:
            st = cdp.js("window.__sim ? {ready: window.__sim.ready, error: window.__sim.error} : null")
            if st and (st.get("ready") or st.get("error")):
                break
            time.sleep(0.5)
        report["load_s"] = round(time.time() - t0, 1)
        if not st or st.get("error"):
            raise RuntimeError(f"app did not load: {st}")
        spawns = cdp.js("window.__sim.spawns()")
        report["spawns_available"] = spawns
        report["warmup"] = cdp.js(WARMUP_JS)
        report["programs_at_load"] = cdp.js("window.__sim.app.renderer.info.programs.length")
        # the menu, live: its first frames
        mark, late0 = cdp.js(MARK_JS), cdp.js(LATE_N_JS)
        menu = cdp.js(FIRST_JS % 3000, timeout=60)
        cdp.js("window.__sim.setLive(false); true")
        report["menu"] = {"first3s": menu, "programs_made": cdp.js(MADE_JS % mark), "warmup_late": cdp.js(LATE_JS % late0)}
        print(json.dumps({"menu": menu, "programs_made": report["menu"]["programs_made"]}), flush=True)
        for sp in [s for s in a.spawns.split(",") if s]:
            if sp not in spawns:
                report["errors"].append(f"no spawn {sp}")
                continue
            for cam in [c for c in a.cameras.split(",") if c]:
                mark, late0 = cdp.js(MARK_JS), cdp.js(LATE_N_JS)
                cdp.js(f"window.__sim.setLive(false); window.__sim.start({json.dumps(sp)}, {{camera: {json.dumps(cam)}}});"
                       f" window.__sim.camera({json.dumps(cam)}); true")
                ground = cdp.js("window.__sim.summary().onGround")
                cdp.js("window.__sim.setInput(" + json.dumps({"throttle": 1.0, "brake": 0} if ground else {}) + "); true")
                first = cdp.js(FIRST_JS % 3000, timeout=60)      # the scene's first 3 s from its first frame: any start-up hitch
                time.sleep(max(0.0, a.seconds - 8))
                fps = cdp.js(FPS_JS % 5000, timeout=60)
                made = cdp.js(MADE_JS % mark)
                late = cdp.js(LATE_JS % late0)
                stats = cdp.js(STATS_JS)
                shot = cdp.call("Page.captureScreenshot", {"format": "jpeg", "quality": 88}, timeout=60)
                fn = os.path.join(a.out, f"pc_{sp}_{cam}.jpg")
                with open(fn, "wb") as fh:
                    fh.write(base64.b64decode(shot["data"]))
                cdp.js("window.__sim.setLive(false); window.__sim.setInput(null); true")
                run = {"spawn": sp, "camera": cam, "fps": fps, "first3s": first, "programs_made": made, "warmup_late": late,
                       **stats, "shot": fn}
                report["runs"].append(run)
                line = {k: run[k] for k in ("spawn", "camera", "fps", "calls", "triangles", "programs_made")}
                line["first_worst_ms"] = first.get("worst_ms") if first else None
                print(json.dumps(line), flush=True)
        for e in cdp.events:
            m = e.get("method")
            p = e.get("params", {})
            if m == "Runtime.exceptionThrown":
                report["errors"].append("exception: " + json.dumps(p.get("exceptionDetails", {}))[:500])
            elif m == "Runtime.consoleAPICalled" and p.get("type") in ("error", "warning"):
                report["errors"].append(p["type"] + ": " + " ".join(str(x.get("value", x.get("description", "")))
                                                                     for x in p.get("args", []))[:500])
            elif m == "Log.entryAdded" and p.get("entry", {}).get("level") in ("error", "warning"):
                report["errors"].append("log: " + p["entry"].get("text", "")[:500])
    except Exception as e:
        report["errors"].append("check failed: " + repr(e))
    finally:
        try:
            report["warmup_end"] = cdp.js(WARMUP_JS)
        except Exception:
            pass
        try:
            br.terminate()
            br.wait(10)
        except Exception:
            br.kill()
        srv.terminate()
        shutil.rmtree(prof, ignore_errors=True)
        report["ended"] = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(os.path.join(a.out, "pc_check.json"), "w") as fh:
            json.dump(report, fh, indent=1)
        print("report:", os.path.join(a.out, "pc_check.json"), "errors:", len(report["errors"]), flush=True)


if __name__ == "__main__":
    main()
