// The ejection seat's headbox and main beams, rebuilt at load time (pcd/parts.js puts them in place).
//
// The glb's seat (scripts/f35/cockpit.py build_seat, a Martin-Baker US16E "simplified") is made of
// bevelled boxes: looking back over the shoulder, the beam beside the head is a flat slab and the
// headbox a block. Rebuilt in the same places and sizes (each box read off the glb part itself):
//
//   * the headbox: the parachute container with rounded edges under a lid (a seam 3 cm below its
//     top), as on the US16E's (photos c09, c34: a dark box just under the glass);
//   * the main beams: rounded box sections with a machined guide strip down their front inner
//     edge and bolts along their inner face (the seat's structure, dark metal).

import * as THREE from 'three';
import { roundedBox, stud } from './shapes.js';

/**
 * The oriented box of a glb part (a bevelled box, tilted about x only: the seat leans back):
 * x extent, the principal axes of its points in the yz plane. points: [x, y, z, ...] (root frame).
 * Returns {c, u, v (the long axis in yz, upwards), w (across it, forwards), hu, hv, hw}.
 */
export function partBox(points) {
  let n = 0, my = 0, mz = 0, x0 = Infinity, x1 = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    x0 = Math.min(x0, points[i]); x1 = Math.max(x1, points[i]);
    my += points[i + 1]; mz += points[i + 2]; n++;
  }
  my /= n; mz /= n;
  let syy = 0, szz = 0, syz = 0;
  for (let i = 0; i < points.length; i += 3) {
    const dy = points[i + 1] - my, dz = points[i + 2] - mz;
    syy += dy * dy; szz += dz * dz; syz += dy * dz;
  }
  // the principal direction of the 2x2 covariance; the more vertical one is v
  const a = 0.5 * Math.atan2(2 * syz, syy - szz);
  let v = new THREE.Vector3(0, Math.cos(a), Math.sin(a));
  let w = new THREE.Vector3(0, -Math.sin(a), Math.cos(a));
  if (Math.abs(w.y) > Math.abs(v.y)) [v, w] = [w, v];
  if (v.y < 0) v.negate();
  if (w.z < 0) w.negate();
  let v0 = Infinity, v1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const dy = points[i + 1], dz = points[i + 2];
    const pv = v.y * dy + v.z * dz, pw = w.y * dy + w.z * dz;
    v0 = Math.min(v0, pv); v1 = Math.max(v1, pv); w0 = Math.min(w0, pw); w1 = Math.max(w1, pw);
  }
  const c = new THREE.Vector3((x0 + x1) / 2, 0, 0).addScaledVector(v, (v0 + v1) / 2).addScaledVector(w, (w0 + w1) / 2);
  return { c, u: new THREE.Vector3(1, 0, 0), v, w, hu: (x1 - x0) / 2, hv: (v1 - v0) / 2, hw: (w1 - w0) / 2 };
}

export const SEAT = {
  headR: 0.02,              // the headbox's edge radius
  lid: 0.032,               // the lid's height, its seam (gap) below it
  seam: 0.003,
  beamR: 0.0075,            // the beams' edge radius
  strip: [0.006, 0.0065],   // the guide strip's half sizes (across, deep)
  bolt: { pitch: 0.13, r: 0.0042, h: 0.0016 },
};

/** The headbox (container and lid) from its glb box, into MeshBuilder B (root frame). */
export function buildHeadbox(b, B) {
  const S = SEAT;
  const top = b.c.clone().addScaledVector(b.v, b.hv);
  // the container: from the bottom to under the seam
  const hc = b.hv - (S.lid + S.seam) / 2;
  const cc = b.c.clone().addScaledVector(b.v, -(S.lid + S.seam) / 2);
  roundedBox(B, cc, b.u, b.v, b.w, b.hu, hc, b.hw, S.headR, 3, 1);
  // the lid: a little proud of the container all round
  const cl = top.clone().addScaledVector(b.v, -S.lid / 2);
  roundedBox(B, cl, b.u, b.v, b.w, b.hu + 0.002, S.lid / 2, b.hw + 0.002, S.headR * 0.7, 3, 1);
}

/**
 * A main beam from its glb box (side +1: +x, the left; -1 the right), into MeshBuilders B (the
 * beam and its guide strip, in the seat's paint) and M (its bolts, bare metal), root frame.
 */
export function buildBeam(b, side, B, M) {
  const S = SEAT;
  roundedBox(B, b.c, b.u, b.v, b.w, b.hu, b.hv, b.hw, S.beamR, 2, 1);
  // the guide strip: down the front edge of the inner face (towards the pilot), clear of the ends
  const [sa, sd] = S.strip;
  const inner = -side;                                   // the inner face's x direction
  const cs = b.c.clone()
    .addScaledVector(b.u, inner * (b.hu - sa * 0.6))
    .addScaledVector(b.w, b.hw - sd * 0.9);
  roundedBox(B, cs, b.u, b.v, b.w, sa, b.hv - 0.03, sd, 0.002, 2, 1);
  // bolts down the inner face, behind the strip
  const n = new THREE.Vector3().copy(b.u).multiplyScalar(inner);
  const p = new THREE.Vector3();
  const count = Math.max(2, Math.floor((2 * b.hv - 0.12) / S.bolt.pitch) + 1);
  for (let k = 0; k < count; k++) {
    const t = -(count - 1) / 2 + k;
    p.copy(b.c).addScaledVector(b.u, inner * b.hu).addScaledVector(b.v, t * S.bolt.pitch).addScaledVector(b.w, -b.hw * 0.25);
    stud(M, p, n, S.bolt.r, S.bolt.h, 6, 0.5);
  }
}
