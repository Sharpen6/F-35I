"""Runways: OurAirports (public domain) -> verified, imagery-aligned runway geometry.

For every runway of an open airport inside the core the CSV end points are checked against the
colour tiles (color/L0, i.e. the Sentinel-2 composite as delivered):
  * lateral: in 120 m segments along the runway the cross profile of the imagery is matched with a
    strip of the runway's width; a straight line through the segment centres gives the imagery
    centreline. Its offset from the CSV line at both ends and its heading difference are reported
    and the ends are moved onto it (the CSV is rarely off by more than a few metres, but some are);
  * along: the paved strip (runway plus overruns / stopways) is followed outward from each CSV end
    on the imagery centreline while it keeps the runway's colour; the extra paved length is stored
    as `overrun_m` and is flattened with the runway. A CSV end that lies off the pavement is
    pulled back onto it.
Runways without coordinates in the CSV are searched for around the airport reference point
with the CSV heading and length; if no clear strip is found they are left out (and reported).

Output: <cache>/work/runways.json (used by the height stage and the json stage).
"""
import csv
import json
import math
import os

import numpy as np
from PIL import Image

import grid

FT = 0.3048
ROT_MIN_M = 15.0      # imagery rotations smaller than this at the runway ends are not applied

# airports of type "closed" whose runway is still physically intact in the 2021 imagery
KEEP_CLOSED = {'IL-0023': 'Jerusalem Atarot: closed in 2001, runway still intact in the 2021 imagery'}
NAMES = {  # friendlier display names
    'LLEK': 'Tel Nof', 'LLHS': 'Hatzor', 'LLBG': 'Ben Gurion', 'LL59': 'Palmachim', 'LLHZ': 'Herzliya',
    'IL-0023': 'Jerusalem Atarot (closed)', 'IL-0007': 'Rishon LeZion',
}
TYPES = ('small_airport', 'medium_airport', 'large_airport')


def log(*a):
    print('[runways]', *a, flush=True)


class L0Sampler:
    """Bilinear sampling of the delivered L0 colour tiles at world (x, z); returns sRGB 0..1 (N, 3)."""

    def __init__(self, out):
        self.dir = os.path.join(out, 'color', 'L0')
        self.tiles = {}
        self.n = grid.L0_PX
        self.px = grid.TILE_SIZE / self.n

    def _tile(self, ix, iz):
        k = (ix, iz)
        if k not in self.tiles:
            if 0 <= ix < grid.NTILES and 0 <= iz < grid.NTILES:
                self.tiles[k] = np.asarray(Image.open(os.path.join(self.dir, f'tile_{ix}_{iz}.jpg')).convert('RGB'),
                                           np.float32) / 255.0
            else:
                self.tiles[k] = np.zeros((self.n, self.n, 3), np.float32)
        return self.tiles[k]

    def _pix(self, gi, gj):
        """Values at global pixel indices (gi = column, gj = row), any tiles."""
        out = np.zeros(gi.shape + (3,), np.float32)
        ti, tj = gi // self.n, gj // self.n
        for (a, b) in set(zip(ti.ravel().tolist(), tj.ravel().tolist())):
            sel = (ti == a) & (tj == b)
            t = self._tile(a, b)
            out[sel] = t[gj[sel] - b * self.n, gi[sel] - a * self.n]
        return out

    def sample(self, x, z):
        fx = (np.asarray(x) + grid.CORE_HALF) / self.px - 0.5
        fz = (np.asarray(z) + grid.CORE_HALF) / self.px - 0.5
        i0, j0 = np.floor(fx).astype(np.int64), np.floor(fz).astype(np.int64)
        tx, tz = (fx - i0)[..., None], (fz - j0)[..., None]
        lim = grid.NTILES * self.n - 1
        i0c, i1c = np.clip(i0, 0, lim), np.clip(i0 + 1, 0, lim)
        j0c, j1c = np.clip(j0, 0, lim), np.clip(j0 + 1, 0, lim)
        return ((self._pix(i0c, j0c) * (1 - tx) + self._pix(i1c, j0c) * tx) * (1 - tz) +
                (self._pix(i0c, j1c) * (1 - tx) + self._pix(i1c, j1c) * tx) * tz)


def luma(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)


def heading_deg(dx, dz):
    """World grid heading of a direction (0 = north = -Z, 90 = east = +X)."""
    return math.degrees(math.atan2(dx, -dz)) % 360.0


