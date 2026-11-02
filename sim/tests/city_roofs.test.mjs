// node sim/tests/city_roofs.test.mjs [--tile 4_3] [--chunks 12,18]
// Checks the roof items BuildingsWorker.js places (buildRoofItems) on real tiles of
// data/world/buildings/ (central Tel Aviv by default: the Azrieli and White City chunks): counts and
// timing per chunk, every item inside its building's footprint and on its roof's level, collectors
// facing south, nothing on pitched roofs, the same items on a second build (deterministic). Also the
// lit-window masks of js/world/windowLights.js: each channel's mean is its lit fraction, the sets are
// nested, offices' rows (floors) are more uniform than homes'.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };

// the worker's functions, in a context of their own (it is not a module: self.onmessage)
const ctx = vm.createContext({ self: { postMessage() {} }, console, Math, Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, DataView, Map, Error, Infinity });
vm.runInContext(readFileSync(join(here, '../js/world/BuildingsWorker.js'), 'utf8'), ctx);
const dataDir = join(here, '../data/world/buildings');
const tileKey = arg('tile', '4_3');
let raw = readFileSync(join(dataDir, `tile_${tileKey}.bin`));
if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const t = ctx.parse(buf);
console.log(`tile ${tileKey}: ${t.N} buildings`);

const chunks = arg('chunks', '12,18').split(',').map(Number);
for (const c of chunks) {
  const t0 = performance.now();
  const it = ctx.buildRoofItems(t, c, { parapets: true, roofBoxes: true });
  const ms = performance.now() - t0;
  const kinds = [0, 0, 0, 0, 0];
  for (let k = 0; k < it.count; k++) kinds[it.c[4 * k + 3]]++;
  const nb = t.starts[c + 1] - t.starts[c];
  console.log(`chunk ${c}: ${nb} buildings, ${it.count} items (collectors ${kinds[0]}, tanks ${kinds[1]}, water ${kinds[2]}, ac ${kinds[3]}, chillers ${kinds[4]}), ${(it.a.byteLength + it.b.byteLength + it.c.byteLength) / 1024 | 0} KB, ${ms.toFixed(0)} ms`);
  check(`chunk ${c}: built in under 150 ms`, ms < 150, `${ms.toFixed(0)} ms`);
  check(`chunk ${c}: has solar water heaters`, kinds[0] > 50 && kinds[0] === kinds[1], `${kinds[0]} collectors, ${kinds[1]} tanks`);
  // every item's centre inside one of the chunk's flat buildings' footprints, near its roof
  const [ccx, ccz] = it.center;
  let outside = 0, south = 0, noRoof = 0;
  for (let k = 0; k < it.count; k++) {
    const x = it.a[4 * k] + ccx, y = it.a[4 * k + 1], z = it.a[4 * k + 2] + ccz;
    let found = false;
    for (let i = t.starts[c]; i < t.starts[c + 1] && !found; i++) {
      if (t.shape[i] !== 0 || !ctx.insideFootprint(t, i, x, z)) continue;
      const apex = t.base[i] * 0.1 + t.top[i] * 0.1;
      if (y > apex - 3 && y < apex + 2) found = true;
    }
    if (!found) noRoof++;
    if (it.c[4 * k + 3] === 0) {
      // the collector faces its -z: (sin yaw, -cos yaw); towards the south (+z) more than not
      const yaw = it.a[4 * k + 3];
      if (-Math.cos(yaw) > 0.3) south++;
    }
    if (!Number.isFinite(x + y + z)) outside++;
  }
  check(`chunk ${c}: every item on a flat roof of the chunk`, noRoof === 0 && outside === 0, `${noRoof} not on a roof, ${outside} not finite`);
  check(`chunk ${c}: collectors face south`, kinds[0] === 0 || south / kinds[0] > 0.95, `${south} of ${kinds[0]}`);
  const again = ctx.buildRoofItems(t, c, { parapets: true, roofBoxes: true });
  check(`chunk ${c}: deterministic`, again.count === it.count && again.a.every((v, i) => v === it.a[i]));
}

// lit-window masks
const { litMaskData, LIT_SIZE, LIT_THRESHOLDS } = await import('../js/world/windowLights.js');
for (const kind of ['homes', 'offices']) {
  const d = litMaskData(kind), N = LIT_SIZE, T = LIT_THRESHOLDS[kind];
  const mean = [0, 0, 0, 0];
  let nested = true;
  for (let k = 0; k < N * N; k++) {
    for (let c = 0; c < 4; c++) mean[c] += d[k * 4 + c] / 255 / (N * N);
    for (let c = 0; c < 3; c++) if (d[k * 4 + c] > d[k * 4 + c + 1]) nested = false;
  }
  check(`${kind}: channel means are the lit fractions`, mean.every((m, c) => Math.abs(m - T[c]) < 0.002), mean.map((m) => m.toFixed(3)).join(' '));
  check(`${kind}: lit sets nested`, nested);
  // how alike a floor's windows are (channel G): the share of neighbours along a row that agree
  let same = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N - 1; i++) same += d[(j * N + i) * 4 + 1] === d[(j * N + i + 1) * 4 + 1] ? 1 : 0;
  console.log(`  ${kind}: neighbours alike along a floor ${(same / (N * (N - 1))).toFixed(3)}`);
  if (kind === 'offices') check('offices: lit by floors and sections (neighbours alike > 0.85)', same / (N * (N - 1)) > 0.85);
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
