"""Quick software previews of the pilot's meshes outside Blender (numpy + Pillow).

The pilot's geometry is pure numpy (sdf, skeleton, body, limbs, gear ...), so shapes can be
checked on any machine without a GPU: build the meshes, rasterise them with a z-buffer and simple
studio shading, and lay several views out on one sheet.

    python3 -m pilot.preview out.png                 # from <repo>/scripts
"""
import math
import sys

import numpy as np

# name: (camera location, look-at target, lens mm)  -- same layout as studio.VIEWS
VIEWS = {
    "front34": ((-1.55, -3.55, 1.25), (0.0, 0.0, 0.95), 70),
    "front": ((0.0, -4.2, 1.05), (0.0, 0.0, 0.95), 70),
    "side": ((-4.2, 0.0, 1.05), (0.0, 0.0, 0.95), 70),
    "back": ((0.0, 4.2, 1.05), (0.0, 0.0, 0.95), 70),
    "back34": ((1.6, 3.5, 1.30), (0.0, 0.0, 0.95), 70),
    "head34": ((-0.55, -0.95, 1.78), (0.0, 0.0, 1.66), 85),
    "head_front": ((0.0, -1.1, 1.70), (0.0, 0.0, 1.66), 85),
    "head_side": ((-1.05, -0.05, 1.70), (0.0, 0.0, 1.66), 85),
    "head_back": ((0.45, 0.95, 1.85), (0.0, 0.0, 1.66), 85),
    "torso": ((-0.65, -1.45, 1.45), (0.0, 0.0, 1.20), 70),
    "legs": ((-0.8, -1.6, 0.65), (0.0, 0.0, 0.50), 60),
    "feet": ((-0.55, -0.75, 0.30), (0.0, -0.05, 0.08), 60),
    "feet_side": ((-0.95, -0.05, 0.12), (0.0, -0.05, 0.08), 60),
    "hands": ((-0.75, -0.95, 0.95), (0.18, 0.0, 0.80), 85),
}


def camera(loc, tgt, lens, res, sensor=36.0):
    loc, tgt = np.asarray(loc, float), np.asarray(tgt, float)
    fwd = tgt - loc
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0.0, 0.0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    w, h = res
    f = lens / sensor * max(w, h)          # Blender: sensor fit AUTO -> the larger side
    return dict(loc=loc, fwd=fwd, right=right, up=up, f=f, w=w, h=h)


def project(cam, P):
    q = P - cam["loc"]
    z = q @ cam["fwd"]
    x = q @ cam["right"]
    y = q @ cam["up"]
    zs = np.maximum(z, 1e-6)
    px = cam["w"] * 0.5 + cam["f"] * x / zs
    py = cam["h"] * 0.5 - cam["f"] * y / zs
    return px, py, z


def vertex_normals(v, faces):
    tri = faces if faces.shape[1] == 3 else np.concatenate([faces[:, [0, 1, 2]], faces[:, [0, 2, 3]]])
    n = np.cross(v[tri[:, 1]] - v[tri[:, 0]], v[tri[:, 2]] - v[tri[:, 0]])
    vn = np.zeros_like(v)
    for k in range(3):
        np.add.at(vn, tri[:, k], n)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    return vn


