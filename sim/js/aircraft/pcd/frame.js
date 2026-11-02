// The canopy bow, rebuilt at load time from the glb's own (pcd/parts.js puts it in place).
//
// The glb's bow (scripts/f35/canopy.py build_bow) is a plain slab under the glass, 8.8 cm wide and
// 2.6 cm deep with square edges: from the seat, 35-55 cm away, a flat black arch over the whole
// forward view (7.4 deg thick at the top). The real one (photos of the F-35's transparency from
// outside and over the pilot's shoulder: c09, c13, c34) is a dark frame bonded under the glass
// whose band, 8-9 cm wide, reads slim from the seat: a body narrower than the band, its edges
// rounded so that they catch the sky, and a thin light line of sealant along the band's edges
// where it meets the glass; a light grey handhold stands off the aft face of each leg, a hand's
// width above the sill (c09, c34: the pilot's hand on it). No rear-view mirrors (the F-35 has
// none: the DAS cameras), no bolt heads on the inside. Swept here with that section:
//
//   glass  ===============================================================  (n = 0: inner surface)
//          (bead)\_ flange __/  body  \__ flange _/(bead)       <- light sealant bead, both edges
//                           |        |
//                            \______/  <- inner face 2.2 cm in, 3.7 cm wide, edges rounded (r 6.5 mm)
//
// * the band keeps the glb's width, ring by ring (the bead's outer edge at the glb's edge, h);
// * seen from the eye at the top of the arch (0.54 m away, the line of sight 33 deg off the band's
//   plane) it is ~5.5 deg thick instead of 7.4: the bead on top, the aft flange and the body's
//   aft side and rounded edge below it, lit, then the inner face;
// * the bow's occlusion is the cockpit's (interior.js: a 'frame' part does not shade itself in the
//   analysis's 1.5 cm voxels), with its own creases (the flange's root, the bead's foot) as a
//   fixed cavity term.
// It keeps the glb's arch exactly: the rings come from the glb mesh (welded, walked from one end
// cap to the other), so the outside view of the bow through the glass does not move.

import * as THREE from 'three';
import { MeshBuilder, mergeBuilt, sweepProfiles, cap, tube, weld, ccwProfile } from './shapes.js';

/** The section (m): t across the band (its centre 0, aft +), n inwards from the glass's inner surface. */
export const BOW = {
  gap: 0.0012,          // the flange's back off the glass (the bead closes the gap at the edges)
  flange: 0.004,        // flange thickness
  bodyHalf: 0.0185,     // half width of the body
  depth: 0.0215,        // the inner face's depth below the glass at its centre
  round: 0.0065,        // radius of the body's inner edges
  bead: [0.005, 0.0034], // the sealant bead: its reach on the glass beyond the flange's edge, its height on that edge
  // the handholds: from / to (arc length from the foot of each leg, m), standoff aft of the body,
  // bar radius, bend radius, depth (n) of the bar
  hand: { from: 0.12, to: 0.265, stand: 0.034, r: 0.0058, bend: 0.012, n: 0.0125 },
};

/** The glb bow's offsets (canopy.py): its outer face 4 mm in from the glass, its inner face 30 mm. */
const GLB_OUTER = 0.004;

/**
 * The bow's rings from the glb mesh (its local frame): [{o (on the glass's inner surface, centre
 * of the band), t (across the band, aft), n (inwards), half (half width)}], or {err}.
 * The glb bow is a closed loop of 4 points per ring (outer fore / aft, inner aft / fore) lofted
 * along the arch with a fan cap at each end: the caps' centres have 4 neighbours, the end rings'
 * points 5, the others 6.
 */
