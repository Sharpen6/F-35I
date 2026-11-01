"""Materials for the glTF export.

Blender's exporter understands a Principled BSDF with constant inputs or image textures.  The
model's procedural materials (noise mottling, ramps, checker weaves, attribute-driven emission)
are reduced here to clean constant PBR materials with the same average look; image textures
(decals, the PCD page, pilot patches) are kept.  The skin, inlet and nozzle are baked (bake.py)
and already image based.  Lights keep their names (F35_nav_red, F35_beacon, ...) so the app can
switch them; their emission is exported at strength 1 and scaled at run time.
"""
import bpy

from common import log

# switchable lights (f35/materials.py SWITCHABLE): base, emission colour, roughness
LIGHTS = {
    "F35_landing_light": ((0.85, 0.85, 0.82), (1.0, 0.96, 0.88), 0.08),
    "F35_nav_red": ((0.45, 0.02, 0.02), (1.0, 0.03, 0.02), 0.08),
    "F35_nav_green": ((0.02, 0.40, 0.08), (0.05, 1.0, 0.25), 0.08),
    "F35_nav_white": ((0.80, 0.80, 0.80), (1.0, 1.0, 0.97), 0.08),
    "F35_formation": ((0.20, 0.27, 0.23), (0.55, 1.0, 0.35), 0.60),
    "F35_beacon": ((0.035, 0.035, 0.04), (1.0, 0.08, 0.04), 0.05),
    "F35_SwitchLED": ((0.02, 0.05, 0.02), (0.15, 1.0, 0.25), 0.3),
}
KEEP = ("F35_Skin_", "F35_Misc_")
NO_MERGE = ("F35_Skin_", "F35_Misc_", "F35_Decal_", "F35_canopy", "F35_PCD", "F35_eots", "F35_das", "P2_Visor",
            "P2_Lens") + tuple(LIGHTS)


def _bsdf(mat):
    if not mat.node_tree:
        return None
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            return n
    return None


def _vec(v):
    try:
        return tuple(float(x) for x in v)
    except TypeError:
        return float(v)


def _lerp(a, b, t):
    if isinstance(a, tuple) or isinstance(b, tuple):
        a = a if isinstance(a, tuple) else (a,) * 4
        b = b if isinstance(b, tuple) else (b,) * 4
        return tuple(x + (y - x) * t for x, y in zip(a, b))
    return a + (b - a) * t


def _scal(x):
    if isinstance(x, tuple):
        return sum(x[:3]) / 3.0
    return float(x)


def _col(x):
    if isinstance(x, tuple):
        return (x + (1.0,) * 4)[:4]
    return (x, x, x, 1.0)


def _find_image(sock, depth=0):
    """An image texture node feeding this socket through pass-through nodes, or None."""
    if not sock.is_linked or depth > 4:
        return None, None
    link = sock.links[0]
    n = link.from_node
    if n.type == 'TEX_IMAGE' and n.image is not None:
        return n, link.from_socket.name
    if n.type in ('MIX', 'MIX_RGB', 'GAMMA', 'HUE_SAT', 'BRIGHTCONTRAST'):
        for i in n.inputs:
            if i.is_linked and i.type == 'RGBA':
                r = _find_image(i, depth + 1)
                if r[0] is not None:
                    return r
    return None, None