class Frame:
    """Runway frame: u along (from end A to end B), v across (+ = right of the direction of travel)."""

    def __init__(self, xa, za, xb, zb):
        self.xa, self.za = xa, za
        d = np.array([xb - xa, zb - za], np.float64)
        self.length = float(np.hypot(*d))
        self.t = d / self.length
        self.n = np.array([-self.t[1], self.t[0]])   # right-hand side looking along t (X east, Z south)

    def xz(self, u, v):
        u, v = np.asarray(u, np.float64), np.asarray(v, np.float64)
        return self.xa + u * self.t[0] + v * self.n[0], self.za + u * self.t[1] + v * self.n[1]


def strip_score(prof, vs, c, w):
    """Contrast between a strip of width w centred at c and the bands beside it (cross profile prof(vs))."""
    inner = np.abs(vs - c) < max(w / 2 - 3, 4)
    outer = (np.abs(vs - c) > w / 2 + 4) & (np.abs(vs - c) < w / 2 + 26)
    return prof[..., inner].mean(axis=-1) - prof[..., outer].mean(axis=-1)


def saturation(rgb):
    """Colourfulness (max - min of sRGB). Pavement (asphalt or concrete) is grey, the soil, dry
    grass and fields around Israeli runways are tan: the cleanest pavement feature at 10 m."""
    return rgb.max(axis=-1) - rgb.min(axis=-1)


def trough_centre(prof, vs, search=45.0):
    """Centre and width of the low-saturation trough (the pavement) nearest to v = 0.

    The trough bottom is the lowest point within +-search; its edges are where the profile
    climbs half way back to the surrounding level (median of the outer part). Returns
    (centre, width, depth) or None."""
    inner = np.abs(vs) <= search
    i0 = int(np.flatnonzero(inner)[np.argmin(prof[inner])])
    bottom = prof[i0]
    outer = np.abs(vs - vs[i0]) > 60
    if not outer.any():
        return None
    level = float(np.median(prof[outer]))
    depth = level - bottom
    if depth <= 0.02:
        return None
    half = bottom + 0.5 * depth
    # walk out from the bottom to the half-level crossings (linear interpolation)
    l = i0
    while l > 0 and prof[l] < half:
        l -= 1
    r = i0
    while r < len(prof) - 1 and prof[r] < half:
        r += 1
    if prof[l] < half or prof[r] < half:
        return None
    vl = vs[l] + (half - prof[l]) / (prof[l + 1] - prof[l]) * (vs[l + 1] - vs[l])
    vr = vs[r - 1] + (half - prof[r - 1]) / (prof[r] - prof[r - 1]) * (vs[r] - vs[r - 1])
    return 0.5 * (vl + vr), vr - vl, depth


def fit_lateral(samp, fr, width, search=45.0):
    """Imagery centreline relative to the CSV line, as v = a + b u (u along, v across, metres).

    The along-track median of saturation cross profiles is computed for a fan of small rotations
    about the runway middle; the rotation giving the narrowest, deepest pavement trough wins and
    its centre is the centreline. 200 m segments are then checked against the fitted line.
    Returns (a, b, quality dict, ok)."""
    L = fr.length
    us = np.arange(0.04 * L, 0.96 * L, 5.0)
    vs = np.arange(-(search + 65.0), search + 65.1, 1.0)
    U, V = np.meshgrid(us, vs, indexing='ij')

    def profile(dang, U=U, V=V, off=0.0):
        x, z = fr.xz(U, V + off + (U - L / 2) * math.tan(math.radians(dang)))
        return np.median(saturation(samp.sample(x, z)), axis=0)

    def best_for(angles):
        res = []
        for da in angles:
            t = trough_centre(profile(da), vs, search=search)
            if t is not None:
                c, w, d = t
                res.append((d / max(w, 10.0), da, c, w, d))
        return max(res) if res else None

    best = best_for(np.arange(-1.6, 1.61, 0.1))
    if best is None:
        return 0.0, 0.0, dict(score=0.0, pavement_width_m=None, depth=0.0, segments=0, consistent=0,
                              rms_m=None), False
    best = best_for(np.arange(best[1] - 0.1, best[1] + 0.101, 0.02)) or best
    s, da, c, w, depth = best
    b = math.tan(math.radians(da))
    a = c - b * L / 2
    # check: per-segment trough centres relative to the fitted line
    seg_c = []
    for u0 in np.arange(0.04 * L, 0.96 * L - 200.0, 100.0):
        uu = np.arange(u0, u0 + 200.0, 5.0)
        UU, VV = np.meshgrid(uu, vs, indexing='ij')
        x, z = fr.xz(UU, VV + (a + b * UU))
        t = trough_centre(np.median(saturation(samp.sample(x, z)), axis=0), vs, search=20.0)
        if t is not None:
            seg_c.append(t[0])
    seg_c = np.array(seg_c) if seg_c else np.array([99.0])
    rob = np.abs(seg_c) < 8.0
    rms = float(np.sqrt(np.mean(seg_c[rob] ** 2))) if rob.any() else 99.0
    nseg = int(len(np.arange(0.04 * L, 0.96 * L - 200.0, 100.0)))
    q = dict(score=round(float(s) * 1000, 2), pavement_width_m=round(float(w), 1), depth=round(float(depth), 3),
             segments=nseg, consistent=int(rob.sum()), rms_m=round(rms, 2))
    ok = rob.sum() >= max(3, 0.6 * nseg) and rms < 5.0 and depth > 0.04
    return float(a), float(b), q, bool(ok)


