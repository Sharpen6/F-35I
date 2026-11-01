"""Render pages of the model's own source code (and two result tables from the damage report) as
1920x1080 images for the making-of video.

    python3 scripts/video/code_pages.py   # -> renders/video/code/NN_<slug>.png, renders/video/tables/
Needs Pillow and Pygments (plain Python, not Blender). Each page is one excerpt, found by an
anchor line so the excerpts follow the code when it changes.
"""
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont
from pygments.lexers import PythonLexer
from pygments.token import Token

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "renders", "video", "code")

# (file, anchor regex, lines, title)
PAGES = [
    ("scripts/f35/fuselage.py", r"^FORE = Table\(", 25,
     "The forebody is a loft through measured cross-sections, one row per station"),
    ("scripts/f35/fuselage.py", r"^BUMP_DEPTH = ", 22,
     "The DSI bump: a smooth swelling under the chine instead of an inlet splitter plate"),
    ("scripts/f35/nozzle.py", r"^PETALS = ", 16,
     "The nozzle: 15 overlapping petals that open up for the afterburner"),
    ("scripts/f35/gear.py", r"^def solve_trunnion", 26,
     "Landing gear: the retraction axis is solved from the down and stowed poses"),
    ("scripts/f35/rig.py", r"^CONTROLS = \[", 20,
     "One rig: every control, door, switch and the pilot's head is a property"),
    ("scripts/f35/anim.py", r"^def start_up", 21,
     "Start-up: the pilot looks at each console, then flips its switches"),
    ("scripts/f35/pilot.py", r"^def _skin_to_bones", 23,
     "Skinning the pilot: weights from the distance to each bone, limited to its own limb"),
    ("scripts/f35/pilot.py", r"^def _fit_pole_angle", 22,
     "The arm IK pole angle is fitted numerically so the sleeves do not twist"),
    ("scripts/f35/destruct.py", r"^def _visible_expr", 20,
     "Damage: drivers show the intact part, the burnt stub or the flying debris"),
    ("scripts/damage/f35_damage.py", r"^def thrust\(", 32,
     "The damage simulator: thrust and drag decide what the jet can still do after a hit"),
    ("scripts/render/clips.py", r"^    tc = N.new\(\"ShaderNodeTexCoord\"\)", 19,
     "The hit fireball: a volume shader driven by 4D noise"),
]

W, H = 1920, 1080
BG = (13, 15, 19)
PANEL = (20, 23, 29)
FG = (220, 223, 228)
MUTED = (112, 120, 132)
GUTTER = (72, 78, 88)
ACCENT = (232, 182, 77)
COLORS = [
    (Token.Comment, (112, 122, 136)),
    (Token.Literal.String, (152, 195, 121)),
    (Token.Literal.Number, (209, 154, 102)),
    (Token.Keyword.Constant, (209, 154, 102)),
    (Token.Keyword, (198, 120, 221)),
    (Token.Operator.Word, (198, 120, 221)),
    (Token.Name.Function, (97, 175, 239)),
    (Token.Name.Class, (229, 192, 123)),
    (Token.Name.Builtin, (86, 182, 194)),
    (Token.Name.Decorator, (229, 192, 123)),
    (Token.Operator, (171, 178, 191)),
    (Token.Punctuation, (171, 178, 191)),
]


def font(names, size):
    dirs = ["/usr/share/fonts/truetype/dejavu", "C:/Windows/Fonts", "/Library/Fonts"]
    for n in names:
        for d in dirs:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def color_of(tt):
    for t, c in COLORS:
        if tt in t:
            return c
    return FG


def excerpt(path, anchor, n):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        lines = f.read().split("\n")
    rx = re.compile(anchor)
    for i, l in enumerate(lines):
        if rx.search(l):
            if l.startswith("    "):            # an excerpt from inside a function: back up to its def
                j = i
                while j > 0 and not lines[j].startswith("def "):
                    j -= 1
                if i - j < 6:
                    i = j
            body = lines[i:i + n]
            while body and not body[-1].strip():
                body.pop()
            return i + 1, body
    raise ValueError(f"anchor {anchor!r} not found in {path}")


def render(k, path, anchor, n, title, total):
    first, body = excerpt(path, anchor, n)
    mono = font(["DejaVuSansMono.ttf", "consola.ttf", "Menlo.ttc"], 25)
    size = 40
    bold = font(["DejaVuSans-Bold.ttf", "segoeuib.ttf", "arialbd.ttf"], size)
    while bold.getlength(title) > W - 190 and size > 24:
        size -= 1
        bold = font(["DejaVuSans-Bold.ttf", "segoeuib.ttf", "arialbd.ttf"], size)
    small = font(["DejaVuSans.ttf", "segoeui.ttf", "arial.ttf"], 24)
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.text((90, 58), title, font=bold, fill=FG)
    d.text((92, 118), f"{path}   ·   lines {first}-{first + len(body) - 1}", font=small, fill=ACCENT)
    top, x0 = 180, 200
    lh = min(33, int((H - top - 110) / max(len(body), 1)))
    if lh < 33:
        mono = font(["DejaVuSansMono.ttf", "consola.ttf", "Menlo.ttc"], int(lh * 0.76))
    d.rounded_rectangle((70, top - 22, W - 70, top + lh * len(body) + 18), radius=14, fill=PANEL)
    cw = mono.getlength("M")
    maxc = int((W - 100 - x0) / cw)
    code = "\n".join(body) + "\n"
    y, col = top, 0
    for i in range(len(body)):
        num = str(first + i)
        d.text((x0 - 30 - mono.getlength(num), top + i * lh), num, font=mono, fill=GUTTER)
    for tt, val in PythonLexer(stripnl=False, ensurenl=False).get_tokens(code):
        parts = val.split("\n")
        for j, part in enumerate(parts):
            if j:
                y += lh
                col = 0
            if not part:
                continue
            room = maxc - col
            if room <= 0:
                continue
            if len(part) > room:
                part = part[:max(room - 1, 0)] + "…"
            d.text((x0 + col * cw, y), part, font=mono, fill=color_of(tt))
            col += len(part)
    d.text((92, H - 58), "github.com/Sharpen6/F-35I", font=small, fill=MUTED)
    d.text((W - 92 - small.getlength(f"{k} / {total}"), H - 58), f"{k} / {total}", font=small, fill=MUTED)
    slug = "_".join(re.findall(r"[a-z0-9]+", title.lower())[:4])
    out = os.path.join(OUT, f"{k:02d}_{slug}.png")
    im.save(out, optimize=True)
    return out


