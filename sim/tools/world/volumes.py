"""Building volumes for buildings.py: parts and their outline, support, duplicates.

Runs after the heights are estimated (buildings.estimate), on the records in the world frame.

* merge_parts   OpenStreetMap's Simple 3D Buildings: a building with building:part members is drawn
                from its parts, the outline is not. Mappers often map only some parts (the crown
                and a few floors of a tower, the podium of another), so dropping the outline left
                towers floating with nothing under them (Azrieli Sarona) or cut them down to their
                podium (ToHa 1). Here the parts stay and the outline fills what they leave out:
                the floors under a part that nothing else holds up, and the plan area no part
                covers. Every member of a building shares one ground reference.
* support       any raised volume (min height > 3 m) still standing on nothing is lowered onto
                what is under it, or onto the ground; a small one (a rooftop fragment whose tower
                is not mapped) is dropped.
* dedup         near-identical footprints (OpenStreetMap and Microsoft's ML footprint of the same
                building, doubled mapping) keep the better one; a volume hidden inside another is
                dropped; overlapping volumes that remain are marked so the runtime insets their
                walls a little (no coplanar walls fighting in the depth buffer).

Heights here are metres above the record's `mid` ground level (0.5 (gmin + gmax)), the convention
of buildings.write_tile; absolute heights are `mid + h`.
"""
import collections
import math

import numpy as np
from PIL import Image, ImageDraw

import geom

RES = 0.5               # m per raster cell for the part / outline arithmetic
GAP_TOL = 1.5           # m: gaps between stacked parts smaller than this are floor rounding
STYLE_FLAG_INSET = 128  # style bit: the runtime insets this volume's walls (it overlaps another)


def _mid(r):
    return 0.5 * (r['gmin'] + r['gmax'])


def abs_range(r):
    """Absolute bottom and top (m above sea level) of a record's volume."""
    m = _mid(r)
    bot = m + r['min_h'] if r['min_h'] > 0 else r['gmin'] - 0.6
    return bot, m + r['height_m']


class Raster:
    """A local grid over some rings (RES m cells): masks of polygons, contours back to rings."""

    def __init__(self, rings_list, res=RES, pad=2.0):
        pts = np.vstack([r[0] for r in rings_list])
        self.x0, self.z0 = pts.min(0) - pad
        x1, z1 = pts.max(0) + pad
        self.res = res
        # very large outlines (stations, malls): a coarser grid keeps the cost bounded
        while (x1 - self.x0) * (z1 - self.z0) / (self.res * self.res) > 6e6:
            self.res *= 2
        self.W = int(math.ceil((x1 - self.x0) / self.res))
        self.H = int(math.ceil((z1 - self.z0) / self.res))

    def _px(self, ring):
        return [((x - self.x0) / self.res - 0.5, (z - self.z0) / self.res - 0.5) for x, z in ring]

    def mask(self, rings):
        img = Image.new('L', (self.W, self.H), 0)
        d = ImageDraw.Draw(img)
        if len(rings[0]) >= 3:
            d.polygon(self._px(rings[0]), fill=1)
        for h in rings[1:]:
            if len(h) >= 3:
                d.polygon(self._px(h), fill=0)
        return np.asarray(img, bool)

    def rings(self, mask, min_area=6.0):
        """Polygons (outer ring + holes, world X / Z) of a mask's connected regions."""
        import cv2
        m = mask.astype(np.uint8)
        cs, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        if hier is None:
            return []
        hier = hier[0]
        out = []
        for i, c in enumerate(cs):
            if hier[i][3] != -1:            # a hole: collected with its parent
                continue
            polys = [c]
            j = hier[i][2]
            while j != -1:
                polys.append(cs[j])
                j = hier[j][0]
            rings = []
            for k, p in enumerate(polys):
                p = cv2.approxPolyDP(p, 1.0, True).reshape(-1, 2).astype(np.float64)
                if len(p) < 3:
                    continue
                w = np.stack([self.x0 + (p[:, 0] + 0.5) * self.res, self.z0 + (p[:, 1] + 0.5) * self.res], 1)
                if k == 0 and abs(geom.signed_area(w)) < min_area:
                    break
                rings.append(w)
            if rings and len(rings[0]) >= 3:
                out.append(rings)
        return out


def _fill_record(tpl, rings, lo, hi, k, clean, floor_h):
    """A filler volume: the template's attributes on new rings from lo to hi (m above mid)."""
    r = dict(tpl)
    r['id'] = f"{tpl.get('building_id') or tpl['id']}:fill{k}"
    r['rings'] = rings
    r['part'] = True
    r['filler'] = True
    r['building_id'] = tpl.get('building_id') or tpl['id']
    if not clean(r):
        return None
    # thinner than 3 m: the parts' outlines missing each other by a mapper's margin (it would
    # stand as a fin beside the tower), not a volume
    if r['area'] < 6.0 or r['obb'][3] < 1.5:
        return None
    r['min_h'] = float(lo)
    r['height_m'] = float(hi)
    r['shape'] = 0
    r['rise'] = 0.0
    r['floors_out'] = float(max(1, round(hi / max(floor_h, 2.5))))
    r['vsize'] = float(max(math.sqrt(r['area']) * 0.7, hi * 1.2))
    return r