def estimate(sock, depth=0):
    """Average value of a (possibly procedural) socket: float or RGBA tuple."""
    if not sock.is_linked or depth > 12:
        return _vec(sock.default_value) if hasattr(sock, "default_value") else 0.5
    link = sock.links[0]
    n, out = link.from_node, link.from_socket
    t = n.type
    inp = {i.identifier: i for i in n.inputs}
    if t == 'VALTORGB':
        els = n.color_ramp.elements
        if out.name == "Alpha":
            return sum(e.color[3] for e in els) / len(els)
        c = [sum(e.color[k] for e in els) / len(els) for k in range(4)]
        return tuple(c)
    if t in ('MIX', 'MIX_RGB'):
        if t == 'MIX':
            want = 'RGBA' if out.type == 'RGBA' else out.type
            fac = next(i for i in n.inputs if i.name == "Factor" and i.type == 'VALUE')
            a = next((i for i in n.inputs if i.name == "A" and i.type == want), None)
            b = next((i for i in n.inputs if i.name == "B" and i.type == want), None)
        else:
            fac, a, b = n.inputs[0], n.inputs[1], n.inputs[2]
        f = _scal(estimate(fac, depth + 1))
        va, vb = estimate(a, depth + 1), estimate(b, depth + 1)
        if n.blend_type == 'MULTIPLY':
            ca, cb = _col(va), _col(vb)
            return tuple(x * (1 - f) + x * y * f for x, y in zip(ca, cb))
        return _lerp(va, vb, f)
    if t == 'TEX_CHECKER':
        return _lerp(estimate(n.inputs["Color1"], depth + 1), estimate(n.inputs["Color2"], depth + 1), 0.5)
    if t == 'MAP_RANGE':
        lo = estimate(n.inputs["To Min"], depth + 1)
        hi = estimate(n.inputs["To Max"], depth + 1)
        return _lerp(lo, hi, 0.5)
    if t == 'MATH':
        a = _scal(estimate(n.inputs[0], depth + 1))
        b = _scal(estimate(n.inputs[1], depth + 1))
        op = n.operation
        try:
            v = {'ADD': a + b, 'SUBTRACT': a - b, 'MULTIPLY': a * b, 'DIVIDE': a / b if b else 0.0,
                 'MAXIMUM': max(a, b), 'MINIMUM': min(a, b), 'POWER': abs(a) ** b,
                 'MULTIPLY_ADD': a * b + _scal(estimate(n.inputs[2], depth + 1))}.get(op, a)
        except Exception:
            v = a
        return min(max(v, 0.0), 1.0) if n.use_clamp else v
    if t in ('RGB', 'VALUE'):
        return _vec(out.default_value)
    if t == 'ATTRIBUTE':
        return 1.0 if n.attribute_name in ("on", "power") else 0.5
    if t in ('SEPARATE_COLOR', 'SEPRGB', 'SEPXYZ', 'SEPARATE_XYZ'):
        v = _col(estimate(n.inputs[0], depth + 1))
        k = {"Red": 0, "R": 0, "X": 0, "Green": 1, "G": 1, "Y": 1, "Blue": 2, "B": 2, "Z": 2}.get(out.name, 0)
        return v[k]
    if t == 'TEX_IMAGE':
        return 0.8
    if t in ('BUMP', 'NORMAL_MAP'):
        return 0.0
    if out.type == 'RGBA':
        return (0.5, 0.5, 0.5, 1.0)
    return 0.5


