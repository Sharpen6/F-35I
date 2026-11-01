"""Reference data for the app, read from the built model at its rest pose (gear down, everything
at default).  Points are in the BODY frame (+X right, +Y up, -Z forward, origin = the model's
reference point, Blender (0, 0, 0)) unless a key says model."""
import math

import bpy
import numpy as np
from mathutils import Vector

from common import log, b2body, b2m, rnd

WHEELS = (("nose", "NG_Wheel", "NG_Steer"), ("left", "MG_Wheel_L", "MG_Oleo_L"),
          ("right", "MG_Wheel_R", "MG_Oleo_R"))


def eye_point():
    """Between the seated pilot's corneas (helmet frame of scripts/pilot/helmet.py), Blender frame."""
    from f35 import pilot as FP
    from pilot import skeleton as S, helmet as H
    t = FP.targets()
    j, hints = S.seated(t["hip"], t["head"], t["grips"], t["feet"])
    F = S.frames(j, hints)
    C, M = H.frame(j, F)
    eye = C + np.array([0.0, H.EYE_Y, H.EYE_Z]) @ M
    fwd = np.asarray(M[2], float)             # helmet z = forward
    return eye, fwd


def _world_centre(ob):
    pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return (lo + hi) * 0.5, hi - lo


def _skin_normal(centre, skins, dg):
    """Outward normal of the nearest skin surface (the lights are lenses and strips on the skin)."""
    best = None
    for s in skins:
        inv = s.matrix_world.inverted()
        ok, loc, nrm, _ = s.closest_point_on_mesh(inv @ centre, depsgraph=dg)
        if not ok:
            continue
        w = s.matrix_world @ loc
        d = (w - centre).length
        if best is None or d < best[0]:
            n = (s.matrix_world.to_3x3().inverted_safe().transposed() @ nrm).normalized()
            best = (d, w, n)
    if best is None:
        return Vector((0, 0, 1))
    d, w, n = best
    # outwards: away from the fuselage axis (the lenses sit partly sunk in the skin, so the offset
    # from the surface cannot tell the side)
    out = Vector((centre.x, 0.0, centre.z - 0.2))
    if out.dot(n) < 0:
        n = -n
    return n


def _lens_axis(ob):
    """Axis of a thin lens (its smallest extent), pointing forward-ish."""
    me = ob.data
    co = np.array([ob.matrix_world @ v.co for v in me.vertices], float)
    co -= co.mean(0)
    _, vecs = np.linalg.eigh(co.T @ co)
    a = Vector(vecs[:, 0]).normalized()
    return -a if a.y > 0 else a                  # Blender -Y = forward


def _material_colour(ob):
    for s in ob.material_slots:
        m = s.material
        if m and m.node_tree:
            b = m.node_tree.nodes.get("Principled BSDF")
            if b is not None:
                return list(b.inputs["Emission Color"].default_value)[:3]
    return [1.0, 1.0, 1.0]


