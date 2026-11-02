// The coaming over the panoramic display, rebuilt at load time (pcd/parts.js puts it in place).
//
// The glb's glare shield (scripts/f35/cockpit.py) is a 3 cm slab tilted 10 deg over the display,
// with two boxes on its front corners: from the seat, "a flat box with two bumps". The F-35 has no
// HUD: the coaming is a low hood whose rounded lip shades the display, its top a flat black
// anti-glare finish that slopes down to the windscreen base, two light pads on its front corners
// (photos c29, c13, c50 head-on, c34, c53, c09 from the side). Rebuilt here in the glb's place:
//
//   * the hood: a section swept across the cockpit, a bull-nosed lip (2 cm, rounded top and
//     bottom), the top sloping down to a rounded front edge, the underside rising from the front
//     to the lip as a brow over the display; its ends bevelled all round (the glb's 45 deg sides),
//     the lip's rear corners rounded in plan;
//   * the two pads on the front corners: low housings with rounded edges lying on the top, both
//     their ends chamfered down to it.
//
// Their outline seen from the eye is the helmet's (js/ui/HMD.js COAMING, measured from the glb:
// the flight path marker is held above that line), so the hood and the pads are fitted to the
// glb's outline from the rig's eye: the top is the glb's top plane (a hair below it), the front
// faces are set where the rounded front edges stand just under the glb's sharp ones (the
// silhouette is that of the edge's round, tangent to the line of sight). Where the helmet's line
// cuts a corner between two of its 1 deg samples (the pads' ends, the lip's rear corners), the
// part follows the cut: the pads' ends are chamfers from their top to the hood's, the lip's corner
// is rounded (8 mm) back from the top's edge. tests/cockpit_parts.test.mjs checks the outline
// against HMD.js's line every 0.5 deg: never more than 0.03 deg above it, nowhere more than 0.1
// deg under it.

import * as THREE from 'three';
import { MeshBuilder, sweepProfiles, roundedPolygon, cap } from './shapes.js';

const DEG = Math.PI / 180;

export const HOOD = {
  slope: 10 * DEG,            // the top's fall towards the front (the glb's, when it cannot be read off it)
  lip: 0.021,                 // height of the lip's rear face
  lipR: [0.009, 0.005],       // its top and bottom radii
  front: 0.040,               // depth of the front face (it runs down into the panel)
  frontR: 0.007,
  brow: [0.09, 0.029, 0.04],  // the underside's knee: (from the lip, below the lip's top, radius)
  end: 0.0115,                // the ends: bevelled at 45 deg over this (m) past the glb top's edge, all round
  fillet: 0.004,              // (the bevel's fillet at the top's edge)
  corner: 0.008,              // plan radius of the lip's rear corners, at the top's edge
  cornerAt: 0,                // (where their round ends, past the glb top's edge)
  lower: 0.0003,              // the tops this far below the glb's (m)
  margin: 0.02 * DEG,         // the fitted front edges' outline this far under the glb's (rad)
  // the pads: their ends chamfered down to the hood's top over [x0, x1] and [x2, x3] (|x|, m: the
  // helmet's line runs from the hood to the pad's top between two of its samples there); the
  // radius of their edges
  pad: { x: [0.155, 0.169, 0.255, 0.270], r: 0.004 },
};

/**
 * The glb's shield and pads as numbers (root frame), from their points ([x, y, z, ...]): {box,
 * top: {z0, y0, z1, y1} (the top plane's rear and front edges, in (z, y)), X (the top's half
 * width), pads: {z0, z1, top: {z0, y0, z1, y1}} | null}.
 */
export function coamingSpec(shield, pads = null) {
  const box = boxOf(shield);
  const top = topLine(shield, box);
  if (!top) throw new Error('the glare shield has no sloping top');
  let X = 0;
  for (let i = 0; i < shield.length; i += 3) {
    const y = shield[i + 1], z = shield[i + 2];
    if (y > lineY(top, z) - 0.001) X = Math.max(X, Math.abs(shield[i]));
  }
  let pad = null;
  if (pads && pads.length) {
    const pb = boxOf(pads), pt = topLine(pads, pb);
    if (pt) pad = { z0: pb.min.z, z1: pb.max.z, top: pt, box: pb };
  }
  return { box, top, X, pads: pad, shield, padPoints: pads };
}

