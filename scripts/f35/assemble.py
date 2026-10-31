"""Top level assembly: builds every part into named collections."""
import time
import bpy

from .geom import get_collection


def build_all(parts):
    t0 = time.time()
    root = get_collection("F-35I_Adir")
    helpers = get_collection("Helpers", root)
    helpers.hide_render = True
    info = {}
    ctx = {"root": root, "helpers": helpers, "objects": {}}

    if "fuselage" in parts:
        from . import fuselage
        col = get_collection("Airframe", root)
        ctx["objects"]["Fuselage"] = fuselage.build(col, helpers)
    if "wings" in parts:
        from . import wings
        wings.build(ctx)
        if "fuselage" in parts:          # lower wing-root fillets (blend wing and body)
            from . import fillets
            fillets.build(ctx)
    if "tails" in parts:
        from . import tails
        tails.build(ctx)
    if "nozzle" in parts:
        from . import nozzle
        nozzle.build(ctx)
    if "canopy" in parts:
        from . import canopy
        canopy.build(ctx)
    if "cockpit" in parts:
        from . import cockpit
        cockpit.build(ctx)
    if "bays" in parts:
        from . import bays
        bays.build(ctx)
    if "gear" in parts:
        from . import gear
        gear.build(ctx)
    if "details" in parts:
        from . import details
        details.build(ctx)
    if "pilot" in parts:
        from . import pilot
        pilot.build(ctx)
    if "markings" in parts:
        from . import markings
        markings.build(ctx)
    if "panels" in parts:            # rest-pose attributes + panel maps (before parts move or break)
        from . import panels
        info["panels"] = panels.build(ctx)
    if "damage" in parts:            # fracture breakable parts before the rig parents them
        from . import destruct
        destruct.prepare(ctx)
    if "rig" in parts:
        from . import rig
        rig.build(ctx)
    if "damage" in parts and "rig" in parts:
        from . import destruct
        info["damage"] = destruct.build(ctx)
    if "scene" in parts:
        from . import scene
        scene.build(ctx)
    info["objects"] = len(bpy.data.objects)
    info["seconds"] = round(time.time() - t0, 1)
    return info
