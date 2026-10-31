"""Cockpit interior: panoramic cockpit display (PCD), glare shield, consoles,
side-stick, throttle, rudder pedals, Martin-Baker US16E style seat and
operable switches.

Every operable control is a separate object whose origin is its pivot, so
the rig can drive it (see rig.py).  Switch definitions are recorded in
ctx['switches'].
"""
import math
import bmesh
import bpy
from mathutils import Vector, Matrix, Euler

from .geom import P, get_collection, mesh_object, loft_rings, add_modifier_bevel, Y0
from .textures import pcd_image
from . import materials as M

# Everything below is laid out in "design" stations and moved forward by COCKPIT_DS when placed
# (W, pilot.jp): the 3-view drawing and photo c34 put the pilot's helmet at s ~3.3, a third of the
# way back under the canopy just behind the canopy bow, with a long empty deck behind the seat.
COCKPIT_DS = -0.55
PANEL_TILT = math.radians(23.0)       # PCD face tilted back from vertical
PANEL_C = (0.0, 3.20, 0.70)           # (x, s, z) centre of the PCD face (design stations)
EYE = (0.0, 3.90, 1.13)               # design eye (s 3.35 after COCKPIT_DS)


# --------------------------------------------------------------------------
def _box_mesh(sx, sy, sz, cx=0.0, cy=0.0, cz=0.0):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [Vector((cx + dx * hx, cy + dy * hy, cz + dz * hz))
         for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6),
         (0, 2, 6, 4), (1, 5, 7, 3)]
    return v, f


def _cyl_mesh(r, h, seg=16, z0=0.0, r_top=None):
    r_top = r if r_top is None else r_top
    v, f = [], []
    for z, rr in ((z0, r), (z0 + h, r_top)):
        for i in range(seg):
            a = 2 * math.pi * i / seg
            v.append(Vector((rr * math.cos(a), rr * math.sin(a), z)))
    for i in range(seg):
        i1 = (i + 1) % seg
        f.append((i, i1, seg + i1, seg + i))
    f.append(tuple(range(seg - 1, -1, -1)))
    f.append(tuple(range(seg, 2 * seg)))
    return v, f


def _sphere_mesh(r, seg=12, rings=8, c=(0, 0, 0)):
    v, f = [Vector((c[0], c[1], c[2] + r))], []
    for i in range(1, rings):
        th = math.pi * i / rings
        for j in range(seg):
            ph = 2 * math.pi * j / seg
            v.append(Vector((c[0] + r * math.sin(th) * math.cos(ph),
                             c[1] + r * math.sin(th) * math.sin(ph),
                             c[2] + r * math.cos(th))))
    v.append(Vector((c[0], c[1], c[2] - r)))
    for j in range(seg):
        f.append((0, 1 + j, 1 + (j + 1) % seg))
    for i in range(rings - 2):
        a, b = 1 + i * seg, 1 + (i + 1) * seg
        for j in range(seg):
            j1 = (j + 1) % seg
            f.append((a + j, b + j, b + j1, a + j1))
    last = len(v) - 1
    base = 1 + (rings - 2) * seg
    for j in range(seg):
        f.append((base + j, last, base + (j + 1) % seg))
    return v, f


def _merge(parts):
    V, F = [], []
    for v, f in parts:
        o = len(V)
        V.extend(v)
        F.extend(tuple(i + o for i in face) for face in f)
    return V, F


def _obj(name, vf, coll, mat, loc=(0, 0, 0), rot=(0, 0, 0), smooth=False, bevel=0.0):
    v, f = vf
    ob = mesh_object(name, v, f, coll, mat, smooth=smooth)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.location = loc
    ob.rotation_euler = rot
    if bevel > 0:
        add_modifier_bevel(ob, bevel, 2, 30)
    return ob


def W(x, s, z):
    """Cockpit design coordinates (x, s, z) -> world, moved forward by COCKPIT_DS."""
    return Vector(P(s + COCKPIT_DS, x, z))


def panel_frame(u, v, d=0.0):
    """Point on the (tilted) main panel plane: u lateral, v up the panel."""
    c = W(*PANEL_C)
    up = Vector((0, -math.sin(PANEL_TILT), math.cos(PANEL_TILT)))
    nrm = Vector((0, math.cos(PANEL_TILT), math.sin(PANEL_TILT)))
    return c + Vector((u, 0, 0)) + up * v + nrm * d


