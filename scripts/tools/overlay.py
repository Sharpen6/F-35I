"""Draw the edges of a photo-matched Workbench render over the reference photo.

    python3 overlay.py EDGES.png PHOTO.jpg OUT.jpg [crop x0 y0 x1 y1 (in render pixels)]

EDGES.png comes from review.match_edges() (transparent background); its
silhouette is drawn in cyan, internal creases / object outlines in red.
Needs numpy + Pillow (run outside Blender).
"""
import sys

import numpy as np
from PIL import Image


def edge_map(rgba):
    a = rgba[..., 3].astype(np.float32) / 255.0
    lum = rgba[..., :3].astype(np.float32).mean(axis=2) / 255.0 * a

    def grad(img):
        gx = np.zeros_like(img)
        gy = np.zeros_like(img)
        gx[:, 1:-1] = img[:, 2:] - img[:, :-2]
        gy[1:-1, :] = img[2:, :] - img[:-2, :]
        return np.hypot(gx, gy)

    sil = grad(a) > 0.35
    inner = (grad(lum) > 0.10) & ~sil & (a > 0.5)
    return sil, inner


def dilate(m, r=1):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


def main(edges, photo, out, crop=None):
    e = np.asarray(Image.open(edges).convert("RGBA"))
    h, w = e.shape[:2]
    p = Image.open(photo).convert("RGB").resize((w, h), Image.LANCZOS)
    p = np.asarray(p).astype(np.float32) * 0.85
    sil, inner = edge_map(e)
    sil = dilate(sil, 1)
    p[inner] = p[inner] * 0.3 + np.array([255, 40, 40]) * 0.7
    p[sil] = np.array([0, 255, 255])
    img = Image.fromarray(p.clip(0, 255).astype(np.uint8))
    if crop:
        img = img.crop(crop)
    img.save(out, quality=90)
    return out


if __name__ == "__main__":
    a = sys.argv[1:]
    crop = tuple(int(v) for v in a[3:7]) if len(a) >= 7 else None
    print(main(a[0], a[1], a[2], crop))