def merge_parts(recs, clean, log=print):
    """Parts and outlines of buildings with building:part members -> the volumes to draw."""
    groups = collections.defaultdict(lambda: ([], []))
    out = []
    for r in recs:
        if r.get('part') and r.get('building_id'):
            groups[r['building_id']][1].append(r)
        elif r.get('outline_of_parts'):
            groups[r['id']][0].append(r)
        else:
            out.append(r)
    st = collections.Counter()
    for bid, (outs, parts) in groups.items():
        if not parts:                      # the parts were filtered out: the outline stands alone
            out += outs
            st['outline without its parts'] += len(outs)
            continue
        members = outs + parts
        g, G = min(m['gmin'] for m in members), max(m['gmax'] for m in members)
        for m in members:
            m['gmin'], m['gmax'] = g, G
        # an outline tagged with a min height of its own is a volume on top of the parts (the
        # crown of Diamond Tower, 113-115 m over its 0-113 m parts): kept like a part
        raised = [o for o in outs if o['min_h'] > 3.0]
        outs = [o for o in outs if o['min_h'] <= 3.0]
        parts = parts + raised
        st['raised outlines kept as volumes'] += len(raised)
        if not outs:
            out += parts
            st['parts without a ground outline'] += 1
            continue
        out += parts
        st['buildings with parts'] += 1
        R = Raster([o['rings'] for o in outs] + [p['rings'] for p in parts])
        O = np.zeros((R.H, R.W), bool)
        for o in outs:
            O |= R.mask(o['rings'])
        P = [R.mask(p['rings']) for p in parts]
        lo = np.array([p['min_h'] for p in parts])
        hi = np.array([p['height_m'] for p in parts])
        anyP = np.zeros_like(O)
        top_above = np.zeros(O.shape)
        for m, h in zip(P, hi):
            anyP |= m
            top_above = np.where(m, np.maximum(top_above, h), top_above)
        fills = []
        # (a) plan area of the outline that no part covers: the outline's own volume there
        U = O & ~anyP
        cellA = R.res * R.res
        if U.sum() * cellA > max(12.0, 0.08 * O.sum() * cellA):
            tpl = max(outs, key=lambda o: o['area'])
            h_out = tpl['height_m']
            if not tpl.get('tagged'):
                h_out = min(h_out, hi.max())
            elif hi.max() >= h_out - 2.0:
                # the outline's tagged height is the whole building's and a part reaches it: what
                # no part covers is lower, the podium a raised part stands on, else as estimated
                raised = lo[lo > 3.0]
                h_out = min(h_out, float(raised.min()) if raised.size else tpl.get('height_est', h_out))
            # else no part reaches the tagged height: the uncovered area is the tallest volume
            for rings in R.rings(U):
                f = _fill_record(tpl, rings, max(0.0, tpl['min_h']), h_out, len(fills), clean, tpl['floor_h'])
                if f:
                    f['shape'] = tpl['shape'] if U.sum() > 0.9 * O.sum() else 0
                    f['rise'] = tpl['rise'] if f['shape'] else 0.0
                    fills.append(f)
                    st['plan fillers'] += 1
        # (b) floors under parts that nothing holds up, band by band between the parts' levels
        zs = sorted(set([0.0] + [float(v) for v in lo] + [float(v) for v in hi]))
        bands = []
        for z0, z1 in zip(zs[:-1], zs[1:]):
            if z1 - z0 < 1e-3:
                continue
            cov = np.zeros_like(O)
            for m, a, b in zip(P, lo, hi):
                if a <= z0 + GAP_TOL and b >= z1 - GAP_TOL:
                    cov |= m
            need = O & (top_above >= z1 - GAP_TOL) & ~cov
            bands.append([z0, z1, need])
        # merge runs of equal masks (one filler per run) and drop thin bands (rounding)
        runs = []
        for z0, z1, need in bands:
            if runs and np.array_equal(runs[-1][2], need):
                runs[-1][1] = z1
            else:
                runs.append([z0, z1, need])
        for z0, z1, need in runs:
            if z1 - z0 < GAP_TOL or need.sum() * cellA < 12.0:
                continue
            # the facade of the floors below a part continues that part's (Sarona's glass shaft)
            above = [p for m, p, a in zip(P, parts, lo) if a >= z1 - GAP_TOL and (m & need).any()]
            tpl = min(above, key=lambda p: p['min_h']) if above else max(outs, key=lambda o: o['area'])
            for rings in R.rings(need):
                f = _fill_record(tpl, rings, z0, z1, len(fills), clean, tpl['floor_h'])
                if f:
                    fills.append(f)
                    st['gap fillers'] += 1
                    st['gap filled (m)'] += round(z1 - z0)
        out += fills
        st['outlines replaced'] += len(outs)
    log(f'parts: {dict(st)}')
    return out


