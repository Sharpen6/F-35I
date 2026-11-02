// node sim/dev/terrain.analysis.test.mjs
// Checks the terrain's pure helpers: horizon angles (horizonCore.js) against brute force on a
// synthetic ridge, with the earth's curvature, the field analysis packing (fieldAnalysis.js)
// on a synthetic pattern of striped fields, the built field data's tile edges (when
// data/terrain_extra/fields is there) and the runway overrun corrections.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { computeHorizon, decodeHorizon, EARTH_R } from '../js/terrain/horizonCore.js';
import { analyzeTile, packCodes, CLASS_CODES, CLASS_ORCHARD, CLASS_VINEYARD } from '../js/terrain/fieldAnalysis.js';
import { Runways } from '../js/terrain/Surface.js';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const DEG = Math.PI / 180;

// --- horizon: a 300 m ridge 1.5 km east of the centre, sun due east -------------------------
const ridge = (x, z) => 300 * Math.exp(-(((x - 1500) / 400) ** 2)) + 20 * Math.sin(z / 900);
const job = { cx: 0, cz: 0, ax: 1, az: 0, n: 128, spacing: 50, preroll: 6000 };
const map = computeHorizon(ridge, job);
// brute force for a few texels
let maxErr = 0;
for (const [i, j] of [[10, 64], [40, 30], [60, 100], [70, 64], [100, 64], [120, 5]]) {
  const u0 = ((i + 0.5) / job.n - 0.5) * job.n * job.spacing;
  const v0 = ((j + 0.5) / job.n - 0.5) * job.n * job.spacing;
  const h0 = ridge(u0, v0);
  let best = 0;
  for (let t = job.spacing; u0 + t < job.n * job.spacing / 2 + job.preroll; t += job.spacing) {
    const h = ridge(u0 + t, v0) - t * t / (2 * EARTH_R);
    best = Math.max(best, Math.atan((h - h0) / t));
  }
  const got = decodeHorizon(map[j * job.n + i]);
  maxErr = Math.max(maxErr, Math.abs(got - best));
}
check('horizon angles match brute force (with curvature)', maxErr < 0.12 * DEG, `max error ${(maxErr / DEG).toFixed(3)} deg`);
const west = decodeHorizon(map[64 * job.n + 5]) / DEG, east = decodeHorizon(map[64 * job.n + 125]) / DEG;
check('west of the ridge is shaded at low sun, east of it is open', west > 3 && east < 0.5, `west ${west.toFixed(2)} deg, east ${east.toFixed(2)} deg`);
// curvature: a 1000 m wall 100 km away hides 785 m less: tan = (1000 - 785) / 100000
const wall = (x) => (x > 99900 && x < 100100 ? 1000 : 0);
const m2 = computeHorizon(wall, { cx: 0, cz: 0, ax: 1, az: 0, n: 2, spacing: 50, preroll: 101000 });
const exp = Math.atan((1000 - (100000 ** 2) / (2 * EARTH_R)) / 100000) / DEG;
const got2 = decodeHorizon(m2[0]) / DEG;
check('earth curvature lowers far obstacles', Math.abs(got2 - exp) < 0.02, `expected ${exp.toFixed(3)} deg, got ${got2.toFixed(3)} deg`);
// a rotated job equals the same terrain rotated
// the same terrain turned 90 deg: texel (u, v) of a job with the sun toward -z sits at world (v, -u)
const rot = (x, z) => ridge(-z, x);
const mr = computeHorizon(rot, { ...job, ax: 0, az: -1 });
let maxDiff = 0;
for (let k = 0; k < map.length; k++) maxDiff = Math.max(maxDiff, Math.abs(map[k] - mr[k]));
check('rotated sun direction gives the rotated map', maxDiff <= 1, `max texel difference ${maxDiff}`);
let t0 = performance.now();
computeHorizon(ridge, { cx: 0, cz: 0, ax: 0.6, az: 0.8, n: 512, spacing: 100, preroll: 20000 });
const ms = performance.now() - t0;
check('512 x 512 map with 20 km preroll in < 2 s', ms < 2000, `${ms.toFixed(0)} ms`);

// --- field analysis ----------------------------------------------------------------------
// 512 x 512 image: two fields side by side, each elongated along a different axis
const W = 512;
const rgba = new Uint8ClampedArray(W * W * 4);
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    // left half: fields 40 px wide (x) x 200 px tall (y) -> rows north-south;
    // right half: fields 200 px wide x 40 px tall -> rows east-west
    let shade;
    if (x < 256) shade = (Math.floor(x / 40) % 2 ? 150 : 110) + (Math.floor(y / 200) % 2 ? 12 : 0);
    else shade = (Math.floor(y / 40) % 2 ? 150 : 110) + (Math.floor(x / 200) % 2 ? 12 : 0);
    const k = (y * W + x) * 4;
    rgba[k] = shade; rgba[k + 1] = shade * 0.85; rgba[k + 2] = shade * 0.6; rgba[k + 3] = 255;
  }
}
const N = 640;
const codes = new Uint8Array(N * N).fill(40);
for (let i = 0; i < N; i++) codes[i] = 10;  // top row trees
t0 = performance.now();
const data = analyzeTile(rgba, W, codes, N);
const msA = performance.now() - t0;
const theta = (i, j) => ((data[j * N + i] >> 4) & 127) / 128 * 180;
const angDist = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };
let okL = 0, okR = 0, nL = 0, nR = 0;
for (let j = 40; j < 600; j += 23) {
  for (let i = 20; i < 300; i += 23) { nL++; if (angDist(theta(i, j), 90) < 6) okL++; }
  for (let i = 340; i < 620; i += 23) { nR++; if (angDist(theta(i, j), 0) < 6) okR++; }
}
check('rows follow long, narrow fields (N-S on the left)', okL / nL > 0.85, `${okL}/${nL}`);
check('rows follow long, narrow fields (E-W on the right)', okR / nR > 0.85, `${okR}/${nR}`);
check('class index packed in bits 0-3', CLASS_CODES[data[5] & 15] === 10 && CLASS_CODES[data[N * 300 + 5] & 15] === 40);
check('analysis of a 512^2 tile in < 1.5 s', msA < 1500, `${msA.toFixed(0)} ms`);
const pk = packCodes(new Uint8Array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]), 1);
check('packCodes maps ESA codes to class indices', pk[0] === 0, '');
const pk2 = packCodes(new Uint8Array(16).map((_, i) => [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100, 0, 0, 0, 0][i]), 4);
check('every ESA code round-trips', [...pk2.slice(0, 12)].every((v, i) => CLASS_CODES[v] === [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100][i]));

