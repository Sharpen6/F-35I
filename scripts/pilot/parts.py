"""All of the pilot's meshes for one pose, as plain numpy data (no Blender): the suit body,
gloves, boots and soles, the helmet and the gear.  build_pilot turns these into Blender objects;
preview renders them in software.

Each part: dict(name, v (N x 3), q (M x 4 quads), mat (materials key), bone (rigid parent bone, or
None for the skinned body)), optionally
    mats  list of materials keys, with mi (M,) the material slot of each face (mats[0] == mat)
    uv    (N x 2) texture coordinates per vertex (patches, the kneeboard screen)
"""
import time

import numpy as np

from . import body, gear, helmet, limbs, sdf


def vertex_normals(v, q):
    tri = np.concatenate([q[:, [0, 1, 2]], q[:, [0, 2, 3]]]) if q.shape[1] == 4 else q
    n = np.cross(v[tri[:, 1]] - v[tri[:, 0]], v[tri[:, 2]] - v[tri[:, 0]])
    vn = np.zeros_like(v)
    for k in range(3):
        np.add.at(vn, tri[:, k], n)
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


def suit_regions(j, F, v, q):
    """Face slots of the suit mesh: 0 flight suit, 1 skin (neck and head above the collar),
    2 the white T-shirt showing in the open collar."""
    c = v[q].mean(1) - j["neck"]
    t = c @ F["neck"][1]
    front = c @ F["neck"][2]
    side = np.abs(c @ F["neck"][0])
    mi = np.zeros(len(q), np.int32)
    mi[(t > -0.030) & (t < 0.028) & (front > 0.035) & (side < 0.045)] = 2
    mi[t >= 0.040] = 1
    return mi


def field_of(solids, h, pad=0.02):
    lo = np.min([s.aabb()[0] for s, _k in solids], axis=0) - pad
    hi = np.max([s.aabb()[1] for s, _k in solids], axis=0) + pad
    f = sdf.Field(lo, hi, h)
    for s, k in solids:
        f.add(s, k)
    return f


def build(j, F, h=0.004, hand_pose=None, sole_n=None, timings=None, only=None, cable_end=None):
    """Meshes for joints j / frames F.  sole_n: {"L": normal, "R": normal} of the surfaces the
    boots stand on (default: the floor)."""
    hand_pose = hand_pose or {}
    sole_n = sole_n or {}
    tm = timings if timings is not None else {}
    parts = []

    def want(name):
        return only is None or any(name.startswith(o) for o in only)

    t = time.time()
    if want("Suit"):
        f = body.body_field(j, F, h=h)
        v, q = f.mesh(smooth=4)
        parts.append(dict(name="Suit", v=v, q=q, mat="suit", bone=None,
                          mats=["suit", "skin", "tshirt"], mi=suit_regions(j, F, v, q)))
        tm["suit"] = round(time.time() - t, 2)
    t = time.time()
    for side in ("L", "R"):
        if want("Glove"):
            pose = hand_pose.get(side, "relaxed")
            f = limbs.hand_field(j[f"wrist.{side}"], F[f"hand.{side}"], side, pose)
            v, q = f.mesh(smooth=3)
            lea = limbs.glove_leather(j[f"wrist.{side}"], F[f"hand.{side}"], side, pose, v, vertex_normals(v, q))
            mi = (lea[q].sum(1) >= 2).astype(np.int32)
            parts.append(dict(name=f"Glove_{side}", v=v, q=q, mat="glove", bone=f"hand.{side}",
                              mats=["glove", "glove_leather"], mi=mi))
        if want("Boot") or want("Sole"):
            sol, fr = limbs.boot_solids(j, F, side, sole_n.get(side))
            v, q = field_of(sol, 0.0025).mesh(smooth=3)
            parts.append(dict(name=f"Boot_{side}", v=v, q=q, mat="boot", bone=f"foot.{side}"))
            v, q = field_of(limbs.sole_solids(fr), 0.002).mesh(smooth=2)
            parts.append(dict(name=f"Sole_{side}", v=v, q=q, mat="sole", bone=f"foot.{side}"))
            # laces criss-crossing the instep, through metal eyelets (second material slot)
            laces, eyelets = limbs.boot_laces(j, F, side, sole_n.get(side))
            v, q = field_of([(s_, 0.0) for s_ in laces + eyelets], 0.0011, pad=0.006).mesh(smooth=1)
            c = v[q].mean(1)
            dl = np.min([s_.dist(c) for s_ in laces], axis=0)
            de = np.min([s_.dist(c) for s_ in eyelets], axis=0)
            parts.append(dict(name=f"Boot_Laces_{side}", v=v, q=q, mat="webbing_black", bone=f"foot.{side}",
                              mats=["webbing_black", "dark_metal"], mi=(de < dl).astype(np.int32)))
    tm["hands_boots"] = round(time.time() - t, 2)
    t = time.time()
    if want("Helmet") or want("Mask"):
        parts += [p for p in helmet.parts(j, F) if want(p["name"].split("_")[0])]
        tm["helmet"] = round(time.time() - t, 2)
    t = time.time()
    if want("Gear"):
        parts += gear.parts(j, F, cable_end=cable_end)
        tm["gear"] = round(time.time() - t, 2)
    return parts


# ------------------------------------------------------------------------------- cache
def save(path, parts, meta=None):
    """Write parts to a compressed .npz (arrays per part plus a JSON index)."""
    import json
    import os
    arrays, index = {}, []
    for i, p in enumerate(parts):
        rec = {k: p[k] for k in ("name", "mat", "bone")}
        if "mats" in p:
            rec["mats"] = list(p["mats"])
        for k in ("v", "q", "mi", "uv"):
            if k in p:
                arrays[f"{i}_{k}"] = np.asarray(p[k], np.float32 if k in ("v", "uv") else np.int32)
        index.append(rec)
    arrays["index"] = np.array(json.dumps({"parts": index, "meta": meta or {}}))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp.npz"
    np.savez_compressed(tmp, **arrays)
    os.replace(tmp, path)
    return path


def load(path):
    """Parts and meta written by save()."""
    import json
    z = np.load(path)
    info = json.loads(str(z["index"]))
    parts = []
    for i, rec in enumerate(info["parts"]):
        p = dict(rec)
        for k in ("v", "q", "mi", "uv"):
            key = f"{i}_{k}"
            if key in z.files:
                p[k] = z[key].astype(np.float64) if k in ("v", "uv") else z[key]
        parts.append(p)
    return parts, info["meta"]


def source_hash(extra=""):
    """Hash of the pilot package's sources (+ extra): a cache key that changes with the code."""
    import hashlib
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    h = hashlib.sha1(extra.encode())
    for f in sorted(os.listdir(here)):
        if f.endswith(".py") and f not in ("preview.py", "preview_build.py", "run_studio.py", "studio.py",
                                           "build_pilot.py", "materials.py", "blender_io.py"):
            with open(os.path.join(here, f), "rb") as fh:
                h.update(fh.read())
    return h.hexdigest()[:16]


def cached_build(path, key, **kw):
    """build(**kw) through an .npz cache at path, rebuilt when `key` differs."""
    import os
    if os.path.exists(path):
        try:
            parts, meta = load(path)
            if meta.get("key") == key:
                return parts, True
        except Exception:
            pass
    parts = build(**kw)
    save(path, parts, {"key": key})
    return parts, False
