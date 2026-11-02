// Vegetation placement against the mapped roads and buildings, in node (no browser):
//
//   node sim/tests/vegetation_placement.test.mjs [--tiles 6,5 5,4 ...] [--data sim/data] [--before]
//
// Runs the placement rules (js/terrain/vegetation/placement.js with obstacles.js) on whole tiles
// from the real data (terrain tiles, data/world/roads, airfields.json, data/world/buildings),
// then checks every tree with an independent 1 m raster of the same layers (its own readers of
// the tile formats, its own rasteriser): no trunk on a carriageway, a railway, a taxiway or an
// apron, none inside a building footprint. Also counts what the obstacles removed, and checks
// that a cell's trees do not depend on the order of the requests. --before places the trees
// without the obstacles (the counts the checks would find without them). The JPEG and PNG
// decoders are the ones Playwright bundles (jpeg-js, pngjs).

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argList = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const out = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out.push(argv[k]);
  return out;
};
const DATA = resolve((argList('data') || [join(here, '..', 'data')])[0]);
// motorway, Tel Nof, Lod / Ben Shemen, the Jerusalem hills, Jerusalem, Tel Aviv
const TILES = (argList('tiles') || ['6,5', '5,4', '4,7', '9,7', '10,8', '4,2']).map((s) => s.split(',').map(Number));
const BEFORE = argv.includes('--before');

const require = createRequire(import.meta.url);
const pw = require.resolve('playwright');
const { jpegjs, PNG } = createRequire(pw)('playwright-core/lib/utilsBundle');

const veg = (f) => import(pathToFileURL(join(here, '..', 'js', 'terrain', 'vegetation', f)).href);
const P = await veg('placement.js');
const O = await veg('obstacles.js');
const { SPECIES } = await veg('species.js');

const T = 6400, HALF = 51200;
const NARROW = 0.75;     // m off each side of a carriageway in the check raster (see rasterise)
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

// ------------------------------------------------------------------------------------ inputs
const W = join(DATA, 'world');
const roadIndex = existsSync(join(W, 'roads', 'index.json')) ? JSON.parse(readFileSync(join(W, 'roads', 'index.json'), 'utf8')) : null;
const bldIndex = existsSync(join(W, 'buildings', 'index.json')) ? JSON.parse(readFileSync(join(W, 'buildings', 'index.json'), 'utf8')) : null;
const airfields = existsSync(join(W, 'airfields', 'airfields.json')) ? JSON.parse(readFileSync(join(W, 'airfields', 'airfields.json'), 'utf8')) : null;
if (!roadIndex || !bldIndex) {
  console.log(`no data/world/roads or data/world/buildings in ${DATA}: nothing to check against (skipped)`);
  process.exit(0);
}
const bldFile = new Map(bldIndex.tiles.map((t) => [`${t.ix},${t.iz}`, t.file]));
const airports = JSON.parse(readFileSync(join(DATA, 'terrain', 'airports.json'), 'utf8'));
const runways = [];
for (const ap of airports) {
  for (const rw of ap.runways || []) {
    const [a, b] = rw.ends || [];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    if (L > 10) runways.push({ cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, ux: dx / L, uz: dz / L, halfLength: L / 2, halfWidth: (rw.width_m || 45) / 2 });
  }
}
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const roadBytes = (ix, iz) => (roadIndex.files[`${ix},${iz}`] ? ab(readFileSync(join(W, 'roads', `tile_${ix}_${iz}.bin`))) : null);
const bldBytes = (ix, iz) => (bldFile.has(`${ix},${iz}`) ? ab(gunzipSync(readFileSync(join(W, 'buildings', bldFile.get(`${ix},${iz}`))))) : null);

function sources(ix, iz) {
  const out = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = ix + dx, z = iz + dz;
      if (x < 0 || z < 0 || x > 15 || z > 15) continue;
      const af = airfields?.tiles?.[`${x},${z}`];
      out.push({ roads: O.parseRoads(roadBytes(x, z), x, z), airfield: af ? O.parseAirfield(af, x, z) : null, buildings: O.parseBuildings(bldBytes(x, z)) });
    }
  }
  return out;
}

function terrainTile(ix, iz) {
  const png = PNG.sync.read(readFileSync(join(DATA, 'terrain', 'landcover', `tile_${ix}_${iz}.png`)));
  const lc = new Uint8Array(png.width * png.height);
  for (let i = 0; i < lc.length; i++) lc[i] = png.data[i * 4];
  const jpg = jpegjs.decode(readFileSync(join(DATA, 'terrain', 'color', 'L0', `tile_${ix}_${iz}.jpg`)), { useTArray: true, formatAsRGBA: true });
  const hb = readFileSync(join(DATA, 'terrain', 'height', `tile_${ix}_${iz}.bin`));
  const heights = new Uint16Array(ab(hb));
  return { lc, rgb: jpg.data, heights };
}

