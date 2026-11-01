// node sim/tests/terrain_coords.test.mjs
// Checks js/world/coords.js against PROJ (pyproj 3.8 / PROJ 9.8,
// '+proj=tmerc +lat_0=31.80 +lon_0=35.025 +k=1 +x_0=0 +y_0=0 +ellps=WGS84').
import { lonLatToXZ, xzToLonLat, lonLatToEN, headingDegFromXZ, xzFromHeadingDeg } from '../js/world/coords.js';

// [lon, lat, easting, northing] from pyproj
const REF = [
  [35.025, 31.8, 0.000000, 0.000000],
  [34.7818, 32.0853, -22959.461399, 31661.603969],
  [35.2137, 31.7683, 17875.564273, -3499.494671],
  [34.8186, 31.8394, -19537.322196, 4387.380477],
  [35.5, 31.5, 45126.339289, -33166.473531],
  [33.0, 30.0, -195405.208676, -197835.022260],
  [37.2, 33.6, 201892.779367, 201739.727789],
  [34.48, 31.34, -51864.595723, -50876.186239],
  [35.57, 32.26, 51353.244100, 51138.542078],
  [34.6, 33.5, -39492.223763, 188607.922495],
];

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

let maxFwd = 0, maxInv = 0;
for (const [lon, lat, e, n] of REF) {
  const p = lonLatToEN(lon, lat);
  maxFwd = Math.max(maxFwd, Math.hypot(p.e - e, p.n - n));
  const w = lonLatToXZ(lon, lat);
  if (Math.abs(w.x - p.e) > 0 || Math.abs(w.z + p.n) > 0) failures++;
  const g = xzToLonLat(e, -n);
  // 1e-9 deg is about 0.1 mm
  maxInv = Math.max(maxInv, Math.abs(g.lon - lon), Math.abs(g.lat - lat));
}
check('forward vs PROJ', maxFwd < 1e-4, `max error ${(maxFwd * 1000).toFixed(4)} mm`);
check('inverse vs PROJ', maxInv < 1e-9, `max error ${maxInv.toExponential(2)} deg`);

// Round trip on a grid over the far area.
let maxRt = 0;
for (let x = -204800; x <= 204800; x += 25600) {
  for (let z = -204800; z <= 204800; z += 25600) {
    const g = xzToLonLat(x, z);
    const w = lonLatToXZ(g.lon, g.lat);
    maxRt = Math.max(maxRt, Math.hypot(w.x - x, w.z - z));
  }
}
check('round trip over the far area', maxRt < 1e-6, `max ${(maxRt * 1e6).toFixed(3)} um`);

// North is -Z, east is +X.
const n0 = lonLatToXZ(35.025, 31.9), e0 = lonLatToXZ(35.125, 31.8);
check('north is -Z', n0.z < -11000 && Math.abs(n0.x) < 1);
check('east is +X', e0.x > 9000 && Math.abs(e0.z) < 50);
check('heading helpers', Math.abs(headingDegFromXZ(1, 0) - 90) < 1e-9 && Math.abs(headingDegFromXZ(0, -1)) < 1e-9 &&
  Math.abs(xzFromHeadingDeg(180).z - 1) < 1e-12);

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('all coords tests passed');
