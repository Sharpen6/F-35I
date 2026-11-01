"""F135 axisymmetric convergent-divergent nozzle (CTOL F-35A / F-35I).

Photos of a JASDF F-35A at Komatsu (references/nozzle, CC BY-SA 4.0) and the
3-view: the nozzle stands clear of the body behind the sawtooth shroud (teeth
at s ~13.30-13.36), ~1.16 m across at its root and ~0.94 m at the exit
(s ~14.04).  Outside: 15 overlapping dark-metal flaps ("turkey feathers"),
flat plates with a shallow chevron at the tip.  Inside: the pale,
ceramic-coated divergent flaps run from the throat to just past the outer
flaps, their serrated tips forming the light ring seen at the exit; ahead of
the throat come the darker convergent flaps, the augmentor liner, the flame
holder and the turbine face.  Shape key 'AB_Open' opens the throat and the
exit for afterburner; the rig drives it.
"""
import math

import bmesh

from .geom import P, get_collection, mesh_object, loft_rings
from .fuselage import NOZ_Z
from . import materials as M

PETALS = 15
S_ROOT = 13.28          # outer flap roots, under the shroud teeth
S_EXIT = 14.04          # outer flap trailing edges (chevron roots)
R_ROOT = 0.58           # outer flaps at the root (shroud skin r 0.605)
R_EXIT = 0.47           # outer flaps at the exit
R_EXIT_OPEN = 0.56      # ... with the afterburner lit
CHEVRON = 0.085         # chevron depth of the outer flap tips: 15 deep V tips, 7-11 cm in the
                        # photos (ref_06, ref_07, c26, c27)
T_FLAP = 0.006          # flap plate thickness
SHINGLE = 0.012         # each outer flap rises this much across its width (ramped in from the root,
                        # under the shroud teeth): it laps over the next with a dark step
CROWN = 0.004           # outer flaps: nearly flat plates, each with its own tone (photos ref_06,
                        # ref_07, c27); a stronger crown read as one smooth can
WIDEN = 1.05            # flap width / sector width (overlap)
CONV = (13.20, 0.535)                   # convergent flaps: root (station, radius)
THROAT = (13.62, 0.405)                 # convergent / divergent hinge line (dry power)
DIV_EXIT = (S_EXIT + 0.025, 0.455)      # divergent flap tips: just past the outer flaps
DIV_CHEVRON = 0.05
AB_THROAT = 1.20        # afterburner: convergent / divergent flaps open by this factor
N_S, N_W = 12, 10       # stations along / points across a flap

OUTER, CONVERGENT, DIVERGENT, LINER = range(4)


def r_outer(s):
    t = min(1.0, max(0.0, (s - S_ROOT) / (S_EXIT - S_ROOT)))
    return R_ROOT - (R_ROOT - R_EXIT) * t ** 1.25


def _lin(a, b, s):
    t = min(1.0, max(0.0, (s - a[0]) / (b[0] - a[0])))
    return a[1] + (b[1] - a[1]) * t


def r_convergent(s):
    return _lin(CONV, THROAT, s)


def r_divergent(s):
    return _lin(THROAT, DIV_EXIT, s)


def _plate(verts, faces, grid_o, grid_i):
    """Closed thin plate from outer / inner grids [station][across]."""
    ns, nw = len(grid_o), len(grid_o[0])
    bo = len(verts)
    for row in grid_o:
        verts.extend(row)
    bi = len(verts)
    for row in grid_i:
        verts.extend(row)

    def o(i, j):
        return bo + i * nw + j

    def n(i, j):
        return bi + i * nw + j
    for i in range(ns - 1):
        for j in range(nw - 1):
            faces.append((o(i, j), o(i, j + 1), o(i + 1, j + 1), o(i + 1, j)))
            faces.append((n(i, j), n(i + 1, j), n(i + 1, j + 1), n(i, j + 1)))
        faces.append((o(i, 0), o(i + 1, 0), n(i + 1, 0), n(i, 0)))
        faces.append((o(i, nw - 1), n(i, nw - 1), n(i + 1, nw - 1), o(i + 1, nw - 1)))
    for j in range(nw - 1):
        faces.append((o(0, j), n(0, j), n(0, j + 1), o(0, j + 1)))
        faces.append((o(ns - 1, j), o(ns - 1, j + 1), n(ns - 1, j + 1), n(ns - 1, j)))


def _flaps(verts, faces, s0, s1, r_fn, chevron, phase, thick, shingle, widen, crown=0.0, ids=None):
    """PETALS flaps around the axis, each lapping over the next; `crown` bows them outward.
    ids: list extended with the flap number of every vertex added."""
    for k in range(PETALS):
        n0 = len(verts)
        ac = math.pi / 2 + 2 * math.pi * (k + phase) / PETALS
        hw = math.pi / PETALS * widen
        nrm = (math.cos(ac), math.sin(ac))
        go, gi = [], []
        for i in range(N_S + 1):
            u = i / N_S
            ro, ri = [], []
            for j in range(N_W + 1):
                v = j / N_W
                tip = s1 + chevron * (1.0 - abs(2.0 * v - 1.0))
                s = s0 + (tip - s0) * u
                r = r_fn(min(s, s1))
                a0, a1 = ac - hw, ac + hw
                x = r * math.cos(a0) + (r * math.cos(a1) - r * math.cos(a0)) * v
                z = r * math.sin(a0) + (r * math.sin(a1) - r * math.sin(a0)) * v
                lift = (shingle * v + crown * math.sin(math.pi * v)) * min(1.0, 4.0 * u)
                x, z = x + nrm[0] * lift, z + nrm[1] * lift
                ro.append(P(s, x, NOZ_Z + z))
                ri.append(P(s, x - nrm[0] * thick, NOZ_Z + z - nrm[1] * thick))
            go.append(ro)
            gi.append(ri)
        _plate(verts, faces, go, gi)
        if ids is not None:
            ids.extend([k] * (len(verts) - n0))


