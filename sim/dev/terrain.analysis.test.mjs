// node sim/dev/terrain.analysis.test.mjs
// Checks the terrain's pure helpers: horizon angles (horizonCore.js) against brute force on a
// synthetic ridge, with the earth's curvature, and the field analysis packing
// (fieldAnalysis.js) on a synthetic pattern of striped fields.
import { computeHorizon, decodeHorizon, EARTH_R } from '../js/terrain/horizonCore.js';
import { analyzeTile, packCodes, CLASS_CODES } from '../js/terrain/fieldAnalysis.js';

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

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('all terrain analysis tests passed');
