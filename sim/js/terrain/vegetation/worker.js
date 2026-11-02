// Vegetation placement worker (module worker): loads a tile's land cover, colour and heights
// from data/terrain/ (the same files the terrain streams, so mostly from the HTTP cache), the
// roads, airfield surfaces and buildings of the tile and its neighbours from data/world/ when
// they exist (obstacles.js: no tree on a mapped road or in a house), analyses the tile once
// (placement.js) and answers requests for the trees of 200 m cells.
//
//   -> {type: 'init', baseUrl (absolute), worldUrl (absolute, or ''), runways: [{cx, cz, ux, uz, halfLength, halfWidth}]}
//   -> {type: 'cells', ix, iz, cells: [[cx, cz], ...], shrubs}
//   <- {type: 'cells', ix, iz, cells: [{cx, cz, count, pos: Float32Array, data: Uint8Array}], waitMs, cellMs,
//       obstacles (trees the tile's obstacles removed so far, by kind), timing (the tile's costs)}
//   <- {type: 'error', ix, iz, cells, message}
//   <- {type: 'world', roads, buildings, airfields}   (once: which world layers were found)

import { fetchBitmap, fetchCodes, fetchU16 } from '../loaders.js';
import { analyseTile, generateCell, COL_N, TILES } from './placement.js';
import { parseRoads, parseAirfield, parseBuildings, buildObstacles } from './obstacles.js';

const MAX_TILES = 6;
const MAX_SOURCES = 16;     // parsed world tiles kept (a tile and its 8 neighbours, and some)
let baseUrl = '';
let worldUrl = '';
let runways = [];
let world = null;           // promise of {roads: Set, buildings: Map key -> file, airfields: tiles}
const tiles = new Map();    // key -> {promise, used}
const sources = new Map();  // key -> {promise, used}
let tick = 0;

/** Which world layers exist (their index files); missing ones leave the grey test alone. */
function loadWorld() {
  if (world) return world;
  const json = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  world = !worldUrl ? Promise.resolve({ roads: null, buildings: null, airfields: null }) : Promise.all([
    json(`${worldUrl}roads/index.json`), json(`${worldUrl}buildings/index.json`), json(`${worldUrl}airfields/airfields.json`),
  ]).then(([r, b, a]) => {
    const w = {
      roads: r && r.files ? new Set(Object.keys(r.files)) : null,
      buildings: b && Array.isArray(b.tiles) ? new Map(b.tiles.map((t) => [`${t.ix},${t.iz}`, t.file])) : null,
      airfields: a && a.tiles ? a.tiles : null,
    };
    self.postMessage({ type: 'world', roads: !!w.roads, buildings: !!w.buildings, airfields: !!w.airfields });
    return w;
  });
  return world;
}

async function fetchBuffer(url, gz) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  let buf = await r.arrayBuffer();
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (gz && b[0] === 0x1f && b[1] === 0x8b) {          // the building tiles are stored gzip'd
    const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(s).arrayBuffer();
  }
  return buf;
}

/** The parsed world layers of one tile: {roads, airfield, buildings} (each may be null). */
async function loadSource(ix, iz) {
  const w = await loadWorld();
  const key = `${ix},${iz}`;
  const warn = (what) => (e) => { console.warn(`vegetation: ${what} of tile ${key}: ${e.message || e}`); return null; };
  const [roads, buildings] = await Promise.all([
    w.roads && w.roads.has(key) ? fetchBuffer(`${worldUrl}roads/tile_${ix}_${iz}.bin`).then((b) => parseRoads(b, ix, iz)).catch(warn('roads')) : null,
    w.buildings && w.buildings.has(key) ? fetchBuffer(`${worldUrl}buildings/${w.buildings.get(key)}`, true).then((b) => {
      const p = parseBuildings(b);
      if (!p) console.warn(`vegetation: buildings of tile ${key}: unknown layout, using the imagery only`);
      return p;
    }).catch(warn('buildings')) : null,
  ]);
  const airfield = w.airfields && w.airfields[key] ? parseAirfield(w.airfields[key], ix, iz) : null;
  return { roads, airfield, buildings };
}

function getSource(ix, iz) {
  return cached(sources, `${ix},${iz}`, MAX_SOURCES, () => loadSource(ix, iz));
}

async function loadTile(ix, iz) {
  const t0 = performance.now();
  const B = baseUrl;
  const near = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = ix + dx, z = iz + dz;
      if (x >= 0 && z >= 0 && x < TILES && z < TILES) near.push(getSource(x, z));
    }
  }
  const [bmp, lc, heights, ...src] = await Promise.all([
    fetchBitmap(`${B}color/L0/tile_${ix}_${iz}.jpg`),
    fetchCodes(`${B}landcover/tile_${ix}_${iz}.png`),
    fetchU16(`${B}height/tile_${ix}_${iz}.bin`),
    ...near,
  ]);
  const t1 = performance.now();
  const canvas = new OffscreenCanvas(COL_N, COL_N);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, COL_N, COL_N);
  bmp.close();
  const rgba = g.getImageData(0, 0, COL_N, COL_N).data;
  const t2 = performance.now();
  const obstacles = buildObstacles(ix, iz, src);
  const t3 = performance.now();
  const t = analyseTile({ ix, iz, lc: lc.codes, rgb: rgba, stride: 4, heights, runways, obstacles });
  // the tile's costs (ms): fetching and parsing its inputs, the obstacle index, the analysis
  t.timing = { loadMs: Math.round(t1 - t0), obstacleMs: Math.round(t3 - t2), analyseMs: Math.round(performance.now() - t3) };
  return t;
}

/** LRU cache of promises: the least recently used entry goes when there are more than max. */
function cached(map, key, max, make) {
  let e = map.get(key);
  if (!e) {
    e = { promise: make(), used: 0 };
    map.set(key, e);
    e.promise.catch(() => map.delete(key));
    if (map.size > max) {
      let old = null;
      for (const [k, v] of map) if (k !== key && (!old || v.used < old[1].used)) old = [k, v];
      if (old) map.delete(old[0]);
    }
  }
  e.used = ++tick;
  return e.promise;
}

function getTile(ix, iz) {
  return cached(tiles, `${ix},${iz}`, MAX_TILES, () => loadTile(ix, iz));
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    baseUrl = m.baseUrl;
    worldUrl = m.worldUrl || '';
    runways = m.runways || [];
    loadWorld();
    return;
  }
  if (m.type !== 'cells') return;
  try {
    const t0 = performance.now();
    const t = await getTile(m.ix, m.iz);
    const t1 = performance.now();
    const cells = [], transfer = [];
    for (const [cx, cz] of m.cells) {
      const r = generateCell(t, cx, cz, { shrubs: m.shrubs !== false });
      cells.push({ cx, cz, count: r.count, pos: r.pos, data: r.data });
      transfer.push(r.pos.buffer, r.data.buffer);
    }
    // waitMs: the tile's loading + analysis this request waited for; cellMs: the placement itself
    self.postMessage({ type: 'cells', ix: m.ix, iz: m.iz, cells, waitMs: t1 - t0, cellMs: performance.now() - t1,
      obstacles: t.obs ? { ...t.obs.stats } : null, timing: t.timing }, transfer);
  } catch (e) {
    self.postMessage({ type: 'error', ix: m.ix, iz: m.iz, cells: m.cells, message: String(e && e.message || e) });
  }
};
