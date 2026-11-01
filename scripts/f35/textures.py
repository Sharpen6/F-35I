"""Tiny numpy rasteriser used to paint cockpit display pages and decals
inside Blender (no PIL dependency, so it also runs in a stock Blender)."""
import math
import numpy as np
import bpy

# 5x7 bitmap font (subset)
_FONT = {
    'A': ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    'B': ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    'C': ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    'D': ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    'E': ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    'F': ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    'G': ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
    'H': ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    'I': ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    'J': ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
    'K': ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    'L': ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    'M': ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    'N': ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
    'O': ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    'P': ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    'Q': ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    'R': ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    'S': ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    'T': ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    'U': ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    'V': ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    'W': ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
    'X': ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    'Y': ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    'Z': ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
    '0': ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    '1': ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    '2': ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    '3': ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    '4': ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    '5': ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    '6': ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    '7': ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    '8': ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    '9': ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    '.': ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
    '-': ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    '/': ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
    ':': ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
    ' ': ["00000"] * 7,
}


class Canvas:
    def __init__(self, w, h, bg=(0.0, 0.0, 0.0)):
        self.w, self.h = w, h
        self.px = np.zeros((h, w, 4), dtype=np.float32)
        self.px[:, :, :3] = bg
        self.px[:, :, 3] = 1.0
        yy, xx = np.mgrid[0:h, 0:w]
        self.xx, self.yy = xx, yy

    def rect(self, x0, y0, x1, y1, col, fill=True, t=2):
        x0, x1 = sorted((int(x0), int(x1)))
        y0, y1 = sorted((int(y0), int(y1)))
        if fill:
            self.px[max(0, y0):min(self.h, y1), max(0, x0):min(self.w, x1), :3] = col
        else:
            self.rect(x0, y0, x1, y0 + t, col)
            self.rect(x0, y1 - t, x1, y1, col)
            self.rect(x0, y0, x0 + t, y1, col)
            self.rect(x1 - t, y0, x1, y1, col)

    def circle(self, cx, cy, r, col, t=None):
        d = np.sqrt((self.xx - cx) ** 2 + (self.yy - cy) ** 2)
        m = d <= r if t is None else (np.abs(d - r) <= t / 2)
        self.px[m, :3] = col

    def line(self, x0, y0, x1, y1, col, t=2):
        x0, y0, x1, y1 = map(float, (x0, y0, x1, y1))
        dx, dy = x1 - x0, y1 - y0
        L2 = dx * dx + dy * dy
        if L2 < 1e-9:
            return
        bx0, bx1 = int(max(0, min(x0, x1) - t)), int(min(self.w, max(x0, x1) + t + 1))
        by0, by1 = int(max(0, min(y0, y1) - t)), int(min(self.h, max(y0, y1) + t + 1))
        if bx1 <= bx0 or by1 <= by0:
            return
        xx = self.xx[by0:by1, bx0:bx1]
        yy = self.yy[by0:by1, bx0:bx1]
        u = np.clip(((xx - x0) * dx + (yy - y0) * dy) / L2, 0, 1)
        d = np.sqrt((xx - x0 - u * dx) ** 2 + (yy - y0 - u * dy) ** 2)
        sub = self.px[by0:by1, bx0:bx1]
        sub[d <= t / 2, :3] = col

    def blob(self, cx, cy, r, col, seed=0, lobes=5):
        ang = np.arctan2(self.yy - cy, self.xx - cx)
        rng = np.random.default_rng(seed)
        rr = np.full_like(ang, r, dtype=np.float32)
        for k in range(1, lobes + 1):
            rr += r * 0.18 / k * np.sin(k * ang + rng.uniform(0, 6.28))
        d = np.sqrt((self.xx - cx) ** 2 + (self.yy - cy) ** 2)
        self.px[d <= rr, :3] = col

    def text(self, x, y, s, col, scale=2):
        cx = int(x)
        for ch in s.upper():
            g = _FONT.get(ch, _FONT[' '])
            for row, bits in enumerate(g):
                for c, b in enumerate(bits):
                    if b == '1':
                        self.rect(cx + c * scale, y + row * scale,
                                  cx + (c + 1) * scale, y + (row + 1) * scale, col)
            cx += 6 * scale

    def to_image(self, name):
        img = bpy.data.images.get(name)
        if img is None or img.size[0] != self.w or img.size[1] != self.h:
            if img is not None:
                bpy.data.images.remove(img)
            img = bpy.data.images.new(name, self.w, self.h, alpha=True)
        # numpy rows are top->bottom, Blender pixels are bottom->top
        img.pixels.foreach_set(np.ascontiguousarray(self.px[::-1]).ravel())
        img.pack()
        return img