def paved_extent(samp, fr, width):
    """How far the pavement continues beyond each end along the centreline (m), and whether the
    end itself is on pavement.

    Pavement is told from the ground by its low saturation: the threshold sits half way between
    the runway's own saturation and that of the ground beside it. Going outward from each end the
    strip counts as paved until 60 m in a row are not."""
    L = fr.length
    um = np.linspace(0.1 * L, 0.9 * L, 120)
    vv = np.linspace(-0.2 * width, 0.2 * width, 5)
    UM, VV = np.meshgrid(um, vv, indexing='ij')
    s_pave = float(np.median(saturation(samp.sample(*fr.xz(UM, VV)))))
    s_side = float(np.median(np.concatenate([
        saturation(samp.sample(*fr.xz(um, np.full_like(um, width / 2 + 50.0)))),
        saturation(samp.sample(*fr.xz(um, np.full_like(um, -width / 2 - 50.0))))])))
    thr = 0.5 * (s_pave + s_side)
    out = []
    for end, direction in ((0.0, -1.0), (L, 1.0)):
        us = end + direction * np.arange(-20.0, 900.0, 5.0)
        U2, V2 = np.meshgrid(us, vv, indexing='ij')
        s = saturation(samp.sample(*fr.xz(U2, V2))).mean(axis=1)
        paved = s < thr
        run, stop = 0, len(us)
        for i in range(len(us)):
            run = run + 1 if not paved[i] else 0
            if run >= 12:
                stop = i - run + 1
                break
        beyond = max(0.0, float(abs(us[min(stop, len(us) - 1)] - end)) - 0.0) if stop > 4 else 0.0
        on = bool(paved[(np.abs(us - end) <= 15.0)].mean() >= 0.5)
        out.append((min(beyond, 450.0), on))
    return out, dict(s_pave=round(s_pave, 3), s_side=round(s_side, 3))


def inward_pavement(samp, fr, width, k, stats, max_m=400.0):
    """Distance (m) inward from end k (0 = start, 1 = end of the frame) to the first paved point."""
    thr = 0.5 * (stats['s_pave'] + stats['s_side'])
    vv = np.linspace(-0.2 * width, 0.2 * width, 5)
    d = np.arange(0.0, max_m, 5.0)
    us = d if k == 0 else fr.length - d
    U, V = np.meshgrid(us, vv, indexing='ij')
    s = saturation(samp.sample(*fr.xz(U, V))).mean(axis=1)
    paved = s < thr
    # first point from which the next 40 m are paved
    for i in range(len(d) - 8):
        if paved[i:i + 8].all():
            return float(d[i])
    return None


def load_csv(cache):
    d = os.path.join(cache, 'ourairports')
    with open(os.path.join(d, 'airports.csv'), encoding='utf-8') as f:
        aps = {r['ident']: r for r in csv.DictReader(f)}
    with open(os.path.join(d, 'runways.csv'), encoding='utf-8') as f:
        rws = list(csv.DictReader(f))
    return aps, rws


def in_core(x, z, margin=500.0):
    return abs(x) < grid.CORE_HALF - margin and abs(z) < grid.CORE_HALF - margin


def frame_at_reference(x0, z0, hdg_deg, length):
    """Runway frame centred on an airport reference point with the CSV heading and length."""
    h = math.radians(hdg_deg)
    t = np.array([math.sin(h), -math.cos(h)])
    return Frame(x0 - t[0] * length / 2, z0 - t[1] * length / 2, x0 + t[0] * length / 2, z0 + t[1] * length / 2)


