// Statistics of the cumulus field (js/env/cloudField.js) for each weather preset: the calibrated
// threshold, the covered fraction of the land and of the sea, and the clouds' size distribution
// (connected footprints on a grid, by equivalent diameter). Pure node, no browser:
//
//   node sim/tests/clouds_field_stats.mjs [--step 100] [--km 60] [--hour 14]
//
// Use it when changing the field's levels: the presets' coverage should hold, and the counts
// should fall with the size (many small puffs, fewer big clouds).

import { FIELD, sdfAt, thresholdFor, hash2 as hash } from '../js/env/cloudField.js';
import { CLOUD_PRESETS, fieldParams } from '../js/env/cloudsWeather.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const step = arg('--step', 100), km = arg('--km', 60), hour = arg('--hour', 14);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

for (const [name, P] of Object.entries(CLOUD_PRESETS)) {
  if (!P.cu) continue;
  const F = { ...FIELD, ...fieldParams(P.cu, hour, 290, 0), drift: [0, 0] };
  const t0 = performance.now();
  // calibrated at the afternoon peak (as Clouds.js does), measured at the hour asked
  const th = thresholdFor(P.cu.coverage, { ...F, ...fieldParams(P.cu, 14, 290, 0) });
  const ms = performance.now() - t0;
  // coverage: random points over +-200 km, by the field's own land / sea / dry classification
  let nl = 0, cl = 0, nsea = 0, csea = 0;
  for (let k = 0; k < 60000; k++) {
    const x = (hash(k, 1) - 0.5) * 400000, z = (hash(k, 2) - 0.5) * 400000;
    const landF = smooth(-7000, 7000, x * 0.951 + z * 0.310 + 34616), dry = smooth(15000, 40000, x);
    const c = sdfAt(x, z, F) / F.scale > th + 0.01 ? 1 : 0;
    if (landF > 0.98 && dry < 0.01) { nl++; cl += c; } else if (landF < 0.02) { nsea++; csea += c; }
  }
  const land = cl / nl, sea = csea / nsea;
  // sizes: a block inland (36 x km km, between the coast and the dry east)
  const NX = Math.round(36000 / step), N = Math.round(km * 1000 / step);
  const grid = new Uint8Array(NX * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < NX; i++) {
      const x = -24000 + i * step, z = -20000 + j * step;
      if (sdfAt(x, z, F) / F.scale > th + 0.01) grid[j * NX + i] = 1;
    }
  }
  // connected components (4-neighbours) -> equivalent diameters
  const lab = new Int32Array(NX * N).fill(-1), sizes = [];
  for (let s = 0; s < NX * N; s++) {
    if (!grid[s] || lab[s] >= 0) continue;
    let cnt = 0;
    const st = [s];
    lab[s] = sizes.length;
    while (st.length) {
      const k = st.pop(); cnt++;
      const x = k % NX, y = (k / NX) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= NX || yy >= N) continue;
        const q = yy * NX + xx;
        if (grid[q] && lab[q] < 0) { lab[q] = sizes.length; st.push(q); }
      }
    }
    sizes.push(2 * Math.sqrt(cnt * step * step / Math.PI));
  }
  const bins = [0, 250, 500, 1000, 2000, 4000, 1e9];
  const hist = bins.slice(0, -1).map((b, i) => sizes.filter((d) => d >= b && d < bins[i + 1]).length);
  console.log(`${name.padEnd(9)} threshold ${th.toFixed(4)} (${(th * F.scale).toFixed(0)} m, ${ms.toFixed(0)} ms)  land ${land.toFixed(3)}  sea ${sea.toFixed(3)}  clouds per 1000 km2 by diameter <250 <500 <1k <2k <4k >4k m: ${hist.map((h) => (h * 1e9 / (NX * N * step * step)).toFixed(0)).join(' ')}`);
}
