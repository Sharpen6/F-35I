"""Build the F-35I 'Adir' model from scratch.

Run headless:
    python3 scripts/build_f35i.py --out blend/F-35I_Adir.blend
or inside Blender's Python console / Blender MCP:
    exec(open(r'.../scripts/build_f35i.py').read())
"""
import os
import sys
import importlib

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402

ALL_PARTS = ["fuselage", "wings", "tails", "nozzle", "canopy", "cockpit",
             "gear", "bays", "details", "pilot", "markings", "rig",
             "damage", "scene"]


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def _reload():
    import f35
    for name in list(sys.modules):
        if name.startswith("f35"):
            importlib.reload(sys.modules[name])


def build(parts=None, reload=True):
    if reload:
        _reload()
    from f35 import geom, materials
    from f35 import assemble
    reset_scene()
    materials._CACHE.clear()
    return assemble.build_all(parts or ALL_PARTS)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    out = None
    parts = None
    i = 0
    while i < len(argv):
        if argv[i] == "--out":
            out = argv[i + 1]
            i += 2
        elif argv[i] == "--parts":
            parts = argv[i + 1].split(",")
            i += 2
        else:
            i += 1
    info = build(parts)
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(out), compress=True)
        print("SAVED", out)
    print("BUILD_INFO", info)