def run(cache, out):
    aps, rws = load_csv(cache)
    samp = L0Sampler(out)
    by_ap = {}
    for r in rws:
        by_ap.setdefault(r['airport_ident'], []).append(r)
    result, report = [], []
    for ident, ap in sorted(aps.items()):
        if ident not in by_ap or not ap['latitude_deg']:
            continue
        ax, az = grid.lonlat_to_xz(float(ap['longitude_deg']), float(ap['latitude_deg']))
        if not in_core(ax, az):
            continue
        if ap['type'] not in TYPES and ident not in KEEP_CLOSED:
            report.append(f'{ident} {ap["name"]}: skipped (type {ap["type"]})')
            continue
        entry = dict(icao=ap['gps_code'] or ap['icao_code'] or ident, ident=ident,
                     name=NAMES.get(ident, ap['name']), full_name=ap['name'],
                     elev_ft=float(ap['elevation_ft']) if ap['elevation_ft'] else None,
                     lon=float(ap['longitude_deg']), lat=float(ap['latitude_deg']),
                     closed=ident in KEEP_CLOSED, runways=[])
        for r in by_ap[ident]:
            if r['closed'] == '1':
                continue
            width = float(r['width_ft']) * FT if r['width_ft'] else 30.0
            length = float(r['length_ft']) * FT if r['length_ft'] else None
            ids = [r['le_ident'], r['he_ident']]
            tag = f'{entry["icao"]} {ids[0]}/{ids[1]}'
            if r['le_latitude_deg'] and r['he_latitude_deg']:
                xa, za = grid.lonlat_to_xz(float(r['le_longitude_deg']), float(r['le_latitude_deg']))
                xb, zb = grid.lonlat_to_xz(float(r['he_longitude_deg']), float(r['he_latitude_deg']))
                source = 'csv'
            elif r['le_heading_degT'] and length:
                # no end coordinates: start from the airport reference point, CSV heading and length,
                # and let the imagery fit find the strip (wider lateral search); dropped if inconclusive
                hdg = float(r['le_heading_degT']) - grid.grid_convergence_deg(ax, az)
                fr0 = frame_at_reference(ax, az, hdg, length)
                xa, za = fr0.xz(0.0, 0.0)
                xb, zb = fr0.xz(fr0.length, 0.0)
                source = 'imagery (no coordinates in the CSV)'
            else:
                report.append(f'{tag}: no coordinates and no heading in the CSV: left out')
                continue
            fr = Frame(float(xa), float(za), float(xb), float(zb))
            a, b, q, ok = fit_lateral(samp, fr, width, search=45.0 if source == 'csv' else 120.0)
            if source != 'csv' and not ok:
                report.append(f'{tag}: no coordinates in the CSV and no clear strip at the airport reference point '
                              f'in the imagery: left out')
                continue
            off_a, off_b = a, a + b * fr.length
            hd = math.degrees(math.atan(b))
            rot_note = None
            amb_note = None
            if ok and source == 'csv' and abs(a + b * fr.length / 2) > width / 2 + 10.0:
                # a move of more than half a runway width: only if the CSV line is off the pavement.
                # If it already runs along a paved strip, the fit has found another one (a parallel
                # taxiway, an apron): ambiguous at 10 m, the CSV is kept.
                uu = np.arange(0.05 * fr.length, 0.95 * fr.length, 10.0)
                s_csv = float(np.median(saturation(samp.sample(*fr.xz(uu, np.zeros_like(uu))))))
                s_fit = float(np.median(saturation(samp.sample(*fr.xz(uu, a + b * uu)))))
                if s_csv < s_fit + 0.5 * q['depth']:
                    amb_note = (f'imagery fit found a paved strip {a + b * fr.length / 2:+.1f} m away, but the CSV line '
                                'already runs along pavement (ambiguous at 10 m): CSV kept')
                    ok = False
            if ok and abs(off_b - off_a) / 2 < ROT_MIN_M:
                # the lateral shift is well measured in 10 m imagery, the angle much less so (checked
                # against OpenStreetMap: ~0.3-0.5 deg errors on 2.4 km runways). Keep the CSV heading
                # unless the imagery says it is clearly wrong.
                mid = a + b * fr.length / 2
                rot_note = (f'imagery rotation {hd:+.2f} deg ({off_a - mid:+.1f} m at the ends) not applied '
                            f'(under {ROT_MIN_M:.0f} m; angles from 10 m imagery are less reliable than the CSV '
                            'heading): CSV heading kept, centreline shifted')
                off_a = off_b = mid
                hd = 0.0
            if ok:
                # move both ends onto the imagery centreline (lateral only)
                xa2, za2 = fr.xz(0.0, off_a)
                xb2, zb2 = fr.xz(fr.length, off_b)
            else:
                xa2, za2, xb2, zb2 = xa, za, xb, zb
            fr2 = Frame(float(xa2), float(za2), float(xb2), float(zb2))
            ext, sat_stats = paved_extent(samp, fr2, width)
            notes = []
            # an end off the pavement is pulled back onto it
            for k in (0, 1):
                if not ext[k][1]:
                    u_in = inward_pavement(samp, fr2, width, k, sat_stats)
                    if u_in is not None and u_in > 0:
                        p_end = fr2.xz(u_in if k == 0 else fr2.length - u_in, 0.0)
                        if k == 0:
                            xa2, za2 = p_end
                        else:
                            xb2, zb2 = p_end
                        notes.append(f'end {ids[k]} was {u_in:.0f} m off the pavement: moved onto it')
            fr2 = Frame(float(xa2), float(za2), float(xb2), float(zb2))
            ext, sat_stats = paved_extent(samp, fr2, width)
            (ov_a, ct_a), (ov_b, ct_b) = ext
            if rot_note:
                notes.insert(0, rot_note)
            if amb_note:
                notes.insert(0, amb_note)
            if source != 'csv':
                notes.insert(0, f'located in the imagery: centreline {off_a:+.1f} / {off_b:+.1f} m from the line '
                                'through the airport reference point with the CSV heading')
            elif ok and max(abs(off_a), abs(off_b)) > 10.0:
                notes.insert(0, f'CSV centreline off by {off_a:+.1f} / {off_b:+.1f} m at the ends: corrected from the imagery')
            elif ok:
                notes.insert(0, f'CSV centreline within {max(abs(off_a), abs(off_b)):.1f} m of the imagery (moved onto it)')
            elif not amb_note:
                notes.insert(0, 'imagery fit not conclusive (narrow strip inside a wider light paved/sandy area at '
                                '10 m resolution): CSV kept; the CSV line lies on the paved area' if ext[0][1] or ext[1][1]
                             else 'imagery fit not conclusive: CSV kept')
            ends = []
            for k, (xx, zz, idd, ov, ct, other) in enumerate(((xa2, za2, ids[0], ov_a, ct_a, (xb2, zb2)),
                                                              (xb2, zb2, ids[1], ov_b, ct_b, (xa2, za2)))):
                hdg = heading_deg(other[0] - xx, other[1] - zz)
                lon, lat = grid.xz_to_lonlat(xx, zz)
                disp = r['le_displaced_threshold_ft' if k == 0 else 'he_displaced_threshold_ft']
                ends.append(dict(id=idd, x=round(float(xx), 2), z=round(float(zz), 2), heading_deg=round(hdg, 2),
                                 lon=round(float(lon), 7), lat=round(float(lat), 7),
                                 overrun_m=round(ov, 0),
                                 displaced_threshold_m=round(float(disp) * FT, 1) if disp else 0.0,
                                 on_pavement=ct))
                if not ct:
                    notes.append(f'end {idd}: pavement not confirmed in the imagery')
            if ov_a > 30 or ov_b > 30:
                notes.append(f'pavement continues {ov_a:.0f} m beyond {ids[0]} and {ov_b:.0f} m beyond {ids[1]} '
                             '(overruns; flattened with the runway, overrun_m)')
            entry['runways'].append(dict(
                ids=ids, width_m=round(width, 1), length_m=round(fr2.length, 1),
                length_csv_m=round(length, 1) if length else None,
                surface=(r['surface'] or 'unknown').lower(), lighted=r['lighted'] == '1',
                ends=ends, source=source,
                check=dict(fit_ok=ok, offset_end_a_m=round(off_a, 1), offset_end_b_m=round(off_b, 1),
                           heading_diff_deg=round(hd, 3), quality=q, notes=notes)))
            report.append(f'{tag}: CSV vs imagery centreline {off_a:+.1f} m at {ids[0]}, {off_b:+.1f} m at {ids[1]} '
                          f'(heading {hd:+.2f} deg); fit score {q["score"]}, segment rms {q["rms_m"]} m '
                          f'({q["consistent"]}/{q["segments"]} consistent); ' + '; '.join(notes))
        if entry['runways']:
            result.append(entry)
    for line in report:
        log(line)
    with open(os.path.join(cache, 'work', 'runways.json'), 'w') as f:
        json.dump(dict(airports=result, report=report), f, indent=1)
