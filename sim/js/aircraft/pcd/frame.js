// The canopy bow, rebuilt at load time from the glb's own (pcd/parts.js puts it in place).
//
// The glb's bow (scripts/f35/canopy.py build_bow) is a plain slab under the glass, 8.5 cm wide and
// 2.6 cm deep with square edges: from the seat, 35-50 cm away, a flat black arch over the whole
// forward view. The real one (photos of the F-35's one-piece transparency, docs/research.md:
// "a dark band about 8-9 cm wide, a third of the way back, leaning forward at the top") is a
// machined frame bonded under the transparency, so the same band, swept here with a real section:
//
//   glass  ======================================================  (n = 0: the inner surface)
//          (seal)\__ flange (4.5 mm) ___/ body \___ flange __/(seal)
//                    o   o   o   o     |      |      o   o           <- fastener rows
//                                      \______/ <- inner face, 5 cm, rounded edges (r 5 mm)
//
// * the flange: the full 8.5 cm band against the glass, with a sealant fillet along both edges
//   (what reads as the band's edge from outside);
// * the body: 5 cm wide, 3 cm deep (the glb's depth), its edges rounded so they catch the sky;
// * a row of fastener heads on each flange strip, every 3.2 cm.
// It keeps the glb's arch exactly: the rings come from the glb mesh (welded, walked from one end
// cap to the other), so the outside view of the bow through the glass does not move.

import * as THREE from 'three';
import { MeshBuilder, sweep, cap, stud, alongPolyline } from './shapes.js';

/** The section (m): t across the band (its centre 0), n inwards from the glass's inner surface. */
export const BOW = {
  gap: 0.0015,          // the flange's back off the glass (the glb's outer face is 4 mm in)
  flange: 0.0045,       // flange thickness
  bodyHalf: 0.0255,     // half width of the body
  depth: 0.0298,        // the inner face's depth below the glass at its centre
  round: 0.005,         // radius of the body's inner edges
  seal: 0.004,          // the sealant fillet's reach beyond the flange edge, on the glass
  pitch: 0.032,         // fastener spacing along the arch
  stud: [0.0031, 0.0013], // fastener head radius, height
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
  const ids = new Map(), rep = new Int32Array(P.count), pts = [];
  for (let i = 0; i < P.count; i++) {
    const k = `${Math.round(P.getX(i) * 1e4)},${Math.round(P.getY(i) * 1e4)},${Math.round(P.getZ(i) * 1e4)}`;
    let r = ids.get(k);
    if (r === undefined) { r = pts.length; ids.set(k, r); pts.push(new THREE.Vector3().fromBufferAttribute(P, i)); }
    rep[i] = r;
  }
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

/** The section's outline, counterclockwise in (t, n) (outside on the right), for a band of half width h. */
function section(h) {
  const B = BOW, g = B.gap, f = g + B.flange, b = B.bodyHalf, d = B.depth, r = B.round;
  const half = [
    // the sealant fillet, from the glass to the flange's top edge (concave)
    // (black sealant: a low occlusion term darkens it in the shade, where the bow is seen)
    { t: h + B.seal, n: 0.0007, hard: true, cav: 0.5 },
    { t: h + B.seal * 0.45, n: 0.0021, cav: 0.45 },
    { t: h + 0.0006, n: f - 0.0012, cav: 0.5 },
    // the flange's edge (a 1 mm chamfer) and its inner face, out to the body's root fillet
    { t: h - 0.0008, n: f, hard: true, cav: 0.9 },
    { t: b + 0.0022, n: f, cav: 0.62 },
    { t: b + 0.0006, n: f + 0.0012, cav: 0.55 },
    // the body's side (a little draft), its rounded inner edge, the inner face
    { t: b, n: f + 0.003, cav: 0.7 },
    { t: b - 0.0007, n: d - r, cav: 0.95 },
    { t: b - 0.0007 - r * (1 - Math.SQRT1_2), n: d - r * (1 - Math.SQRT1_2) - 0.0002 },
    { t: b - 0.0007 - r, n: d - 0.0003 },
    { t: 0, n: d },
  ];
  // the left half mirrored (the inner face's centre is shared), then the back against the glass
  const out = [];
  for (let k = 0; k < half.length; k++) out.push(half[k]);
  for (let k = half.length - 2; k >= 0; k--) out.push({ ...half[k], t: -half[k].t });
  out.push({ t: -h + 0.004, n: g, hard: true, cav: 0.9 });
  out.push({ t: h - 0.004, n: g, hard: true, cav: 0.9 });
  // (up the +t side, over the inner face to -t, back along the glass: counterclockwise in (t, n))
  return out;
}

/**
 * The bow's geometry (the glb bow's local frame) from its rings. Returns {geometry, fasteners
 * (their heads, a geometry of their own for their own finish), studs (count), length}.
 */
export function buildBow(rings) {
  const B = new MeshBuilder();
  // the arch's direction at each ring (central differences)
  const frames = rings.map((r, i) => {
    const a = rings[Math.max(0, i - 1)].o, c = rings[Math.min(rings.length - 1, i + 1)].o;
    return { o: r.o, t: r.t, n: r.n, b: c.clone().sub(a).normalize(), half: r.half };
  });
  const h = frames.reduce((s, f) => s + f.half, 0) / frames.length;
  const prof = section(h);
  sweep(B, frames, prof, true);
  cap(B, frames[0], prof, frames[0].b.clone().negate());
  cap(B, frames[frames.length - 1], prof, frames[frames.length - 1].b);
  // fastener heads along both flange strips (clear of the ends)
  const F = new MeshBuilder();
  const tf = (BOW.bodyHalf + h) / 2 + 0.0004, nf = BOW.gap + BOW.flange;
  const line = frames.map((f) => f.o);
  const at = alongPolyline(line, BOW.pitch, 0.03);
  const o = new THREE.Vector3(), t = new THREE.Vector3(), n = new THREE.Vector3(), p = new THREE.Vector3();
  let studs = 0;
  for (const { k, f } of at) {
    const A = frames[k], C = frames[Math.min(frames.length - 1, k + 1)];
    o.lerpVectors(A.o, C.o, f);
    t.lerpVectors(A.t, C.t, f).normalize();
    n.lerpVectors(A.n, C.n, f).normalize();
    for (const side of [-1, 1]) {
      p.copy(o).addScaledVector(t, side * tf).addScaledVector(n, nf);
      stud(F, p, n, BOW.stud[0], BOW.stud[1], 8, 0.5);
      studs++;
    }
  }
  let length = 0;
  for (let k = 1; k < line.length; k++) length += line[k].distanceTo(line[k - 1]);
  return { geometry: B.geometry(), fasteners: F.geometry(), studs, length };
}
