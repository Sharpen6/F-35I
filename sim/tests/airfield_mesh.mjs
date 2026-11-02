// Node test of js/world/runwayMesh.js: a runway rectangle cut out of the terrain's 25 m triangles
// covers exactly the rectangle, every vertex lies on the terrain's surface (HeightField.heightAt's
// triangles), every triangle faces up, and s, t are the runway frame.
//
//   node sim/tests/airfield_mesh.mjs

import { drapeRunway } from '../js/world/runwayMesh.js';
import { HeightField, CORE_N } from '../js/terrain/HeightField.js';

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('FAIL', msg); } };

// a height field with relief and the 5 cm quantisation of the real data
const hf = new HeightField();
for (let j = 0; j < CORE_N; j++) {
  for (let i = 0; i < CORE_N; i++) {
    const h = 40 + 3 * Math.sin(i * 0.37) + 2 * Math.cos(j * 0.23) + 0.7 * Math.sin((i + j) * 1.3);
    hf.core[j * CORE_N + i] = Math.round((h + 500) / 0.05);
  }
}
const sample = (i, j) => hf.coreSample(i, j);
for (const [deg, L, W] of [[28.9, 2773, 30], [79.8, 3668, 30.1], [0, 2409, 30.4], [45, 700, 9], [90, 540, 4.6]]) {
  const a = (deg * Math.PI) / 180;
  const rw = { x0: -13125.4, z0: -21764.8, ux: Math.sin(a), uz: -Math.cos(a), sMin: -451.5, sMax: L + 321.5, tMax: W };
  const out = { pos: [], st: [], nrm: [], rw: [], idx: [] };
  const origin = [-13000, -22000];
  const tris = drapeRunway(rw, sample, origin, 3, out);
  let area = 0, maxErr = 0, down = 0, stErr = 0;
  const n = out.pos.length / 3;
  for (let k = 0; k < n; k++) {
    const x = out.pos[k * 3] + origin[0], y = out.pos[k * 3 + 1], z = out.pos[k * 3 + 2] + origin[1];
    maxErr = Math.max(maxErr, Math.abs(y - hf.heightAt(x, z)));
    const dx = x - rw.x0, dz = z - rw.z0;
    stErr = Math.max(stErr, Math.abs(dx * rw.ux + dz * rw.uz - out.st[k * 2]), Math.abs(-dx * rw.uz + dz * rw.ux - out.st[k * 2 + 1]));
  }
  for (let k = 0; k < out.idx.length; k += 3) {
    const [a0, b0, c0] = [out.idx[k], out.idx[k + 1], out.idx[k + 2]].map((v) => v * 3);
    const e1 = [out.pos[b0] - out.pos[a0], out.pos[b0 + 1] - out.pos[a0 + 1], out.pos[b0 + 2] - out.pos[a0 + 2]];
    const e2 = [out.pos[c0] - out.pos[a0], out.pos[c0 + 1] - out.pos[a0 + 1], out.pos[c0 + 2] - out.pos[a0 + 2]];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];        // y of e1 x e2
    area += Math.abs(ny) / 2;
    if (ny <= 0) down++;
  }
  const want = (rw.sMax - rw.sMin) * 2 * rw.tMax;
  check(Math.abs(area - want) / want < 1e-4, `heading ${deg}: area ${area.toFixed(1)} vs ${want.toFixed(1)}`);
  check(maxErr < 2e-3, `heading ${deg}: vertex off the terrain by ${maxErr.toFixed(4)} m`);
  check(stErr < 1e-3, `heading ${deg}: s, t off by ${stErr}`);
  check(down === 0, `heading ${deg}: ${down} triangles facing down`);
  check(out.rw.every((v) => v === 3), `heading ${deg}: runway index`);
  console.log(`heading ${deg}: ${tris} triangles, ${n} vertices, area ${(area / want * 100).toFixed(4)} %, height error ${maxErr.toExponential(1)} m`);
}
console.log(fails ? `${fails} FAILED` : 'airfield_mesh: all passed');
process.exit(fails ? 1 : 0);