export function bowRings(geometry) {
  const P = geometry.attributes.position;
  if (!P) return { err: 'no positions' };
  const idx = geometry.index ? geometry.index.array : null;
  const w = weld(P), rep = w.rep;
  const pts = Array.from(w.first, (i) => new THREE.Vector3().fromBufferAttribute(P, i));
  const adj = pts.map(() => new Set());
  const nIdx = idx ? idx.length : P.count;
  for (let t = 0; t + 2 < nIdx; t += 3) {
    const a = rep[idx ? idx[t] : t], b = rep[idx ? idx[t + 1] : t + 1], c = rep[idx ? idx[t + 2] : t + 2];
    adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
  }
  const caps = [];
  for (let v = 0; v < pts.length; v++) if (adj[v].size === 4 && [...adj[v]].every((u) => adj[u].size === 5)) caps.push(v);
  if (caps.length !== 2) return { err: `expected 2 end caps, found ${caps.length}` };
  const seen = new Set(caps), loops = [];
  let ring = [...adj[caps[0]]];
  while (ring.length === 4) {
    loops.push(ring);
    for (const v of ring) seen.add(v);
    const next = new Set();
    for (const v of ring) for (const u of adj[v]) if (!seen.has(u)) next.add(u);
    ring = [...next];
  }
  if (ring.length || loops.length * 4 + 2 !== pts.length || loops.length < 8) return { err: `not a lofted band (${loops.length} rings, ${pts.length} points)` };
  if (![...adj[caps[1]]].every((v) => loops[loops.length - 1].includes(v))) return { err: 'the walk did not end at the other cap' };
  // each ring is a loop of 4 (each point joined to two of the others): its two long sides are the
  // outer and the inner face, the outer one farther from the arch's foot line (x at the middle,
  // below the sills)
  const box = new THREE.Box3().setFromPoints(pts);
  const xc = (box.min.x + box.max.x) / 2, yb = box.min.y - 0.05;
  const rad = (p) => Math.hypot(p.x - xc, p.y - yb);
  const rings = [];
  for (const L of loops) {
    const loop = [L[0]];
    while (loop.length < 4) {
      const last = loop[loop.length - 1];
      const nx = L.find((v) => adj[last].has(v) && !loop.includes(v));
      if (nx === undefined) return { err: 'a ring is not a loop' };
      loop.push(nx);
    }
    const sides = [0, 1, 2, 3].map((k) => [pts[loop[k]], pts[loop[(k + 1) % 4]]]);
    const len = sides.map(([a, b]) => a.distanceTo(b));
    const k0 = len[0] + len[2] > len[1] + len[3] ? 0 : 1;       // the long pair: k0, k0 + 2
    const A = sides[k0], C = sides[k0 + 2];
    const mid = (s) => s[0].clone().add(s[1]).multiplyScalar(0.5);
    const [os, is] = rad(mid(A)) > rad(mid(C)) ? [A, C] : [C, A];
    const out = [os[0], os[1]].sort((a, b) => b.z - a.z);        // fore (+Z), aft
    const co = mid(os), ci = mid(is);
    const t = out[1].clone().sub(out[0]);
    const half = t.length() / 2;
    t.normalize();
    const n = ci.sub(co);
    n.addScaledVector(t, -n.dot(t)).normalize();
    rings.push({ o: co.addScaledVector(n, -GLB_OUTER), t, n, half });
  }
  // (sanity: a band 5-15 cm wide)
  if (rings.some((r) => !(r.half > 0.025 && r.half < 0.075))) return { err: 'unexpected band width' };
  return { rings };
}

/**
 * The frame's section for a band of half width h: {t, n, hard, cav} counterclockwise in (t, n).
 * The cavity: 1 on the open faces; the flange strip darkens towards the body's root (the body
 * stands 1.6 cm over it), the root fillet and the foot of the body's side most.
 */
export function section(h) {
  const B = BOW, g = B.gap, f = g + B.flange, b = B.bodyHalf, d = B.depth, r = B.round;
  const e = h - B.bead[0];                       // the flange's edge (the bead beyond it)
  const half = [
    { t: e, n: g, hard: true, cav: 0.8 },         // the edge's foot, in the bead
    { t: e, n: f - 0.0007, cav: 0.92 },
    { t: e - 0.0007, n: f, cav: 1 },              // a 0.7 mm round onto the flange's inner face
    { t: (e + b) / 2 + 0.002, n: f, cav: 0.86 },
    { t: b + 0.0022, n: f, cav: 0.66 },
    { t: b + 0.0006, n: f + 0.0011, cav: 0.55 },  // the root fillet
    { t: b, n: f + 0.0028, cav: 0.64 },
    { t: b - 0.0006, n: d - r, cav: 0.9 },        // the body's side (a little draft), up to the round
  ];
  for (let k = 1; k < 4; k++) {
    const a = (k / 4) * Math.PI / 2;
    half.push({ t: b - 0.0006 - r + r * Math.cos(a), n: d - r + r * Math.sin(a) - 0.0002 * (k / 4), cav: 1 });
  }
  half.push({ t: b - 0.0006 - r, n: d - 0.0002, cav: 1 });
  half.push({ t: 0, n: d, cav: 1 });             // (a slight crown on the inner face)
  const out = half.slice();
  for (let k = half.length - 2; k >= 0; k--) out.push({ ...half[k], t: -half[k].t });
  // (closed back along the glass, from -e to +e)
  return ccwProfile(out);
}

/**
 * The sealant bead along the edge at +t (side 1) or -t (side -1): a concave fillet from the glass
 * to the flange's edge, a little into the flange (no gap).
 */