# ------------------------------------------------------------------ result tables (damage report)
TABLES = [  # (report section heading, columns to keep, title, subtitle)
    ("## 4. Damage scenarios", ["Scenario", "Thrust", "Max Mach 11 km", "g limit", "Min control speed",
                                "Fuel / endurance"],
     "What the jet can still do after a hit", "docs/damage_model.md  ·  Mach 0.8 at 6 km unless noted"),
    ("**Outer left wing panel missing**", None,
     "Flying on with the outer left wing panel shot off",
     "docs/damage_model.md  ·  the simulator trims the jet at each airspeed (sea level)"),
]


def md_table(heading):
    with open(os.path.join(ROOT, "docs", "damage_model.md"), encoding="utf-8") as f:
        lines = f.read().split("\n")
    i = next(k for k, l in enumerate(lines) if l.strip().startswith(heading))
    rows = []
    for l in lines[i + 1:]:
        if l.startswith("|"):
            cells = [c.strip().strip("`") for c in l.strip().strip("|").split("|")]
            if not all(set(c) <= set("-: ") for c in cells):
                rows.append(cells)
        elif rows:
            break
    return rows[0], rows[1:]


def render_table(k, heading, keep, title, subtitle, total):
    head, rows = md_table(heading)
    idx = [head.index(c) for c in keep] if keep else list(range(len(head)))
    head = [head[i] for i in idx]
    rows = [[r[i] for i in idx] for r in rows]
    bold = font(["DejaVuSans-Bold.ttf", "segoeuib.ttf", "arialbd.ttf"], 40)
    small = font(["DejaVuSans.ttf", "segoeui.ttf", "arial.ttf"], 24)
    n = len(rows) + 1
    lh = min(54, int((H - 185 - 105) / n))
    fs = min(26, int(lh * 0.56))
    cell = font(["DejaVuSans.ttf", "segoeui.ttf", "arial.ttf"], fs)
    cellb = font(["DejaVuSans-Bold.ttf", "segoeuib.ttf", "arialbd.ttf"], fs)
    widths = [max(cellb.getlength(head[j]), *(cell.getlength(r[j]) for r in rows)) + 36 for j in range(len(head))]
    scale = min(1.0, (W - 180) / sum(widths))
    if scale < 1.0:
        fs = int(fs * scale)
        cell = font(["DejaVuSans.ttf", "segoeui.ttf", "arial.ttf"], fs)
        cellb = font(["DejaVuSans-Bold.ttf", "segoeuib.ttf", "arialbd.ttf"], fs)
        widths = [w * scale for w in widths]
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.text((90, 58), title, font=bold, fill=FG)
    d.text((92, 118), subtitle, font=small, fill=ACCENT)
    x0 = (W - sum(widths)) / 2
    y = 185
    for r, cells in enumerate([head] + rows):
        if r == 0:
            d.rectangle((x0 - 10, y, x0 + sum(widths) + 10, y + lh), fill=(36, 41, 50))
        elif r % 2 == 0:
            d.rectangle((x0 - 10, y, x0 + sum(widths) + 10, y + lh), fill=PANEL)
        x = x0
        for j, c in enumerate(cells):
            f = cellb if r == 0 else cell
            col = FG if r == 0 else ((232, 182, 77) if j == 0 else (200, 204, 210))
            d.text((x + 8, y + (lh - fs) / 2 - 2), c, font=f, fill=col)
            x += widths[j]
        y += lh
    d.text((92, H - 58), "github.com/Sharpen6/F-35I", font=small, fill=MUTED)
    out = os.path.join(TABLE_OUT, f"{k:02d}_" + "_".join(re.findall(r"[a-z0-9]+", title.lower())[:4]) + ".png")
    im.save(out, optimize=True)
    return out


TABLE_OUT = os.path.join(ROOT, "renders", "video", "tables")


def main():
    for folder in (OUT, TABLE_OUT):
        os.makedirs(folder, exist_ok=True)
        for old in os.listdir(folder):
            if old.endswith(".png"):
                os.remove(os.path.join(folder, old))
    for k, (path, anchor, n, title) in enumerate(PAGES, 1):
        print(render(k, path, anchor, n, title, len(PAGES)))
    for k, (heading, keep, title, sub) in enumerate(TABLES, 1):
        print(render_table(k, heading, keep, title, sub, len(TABLES)))


if __name__ == "__main__":
    sys.exit(main())
