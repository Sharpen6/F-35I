// The side consoles' panels, built at load time (pcd/parts.js puts them in place).
//
// The glb's consoles (scripts/f35/cockpit.py) are plain boxes with a grid of toggle switches, the
// throttle's track (left) and the side-stick's base (right) standing on a flat top: from the seat,
// two flat grey slabs. A fighter's console top is a row of Dzus-fastened panels (5.75 in wide, each
// held by a quarter-turn fastener at every corner) on the console's rails, the switches through
// them, the throttle in its quadrant: built here on the glb console's top, out of its features' way:
//
//   * a black base on the whole top (the rails and the seams between the panels read dark);
//   * one panel per row of switches, a blank panel aft of them and blank panels forward up to the
//     throttle quadrant / the stick's panel, whose plates go round the track or the base;
//   * a fastener head at each panel corner, part of the panel (its paint: on the real consoles the
//     Dzus heads are the panel's colour, not bright metal).

import * as THREE from 'three';
import { MeshBuilder, roundedBox, stud } from './shapes.js';

export const CONSOLE = {
  inset: 0.004,        // the panels' margin from the console's edges
  gap: 0.0025,         // the seam between two panels
  base: 0.0012,        // the black base's thickness
  plate: 0.0026,       // a panel's thickness, its edge radius
  plateR: 0.0012,
  blank: 0.095,        // the longest blank panel
  clear: 0.004,        // clearance round a feature (the throttle's track, the stick's base)
  dzus: { r: 0.0026, h: 0.0009, inset: 0.0055 },
};

/**
 * A console's panels. c: {x0, x1 (its top's x extent, root frame), z0, z1, y (the top)}, rows:
 * the switch rows' z (sorted), holes: [{x0, x1, z0, z1}] (features standing on the top), out:
 * the MeshBuilders {base, plates, fasteners} it adds to (root frame). Returns the panel count.
 */
export function buildConsole(c, rows, holes, out) {
  const K = CONSOLE;
  const { base, plates } = out;
  const fasteners = out.fasteners || plates;
  const xa = c.x0 + K.inset, xb = c.x1 - K.inset;
  const yb = c.y + K.base;
  // the black base
  roundedBox(base, new THREE.Vector3((c.x0 + c.x1) / 2, c.y + K.base / 2, (c.z0 + c.z1) / 2),
    _X, _Y, _Z, (c.x1 - c.x0) / 2 - 0.002, K.base / 2 + 0.0004, (c.z1 - c.z0) / 2 - 0.002, 0.0008, 1, 1);
  let n = 0;
  const plate = (x0, x1, z0, z1) => {
    if (x1 - x0 < 0.012 || z1 - z0 < 0.012) return;
    roundedBox(plates, new THREE.Vector3((x0 + x1) / 2, yb + K.plate / 2, (z0 + z1) / 2), _X, _Y, _Z,
      (x1 - x0) / 2, K.plate / 2, (z1 - z0) / 2, K.plateR, 2, 1, 0.9);
    // the fastener heads: one at each corner (two on a narrow strip)
    const d = K.dzus.inset, top = yb + K.plate;
    const xs = x1 - x0 > 0.03 ? [x0 + d, x1 - d] : [(x0 + x1) / 2];
    const zs = z1 - z0 > 0.03 ? [z0 + d, z1 - d] : [(z0 + z1) / 2];
    // (their crowns the plate's own cavity, 0.9)
    for (const x of xs) for (const z of zs) { stud(fasteners, _p.set(x, top, z), _Y, K.dzus.r, K.dzus.h, 8, 0.5, 0.9); out.heads = (out.heads || 0) + 1; }
    n++;
  };
  // the row panels: between the rows' midpoints, the first and last half a pitch out
  let za = c.z0 + K.inset, zb = c.z1 - K.inset;
  let edgeA = za, edgeB = zb;
  if (rows.length) {
    const pitch = rows.length > 1 ? (rows[rows.length - 1] - rows[0]) / (rows.length - 1) : 0.1;
    const cuts = [rows[0] - pitch / 2];
    for (let k = 1; k < rows.length; k++) cuts.push((rows[k - 1] + rows[k]) / 2);
    cuts.push(rows[rows.length - 1] + pitch / 2);
    for (let k = 0; k + 1 < cuts.length; k++) plate(xa, xb, Math.max(za, cuts[k] + K.gap / 2), Math.min(zb, cuts[k + 1] - K.gap / 2));
    edgeA = cuts[0] - K.gap / 2;
    edgeB = cuts[cuts.length - 1] + K.gap / 2;
  }
  // blank panels (at most K.blank long) over [z0, z1]
  const blanks = (z0, z1) => {
    const m = Math.ceil((z1 - z0) / K.blank);
    if (z1 - z0 < 0.012) return;
    for (let k = 0; k < m; k++) plate(xa, xb, z0 + ((z1 - z0) * k) / m + (k ? K.gap / 2 : 0), z0 + ((z1 - z0) * (k + 1)) / m - (k + 1 < m ? K.gap / 2 : 0));
  };
  // aft of the rows
  blanks(za, edgeA - K.gap / 2);
  // forward of the rows: the features' band (plates round them), blanks either side
  const hs = holes.filter((h) => h.z1 > edgeB && h.z0 < zb).sort((a, b) => a.z0 - b.z0);
  let z = edgeB + K.gap / 2;
  for (const h of hs) {
    const b0 = Math.max(z, h.z0 - K.clear - 0.016), b1 = Math.min(zb, h.z1 + K.clear + 0.016);
    blanks(z, b0 - K.gap / 2);
    // the band: strips beside the feature, plates fore and aft of it
    const hx0 = Math.max(xa, h.x0 - K.clear), hx1 = Math.min(xb, h.x1 + K.clear);
    plate(xa, hx0, b0 + K.gap / 2, b1 - K.gap / 2);
    plate(hx1, xb, b0 + K.gap / 2, b1 - K.gap / 2);
    plate(hx0 + K.gap, hx1 - K.gap, b0 + K.gap / 2, h.z0 - K.clear);
    plate(hx0 + K.gap, hx1 - K.gap, h.z1 + K.clear, b1 - K.gap / 2);
    z = b1 + K.gap / 2;
  }
  blanks(z, zb);
  return n;
}

const _X = new THREE.Vector3(1, 0, 0), _Y = new THREE.Vector3(0, 1, 0), _Z = new THREE.Vector3(0, 0, 1);
const _p = new THREE.Vector3();

/** Builders for buildConsole (the fastener heads go with the panels). */
export function consoleBuilders() {
  const plates = new MeshBuilder();
  return { base: new MeshBuilder(), plates, fasteners: plates, heads: 0 };
}