// ------------------------------------------------------------------------- independent raster
// 1 m raster of the tile (row 0 north): 1 carriageway / railway / taxiway, 2 apron, 3 building.
// Its own readers of RDS1 and F35B (not obstacles.js), its own geometry (pixel centres against
// the shapes). Carriageways at their paved width minus 0.75 m: a trunk is looked up by the
// pixel it stands in, whose centre can be 0.71 m away (a tree beside a dirt track stands 0.3 m
// off its edge); bridges whose deck height is known are left out (a tree may stand below).
function rasterise(ix, iz) {
  const x0 = -HALF + T * ix, z0 = -HALF + T * iz;
  const R = new Uint8Array(T * T);
  const seg = (ax, az, bx, bz, hw, v) => {
    const lx0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - x0)), lx1 = Math.min(T - 1, Math.ceil(Math.max(ax, bx) + hw - x0));
    const lz0 = Math.max(0, Math.floor(Math.min(az, bz) - hw - z0)), lz1 = Math.min(T - 1, Math.ceil(Math.max(az, bz) + hw - z0));
    const ux = bx - ax, uz = bz - az, l2 = ux * ux + uz * uz;
    for (let j = lz0; j <= lz1; j++) {
      const pz = z0 + j + 0.5;
      for (let i = lx0; i <= lx1; i++) {
        const px = x0 + i + 0.5;
        let t = l2 > 0 ? ((px - ax) * ux + (pz - az) * uz) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const dx = ax + ux * t - px, dz = az + uz * t - pz;
        if (dx * dx + dz * dz <= hw * hw) R[j * T + i] = v;
      }
    }
  };
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tx = ix + dx, tz = iz + dz;
      const b = roadBytes(tx, tz);
      if (!b) continue;
      const dv = new DataView(b);
      const n = dv.getUint32(4, true), npt = dv.getUint32(8, true), nbr = dv.getUint32(12, true);
      const end = 16 + 24 * n + 4 * npt + 8 * nbr;
      const decks = new Set();
      if (end + 8 <= b.byteLength && String.fromCharCode(...new Uint8Array(b, end, 4)) === 'DCK1') {
        let o = end + 8;
        for (let d = 0, nd = dv.getUint32(end + 4, true); d < nd; d++) {
          const rec = dv.getUint32(o, true);
          decks.add(rec);
          o += 8 + 4 * dv.getUint16(16 + 24 * rec + 8, true);
        }
      }
      const ox = -HALF + T * tx, oz = -HALF + T * tz;
      for (let k = 0; k < n; k++) {
        const r = 16 + 24 * k;
        if (dv.getInt8(r + 3) > 0 && decks.has(k)) continue;
        const hw = dv.getUint16(r + 4, true) / 200 - NARROW;
        const m = dv.getUint16(r + 8, true), first = dv.getUint32(r + 12, true);
        for (let i = 0; i + 1 < m; i++) {
          const p = 16 + 24 * n + 4 * (first + i);
          seg(ox + dv.getUint16(p, true) / 10, oz + dv.getUint16(p + 2, true) / 10, ox + dv.getUint16(p + 4, true) / 10, oz + dv.getUint16(p + 6, true) / 10, hw, 1);
        }
      }
    }
  }
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const e = airfields?.tiles?.[`${ix + dx},${iz + dz}`];
      if (!e) continue;
      const ox = -HALF + T * (ix + dx), oz = -HALF + T * (iz + dz);
      for (const t of e.taxiways || []) {
        for (let i = 0; i + 3 < t.pts.length; i += 2) seg(ox + t.pts[i], oz + t.pts[i + 1], ox + t.pts[i + 2], oz + t.pts[i + 3], t.cw / 2 - NARROW, 1);
      }
      for (const a of e.aprons || []) {
        for (let i = 0; i + 5 < a.tris.length; i += 6) {
          const P3 = [0, 2, 4].map((k) => [ox + a.tris[i + k], oz + a.tris[i + k + 1]]);
          fillPolygon(R, x0, z0, [P3], 2);
        }
      }
    }
  }
  // buildings (each tile's own reader of F35B; even-odd over a building's rings)
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const b = bldBytes(ix + dx, iz + dz);
      if (!b) continue;
      const dv = new DataView(b);
      const nch = dv.getUint8(10), ox = dv.getFloat32(12, true), oz = dv.getFloat32(16, true), q = dv.getFloat32(20, true);
      const N = dv.getUint32(24, true), Rn = dv.getUint32(28, true), V = dv.getUint32(32, true);
      let o = dv.getUint16(6, true);
      const take = (C, n) => { const a = new C(b.slice(o, o + n * C.BYTES_PER_ELEMENT)); o += n * C.BYTES_PER_ELEMENT; o += (4 - (o % 4)) % 4; return a; };
      take(Uint32Array, nch * nch + 1);
      for (let i = 0; i < 8; i++) take(Uint16Array, N);
      const ringN = take(Uint16Array, Rn), vx = take(Uint16Array, V), vz = take(Uint16Array, V);
      for (let i = 0; i < 10; i++) take(Uint8Array, N);
      const nrings = take(Uint8Array, N);
      let r = 0, v = 0;
      for (let i = 0; i < N; i++) {
        const rings = [];
        for (let k = 0; k < nrings[i]; k++, r++) {
          const ring = [];
          for (let j = 0; j < ringN[r]; j++, v++) ring.push([ox + vx[v] * q, oz + vz[v] * q]);
          rings.push(ring);
        }
        fillPolygon(R, x0, z0, rings, 3);
      }
    }
  }
  return R;
}

