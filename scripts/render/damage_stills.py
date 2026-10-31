"""Progress stills for the damage model: a damaged airframe (EEVEE) and the hitboxes (X-ray).

    python3 scripts/render/damage_stills.py OUT_DIR [--res 1920x1080]
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import bpy                      # noqa: E402
import build_f35i               # noqa: E402
import preview                  # noqa: E402
from f35 import destruct        # noqa: E402

DAMAGE = dict(health_wing_outer_L=0.0, health_fin_R=0.0, health_radome=0.0, health_engine=0.30,
              health_wing_root_R=0.45, health_center_fuselage=0.55, health_stab_L=0.0, health_aft_fuselage=0.6)

VIEWS = {
    "damage_front_left": ((11.0, -13.0, 4.5), (0.5, 0.5, 0.0), 45),
    "damage_rear_right": ((-10.0, 15.0, 5.0), (0.0, 2.0, 0.3), 45),
    "damage_top": ((3.0, 2.0, 22.0), (0.0, 2.0, 0.0), 45),
    "hitboxes_34": ((12.5, -12.0, 8.5), (0.0, 0.8, -0.2), 40),
    "hitboxes_side": ((27.0, 0.6, 0.4), (0.0, 0.6, 0.0), 50),
}


def _rename(out, view, name):
    src = os.path.join(out, f"prev_{view}.png")
    dst = os.path.join(out, name)
    os.replace(src, dst)
    return dst


def damaged(out, res):
    arm = bpy.data.objects["F35I_Rig"]
    sc = bpy.context.scene
    for k, v in DAMAGE.items():
        arm[k] = v
    arm.update_tag()
    sc.frame_set(1)
    destruct.impact((6.0, -1.5, 0.6), (-1, 0.1, -0.1), 120, frame=None)
    destruct.impact((-6.0, 0.5, 0.9), (1, 0.0, -0.15), 90, frame=None)
    arm.update_tag()
    sc.frame_set(1)
    preview.CAMS.update({k: VIEWS[k] for k in ("damage_front_left", "damage_rear_right", "damage_top")})
    files = []
    for v in ("damage_front_left", "damage_rear_right", "damage_top"):
        preview.render(out, [v], res=res, engine="EEVEE", samples=32)
        files.append(_rename(out, v, f"{v}.png"))
    for k in DAMAGE:
        arm[k] = 1.0
    arm.update_tag()
    sc.frame_set(1)
    return files


def hitboxes(out, res):
    """Workbench X-ray ghost of the airframe with the hitbox wires composited on top."""
    from PIL import Image
    sc = bpy.context.scene
    hb = [o for o in bpy.data.objects if o.name.startswith("HB_")]
    col = bpy.data.collections.get("Hitboxes")
    preview.CAMS.update({k: VIEWS[k] for k in ("hitboxes_34", "hitboxes_side")})
    shading = sc.display.shading
    files = []
    cd = bpy.data.cameras.new("HBCam")
    cam = bpy.data.objects.new("HBCam", cd)
    sc.collection.objects.link(cam)
    for v in ("hitboxes_34", "hitboxes_side"):
        # pass 1: airframe ghost
        col.hide_render = True
        preview.render(out, [v], res=res, engine="WORKBENCH")
        loc, tgt, lens = VIEWS[v]
        cam.location = loc
        cd.lens = lens
        cd.clip_end = 200
        preview.look_at(cam, tgt)
        sc.camera = cam
        shading.color_type = 'OBJECT'
        shading.show_xray = True
        shading.xray_alpha = 0.35
        shading.show_cavity = False
        shading.show_object_outline = True
        for o in bpy.data.objects:
            if o.type == 'MESH' and not o.name.startswith("HB_"):
                o.color = (0.55, 0.60, 0.66, 1.0)
        sc.world.color = (0.05, 0.06, 0.08)
        shading.background_type = 'WORLD'
        bpy.ops.render.render(write_still=True)
        ghost = Image.open(sc.render.filepath).convert("RGBA")
        # pass 2: hitboxes only, transparent background
        col.hide_render = False
        hidden = []
        for o in bpy.data.objects:
            if o.type in ('MESH', 'CURVE', 'FONT') and not o.name.startswith("HB_") and not o.hide_render:
                o.hide_render = True
                hidden.append(o)
        for o in hb:
            o.hide_render = False
        shading.show_xray = False
        shading.show_object_outline = False
        shading.light = 'FLAT'
        sc.render.film_transparent = True
        sc.render.image_settings.color_mode = 'RGBA'
        bpy.ops.render.render(write_still=True)
        wires = Image.open(sc.render.filepath).convert("RGBA")
        sc.render.film_transparent = False
        sc.render.image_settings.color_mode = 'RGB'
        for o in hidden:
            o.hide_render = False
        for o in hb:
            o.hide_render = True
        col.hide_render = True
        shading.light = 'STUDIO'
        img = Image.alpha_composite(ghost, wires).convert("RGB")
        dst = os.path.join(out, f"{v}.png")
        img.save(dst)
        os.remove(sc.render.filepath)
        files.append(dst)
    bpy.data.objects.remove(cam)
    return files


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    out = os.path.abspath(argv[0])
    res = (1920, 1080)
    if "--res" in argv:
        w, h = argv[argv.index("--res") + 1].split("x")
        res = (int(w), int(h))
    os.makedirs(out, exist_ok=True)
    only = argv[argv.index("--only") + 1].split(",") if "--only" in argv else ["hitboxes", "damage"]
    build_f35i.build()
    files = []
    if "hitboxes" in only:
        files += hitboxes(out, res)
    if "damage" in only:
        files += damaged(out, res)
    print("FILES", files)