def render(objects, view, res=(450, 600), bg=(0.16, 0.165, 0.17)):
    """objects: list of (verts, faces, rgb).  Returns an HxWx3 float image."""
    loc, tgt, lens = VIEWS[view] if isinstance(view, str) else view
    cam = camera(loc, tgt, lens, res)
    W, H = res
    zbuf = np.full(W * H, np.inf)
    nbuf = np.zeros((W * H, 3))
    cbuf = np.zeros((W * H, 3))
    pbuf = np.zeros((W * H, 3))
    for v, faces, rgb in objects:
        if len(faces) == 0:
            continue
        faces = np.asarray(faces)
        tri = faces if faces.shape[1] == 3 else np.concatenate([faces[:, [0, 1, 2]], faces[:, [0, 2, 3]]])
        vn = vertex_normals(v, faces)
        px, py, pz = project(cam, v)
        X, Y, Z = px[tri], py[tri], pz[tri]
        ok = (Z > 0.05).all(1)
        X, Y, Z, T = X[ok], Y[ok], Z[ok], tri[ok]
        x0 = np.floor(X.min(1)).astype(int)
        y0 = np.floor(Y.min(1)).astype(int)
        x1 = np.ceil(X.max(1)).astype(int)
        y1 = np.ceil(Y.max(1)).astype(int)
        size = np.maximum(x1 - x0, y1 - y0) + 1
        for S in (3, 6, 12, 24, 48, 96):
            sel = size <= S if S == 3 else (size <= S) & (size > S // 2)
            if S == 96:
                sel = size > 24
            if not sel.any():
                continue
            ii = np.nonzero(sel)[0]
            for chunk in np.array_split(ii, max(1, len(ii) * S * S // 4_000_000 + 1)):
                gx = x0[chunk, None, None] + np.arange(S)[None, :, None]
                gy = y0[chunk, None, None] + np.arange(S)[None, None, :]
                cx, cy = gx + 0.5, gy + 0.5
                ax, ay = X[chunk, 0, None, None], Y[chunk, 0, None, None]
                bx, by = X[chunk, 1, None, None], Y[chunk, 1, None, None]
                qx, qy = X[chunk, 2, None, None], Y[chunk, 2, None, None]
                den = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy)
                den = np.where(np.abs(den) < 1e-12, 1e-12, den)
                l0 = ((by - qy) * (cx - qx) + (qx - bx) * (cy - qy)) / den
                l1 = ((qy - ay) * (cx - qx) + (ax - qx) * (cy - qy)) / den
                l2 = 1.0 - l0 - l1
                inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6) & (gx >= 0) & (gx < W) & (gy >= 0) & (gy < H)
                if not inside.any():
                    continue
                t_idx, a_idx, b_idx = np.nonzero(inside)
                L0, L1, L2 = l0[inside], l1[inside], l2[inside]
                tc = chunk[t_idx]
                # perspective-correct depth
                iz = L0 / Z[tc, 0] + L1 / Z[tc, 1] + L2 / Z[tc, 2]
                depth = 1.0 / iz
                pix = gy[t_idx, 0, b_idx] * W + gx[t_idx, a_idx, 0]
                order = np.lexsort((depth, pix))
                pix_o = pix[order]
                first = np.r_[True, pix_o[1:] != pix_o[:-1]]
                o = order[first]
                p, dpt = pix[o], depth[o]
                win = dpt < zbuf[p]
                p, o = p[win], o[win]
                zbuf[p] = depth[o]
                tv = T[tc[o]]
                w0 = (L0[o] / Z[tc[o], 0]) / iz[o]
                w1 = (L1[o] / Z[tc[o], 1]) / iz[o]
                w2 = (L2[o] / Z[tc[o], 2]) / iz[o]
                nrm = vn[tv[:, 0]] * w0[:, None] + vn[tv[:, 1]] * w1[:, None] + vn[tv[:, 2]] * w2[:, None]
                pos = v[tv[:, 0]] * w0[:, None] + v[tv[:, 1]] * w1[:, None] + v[tv[:, 2]] * w2[:, None]
                nbuf[p] = nrm
                pbuf[p] = pos
                cbuf[p] = rgb
    hit = np.isfinite(zbuf)
    img = np.tile(np.asarray(bg, float), (W * H, 1))
    n = nbuf[hit]
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    view_dir = cam["loc"][None] - pbuf[hit]
    view_dir /= np.linalg.norm(view_dir, axis=1, keepdims=True)
    n = np.where(((n * view_dir).sum(1) < 0)[:, None], -n, n)
    key = np.array([-2.2, -2.4, 3.0]) - np.array([0, 0, 1.0])
    key /= np.linalg.norm(key)
    fill = np.array([2.6, -2.0, 0.6])
    fill /= np.linalg.norm(fill)
    rim = np.array([1.2, 2.4, 1.6])
    rim /= np.linalg.norm(rim)
    lk = np.clip(n @ key, 0, 1)
    lf = np.clip(n @ fill, 0, 1)
    lr = np.clip(n @ rim, 0, 1) ** 2
    sky = 0.5 + 0.5 * n[:, 2]
    hvec = key[None] + view_dir
    hvec /= np.linalg.norm(hvec, axis=1, keepdims=True)
    spec = np.clip((n * hvec).sum(1), 0, 1) ** 40
    base = cbuf[hit]
    col = base * (0.75 * lk + 0.30 * lf + 0.22 * sky + 0.10)[:, None] + 0.35 * lr[:, None] * base + 0.08 * spec[:, None]
    img[hit] = col
    img = img.reshape(H, W, 3)
    img = np.clip(img, 0, 1) ** (1 / 2.2)
    return img


def sheet(objects, views, res=(450, 600), labels=True):
    from PIL import Image, ImageDraw
    ims = []
    for vw in views:
        im = Image.fromarray((render(objects, vw, res) * 255).astype(np.uint8))
        if labels:
            ImageDraw.Draw(im).text((6, 4), vw if isinstance(vw, str) else "view", fill=(230, 230, 230))
        ims.append(im)
    out = Image.new("RGB", (sum(i.width for i in ims), max(i.height for i in ims)))
    x = 0
    for im in ims:
        out.paste(im, (x, 0))
        x += im.width
    return out


if __name__ == "__main__":
    from pilot import preview_build
    objs = preview_build.standing_objects()
    sheet(objs, ["front34", "side", "back34"]).save(sys.argv[1] if len(sys.argv) > 1 else "/tmp/pilot_preview.png")
