// node sim/tests/terrain_lod.test.mjs
// CDLOD selection invariants on a synthetic height field (no data files needed):
//  * the patches tile the far area exactly once,
//  * edge neighbours differ by at most one level,
//  * on every shared edge between levels k and k + 1 the finer patch is fully morphed and
//    the coarser one not at all (so the meshes meet without cracks),
//  * triangle counts and patch counts stay within budget,
//  * heightAt() reproduces samples and the NW-SE triangle split.
import { HeightField, CORE_N, FAR_N, FAR_HALF, CORE_HALF, H_OFFSET, H_SCALE, NODE0_M } from '../js/terrain/HeightField.js';
import { QuadTree, morphFactor, GRID } from '../js/terrain/QuadTree.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// --- synthetic heights: rolling hills, a 900 m escarpment and a -430 m basin ---
function synth(x, z) {
  let h = 300 + 250 * Math.sin(x / 7000) * Math.cos(z / 5000) + 60 * Math.sin(x / 900 + z / 1300);
  h += 700 / (1 + Math.exp(-(x - 20000) / 1500)); // escarpment
  if (x > 40000) h = -430 + 30 * Math.sin(z / 3000);
  if (x < -35000) h = 0; // sea
  return Math.max(-500, Math.min(2700, h));
}
const enc = (h) => Math.round((h - H_OFFSET) / H_SCALE);
const hf = new HeightField();
for (let j = 0; j < CORE_N; j++) {
  for (let i = 0; i < CORE_N; i++) hf.core[j * CORE_N + i] = enc(synth(-CORE_HALF + 25 * i, -CORE_HALF + 25 * j));
}
for (let j = 0; j < FAR_N; j++) {
  for (let i = 0; i < FAR_N; i++) hf.far[j * FAR_N + i] = enc(synth(-FAR_HALF + 200 * i, -FAR_HALF + 200 * j));
}
let t0 = performance.now();
hf.buildMinMax();
check('min/max pyramid', hf.minMax.length === 9, `${(performance.now() - t0).toFixed(0)} ms`);

// --- heightAt matches samples and the triangle split ---
{
  const i = 1234, j = 2345;
  const x = -CORE_HALF + 25 * i, z = -CORE_HALF + 25 * j;
  const ha = hf.coreSample(i, j), hb = hf.coreSample(i + 1, j), hc = hf.coreSample(i, j + 1), hd = hf.coreSample(i + 1, j + 1);
  const okS = Math.abs(hf.heightAt(x, z) - ha) < 1e-9 && Math.abs(hf.heightAt(x + 25, z + 25) - hd) < 1e-6;
  // point in the upper-right triangle (fx > fz): plane through a, b, d
  const p1 = hf.heightAt(x + 20, z + 5), e1 = ha + 0.8 * (hb - ha) + 0.2 * (hd - hb);
  // point in the lower-left triangle (fz > fx): plane through a, c, d
  const p2 = hf.heightAt(x + 5, z + 20), e2 = ha + 0.8 * (hc - ha) + 0.2 * (hd - hc);
  const n = hf.normalAt(x + 20, z + 5, {});
  const nExp = [-(hb - ha) / 25, 1, -(hd - hb) / 25];
  const nl = Math.hypot(...nExp);
  const okN = Math.abs(n.x - nExp[0] / nl) < 1e-9 && Math.abs(n.y - 1 / nl) < 1e-9 && Math.abs(n.z - nExp[2] / nl) < 1e-9;
  check('heightAt / normalAt follow the triangle split', okS && Math.abs(p1 - e1) < 1e-9 && Math.abs(p2 - e2) < 1e-9 && okN);
  const xf = 150000.5, zf = -170000.25;
  const hfar = hf.heightAt(xf, zf);
  check('far area is bilinear', Math.abs(hfar - synth(xf, zf)) < 30, `${hfar.toFixed(2)} vs ${synth(xf, zf).toFixed(2)}`);
}

// --- selection invariants for many cameras ---
const qt = new QuadTree(hf);
const cams = [];
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (let n = 0; n < 60; n++) {
  const inCore = n % 3 !== 0;
  const half = inCore ? CORE_HALF : FAR_HALF;
  const x = (rnd() * 2 - 1) * half, z = (rnd() * 2 - 1) * half;
  const agl = [2, 30, 300, 1500, 3000, 10000, 15000][n % 7];
  cams.push({ x, y: hf.heightAt(x, z) + agl, z });
}
cams.push({ x: -18591, y: 32, z: -3608 }); // on a runway-like spot
cams.push({ x: CORE_HALF + 1, y: 50, z: 0 }); // just outside the core boundary