export function bead(h, side) {
  const B = BOW, e = h - B.bead[0], top = B.gap + B.bead[1];
  const pts = [
    { t: e - 0.0005, n: 0.0002, hard: true, cav: 0.8 },
    { t: e - 0.0005, n: top, hard: true, cav: 0.72 },
  ];
  for (let k = 0; k <= 4; k++) {
    const a = (k / 4) * Math.PI / 2;
    pts.push({ t: h - (h - e) * Math.cos(a), n: top * (1 - Math.sin(a)) + 0.0003 * Math.sin(a), hard: k === 4, cav: k === 0 ? 0.74 : 0.86 });
  }
  return ccwProfile(pts.map((p) => ({ ...p, t: side * p.t })));
}

/** Arc length along the rings' centres, and a frame at any arc length (interpolated). */
function arcFrames(frames) {
  const cum = [0];
  for (let k = 1; k < frames.length; k++) cum.push(cum[k - 1] + frames[k].o.distanceTo(frames[k - 1].o));
  const at = (s) => {
    let k = 1;
    while (k < cum.length - 1 && cum[k] < s) k++;
    const A = frames[k - 1], C = frames[k], f = Math.min(1, Math.max(0, (s - cum[k - 1]) / Math.max(1e-9, cum[k] - cum[k - 1])));
    return {
      o: A.o.clone().lerp(C.o, f),
      t: A.t.clone().lerp(C.t, f).normalize(),
      n: A.n.clone().lerp(C.n, f).normalize(),
    };
  };
  return { length: cum[cum.length - 1], at };
}

/**
 * A handhold on the aft face of a leg: a U of round bar, its two arms into the body's side, the
 * grip along the leg `stand` aft of it. s0, s1: arc lengths of its ends (s1 < s0 on the far leg).
 */
function handhold(F, arc, s0, s1) {
  const H = BOW.hand, b = BOW.bodyHalf, L = Math.abs(s1 - s0), dir = Math.sign(s1 - s0);
  // the U in (u along the leg from s0, w aft of the band's centre), corners rounded
  const w0 = b - 0.003, w1 = b + H.stand, R = H.bend;
  const uv = [[0, w0], [0, w1 - R]];
  for (let k = 1; k < 6; k++) { const a = (k / 6) * Math.PI / 2; uv.push([R - R * Math.cos(a), w1 - R + R * Math.sin(a)]); }
  for (let k = 0; k <= 6; k++) uv.push([R + (L - 2 * R) * (k / 6), w1]);
  for (let k = 1; k < 6; k++) { const a = (k / 6) * Math.PI / 2; uv.push([L - R + R * Math.sin(a), w1 - R + R * Math.cos(a)]); }
  uv.push([L, w1 - R], [L, w0]);
  const path = uv.map(([u, w]) => {
    const f = arc.at(s0 + dir * u);
    return f.o.clone().addScaledVector(f.t, w).addScaledVector(f.n, H.n);
  });
  const mid = arc.at((s0 + s1) / 2);
  // (the U lies in the plane of the leg's direction and t: n is its normal)
  tube(F, path, mid.n, H.r, 10, 0.9);
}

/**
 * The bow's geometry (the glb bow's local frame) from its rings, each ring's section at that
 * ring's width. Returns {geometry (the frame, the bow's paint), fittings (the sealant beads and
 * the handholds, a light grey; also apart: beads, handles), handholds, length, half (the band's
 * mean half width)}.
 */
export function buildBow(rings) {
  const B = new MeshBuilder(), F = new MeshBuilder(), Hh = new MeshBuilder();
  // the arch's direction at each ring (central differences)
  const frames = rings.map((r, i) => {
    const a = rings[Math.max(0, i - 1)].o, c = rings[Math.min(rings.length - 1, i + 1)].o;
    return { o: r.o, t: r.t, n: r.n, b: c.clone().sub(a).normalize(), half: r.half };
  });
  const h = frames.reduce((s, f) => s + f.half, 0) / frames.length;
  const last = frames.length - 1;
  // (each ring's own width: the glb band narrows by 2 mm towards the sills)
  const profs = frames.map((f) => section(f.half));
  sweepProfiles(B, frames, profs, true);
  cap(B, frames[0], profs[0], frames[0].b.clone().negate());
  cap(B, frames[last], profs[last], frames[last].b);
  for (const side of [1, -1]) {
    const p = frames.map((f) => bead(f.half, side));
    sweepProfiles(F, frames, p, true);
    cap(F, frames[0], p[0], frames[0].b.clone().negate());
    cap(F, frames[last], p[last], frames[last].b);
  }
  const arc = arcFrames(frames);
  let handholds = 0;
  if (arc.length > 2 * BOW.hand.to + 0.3) {
    handhold(Hh, arc, BOW.hand.from, BOW.hand.to);
    handhold(Hh, arc, arc.length - BOW.hand.from, arc.length - BOW.hand.to);
    handholds = 2;
  }
  const beads = F.geometry(), handles = Hh.geometry();
  return { geometry: B.geometry(), fittings: mergeBuilt([beads, handles]), beads, handles, handholds, length: arc.length, half: h };
}
