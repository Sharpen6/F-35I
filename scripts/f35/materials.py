"""Procedural materials for the F-35I model (Cycles + EEVEE compatible)."""
import bpy

_CACHE = {}

# named damage zones of large meshes (see destruct.py)
DAMAGE_ZONES = ("nose", "fwd", "center", "aft", "outer")


def _bsdf(mat):
    nt = mat.node_tree
    return nt.nodes.get("Principled BSDF")


def _new(name):
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    return mat


def principled(name, color, rough=0.5, metal=0.0, coat=0.0, emission=None,
               emission_strength=0.0, alpha=1.0, transmission=0.0, ior=1.45,
               spec=0.5, spec_tint=None, thin_film=0.0, film_ior=1.9):
    mat = _new(name)
    b = _bsdf(mat)
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Specular IOR Level"].default_value = spec
    if emission is not None:
        b.inputs["Emission Color"].default_value = (*emission, 1.0)
        b.inputs["Emission Strength"].default_value = emission_strength
    if transmission > 0:
        b.inputs["Transmission Weight"].default_value = transmission
        b.inputs["IOR"].default_value = ior
    if spec_tint is not None and "Specular Tint" in b.inputs:
        b.inputs["Specular Tint"].default_value = (*spec_tint, 1.0)
    if thin_film > 0 and "Thin Film Thickness" in b.inputs:
        b.inputs["Thin Film Thickness"].default_value = thin_film      # nm (ITO coating)
        b.inputs["Thin Film IOR"].default_value = film_ior
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        try:
            mat.surface_render_method = 'BLENDED'
        except Exception:
            pass
    mat.diffuse_color = (*color, alpha)
    return mat


