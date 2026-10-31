"""Landing-gear clearance checks, run inside Blender (e.g. via the MCP).

    import sys; sys.path.insert(0, r"<repo>/scripts/tools")
    import clearance
    clearance.exposed(0.0)                         # gear outside the closed airframe, gear up
    clearance.crossings([0.0, 0.3, 0.6, 0.9, 1.0]) # gear edges cutting through skin or doors

Positions are reported as station triples (x, s, z): x lateral (+ left),
s metres aft of the nose tip, z up.
"""
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

Y_NOSE = 7.835          # world y of station 0 is -Y_NOSE
SKIP = ("MG_", "NG_", "HB_", "Hitbox", "Ground", "Apron", "Smoke", "Vapour", "Cut_", "Pilot", "AB_", "Cav_",
        "Review", "Match", "Compare", "Prev")


def _st(p):
    return (round(p.x, 3), round(p.y + Y_NOSE, 3), round(p.z, 3))


def set_gear(g, rig_name="F35I_Rig"):
    rig = bpy.data.objects[rig_name]
    rig["gear"] = float(g)
    rig.update_tag()
    bpy.context.view_layer.update()
    return bpy.context.evaluated_depsgraph_get()


def _world_mesh(ob, dg):
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    mw = ev.matrix_world.copy()
    vs = [mw @ v.co for v in me.vertices]
    es = [tuple(e.vertices) for e in me.edges]
    ps = [tuple(p.vertices) for p in me.polygons]
    ev.to_mesh_clear()
    return vs, es, ps


def _bvh(obs, dg):
    verts, polys = [], []
    for ob in obs:
        vs, _, ps = _world_mesh(ob, dg)
        off = len(verts)
        verts.extend(vs)
        polys.extend([off + i for i in p] for p in ps)
    return BVHTree.FromPolygons(verts, polys)


def _side(name):
    """Side tag: the last L/R token (MG_DragBrace_L_R is the right lower brace)."""
    for t in reversed(name.replace(".", "_").split("_")):
        if t in ("L", "R"):
            return t
    return ""


def gear_parts(prefix="MG_", side="L"):
    return [o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith(prefix)
            and _side(o.name) == side and not o.hide_render]


def airframe(side=None):
    out = []
    for o in bpy.data.objects:
        if o.type != 'MESH' or o.hide_render or o.name.startswith(SKIP):
            continue
        if any(c.name == "Helpers" for c in o.users_collection):
            continue
        if side and _side(o.name) not in ("", side):
            continue
        out.append(o)
    return out


def exposed(g=0.0, prefix="MG_", side="L"):
    """Gear vertices with no airframe surface above AND below them, or none
    on one side: i.e. outside the closed skin.  {part: (count, n, bbox)}."""
    dg = set_gear(g)
    bvh = _bvh(airframe(), dg)
    res = {}
    for ob in gear_parts(prefix, side):
        vs, _, _ = _world_mesh(ob, dg)
        out = [p for p in vs if bvh.ray_cast(p, Vector((0, 0, -1)), 30.0)[0] is None
               or bvh.ray_cast(p, Vector((0, 0, 1)), 30.0)[0] is None]
        if out:
            lo = _st(Vector((min(p.x for p in out), min(p.y for p in out), min(p.z for p in out))))
            hi = _st(Vector((max(p.x for p in out), max(p.y for p in out), max(p.z for p in out))))
            res[ob.name] = (len(out), len(vs), lo, hi)
    return res


def crossings(gs=(0.0, 0.5, 1.0), prefix="MG_", side="L", targets=None, doors_vs_gear=True):
    """For each gear value: gear edges that pass through a target surface
    (and door edges through gear parts).  {g: {(part, target): (n, first_hit)}}"""
    out = {}
    for g in gs:
        dg = set_gear(g)
        tg = targets or [o for o in airframe(side) if o.name.startswith(
            ("Fuselage", "Wing_", "WingFillet_", "MainGearDoor", "BayDoor", "LEF_", "Flaperon_"))]
        tb = {o.name: _bvh([o], dg) for o in tg}
        parts = gear_parts(prefix, side)
        res = {}
        meshes = {ob.name: _world_mesh(ob, dg) for ob in parts}
        for pn, (vs, es, _) in meshes.items():
            for tn, bvh in tb.items():
                n, first = 0, None
                for a, b in es:
                    d = vs[b] - vs[a]
                    L = d.length
                    if L < 1e-6:
                        continue
                    h = bvh.ray_cast(vs[a], d / L, L)
                    if h[0] is not None:
                        n += 1
                        first = first or _st(h[0])
                if n:
                    res[(pn, tn)] = (n, first)
        if doors_vs_gear:
            gb = _bvh(parts, dg)
            for o in tg:
                if not o.name.startswith("MainGearDoor"):
                    continue
                vs, es, _ = _world_mesh(o, dg)
                n, first = 0, None
                for a, b in es:
                    d = vs[b] - vs[a]
                    L = d.length
                    if L < 1e-6:
                        continue
                    h = gb.ray_cast(vs[a], d / L, L)
                    if h[0] is not None:
                        n += 1
                        first = first or _st(h[0])
                if n:
                    res[(o.name, "gear")] = (n, first)
        out[g] = res
    set_gear(1.0)
    return out


def summary(res):
    """Compact text of crossings() output."""
    lines = []
    for g, r in res.items():
        lines.append(f"gear {g}: {len(r)} contacts")
        for (pn, tn), (n, first) in sorted(r.items()):
            lines.append(f"  {pn} x {tn}: {n} edges, first at {first}")
    return "\n".join(lines)