def _clean(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    return mat, _bsdf(mat)


def convert(src):
    """A clean export material for src (same name; the source is renamed out of the way)."""
    name = src.name
    if name.startswith(KEEP):
        return src
    b0 = _bsdf(src)
    src.name = name + ".src"
    mat, b = _clean(name)
    nt = mat.node_tree
    if name in LIGHTS:
        base, emit, rough = LIGHTS[name]
        b.inputs["Base Color"].default_value = (*base, 1.0)
        b.inputs["Emission Color"].default_value = (*emit, 1.0)
        b.inputs["Emission Strength"].default_value = 1.0
        b.inputs["Roughness"].default_value = rough
        return mat
    if b0 is None:
        b.inputs["Base Color"].default_value = tuple(src.diffuse_color)
        return mat
    for key in ("Base Color", "Emission Color"):
        img, chan = _find_image(b0.inputs[key])
        if img is not None:
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = img.image
            tex.interpolation = 'Linear'
            nt.links.new(tex.outputs["Color"], b.inputs[key])
            if key == "Base Color" and b0.inputs["Alpha"].is_linked:
                ai, ach = _find_image(b0.inputs["Alpha"])
                if ai is not None and ai.image == img.image:
                    nt.links.new(tex.outputs["Alpha"], b.inputs["Alpha"])
        else:
            b.inputs[key].default_value = _col(estimate(b0.inputs[key]))
    for key in ("Metallic", "Roughness", "IOR", "Alpha", "Transmission Weight", "Coat Weight", "Coat Roughness",
                "Coat IOR", "Specular IOR Level", "Emission Strength", "Sheen Weight"):
        if key not in b0.inputs or key not in b.inputs:
            continue
        if key == "Alpha" and b.inputs["Alpha"].is_linked:
            continue
        v = _scal(estimate(b0.inputs[key]))
        if key == "Emission Strength" and name == "F35_PCD_Screen":
            v = 2.2
        b.inputs[key].default_value = v
    if b.inputs["Coat Weight"].default_value < 0.05:
        b.inputs["Coat Weight"].default_value = 0.0
    b.inputs["Sheen Weight"].default_value = 0.0         # no sheen extension: keep the export lean
    for key in ("Specular Tint", "Coat Tint"):
        if key in b0.inputs and key in b.inputs and not b0.inputs[key].is_linked:
            b.inputs[key].default_value = b0.inputs[key].default_value
    if "Thin Film Thickness" in b0.inputs:
        mat["thin_film_nm"] = float(b0.inputs["Thin Film Thickness"].default_value)
        mat["thin_film_ior"] = float(b0.inputs["Thin Film IOR"].default_value)
    try:
        if b.inputs["Alpha"].is_linked or b.inputs["Alpha"].default_value < 0.999:
            mat.surface_render_method = 'BLENDED'
    except Exception:
        pass
    mat.diffuse_color = b.inputs["Base Color"].default_value if not b.inputs["Base Color"].is_linked else \
        src.diffuse_color
    return mat


def _key(mat):
    b = _bsdf(mat)
    if b is None or any(i.is_linked for i in b.inputs):
        return None

    def q(v, s):
        return round(v / s)
    c = b.inputs["Base Color"].default_value
    lum = (c[0] + c[1] + c[2]) / 3 + 1e-4
    return (tuple(q(x ** (1 / 2.2), 0.03) for x in c[:3]), q(b.inputs["Roughness"].default_value, 0.12),
            q(b.inputs["Metallic"].default_value, 0.2), q(b.inputs["Transmission Weight"].default_value, 0.5),
            q(b.inputs["Coat Weight"].default_value, 0.3),
            tuple(q(x, 0.05) for x in b.inputs["Emission Color"].default_value[:3]),
            q(b.inputs["Emission Strength"].default_value, 0.2), q(b.inputs["Alpha"].default_value, 0.05),
            round(lum, 1) > 0)


def convert_all(objs):
    """Replace every material slot on objs by its export material; merge look-alikes."""
    done = {}
    for o in objs:
        me = o.data
        for i, m in enumerate(me.materials):
            if m is None:
                continue
            if m.name not in done:
                done[m.name] = convert(m)
            me.materials[i] = done[m.name]
    # merge materials that would render the same (mostly the pilot's many dark fabrics)
    groups = {}
    for m in set(done.values()):
        if m.name.startswith(NO_MERGE):
            continue
        k = _key(m)
        if k is not None:
            groups.setdefault(k, []).append(m)
    remap = {}
    for k, ms in groups.items():
        ms.sort(key=lambda m: (not m.name.startswith("F35_"), m.name))
        for m in ms[1:]:
            remap[m.name] = ms[0]
    for o in objs:
        me = o.data
        for i, m in enumerate(me.materials):
            if m is not None and m.name in remap:
                me.materials[i] = remap[m.name]
    n = len({m.name for m in done.values()})
    log(f"  materials: {n} -> {n - len(remap)} after merging look-alikes")
    return done, remap