function boxOf(p) {
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 3) b.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]));
  return b;
}

/** The top plane's edges: the highest point (rear), and the highest one within 1.2 cm of the front. */
function topLine(p, box) {
  let r = null, f = null;
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1], z = p[i + 2];
    if (!r || y > r[1] + 1e-6 || (Math.abs(y - r[1]) <= 1e-6 && z > r[0])) r = [z, y];
    if (z > box.max.z - 0.012 && (!f || y > f[1])) f = [z, y];
  }
  if (!r || !f || f[0] - r[0] < 0.02) return null;
  return { z0: r[0], y0: r[1], z1: f[0], y1: f[1] };
}

const lineY = (L, z) => L.y0 + (L.y1 - L.y0) * (z - L.z0) / (L.z1 - L.z0);

/** The steepest angle (rad) from the eye's (z, y) to any of the points, in the (z, y) plane. */
function outline2D(eye, zy) {
  let best = -Infinity;
  for (const [z, y] of zy) best = Math.max(best, Math.atan2(y - eye.y, z - eye.z));
  return best;
}

/**
 * Where a front face goes (z) so that its profile's outline from the eye is `target`: f(z) gives
 * the profile's points for a front face at z; the outline rises as the face moves forward.
 */
function fitFront(eye, f, target, lo, hi) {
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (outline2D(eye, f(m)) > target) hi = m; else lo = m;
  }
  return lo;
}

/**
 * The hood and its pads in the glTF root frame. spec: coamingSpec(...); eye: the design eye
 * (Vector3, root frame). Returns {hood, pads (BufferGeometries, root frame; pads null without the
 * glb's), fit: {zf, zp, slope (deg)}}.
 */