def fabric(name, color, rough=0.82, sheen=0.35, fold=0.35, fold_scale=14.0):
    """Cloth: rough diffuse with a soft sheen and a low-frequency bump for folds and seams."""
    mat = principled(name, color, rough=rough)
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    b = _bsdf(mat)
    for k, v in (("Sheen Weight", sheen), ("Sheen Roughness", 0.45)):
        if k in b.inputs:
            b.inputs[k].default_value = v
    if "Sheen Tint" in b.inputs:
        b.inputs["Sheen Tint"].default_value = (1.0, 1.0, 1.0, 1.0)
    tc = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = fold_scale
    noise.inputs["Detail"].default_value = 3.0
    noise.inputs["Roughness"].default_value = 0.55
    noise.inputs["Distortion"].default_value = 0.6
    links.new(tc.outputs["Object"], noise.inputs["Vector"])
    fine = nodes.new("ShaderNodeTexNoise")              # weave / small creases
    fine.inputs["Scale"].default_value = fold_scale * 9.0
    fine.inputs["Detail"].default_value = 2.0
    links.new(tc.outputs["Object"], fine.inputs["Vector"])
    mix = nodes.new("ShaderNodeMath")
    mix.operation = 'MULTIPLY_ADD'
    mix.inputs[1].default_value = 0.15
    links.new(fine.outputs["Fac"], mix.inputs[0])
    links.new(noise.outputs["Fac"], mix.inputs[2])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = fold
    bump.inputs["Distance"].default_value = 0.004
    links.new(mix.outputs[0], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return mat


def sooty(name, base, soot, rough=0.6, metal=0.0, stretch=(9.0, 1.2, 9.0), ramp=(0.32, 0.58)):
    """Base colour streaked with soot along the flow (+Y, object space):
    heat-stained nozzle parts (photos: pale ceramic flaps with brown streaks)."""
    mat = _new(name)
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    b = _bsdf(mat)
    tc = nodes.new("ShaderNodeTexCoord")
    mp = nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = stretch
    links.new(tc.outputs["Object"], mp.inputs["Vector"])
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 3.0
    noise.inputs["Detail"].default_value = 8.0
    noise.inputs["Roughness"].default_value = 0.65
    links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    cr = nodes.new("ShaderNodeValToRGB")
    cr.color_ramp.elements[0].position = ramp[0]
    cr.color_ramp.elements[0].color = (*soot, 1.0)
    cr.color_ramp.elements[1].position = ramp[1]
    cr.color_ramp.elements[1].color = (*base, 1.0)
    links.new(noise.outputs["Fac"], cr.inputs["Fac"])
    links.new(cr.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    mat.diffuse_color = (*base, 1.0)
    return mat


def depth_fade(name, near, far, y0, y1, rough=0.55):
    """Colour fading from `near` to `far` along object-space Y (y0 -> y1):
    the inlet duct lining, light behind the lip and dark deep inside, as in
    photos (c20: white lining at the lip; c29 head-on: black beyond)."""
    mat = _new(name)
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    b = _bsdf(mat)
    tc = nodes.new("ShaderNodeTexCoord")
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(tc.outputs["Object"], sep.inputs["Vector"])
    mr = nodes.new("ShaderNodeMapRange")
    mr.clamp = True
    mr.inputs["From Min"].default_value = y0
    mr.inputs["From Max"].default_value = y1
    links.new(sep.outputs["Y"], mr.inputs["Value"])
    cr = nodes.new("ShaderNodeValToRGB")
    cr.color_ramp.interpolation = 'EASE'
    cr.color_ramp.elements[0].color = (*near, 1.0)
    cr.color_ramp.elements[1].color = (*far, 1.0)
    links.new(mr.outputs["Result"], cr.inputs["Fac"])
    links.new(cr.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    mat.diffuse_color = (*near, 1.0)
    return mat


def _panel_detail(nodes, links):
    """Projected panel-line maps (see panels.py) -> (line, tape, light) sockets.

    The lookup uses the rest-pose position / normal stored on each mesh, so
    the detail stays glued to moving and broken-off parts."""
    from . import panels as PN
    imgs = PN.images()

    def m(op, a, b=None, c=None):
        n = nodes.new("ShaderNodeMath")
        n.operation = op
        for i, v in enumerate((a, b, c)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = float(v)
            else:
                links.new(v, n.inputs[i])
        return n.outputs[0]

    ap = nodes.new("ShaderNodeAttribute")
    ap.attribute_type = 'GEOMETRY'
    ap.attribute_name = "rest_p"
    an = nodes.new("ShaderNodeAttribute")
    an.attribute_type = 'GEOMETRY'
    an.attribute_name = "rest_n"
    sp = nodes.new("ShaderNodeSeparateXYZ")
    links.new(ap.outputs["Vector"], sp.inputs[0])
    sn = nodes.new("ShaderNodeSeparateXYZ")
    links.new(an.outputs["Vector"], sn.inputs[0])
    X, Y, Z = sp.outputs[0], sp.outputs[1], sp.outputs[2]
    LS = PN.S1 - PN.S0
    u = m('MULTIPLY_ADD', Y, 1.0 / LS, (PN.Y0 - PN.S0) / LS)
    v_tb = m('MULTIPLY_ADD', X, 1.0 / (PN.XMAX - PN.XMIN), -PN.XMIN / (PN.XMAX - PN.XMIN))
    tz = m('MULTIPLY_ADD', Z, 1.0 / (PN.Z1 - PN.Z0), -PN.Z0 / (PN.Z1 - PN.Z0))
    tz = m('MINIMUM', m('MAXIMUM', tz, 0.0), 1.0)
    half = m('MULTIPLY', m('GREATER_THAN', X, 0.0), 0.5)
    v_sd = m('MULTIPLY_ADD', tz, 0.5, half)
    cols = {}
    for name, vv in (("top", v_tb), ("bottom", v_tb), ("side", v_sd)):
        cx = nodes.new("ShaderNodeCombineXYZ")
        links.new(u, cx.inputs[0])
        links.new(vv, cx.inputs[1])
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = imgs[name]
        tex.interpolation = 'Linear'
        tex.extension = 'CLIP'
        links.new(cx.outputs[0], tex.inputs["Vector"])
        cols[name] = tex.outputs["Color"]
    nx, nz = sn.outputs[0], sn.outputs[2]
    wt = m('POWER', m('MAXIMUM', nz, 0.0), PN.K)
    wb = m('POWER', m('MAXIMUM', m('MULTIPLY', nz, -1.0), 0.0), PN.K)
    ws = m('POWER', m('ABSOLUTE', nx), PN.K)
    tot = m('ADD', m('ADD', wt, wb), m('ADD', ws, 1e-4))
    acc = None
    for name, w in (("top", wt), ("bottom", wb), ("side", ws)):
        sc = nodes.new("ShaderNodeVectorMath")
        sc.operation = 'SCALE'
        links.new(cols[name], sc.inputs[0])
        links.new(m('DIVIDE', w, tot), sc.inputs["Scale"])
        if acc is None:
            acc = sc.outputs[0]
        else:
            ad = nodes.new("ShaderNodeVectorMath")
            ad.operation = 'ADD'
            links.new(acc, ad.inputs[0])
            links.new(sc.outputs[0], ad.inputs[1])
            acc = ad.outputs[0]
    sep = nodes.new("ShaderNodeSeparateXYZ")
    sep.name = "PanelDetail"
    links.new(acc, sep.inputs[0])
    return sep.outputs[0], sep.outputs[1], sep.outputs[2]


def skin_material():
    """Radar-absorbent 'Have Glass' grey with subtle panel mottling.

    Tuned against photos c29 (clear sky) and c51 (bright cloud) rendered from their solved cameras
    under an HDRI sky: the coating is dark where it faces the camera and turns silvery where it
    catches the sky at a glancing angle, so the base is darker than the paint chip and a satin
    coat plus a little sheen carry the sky reflection."""
    mat = _new("F35_Skin_RAM")
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    b = nodes["Principled BSDF"]
    base = (0.094, 0.097, 0.100)       # FS 36170 class grey (linear), darkened for the coat on top
    tc = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 2.2
    noise.inputs["Detail"].default_value = 6.0
    noise.inputs["Roughness"].default_value = 0.6
    links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (base[0] * 0.965, base[1] * 0.965, base[2] * 0.97, 1)
    ramp.color_ramp.elements[1].position = 0.70
    ramp.color_ramp.elements[1].color = (base[0] * 1.03, base[1] * 1.03, base[2] * 1.03, 1)
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    # panel lines, sealant tape and lighter coatings (projected maps)
    line, tape, light = _panel_detail(nodes, links)

    def _m(op, a, b):
        n = nodes.new("ShaderNodeMath")
        n.operation = op
        for i, v in enumerate((a, b)):
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = float(v)
            else:
                links.new(v, n.inputs[i])
        return n.outputs[0]
    # RAM tape and caulk differ from the paint mostly in sheen: lighter, rougher and without the
    # satin coat, so a frame reads 6-10 % lighter under sky light (c51, c53) and darker than the
    # sunlit sheen of the paint (ref_06)
    dark = _m('MULTIPLY', _m('SUBTRACT', 1.0, _m('MULTIPLY', line, 0.45)),
              _m('ADD', 1.0, _m('MULTIPLY', tape, 0.22)))
    fac = _m('MULTIPLY', dark, _m('ADD', 1.0, _m('MULTIPLY', light, 0.30)))
    pmul = nodes.new("ShaderNodeMix")
    pmul.data_type = 'RGBA'
    pmul.blend_type = 'MULTIPLY'
    pmul.inputs["Factor"].default_value = 1.0
    links.new(ramp.outputs["Color"], pmul.inputs["A"])
    links.new(fac, pmul.inputs["B"])
    # roughness variation (Have Glass coatings have a soft metallic sheen)
    rr = nodes.new("ShaderNodeMapRange")
    rr.name = "SkinRough"
    rr.inputs["To Min"].default_value = 0.42
    rr.inputs["To Max"].default_value = 0.50
    links.new(noise.outputs["Fac"], rr.inputs["Value"])
    # battle damage (0..1) spreads soot / burns.  Sources (the largest wins):
    #   object property 'damage'                      - whole object
    #   geometry weight 'zone_<z>' x object 'dmg_<z>'  - one zone of a big mesh
    dmg = nodes.new("ShaderNodeAttribute")
    dmg.attribute_type = 'OBJECT'
    dmg.attribute_name = "damage"
    acc = dmg.outputs["Fac"]
    for z in DAMAGE_ZONES:
        zw = nodes.new("ShaderNodeAttribute")
        zw.attribute_type = 'GEOMETRY'
        zw.attribute_name = "zone_" + z
        zd = nodes.new("ShaderNodeAttribute")
        zd.attribute_type = 'OBJECT'
        zd.attribute_name = "dmg_" + z
        mul = nodes.new("ShaderNodeMath")
        mul.operation = 'MULTIPLY'
        links.new(zw.outputs["Fac"], mul.inputs[0])
        links.new(zd.outputs["Fac"], mul.inputs[1])
        mx = nodes.new("ShaderNodeMath")
        mx.operation = 'MAXIMUM'
        links.new(acc, mx.inputs[0])
        links.new(mul.outputs[0], mx.inputs[1])
        acc = mx.outputs[0]
    n3 = nodes.new("ShaderNodeTexNoise")
    n3.inputs["Scale"].default_value = 1.6
    n3.inputs["Detail"].default_value = 10.0
    n3.inputs["Roughness"].default_value = 0.7
    links.new(tc.outputs["Object"], n3.inputs["Vector"])
    thr = nodes.new("ShaderNodeMath")          # noise - (1 - damage)
    thr.operation = 'ADD'
    links.new(n3.outputs["Fac"], thr.inputs[0])
    links.new(acc, thr.inputs[1])
    msk = nodes.new("ShaderNodeMapRange")       # 1.0 .. 1.12 -> 0 .. 1
    msk.inputs["From Min"].default_value = 1.0
    msk.inputs["From Max"].default_value = 1.12
    links.new(thr.outputs[0], msk.inputs["Value"])
    soot = nodes.new("ShaderNodeMix")
    soot.data_type = 'RGBA'
    soot.inputs["B"].default_value = (0.012, 0.011, 0.010, 1.0)
    links.new(msk.outputs["Result"], soot.inputs["Factor"])
    links.new(pmul.outputs["Result"], soot.inputs["A"])
    links.new(soot.outputs["Result"], b.inputs["Base Color"])
    rmix = nodes.new("ShaderNodeMix")
    rmix.data_type = 'FLOAT'
    rmix.inputs["B"].default_value = 0.95
    links.new(msk.outputs["Result"], rmix.inputs["Factor"])
    rpan = _m('ADD', rr.outputs["Result"], _m('SUBTRACT', _m('ADD', _m('MULTIPLY', line, 0.12),
                                                              _m('MULTIPLY', tape, 0.30)),
                                                     _m('MULTIPLY', light, 0.06)))
    links.new(rpan, rmix.inputs["A"])
    links.new(rmix.outputs["Result"], b.inputs["Roughness"])
    b.inputs["Metallic"].default_value = 0.15
    b.inputs["Specular IOR Level"].default_value = 0.5
    # satin top coat (sky sheen at glancing angles) and a little sheen; soot burns both away
    clean = _m('SUBTRACT', 1.0, msk.outputs["Result"])
    links.new(_m('MULTIPLY', _m('MULTIPLY', clean, 0.6), _m('SUBTRACT', 1.0, _m('MULTIPLY', tape, 0.9))),
              b.inputs["Coat Weight"])
    b.inputs["Coat Roughness"].default_value = 0.3
    b.inputs["Coat IOR"].default_value = 1.5
    links.new(_m('MULTIPLY', clean, 0.15), b.inputs["Sheen Weight"])
    b.inputs["Sheen Roughness"].default_value = 0.5
    # fine grain bump
    n2 = nodes.new("ShaderNodeTexNoise")
    n2.inputs["Scale"].default_value = 180.0
    links.new(tc.outputs["Object"], n2.inputs["Vector"])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.04
    links.new(n2.outputs["Fac"], bump.inputs["Height"])
    gbump = nodes.new("ShaderNodeBump")          # panel lines read as fine grooves
    gbump.invert = True
    gbump.inputs["Strength"].default_value = 0.35
    gbump.inputs["Distance"].default_value = 0.0008
    links.new(line, gbump.inputs["Height"])
    links.new(bump.outputs["Normal"], gbump.inputs["Normal"])
    links.new(gbump.outputs["Normal"], b.inputs["Normal"])
    links.new(gbump.outputs["Normal"], b.inputs["Coat Normal"])
    mat.diffuse_color = (*base, 1)
    return mat


def get(name):
    if name in _CACHE and _CACHE[name].name in bpy.data.materials:
        return _CACHE[name]
    m = _make(name)
    _CACHE[name] = m
    return m


FABRICS = {
    "flightsuit": ((0.105, 0.110, 0.085), 0.85, 0.35, 0.45, 12.0),
    "gsuit":      ((0.095, 0.100, 0.076), 0.85, 0.30, 0.55, 10.0),
    "vest":       ((0.072, 0.080, 0.058), 0.80, 0.25, 0.35, 16.0),
    "pouch":      ((0.060, 0.080, 0.042), 0.80, 0.25, 0.30, 20.0),
    "glove":      ((0.055, 0.058, 0.045), 0.75, 0.30, 0.25, 30.0),
}


SWITCHABLE = {
    # name: (base colour, emission colour, strength when on[, roughness])
    "landing_light": ((0.85, 0.85, 0.82), (1.0, 0.96, 0.88), 60.0),
    "nav_red":       ((0.45, 0.02, 0.02), (1.0, 0.03, 0.02), 25.0),
    "nav_green":     ((0.02, 0.40, 0.08), (0.05, 1.0, 0.25), 25.0),
    "nav_white":     ((0.80, 0.80, 0.80), (1.0, 1.0, 0.97), 20.0),
    # electroluminescent strips: pale matte grey-green when off, 1.5-2.5x the skin's brightness on
    # screen in every light (photos ref_03, ref_05, ref_06, c00, c14, c20, c51)
    "formation":     ((0.20, 0.27, 0.23), (0.55, 1.0, 0.35), 6.0, 0.60),
    # anti-collision lenses sit flush and read as dark smoked glass when off
    "beacon":        ((0.035, 0.035, 0.04), (1.0, 0.08, 0.04), 40.0, 0.05),
}


def switchable(name, base, emit, strength, rough=0.08):
    """Emission = object property 'on' (0..1) x strength, so the rig can
    switch every light individually."""
    mat = _new("F35_" + name)
    nt = mat.node_tree
    b = _bsdf(mat)
    b.inputs["Base Color"].default_value = (*base, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Emission Color"].default_value = (*emit, 1.0)
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_type = 'OBJECT'
    attr.attribute_name = "on"
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = strength
    nt.links.new(attr.outputs["Fac"], mul.inputs[0])
    nt.links.new(mul.outputs[0], b.inputs["Emission Strength"])
    mat.diffuse_color = (*base, 1.0)
    return mat


def _make(name):
    if name == "skin":
        return skin_material()
    if name in SWITCHABLE:
        return switchable(name, *SWITCHABLE[name])
    if name == "intake":
        # duct lining: light grey behind the lip (s ~4.3-5.0), dark by s ~5.9
        return depth_fade("F35_intake", (0.52, 0.52, 0.50), (0.035, 0.035, 0.038), -2.85, -1.95)
    if name in FABRICS:
        return fabric("F35_" + name, *FABRICS[name])
    if name == "pilot_skin":
        mat = principled("F35_pilot_skin", (0.36, 0.20, 0.13), rough=0.48)
        b = _bsdf(mat)
        for k, v in (("Subsurface Weight", 0.25), ("Subsurface Scale", 0.004)):
            if k in b.inputs:
                b.inputs[k].default_value = v
        return mat
    if name == "nozzle":
        # outer flaps: taupe / bronze grey gunmetal (ref_02 and ref_06 of IAF jets, c26; in sun
        # the JASDF close-ups n00 / n01 read silvery grey), each flap a slightly different tone
        # (attribute 'flap_tone' 0..1 -> x0.86..1.14; 0 where the attribute is missing).  The
        # earlier reddish base at metallic 0.6 rendered pink-mauve under the sky.
        color = (0.205, 0.182, 0.158)
        mat = principled("F35_nozzle", color, rough=0.44, metal=0.35)
        nt = mat.node_tree
        b = _bsdf(mat)
        at = nt.nodes.new("ShaderNodeAttribute")
        at.attribute_type = 'GEOMETRY'
        at.attribute_name = "flap_tone"
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.inputs["To Min"].default_value = 0.86
        mr.inputs["To Max"].default_value = 1.14
        nt.links.new(at.outputs["Fac"], mr.inputs["Value"])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = 1.0
        mix.inputs[6].default_value = (*color, 1.0)
        comb = nt.nodes.new("ShaderNodeCombineColor")
        for i in range(3):
            nt.links.new(mr.outputs["Result"], comb.inputs[i])
        nt.links.new(comb.outputs["Color"], mix.inputs[7])
        nt.links.new(mix.outputs[2], b.inputs["Base Color"])
        return mat
    if name == "nozzle_ceramic":
        return sooty("F35_nozzle_ceramic", (0.56, 0.53, 0.48), (0.24, 0.21, 0.18), rough=0.7)
    table = {
        # aircraft exterior
        "edge":      dict(color=(0.098, 0.100, 0.104), rough=0.70, metal=0.1),
        "panel":     dict(color=(0.125, 0.128, 0.132), rough=0.52, metal=0.2),
        "radome":    dict(color=(0.215, 0.225, 0.235), rough=0.45, metal=0.2),
        # clear, lightly bronze-tinted transparency; the gold shows mainly in
        # reflections (ITO coating), as in photos where the pilot is plainly visible.
        # A quarter-wave film on n 1.5 glass reflects a first-order gold that pales at
        # grazing angles; the earlier 420 nm film gave a second-order red + blue peak,
        # i.e. a magenta canopy.  n 1.62 at 131 nm keeps the hue of the earlier n 1.9 /
        # 112 nm film (peak ~850 nm) but reflects ~7 % at normal incidence instead of ~17 %:
        # in c09, c34 and c53 the black bow stays solid under sky glare, and the glass reads
        # darker than the skin (c34 glass/skin luminance ~0.66; the renders gave ~0.94).
        # photo c09: the view through both walls turns amber while the reflections stay
        # near neutral (magenta-violet glints in c51 / c53), so the tint is in the transmission
        "canopy":    dict(color=(0.84, 0.72, 0.50), rough=0.02, metal=0.0,
                          transmission=1.0, ior=1.5, alpha=1.0, spec_tint=(1.0, 0.95, 0.88),
                          thin_film=131.0, film_ior=1.62),
        "canopy_frame": dict(color=(0.17, 0.18, 0.19), rough=0.45, metal=0.3),
        "canopy_bow": dict(color=(0.025, 0.025, 0.028), rough=0.5),
        "intake_dark": dict(color=(0.03, 0.03, 0.035), rough=0.7),
        # outer flaps: dark gunmetal; divergent flaps: light ceramic coating
        # (photos of the exit: a whitish-tan serrated ring inside the dark flaps)
        "nozzle_in": dict(color=(0.07, 0.065, 0.06), rough=0.6, metal=0.3),
        "bay":       dict(color=(0.78, 0.79, 0.78), rough=0.55),
        "gear":      dict(color=(0.82, 0.83, 0.82), rough=0.4, metal=0.1),
        "chrome":    dict(color=(0.8, 0.8, 0.82), rough=0.12, metal=1.0),
        "tyre":      dict(color=(0.02, 0.02, 0.02), rough=0.85),
        "hub":       dict(color=(0.66, 0.67, 0.68), rough=0.50, metal=0.0),     # painted light grey
        "light_red": dict(color=(0.6, 0.0, 0.0), rough=0.2, emission=(1, 0.05, 0.02), emission_strength=4),
        "light_green": dict(color=(0.0, 0.6, 0.0), rough=0.2, emission=(0.05, 1, 0.1), emission_strength=4),
        "light_white": dict(color=(0.9, 0.9, 0.9), rough=0.2, emission=(1, 1, 0.95), emission_strength=3),
        "marking_blue": dict(color=(0.0, 0.12, 0.45), rough=0.5),
        "marking_white": dict(color=(0.82, 0.83, 0.84), rough=0.5),
        "marking_grey": dict(color=(0.11, 0.115, 0.12), rough=0.5),
        "marking_yellow": dict(color=(0.75, 0.55, 0.05), rough=0.5),
        "marking_black": dict(color=(0.02, 0.02, 0.02), rough=0.5),
        # dark windows with an interference coating: the DAS apertures flash pink /
        # teal in photos (a ~420 nm film)
        "das_window": dict(color=(0.025, 0.025, 0.03), rough=0.06, metal=0.0, spec=0.8, thin_film=420.0),
        # EOTS window: clear faceted glass, not a dark box.  In c20, c51, c53, c13, c29, c34, c07
        # and IAF ref_03 / ref_07 the panes mirror the apron and sky, flash gold / amber, teal or
        # lavender (a high-index coating) and show the sensor or the background through them
        # (c34, c51), with light-grey frame bars.  Transmission makes it read as glass; the
        # collar between the panes and the chin skin is the same coated glass, opaque
        # A 220 nm film of n 1.9 tints the reflections a soft gold-green (c20 beige-gold, c53
        # green-grey); 280 nm at n 2.1 gave a uniform violet.  Panes are thin (solidify) over a
        # dark head ('eots_head'), so the view through them ends on the sensor, as in c34 / c51.
        # The yellow flash in the front pane in test renders is the apron's taxi line mirrored.
        "eots_glass": dict(color=(0.95, 0.95, 0.95), rough=0.03, metal=0.0, spec=1.0,
                           transmission=1.0, ior=1.76, thin_film=220.0, film_ior=1.9),
        "eots_rim":  dict(color=(0.035, 0.032, 0.03), rough=0.03, metal=0.0, spec=1.0,
                          thin_film=220.0, film_ior=1.9),
        "eots_frame": dict(color=(0.56, 0.57, 0.58), rough=0.35, metal=0.4),
        "eots_head": dict(color=(0.03, 0.03, 0.033), rough=0.45, metal=0.0),
        # the second window in the upper DAS blister: light and mirror-like (photo c13)
        "das_mirror": dict(color=(0.85, 0.87, 0.9), rough=0.04, metal=1.0),
        # cockpit
        "cockpit":   dict(color=(0.06, 0.065, 0.07), rough=0.6),
        "cockpit_panel": dict(color=(0.03, 0.03, 0.035), rough=0.5),
        "screen":    dict(color=(0.01, 0.01, 0.01), rough=0.1, emission=(0.25, 0.6, 0.9), emission_strength=1.6),
        "screen_map": dict(color=(0.01, 0.01, 0.01), rough=0.1, emission=(0.35, 0.55, 0.25), emission_strength=1.4),
        "switch":    dict(color=(0.7, 0.7, 0.7), rough=0.3, metal=0.8),
        "switch_guard": dict(color=(0.75, 0.05, 0.03), rough=0.4),
        "gear_handle": dict(color=(0.85, 0.85, 0.85), rough=0.3),
        "yellow_black": dict(color=(0.85, 0.65, 0.05), rough=0.4),
        "seat":      dict(color=(0.09, 0.10, 0.09), rough=0.7),
        "seat_cushion": dict(color=(0.16, 0.17, 0.12), rough=0.9),
        # light beige pads on the glare shield corners (photos c29, c34, c09)
        "glare_pad": dict(color=(0.62, 0.57, 0.45), rough=0.8),
        "led_green": dict(color=(0.0, 0.2, 0.0), rough=0.3, emission=(0.1, 1.0, 0.2), emission_strength=6),
        "led_amber": dict(color=(0.2, 0.1, 0.0), rough=0.3, emission=(1.0, 0.55, 0.05), emission_strength=6),
        "led_red":   dict(color=(0.2, 0.0, 0.0), rough=0.3, emission=(1.0, 0.05, 0.02), emission_strength=6),
        # pilot (IAF aircrew at Red Flag 2023: grey-sage suit and G-suit, olive vest with
        # green pouches, dark grey HMDS helmet with a smoked visor, black mask and boots)
        "harness":   dict(color=(0.030, 0.032, 0.026), rough=0.7),
        "helmet":    dict(color=(0.045, 0.047, 0.050), rough=0.40, coat=0.25),
        "visor":     dict(color=(0.020, 0.020, 0.021), rough=0.04, metal=0.7, coat=0.6),
        "boot":      dict(color=(0.025, 0.025, 0.025), rough=0.55),
        "mask":      dict(color=(0.035, 0.036, 0.034), rough=0.55),
        "hose":      dict(color=(0.04, 0.042, 0.038), rough=0.6),
        "koch":      dict(color=(0.55, 0.56, 0.57), rough=0.3, metal=0.9),
        "kneeboard": dict(color=(0.04, 0.04, 0.042), rough=0.6),
        "paper":     dict(color=(0.80, 0.80, 0.76), rough=0.9),
        "ground":    dict(color=(0.32, 0.32, 0.31), rough=0.8),
    }
    kw = table[name]
    return principled("F35_" + name, **kw)
