"""Geometry helpers: interpolation, lofting, mesh creation.

Coordinate convention used across the whole model
-------------------------------------------------
* Station ``s`` (metres) runs from the nose tip (s=0) to the tail (s=15.67).
* Blender axes: nose points to -Y, +X is the aircraft's LEFT (port) side,
  +Z is up. ``P(s, x, z)`` converts station coordinates to Blender space.
* z = 0 is the fuselage reference (roughly the forward chine line).
  The ground plane sits at ``GROUND_Z``.
"""
import math
import bmesh
import bpy
from mathutils import Vector

L_TOTAL = 15.67          # overall length (m)
Y0 = L_TOTAL * 0.5       # nose sits at y = -Y0
GROUND_Z = -1.76         # ground plane (gear down, static; tyre bottoms)
# Static ground attitude.  The airframe is built level; on its gear the jet sits about 1.45 deg
# nose-up (camera-matched photos c14, c22, c29, c51 with the main contacts matched; the nose-tip to
# fin-tip line in the long-lens side view c48 agrees within 0.3 deg) and 13 cm higher at the main
# wheels: measured in tyre diameters, the gear doors' lower edges sit higher above the wheels in
# c48, c51 and c53 than they did at 5 cm.  13 cm puts the fin tips 4.41 m above the ground, against
# the published 4.38 m (14.4 ft); 10 cm would match that but leaves the doors too low in the photos.
# The rig root carries this transform (assemble.apply_stance), so in the airframe frame the
# ground lies at ground_z_airframe(s).
STANCE_PITCH = 1.45      # deg, nose up
STANCE_RAISE = 0.13      # m, airframe above GROUND_Z at the main-wheel contact line
MAIN_CONTACT_S = 10.27   # station of the main-wheel contact line


def ground_z_airframe(s):
    """Height of the ground under station s in the level airframe frame."""
    return GROUND_Z - STANCE_RAISE - (MAIN_CONTACT_S - s) * math.tan(math.radians(STANCE_PITCH))


def stance_matrix():
    """Airframe frame -> world: pitch nose-up about the main-wheel contact line."""
    from mathutils import Matrix
    ca = Vector((0.0, MAIN_CONTACT_S - Y0, GROUND_Z - STANCE_RAISE))
    cw = Vector((0.0, MAIN_CONTACT_S - Y0, GROUND_Z))
    return Matrix.Translation(cw) @ Matrix.Rotation(-math.radians(STANCE_PITCH), 4, 'X') @ Matrix.Translation(-ca)


def P(s, x, z):
    """Station coordinates -> Blender world vector."""
    return Vector((x, s - Y0, z))


# ---------------------------------------------------------------------------
# 1-D monotone cubic interpolation (PCHIP) - smooth but no overshoot.
# ---------------------------------------------------------------------------
class Pchip:
    def __init__(self, xs, ys):
        assert len(xs) == len(ys) and len(xs) >= 2
        self.x = list(xs)
        self.y = list(ys)
        n = len(xs)
        h = [self.x[i + 1] - self.x[i] for i in range(n - 1)]
        d = [(self.y[i + 1] - self.y[i]) / h[i] for i in range(n - 1)]
        m = [0.0] * n
        if n == 2:
            m = [d[0], d[0]]
        else:
            for i in range(1, n - 1):
                if d[i - 1] * d[i] <= 0:
                    m[i] = 0.0
                else:
                    w1 = 2 * h[i] + h[i - 1]
                    w2 = h[i] + 2 * h[i - 1]
                    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
            m[0] = self._end(h[0], h[1], d[0], d[1])
            m[-1] = self._end(h[-1], h[-2], d[-1], d[-2])
        self.m = m
        self.h = h

    @staticmethod
    def _end(h0, h1, d0, d1):
        m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
        if m * d0 <= 0:
            return 0.0
        if d0 * d1 <= 0 and abs(m) > abs(3 * d0):
            return 3 * d0
        return m

    def __call__(self, x):
        xs = self.x
        if x <= xs[0]:
            return self.y[0]
        if x >= xs[-1]:
            return self.y[-1]
        lo, hi = 0, len(xs) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if xs[mid] > x:
                hi = mid
            else:
                lo = mid
        i = lo
        h = self.h[i]
        t = (x - xs[i]) / h
        t2, t3 = t * t, t * t * t
        h00 = 2 * t3 - 3 * t2 + 1
        h10 = t3 - 2 * t2 + t
        h01 = -2 * t3 + 3 * t2
        h11 = t3 - t2
        return (h00 * self.y[i] + h10 * h * self.m[i]
                + h01 * self.y[i + 1] + h11 * h * self.m[i + 1])


