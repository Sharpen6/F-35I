"""Presentation scene: physical sky + sun, concrete apron, named cameras,
render settings (Cycles by default, EEVEE ready)."""
import math
import bpy
from mathutils import Vector

from .geom import GROUND_Z, get_collection, mesh_object

CAMERAS = {
    # name: (location, target, lens)
    "Cam_Hero_FrontLeft": ((10.5, -15.0, 0.4), (0.3, -1.0, -0.2), 55),
    "Cam_Hero_FrontRight": ((-10.5, -15.0, 0.4), (-0.3, -1.0, -0.2), 55),
    "Cam_Side_Left": ((24.0, 0.2, -0.2), (0.0, 0.2, -0.2), 50),
    "Cam_Rear_Quarter": ((-9.5, 15.5, 1.8), (0.0, 1.5, 0.0), 50),
    "Cam_Top": ((0.0, 0.0, 34.0), (0.0, 0.0, 0.0), 45),
    "Cam_Front_Low": ((0.0, -19.0, -0.9), (0.0, 0.0, -0.4), 60),
    "Cam_Cockpit_Over": ((0.95, -2.6, 2.35), (0.0, -4.2, 0.65), 28),
    "Cam_Cockpit_Pilot": ((0.0, -3.95, 1.14), (0.0, -5.2, 0.62), 18),
    "Cam_Gear_Main": ((-5.6, -1.0, -1.25), (-1.9, 2.3, -0.9), 32),
    "Cam_Gear_Nose": ((-2.6, -7.6, -1.1), (0.0, -3.6, -0.9), 35),
    "Cam_Belly": ((-3.0, -4.0, -1.55), (0.0, 1.5, -0.8), 22),
    "Cam_Nozzle": ((-4.2, 12.5, 0.6), (0.0, 6.2, 0.15), 45),
}


def _look(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def concrete_material():
    mat = bpy.data.materials.get("F35_Apron") or bpy.data.materials.new("F35_Apron")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 0.35
    noise.inputs["Detail"].default_value = 8.0
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.30, 0.30, 0.29, 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (0.46, 0.45, 0.43, 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    # 5 m slabs with dark expansion joints
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.offset = 0.0
    brick.squash = 1.0
    brick.inputs["Scale"].default_value = 0.2
    brick.inputs["Mortar Size"].default_value = 0.004
    brick.inputs["Brick Width"].default_value = 1.0
    brick.inputs["Row Height"].default_value = 1.0
    brick.inputs["Color1"].default_value = (1, 1, 1, 1)
    brick.inputs["Color2"].default_value = (0.95, 0.95, 0.95, 1)
    brick.inputs["Mortar"].default_value = (0.25, 0.25, 0.25, 1)
    nt.links.new(tc.outputs["Object"], brick.inputs["Vector"])
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs["Factor"].default_value = 1.0
    nt.links.new(ramp.outputs["Color"], mul.inputs["A"])
    nt.links.new(brick.outputs["Color"], mul.inputs["B"])
    nt.links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.88
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.15
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    mat.diffuse_color = (0.38, 0.38, 0.37, 1)
    return mat


SUN_ELEV, SUN_ROT = 48.0, 200.0       # mid-morning desert sun (deg)


def build_world(sun_elev=SUN_ELEV, sun_rot=SUN_ROT, strength=0.05):
    sc = bpy.context.scene
    world = bpy.data.worlds.get("F35_World") or bpy.data.worlds.new("F35_World")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexSky")
    try:
        sky.sky_type = 'MULTIPLE_SCATTERING'
    except Exception:
        sky.sky_type = 'NISHITA'
    sky.sun_elevation = math.radians(sun_elev)
    sky.sun_rotation = math.radians(sun_rot)
    sky.sun_disc = False
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return world


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Scene", root)
    sc = bpy.context.scene
    build_world()
    # sun matching the sky
    sd = bpy.data.lights.new("Sun", 'SUN')
    sd.energy = 4.0
    sd.angle = math.radians(0.6)
    sun = bpy.data.objects.new("Sun", sd)
    coll.objects.link(sun)
    sun.rotation_euler = (math.radians(90 - SUN_ELEV), 0.0, math.radians(SUN_ROT - 90.0))
    # apron
    R = 220.0
    z = GROUND_Z
    ground = mesh_object("Ground_Apron", [(-R, -R, z), (R, -R, z), (R, R, z), (-R, R, z)], [(0, 1, 2, 3)],
                         coll, concrete_material(), smooth=False)
    ground["is_ground"] = True
    # cameras
    cams = get_collection("Cameras", root)
    first = None
    for name, (loc, tgt, lens) in CAMERAS.items():
        cd = bpy.data.cameras.new(name)
        cd.lens = lens
        cd.clip_start = 0.05
        cd.clip_end = 1000
        cam = bpy.data.objects.new(name, cd)
        cams.objects.link(cam)
        cam.location = loc
        _look(cam, tgt)
        first = first or cam
    # turntable rig: empty at the aircraft centre, camera on a 19 m radius
    piv = bpy.data.objects.new("Turntable_Pivot", None)
    cams.objects.link(piv)
    piv.location = (0.0, 0.3, -0.4)
    cd = bpy.data.cameras.new("Cam_Turntable")
    cd.lens = 50
    tt = bpy.data.objects.new("Cam_Turntable", cd)
    cams.objects.link(tt)
    tt.parent = piv
    tt.location = (0.0, -19.5, 3.4)
    tt.rotation_euler = (math.radians(81.5), 0, 0)
    piv["turntable_frames"] = 240
    fc_owner = piv
    piv.rotation_euler = (0, 0, 0)
    piv.keyframe_insert("rotation_euler", index=2, frame=1)
    piv.rotation_euler = (0, 0, 2 * math.pi)
    piv.keyframe_insert("rotation_euler", index=2, frame=241)
    try:
        for fc in piv.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'
    except Exception:
        try:
            for layer in piv.animation_data.action.layers:
                for strip in layer.strips:
                    for cb in strip.channelbags:
                        for fc in cb.fcurves:
                            for kp in fc.keyframe_points:
                                kp.interpolation = 'LINEAR'
        except Exception:
            pass
    sc.camera = bpy.data.objects["Cam_Hero_FrontLeft"]
    # render defaults
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    sc.render.fps = 24
    sc.frame_start, sc.frame_end = 1, 240
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 160
    sc.cycles.use_denoising = True
    try:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except Exception:
        try:
            sc.view_settings.look = 'Medium High Contrast'
        except Exception:
            pass
    ctx["objects"]["Ground_Apron"] = ground
    return ground
