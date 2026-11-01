// node --import ./sim/tests/node-three.mjs sim/tests/terrain_surface.test.mjs
// Runway rectangles (with overruns), land cover water weights and surfaceAt() types.
// The browser check of the same against the rendered surface is in terrain_screens.mjs.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Runways, LandCover, surfaceType, FRICTION, LC_WATER } from '../js/terrain/Surface.js';
import { lonLatToXZ } from '../js/world/coords.js';

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
  if (!ok) failed++;
};

// a runway 2400 m long, 45 m wide, heading 030, with a 300 m overrun beyond end 0 only
const h = 30 * Math.PI / 180;
const ux = Math.sin(h), uz = -Math.cos(h);
const a = { id: '03', x: 1000 - ux * 1200, z: 2000 - uz * 1200, y: 50, overrun_m: 300, displaced_threshold_m: 0 };
const b = { id: '21', x: 1000 + ux * 1200, z: 2000 + uz * 1200, y: 52, overrun_m: 0 };
const rw = new Runways([{ icao: 'TEST', name: 'Test', runways: [{ ids: ['03', '21'], width_m: 45, surface: 'asphalt', ends: [a, b] }] }]);
const at = (s, t) => [1000 + ux * s - uz * t, 2000 + uz * s + ux * t];
check('runway centre', rw.find(...at(0, 0)) !== null);
check('near the edge, inside', rw.find(...at(1100, 22)) !== null);
check('beside the runway', rw.find(...at(0, 30)) === null);
check('overrun beyond end 0 is paved', rw.find(...at(-1200 - 250, 0)) !== null);
check('beyond the overrun', rw.find(...at(-1200 - 320, 0)) === null);
check('no overrun beyond end 1', rw.find(...at(1200 + 20, 0)) === null);
{
  const [x, z] = at(-1200 - 290, 0);
  check('inBox finds the runway by its overrun', rw.inBox(x - 5, z - 5, x + 5, z + 5, 0).length === 1);
  check('inBox misses a box away from it', rw.inBox(x + 500, z + 500, x + 600, z + 600, 0).length === 0);
}
check('grass runways are not paved',
  new Runways([{ runways: [{ ids: ['09', '27'], width_m: 30, surface: 'grass', ends: [a, b] }] }]).list[0].paved === false);

// land cover: a tiny 4 x 4 "far" grid over the whole far area, west half water (80)
const lc = new LandCover();
lc.farN = 4;
lc.far = new Uint8Array(16).map((_, i) => ((i % 4) < 2 ? LC_WATER : 40));
check('water weight on the water side', lc.waterWeight(-150000, 0, 0) === 1);
check('water weight on the land side', lc.waterWeight(150000, 0, 120) === 0);
check('water weight half way at the class border', Math.abs(lc.waterWeight(0, 0, 0) - 0.5) < 1e-9);
lc.far.fill(0);
check('no-data at sea level counts as sea', lc.waterWeight(150000, 0, 0.1) === 1);
check('no-data below sea level (Dead Sea basin land) does not', lc.waterWeight(150000, 0, -400) === 0);

const sRunway = surfaceType(rw, lc, ...at(0, 0), 50);
check('surfaceType runway', sRunway.type === 'runway' && sRunway.friction === FRICTION.runway, JSON.stringify(sRunway));
lc.far.fill(LC_WATER);
const sWater = surfaceType(rw, lc, 150000, 0, 0);
check('surfaceType water', sWater.type === 'water' && sWater.friction === FRICTION.water, JSON.stringify(sWater));
lc.far.fill(40);
const sGround = surfaceType(rw, lc, 150000, 0, 80);
check('surfaceType ground', sGround.type === 'ground' && sGround.friction === FRICTION.ground, JSON.stringify(sGround));

// the real airports.json, when the data is there: ends consistent with their lon/lat and heading
const real = fileURLToPath(new URL('../data/terrain/airports.json', import.meta.url));
if (existsSync(real)) {
  const airports = JSON.parse(readFileSync(real, 'utf8'));
  const list = new Runways(airports).list;
  let worstPos = 0, worstHdg = 0;
  for (const ap of airports) {
    for (const r of ap.runways) {
      for (const e of r.ends) {
        if (e.lon == null) continue;
        const p = lonLatToXZ(e.lon, e.lat);
        worstPos = Math.max(worstPos, Math.hypot(p.x - e.x, p.z - e.z));
      }
      const [e0, e1] = r.ends;
      const hdg = (Math.atan2(e1.x - e0.x, -(e1.z - e0.z)) * 180 / Math.PI + 360) % 360;
      const d = Math.abs(((hdg - e0.heading_deg) % 360 + 540) % 360 - 180);
      worstHdg = Math.max(worstHdg, d);
    }
  }
  check(`airports.json: ${list.length} runways parsed`, list.length > 0);
  check('runway ends: x/z agree with lon/lat (< 0.5 m)', worstPos < 0.5, `worst ${worstPos.toFixed(3)} m`);
  check('runway ends: heading agrees with the ends (< 0.2 deg)', worstHdg < 0.2, `worst ${worstHdg.toFixed(3)} deg`);
  const all = new Runways(airports);
  check('every runway centre is found as runway', list.every((r) => all.find(r.cx, r.cz) !== null));
} else {
  console.log('SKIP  airports.json checks (no data/terrain)');
}

console.log(failed ? `${failed} surface test(s) FAILED` : 'all surface tests passed');
process.exit(failed ? 1 : 0);
