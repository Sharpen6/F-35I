// Vegetation placement worker (module worker): loads a tile's land cover, colour and heights
// from data/terrain/ (the same files the terrain streams, so mostly from the HTTP cache),
// analyses it once (placement.js) and answers requests for the trees of 200 m cells.
//
//   -> {type: 'init', baseUrl (absolute), runways: [{cx, cz, ux, uz, halfLength, halfWidth}]}
//   -> {type: 'cells', ix, iz, cells: [[cx, cz], ...], shrubs}
//   <- {type: 'cells', ix, iz, cells: [{cx, cz, count, pos: Float32Array, data: Uint8Array}]}
//   <- {type: 'error', ix, iz, cells, message}

import { fetchBitmap, fetchCodes, fetchU16 } from '../loaders.js';
import { analyseTile, generateCell, COL_N } from './placement.js';

const MAX_TILES = 6;
let baseUrl = '';
let runways = [];
const tiles = new Map();   // key -> {promise, used}
let tick = 0;

async function loadTile(ix, iz) {
  const B = baseUrl;
  const [bmp, lc, heights] = await Promise.all([
    fetchBitmap(`${B}color/L0/tile_${ix}_${iz}.jpg`),
    fetchCodes(`${B}landcover/tile_${ix}_${iz}.png`),
    fetchU16(`${B}height/tile_${ix}_${iz}.bin`),
  ]);
  const canvas = new OffscreenCanvas(COL_N, COL_N);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, COL_N, COL_N);
  bmp.close();
  const rgba = g.getImageData(0, 0, COL_N, COL_N).data;
  return analyseTile({ ix, iz, lc: lc.codes, rgb: rgba, stride: 4, heights, runways });
}

function getTile(ix, iz) {
  const key = `${ix},${iz}`;
  let e = tiles.get(key);
  if (!e) {
    e = { promise: loadTile(ix, iz), used: 0 };
    tiles.set(key, e);
    e.promise.catch(() => tiles.delete(key));
    if (tiles.size > MAX_TILES) {
      let old = null;
      for (const [k, v] of tiles) if (k !== key && (!old || v.used < old[1].used)) old = [k, v];
      if (old) tiles.delete(old[0]);
    }
  }
  e.used = ++tick;
  return e.promise;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    baseUrl = m.baseUrl;
    runways = m.runways || [];
    return;
  }
  if (m.type !== 'cells') return;
  try {
    const t = await getTile(m.ix, m.iz);
    const cells = [], transfer = [];
    for (const [cx, cz] of m.cells) {
      const r = generateCell(t, cx, cz, { shrubs: m.shrubs !== false });
      cells.push({ cx, cz, count: r.count, pos: r.pos, data: r.data });
      transfer.push(r.pos.buffer, r.data.buffer);
    }
    self.postMessage({ type: 'cells', ix: m.ix, iz: m.iz, cells }, transfer);
  } catch (e) {
    self.postMessage({ type: 'error', ix: m.ix, iz: m.iz, cells: m.cells, message: String(e && e.message || e) });
  }
};