# --------------------------------------------------------------------------
SWITCHES = [
    # name, location (x, s, z) or panel (u, v), surface, type, label
    ("GEAR", ("panel", 0.33, -0.205), "gear", "LANDING GEAR"),
    ("EMER_JETT", ("panel", 0.18, -0.215), "button", "EMERGENCY JETTISON"),
    ("MASTER_ARM", ("panel", -0.17, -0.205), "guarded", "MASTER ARM"),
    ("HOOK", ("panel", -0.32, -0.205), "handle", "ARRESTING HOOK"),
    ("PARK_BRAKE", ("panel", 0.24, -0.255), "toggle", "PARKING BRAKE"),
    ("BAY_DOORS", ("panel", -0.24, -0.255), "toggle", "WEAPON BAY DOORS"),
    # left console (+X)
    ("BATT", ("lcon", 0.425, 3.98), "toggle", "BATTERY"),
    ("IPP", ("lcon", 0.385, 3.98), "toggle", "INTEGRATED POWER PACKAGE"),
    ("ENG_START", ("lcon", 0.345, 3.98), "guarded", "ENGINE START"),
    ("FUEL_BOOST", ("lcon", 0.425, 4.08), "toggle", "FUEL BOOST PUMPS"),
    ("ANTI_COLL", ("lcon", 0.385, 4.08), "toggle", "ANTI-COLLISION LIGHT"),
    ("POS_LT", ("lcon", 0.345, 4.08), "toggle", "POSITION LIGHTS"),
    ("FORM_LT", ("lcon", 0.425, 4.18), "toggle", "FORMATION LIGHTS"),
    ("LDG_LT", ("lcon", 0.385, 4.18), "toggle", "LANDING / TAXI LIGHT"),
    ("CANOPY", ("lcon", 0.345, 4.18), "toggle", "CANOPY OPEN / CLOSE"),
    # right console (-X)
    ("DISPLAY", ("rcon", -0.345, 3.98), "toggle", "DISPLAY POWER"),
    ("RADAR", ("rcon", -0.385, 3.98), "toggle", "RADAR"),
    ("EW", ("rcon", -0.425, 3.98), "toggle", "ELECTRONIC WARFARE"),
    ("OBOGS", ("rcon", -0.345, 4.08), "toggle", "ON-BOARD OXYGEN"),
    ("DEFOG", ("rcon", -0.385, 4.08), "toggle", "CANOPY DEFOG"),
    ("NOZZLE_AB", ("rcon", -0.425, 4.08), "toggle", "AFTERBURNER ARM"),
    ("GUN_ARM", ("rcon", -0.345, 4.18), "guarded", "GUN ARM"),
    ("SPEEDBRAKE", ("rcon", -0.385, 4.18), "toggle", "SPEED BRAKE (SPLIT RUDDERS)"),
    ("REFUEL_DOOR", ("rcon", -0.425, 4.18), "toggle", "AIR REFUELLING DOOR"),
]

CONSOLE_Z = 0.585


def _switch_place(spec):
    kind = spec[0]
    if kind == "panel":
        _, u, v = spec
        loc = panel_frame(u, v, 0.012)
        # lever stands normal to the panel: rotate local +Z onto the panel normal
        nrm = Vector((0, math.cos(PANEL_TILT), math.sin(PANEL_TILT)))
        rot = Vector((0, 0, 1)).rotation_difference(nrm).to_euler()
        return loc, rot
    _, x, s = spec
    return W(x, s, CONSOLE_Z + 0.012), Euler((0, 0, 0))