const cell = NODE0_M; // the smallest patch is 1600 m
const nCells = (2 * FAR_HALF) / cell;
let worstTris = 0, worstPatches = 0, coverOk = true, levelOk = true, morphOk = true, detail = '';
const vertexHeight = (ux, uz) => hf.heightAt(-FAR_HALF + 25 * ux, -FAR_HALF + 25 * uz);

for (const cam of cams) {
  const patches = qt.select(cam).map((p) => ({ ...p, originU: [...p.originU] }));
  // coverage
  const cover = new Uint8Array(nCells * nCells);
  let tris = 0;
  for (const p of patches) {
    const c0 = Math.round((p.x0 + FAR_HALF) / cell), r0 = Math.round((p.z0 + FAR_HALF) / cell), n = Math.round(p.size / cell);
    for (let r = r0; r < r0 + n; r++) for (let c = c0; c < c0 + n; c++) cover[r * nCells + c]++;
    tris += (p.half ? GRID / 2 : GRID) ** 2 * 2;
  }
  if (cover.some((v) => v !== 1)) { coverOk = false; detail = `cover cam ${JSON.stringify(cam)}`; }
  worstTris = Math.max(worstTris, tris);
  worstPatches = Math.max(worstPatches, patches.length);
  // neighbours: map each 1600 m cell to its patch
  const owner = new Int32Array(nCells * nCells);
  patches.forEach((p, idx) => {
    const c0 = Math.round((p.x0 + FAR_HALF) / cell), r0 = Math.round((p.z0 + FAR_HALF) / cell), n = Math.round(p.size / cell);
    for (let r = r0; r < r0 + n; r++) for (let c = c0; c < c0 + n; c++) owner[r * nCells + c] = idx;
  });
  const dist = (ux, uz) => {
    const x = -FAR_HALF + 25 * ux, z = -FAR_HALF + 25 * uz;
    return Math.hypot(x - cam.x, vertexHeight(ux, uz) - cam.y, z - cam.z);
  };
  const seen = new Set();
  for (let r = 0; r < nCells; r++) {
    for (let c = 0; c < nCells; c++) {
      for (const [dr, dc] of [[0, 1], [1, 0]]) {
        const r2 = r + dr, c2 = c + dc;
        if (r2 >= nCells || c2 >= nCells) continue;
        const a = patches[owner[r * nCells + c]], b = patches[owner[r2 * nCells + c2]];
        if (a === b || a.level === b.level) continue;
        if (Math.abs(a.level - b.level) > 1) { levelOk = false; detail = `levels ${a.level}/${b.level}`; continue; }
        const key = `${r},${c},${dr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const fine = a.level < b.level ? a : b, coarse = a.level < b.level ? b : a;
        // the shared edge segment of this cell pair, walked at the fine patch's vertex step
        const step = fine.stepU;
        const u = (c + dc) * (cell / 25), v = (r + dr) * (cell / 25);
        const len = cell / 25;
        for (let s = 0; s <= len; s += step) {
          const ux = dc ? u : c * (cell / 25) + s;
          const uz = dc ? r * (cell / 25) + s : v;
          const d = dist(ux, uz);
          const mf = morphFactor(fine.level, d), mc = morphFactor(coarse.level, d);
          if (mf < 1 || mc > 0) { morphOk = false; detail = `edge morph fine L${fine.level}=${mf.toFixed(3)} coarse L${coarse.level}=${mc.toFixed(3)} d=${d.toFixed(0)}`; }
        }
      }
    }
  }
}
check('patches tile the far area exactly once', coverOk, detail);
check('edge neighbours differ by at most one level', levelOk, detail);
check('shared edges: finer fully morphed, coarser unmorphed', morphOk, detail);
check('triangles before frustum culling < 2 M (culled budget is checked in the browser)', worstTris < 2e6, `worst ${(worstTris / 1e6).toFixed(2)} M tris, ${worstPatches} patches`);

// --- timing ---
t0 = performance.now();
for (let n = 0; n < 200; n++) qt.select(cams[n % cams.length]);
check('selection is fast', (performance.now() - t0) / 200 < 2, `${((performance.now() - t0) / 200).toFixed(3)} ms per select`);

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('all LOD tests passed');
