"""Clean shading on meshes made by booleans of smooth lofts.

The fuselage is the union of two smooth lofts, the forebody and the main
body.  Where they cross at a shallow angle (behind the canopy) the exact
boolean leaves thin n-gons, and smooth-by-angle shading blends the normals
across that seam in some places and not in others: a jagged, blotchy band.
Holes cut later (wells, bays, the gun port) leave similar slivers.

The fix: before the union, keep each source loft (capture).  After the last
cut, every face that lies on a source surface gets, at each corner, that
source's own smooth normal at that point (custom split normals) (apply).
Edges are made sharp from the source normals, not from the (sliver) faces:
a seam between two sources stays smooth where they meet at a shallow angle,
with one averaged normal per smooth fan, so it does not show.  Faces made by
cutters (well walls, duct walls) keep Blender's default normals.
"""
import math

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

_SOURCES = {}
_E1, _E2, _E3 = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))


class _Source:
    """A smooth source surface: triangles with their corner normals (world)."""

    def __init__(self, ob, sharp_angle):
        me = ob.data.copy()
        me.set_sharp_from_angle(angle=math.radians(sharp_angle))
        mw = ob.matrix_world
        rot = mw.to_3x3().inverted_safe().transposed()
        cn = me.corner_normals
        me.calc_loop_triangles()
        self.co, self.n, tris = [], [], []
        for lt in me.loop_triangles:
            base = len(self.co)
            for li, vi in zip(lt.loops, lt.vertices):
                self.co.append(mw @ me.vertices[vi].co)
                self.n.append((rot @ cn[li].vector).normalized())
            tris.append((base, base + 1, base + 2))
        self.bvh = BVHTree.FromPolygons(self.co, tris, all_triangles=True)
        bpy.data.meshes.remove(me)

    def near(self, p, eps):
        return self.bvh.find_nearest(p, eps)

    def facing(self, p, eps, fn, cos_min):
        """Nearest triangle within eps of p whose normal agrees with fn
        (|dot| >= cos_min), or None.  Small cut faces (e.g. the side wall of a
        lip cutter) can be nearer than the surface itself."""
        best = None
        for loc, n, idx, d in self.bvh.find_nearest_range(p, eps):
            if abs(n.dot(fn)) >= cos_min and (best is None or d < best[3]):
                best = (loc, n, idx, d)
        return best

    def normal(self, p, probe, fn, cos_min=0.7):
        """Smooth normal at p, on the triangle nearest to `probe` (a point just
        inside the face, so the right side of a sharp source edge is used) that
        faces the same way as the face (normal fn)."""
        hit = self.facing(probe, 0.004, fn, cos_min)
        if hit is None:
            hit = self.bvh.find_nearest(probe, 0.05)
            if hit[0] is None:
                return None
        loc, tn, idx, d = hit
        a, b, c = 3 * idx, 3 * idx + 1, 3 * idx + 2
        w = barycentric_transform(p, self.co[a], self.co[b], self.co[c], _E1, _E2, _E3)
        n = self.n[a] * w.x + self.n[b] * w.y + self.n[c] * w.z
        if n.length < 1e-6:
            return tn
        return n.normalized()


def capture(key, obs, sharp_angle=35.0):
    """Remember the source surfaces for a mesh that is about to be booleaned."""
    _SOURCES[key] = [_Source(ob, sharp_angle) for ob in obs]


