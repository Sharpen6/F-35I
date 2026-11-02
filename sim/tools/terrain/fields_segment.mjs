// The segmentation stage of fields.py (node): field regions over the whole core, so that a field
// cut by a tile edge keeps its rows on both sides of it.
//
//   node sim/tools/terrain/fields_segment.mjs --cache DIR --out DIR
//
// In (from fields.py prepare, in --cache): rgb12.npy (the L0 imagery at 12.5 m, 8192^2 x 3),
// poly12.npy (mapped polygon ids at 12.5 m, uint16), lc10.npy (WorldCover codes at 10 m,
// 10240^2), mask10.npy (mapped classes at 10 m: 1 orchard, 2 vineyard, 3 greenhouses).
// Out (--out): tile_{ix}_{iz}.u16.gz per core tile (640 x 640 texels, js/terrain/fieldAnalysis.js
// has the layout) and index.json.
//
// 1. Every tile is segmented in a window that reaches 64 px (800 m) into its neighbours
//    (fieldAnalysis.js segmentImage, with the mapped outlines as extra edge weight; then a 3 x 3
//    majority filter), so the fields along its edges are seen whole.
// 2. Stitching: where two windows overlap (96 px bands along every tile edge and around every
//    corner), a region of one and a region of the other that cover mostly the same pixels
//    (intersection over union >= 0.5) are the same field: union-find over all windows' regions.
// 3. Every field (union of regions) gets its row direction from its sums over the whole core
//    (accumulateRegions over the tiles' own pixels; the fallback grid axis from world-anchored
//    800 m blocks) and its random number from the hash of its centre in metres, so the same field
//    gets the same rows whichever tile draws it, and rebuilding with other tiles changes nothing.
// 4. Per 10 m texel: the field of the 12.5 m pixel under its centre, the WorldCover class, and the
//    mapped classes where the map has orchards (on tree, shrub, grass or crop land), vineyards or
//    greenhouses.

