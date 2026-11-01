"""Compose a 1920x1080 progress still from four captioned panels (2 x 2), as in renders/progress.

    python3 scripts/tools/progress_grid.py spec.json out.jpg

spec.json: a list of four panels, each {"img": path, "box": [x0, y0, x1, y1] (optional crop, in
the image's own pixels after an optional "resize": [w, h]), "caption": text}.  A panel may
instead be {"split": [panel, panel], "caption": text}: two crops side by side.  Each crop is
scaled to cover its cell and centred (no distortion)."""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
CW, CH = W // 2, H // 2
BAR = 40
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def _crop(p, w, h):
    im = Image.open(p["img"]).convert("RGB")
    if p.get("resize"):
        im = im.resize(tuple(p["resize"]), Image.LANCZOS)
    if p.get("box"):
        im = im.crop(tuple(p["box"]))
    k = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * k)), max(h, round(im.height * k))), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def cell(p):
    if "split" in p:
        a, b = p["split"]
        out = Image.new("RGB", (CW, CH), "black")
        out.paste(_crop(a, CW // 2 - 2, CH), (0, 0))
        out.paste(_crop(b, CW // 2 - 2, CH), (CW // 2 + 2, 0))
        return out
    return _crop(p, CW, CH)


def compose(panels, out):
    canvas = Image.new("RGB", (W, H), "black")
    font = ImageFont.truetype(FONT, 24)
    for i, p in enumerate(panels):
        c = cell(p)
        d = ImageDraw.Draw(c)
        d.rectangle([0, CH - BAR, CW, CH], fill=(0, 0, 0))
        d.text((12, CH - BAR + 7), p.get("caption", ""), font=font, fill=(240, 240, 240))
        canvas.paste(c, ((i % 2) * CW, (i // 2) * CH))
    canvas.save(out, quality=92)
    return out


if __name__ == "__main__":
    compose(json.load(open(sys.argv[1])), sys.argv[2])