class Table:
    """A table of named parameters keyed by station, interpolated by PCHIP."""

    def __init__(self, keys, rows):
        self.keys = keys
        stations = [r[0] for r in rows]
        self.f = {}
        for j, k in enumerate(keys):
            self.f[k] = Pchip(stations, [r[j + 1] for r in rows])
        self.s0, self.s1 = stations[0], stations[-1]

    def __call__(self, s):
        return {k: f(s) for k, f in self.f.items()}


def cosine_spacing(a, b, n, bias_start=True, bias_end=True):
    """n samples between a and b, clustered towards ends."""
    out = []
    for i in range(n):
        t = i / (n - 1)
        if bias_start and bias_end:
            t = 0.5 - 0.5 * math.cos(math.pi * t)
        elif bias_start:
            t = 1 - math.cos(0.5 * math.pi * t)
        elif bias_end:
            t = math.sin(0.5 * math.pi * t)
        out.append(a + (b - a) * t)
    return out


# ---------------------------------------------------------------------------
# Mesh helpers
# ---------------------------------------------------------------------------
def get_collection(name, parent=None):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(col)
    return col


def mesh_object(name, verts, faces, collection, material=None, smooth=True,
                sharp_angle=None, uv_from=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate(clean_customdata=False)
    me.update()
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    if material is not None:
        me.materials.append(material)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
        if sharp_angle is not None:
            me.set_sharp_from_angle(angle=math.radians(sharp_angle))
    return ob


def loft_rings(rings, close_ring=True, cap_start=False, cap_end=False):
    """Build verts/faces from a list of equal-length rings of Vectors."""
    verts, faces = [], []
    n = len(rings[0])
    for r in rings:
        assert len(r) == n
        verts.extend(r)
    seg = n if close_ring else n - 1
    for i in range(len(rings) - 1):
        a0, b0 = i * n, (i + 1) * n
        for j in range(seg):
            j1 = (j + 1) % n
            faces.append((a0 + j, a0 + j1, b0 + j1, b0 + j))
    if cap_start:
        c = len(verts)
        verts.append(sum(rings[0], Vector()) / n)
        for j in range(seg):
            faces.append((c, (j + 1) % n, j))
    if cap_end:
        c = len(verts)
        verts.append(sum(rings[-1], Vector()) / n)
        base = (len(rings) - 1) * n
        for j in range(seg):
            faces.append((c, base + j, base + (j + 1) % n))
    return verts, faces


def add_modifier_bevel(ob, width=0.004, segments=2, angle=40):
    m = ob.modifiers.new("Bevel", 'BEVEL')
    m.width = width
    m.segments = segments
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle)
    m.harden_normals = False
    return m


def add_solidify(ob, thickness=0.01, offset=-1.0):
    m = ob.modifiers.new("Solidify", 'SOLIDIFY')
    m.thickness = thickness
    m.offset = offset
    m.use_even_offset = True
    return m


def boolean(target, cutter, op='DIFFERENCE', apply=True):
    m = target.modifiers.new("Bool_" + cutter.name, 'BOOLEAN')
    m.operation = op
    m.object = cutter
    m.solver = 'EXACT'
    try:
        m.material_mode = 'TRANSFER'
    except Exception:
        pass
    if apply:
        apply_modifier(target, m.name)
    return m


