// The coaming over the panoramic display, rebuilt at load time (pcd/parts.js puts it in place).
//
// The glb's glare shield (scripts/f35/cockpit.py) is a 3 cm slab tilted 10 deg over the display,
// with two boxes on its front corners: from the seat, "a flat box with two bumps". The F-35 has no
// HUD: the coaming is a low hood whose rounded lip shades the display, its top a flat black
// anti-glare finish that slopes down to the windscreen base. Rebuilt here in the glb's place and
// size (its bounding box), so its edge seen from the eye stays where the helmet's symbology
// expects it (js/ui/HMD.js COAMING: the flight path marker is held above that line):
//
//   * the hood: a section swept across the cockpit, a bull-nosed lip (2 cm, rounded top and
//     bottom), the top sloping 10 deg down to a rounded front edge, the underside rising from the
//     front to the lip as a brow over the display; the plan's corners rounded (r 4 cm);
//   * the two pads on the front corners (photos c29, c13, c50 head-on, c34, c53, c09 from the
//     side: light, low housings): rounded boxes lying on the top, no higher than the glb's.

import * as THREE from 'three';
import { MeshBuilder, sweepProfiles, roundedPolygon, roundedBox, cap } from './shapes.js';

export const HOOD = {
  slope: 10 * Math.PI / 180,  // the top's fall towards the front (the glb's tilt)
  lip: 0.021,                 // height of the lip's rear face
  lipR: [0.009, 0.005],       // its top and bottom radii
  front: 0.040,               // depth of the front face (it runs down into the panel)
  frontR: 0.007,
  brow: [0.09, 0.029, 0.04],  // the underside's knee: (from the lip, below the lip's top, radius)
  corner: 0.04,               // plan radius of the corners
  pad: { x: 0.2125, z: 0.18, size: [0.0425, 0.0085, 0.028], r: 0.005 },   // centre (|x|, from the lip), half sizes, radius
};

/**
 * The hood and its pads in the glTF root frame, from the glb shield's box ({min, max}, root frame).
 * Returns {hood, pads} (BufferGeometries, root frame) and the lip's line for the record.
 */
export function buildCoaming(box) {
  const H = HOOD;
  const X = box.max.x - 0.001;                    // half width (the helmet's COAMING line: hood side at 0.279)
  const zr = box.min.z + 0.003;                   // the lip's rear face
  const zf = box.max.z + 0.004;                   // the front face
  const y0 = box.max.y - 0.0015;                  // the top at the lip
  const tan = Math.tan(H.slope);
  const yTop = (z) => y0 - (z - zr) * tan;
  // frames across the cockpit: even in the middle, closer in the rounded corners
  const Re = H.corner, xs = [];
  const mid = X - Re, nMid = Math.max(2, Math.round((2 * mid) / 0.03));
  for (let k = 0; k <= 8; k++) xs.push(-mid - Re * Math.sin(((8 - k) / 8) * Math.PI / 2));
  for (let k = 1; k < nMid; k++) xs.push(-mid + (2 * mid * k) / nMid);
  for (let k = 0; k <= 8; k++) xs.push(mid + Re * Math.sin((k / 8) * Math.PI / 2));
  const frames = [], profiles = [];
  for (const x of xs) {
    const e = Math.max(0, Math.abs(x) - mid);
    const u0 = Re - Math.sqrt(Math.max(0, Re * Re - e * e));        // the lip pulled forward in the corners
    const zl = zr + u0;
    const zb = Math.max(zr + H.brow[0], zl + 0.05);
    const corners = [
      [zf, yTop(zf) - H.front, 0, 0.7],
      [zf, yTop(zf), H.frontR, 1],
      [zl, yTop(zl), H.lipR[0], 1],
      [zl + 0.003, yTop(zl) - H.lip, H.lipR[1], 0.85],
      [zb, yTop(zl) - H.brow[1], H.brow[2], 0.75],
    ];
    frames.push({ o: new THREE.Vector3(x, 0, 0), t: new THREE.Vector3(0, 0, 1), n: new THREE.Vector3(0, 1, 0) });
    profiles.push(roundedPolygon(corners, 5));
  }
  const B = new MeshBuilder();
  sweepProfiles(B, frames, profiles, true);
  cap(B, frames[0], profiles[0], new THREE.Vector3(-1, 0, 0));
  cap(B, frames[frames.length - 1], profiles[profiles.length - 1], new THREE.Vector3(1, 0, 0));
  const hood = B.geometry();
  // the pads: lying on the top (tilted with it), at the front corners
  const P = new MeshBuilder();
  const up = new THREE.Vector3(0, Math.cos(H.slope), Math.sin(H.slope));
  const fwd = new THREE.Vector3(0, -Math.sin(H.slope), Math.cos(H.slope));
  const [hx, hy, hz] = H.pad.size;
  for (const s of [-1, 1]) {
    const z = zr + H.pad.z;
    const c = new THREE.Vector3(s * H.pad.x, yTop(z), z).addScaledVector(up, hy - 0.0005);
    roundedBox(P, c, new THREE.Vector3(1, 0, 0), up, fwd, hx, hy, hz, H.pad.r, 2, 1);
  }
  const pads = P.geometry();
  return { hood, pads, lip: { zr, y0, X } };
}