def _toggle_lever(name, coll, kind):
    """Lever pointing +Z from the pivot; rotate about local X to toggle."""
    if kind == "gear":
        shaft = _cyl_mesh(0.007, 0.075)
        # wheel-shaped knob
        wheel = []
        seg = 14
        knob_v, knob_f = [], []
        tor = _cyl_mesh(0.022, 0.012, seg=seg, z0=-0.006)
        rotm = Matrix.Rotation(math.radians(90), 4, 'Y')
        tv = [rotm @ v + Vector((0, 0, 0.085)) for v in tor[0]]
        parts = [shaft, (tv, tor[1])]
        return _merge(parts), M.get("gear_handle")
    if kind == "handle":
        shaft = _cyl_mesh(0.006, 0.06)
        grip = _box_mesh(0.05, 0.016, 0.016, 0, 0, 0.065)
        return _merge([shaft, grip]), M.get("yellow_black")
    if kind == "button":
        cap = _cyl_mesh(0.012, 0.012, seg=16)
        return _merge([cap]), M.get("switch_guard")
    shaft = _cyl_mesh(0.0028, 0.022, seg=10)
    tip = _sphere_mesh(0.0045, seg=10, rings=6, c=(0, 0, 0.024))
    return _merge([shaft, tip]), M.get("switch")


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Cockpit", root)
    objs = {}
    # ---------------------------------------------------------------- panel
    panel_body = _obj("Cockpit_Panel", _box_mesh(0.64, 0.14, 0.36), coll,
                      M.get("cockpit_panel"), loc=panel_frame(0, -0.03, -0.075),
                      rot=(PANEL_TILT, 0, 0), bevel=0.006)
    # PCD screen with emissive display page
    img = pcd_image()
    scr_mat = bpy.data.materials.new("F35_PCD_Screen")
    scr_mat.use_nodes = True
    nt = scr_mat.node_tree
    b = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_type = 'OBJECT'
    attr.attribute_name = "power"
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = 2.2
    nt.links.new(attr.outputs["Fac"], mul.inputs[0])
    nt.links.new(tex.outputs["Color"], b.inputs["Emission Color"])
    nt.links.new(mul.outputs[0], b.inputs["Emission Strength"])
    b.inputs["Base Color"].default_value = (0.005, 0.005, 0.006, 1)
    b.inputs["Roughness"].default_value = 0.08
    sw, sh = 0.508, 0.203
    v = [panel_frame(-sw / 2, -sh / 2, 0.004), panel_frame(sw / 2, -sh / 2, 0.004),
         panel_frame(sw / 2, sh / 2, 0.004), panel_frame(-sw / 2, sh / 2, 0.004)]
    scr = mesh_object("PCD_Screen", v, [(0, 1, 2, 3)], coll, scr_mat, smooth=False)
    uv = scr.data.uv_layers.new(name="UVMap")
    # +X is the aircraft's left: from the pilot's view left is +X -> u=0 at +X
    for loop, (uu, vv) in zip(scr.data.loops, [(1, 0), (0, 0), (0, 1), (1, 1)]):
        uv.data[loop.index].uv = (uu, vv)
    scr["power"] = 1.0
    # bezel
    bz = []
    t = 0.018
    for (u0, v0, u1, v1) in ((-sw / 2 - t, sh / 2, sw / 2 + t, sh / 2 + t),
                             (-sw / 2 - t, -sh / 2 - t, sw / 2 + t, -sh / 2),
                             (-sw / 2 - t, -sh / 2, -sw / 2, sh / 2),
                             (sw / 2, -sh / 2, sw / 2 + t, sh / 2),
                             (-0.004, -sh / 2, 0.004, sh / 2)):
        q = [panel_frame(u0, v0, 0.008), panel_frame(u1, v0, 0.008),
             panel_frame(u1, v1, 0.008), panel_frame(u0, v1, 0.008),
             panel_frame(u0, v0, 0.0), panel_frame(u1, v0, 0.0),
             panel_frame(u1, v1, 0.0), panel_frame(u0, v1, 0.0)]
        bz.append((q, [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2),
                       (2, 6, 7, 3), (3, 7, 4, 0)]))
    _obj("PCD_Bezel", _merge(bz), coll, M.get("cockpit"))
    # glare shield (hood over the display)
    gs = _obj("Glareshield", _box_mesh(0.56, 0.22, 0.03), coll, M.get("cockpit"),
              loc=panel_frame(0, 0.135, 0.075), rot=(math.radians(10), 0, 0), bevel=0.01)
    # lower switch panel
    lp = _obj("Cockpit_LowerPanel", _box_mesh(0.78, 0.10, 0.10), coll,
              M.get("cockpit_panel"), loc=panel_frame(0, -0.215, -0.04),
              rot=(PANEL_TILT, 0, 0), bevel=0.004)
    # side consoles
    for side, tag in ((1, "L"), (-1, "R")):
        _obj(f"Console_{tag}", _box_mesh(0.17, 0.92, 0.30), coll, M.get("cockpit_panel"),
             loc=W(side * 0.385, 3.845, CONSOLE_Z - 0.15), bevel=0.006)
    # rudder pedals (each a separate object with pivot)
    for side, tag in ((1, "L"), (-1, "R")):
        v1, f1 = _box_mesh(0.09, 0.02, 0.16, 0, 0, 0.0)
        arm = _cyl_mesh(0.008, 0.20)
        rotm = Matrix.Rotation(math.radians(90), 4, 'X')
        av = [rotm @ vv + Vector((0, 0, 0.07)) for vv in arm[0]]
        ped = _obj(f"Pedal_{tag}", _merge([(v1, f1), (av, arm[1])]), coll,
                   M.get("switch"), loc=W(side * 0.14, 2.86, 0.22))
        objs[f"Pedal_{tag}"] = ped
    # ---------------------------------------------------------- throttle
    thr_base = _obj("Throttle_Base", _box_mesh(0.07, 0.28, 0.02), coll, M.get("cockpit"),
                    loc=W(0.37, 3.60, CONSOLE_Z + 0.01))
    lever = _cyl_mesh(0.010, 0.13)
    grip = _box_mesh(0.045, 0.085, 0.06, 0.012, -0.01, 0.15)
    btns = _box_mesh(0.012, 0.02, 0.012, -0.012, -0.045, 0.165)
    thr = _obj("Throttle", _merge([lever, grip, btns]), coll, M.get("cockpit"),
               loc=W(0.37, 3.64, CONSOLE_Z + 0.02), bevel=0.004)
    objs["Throttle"] = thr
    # ---------------------------------------------------------- side-stick
    boot = _cyl_mesh(0.035, 0.04, seg=18, r_top=0.022)
    _obj("Stick_Boot", boot, coll, M.get("cockpit"), loc=W(-0.375, 3.66, CONSOLE_Z + 0.0),
         smooth=True)
    shaft = _cyl_mesh(0.012, 0.06)
    g = _cyl_mesh(0.021, 0.10, seg=16, z0=0.06, r_top=0.019)
    hat = _sphere_mesh(0.010, c=(0, -0.012, 0.165))
    stick = _obj("Stick", _merge([shaft, g, hat]), coll, M.get("cockpit"),
                 loc=W(-0.375, 3.66, CONSOLE_Z + 0.03), rot=(math.radians(-8), 0, 0),
                 smooth=True)
    objs["Stick"] = stick
    # ---------------------------------------------------------- seat
    seat = build_seat(coll)
    objs.update(seat)
    build_aft_deck(coll)
    # ---------------------------------------------------------- switches
    switches = []
    for name, spec, kind, label in SWITCHES:
        loc, rot = _switch_place(spec)
        # base collar / guard
        base_v, base_f = _cyl_mesh(0.009 if kind != "gear" else 0.016, 0.006, seg=14)
        base = _obj(f"SWB_{name}", (base_v, base_f), coll, M.get("cockpit"), loc=loc, rot=rot)
        (lv, lf), mat = _toggle_lever(f"SW_{name}", coll, kind)
        lev = _obj(f"SW_{name}", (lv, lf), coll, mat, loc=loc, rot=rot, smooth=True)
        lev["switch"] = name
        lev["label"] = label
        lev["kind"] = kind
        rec = {"name": name, "object": lev.name, "kind": kind, "label": label,
               "rest_rot": tuple(rot)}
        # status LED next to the switch
        nrm = rot.to_matrix() @ Vector((0, 0, 1))
        side_off = rot.to_matrix() @ Vector((0.0, 0.022, 0.0))
        led_v, led_f = _sphere_mesh(0.004, seg=8, rings=5)
        led = _obj(f"LED_{name}", (led_v, led_f), coll, led_material(),
                   loc=loc + side_off + nrm * 0.004)
        led["on"] = 0.0
        rec["led"] = led.name
        if kind == "guarded":
            gv, gf = _box_mesh(0.026, 0.034, 0.002, 0, 0.017, 0.0)
            gv2, gf2 = _box_mesh(0.002, 0.034, 0.022, 0.012, 0.017, -0.011)
            gv3, gf3 = _box_mesh(0.002, 0.034, 0.022, -0.012, 0.017, -0.011)
            gm = Matrix.Translation((0, -0.017, 0.034))
            gverts = [gm @ v for v in gv] + [gm @ v for v in gv2] + [gm @ v for v in gv3]
            n1, n2 = len(gv), len(gv) + len(gv2)
            gfaces = gf + [tuple(i + n1 for i in f) for f in gf2] + [tuple(i + n2 for i in f) for f in gf3]
            guard = _obj(f"SWG_{name}", (gverts, gfaces), coll, M.get("switch_guard"),
                         loc=loc + (rot.to_matrix() @ Vector((0, -0.017, 0.0))), rot=rot)
            rec["guard"] = guard.name
        switches.append(rec)
    ctx["switches"] = switches
    ctx["objects"].update(objs)
    ctx["objects"]["PCD_Screen"] = scr
    return objs


