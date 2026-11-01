"""Assemble the ~20 minute making-of video in Blender's sequencer (no 3D rendering: stills with a
slow push-in, the animation clips, pages of the source code, chapter cards and captions, and
cross-dissolves between everything).

Background Blender, from the repository root (the renders live on the render PC):
    blender -b --factory-startup --python scripts/video/make_video.py -- [--res 1920x1080]
            [--out renders/video/F-35I_Adir_making_of.mp4] [--scale 1.0] [--dry] [--only 1,3]
            [--stills 100,2000] [--frames 1-600] [--root <data root>]
--dry      builds the timeline, prints the chapters and the length, writes chapters.txt
--scale    0.5 renders a quicker half-resolution preview
--only     keeps just those chapters (plus the titles)
--stills   renders single frames to renders/video/check/ to check the layout
--frames   renders only that frame range into the movie
"""
import argparse
import csv
import glob
import os
import re
import shutil
import sys
import warnings

import bpy

warnings.filterwarnings("ignore", category=DeprecationWarning)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = [ROOT]                     # where renders/, references/ and blend/ are (--root)
FPS = 24


def R(*p):
    return os.path.join(DATA[0], *p)


# ------------------------------------------------------------------ captions
REFS = [  # (file prefix, caption)
    ("ref_00", "Red Flag 23-2, Nellis AFB: IAF aircrew walk to their F-35I Adir jets  (USAF photo, public domain)"),
    ("ref_01", "F-35I 926 taxiing at Nellis: pilot, canopy and stencils  (USAF photo, public domain)"),
    ("ref_02", "Rear quarter: nozzle, tails and the shape of the aft deck  (USAF photo, public domain)"),
    ("ref_03", "Pre-flight walk-round: flight suit, vest and G-suit details  (USAF photo, public domain)"),
    ("ref_04", "Night maintenance: main gear legs and doors  (USAF photo, public domain)"),
    ("ref_05", "Boarding at night: ladder, canopy open, serial 901  (USAF photo, public domain)"),
    ("ref_06", "First IAF Adir, December 2016  (Maj. Ofer / IAF, CC BY 4.0)"),
    ("ref_07", "Adir climbing out: planform and paint  (IDF Spokesperson's Unit, CC BY-SA 3.0)"),
    ("ref_08", "Adir from below: bays, doors and tails  (IDF Spokesperson's Unit, CC BY-SA 3.0)"),
    ("ref_09", "3-view drawing used to lay out the stations  (Wikimedia Commons)"),
]
DIMENSIONS = ("Length 15.7 m   ·   Span 10.7 m   ·   Height 4.38 m\n"
              "Wing area 42.7 m²   ·   Tailplane span 6.86 m\n"
              "Wheelbase 6.02 m   ·   Wheel track 4.34 m\n"
              "F135 engine, nozzle of 15 + 15 overlapping flaps")