def apply(ob, key, sharp_angle=35.0, seam_angle=12.0, eps_v=1.5e-3, eps_c=4e-3, max_dev=25.0):
    """Give `ob` the smooth normals of its captured sources (see module doc).

    Sharp edges: between a source face and a cutter face; between two
    source faces where the source normals differ by more than sharp_angle
    (same source) or seam_angle (a seam between two sources).  Where two
    sources meet at a shallow angle the seam stays smooth and the normals of
    each smooth fan are averaged, so the seam itself does not show.
    Returns (faces on a source, faces left default, sharp edges)."""
    srcs = _SOURCES.get(key)
    if not srcs:
        return None
    me = ob.data
    mw = ob.matrix_world
    nrot = mw.to_3x3().inverted_safe().transposed()
    to_local = mw.to_3x3().transposed()                 # world -> local for normals (inverse of nrot)
    wco = [mw @ v.co for v in me.vertices]
    on = [[s.near(p, eps_v)[0] is not None for p in wco] for s in srcs]
    cos_dev = math.cos(math.radians(max_dev))
    polys = me.polygons
    fnw = [(nrot @ p.normal).normalized() for p in polys]
    cls = [-1] * len(polys)
    for p in polys:
        c = mw @ p.center
        best = None
        for si, s in enumerate(srcs):
            if not all(on[si][v] for v in p.vertices):
                continue
            hit = s.facing(c, eps_c, fnw[p.index], cos_dev)
            if hit is None:
                continue
            if best is None or hit[3] < best[1]:
                best = (si, hit[3])
        if best is not None:
            cls[p.index] = best[0]
    # corner normals from the sources (world space; None = Blender default)
    loops = me.loops
    lv = [l.vertex_index for l in loops]
    le = [l.edge_index for l in loops]
    nw = [None] * len(loops)
    for p in polys:
        si = cls[p.index]
        if si < 0:
            continue
        s = srcs[si]
        c = mw @ p.center
        for li in p.loop_indices:
            pv = wco[lv[li]]
            probe = pv + (c - pv) * min(1.0, 0.002 / max((c - pv).length, 1e-6))
            nw[li] = s.normal(pv, probe, fnw[p.index])
    # sharp edges
    edge_faces = [[] for _ in me.edges]
    face_loop = {}
    for p in polys:
        for li in p.loop_indices:
            edge_faces[le[li]].append(p.index)
            face_loop[(p.index, lv[li])] = li
    cos_sharp = math.cos(math.radians(sharp_angle))
    cos_seam = math.cos(math.radians(seam_angle))
    sharp = [True] * len(me.edges)
    for e in me.edges:
        fs = edge_faces[e.index]
        if len(fs) != 2:
            continue
        f1, f2 = fs
        c1, c2 = cls[f1], cls[f2]
        if c1 < 0 or c2 < 0:
            sharp[e.index] = c1 != c2 or fnw[f1].dot(fnw[f2]) < cos_sharp
            continue
        lim = cos_sharp if c1 == c2 else cos_seam
        ok = True
        for v in e.vertices:
            a, b = nw[face_loop[(f1, v)]], nw[face_loop[(f2, v)]]
            if a is None or b is None or a.dot(b) < lim:
                ok = False
        sharp[e.index] = not ok
    attr = me.attributes.get("sharp_edge")
    if attr is None:
        attr = me.attributes.new("sharp_edge", 'BOOLEAN', 'EDGE')
    attr.data.foreach_set("value", sharp)
    # one normal per smooth fan: average the corners around each vertex that
    # are joined by smooth edges (union-find over the corners of the vertex)
    vert_loops = [[] for _ in me.vertices]
    for p in polys:
        if cls[p.index] >= 0:
            for li in p.loop_indices:
                vert_loops[lv[li]].append((li, p.index))
    poly_edges = {}
    for p in polys:
        poly_edges[p.index] = {le[li] for li in p.loop_indices}
    ev = [tuple(e.vertices) for e in me.edges]
    for v, cl in enumerate(vert_loops):
        if len(cl) < 2:
            continue
        par = list(range(len(cl)))

        def find(i):
            while par[i] != i:
                par[i] = par[par[i]]
                i = par[i]
            return i
        for i in range(len(cl)):
            for j in range(i + 1, len(cl)):
                shared = poly_edges[cl[i][1]] & poly_edges[cl[j][1]]
                if any(not sharp[ei] and v in ev[ei] for ei in shared):
                    par[find(i)] = find(j)
        groups = {}
        for i, (li, f) in enumerate(cl):
            groups.setdefault(find(i), []).append(li)
        for g in groups.values():
            if len(g) < 2:
                continue
            acc = Vector((0.0, 0.0, 0.0))
            for li in g:
                if nw[li] is not None:
                    acc += nw[li]
            if acc.length > 1e-9:
                acc.normalize()
                for li in g:
                    nw[li] = acc
    out = [(0.0, 0.0, 0.0) if n is None else tuple((to_local @ n).normalized()) for n in nw]
    for p in polys:
        p.use_smooth = True
    me.normals_split_custom_set(out)
    n_src = sum(1 for k in cls if k >= 0)
    return n_src, len(cls) - n_src, sum(sharp)