/** Even-odd fill of polygon rings (world x, z) into the raster: pixel centres inside. */
function fillPolygon(R, x0, z0, rings, v) {
  let mz = Infinity, Mz = -Infinity;
  for (const ring of rings) for (const [, z] of ring) { mz = Math.min(mz, z); Mz = Math.max(Mz, z); }
  const j0 = Math.max(0, Math.floor(mz - z0)), j1 = Math.min(T - 1, Math.ceil(Mz - z0));
  for (let j = j0; j <= j1; j++) {
    const pz = z0 + j + 0.5;
    const xs = [];
    for (const ring of rings) {
      for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
        const [xa, za] = ring[k], [xb, zb] = ring[l];
        if ((za > pz) !== (zb > pz)) xs.push(xa + (pz - za) * (xb - xa) / (zb - za));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - x0 - 0.5)), i1 = Math.min(T - 1, Math.floor(xs[k + 1] - x0 - 0.5));
      for (let i = i0; i <= i1; i++) R[j * T + i] = v;
    }
  }
}

// ------------------------------------------------------------------------------------- run
const SPN = SPECIES.map((s) => s.name);
let total = 0, removedAll = 0;
for (const [ix, iz] of TILES) {
  const t0 = Date.now();
  const tt = terrainTile(ix, iz);
  const obstacles = BEFORE ? null : O.buildObstacles(ix, iz, sources(ix, iz));
  const tile = P.analyseTile({ ix, iz, ...tt, stride: 4, runways, obstacles });
  const t1 = Date.now();
  const raster = rasterise(ix, iz);
  const t2 = Date.now();
  const x0 = -HALF + T * ix, z0 = -HALF + T * iz;
  let n = 0, onRoad = 0, onApron = 0, inBld = 0, shrubs = 0;
  const examples = [];
  const cells = [];
  for (let cz = 0; cz < P.CELLS; cz++) {
    for (let cx = 0; cx < P.CELLS; cx++) {
      const r = P.generateCell(tile, cx, cz, { shrubs: true });
      cells.push(r);
      for (let i = 0; i < r.count; i++) {
        const x = r.pos[i * 3], z = r.pos[i * 3 + 2];
        const sp = r.data[i * 8] & 15;
        const v = raster[Math.min(T - 1, Math.floor(z - z0)) * T + Math.min(T - 1, Math.floor(x - x0))];
        n++;
        if (sp === 7) shrubs++;
        if (v === 1) onRoad++;
        else if (v === 2) onApron++;
        else if (v === 3) inBld++;
        if (v && examples.length < 4) examples.push(`${SPN[sp]} at ${x.toFixed(1)}, ${z.toFixed(1)} on ${['', 'road', 'apron', 'building'][v]}`);
      }
    }
  }
  const t3 = Date.now();
  // the same tile without the obstacles: what they removed
  tile.obs = null;
  let n0 = 0;
  for (let cz = 0; cz < P.CELLS; cz++) for (let cx = 0; cx < P.CELLS; cx++) n0 += P.generateCell(tile, cx, cz, { shrubs: true }).count;
  // determinism: a few cells again, in another order, with the obstacles
  tile.obs = obstacles;
  let same = true;
  for (const k of [517, 3, 1000, 64]) {
    const r = P.generateCell(tile, k % 32, Math.floor(k / 32), { shrubs: true });
    const a = cells[k];
    if (r.count !== a.count || r.pos.some((v, i) => v !== a.pos[i]) || r.data.some((v, i) => v !== a.data[i])) same = false;
  }
  total += n;
  removedAll += n0 - n;
  console.log(`tile ${ix},${iz}: ${n} plants (${shrubs} shrubs), obstacles removed ${n0 - n} (${((n0 - n) / Math.max(1, n0) * 100).toFixed(2)} %: ` +
    `roads ${obstacles?.stats.roads ?? 0}, aprons ${obstacles?.stats.aprons ?? 0}, buildings ${obstacles?.stats.buildings ?? 0}, under a deck ${obstacles?.stats.underDeck ?? 0}); ` +
    `analyse ${t1 - t0} ms, raster ${t2 - t1} ms, cells ${t3 - t2} ms`);
  check(`tile ${ix},${iz}: no trunk on a carriageway, railway or taxiway`, onRoad === 0, `${onRoad}${examples.length ? ` (${examples.join('; ')})` : ''}`);
  check(`tile ${ix},${iz}: no trunk on an apron`, onApron === 0, `${onApron}`);
  check(`tile ${ix},${iz}: no trunk inside a building footprint`, inBld === 0, `${inBld}`);
  check(`tile ${ix},${iz}: cells do not depend on the order of requests`, same);
}
console.log(`${total} plants in ${TILES.length} tiles, ${removedAll} removed by the obstacles`);
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
