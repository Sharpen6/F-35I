"""Materials for the pilot: fabrics (IAF olive flight suit, G-suit, vest, webbing), leather, rubber,
the helmet's carbon shell, the smoke/mirror display visor, glass, steel, and small generated
textures (Israeli flag, unit patch, watch dial, kneeboard tablet screen).

Colours are sRGB from the reference photos (see docs/pilot_*.md), converted to linear here."""
import math

import bpy
import numpy as np


def srgb(h, a=1.0):
    """'#rrggbb' or (r, g, b) 0-255 -> linear RGBA."""
    if isinstance(h, str):
        h = h.lstrip("#")
        rgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    else:
        rgb = [c / 255.0 for c in h]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return (*lin, a)


def _hex01(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


def _new(name):
    m = bpy.data.materials.get(name)
    if m is not None:
        bpy.data.materials.remove(m)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    return m


def _bsdf(m):
    return m.node_tree.nodes.get("Principled BSDF")


def _texcoord(nt, scale):
    """Object coordinates scaled (patterns stay put on the body when it moves)."""
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (scale, scale, scale)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    return mp.outputs["Vector"]


def _bump(nt, height_socket, strength, distance, normal_in=None):
    bm = nt.nodes.new("ShaderNodeBump")
    bm.inputs["Strength"].default_value = strength
    bm.inputs["Distance"].default_value = distance
    nt.links.new(height_socket, bm.inputs["Height"])
    if normal_in is not None:
        nt.links.new(normal_in, bm.inputs["Normal"])
    return bm.outputs["Normal"]


def fabric(name, color, rough=0.85, sheen=0.35, weave=900.0, bump=0.25, mottle=0.10, wrinkle=0.0,
           folds=0.0, fold_scale=7.0):
    """Woven cloth: a fine twill bump, slow colour mottling (wear, dye), sheen at grazing angles.
    folds > 0 adds creases: ridges of a noise squashed along Z, so on limbs and torso they run
    round the body like the concertina folds of sleeves and trouser legs (in object space, so
    they stay on the cloth when the pilot moves)."""
    m = _new(name)
    nt = m.node_tree
    b = _bsdf(m)
    b.inputs["Roughness"].default_value = rough
    # a little sheen tinted like the cloth (white sheen turns dark fabric pale)
    b.inputs["Sheen Weight"].default_value = sheen * 0.35
    b.inputs["Sheen Roughness"].default_value = 0.5
    b.inputs["Sheen Tint"].default_value = tuple(min(1.0, 0.25 + 2.5 * c) for c in color[:3]) + (1.0,)
    b.inputs["Specular IOR Level"].default_value = 0.25
    vec = _texcoord(nt, 1.0)
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 9.0
    noise.inputs["Detail"].default_value = 4.0
    nt.links.new(vec, noise.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    c0 = tuple(max(0.0, c * (1 - mottle)) for c in color[:3]) + (1.0,)
    c1 = tuple(min(1.0, c * (1 + mottle)) for c in color[:3]) + (1.0,)
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[0].color = c0
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[1].color = c1
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'DIAGONAL'
    wave.inputs["Scale"].default_value = weave
    wave.inputs["Distortion"].default_value = 1.5
    wave.inputs["Detail"].default_value = 1.0
    nt.links.new(vec, wave.inputs["Vector"])
    nrm = None
    if folds > 0:
        # soft creases: a smooth, low-detail noise squashed along Z drives the bump only, so the
        # cloth shades like gentle folds round the limbs (no dark contour lines: those read as camo)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (fold_scale, fold_scale, fold_scale * 3.2)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        fn = nt.nodes.new("ShaderNodeTexNoise")
        fn.inputs["Scale"].default_value = 1.0
        fn.inputs["Detail"].default_value = 1.5
        fn.inputs["Roughness"].default_value = 0.45
        fn.inputs["Distortion"].default_value = 0.2
        nt.links.new(mp.outputs["Vector"], fn.inputs["Vector"])
        nrm = _bump(nt, fn.outputs["Fac"], folds * 0.5, 0.006)
    if wrinkle > 0:
        wn = nt.nodes.new("ShaderNodeTexNoise")
        wn.inputs["Scale"].default_value = 40.0
        wn.inputs["Detail"].default_value = 3.0
        wn.inputs["Distortion"].default_value = 0.6
        nt.links.new(vec, wn.inputs["Vector"])
        nrm = _bump(nt, wn.outputs["Fac"], wrinkle, 0.002, nrm)
    nt.links.new(_bump(nt, wave.outputs["Fac"], bump, 0.0004, nrm), b.inputs["Normal"])
    return m


def plain(name, color, rough=0.5, metal=0.0, coat=0.0, spec=0.5, coat_rough=0.15):
    m = _new(name)
    b = _bsdf(m)
    b.inputs["Base Color"].default_value = color
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["Specular IOR Level"].default_value = spec
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = coat_rough
    return m


def leather(name, color, rough=0.5, coat=0.0, grain=0.25):
    """Leather: fine pebbled grain (cellular noise bump), slightly darker in the creases."""
    m = plain(name, color, rough=rough, coat=coat, coat_rough=0.25)
    nt = m.node_tree
    b = _bsdf(m)
    vec = _texcoord(nt, 1.0)
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.feature = 'DISTANCE_TO_EDGE'
    vor.inputs["Scale"].default_value = 900.0
    nt.links.new(vec, vor.inputs["Vector"])
    nt.links.new(_bump(nt, vor.outputs["Distance"], grain, 0.0003), b.inputs["Normal"])
    return m


def rubber_ribbed(name, color, rough=0.5):
    return plain(name, color, rough=rough, spec=0.4)


def carbon(name, base="#1B1C1E", hi="#2B2D30", tow=0.0022, coat=0.6):
    """Carbon-fibre composite under a satin clear coat: a 2x2 twill-like checker of tows."""
    m = _new(name)
    nt = m.node_tree
    b = _bsdf(m)
    vec = _texcoord(nt, 1.0)
    chk = nt.nodes.new("ShaderNodeTexChecker")
    chk.inputs["Scale"].default_value = 1.0 / tow
    chk.inputs["Color1"].default_value = srgb(hi)
    chk.inputs["Color2"].default_value = srgb(base)
    nt.links.new(vec, chk.inputs["Vector"])
    # the tows run diagonally: modulate the checker with fine bands so it reads as a weave
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'DIAGONAL'
    wave.inputs["Scale"].default_value = 2.5 / tow
    nt.links.new(vec, wave.inputs["Vector"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    # the Mix node has float, vector and colour sockets of the same names: pick the colour ones
    fac = next(i for i in mix.inputs if i.name == "Factor" and i.type == 'VALUE')
    a_in = next(i for i in mix.inputs if i.name == "A" and i.type == 'RGBA')
    b_in = next(i for i in mix.inputs if i.name == "B" and i.type == 'RGBA')
    res = next(o for o in mix.outputs if o.name == "Result" and o.type == 'RGBA')
    fac.default_value = 0.25
    nt.links.new(chk.outputs["Color"], a_in)
    nt.links.new(wave.outputs["Color"], b_in)
    nt.links.new(res, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.42
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Coat Roughness"].default_value = 0.30
    b.inputs["Coat IOR"].default_value = 1.5
    b.inputs["Anisotropic"].default_value = 0.15
    nt.links.new(_bump(nt, chk.outputs["Fac"], 0.08, 0.0002), b.inputs["Normal"])
    return m


def glass(name, tint="#E6E8EA", rough=0.01, ior=1.585):
    m = plain(name, srgb(tint), rough=rough)
    b = _bsdf(m)
    b.inputs["Transmission Weight"].default_value = 1.0
    b.inputs["IOR"].default_value = ior
    return m


def visor(name="P2_Visor"):
    """Day visor: neutral smoke polycarbonate (~18 % transmission) under a partly mirrored coating
    (F0 ~ 0.2) with a faint bronze/gold interference tint, as in the photos."""
    m = _new(name)
    b = _bsdf(m)
    b.inputs["Base Color"].default_value = srgb("#5A5A5C")
    b.inputs["Transmission Weight"].default_value = 1.0
    b.inputs["IOR"].default_value = 1.585
    b.inputs["Roughness"].default_value = 0.012
    b.inputs["Coat Weight"].default_value = 1.0
    b.inputs["Coat IOR"].default_value = 2.0
    b.inputs["Coat Roughness"].default_value = 0.01
    b.inputs["Thin Film Thickness"].default_value = 420.0
    b.inputs["Thin Film IOR"].default_value = 1.9
    return m


def lens(name="P2_Lens"):
    """Night-camera lens: dark glass with a blue-violet anti-reflection coating."""
    m = plain(name, srgb("#050505"), rough=0.04, spec=1.0)
    b = _bsdf(m)
    b.inputs["Coat Weight"].default_value = 1.0
    b.inputs["Coat Roughness"].default_value = 0.02
    b.inputs["Thin Film Thickness"].default_value = 330.0
    b.inputs["Thin Film IOR"].default_value = 1.38
    return m


def skin(name="P2_Skin", color="#B98A6E"):
    m = plain(name, srgb(color), rough=0.45)
    b = _bsdf(m)
    b.inputs["Subsurface Weight"].default_value = 0.25
    b.inputs["Subsurface Radius"].default_value = (1.0, 0.35, 0.2)
    b.inputs["Subsurface Scale"].default_value = 0.006
    return m


# ----------------------------------------------------------------------------- generated textures
def _image(name, rgba):
    """Packed image from an (H, W, 4) array in display (sRGB) values, row 0 at the top."""
    H, W = rgba.shape[:2]
    im = bpy.data.images.get(name)
    if im is not None:
        bpy.data.images.remove(im)
    im = bpy.data.images.new(name, W, H, alpha=True)
    im.pixels.foreach_set(np.ascontiguousarray(rgba[::-1], np.float32).ravel())
    im.pack()
    return im


def _grid(W, H):
    y, x = np.mgrid[0:H, 0:W]
    return (x + 0.5) / W, 1.0 - (y + 0.5) / H          # u right, v up


def _poly_inside(px, py, poly):
    """Even-odd point-in-polygon for arrays of points."""
    inside = np.zeros(px.shape, bool)
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        cond = (y0 > py) != (y1 > py)
        xc = x0 + (py - y0) * (x1 - x0) / ((y1 - y0) if y1 != y0 else 1e-12)
        inside ^= cond & (px < xc)
    return inside


def _tri_sd(px, py, cx, cy, r, up=True):
    """Signed distance (negative inside) to an equilateral triangle, centroid (cx, cy),
    circumradius r, pointing up or down."""
    d = -np.inf * np.ones(px.shape)
    for k in range(3):
        a = math.radians(90 + 120 * k + (0 if up else 180))
        # edge normal points away from the vertex, inradius r / 2
        nx, ny = -math.cos(a), -math.sin(a)
        d = np.maximum(d, (px - cx) * nx + (py - cy) * ny - r / 2)
    return d


def flag_image(W=640, H=414):
    """The Israeli flag as an embroidered patch: white field, two blue stripes, the Star of David,
    blue merrow edge.  Proportions of the 160 x 220 flag."""
    u, v = _grid(W, H)
    x, y = u * 220.0, v * 160.0                    # flag units (cm)
    blue = _hex01("#0038B8")
    white = _hex01("#F2F2F0")
    img = np.ones((H, W, 3)) * white
    stripe = ((y >= 15) & (y <= 40)) | ((y >= 120) & (y <= 145))
    t = 5.5
    star = np.zeros(stripe.shape, bool)
    for up in (True, False):
        d = _tri_sd(x, y, 110.0, 80.0, 33.0, up)          # star 66 cm tip to tip
        star |= (d < 0) & (d > -t)
    img[stripe | star] = blue
    edge = (u < 0.022) | (u > 0.978) | (v < 0.034) | (v > 0.966)
    img[edge] = blue * 0.85
    return np.dstack([img, np.ones((H, W))])


def unit_patch_image(W=512):
    """A generic round squadron patch: navy merrow border, gold ring, sky field with a white
    F-35 seen from above (squadron art of the F-35I units is not public in the references)."""
    u, v = _grid(W, W)
    x, y = (u - 0.5) * 2, (v - 0.5) * 2
    r = np.hypot(x, y)
    img = np.zeros((W, W, 3))
    img[:] = _hex01("#6E9CD6") * (0.92 + 0.08 * y[..., None])
    jet = [(0.0, 0.70), (0.06, 0.48), (0.08, 0.20), (0.50, -0.10), (0.50, -0.22), (0.12, -0.20),
           (0.10, -0.36), (0.30, -0.52), (0.30, -0.62), (0.06, -0.58), (0.0, -0.54)]
    jet = jet + [(-px, py) for px, py in reversed(jet[1:-1])]
    img[_poly_inside(x, y, jet)] = _hex01("#F4F4F2")
    img[(r > 0.80) & (r <= 0.86)] = _hex01("#C9A43A")
    img[r > 0.86] = _hex01("#1C2541")
    img[r > 0.97] = _hex01("#141B30")
    alpha = (r <= 1.0).astype(float)
    return np.dstack([img, alpha])


def dial_image(W=256):
    """Black dive-watch dial: luminous markers and hands (10:08)."""
    u, v = _grid(W, W)
    x, y = (u - 0.5) * 2, (v - 0.5) * 2
    r = np.hypot(x, y)
    ang = np.arctan2(x, y)                          # 0 at 12 o'clock, clockwise
    img = np.zeros((W, W, 3)) + 0.04
    lum = _hex01("#E8EDE0")
    for k in range(12):
        a = k * math.pi / 6
        da = np.angle(np.exp(1j * (ang - a)))
        if k == 0:
            m = (r > 0.62) & (r < 0.86) & (np.abs(da) < 0.12 * (0.86 - r) / 0.24 + 0.02)
        else:
            m = (r > 0.66) & (r < 0.86) & (np.abs(da) * r < (0.05 if k % 3 == 0 else 0.035))
        img[m] = lum
    for a, L, wdt in ((math.radians(304), 0.50, 0.055), (math.radians(48), 0.78, 0.035)):
        dx, dy = math.sin(a), math.cos(a)
        t = x * dx + y * dy
        n = np.abs(x * dy - y * dx)
        img[(t > -0.08) & (t < L) & (n < wdt)] = lum * 0.95
    img[r < 0.05] = 0.7
    img[r > 0.95] = 0.12
    return np.dstack([img, np.ones((W, W))])


def screen_image(W=420, H=640):
    """Kneeboard tablet: a moving map (coast, sea, terrain shading, airfield, route, range rings)."""
    u, v = _grid(W, H)
    x, y = u * W / H, v
    coast = 0.42 + 0.06 * np.sin(7.0 * y) + 0.03 * np.sin(23.0 * y + 1.0) - 0.15 * (y - 0.5)
    sea = x < coast
    rng = np.random.default_rng(7)
    hill = np.zeros_like(x)
    for _ in range(18):
        cx, cy, s = rng.uniform(0.3, 0.7), rng.uniform(0, 1), rng.uniform(0.04, 0.12)
        hill += np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s)) * rng.uniform(0.3, 1.0)
    land = _hex01("#3A4A2C") * (0.7 + 0.5 * np.clip(hill, 0, 1))[..., None] + _hex01("#5A4A30") * 0.25 * np.clip(hill - 0.6, 0, 1)[..., None]
    img = np.where(sea[..., None], _hex01("#0E2C4A"), land)
    # contour-ish lines on the hills
    img[(np.abs(np.sin(hill * 18.0)) < 0.06) & ~sea] *= 1.35
    # airfield: two runways
    cx, cy = 0.50, 0.40
    for a, L in ((math.radians(-20), 0.10), (math.radians(40), 0.08)):
        dx, dy = math.cos(a), math.sin(a)
        t = (x - cx) * dx + (y - cy) * dy
        n = np.abs(-(x - cx) * dy + (y - cy) * dx)
        img[(np.abs(t) < L) & (n < 0.006)] = _hex01("#E8E8E8")
    # route (magenta) and range rings (cyan) round the aircraft symbol
    ax, ay = 0.33, 0.18
    pts = [(ax, ay), (0.45, 0.33), (0.50, 0.40), (0.42, 0.62), (0.30, 0.86)]
    for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy)
        t = ((x - x0) * dx + (y - y0) * dy) / L
        n = np.abs(-(x - x0) * dy + (y - y0) * dx) / L
        img[(t > 0) & (t < L) & (n < 0.004)] = _hex01("#E040E0")
    rr = np.hypot(x - ax, y - ay)
    for R in (0.15, 0.30, 0.45):
        img[np.abs(rr - R) < 0.0025] = _hex01("#40D0E0")
    tri = [(ax, ay + 0.03), (ax + 0.018, ay - 0.015), (ax, ay - 0.004), (ax - 0.018, ay - 0.015)]
    img[_poly_inside(x, y, tri)] = _hex01("#FFFFFF")
    # status bars top and bottom
    img[(v > 0.955) | (v < 0.035)] = _hex01("#101418")
    img[((v > 0.962) & (v < 0.985)) & ((u * 8) % 1 < 0.75)] = _hex01("#2A3440")
    return np.dstack([np.clip(img, 0, 1), np.ones((H, W))])


def textured(name, image, rough=0.6, sheen=0.3, emission=0.0, coat=0.0, bump=0.0, alpha=False):
    """Material from a generated image on the mesh's UV map."""
    m = _new(name)
    nt = m.node_tree
    b = _bsdf(m)
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.interpolation = 'Cubic'
    uvn = nt.nodes.new("ShaderNodeUVMap")
    nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    b.inputs["Sheen Weight"].default_value = sheen
    if alpha:
        nt.links.new(tex.outputs["Alpha"], b.inputs["Alpha"])
    if emission:
        nt.links.new(tex.outputs["Color"], b.inputs["Emission Color"])
        b.inputs["Emission Strength"].default_value = emission
        b.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0)
        nt.links.remove(b.inputs["Base Color"].links[0])
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.02
    if bump:
        # embroidery: a fine thread texture in the UV space
        wave = nt.nodes.new("ShaderNodeTexWave")
        wave.inputs["Scale"].default_value = 120.0
        wave.inputs["Distortion"].default_value = 2.0
        nt.links.new(uvn.outputs["UV"], wave.inputs["Vector"])
        nt.links.new(_bump(nt, wave.outputs["Fac"], bump, 0.0002), b.inputs["Normal"])
    return m


def all_materials():
    """The pilot palette (sRGB values from the reference photos)."""
    return {
        # IAF olive suit: darker and more yellow than the USAF sage (Blue Flag 2019 side by side)
        "suit": fabric("P2_FlightSuit", srgb("#646246"), rough=0.88, sheen=0.25, mottle=0.04, wrinkle=0.12,
                       folds=0.55),
        "tshirt": fabric("P2_TShirt", srgb("#E6E6E4"), rough=0.95, sheen=0.3, weave=2400.0, bump=0.15),
        "gsuit": fabric("P2_GSuit", srgb("#585C43"), rough=0.8, sheen=0.2, weave=700.0, mottle=0.04,
                        wrinkle=0.1, folds=0.45, fold_scale=6.0),
        "webbing": fabric("P2_Webbing", srgb("#3a3c33"), rough=0.75, sheen=0.25, weave=1400.0, bump=0.5),
        "webbing_black": fabric("P2_WebbingBlack", srgb("#161616"), rough=0.8, sheen=0.2, weave=1600.0, bump=0.4),
        "vest": fabric("P2_Vest", srgb("#4E5340"), rough=0.85, sheen=0.2, weave=800.0, mottle=0.05, folds=0.3,
                       fold_scale=5.0),
        "skin": skin(),
        "glove": fabric("P2_GloveKnit", srgb("#6E6D57"), rough=0.9, sheen=0.4, weave=2200.0, bump=0.3),
        "glove_leather": leather("P2_GloveLeather", srgb("#74726A"), rough=0.55, grain=0.2),
        "leather": leather("P2_Leather", srgb("#2a231e"), rough=0.55),
        "boot": leather("P2_Boot", srgb("#1C1B1A"), rough=0.52, coat=0.0, grain=0.25),
        "sole": plain("P2_Sole", srgb("#1b1a19"), rough=0.85),
        "helmet": carbon("P2_HelmetCarbon"),
        "helmet_trim": plain("P2_HelmetTrim", srgb("#151617"), rough=0.6),
        "clear_cover": glass("P2_BrowCover"),
        "visor": visor(),
        "lens": lens(),
        "rubber": plain("P2_Rubber", srgb("#0E0E0E"), rough=0.7),
        "mask": plain("P2_Mask", srgb("#151515"), rough=0.55),
        "mask_seal": plain("P2_MaskSeal", srgb("#8A9096"), rough=0.45),
        "cuff": plain("P2_MaskCuff", srgb("#6A7076"), rough=0.6),
        "black_gloss": plain("P2_BlackGloss", srgb("#0C0C0C"), rough=0.25),
        "hose": plain("P2_Hose", srgb("#6E747A"), rough=0.5, spec=0.4),
        "hose_olive": plain("P2_HoseOlive", srgb("#5A5F48"), rough=0.55, spec=0.4),
        "cable": fabric("P2_CableBraid", srgb("#111111"), rough=0.6, sheen=0.2, weave=3000.0, bump=0.6, mottle=0.0),
        "metal": plain("P2_Metal", srgb("#B8BBBE"), rough=0.3, metal=1.0),
        "steel": plain("P2_Steel", srgb("#C9CBCD"), rough=0.18, metal=1.0),
        "steel_brushed": plain("P2_SteelBrushed", srgb("#B8BBBE"), rough=0.35, metal=1.0),
        "dark_metal": plain("P2_DarkMetal", srgb("#3a3b3c"), rough=0.35, metal=0.9),
        "olive_metal": plain("P2_OliveMetal", srgb("#5F5D44"), rough=0.45, metal=0.6),
        "zip": plain("P2_Zip", srgb("#2A2B27"), rough=0.45, metal=0.2),
        "patch": plain("P2_Patch", srgb("#4f5545"), rough=0.9),
        "black": plain("P2_Black", srgb("#121212"), rough=0.55),
        "kneeboard": plain("P2_Kneeboard", srgb("#121212"), rough=0.45),
        "screen": textured("P2_TabletScreen", _image("P2_TabletMap", screen_image()), rough=0.05,
                           sheen=0.0, emission=1.4, coat=1.0),
        "flag": textured("P2_FlagPatch", _image("P2_IsraeliFlag", flag_image()), rough=0.65, sheen=0.35, bump=0.15),
        "unit_patch": textured("P2_UnitPatch", _image("P2_UnitPatchArt", unit_patch_image()), rough=0.65,
                               sheen=0.35, bump=0.15),
        "watch_face": textured("P2_WatchDial", _image("P2_WatchDialArt", dial_image()), rough=0.3,
                               sheen=0.0, coat=1.0),
    }
