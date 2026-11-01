"""Generic lifting-surface builder (wings, fins, stabilators) + hinge cuts."""
import math
import bmesh
import bpy
from mathutils import Vector, Matrix

from .geom import Pchip, mesh_object, loft_rings, boolean, Y0, apply_modifier
from . import materials as M


class Frame:
    """Local frame for a lifting surface.

    u : spanwise distance from the root (m)
    s : fuselage station of a chordwise point (m)
    n : thickness offset (m)
    world = origin(u) + span_dir*u + Y*(s) + normal*n
    """

    def __init__(self, root_xz, span_dir, normal, mirror=False):
        self.root = Vector((root_xz[0], 0.0, root_xz[1]))
        self.span = Vector(span_dir).normalized()
        self.normal = Vector(normal).normalized()
        self.mirror = mirror

    def world(self, u, s, n):
        p = self.root + self.span * u + self.normal * n
        p.y = s - Y0
        if self.mirror:
            p.x = -p.x
        return p


def naca_thickness(x, t):
    """Half thickness of a symmetric NACA 4-digit section (closed TE)."""
    return 5 * t * (0.2969 * math.sqrt(max(x, 0)) - 0.1260 * x - 0.3516 * x * x
                    + 0.2843 * x ** 3 - 0.1036 * x ** 4)


def lifting_surface(name, collection, frame, u_list, le_fn, te_fn, tc_fn,
                    material, n_chord=36, te_gap=0.0015, flip=False, le_sharp=None):
    """Closed mesh for a lifting surface sampled at spanwise stations.

    le_sharp(u) -> (d, w): over the first d metres behind the leading edge the half thickness is
    eased in (h * (1 - (1 - x/d)^2), smooth at x = d), blended by weight w; this gives a thin edge
    with a small nose radius while keeping the section's maximum thickness."""
    xs = [0.5 - 0.5 * math.cos(math.pi * i / (n_chord - 1)) for i in range(n_chord)]
    rings = []
    for u in u_list:
        le, te = le_fn(u), te_fn(u)
        c = te - le
        t = tc_fn(u)
        d, w = le_sharp(u) if le_sharp else (0.0, 0.0)
        upper = []
        lower = []
        for x in xs:
            h = naca_thickness(x, t) * c
            if w > 0.0 and d > 0.0 and x * c < d:
                f = 1.0 - (1.0 - x * c / d) ** 2
                h *= 1.0 - w * (1.0 - f)
            h = max(h, te_gap * 0.5 if x > 0.99 else 0.0)
            upper.append(frame.world(u, le + x * c, h))
            lower.append(frame.world(u, le + x * c, -h))
        ring = list(reversed(upper)) + lower[1:-1]
        rings.append(ring)
    verts, faces = loft_rings(rings, True, True, True)
    ob = mesh_object(name, verts, faces, collection, material, smooth=True)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.set_sharp_from_angle(angle=math.radians(30))
    return ob


def planform_prism(name, collection, frame, poly_us, half_thick=0.6):
    """Closed prism over a planform polygon [(u, s), ...] (CCW or CW)."""
    bot = [frame.world(u, s, -half_thick) for u, s in poly_us]
    top = [frame.world(u, s, half_thick) for u, s in poly_us]
    verts, faces = loft_rings([bot, top], True, True, True)
    ob = mesh_object(name, verts, faces, collection, None, smooth=False)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def split_surface(base, cutter_poly, frame, helpers, part_name, gap=0.006,
                  material=None):
    """Split `base` into (base - prism) and (base ∩ prism) -> new object."""
    coll = base.users_collection[0]
    # moving part = intersection with the prism
    part_me = base.data.copy()
    part = bpy.data.objects.new(part_name, part_me)
    coll.objects.link(part)
    prism_in = planform_prism(part_name + "_cutIn", helpers, frame, cutter_poly)
    boolean(part, prism_in, 'INTERSECT', apply=True)
    bpy.data.objects.remove(prism_in)
    # fixed part: subtract a slightly larger prism -> hinge gap
    grown = _grow_poly(cutter_poly, gap)
    prism_out = planform_prism(part_name + "_cutOut", helpers, frame, grown)
    boolean(base, prism_out, 'DIFFERENCE', apply=True)
    bpy.data.objects.remove(prism_out)
    if material is not None:
        part.data.materials.clear()
        part.data.materials.append(material)
    part.data.set_sharp_from_angle(angle=math.radians(30))
    base.data.set_sharp_from_angle(angle=math.radians(30))
    return part


def _grow_poly(poly, d):
    """Offset a simple polygon outward by d (approximate, vertex normals)."""
    n = len(poly)
    # signed area -> orientation
    area = sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]
               for i in range(n))
    sgn = 1 if area > 0 else -1
    out = []
    for i in range(n):
        p0 = Vector(poly[i - 1])
        p1 = Vector(poly[i])
        p2 = Vector(poly[(i + 1) % n])
        e1 = (p1 - p0).normalized()
        e2 = (p2 - p1).normalized()
        n1 = Vector((e1.y, -e1.x)) * sgn
        n2 = Vector((e2.y, -e2.x)) * sgn
        nn = (n1 + n2)
        if nn.length < 1e-6:
            nn = n1
        nn.normalize()
        out.append(tuple(p1 + nn * d))
    return out


def set_hinge(ob, p0, p1, kind, limits_deg, extra=None):
    """Store hinge axis (world) + deflection limits for the rig builder."""
    ob["hinge_p0"] = list(p0)
    ob["hinge_p1"] = list(p1)
    ob["hinge_kind"] = kind
    ob["limit_min"] = float(limits_deg[0])
    ob["limit_max"] = float(limits_deg[1])
    if extra:
        for k, v in extra.items():
            ob[k] = v