PROGRESS = {
    "001": "First airframe: fuselage, wings and tails laid over the 3-view",
    "002": "Cockpit, first pass: panoramic display, stick, throttle, seat",
    "003": "Weapon bays open: GBU-31 JDAM and AIM-120 AMRAAM",
    "004": "Landing gear down",
    "005": "Main gear well",
    "006": "Gear retracting: solved leg, strut and door kinematics",
    "007": "Canopy open, control surfaces deflected",
    "008": "Damage model: hits on the front left",
    "009": "Damage model: rear right, burnt stubs and soot",
    "010": "Damage model from above",
    "011": "Hitboxes (X-ray): every component the simulator knows about",
    "012": "Hitboxes from the side",
    "013": "New nose: chines and radome reshaped",
    "014": "Nose before / after",
    "015": "Nose and inlets before / after",
    "016": "New inlets: diverterless (DSI) bump",
    "017": "Panel lines",
    "018": "Panel lines before / after",
    "019": "Photo match: model edges over a reference photo",
    "020": "Edge overlay, front",
    "021": "Edge overlay, side and belly",
    "022": "Gear doors before / after",
    "023": "Gear cycle",
    "024": "Main gear leg before / after",
    "025": "Gun port before / after",
    "026": "Canopy and shoulder before / after",
    "027": "Nozzle and aft end before / after",
    "028": "Inlets before / after",
    "029": "Inlet aperture against the drawing",
    "030": "Nose gear doors and the faceted EOTS window",
    "031": "Paint and sky: HDRI light with a matched sun, satin paint tuned to photos",
    "032": "Afterburner: volumetric flame with shock diamonds",
    "033": "Cockpit moved 0.55 m forward, canopy bow and frame band",
    "034": "Pilot rebuilt: skinned body, IAF flight gear, HMDS helmet",
    "035": "Stencils redrawn from close photos; the canopy band closes over the tip",
}
CLIPS = [  # (file stem, title, caption)
    ("turntable_v6", "Turntable", "Final paint, sky and the new pilot"),
    ("gear_retract_v6", "Landing gear", "Retraction: legs fold, wheels turn, doors sequence"),
    ("canopy_open_v6", "Canopy", "Canopy opens on its forward hinge"),
    ("pilot_look_v6", "Pilot", "Head look: left, right, up and down"),
    ("startup_v6", "Start-up", "Battery, IPP, displays, lights, engine start: every switch is live"),
    ("controls_v6", "Flight controls", "Stabilators, flaperons, rudders and leading-edge flaps on the stick"),
    ("weapon_bays_v6", "Weapon bays", "Bay doors and the stores inside"),
    ("afterburner_v5", "Afterburner", "Throttle from idle to full reheat and back"),
    ("walkaround_v6", "Walk-around", "A slow walk round the parked jet"),
]
FALLBACK = {  # older takes used when a clip has not been rendered yet
    "turntable_v6": "turntable_v5",
    "gear_retract_v6": "gear_retract_v4", "canopy_open_v6": "canopy_open_v4", "pilot_look_v6": "pilot_look_v4",
    "controls_v6": "controls_v4", "weapon_bays_v6": "weapon_bays_v4",
}
VERSIONS = [  # (title, [clip stems oldest -> newest])
    ("Turntable, five versions", ["turntable_v2", "turntable_v3", "turntable_v4", "turntable_v5", "turntable_v6"]),
    ("Gear retraction, four versions", ["gear_retract", "gear_retract_v3", "gear_retract_v4", "gear_retract_v6"]),
    ("Pilot look, three versions", ["pilot_look", "pilot_look_v4", "pilot_look_v6"]),
]
IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".exr")


