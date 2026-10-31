"""Animation helpers: flip a cockpit switch *and* animate what it commands.

Every switch is a property ``sw_<NAME>`` (0/1) on ``F35I_Rig``.  Drivers
already move the lever, light its LED and switch lights and displays.
Mechanical systems take time to move, so ``actuate()`` also keys the
matching control (gear, bays, canopy ...) to travel after the switch flips.

    from f35 import anim
    anim.actuate("GEAR", 0, frame=48)          # gear up, doors sequenced
    anim.actuate("CANOPY", 1, frame=200)       # canopy opens over 6 s
    anim.look(frame=300, yaw=60, pitch=-10)    # pilot looks left and down
    anim.start_up(frame=1)                     # full cockpit power-up sequence
"""
import bpy

FPS = 24

# switch -> (rig control, delay after the flip [s], travel time [s], value for switch ON, value for OFF)
SYSTEMS = {
    "GEAR": ("gear", 0.4, 6.0, 1.0, 0.0),            # lever down = gear down
    "BAY_DOORS": ("weapon_bays", 0.3, 2.0, 1.0, 0.0),
    "CANOPY": ("canopy", 0.5, 6.0, 1.0, 0.0),
    "HOOK": ("tailhook", 0.2, 1.5, 1.0, 0.0),
    "SPEEDBRAKE": ("speedbrake", 0.1, 1.2, 1.0, 0.0),
    "REFUEL_DOOR": ("refuel_door", 0.3, 2.0, 1.0, 0.0),
    "GUN_ARM": ("gun_door", 0.2, 0.6, 1.0, 0.0),
}


def _rig():
    return bpy.data.objects["F35I_Rig"]


def fcurves(action):
    """All F-curves of an action (legacy or layered actions)."""
    try:
        return list(action.fcurves)
    except Exception:
        out = []
        for layer in action.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    out.extend(cb.fcurves)
        return out


def _fcurve(arm, path):
    ad = arm.animation_data
    if not ad or not ad.action:
        return None
    for fc in fcurves(ad.action):
        if fc.data_path == path:
            return fc
    return None


def value_at(prop, frame, arm=None):
    """Value of a rig property at `frame` (from its F-curve if animated)."""
    arm = arm or _rig()
    fc = _fcurve(arm, f'["{prop}"]')
    if fc is not None:
        return fc.evaluate(frame)
    return float(arm.get(prop, 0.0))


def key(prop, value, frame, interp='BEZIER', arm=None):
    arm = arm or _rig()
    arm[prop] = value
    arm.keyframe_insert(f'["{prop}"]', frame=frame)
    fc = _fcurve(arm, f'["{prop}"]')
    if fc is not None:
        for kp in fc.keyframe_points:
            if abs(kp.co.x - frame) < 1e-3:
                kp.interpolation = interp


def move(prop, value, frame, seconds, arm=None):
    """Key `prop` to travel from its current value to `value` over `seconds`."""
    arm = arm or _rig()
    start = value_at(prop, frame, arm)
    key(prop, start, frame, 'BEZIER', arm)
    key(prop, value, frame + max(1, round(seconds * FPS)), 'BEZIER', arm)


def actuate(name, on, frame, arm=None):
    """Flip switch `name` (e.g. "GEAR") at `frame` and animate the system it commands.
    Returns the frame at which the system finishes moving."""
    arm = arm or _rig()
    prop = f"sw_{name}"
    if prop not in arm:
        raise KeyError(f"no switch {name}")
    key(prop, value_at(prop, frame - 2, arm), frame - 2, 'CONSTANT', arm)
    key(prop, 1.0 if on else 0.0, frame, 'CONSTANT', arm)
    end = frame
    sysm = SYSTEMS.get(name)
    if sysm:
        ctrl, delay, travel, v_on, v_off = sysm
        t0 = frame + round(delay * FPS)
        move(ctrl, v_on if on else v_off, t0, travel, arm)
        end = t0 + round(travel * FPS)
    return end


def look(frame, yaw=0.0, pitch=0.0, tilt=0.0, seconds=0.6, arm=None):
    """Turn the pilot's head (degrees: yaw + = left, pitch + = up)."""
    arm = arm or _rig()
    for k, v in (("head_yaw", yaw), ("head_pitch", pitch), ("head_tilt", tilt)):
        move(k, v, frame, seconds, arm)
    return frame + round(seconds * FPS)


# where the pilot looks to find a switch (head yaw, pitch in degrees)
LOOK_AT = {"panel": (0.0, -28.0), "lcon": (38.0, -38.0), "rcon": (-38.0, -38.0)}


def start_up(frame=1, arm=None, gap=0.8):
    """Cockpit power-up: battery, IPP, displays, lights, engine start ...
    The pilot looks at each console before flipping its switches."""
    arm = arm or _rig()
    seq = [("lcon", "BATT"), ("lcon", "IPP"), ("rcon", "DISPLAY"), ("lcon", "FUEL_BOOST"),
           ("lcon", "ENG_START"), ("lcon", "ANTI_COLL"), ("lcon", "POS_LT"), ("rcon", "OBOGS"),
           ("rcon", "RADAR"), ("rcon", "EW"), ("lcon", "CANOPY")]
    f = frame
    where = None
    for console, sw in seq:
        if console != where:
            yaw, pitch = LOOK_AT[console]
            f = look(f, yaw, pitch, arm=arm) + 4
            where = console
        actuate(sw, 0 if sw == "CANOPY" else 1, f, arm)     # canopy closes for start-up
        f += round(gap * FPS)
    f = look(f, 0.0, 0.0, arm=arm)
    return f