class Grid:
    """Bounding boxes of records in square cells, for neighbour queries."""

    def __init__(self, recs, cell=64.0):
        self.cell = cell
        self.cells = collections.defaultdict(list)
        self.bb = np.zeros((len(recs), 4))
        for i, r in enumerate(recs):
            p = r['rings'][0]
            x0, z0 = p.min(0)
            x1, z1 = p.max(0)
            self.bb[i] = (x0, z0, x1, z1)
            for cx in range(int(x0 // cell), int(x1 // cell) + 1):
                for cz in range(int(z0 // cell), int(z1 // cell) + 1):
                    self.cells[(cx, cz)].append(i)

    def query(self, x0, z0, x1, z1):
        s = set()
        c = self.cell
        for cx in range(int(x0 // c), int(x1 // c) + 1):
            for cz in range(int(z0 // c), int(z1 // c) + 1):
                s.update(self.cells.get((cx, cz), ()))
        return s


def sample_points(r, target=120):
    """Points inside a footprint (a grid with ~target points), for overlap tests."""
    p = r['rings'][0]
    (x0, z0), (x1, z1) = p.min(0), p.max(0)
    step = max(0.75, math.sqrt(max(r['area'], 1.0) / target))
    xs = np.arange(x0 + step / 2, x1, step)
    zs = np.arange(z0 + step / 2, z1, step)
    if not len(xs) or not len(zs):
        return np.array([[r['cx'], r['cz']]])
    X, Z = np.meshgrid(xs, zs)
    X, Z = X.ravel(), Z.ravel()
    ins = geom.points_in_polygon(X, Z, r['rings'])
    if not ins.any():
        return np.array([[r['cx'], r['cz']]])
    return np.stack([X[ins], Z[ins]], 1)


def _share_inside(pts, r):
    return float(geom.points_in_polygon(pts[:, 0], pts[:, 1], r['rings']).mean())


def _free_standing(r):
    """Volumes meant to stand on columns or other structures (roofs, carports, bridges)."""
    return r['kind'] == 'roof' or (r.get('cls') or '') in ('bridge', 'roof', 'carport', 'bridge_structure')


def _support_top(recs, grid, i, keep):
    """Top (m above sea level) of the highest volume under record i covering >= 15 % of it."""
    r = recs[i]
    bot, _ = abs_range(r)
    pts = sample_points(r, 60)
    best = -1e9
    for j in grid.query(*grid.bb[i]):
        if j == i or not keep[j]:
            continue
        o = recs[j]
        ob, ot = abs_range(o)
        if ob >= bot - 0.5 or ot < best:
            continue
        if _share_inside(pts, o) >= 0.15:
            best = max(best, ot)
    return bot, best


def floating(recs, tol=5.0):
    """Raised volumes whose bottom is more than tol m above what is under them (a check)."""
    grid = Grid(recs)
    keep = np.ones(len(recs), bool)
    out = []
    for i, r in enumerate(recs):
        if r['min_h'] <= 3.0 or _free_standing(r):
            continue
        bot, best = _support_top(recs, grid, i, keep)
        under = max(best, _mid(r))
        if bot - under > tol:
            out.append((round(bot - under, 1), r['id'], round(r['area'])))
    return sorted(out, reverse=True)


def support(recs, log=print):
    """Raised volumes standing on nothing: lowered onto what is under them, or dropped."""
    grid = Grid(recs)
    lowered = dropped = 0
    keep = np.ones(len(recs), bool)
    rows = []
    # bottom up: a dropped fragment no longer holds up what was standing on it
    for i in sorted(range(len(recs)), key=lambda k: abs_range(recs[k])[0]):
        r = recs[i]
        if r['min_h'] <= 3.0 or _free_standing(r):
            continue
        bot, best = _support_top(recs, grid, i, keep)
        if best >= bot - 4.0:
            continue
        ground = _mid(r)
        under = max(best, ground)
        rows.append((round(bot - under, 1), r['id'], round(r['area']), round(r['min_h'], 1), round(r['height_m'], 1)))
        # a small piece high up with nothing under it is a rooftop element (a crown, a mast
        # room) whose tower is not mapped: lowered, it would be a pillar; dropped instead
        if (r['area'] < 150 and r.get('part')) or (r['area'] < 400 and bot - under > 20.0):
            keep[i] = False
            dropped += 1
        else:
            r['min_h'] = max(0.0, under - ground) if best > ground + 0.5 else 0.0
            lowered += 1
    rows.sort(reverse=True)
    log(f'support: {lowered} raised volumes lowered onto what is under them, {dropped} small fragments dropped; '
        f'largest gaps {rows[:6]}')
    return [r for r, k in zip(recs, keep) if k]


def _quality(r):
    """Which of two duplicates to keep: parts > tagged OpenStreetMap > OpenStreetMap > ML; then taller."""
    return ((1 if r.get('part') else 0), (1 if r.get('tagged') else 0), (1 if r['dataset'] == 'OpenStreetMap' else 0),
            (1 if r.get('cls') else 0), r['height_m'])


def _facade_quality(r):
    """Whose facade two volumes of one tower share: a tagged facade > a name > a class > the larger."""
    return ((1 if r.get('facade_material') or r.get('facade_color') else 0), (1 if r.get('name') else 0),
            (1 if r.get('cls') else 0), r['area'])


SPECIAL_STYLES = (11, 12, 13)    # stack, hangar, frame: their floors / floor height mean other things


def dedup(recs, log=print):
    """Near-identical and hidden volumes dropped; overlapping ones flagged for a wall inset."""
    n0 = len(recs)
    grid = Grid(recs, cell=48.0)
    cx = np.array([r['cx'] for r in recs])
    cz = np.array([r['cz'] for r in recs])
    keep = np.ones(n0, bool)
    pts_cache = {}

    def pts(i):
        if i not in pts_cache:
            pts_cache[i] = sample_points(recs[i])
        return pts_cache[i]

    st = collections.Counter()
    order = sorted(range(n0), key=lambda i: -recs[i]['area'])      # big volumes first
    for b in order:
        if not keep[b]:
            continue
        B = recs[b]
        bx, bz, ha, hb, yaw = B['obb']
        cand = [a for a in grid.query(*grid.bb[b]) if a != b and keep[a]]
        if not cand:
            continue
        cand = np.array(cand)
        c, s = math.cos(yaw), math.sin(yaw)
        u = (cx[cand] - bx) * c + (cz[cand] - bz) * s
        v = -(cx[cand] - bx) * s + (cz[cand] - bz) * c
        cand = cand[(np.abs(u) <= ha + 0.5) & (np.abs(v) <= hb + 0.5)]
        bb0, bt0 = abs_range(B)
        for a in cand:
            if not keep[a] or not keep[b]:
                continue
            A = recs[a]
            ab0, at0 = abs_range(A)
            if min(at0, bt0) - max(ab0, bb0) < 1.0:            # stacked, not side by side
                continue
            ca = _share_inside(pts(a), B)                      # share of A inside B
            if ca < 0.05:
                continue
            cb = _share_inside(pts(b), A)
            inter = 0.5 * (ca * A['area'] + cb * B['area'])
            iou = inter / max(A['area'] + B['area'] - inter, 1e-6)
            if iou > 0.8:
                lo, hi_ = (a, b) if _quality(A) < _quality(B) else (b, a)
                keep[lo] = False
                st['near-identical'] += 1
                if recs[lo]['height_m'] > 30:
                    st['near-identical over 30 m'] += 1
                continue
            if ca > 0.9 and ab0 >= bb0 - 1.0 and at0 <= bt0 + 1.0:
                keep[a] = False                                  # A is hidden inside B
                st['hidden inside another'] += 1
                continue
            if cb > 0.9 and bb0 >= ab0 - 1.0 and bt0 <= at0 + 1.0:
                keep[b] = False
                st['hidden inside another'] += 1
                continue
            # both stay: the lesser one's walls step back a little (no coplanar walls)
            lesser = a if _quality(A) < _quality(B) else b
            recs[lesser]['inset'] = True
            st['overlapping, inset'] += 1
            # a tall volume mostly inside another is one tower mapped twice (Seven Stars in Bnei
            # Brak: a 211 m inner block in a 200 m glass outline; Moshe Aviv): one facade for both,
            # the one tagged, so they read as one building (floors and windows line up)
            if (min(A['height_m'], B['height_m']) > 30.0 and max(ca, cb) > 0.5
                    and (A['style'] & 15) not in SPECIAL_STYLES and (B['style'] & 15) not in SPECIAL_STYLES):
                src, dst = (A, B) if _facade_quality(A) >= _facade_quality(B) else (B, A)
                for k in ('style', 'wall_rgb', 'floor_h', 'bay', 'seed'):
                    dst[k] = src[k]
                st['tall overlaps sharing one facade'] += 1
    out = [r for r, k in zip(recs, keep) if k]
    log(f'dedup: {n0} -> {len(out)} volumes; {dict(st)}')
    return out, dict(st)