def media(path):
    """Copy an image with an odd name (no extension, '&' in it) to a cache with a clean one."""
    if not os.path.exists(path) or (path.lower().endswith(IMG_EXT) and "&" not in path):
        return path
    with open(path, "rb") as f:
        head = f.read(12)
    ext = (".jpg" if head[:3] == b"\xff\xd8\xff" else ".png" if head[:4] == b"\x89PNG"
           else ".webp" if head[8:12] == b"WEBP" else os.path.splitext(path)[1])
    cache = R("renders", "video", "_cache")
    os.makedirs(cache, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", os.path.splitext(os.path.basename(path))[0])[:48]
    dst = os.path.join(cache, stem + ext)
    if not os.path.exists(dst):
        shutil.copyfile(path, dst)
    return dst


FONTS = {False: ["C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
         True: ["C:/Windows/Fonts/segoeuib.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]}
_FONT_CACHE = {}


def ui_font(bold):
    if bold not in _FONT_CACHE:
        _FONT_CACHE[bold] = None
        for p in FONTS[bold]:
            if os.path.exists(p):
                _FONT_CACHE[bold] = bpy.data.fonts.load(p, check_existing=True)
                break
    return _FONT_CACHE[bold]


# ------------------------------------------------------------------ timeline
class Timeline:
    TEXT_CH = (6, 24)             # channels for text strips
    GRID_CH = 30                  # thumbnails before they move into their meta strip

    def __init__(self, sc, res):
        self.sc = sc
        self.se = sc.sequence_editor_create()
        self.res = res
        self.f = 1                    # next free frame
        self.last = None              # last content strip (for cross-dissolves)
        self.slot = 0                 # content alternates between channels 1 and 2
        self.chapters = []
        self.busy = {}                # text channel -> last end frame
        self.k = 0

    def s2f(self, seconds):
        return max(1, int(round(seconds * FPS)))

    def _name(self, tag):
        self.k += 1
        return f"{tag}_{self.k:04d}"

    def _place(self, strip, fade):
        """Overlap with the previous strip by `fade` and add a cross-dissolve over the overlap."""
        if self.last is not None and fade > 0:
            n = min(self.s2f(fade), self.last.frame_final_duration // 2, strip.frame_final_duration // 2)
            if n >= 2:
                strip.frame_start -= n
                self.f -= n
                cr = self.se.strips.new_effect(self._name("X"), 'CROSS', 3, self.f, length=n,
                                               input1=self.last, input2=strip)
        self.last = strip

    def _content_channel(self):
        self.slot = 1 - self.slot
        return 1 + self.slot

    def _text_channel(self, a, b):
        for ch in range(*self.TEXT_CH):
            if self.busy.get(ch, -10**9) <= a:
                self.busy[ch] = b
                return ch
        raise RuntimeError(f"no free text channel at frame {a}")

    def image(self, path, seconds, caption=None, push=0.06, fade=0.6):
        if not os.path.exists(path):
            print("VIDEO missing", path, flush=True)
            return None
        n = self.s2f(seconds)
        st = self.se.strips.new_image(self._name("I"), media(path), self._content_channel(), self.f,
                                      fit_method='FIT')
        st.frame_final_duration = n
        self._place(st, fade)
        if push:                                  # slow push-in (FIT already set the base scale)
            t = st.transform
            base = t.scale_x
            for fr, sc in ((st.frame_final_start, base), (st.frame_final_end, base * (1.0 + push))):
                t.scale_x = t.scale_y = sc
                t.keyframe_insert("scale_x", frame=fr)
                t.keyframe_insert("scale_y", frame=fr)
        if caption:
            self.caption(caption, st.frame_final_start, st.frame_final_end)
        self.f = st.frame_final_end
        return st

    def grid(self, paths, seconds, cols=4, rows=3, caption=None, fade=0.6, labels=None):
        """A page of thumbnails: image strips placed in a grid inside one meta strip."""
        if labels:
            pairs = [(p, l) for p, l in zip(paths, labels) if os.path.exists(p)]
            paths, labels = [p for p, _ in pairs], [l for _, l in pairs]
        paths = [p for p in paths if os.path.exists(p)][:cols * rows]
        if not paths:
            return None
        n = self.s2f(seconds)
        start = self.f
        W, H = self.res
        cw, chh = W / cols, H / rows
        kids = []
        for i, p in enumerate(paths):
            st = self.se.strips.new_image(self._name("G"), media(p), self.GRID_CH + i, start, fit_method='FIT')
            st.frame_final_duration = n
            c, r = i % cols, i // cols
            t = st.transform
            t.scale_x = t.scale_y = t.scale_x * min(1.0 / cols, 1.0 / rows) * 0.96
            t.offset_x = (c + 0.5) * cw - W / 2
            t.offset_y = H / 2 - (r + 0.5) * chh
            kids.append(st)
        meta = self.se.strips.new_meta(self._name("M"), self._content_channel(), start)
        for st in kids:
            st.move_to_meta(meta)
        meta.frame_final_duration = n
        self._place(meta, fade)
        if caption:
            self.caption(caption, meta.frame_final_start, meta.frame_final_end)
        for i, lab in enumerate(labels or []):
            c, r = i % cols, i // cols
            y = 1.0 - (r + 0.5) / rows + 0.5 / rows * min(1.0 / cols, 1.0 / rows) * 0.96 + 0.035
            self.text(lab, meta.frame_final_start, meta.frame_final_end, size=0.032, x=(c + 0.5) / cols,
                      y=min(y, 0.95), bold=True)
        self.f = meta.frame_final_end
        return meta

    def movie(self, path, caption=None, fade=0.5, max_seconds=None):
        if not os.path.exists(path):
            print("VIDEO missing", path, flush=True)
            return None
        st = self.se.strips.new_movie(self._name("V"), path, self._content_channel(), self.f, fit_method='FIT')
        if st.fps and abs(st.fps - FPS) > 0.01:          # (retiming keys from Python are not reliable)
            print("VIDEO fps", os.path.basename(path), st.fps, "plays at", FPS, flush=True)
        if max_seconds:
            st.frame_final_duration = min(st.frame_final_duration, self.s2f(max_seconds))
        self._place(st, fade)
        if caption:
            self.caption(caption, st.frame_final_start, st.frame_final_end)
        self.f = st.frame_final_end
        return st

    def card(self, title, subtitle=None, seconds=4.0, fade=0.6, big=True, body=None):
        """Dark card with centred text."""
        n = self.s2f(seconds)
        bg = self.se.strips.new_effect(self._name("C"), 'COLOR', self._content_channel(), self.f, length=n)
        bg.color = (0.015, 0.016, 0.018)
        self._place(bg, fade)
        a, b = bg.frame_final_start, bg.frame_final_end
        if body:
            self.text(title, a, b, size=0.06, y=0.80, bold=True)
            self.text(body, a, b, size=0.038, y=0.46, color=(0.86, 0.88, 0.90, 1))
        else:
            self.text(title, a, b, size=0.085 if big else 0.06, y=0.56 if subtitle else 0.5, bold=True)
            if subtitle:
                self.text(subtitle, a, b, size=0.034, y=0.42, color=(0.80, 0.82, 0.85, 1))
        self.f = b
        return bg

    def chapter(self, number, title, subtitle=None):
        self.chapters.append([number, title, self.f, None])
        self.card(f"{number}  ·  {title}", subtitle, seconds=4.5, big=False)

    def end_chapter(self):
        """Small chapter name in the corner for the rest of the chapter."""
        if self.chapters and self.chapters[-1][3] is None:
            n, title, f0, _ = self.chapters[-1]
            self.chapters[-1][3] = self.f
            a = f0 + self.s2f(4.5)
            if self.f - a > self.s2f(3):
                self.text(f"{n} · {title}", a, self.f, size=0.024, x=0.975, y=0.955, anchor='RIGHT',
                          color=(1, 1, 1, 0.75), shadow=True)

    def text(self, s, a, b, size=0.04, x=0.5, y=0.5, bold=False, color=(1, 1, 1, 1), box=False,
             anchor='CENTER', fade=0.5, shadow=True):
        H = self.res[1]
        t = self.se.strips.new_effect(self._name("T"), 'TEXT', self._text_channel(a, b), a, length=b - a)
        t.text = s
        t.font_size = int(size * H)
        t.location = (x, y)
        fnt = ui_font(bold)
        if fnt is not None:
            t.font = fnt
        else:
            t.use_bold = bold
        t.color = color
        t.anchor_x = anchor
        t.anchor_y = 'CENTER'
        t.alignment_x = anchor
        t.wrap_width = 0.92
        t.use_shadow = shadow
        t.shadow_color = (0, 0, 0, 0.8)
        if box:
            t.use_box = True
            t.box_color = (0.0, 0.0, 0.0, 0.55)
            t.box_margin = 0.012
        t.blend_type = 'ALPHA_OVER'
        nf = min(self.s2f(fade), max(1, (b - a) // 4))
        for fr, al in ((a, 0.0), (a + nf, 1.0), (b - nf, 1.0), (b, 0.0)):
            t.blend_alpha = al
            t.keyframe_insert("blend_alpha", frame=fr)
        return t

    def caption(self, s, a, b):
        self.text(s, a + self.s2f(0.3), b - self.s2f(0.2), size=0.028, x=0.04, y=0.07, anchor='LEFT', box=True)


# ------------------------------------------------------------------ storyboard
def history_rows():
    p = R("blend", "history", "index.csv")
    if not os.path.exists(p):
        return []
    with open(p, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def history_still(nn, view):
    for ext in (".png", ".jpg"):
        p = R("renders", "history", f"{nn}_{view}{ext}")
        if os.path.exists(p):
            return p
    return R("renders", "history", f"{nn}_{view}.png")


def first(pattern):
    m = sorted(glob.glob(pattern))
    return m[0] if m else pattern


def clip(stem):
    conv = R("renders", "video", "clips", stem + "_24fps.mp4")     # early 12 fps clips, converted
    if os.path.exists(conv):
        return conv
    p = R("renders", "animation", stem + ".mp4")
    if not os.path.exists(p) and stem in FALLBACK:
        print("VIDEO fallback", stem, "->", FALLBACK[stem], flush=True)
        p = R("renders", "animation", FALLBACK[stem] + ".mp4")
    return p


def code_stats():
    files = [p for p in glob.glob(os.path.join(ROOT, "scripts", "**", "*.py"), recursive=True)]
    lines = 0
    for p in files:
        with open(p, encoding="utf-8", errors="replace") as f:
            lines += sum(1 for _ in f)
    return len(files), lines


def build(tl, only=None):
    def want(n):
        return not only or n in only
    # title
    tl.card("F-35I  ADIR", "A procedural Blender model: built, rigged, animated and broken.  The making-of.",
            seconds=8.0)
    tl.movie(clip("turntable_v6"), "Built entirely from Python scripts: no hand modelling")
    tl.movie(clip("afterburner_v5"))
    if want(1):
        tl.chapter(1, "Research", "Public photos, a 3-view drawing and published dimensions")
        tl.card("Published dimensions", body=DIMENSIONS, seconds=10.0)
        for pre, cap in REFS:
            tl.image(first(R("references", pre + "*")), 7.5 if pre != "ref_09" else 10.0, cap)
        cands = sorted(glob.glob(R("references", "candidates", "*.jpg")))
        for i in range(0, min(len(cands), 72), 12):
            tl.grid(cands[i:i + 12], 4.0, caption=f"{len(cands)} candidate photos screened for angles and details")
        tl.end_chapter()
    if want(2):
        nf, nl = code_stats()
        tl.chapter(2, "The code", f"{nl:,} lines of Python in {nf} files build, rig and animate the whole jet")
        for p in sorted(glob.glob(R("renders", "video", "code", "*.png"))):
            tl.image(p, 9.0 if "code_grew" in p else 7.0, None, push=0.025)
        tl.end_chapter()
    if want(3):
        tl.chapter(3, "Building the airframe", "Every milestone is kept as a numbered backup of the .blend file")
        for row in history_rows():
            nn = f"{int(row['n']):02d}"
            summ = (row.get("summary") or "").split("\n")[0].strip().rstrip(".")
            when = (row.get("date") or "")[-5:]
            for view in ("fl34", "side", "rr34"):
                tl.image(history_still(nn, view), 4.5, f"Backup {nn}  ·  {when}  ·  {summ}", push=0.04, fade=0.5)
        tl.end_chapter()
    if want(4):
        tl.chapter(4, "Detail work", "Review renders against the photos, then fix, then review again")
        for p in sorted(glob.glob(R("renders", "progress", "*.*"))):
            num = os.path.basename(p)[:3]
            tl.image(p, 8.5, f"{num}  ·  {PROGRESS.get(num, os.path.basename(p)[4:-4].replace('_', ' '))}")
        tl.end_chapter()
    if want(5):
        tl.chapter(5, "The review loop", "Each change rendered from fixed cameras and compared with the photos")
        revs = sorted(glob.glob(R("renders", "review", "*.png")), key=os.path.getmtime)
        a = tl.f
        for p in revs:
            tl.image(p, 0.5, None, push=0.0, fade=0.0)
        if revs:
            tl.text(f"{len(revs)} review renders", a, tl.f, size=0.045, x=0.5, y=0.08, box=True)
        tl.end_chapter()
    if want(6):
        tl.chapter(6, "Rig and animation", "One rig drives the gear, doors, canopy, controls, pilot and switches")
        for stem, title, cap in CLIPS:
            tl.card(title, cap, seconds=3.0, big=False)
            tl.movie(clip(stem), f"{title}  ·  {cap}")
        tl.end_chapter()
    if want(7):
        tl.chapter(7, "Damage model", "Hitboxes, a damage simulator and parts that break off")
        for p in sorted(glob.glob(R("renders", "progress", "0[01][0-9]_*"))):
            num = os.path.basename(p)[:3]
            if num in ("008", "009", "010", "011", "012"):
                tl.image(p, 7.0, PROGRESS[num])
        for p in sorted(glob.glob(R("renders", "video", "tables", "*.png"))):
            tl.image(p, 9.0, None, push=0.02)
        tl.movie(clip("destruction_v6"), "Two hits: the left wing tip tears off, then the left main gear folds")
        tl.end_chapter()
    if want(8):
        tl.chapter(8, "Then and now", "The first version against the latest, then the same clips version after version")
        rows = history_rows()
        if len(rows) > 1:
            a, b = rows[0], rows[-1]
            na, nb = f"{int(a['n']):02d}", f"{int(b['n']):02d}"
            for view in ("fl34", "side", "rr34"):
                tl.grid([history_still(na, view), history_still(nb, view)], 6.0, cols=2, rows=1,
                        labels=[f"Backup {na}  ·  {a['date'][-5:]}", f"Backup {nb}  ·  {b['date'][-5:]}"])
        for title, stems in VERSIONS:
            tl.card(title, None, seconds=2.5, big=False)
            for s in stems:
                tl.movie(clip(s), f"{title}  ·  {s.replace('_', ' ')}")
        tl.end_chapter()
    # credits
    tl.card("F-35I  ADIR", "Code, renders and every saved version: github.com/Sharpen6/F-35I", seconds=6.0)
    tl.card("Credits", body=(
        "Photos: U.S. Air Force (public domain), IAF / Maj. Ofer (CC BY 4.0),\n"
        "IDF Spokesperson's Unit (CC BY-SA 3.0), 3-view drawing from Wikimedia Commons\n"
        "Sky: Poly Haven, Kloofendal 48d Partly Cloudy (CC0)\n"
        "Modelled, rigged, animated and rendered in Blender 5.1"), seconds=10.0)
    return tl.f - 1


def timestamp(frame):
    s = int((frame - 1) / FPS)
    return f"{s // 60:02d}:{s % 60:02d}"


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--res", default="1920x1080")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--out", default="")
    ap.add_argument("--only", default="")
    ap.add_argument("--root", default="")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--stills", default="")
    ap.add_argument("--frames", default="")
    ap.add_argument("--crf", default="HIGH", help="H.264 quality: HIGH, MEDIUM, LOW, VERYLOW, ...")
    args = ap.parse_args(argv)
    if args.root:
        DATA[0] = os.path.abspath(args.root)
    out = args.out or R("renders", "video", "F-35I_Adir_making_of.mp4")
    if not os.path.isabs(out):
        out = R(out)
    res = tuple(int(v) for v in args.res.lower().split("x"))
    only = {int(v) for v in args.only.split(",") if v}

    sc = bpy.context.scene
    sc.name = "MakingOf"
    r = sc.render
    r.resolution_x, r.resolution_y = res
    r.resolution_percentage = int(round(args.scale * 100))
    r.fps, r.fps_base = FPS, 1.0
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    tl = Timeline(sc, res)
    end = build(tl, only)
    sc.frame_start, sc.frame_end = 1, end
    chap = [(n, t, timestamp(f)) for n, t, f, _ in tl.chapters]
    print("VIDEO chapters", chap, flush=True)
    print("VIDEO length", end, "frames", round(end / FPS / 60, 2), "min", flush=True)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(os.path.join(os.path.dirname(out), "chapters.txt"), "w", encoding="utf-8") as f:
        f.write("00:00 F-35I Adir: the making-of\n")
        for n, t, ts in chap:
            f.write(f"{ts} {n}. {t}\n")
    if args.dry:
        return
    r.use_sequencer = True
    if args.stills:
        chk = R("renders", "video", "check")
        os.makedirs(chk, exist_ok=True)
        r.image_settings.file_format = 'PNG'
        for v in args.stills.split(","):
            fr = int(v)
            sc.frame_set(fr)
            r.filepath = os.path.join(chk, f"frame_{fr:05d}.png")
            bpy.ops.render.render(write_still=True, scene=sc.name)
            print("VIDEO still", r.filepath, flush=True)
        return
    if args.frames:
        a, b = (int(v) for v in args.frames.split("-"))
        sc.frame_start, sc.frame_end = a, min(b, end)
    if hasattr(r.image_settings, "media_type"):
        r.image_settings.media_type = 'VIDEO'
    r.image_settings.file_format = 'FFMPEG'
    r.ffmpeg.format = 'MPEG4'
    r.ffmpeg.codec = 'H264'
    r.ffmpeg.constant_rate_factor = args.crf
    r.ffmpeg.ffmpeg_preset = 'GOOD'
    r.ffmpeg.gopsize = FPS * 2
    r.ffmpeg.audio_codec = 'NONE'
    r.filepath = out
    bpy.ops.render.render(animation=True, scene=sc.name)
    print("VIDEO done", out, flush=True)


if __name__ == "__main__":
    main()