_LED = None


def led_material():
    global _LED
    if _LED is not None and _LED.name in bpy.data.materials:
        return _LED
    mat = bpy.data.materials.new("F35_SwitchLED")
    mat.use_nodes = True
    nt = mat.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.02, 0.05, 0.02, 1)
    b.inputs["Emission Color"].default_value = (0.15, 1.0, 0.25, 1)
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_type = 'OBJECT'
    attr.attribute_name = "on"
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = 8.0
    nt.links.new(attr.outputs["Fac"], mul.inputs[0])
    nt.links.new(mul.outputs[0], b.inputs["Emission Strength"])
    _LED = mat
    return mat


def build_aft_deck(coll):
    """Deck behind the seat under the long aft canopy (photo c34: dark grey, just above the sill,
    running back to the canopy's rear frame) with an equipment box on it.  World stations: it
    belongs to the airframe, not to the cockpit design layout."""
    from .canopy import SILL_W
    from .fuselage import fore_upper_z, cockpit_half_width
    s0, s1, n = 3.66, 4.93, 14
    rings = []
    for i in range(n + 1):
        s = s0 + (s1 - s0) * i / n
        w = min(cockpit_half_width(s), SILL_W(s)) - 0.006
        z = fore_upper_z(s, min(SILL_W(s), 0.85)) + 0.02
        rings.append([P(s, -w, z), P(s, w, z), P(s, w, z - 0.03), P(s, -w, z - 0.03)])
    v, f = loft_rings(rings, True, True, True)
    deck = mesh_object("Cockpit_AftDeck", v, f, coll, M.get("cockpit"), smooth=False)
    bm = bmesh.new()
    bm.from_mesh(deck.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(deck.data)
    bm.free()
    zb = fore_upper_z(4.30, min(SILL_W(4.30), 0.85)) + 0.02
    box = _obj("Cockpit_AftBox", _box_mesh(0.34, 0.30, 0.09), coll, M.get("cockpit_panel"),
               loc=Vector(P(4.30, 0.0, zb + 0.045)), bevel=0.01)
    return [deck, box]


def build_seat(coll):
    """Martin-Baker US16E style ejection seat (simplified)."""
    objs = {}
    parts = []
    s_pan_f, s_pan_b, z_pan = 3.55, 3.97, 0.40
    # seat pan (bucket bottom)
    parts.append(_box_mesh(0.44, s_pan_b - s_pan_f, 0.10, 0, 0, 0))
    pan_loc = W(0, (s_pan_f + s_pan_b) / 2, z_pan - 0.05)
    pan = _obj("Seat_Pan", parts[0], coll, M.get("seat"), loc=pan_loc, bevel=0.012)
    # back (reclined ~18 deg)
    rec = math.radians(18)
    back = _obj("Seat_Back", _box_mesh(0.46, 0.10, 0.82), coll, M.get("seat"),
                loc=W(0, 4.12, 0.80), rot=(-rec, 0, 0), bevel=0.012)
    # headbox with drogue container
    head = _obj("Seat_Headbox", _box_mesh(0.30, 0.18, 0.24), coll, M.get("seat"),
                loc=W(0, 4.33, 1.16), rot=(-rec, 0, 0), bevel=0.02)
    # side rails / guide rails
    for side in (1, -1):
        _obj(f"Seat_Rail_{'L' if side > 0 else 'R'}", _box_mesh(0.035, 0.07, 1.05), coll,
             M.get("seat"), loc=W(side * 0.235, 4.15, 0.82), rot=(-rec, 0, 0), bevel=0.006)
        _obj(f"Seat_Side_{'L' if side > 0 else 'R'}", _box_mesh(0.03, 0.40, 0.17), coll,
             M.get("seat"), loc=W(side * 0.235, 3.78, 0.46), bevel=0.006)
    # cushions
    _obj("Seat_Cushion", _box_mesh(0.40, 0.38, 0.05), coll, M.get("seat_cushion"),
         loc=W(0, 3.76, z_pan + 0.025), bevel=0.015)
    _obj("Seat_BackCushion", _box_mesh(0.38, 0.05, 0.62), coll, M.get("seat_cushion"),
         loc=W(0, 4.035, 0.80), rot=(-rec, 0, 0), bevel=0.015)
    # ejection handle (yellow/black loop) at the front of the seat pan
    loop = _cyl_mesh(0.009, 0.16, seg=10)
    rotm = Matrix.Rotation(math.radians(90), 4, 'Y')
    lv = [rotm @ v + Vector((-0.08, 0, 0)) for v in loop[0]]
    l2 = _cyl_mesh(0.009, 0.06, seg=10)
    l2v = [v + Vector((-0.08, 0, -0.06)) for v in l2[0]]
    l3v = [v + Vector((0.08, 0, -0.06)) for v in l2[0]]
    ej = _obj("Seat_EjectHandle", _merge([(lv, loop[1]), (l2v, l2[1]), (l3v, l2[1])]), coll,
              M.get("yellow_black"), loc=W(0, 3.54, 0.43))
    objs["Seat_EjectHandle"] = ej
    return objs
