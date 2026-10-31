"""Procedural materials for the F-35I model (Cycles + EEVEE compatible)."""
import bpy

_CACHE = {}


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
               spec=0.5):
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
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        try:
            mat.surface_render_method = 'BLENDED'
        except Exception:
            pass
    mat.diffuse_color = (*color, alpha)
    return mat


def skin_material():
    """Radar-absorbent 'Have Glass' grey with subtle panel mottling."""
    mat = _new("F35_Skin_RAM")
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    b = nodes["Principled BSDF"]
    base = (0.205, 0.215, 0.225)
    tc = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 2.2
    noise.inputs["Detail"].default_value = 6.0
    noise.inputs["Roughness"].default_value = 0.6
    links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (base[0] * 0.86, base[1] * 0.86, base[2] * 0.88, 1)
    ramp.color_ramp.elements[1].position = 0.70
    ramp.color_ramp.elements[1].color = (base[0] * 1.10, base[1] * 1.10, base[2] * 1.10, 1)
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    # roughness variation (Have Glass coatings have a soft metallic sheen)
    rr = nodes.new("ShaderNodeMapRange")
    rr.inputs["To Min"].default_value = 0.38
    rr.inputs["To Max"].default_value = 0.55
    links.new(noise.outputs["Fac"], rr.inputs["Value"])
    links.new(rr.outputs["Result"], b.inputs["Roughness"])
    b.inputs["Metallic"].default_value = 0.35
    b.inputs["Specular IOR Level"].default_value = 0.45
    # fine grain bump
    n2 = nodes.new("ShaderNodeTexNoise")
    n2.inputs["Scale"].default_value = 180.0
    links.new(tc.outputs["Object"], n2.inputs["Vector"])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.04
    links.new(n2.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], b.inputs["Normal"])
    mat.diffuse_color = (*base, 1)
    return mat


def get(name):
    if name in _CACHE and _CACHE[name].name in bpy.data.materials:
        return _CACHE[name]
    m = _make(name)
    _CACHE[name] = m
    return m


def _make(name):
    if name == "skin":
        return skin_material()
    table = {
        # aircraft exterior
        "edge":      dict(color=(0.16, 0.17, 0.18), rough=0.45, metal=0.3),
        "panel":     dict(color=(0.19, 0.20, 0.21), rough=0.50, metal=0.3),
        "radome":    dict(color=(0.215, 0.225, 0.235), rough=0.45, metal=0.2),
        "canopy":    dict(color=(0.55, 0.42, 0.18), rough=0.03, metal=0.0,
                          transmission=1.0, ior=1.5, alpha=1.0),
        "canopy_frame": dict(color=(0.17, 0.18, 0.19), rough=0.45, metal=0.3),
        "intake":    dict(color=(0.85, 0.85, 0.83), rough=0.6),
        "intake_dark": dict(color=(0.03, 0.03, 0.035), rough=0.7),
        "nozzle":    dict(color=(0.22, 0.20, 0.18), rough=0.55, metal=0.6),
        "nozzle_in": dict(color=(0.30, 0.22, 0.16), rough=0.4, metal=0.8),
        "bay":       dict(color=(0.78, 0.79, 0.78), rough=0.55),
        "gear":      dict(color=(0.82, 0.83, 0.82), rough=0.4, metal=0.1),
        "chrome":    dict(color=(0.8, 0.8, 0.82), rough=0.12, metal=1.0),
        "tyre":      dict(color=(0.02, 0.02, 0.02), rough=0.85),
        "hub":       dict(color=(0.55, 0.56, 0.57), rough=0.35, metal=0.8),
        "light_red": dict(color=(0.6, 0.0, 0.0), rough=0.2, emission=(1, 0.05, 0.02), emission_strength=4),
        "light_green": dict(color=(0.0, 0.6, 0.0), rough=0.2, emission=(0.05, 1, 0.1), emission_strength=4),
        "light_white": dict(color=(0.9, 0.9, 0.9), rough=0.2, emission=(1, 1, 0.95), emission_strength=3),
        "marking_blue": dict(color=(0.0, 0.12, 0.45), rough=0.5),
        "marking_white": dict(color=(0.82, 0.83, 0.84), rough=0.5),
        "marking_grey": dict(color=(0.11, 0.115, 0.12), rough=0.5),
        "marking_yellow": dict(color=(0.75, 0.55, 0.05), rough=0.5),
        "marking_black": dict(color=(0.02, 0.02, 0.02), rough=0.5),
        "das_window": dict(color=(0.05, 0.04, 0.03), rough=0.05, metal=0.5),
        "eots_glass": dict(color=(0.30, 0.22, 0.10), rough=0.03, metal=0.6),
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
        "led_green": dict(color=(0.0, 0.2, 0.0), rough=0.3, emission=(0.1, 1.0, 0.2), emission_strength=6),
        "led_amber": dict(color=(0.2, 0.1, 0.0), rough=0.3, emission=(1.0, 0.55, 0.05), emission_strength=6),
        "led_red":   dict(color=(0.2, 0.0, 0.0), rough=0.3, emission=(1.0, 0.05, 0.02), emission_strength=6),
        # pilot
        "flightsuit": dict(color=(0.20, 0.21, 0.13), rough=0.85),
        "gsuit":     dict(color=(0.16, 0.17, 0.10), rough=0.85),
        "harness":   dict(color=(0.05, 0.05, 0.05), rough=0.7),
        "helmet":    dict(color=(0.08, 0.085, 0.09), rough=0.35, coat=0.4),
        "visor":     dict(color=(0.04, 0.03, 0.02), rough=0.02, metal=0.9),
        "glove":     dict(color=(0.13, 0.11, 0.08), rough=0.7),
        "boot":      dict(color=(0.03, 0.03, 0.03), rough=0.6),
        "mask":      dict(color=(0.08, 0.08, 0.08), rough=0.5),
        "ground":    dict(color=(0.32, 0.32, 0.31), rough=0.8),
    }
    kw = table[name]
    return principled("F35_" + name, **kw)