def apply_modifier(ob, name):
    """Apply a modifier without needing UI context."""
    dg = bpy.context.evaluated_depsgraph_get()
    # temporarily disable modifiers after this one
    mods = list(ob.modifiers)
    idx = [m.name for m in mods].index(name)
    states = []
    for m in mods[idx + 1:]:
        states.append((m, m.show_viewport))
        m.show_viewport = False
    for m in mods[:idx]:
        pass
    dg.update()
    ob_eval = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ob_eval)
    for m, st in states:
        m.show_viewport = st
    for m in mods[:idx + 1]:
        ob.modifiers.remove(m)
    old = ob.data
    mats = list(old.materials)
    ob.data = me
    if not me.materials:
        for mt in mats:
            me.materials.append(mt)
    bpy.data.meshes.remove(old)


def box(name, center, size, collection, material=None, bevel=0.0):
    cx, cy, cz = center
    sx, sy, sz = (size[0] / 2, size[1] / 2, size[2] / 2)
    v = [Vector((cx + dx * sx, cy + dy * sy, cz + dz * sz))
         for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6),
         (0, 2, 6, 4), (1, 5, 7, 3)]
    ob = mesh_object(name, v, f, collection, material, smooth=False)
    if bevel > 0:
        add_modifier_bevel(ob, bevel, 2, 30)
    return ob


def cylinder(name, p0, p1, r0, r1=None, collection=None, material=None,
             segments=24, cap=True, smooth=True):
    """Cylinder/cone between two points."""
    r1 = r0 if r1 is None else r1
    p0, p1 = Vector(p0), Vector(p1)
    axis = (p1 - p0).normalized()
    tmp = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(tmp).normalized()
    w = axis.cross(u).normalized()
    rings = []
    for p, r in ((p0, r0), (p1, r1)):
        ring = []
        for i in range(segments):
            a = 2 * math.pi * i / segments
            ring.append(p + (u * math.cos(a) + w * math.sin(a)) * r)
        rings.append(ring)
    verts, faces = loft_rings(rings, True, cap, cap)
    ob = mesh_object(name, verts, faces, collection, material, smooth,
                     sharp_angle=40 if smooth else None)
    return ob


def uv_sphere(name, center, radii, collection, material=None, seg=24, rings=12):
    cx, cy, cz = center
    rx, ry, rz = radii
    verts, faces = [], []
    verts.append(Vector((cx, cy, cz + rz)))
    for i in range(1, rings):
        th = math.pi * i / rings
        for j in range(seg):
            ph = 2 * math.pi * j / seg
            verts.append(Vector((cx + rx * math.sin(th) * math.cos(ph),
                                 cy + ry * math.sin(th) * math.sin(ph),
                                 cz + rz * math.cos(th))))
    verts.append(Vector((cx, cy, cz - rz)))
    for j in range(seg):
        faces.append((0, 1 + j, 1 + (j + 1) % seg))
    for i in range(rings - 2):
        a, b = 1 + i * seg, 1 + (i + 1) * seg
        for j in range(seg):
            j1 = (j + 1) % seg
            faces.append((a + j, b + j, b + j1, a + j1))
    last = len(verts) - 1
    base = 1 + (rings - 2) * seg
    for j in range(seg):
        faces.append((base + j, last, base + (j + 1) % seg))
    return mesh_object(name, verts, faces, collection, material)


def set_origin(ob, world_point):
    """Move object origin to world_point without moving geometry."""
    world_point = Vector(world_point)
    mw = ob.matrix_world.copy()
    local = mw.inverted() @ world_point
    ob.data.transform(__import__('mathutils').Matrix.Translation(-local))
    ob.matrix_world = mw @ __import__('mathutils').Matrix.Translation(local)


def mirror_x_object(ob, name):
    """Duplicate object mirrored across the aircraft centreline (X=0)."""
    me = ob.data.copy()
    from mathutils import Matrix
    me.transform(Matrix.Scale(-1, 4, (1, 0, 0)))
    me.flip_normals()
    new = bpy.data.objects.new(name, me)
    for c in ob.users_collection:
        c.objects.link(new)
    for m in ob.modifiers:
        nm = new.modifiers.new(m.name, m.type)
        for attr in dir(m):
            if attr.startswith('_') or attr in ('rna_type', 'name', 'type',
                                                 'is_override_data', 'persistent_uid',
                                                 'is_active', 'is_pin_to_last',
                                                 'execution_time'):
                continue
            try:
                setattr(nm, attr, getattr(m, attr))
            except Exception:
                pass
    return new