export function buildCoaming(spec, eye) {
  const H = HOOD, T = spec.top;
  const tan = (T.y0 - T.y1) / (T.z1 - T.z0);
  const yTop = (z) => lineY(T, z) - H.lower;
  const X0 = spec.X, Xend = X0 + H.end, Rc = H.corner, Xc = X0 + H.cornerAt;
  const zr = spec.box.min.z + 0.003;                // the lip's rear face
  const glbOutline = outline2D(eye, pairs(spec.shield));
  // the ends: past the top's edge (e > 0) the section shrinks all round, a 45 deg bevel with a
  // fillet at the top's edge; the lip's corners rounded in plan (radius Rc)
  const dropAt = (e) => (e <= 0 ? 0 : e < H.fillet ? (e * e) / (2 * H.fillet) : e - H.fillet / 2);
  const pullAt = (ax) => {
    const c = Math.min(Rc, ax - (Xc - Rc));
    return c > 0 ? Rc - Math.sqrt(Math.max(0, Rc * Rc - c * c)) : 0;
  };
  // the profile at |x| = ax, the front face at zf
  const profile = (zf, ax) => {
    const drop = dropAt(ax - X0), zl = zr + pullAt(ax) + drop;
    return roundedPolygon([
      [zf - drop, yTop(zf) - H.front, 0, 0.7],
      [zf - drop, yTop(zf) - drop, H.frontR, 1],
      [zl, yTop(zl) - drop, H.lipR[0], 1],
      [zl + 0.003, yTop(zl) - H.lip, H.lipR[1], 0.85],
      [zr + H.brow[0], yTop(zr) - H.brow[1], H.brow[2], 0.75],
    ], 5);
  };
  const zy = (prof) => prof.map((q) => [q.t, q.n]);
  const zf = fitFront(eye, (z) => zy(profile(z, 0)), glbOutline - H.margin, spec.box.max.z - 0.02, spec.box.max.z + 0.02);
  // frames across the cockpit: every 3 cm, closer over the corners and the bevelled ends
  const xs = new Set();
  const Xm = Math.min(X0, Xc - Rc), nMid = Math.max(2, Math.round((2 * Xm) / 0.03));
  for (let k = 0; k <= nMid; k++) xs.add(+(-Xm + (2 * Xm * k) / nMid).toFixed(5));
  for (let k = 1; k <= 8; k++) {
    const x = Xc - Rc + Rc * Math.sin((k / 8) * Math.PI / 2);
    if (x < X0) { xs.add(+x.toFixed(5)); xs.add(+(-x).toFixed(5)); }
  }
  for (let k = 0; k <= 6; k++) {
    const x = X0 + H.end * (k / 6);
    xs.add(+x.toFixed(5)); xs.add(+(-x).toFixed(5));
  }
  const frames = [], profiles = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    frames.push({ o: new THREE.Vector3(x, 0, 0), t: new THREE.Vector3(0, 0, 1), n: new THREE.Vector3(0, 1, 0) });
    profiles.push(profile(zf, Math.abs(x)));
  }
  const B = new MeshBuilder();
  sweepProfiles(B, frames, profiles, true);
  cap(B, frames[0], profiles[0], new THREE.Vector3(-1, 0, 0));
  cap(B, frames[frames.length - 1], profiles[profiles.length - 1], new THREE.Vector3(1, 0, 0));
  const hood = B.geometry();
  // the pads: on the top, the glb's depth and top plane
  let pads = null, zp = null;
  const Pd = spec.pads;
  if (Pd) {
    const [x0, x1, x2, x3] = H.pad.x, r = H.pad.r;
    const pTop = (z) => lineY(Pd.top, z) - H.lower;
    // h: the share of the pad's height (its ends' chamfers)
    const padProfile = (z1, h) => {
      const yb = (z) => yTop(z) - 0.002;                       // (its foot inside the hood's top)
      const yt = (z) => yTop(z) + (pTop(z) - yTop(z)) * h;
      const rr = Math.max(0.0004, Math.min(r, (yt(z1) - yb(z1)) * 0.45));
      return roundedPolygon([
        [Pd.z0, yb(Pd.z0), 0, 0.7],
        [z1, yb(z1), 0, 0.7],
        [z1, yt(z1), rr, 1],
        [Pd.z0, yt(Pd.z0), rr, 1],
      ], 4);
    };
    const padOutline = outline2D(eye, pairs(spec.padPoints));
    zp = fitFront(eye, (z) => zy(padProfile(z, 1)), padOutline - H.margin, Pd.z1 - 0.02, Pd.z1 + 0.02);
    const P = new MeshBuilder();
    const px = [];
    for (let k = 0; k <= 4; k++) px.push(x0 + (x1 - x0) * (k / 4));
    const nFlat = Math.max(2, Math.round((x2 - x1) / 0.02));
    for (let k = 1; k < nFlat; k++) px.push(x1 + (x2 - x1) * (k / nFlat));
    for (let k = 0; k <= 4; k++) px.push(x2 + (x3 - x2) * (k / 4));
    for (const s of [-1, 1]) {
      const fr = [], pr = [];
      for (const x of px) {
        const h = x < x1 ? (x - x0) / (x1 - x0) : x > x2 ? (x3 - x) / (x3 - x2) : 1;
        fr.push({ o: new THREE.Vector3(s * x, 0, 0), t: new THREE.Vector3(0, 0, 1), n: new THREE.Vector3(0, 1, 0) });
        pr.push(padProfile(zp, Math.max(0.02, h)));
      }
      sweepProfiles(P, fr, pr, true);
      cap(P, fr[0], pr[0], new THREE.Vector3(-s, 0, 0));
      cap(P, fr[fr.length - 1], pr[pr.length - 1], new THREE.Vector3(s, 0, 0));
    }
    pads = P.geometry();
  }
  return { hood, pads, fit: { zf: +zf.toFixed(4), zp: zp === null ? null : +zp.toFixed(4), slope: +(Math.atan(tan) / DEG).toFixed(2), X: +X0.toFixed(4) } };
}

/** [x, y, z, ...] -> [[z, y], ...] */
function pairs(p) {
  const out = [];
  for (let i = 0; i < p.length; i += 3) out.push([p[i + 2], p[i + 1]]);
  return out;
}