GRN = (0.25, 1.0, 0.35)
CYN = (0.2, 0.85, 1.0)
WHT = (0.95, 0.95, 0.95)
YEL = (1.0, 0.85, 0.1)
RED = (1.0, 0.15, 0.1)
MAG = (1.0, 0.3, 0.9)


def pcd_image(name="PCD_Display", w=1600, h=640):
    """Panoramic cockpit display: TSD map, FCR, ENG/FUEL + top info strip."""
    c = Canvas(w, h, (0.01, 0.012, 0.02))
    strip = 70
    # top strip
    c.rect(0, 0, w, strip, (0.02, 0.03, 0.05))
    c.text(20, 18, "CAS 452", GRN, 3)
    c.text(260, 18, "ALT 25000", GRN, 3)
    c.text(560, 18, "HDG 087", GRN, 3)
    c.text(820, 18, "M 0.92", GRN, 3)
    c.text(1040, 18, "G 1.0", GRN, 3)
    c.text(1240, 18, "FUEL 14.2", CYN, 3)
    c.line(0, strip, w, strip, (0.3, 0.3, 0.35), 2)
    c.line(w // 2, strip, w // 2, h, (0.25, 0.25, 0.3), 6)
    # ---- left portal: TSD map
    x0, x1, y0, y1 = 10, w // 2 - 10, strip + 10, h - 10
    c.rect(x0, y0, x1, y1, (0.05, 0.10, 0.22))       # sea
    rng = np.random.default_rng(7)
    for i in range(9):
        c.blob(rng.uniform(x0 + 300, x1), rng.uniform(y0, y1), rng.uniform(60, 140),
               (0.18 + rng.uniform(0, 0.08), 0.17 + rng.uniform(0, 0.06), 0.09), seed=i)
    c.rect(0, 0, x0, h, (0.01, 0.012, 0.02))
    c.rect(x1, 0, w // 2, h, (0.01, 0.012, 0.02))
    cx, cy = (x0 + x1) // 2, int(y0 + (y1 - y0) * 0.72)
    for r in (90, 180, 270):
        c.circle(cx, cy, r, (0.6, 0.6, 0.65), t=2)
    # route
    wps = [(cx, cy), (cx + 120, cy - 150), (cx + 60, cy - 330), (cx - 150, cy - 400)]
    for a, b in zip(wps[:-1], wps[1:]):
        c.line(a[0], a[1], b[0], b[1], WHT, 3)
    for p in wps[1:]:
        c.circle(p[0], p[1], 9, WHT, t=3)
    # threats / tracks
    c.circle(cx + 220, cy - 260, 60, RED, t=3)
    c.text(cx + 205, cy - 268, "SA", RED, 3)
    for (tx, ty) in ((cx - 90, cy - 300), (cx - 40, cy - 330)):
        c.line(tx - 12, ty + 10, tx, ty - 10, YEL, 3)
        c.line(tx, ty - 10, tx + 12, ty + 10, YEL, 3)
    for (tx, ty) in ((cx + 40, cy - 120), (cx + 70, cy - 110)):
        c.circle(tx, ty, 10, GRN, t=3)
    # ownship
    c.line(cx, cy - 22, cx, cy + 20, CYN, 4)
    c.line(cx - 22, cy, cx + 22, cy, CYN, 4)
    c.line(cx - 10, cy + 18, cx + 10, cy + 18, CYN, 4)
    c.text(x0 + 12, y0 + 10, "TSD 1", WHT, 3)
    c.text(x1 - 140, y0 + 10, "80 NM", WHT, 3)
    # ---- right portal top: FCR B-scope
    x0, x1, y0, y1 = w // 2 + 10, w - 10, strip + 10, strip + 10 + (h - strip) // 2 - 10
    c.rect(x0, y0, x1, y1, (0.0, 0.03, 0.01))
    for i in range(1, 4):
        c.line(x0 + (x1 - x0) * i // 4, y0, x0 + (x1 - x0) * i // 4, y1, (0.1, 0.3, 0.1), 1)
        c.line(x0, y0 + (y1 - y0) * i // 4, x1, y0 + (y1 - y0) * i // 4, (0.1, 0.3, 0.1), 1)
    for i in range(7):
        c.rect(x0 + rng.uniform(40, 700), y0 + rng.uniform(20, 230), x0 + rng.uniform(40, 700) + 14,
               y0 + rng.uniform(20, 230) + 8, GRN)
    c.text(x0 + 10, y0 + 8, "FCR  RWS  40", GRN, 3)
    # ---- right portal bottom: ENG / FUEL
    y0b = y1 + 20
    c.rect(x0, y0b, x1, h - 10, (0.015, 0.015, 0.03))
    c.text(x0 + 10, y0b + 8, "ENG", WHT, 3)
    for i, (lab, val, col) in enumerate((("RPM", 0.86, GRN), ("TET", 0.72, GRN),
                                         ("NOZ", 0.25, CYN), ("OIL", 0.55, GRN))):
        bx = x0 + 40 + i * 90
        c.rect(bx, y0b + 50, bx + 40, h - 50, (0.15, 0.15, 0.18), fill=False, t=2)
        top = int((h - 50) - ((h - 50) - (y0b + 50)) * val)
        c.rect(bx + 4, top, bx + 36, h - 52, col)
        c.text(bx - 2, h - 42, lab, WHT, 2)
    c.text(x0 + 420, y0b + 8, "FUEL", WHT, 3)
    for i, (lab, val) in enumerate((("F1", 0.8), ("F2", 0.7), ("F3", 0.9), ("F4", 0.6), ("F5", 0.75))):
        bx = x0 + 420 + i * 70
        c.rect(bx, y0b + 50, bx + 50, h - 50, (0.15, 0.15, 0.18), fill=False, t=2)
        top = int((h - 50) - ((h - 50) - (y0b + 50)) * val)
        c.rect(bx + 4, top, bx + 46, h - 52, CYN)
        c.text(bx + 4, h - 42, lab, WHT, 2)
    return c.to_image(name)


def roundel_image(name="IAF_Roundel", size=512, star=None,
                  disc=(0.86, 0.88, 0.90)):
    """Israeli Air Force roundel (low-visibility style seen on F-35I photos):
    light disc with a Star of David (two overlapping triangles).  star=None leaves the star
    transparent, so the skin (with its coat and sheen) shows through, as on the real jets
    where the star is the airframe grey."""
    c = Canvas(size, size, (0, 0, 0))
    c.px[:, :, 3] = 0.0
    cx = cy = size / 2
    d = np.sqrt((c.xx - cx) ** 2 + (c.yy - cy) ** 2)
    disc_m = d <= size * 0.48
    c.px[disc_m, :3] = disc
    c.px[disc_m, 3] = 1.0
    # star of David: union of two equilateral triangles
    R = size * 0.36

    def tri(rot):
        pts = [(cx + R * math.sin(rot + k * 2 * math.pi / 3),
                cy - R * math.cos(rot + k * 2 * math.pi / 3)) for k in range(3)]
        m = np.ones_like(d, dtype=bool)
        for i in range(3):
            (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % 3]
            cross = (x1 - x0) * (c.yy - y0) - (y1 - y0) * (c.xx - x0)
            m &= cross >= 0
        return m
    star_m = tri(0.0) | tri(math.pi)
    if star is None:
        c.px[star_m, :3] = disc          # keep the colour under the soft alpha edge
        c.px[star_m, 3] = 0.0
    else:
        c.px[star_m, :3] = star
    return c.to_image(name)


def number_image(name, text, w=512, h=192, col=(0.80, 0.82, 0.84)):
    c = Canvas(w, h, (0, 0, 0))
    c.px[:, :, 3] = 0.0
    scale = int(h / 9)
    tw = len(text) * 6 * scale
    x = (w - tw) // 2
    for ch in text:
        g = _FONT.get(ch, _FONT[' '])
        for row, bits in enumerate(g):
            for cc, b in enumerate(bits):
                if b == '1':
                    y0 = h // 2 - 7 * scale // 2 + row * scale
                    c.px[y0:y0 + scale, x + cc * scale:x + (cc + 1) * scale, :3] = col
                    c.px[y0:y0 + scale, x + cc * scale:x + (cc + 1) * scale, 3] = 1.0
        x += 6 * scale
    return c.to_image(name)
