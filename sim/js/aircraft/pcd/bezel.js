// The panoramic display's bezel, built at load time (pcd/parts.js puts it in place).
//
// The glb's frame round the 20 x 8 in glass (scripts/f35/cockpit.py) is four square bars and a
// divider. The PCD's own housing is a moulded bezel with rounded corners whose inner lip is
// chamfered down to the glass, the two halves parted by a slim mullion, its screws (the bezel's
// own finish) at the corners: swept here round the glass's rectangle (the glass, its picture and
// the canvas mapping are the glb's, untouched).

import * as THREE from 'three';
import { MeshBuilder, sweep, roundedPolygon, roundedBox, stud, ccw } from './shapes.js';

export const BEZEL = {
  width: 0.018,          // the frame's face beyond the glass's edge
  proud: 0.0045,         // its face in front of the glass
  depth: 0.012,          // its outer side back into the panel
  lip: 0.003,            // the inner chamfer's run on the face
  inner: 0.004,          // the opening's corner radius
  edge: 0.0035,          // the outer edge's radius
  mullion: [0.0022, 0.0016],   // the divider's half width, its height in front of the glass
  screw: { r: 0.0024, h: 0.0009 },
};

/**
 * The bezel from the glass's rectangle: c (centre), u (right, unit), v (up the glass, unit), n
 * (its normal, towards the pilot), hu, hv (half sizes), all in the root frame. Returns {frame
 * (BufferGeometry, root frame, the screw heads with it), screws (their count)}.
 */
export function buildBezel({ c, u, v, n, hu, hv }) {
  const K = BEZEL;
  const B = new MeshBuilder(), S = B;
  let screws = 0;
  // the profile across the frame: t outwards from the glass's edge, n towards the pilot
  const W = K.width;
  const prof = roundedPolygon(ccw([
    [0, -0.004, 0, 0.6],
    [0, 0.0006, 0, 0.55],
    [K.lip, K.proud, 0.0008, 0.9],
    [W - K.edge, K.proud, 0, 1],
    [W, K.proud - K.edge, K.edge, 1],
    [W, -K.depth, 0, 0.6],
  ]), 3);
  // the path round the opening (a rounded rectangle), counterclockwise seen from the pilot
  const r = K.inner, path = [];
  const corners = [[hu - r, -(hv - r), -Math.PI / 2], [hu - r, hv - r, 0], [-(hu - r), hv - r, Math.PI / 2], [-(hu - r), -(hv - r), Math.PI]];
  for (const [x, y, a0] of corners) {
    for (let k = 0; k <= 4; k++) {
      const a = a0 + (k / 4) * (Math.PI / 2);
      path.push({ x: x + r * Math.cos(a), y: y + r * Math.sin(a), ox: Math.cos(a), oy: Math.sin(a) });
    }
  }
  path.push(path[0]);
  const frames = path.map((p) => ({
    o: c.clone().addScaledVector(u, p.x).addScaledVector(v, p.y),
    t: u.clone().multiplyScalar(p.ox).addScaledVector(v, p.oy).normalize(),
    n: n.clone(),
  }));
  sweep(B, frames, prof, true);
  // the mullion between the two halves
  roundedBox(B, c.clone().addScaledVector(n, K.mullion[1] / 2 - 0.0005), u, v, n, K.mullion[0], hv + 0.001, K.mullion[1] / 2 + 0.0005, 0.0008, 2, 1);
  // screws: the corners and the middles of the long sides, on the face
  const o = new THREE.Vector3();
  const d = W * 0.55;
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1]]) {
    o.copy(c).addScaledVector(n, K.proud)
      .addScaledVector(u, x * (hu + (x ? d : 0)) + (x === 0 ? 0.06 : 0))
      .addScaledVector(v, y * (hv + d));
    stud(S, o, n, K.screw.r, K.screw.h, 8, 0.5);
    screws++;
    if (x === 0) {
      o.addScaledVector(u, -0.12);
      stud(S, o, n, K.screw.r, K.screw.h, 8, 0.5);
      screws++;
    }
  }
  return { frame: B.geometry(), screws };
}