import { openSync, readSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import {
  segmentImage, majorityFilter, accumulateRegions, regionDirection, packTexel, hash32, BLOCK,
  CODE_TO_INDEX, CLASS_ORCHARD, CLASS_VINEYARD, CLASS_GREENHOUSE,
} from '../../js/terrain/fieldAnalysis.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const CACHE = arg('cache');
const OUT = arg('out');
if (!CACHE || !OUT) { console.error('usage: node fields_segment.mjs --cache DIR --out DIR'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const NT = 16, S = 512, MARGIN = 64, BAND = 48, LC = 640;
const N12 = NT * S, N10 = NT * LC;
const NBX = N12 / BLOCK;
const t0 = Date.now();
const log = (...a) => console.log(`  [fields_segment ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

/** A .npy file opened for row reads: {fd, offset, shape, itemBytes}. */
function npy(name) {
  const fd = openSync(join(CACHE, name), 'r');
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const major = head[6];
  const hl = major === 1 ? head.readUInt16LE(8) : head.readUInt32LE(8);
  const off = (major === 1 ? 10 : 12) + hl;
  const hdr = Buffer.alloc(hl);
  readSync(fd, hdr, 0, hl, major === 1 ? 10 : 12);
  const txt = hdr.toString('latin1');
  const shape = /'shape':\s*\(([^)]*)\)/.exec(txt)[1].split(',').filter((s) => s.trim()).map(Number);
  const descr = /'descr':\s*'([^']*)'/.exec(txt)[1];
  const itemBytes = Number(descr.slice(2));
  if (/True/.test(/'fortran_order':\s*(\w+)/.exec(txt)[1])) throw new Error(`${name}: fortran order`);
  return { fd, off, shape, itemBytes, descr };
}

/** Rows y0..y0+h-1, columns x0..x0+w-1 of a (rows, cols[, ch]) array -> Buffer. */
function readRect(a, x0, y0, w, h) {
  const ch = a.shape[2] || 1;
  const px = ch * a.itemBytes;
  const rowBytes = a.shape[1] * px;
  const out = Buffer.alloc(w * h * px);
  for (let y = 0; y < h; y++) readSync(a.fd, out, y * w * px, w * px, a.off + (y0 + y) * rowBytes + x0 * px);
  return out;
}

const rgbA = npy('rgb12.npy'), polyA = npy('poly12.npy'), lcA = npy('lc10.npy'), maskA = npy('mask10.npy');
if (rgbA.shape[0] !== N12 || lcA.shape[0] !== N10) throw new Error('unexpected mosaic sizes');

// ---- 1. windows -----------------------------------------------------------------------------
const tiles = [];
const blk = new Float64Array(NBX * NBX * 3);
let gidTotal = 0;
for (let iz = 0; iz < NT; iz++) {
  for (let ix = 0; ix < NT; ix++) {
    const wx0 = Math.max(0, ix * S - MARGIN), wy0 = Math.max(0, iz * S - MARGIN);
    const wx1 = Math.min(N12, (ix + 1) * S + MARGIN), wy1 = Math.min(N12, (iz + 1) * S + MARGIN);
    const w = wx1 - wx0, h = wy1 - wy0;
    const rgb = readRect(rgbA, wx0, wy0, w, h);
    const rgba = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      rgba[p * 4] = rgb[p * 3]; rgba[p * 4 + 1] = rgb[p * 3 + 1]; rgba[p * 4 + 2] = rgb[p * 3 + 2]; rgba[p * 4 + 3] = 255;
    }
    const pb = readRect(polyA, wx0, wy0, w, h);
    const barrier = new Uint16Array(pb.buffer, pb.byteOffset, w * h);
    const seg = segmentImage(rgba, w, h, { barrier });
    const label = majorityFilter(seg.label, w, h);
    const nr = seg.nr;
    if (nr > 65535) throw new Error(`tile ${ix},${iz}: ${nr} regions`);
    // sums over the tile's own pixels (mosaic coordinates)
    const M = new Float64Array(nr * 6), A4 = new Float64Array(nr * 3);
    const rect = [ix * S - wx0, iz * S - wy0, ix * S - wx0 + S, iz * S - wy0 + S];
    accumulateRegions(seg, label, w, h, rect, wx0, wy0, (l) => l, M, A4, blk, NBX);
    tiles.push({ ix, iz, wx0, wy0, w, h, nr, gid0: gidTotal, label: Uint16Array.from(label), M, A4 });
    gidTotal += nr;
    if ((iz * NT + ix) % 16 === 15) log(`segmented ${iz * NT + ix + 1}/${NT * NT} tiles (${gidTotal} regions)`);
  }
}

// ---- 2. stitching -----------------------------------------------------------------------------
const parent = new Int32Array(gidTotal);
for (let i = 0; i < gidTotal; i++) parent[i] = i;
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
const tileAt = (ix, iz) => (ix >= 0 && iz >= 0 && ix < NT && iz < NT ? tiles[iz * NT + ix] : null);
const labelAt = (t, X, Y) => t.label[(Y - t.wy0) * t.w + (X - t.wx0)];
let pairs = 0, joined = 0;
function stitch(A, B, x0, y0, x1, y1) {
  if (!A || !B) return;
  const cnt = new Map(), ta = new Map(), tb = new Map();
  for (let Y = y0; Y < y1; Y++) {
    for (let X = x0; X < x1; X++) {
      const la = labelAt(A, X, Y), lb = labelAt(B, X, Y);
      const k = la * 65536 + lb;
      cnt.set(k, (cnt.get(k) || 0) + 1);
      ta.set(la, (ta.get(la) || 0) + 1);
      tb.set(lb, (tb.get(lb) || 0) + 1);
    }
  }
  for (const [k, c] of cnt) {
    pairs++;
    if (c < 32) continue;
    const la = Math.floor(k / 65536), lb = k % 65536;
    const iou = c / (ta.get(la) + tb.get(lb) - c);
    if (iou >= 0.5) { union(A.gid0 + la, B.gid0 + lb); joined++; }
  }
}
for (const t of tiles) {
  const bx = (t.ix + 1) * S, by = (t.iz + 1) * S, x0 = t.ix * S, y0 = t.iz * S;
  stitch(t, tileAt(t.ix + 1, t.iz), bx - BAND, y0, bx + BAND, y0 + S);           // east edge
  stitch(t, tileAt(t.ix, t.iz + 1), x0, by - BAND, x0 + S, by + BAND);           // south edge
  stitch(t, tileAt(t.ix + 1, t.iz + 1), bx - BAND, by - BAND, bx + BAND, by + BAND);   // SE corner
  stitch(t, tileAt(t.ix - 1, t.iz + 1), x0 - BAND, by - BAND, x0 + BAND, by + BAND);   // SW corner
}
log(`stitched: ${joined} of ${pairs} region pairs joined across tile edges`);

// ---- 3. fields: sums, directions, random numbers -------------------------------------------
const RM = new Float64Array(gidTotal * 6), RA = new Float64Array(gidTotal * 3);
for (const t of tiles) {
  for (let l = 0; l < t.nr; l++) {
    if (!t.M[l * 6]) continue;
    const r = find(t.gid0 + l);
    for (let k = 0; k < 6; k++) RM[r * 6 + k] += t.M[l * 6 + k];
    for (let k = 0; k < 3; k++) RA[r * 3 + k] += t.A4[l * 3 + k];
  }
  t.M = t.A4 = null;
}
const theta = new Float32Array(gidTotal), rnd = new Uint8Array(gidTotal);
let fields = 0;
for (let r = 0; r < gidTotal; r++) {
  const n = RM[r * 6];
  if (!n || find(r) !== r) continue;
  fields++;
  // world position of the field's centre (m), rounded: the seed does not depend on the tiling
  const xm = Math.round(RM[r * 6 + 1] / n * 12.5 - 51200), zm = Math.round(RM[r * 6 + 2] / n * 12.5 - 51200);
  const h = hash32(Math.imul(xm, 73856093) ^ Math.imul(zm, 19349663) ^ 0x5bd1e995);
  rnd[r] = h & 31;
  theta[r] = regionDirection(RM, RA, blk, NBX, r, h);
}
log(`${fields} fields`);

// ---- 4. pack per tile -------------------------------------------------------------------------
const TREEISH = new Set([10, 20, 30, 40]), VINE_OK = new Set([10, 20, 30, 40, 60]), GH_OK = new Set([30, 40, 50, 60]);
const classCount = new Float64Array(16);
let bytes = 0;
for (const t of tiles) {
  const lc = readRect(lcA, t.ix * LC, t.iz * LC, LC, LC);
  const mk = readRect(maskA, t.ix * LC, t.iz * LC, LC, LC);
  const out = new Uint16Array(LC * LC);
  for (let j = 0; j < LC; j++) {
    const Y = t.iz * S + Math.min(S - 1, Math.floor((j + 0.5) * S / LC));
    for (let i = 0; i < LC; i++) {
      const X = t.ix * S + Math.min(S - 1, Math.floor((i + 0.5) * S / LC));
      const r = find(t.gid0 + labelAt(t, X, Y));
      const p = j * LC + i, code = lc[p], m = mk[p];
      let ci = CODE_TO_INDEX[code];
      if (m === 1 && TREEISH.has(code)) ci = CLASS_ORCHARD;
      else if (m === 2 && VINE_OK.has(code)) ci = CLASS_VINEYARD;
      else if (m === 3 && GH_OK.has(code)) ci = CLASS_GREENHOUSE;
      classCount[ci]++;
      out[p] = packTexel(ci, theta[r], rnd[r]);
    }
  }
  const gz = gzipSync(Buffer.from(out.buffer), { level: 9 });
  writeFileSync(join(OUT, `tile_${t.ix}_${t.iz}.u16.gz`), gz);
  bytes += gz.length;
}
const total = classCount.reduce((a, b) => a + b, 0);
writeFileSync(join(OUT, 'index.json'), JSON.stringify({
  format: 'tile_{ix}_{iz}.u16.gz: 640 x 640 little-endian uint16, gzip; bits 0-3 class, 4-10 row direction, 11-15 random (js/terrain/fieldAnalysis.js)',
  version: 1, tiles: NT, n: LC, fields, regions: gidTotal, joinedAcrossEdges: joined, bytes,
  mapped: { orchard: classCount[CLASS_ORCHARD] / total, vineyard: classCount[CLASS_VINEYARD] / total, greenhouse: classCount[CLASS_GREENHOUSE] / total },
  seconds: Math.round((Date.now() - t0) / 1000),
}, null, 1));
log(`wrote ${NT * NT} tiles, ${(bytes / 1e6).toFixed(1)} MB`);