def _ring(s, r, n):
    return [P(s, r * math.cos(2 * math.pi * i / n), NOZ_Z + r * math.sin(2 * math.pi * i / n))
            for i in range(n)]


def _tube(verts, faces, st, thick, n=48):
    """Closed thin tube through (station, outer radius) pairs."""
    outer = [_ring(s, r, n) for s, r in st]
    inner = [_ring(s, r - thick, n) for s, r in st]
    v0 = len(verts)
    lv, lf = loft_rings(outer + list(reversed(inner)), True, False, False)
    nr = 2 * len(st)
    for j in range(n):
        j1 = (j + 1) % n
        lf.append(((nr - 1) * n + j, (nr - 1) * n + j1, j1, j))
    verts.extend(lv)
    faces.extend(tuple(v0 + i for i in f) for f in lf)


def _ab_scale(part, s):
    """Radial scale of the 'AB_Open' shape key for a vertex of `part` at s."""
    if part == OUTER:
        f = min(1.0, max(0.0, (s - 13.55) / (S_EXIT - 13.55)))
        return 1.0 + (R_EXIT_OPEN / R_EXIT - 1.0) * f ** 1.6
    if part == CONVERGENT:
        g = min(1.0, max(0.0, (s - CONV[0]) / (THROAT[0] - CONV[0])))
        return 1.0 + (AB_THROAT - 1.0) * g
    if part == DIVERGENT:
        return AB_THROAT
    return 1.0


def build(ctx):
    root = ctx["root"]
    coll = get_collection("Engine", root)
    verts, faces, mats, parts = [], [], [], []

    def tag(part, mat):
        mats.extend([mat] * (len(faces) - len(mats)))
        parts.extend([part] * (len(verts) - len(parts)))
    # dark outer flaps
    flap_of = []
    _flaps(verts, faces, S_ROOT, S_EXIT, r_outer, CHEVRON, 0.0, T_FLAP, SHINGLE, WIDEN, CROWN, ids=flap_of)
    tag(OUTER, 0)
    # convergent flaps (sooty), augmentor to throat
    _flaps(verts, faces, CONV[0], THROAT[0], r_convergent, 0.0, 0.5, 0.006, 0.003, 1.04)
    tag(CONVERGENT, 1)
    # divergent flaps (light ceramic), throat to just past the outer flaps;
    # offset half a flap so their chevrons sit between the outer ones
    _flaps(verts, faces, THROAT[0], DIV_EXIT[0], r_divergent, DIV_CHEVRON, 0.5, 0.006, 0.0, 1.03)
    tag(DIVERGENT, 2)
    # augmentor liner ahead of the convergent flaps
    _tube(verts, faces, [(12.95, 0.548), (13.10, 0.545), (13.24, 0.542)], 0.01)
    tag(LINER, 1)
    noz = mesh_object("Nozzle", verts, faces, coll, M.get("nozzle"), smooth=True)
    me = noz.data
    me.materials.append(M.get("nozzle_in"))
    me.materials.append(M.get("nozzle_ceramic"))
    assert len(me.polygons) == len(mats) and len(me.vertices) == len(parts), "nozzle mesh changed"
    me.polygons.foreach_set("material_index", mats)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.set_sharp_from_angle(angle=math.radians(20))
    # each outer flap its own tone (0..1, golden-ratio steps: neighbours always differ)
    tone = me.attributes.new("flap_tone", 'FLOAT', 'POINT')
    vals = [((k * 0.618034) % 1.0) for k in flap_of] + [0.5] * (len(me.vertices) - len(flap_of))
    tone.data.foreach_set("value", vals)
    # shape key: afterburner (throat and exit open)
    noz.shape_key_add(name="Basis")
    sk = noz.shape_key_add(name="AB_Open")
    half = 15.67 / 2
    for i, v in enumerate(me.vertices):
        co = v.co
        k = _ab_scale(parts[i], co.y + half)
        sk.data[i].co.x = co.x * k
        sk.data[i].co.z = NOZ_Z + (co.z - NOZ_Z) * k
    # turbine / augmentor face deep inside (dark) + tail cone + flame holder
    face_rings = [_ring(12.95, 0.56, 32), _ring(12.95, 0.001, 32)]
    v2, f2 = loft_rings(face_rings, True, False, False)
    face = mesh_object("Engine_Face", v2, f2, coll, M.get("intake_dark"), smooth=False)
    cone_r = [_ring(12.90, 0.22, 24), _ring(13.25, 0.12, 24), _ring(13.42, 0.01, 24)]
    v3, f3 = loft_rings(cone_r, True, False, True)
    cone = mesh_object("Engine_TailCone", v3, f3, coll, M.get("nozzle_in"))
    fh = [_ring(13.02, 0.36, 32), _ring(13.02, 0.33, 32), _ring(13.08, 0.33, 32), _ring(13.08, 0.36, 32)]
    v4, f4 = loft_rings(fh, True, False, False)
    nb = len(fh[0])
    for j in range(nb):
        j1 = (j + 1) % nb
        f4.append((3 * nb + j, 3 * nb + j1, j1, j))
    holder = mesh_object("Engine_FlameHolder", v4, f4, coll, M.get("nozzle_in"), smooth=False)
    for ob in (face, cone, holder):
        ob.parent = noz
    ctx["objects"]["Nozzle"] = noz
    noz["hinge_kind"] = "nozzle"
    return noz