def gather(arm, groups, node_of_obj, struts, export_objs):
    from f35 import gear as G, nozzle as NZ, geom as GE
    from f35.fuselage import NOZ_Z
    out = {}
    # ------------------------------------------------------------------ eye
    eye, fwd = eye_point()
    out["eye"] = rnd(b2body(eye), 4)
    out["eyeForward"] = rnd(b2body(fwd), 4)
    head = bpy.data.objects.get("Pilot_Rig")
    if head is not None:
        pb = head.pose.bones.get("head")
        if pb is not None:
            hb = head.matrix_world @ pb.head
            log(f"  eye {np.round(eye, 3)} (head bone at {np.round(np.array(hb), 3)})")
    # --------------------------------------------------------------- wheels
    radius = {"nose": G.NG_R, "left": G.MG_R, "right": G.MG_R}
    width = {"nose": G.NG_W, "left": G.MG_W, "right": G.MG_W}
    deflect = {"nose": G.NG_DEFLECT, "left": G.MG_DEFLECT, "right": G.MG_DEFLECT}
    # The model's gear is posed parked (static load).  The struts can extend STRUT_EXTEND below that
    # pose (fully extended, wheels in the air) and compress by the stowage stroke of the retraction
    # rig above it; the strut_<x> rig controls are measured from the parked pose (+ = compressed).
    from rigsample import STRUT_EXTEND
    contacts = []
    for name, wbone, obone in WHEELS:
        pw = arm.pose.bones[wbone]
        po = arm.pose.bones[obone]
        c = arm.matrix_world @ pw.head
        axle = (arm.matrix_world.to_3x3() @ pw.y_axis).normalized()
        down = (arm.matrix_world.to_3x3() @ po.y_axis).normalized()     # oleo bone +Y runs down the strut
        r = radius[name]
        bottom = c - Vector((0, 0, r))                  # free (unloaded) tyre, parked strut
        ext = down * STRUT_EXTEND
        key, strut = next(((k, s) for k, s in struts.items() if s["bone"] == obone), (None, None))
        travel = (strut["travel"] if strut else 0.15) + STRUT_EXTEND
        contacts.append({
            "name": name,
            "pos": rnd(b2body(bottom + ext), 4),          # tyre bottom, gear down, strut fully extended
            "radius": rnd(r, 4),
            "axis": rnd(b2body(-down), 4),               # unit: the way the wheel moves as the strut compresses
            "travel": rnd(travel, 4),                    # full stroke from fully extended (m)
            "staticCompression": rnd(STRUT_EXTEND, 4),   # stroke used in the modelled parked pose (m)
            "posParked": rnd(b2body(bottom), 4),         # tyre bottom in the modelled parked pose
            "axle": rnd(b2body(c + ext), 4),             # axle centre, fully extended
            "axleDir": rnd(b2body(axle), 4),
            "width": rnd(width[name], 4),
            "tyreDeflection": rnd(deflect[name], 4),     # parked model's tyre flat: its ground is this far above posParked
            "control": key,
            "node": wbone,
        })
    out["gearContacts"] = contacts
    st = arm.pose.bones["NG_Steer"]
    out["noseSteer"] = {"axis": rnd(b2body((arm.matrix_world.to_3x3() @ st.y_axis).normalized()), 4),
                        "max": rnd(math.radians(60.0), 5), "control": "nws"}
    # --------------------------------------------------------------- nozzle
    exit_c = GE.P(NZ.S_EXIT, 0.0, NOZ_Z)
    throat = GE.P(NZ.THROAT[0], 0.0, NOZ_Z)
    out["nozzle"] = {"exit": rnd(b2body(exit_c), 4), "radius": NZ.R_EXIT, "radiusAB": NZ.R_EXIT_OPEN,
                     "axis": [0.0, 0.0, 1.0], "throat": rnd(b2body(throat), 4), "throatRadius": NZ.THROAT[1],
                     "node": "Nozzle", "morph": "AB_Open"}
    # --------------------------------------------------------------- lights
    lights = []
    dg = bpy.context.evaluated_depsgraph_get()
    skins = [o for o in export_objs if not o.get("light")
             and any(s.material is not None and s.material.name == "F35_Skin_RAM" for s in o.material_slots)]
    for ob in export_objs:
        role = ob.get("light")
        if not role or role == "afterburner":
            continue
        c, size = _world_centre(ob)
        n = _lens_axis(ob) if role == "landing" else _skin_normal(c, skins, dg)
        node = node_of_obj(ob)
        g = groups[node]
        e = {"name": ob.name, "role": role, "pos": rnd(b2body(c), 4), "dir": rnd(b2body(n), 4),
             "size": rnd(sorted([size.x, size.y, size.z])[-1], 4), "colour": rnd(_material_colour(ob), 3),
             "node": node, "nodePos": rnd(b2m(np.array(c) - g["pivot"]), 4), "nodeDir": rnd(b2m(n), 4)}
        lights.append(e)
    out["lights"] = sorted(lights, key=lambda e: (e["role"], e["name"]))
    land = next((l for l in lights if l["role"] == "landing"), None)
    if land is not None:
        out["landingLight"] = {"pos": land["pos"], "dir": land["dir"], "node": land["node"],
                               "nodePos": land["nodePos"], "nodeDir": land["nodeDir"],
                               "on": "lights.landing and gear > 0.9"}
    # --------------------------------------------------------------- dimensions
    lo = np.full(3, 1e9)
    hi = np.full(3, -1e9)
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in export_objs:
        if any(c.name == "Pilot" for c in ob.users_collection):
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        if len(me.vertices):
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            mw = np.array(ob.matrix_world)
            w = co @ mw[:3, :3].T + mw[:3, 3]
            lo = np.minimum(lo, w.min(0))
            hi = np.maximum(hi, w.max(0))
        ev.to_mesh_clear()
    blo = np.array(b2body(lo))
    bhi = np.array(b2body(hi))
    bmin, bmax = np.minimum(blo, bhi), np.maximum(blo, bhi)
    out["bbox"] = {"min": rnd(bmin, 4), "max": rnd(bmax, 4)}
    out["length"] = rnd(bmax[2] - bmin[2], 3)
    out["span"] = rnd(bmax[0] - bmin[0], 3)
    out["height"] = rnd(bmax[1] - bmin[1], 3)      # gear down, tyre bottom (loaded) to fin tip
    # --------------------------------------------------------------- static stance (as in the Blender scenes)
    S = GE.stance_matrix()
    o = S @ Vector((0, 0, 0))
    out["groundStance"] = {
        "pitch": rnd(math.radians(GE.STANCE_PITCH), 5),
        "refHeight": rnd(o.z - GE.GROUND_Z, 4),
        "note": "Blender scenes park the jet nose-up by `pitch` with the reference point `refHeight` above the "
                "ground (tyres flattened by each contact's tyreDeflection); the FDM sets the real attitude."}
    out["referencePoint"] = {"station": rnd(GE.Y0, 4), "note": "body origin: station s from the radome tip, "
                             "centre line, Blender z = 0 (fuselage reference line); the FDM's CG"}
    return out