// --- the built field data (tools/terrain/fields.py): no seams at the tile edges -----------
// Pairs of neighbouring crop texels (both crop, orchard or vineyard) across every tile edge
// against the pairs across each tile's middle row and column (the control: same data, no
// edge). A field cut by a tile edge must keep its row direction and its random number, so
// the edge pairs may differ no more often than the inner ones (the per-tile analysis had
// 44-56 % of edge pairs more than 15 deg apart against 1-4 % inside).
const FIELDS = fileURLToPath(new URL('../data/terrain_extra/fields/', import.meta.url));
if (existsSync(join(FIELDS, 'index.json'))) {
  const idx = JSON.parse(readFileSync(join(FIELDS, 'index.json'), 'utf8'));
  const n = idx.n, T = idx.tiles;
  const tile = (ix, iz) => {
    const f = join(FIELDS, `tile_${ix}_${iz}.u16.gz`);
    if (!existsSync(f)) return null;
    const b = gunzipSync(readFileSync(f));
    return new Uint16Array(b.buffer, b.byteOffset, n * n);
  };
  const ROWS = new Set([4, CLASS_ORCHARD, CLASS_VINEYARD]);   // crop, orchard, vineyard
  const st = { edge: { n: 0, dir: 0, rnd: 0 }, inner: { n: 0, dir: 0, rnd: 0 } };
  const pair = (s, a, b) => {
    if ((a & 15) !== (b & 15) || !ROWS.has(a & 15)) return;
    s.n++;
    const d = Math.abs(((a >> 4) & 127) - ((b >> 4) & 127)) % 128;
    if (Math.min(d, 128 - d) * 180 / 128 > 15) s.dir++;
    if ((a >> 11) === (b >> 11)) s.rnd++;
  };
  t0 = performance.now();
  let prevRow = new Array(T).fill(null);
  for (let iz = 0; iz < T; iz++) {
    const row = [];
    for (let ix = 0; ix < T; ix++) row.push(tile(ix, iz));
    for (let ix = 0; ix < T; ix++) {
      const A = row[ix];
      if (!A) continue;
      const R = ix + 1 < T ? row[ix + 1] : null, U = prevRow[ix];
      const h = n >> 1;
      for (let k = 0; k < n; k++) {
        if (R) pair(st.edge, A[k * n + n - 1], R[k * n]);
        if (U) pair(st.edge, U[(n - 1) * n + k], A[k]);
        pair(st.inner, A[k * n + h - 1], A[k * n + h]);
        pair(st.inner, A[(h - 1) * n + k], A[h * n + k]);
      }
    }
    prevRow = row;
  }
  const pc = (s, k) => (100 * s[k] / Math.max(s.n, 1));
  const e = st.edge, i = st.inner;
  const detail = `edges ${pc(e, 'dir').toFixed(1)} % of ${e.n} pairs, inside ${pc(i, 'dir').toFixed(1)} % of ${i.n}`;
  check('field data: row directions across tile edges agree as well as inside tiles',
    e.n > 1000 && pc(e, 'dir') <= Math.max(2 * pc(i, 'dir'), pc(i, 'dir') + 3), detail);
  check('field data: a field keeps its random number across tile edges',
    pc(e, 'rnd') >= pc(i, 'rnd') - 10, `edges ${pc(e, 'rnd').toFixed(1)} %, inside ${pc(i, 'rnd').toFixed(1)} % same (${(performance.now() - t0).toFixed(0)} ms)`);
} else {
  console.log('SKIP  field data seams (no data/terrain_extra/fields: run tools/terrain/fields.py)');
}

// --- measured overrun corrections (Surface.js OVERRUN_FIX) --------------------------------
const rws = new Runways([{ icao: 'LLEK', runways: [{ width_m: 45.7, surface: 'asphalt', ends: [
  { id: '18', x: -19544.25, z: -5219.09, overrun_m: 215 }, { id: '36', x: -19662.59, z: -2812.92, overrun_m: 145 }] }] }]);
const r36 = rws.list[0];
check('Tel Nof 36 overrun follows the imagery (390 m)', r36.overrun[1] === 390 && r36.overrun[0] === 215);
check('the pavement 300 m south of threshold 36 is runway', rws.find(-19662.59 + 300 * -0.0491, -2812.92 + 300 * 0.9988) === r36);
// a data set built with the corrections (runways.py OVERRUN_CONFIRMED_M) or a longer measure wins
const rws2 = new Runways([{ icao: 'LLEK', runways: [{ width_m: 45.7, surface: 'asphalt', ends: [
  { id: '18', x: -19544.25, z: -5219.09, overrun_m: 215 }, { id: '36', x: -19662.59, z: -2812.92, overrun_m: 420 }] }] }]);
check('OVERRUN_FIX is a lower bound (data 420 m kept)', rws2.list[0].overrun[1] === 420);

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('all terrain analysis tests passed');
