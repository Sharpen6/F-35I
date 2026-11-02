// Where the trees stand: placement rules from ESA WorldCover land cover (10 m) and the L0
// colour imagery (6.25 m), pure JS (runs in the worker and in node tests; no DOM, no three).
//
// analyseTile() prepares one 6.4 km tile: per 10 m pixel greenness (ExG = 2G - R - B of the
// imagery), brightness, saturation, slope, height and the land cover of the neighbourhood;
// orchard and palm plantation blocks (connected components) with their row direction;
// airport exclusion zones from the runways. generateCell() then places the trees of one
// 200 m cell, deterministically (the same trees every time, whatever the order of requests):
//
//   tree cover (10)   orchards: flat, lowland, very green and dark -> rows of citrus /
//                     avocado (or olive where paler) along the block's long axis;
//                     date palm plantations below -150 m (Jordan valley, Dead Sea);
//                     thin lines in farmland -> eucalyptus / cypress windbreaks;
//                     among houses -> garden and street trees;
//                     else forest: Aleppo pine with oak / carob / terebinth on the hills,
//                     pine / eucalyptus / broadleaf / cypress in the lowland, in stands
//                     (150 m noise), density from the imagery's greenness and darkness
//   shrubland (20)    hills: olive groves on the terraces (rows on contour lines) where
//                     green enough, garrigue shrubs between; lowland: shrubs
//   grassland (30)    sparse shrubs, a lone oak or olive on the hills now and then
//   cropland (40)     a lone tree now and then
//   built-up (50)     garden and street trees where the imagery is green
//   bare (60), water, wetland, snow, moss: nothing
//
// Nothing on runways (+ 80 m to the sides, + 300 m past the ends), no shrubs or lone trees
// around them (airfield grass), and nothing on grey or bright pixels (roads, roofs).
//
// Output per tree: position (float32 x, y, z; y = ground - 0.25 m) and 8 bytes: species |
// variant << 4 | the imagery's weight in the colour (0..7) << 5, height / HEIGHT_STEP, crown
// width factor * 128, rotation * 256 / 2 pi, colour R, G, B (sRGB: the imagery's mean over the
// crown where it is green, else the species' own), rank (0..255, uniform: thinning).

import { SPECIES, SP, HEIGHT_STEP } from './species.js';

export const TILE_M = 6400;
export const CORE_HALF = 51200;
export const TILES = 16;
export const LC_N = 640;          // land cover px per tile side (10 m)
export const COL_N = 1024;        // colour px per tile side (6.25 m)
export const H_N = 257;           // height samples per tile side (25 m)
export const CELL_M = 200;
export const CELLS = TILE_M / CELL_M;   // 32
export const REC_U8 = 8;

const LC_PX = TILE_M / LC_N;      // 10 m
const COL_PX = TILE_M / COL_N;    // 6.25 m
const H_SP = TILE_M / (H_N - 1);  // 25 m
const DEG = 180 / Math.PI;

// ------------------------------------------------------------------------------------------
// deterministic randomness

function hash2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise over world x, z with a cell of `scale` m (0..1). */
export function noise2(x, z, scale, seed) {
  const gx = x / scale, gz = z / scale;
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------------------------------
// tile analysis

/**
 * ix, iz: tile; lc: Uint8Array 640^2 (row 0 north); rgb: Uint8Array / Uint8ClampedArray
 * 1024^2 * stride (stride 3 or 4); heights: Uint16Array 257^2 (h = v * 0.05 - 500);
 * runways: [{cx, cz, ux, uz, halfLength, halfWidth}] (world m); obstacles: the tile's mapped
 * roads, railways, airfield surfaces and buildings (obstacles.js buildObstacles), or null.
 */
export function analyseTile({ ix, iz, lc, rgb, stride = 4, heights, runways = [], obstacles = null }) {
  const x0 = -CORE_HALF + ix * TILE_M, z0 = -CORE_HALF + iz * TILE_M;
  const N = LC_N, NN = N * N;
  // colour (RGB bytes, row 0 north)
  const col = new Uint8Array(COL_N * COL_N * 3);
  for (let i = 0, n = COL_N * COL_N; i < n; i++) {
    col[i * 3] = rgb[i * stride]; col[i * 3 + 1] = rgb[i * stride + 1]; col[i * 3 + 2] = rgb[i * stride + 2];
  }
  // heights
  const h = new Float32Array(H_N * H_N);
  for (let i = 0; i < h.length; i++) h[i] = heights[i] * 0.05 - 500;
  const t = { ix, iz, x0, z0, lc, col, h, obs: obstacles };

  // per 10 m pixel: greenness, brightness, saturation (of the 6.25 m imagery under it)
  const exg = new Float32Array(NN), luma = new Float32Array(NN), sat = new Float32Array(NN);
  const elev = new Float32Array(NN), slope = new Float32Array(NN);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const p = j * N + i;
      const [r, g, b] = colourAt(t, x0 + (i + 0.5) * LC_PX, z0 + (j + 0.5) * LC_PX, 5);
      exg[p] = (2 * g - r - b) / 255;
      luma[p] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat[p] = mx > 0 ? (mx - mn) / mx : 0;
      const x = x0 + (i + 0.5) * LC_PX, z = z0 + (j + 0.5) * LC_PX;
      elev[p] = heightAt(t, x, z);
      const e = 12.5;
      const gx = (heightAt(t, x + e, z) - heightAt(t, x - e, z)) / (2 * e);
      const gz = (heightAt(t, x, z + e) - heightAt(t, x, z - e)) / (2 * e);
      slope[p] = Math.atan(Math.hypot(gx, gz)) * DEG;
    }
  }
  Object.assign(t, { exg, luma, sat, elev, slope });

  // neighbourhood land cover (7 x 7 px = 70 m): share of built-up, crop, trees, grass / shrub
  const sat_ = (code) => {
    const s = new Float64Array((N + 1) * (N + 1));
    for (let j = 0; j < N; j++) {
      let row = 0;
      for (let i = 0; i < N; i++) {
        row += lc[j * N + i] === code ? 1 : 0;
        s[(j + 1) * (N + 1) + i + 1] = s[j * (N + 1) + i + 1] + row;
      }
    }
    return s;
  };
  const boxShare = (s, r) => {
    const out = new Uint8Array(NN);
    for (let j = 0; j < N; j++) {
      const ja = Math.max(0, j - r), jb = Math.min(N, j + r + 1);
      for (let i = 0; i < N; i++) {
        const ia = Math.max(0, i - r), ib = Math.min(N, i + r + 1);
        const v = s[jb * (N + 1) + ib] - s[ja * (N + 1) + ib] - s[jb * (N + 1) + ia] + s[ja * (N + 1) + ia];
        out[j * N + i] = Math.round(255 * v / ((jb - ja) * (ib - ia)));
      }
    }
    return out;
  };
  const sBuilt = sat_(50), sCrop = sat_(40), sTree = sat_(10), sGrass = sat_(30);
  t.built = boxShare(sBuilt, 3);
  t.crop = boxShare(sCrop, 3);
  t.tree3 = boxShare(sTree, 1);
  t.grass = boxShare(sGrass, 3);
  t.builtWide = boxShare(sBuilt, 12);

  // airports: 2 = no vegetation (runway strip), 1 = airfield (no shrubs / lone trees)
  t.air = new Uint8Array(NN);
  for (const r of runways) {
    const ext = r.halfLength + 300, wid = r.halfWidth + 80, zone = 900;
    // quick reject against the tile
    const reach = r.halfLength + 300 + zone;
    if (r.cx + reach < x0 || r.cx - reach > x0 + TILE_M || r.cz + reach < z0 || r.cz - reach > z0 + TILE_M) continue;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const dx = x0 + (i + 0.5) * LC_PX - r.cx, dz = z0 + (j + 0.5) * LC_PX - r.cz;
        const s = Math.abs(dx * r.ux + dz * r.uz), q = Math.abs(-dx * r.uz + dz * r.ux);
        const p = j * N + i;
        if (s < ext && q < wid) t.air[p] = 2;
        else if (s < ext + zone * 0.5 && q < wid + zone) t.air[p] = Math.max(t.air[p], 1);
      }
    }
  }

  // plantation blocks: orchards (lowland, flat, very green and dark) and date palms (rift)
  const kind = new Uint8Array(NN);    // 1 orchard, 2 palm plantation
  for (let p = 0; p < NN; p++) {
    if (lc[p] !== 10 || t.air[p] === 2) continue;
    if (elev[p] < -150) kind[p] = 2;
    else if (slope[p] < 4.5 && elev[p] < 420 && exg[p] > 0.165 && luma[p] < 0.47 && t.built[p] < 90) kind[p] = 1;
  }
  // blocks: label the mask eroded by one pixel (4-connected), so blocks that touch through a
  // hedge or a path stay apart, then give the border pixels to the block next to them
  t.comp = new Int32Array(NN).fill(-1);
  t.comps = [];
  const orient = blockOrientation(t);
  const stack = new Int32Array(NN);
  const core = new Uint8Array(NN);
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const p = j * N + i, k = kind[p];
      if (k && kind[p - 1] === k && kind[p + 1] === k && kind[p - N] === k && kind[p + N] === k) core[p] = 1;
    }
  }
  const label = (p0, k, useCore) => {
    const id = t.comps.length;
    let sp = 0;
    stack[sp++] = p0;
    t.comp[p0] = id;
    while (sp) {
      const p = stack[--sp];
      const i = p % N, j = (p / N) | 0;
      for (const q of [i > 0 ? p - 1 : -1, i < N - 1 ? p + 1 : -1, j > 0 ? p - N : -1, j < N - 1 ? p + N : -1]) {
        if (q >= 0 && kind[q] === k && t.comp[q] < 0 && (!useCore || core[q])) { t.comp[q] = id; stack[sp++] = q; }
      }
    }
    t.comps.push({ kind: k });
  };
  for (let p = 0; p < NN; p++) if (core[p] && t.comp[p] < 0) label(p, kind[p], true);
  for (let pass = 0; pass < 2; pass++) {
    for (let p = 0; p < NN; p++) {
      if (!kind[p] || t.comp[p] >= 0) continue;
      const i = p % N, j = (p / N) | 0;
      for (const q of [i > 0 ? p - 1 : -1, i < N - 1 ? p + 1 : -1, j > 0 ? p - N : -1, j < N - 1 ? p + N : -1]) {
        if (q >= 0 && t.comp[q] >= 0 && t.comps[t.comp[q]].kind === kind[p]) { t.comp[p] = t.comp[q]; break; }
      }
    }
  }
  for (let p = 0; p < NN; p++) if (kind[p] && t.comp[p] < 0) label(p, kind[p], false);
  // statistics per block
  const nB = t.comps.length;
  const acc = new Float64Array(nB * 10);
  for (let p = 0; p < NN; p++) {
    const id = t.comp[p];
    if (id < 0) continue;
    const i = p % N, j = (p / N) | 0, a = id * 10;
    acc[a]++; acc[a + 1] += i; acc[a + 2] += j; acc[a + 3] += i * i; acc[a + 4] += j * j; acc[a + 5] += i * j;
    acc[a + 6] += exg[p]; acc[a + 7] += luma[p]; acc[a + 8] += elev[p];
  }
  for (let id = 0; id < nB; id++) {
    const a = id * 10, k = t.comps[id].kind;
    const n = acc[a], sx = acc[a + 1], sz = acc[a + 2], sxx = acc[a + 3], szz = acc[a + 4], sxz = acc[a + 5];
    const se = acc[a + 6], sl = acc[a + 7], sh = acc[a + 8];
    const mx = sx / n, mz = sz / n;
    const cxx = sxx / n - mx * mx, czz = szz / n - mz * mz, cxz = sxz / n - mx * mz;
    const theta = 0.5 * Math.atan2(2 * cxz, cxx - czz);
    const l1 = (cxx + czz) / 2 + Math.sqrt(((cxx - czz) / 2) ** 2 + cxz * cxz);
    const l2 = (cxx + czz) / 2 - Math.sqrt(((cxx - czz) / 2) ** 2 + cxz * cxz);
    const elong = Math.sqrt(Math.max(l1, 1e-6) / Math.max(l2, 0.08));
    const bi = Math.min(3, Math.floor(mx / 160)), bj = Math.min(3, Math.floor(mz / 160));
    const th = elong > 1.35 || n < 4 ? theta : orient[bj * 4 + bi];
    const meanExg = se / n, meanLuma = sl / n;
    const seed = Math.floor(hash2(ix * 64 + Math.round(mx), iz * 64 + Math.round(mz), 977) * 1e9);
    const c = t.comps[id];
    Object.assign(c, {
      n, theta: th, cx: x0 + (mx + 0.5) * LC_PX, cz: z0 + (mz + 0.5) * LC_PX, seed,
      meanExg, meanLuma, elev: sh / n,
    });
    if (k === 2) {
      Object.assign(c, { species: SP.datepalm, du: 8.5 + hash2(seed, 1, 2) * 1.5, dv: 8.5 + hash2(seed, 3, 4) * 1.5, hMin: 6, hMax: 11, gap: 0.05 });
    } else {
      const u = hash2(seed, 5, 6);
      if (meanExg < 0.19 && meanLuma > 0.4) {
        Object.assign(c, { species: SP.olive, du: 5.5, dv: 7, hMin: 3.5, hMax: 5.5, gap: 0.05 });   // intensive olive orchard
      } else if (u < 0.25) {
        Object.assign(c, { species: SP.citrus, du: 5, dv: 7, hMin: 5, hMax: 7.5, gap: 0.04 });     // avocado
      } else {
        Object.assign(c, { species: SP.citrus, du: 4, dv: 6, hMin: 3.2, hMax: 4.6, gap: 0.035 });  // citrus (rows along u)
      }
    }
  }
  // tree cover pixels right next to a block (paths, hedges, the block's ragged border) belong to
  // the block's edge: no forest there
  t.edge = new Uint8Array(NN);
  for (let j = 2; j < N - 2; j++) {
    for (let i = 2; i < N - 2; i++) {
      const p = j * N + i;
      if (t.comp[p] >= 0 || lc[p] !== 10) continue;
      let near = false;
      for (let dj = -2; dj <= 2 && !near; dj++) for (let di = -2; di <= 2; di++) if (t.comp[p + dj * N + di] >= 0 && t.comps[t.comp[p + dj * N + di]].kind === 1) { near = true; break; }
      if (near) t.edge[p] = 1;
    }
  }
  return t;
}

/** Dominant direction of the field pattern in each 1.6 km block (4 x 4 per tile), radians. */
function blockOrientation(t) {
  const out = new Float32Array(16);
  const N = LC_N;
  for (let bj = 0; bj < 4; bj++) {
    for (let bi = 0; bi < 4; bi++) {
      let c4 = 0, s4 = 0;
      for (let j = bj * 160 + 1; j < bj * 160 + 159; j++) {
        for (let i = bi * 160 + 1; i < bi * 160 + 159; i++) {
          const p = j * N + i;
          const gx = t.luma[p + 1] - t.luma[p - 1], gz = t.luma[p + N] - t.luma[p - N];
          const w = gx * gx + gz * gz;
          if (w < 1e-4) continue;
          const a = Math.atan2(gz, gx);
          c4 += w * Math.cos(4 * a); s4 += w * Math.sin(4 * a);
        }
      }
      // edges are perpendicular to the gradient; mod 90 deg both are the same direction
      out[bj * 4 + bi] = Math.atan2(s4, c4) / 4;
    }
  }
  return out;
}

/** Ground height (m) at world x, z inside the tile: the rendered triangle (NW-SE split). */
export function heightAt(t, x, z) {
  const gx = clamp((x - t.x0) / H_SP, 0, H_N - 1.0001), gz = clamp((z - t.z0) / H_SP, 0, H_N - 1.0001);
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const k = j * H_N + i, h = t.h;
  const ha = h[k], hd = h[k + H_N + 1];
  if (fx >= fz) { const hb = h[k + 1]; return ha + fx * (hb - ha) + fz * (hd - hb); }
  const hc = h[k + H_N];
  return ha + fz * (hc - ha) + fx * (hd - hc);
}

/** Mean imagery colour (sRGB bytes) over a square of `size` m centred on x, z. */
export function colourAt(t, x, z, size = 4) {
  const u0 = (x - size / 2 - t.x0) / COL_PX, u1 = (x + size / 2 - t.x0) / COL_PX;
  const v0 = (z - size / 2 - t.z0) / COL_PX, v1 = (z + size / 2 - t.z0) / COL_PX;
  const ia = clamp(Math.floor(u0), 0, COL_N - 1), ib = clamp(Math.floor(u1), 0, COL_N - 1);
  const ja = clamp(Math.floor(v0), 0, COL_N - 1), jb = clamp(Math.floor(v1), 0, COL_N - 1);
  let r = 0, g = 0, b = 0, n = 0;
  for (let j = ja; j <= jb; j++) {
    for (let i = ia; i <= ib; i++) {
      const p = (j * COL_N + i) * 3;
      r += t.col[p]; g += t.col[p + 1]; b += t.col[p + 2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

// ------------------------------------------------------------------------------------------
// cell generation

class Out {
  constructor() { this.pos = []; this.data = []; }
  get count() { return this.pos.length / 3; }
}

const spec = (name) => SPECIES[SP[name]];

/**
 * Trees of cell (cx, cz) of tile t (0..31 each, cell 0 at the tile's north-west corner).
 * density scales everything (1 = the full set; quality thinning happens on the main thread by
 * rank). Returns {count, pos: Float32Array, data: Uint8Array}.
 */
export function generateCell(t, cx, cz, { shrubs = true } = {}) {
  const out = new Out();
  const rng = mulberry32(((t.ix * 32 + cx) * 7919) ^ ((t.iz * 32 + cz) * 104729) ^ 0x5bd1e995);
  const N = LC_N;
  const cellX0 = t.x0 + cx * CELL_M, cellZ0 = t.z0 + cz * CELL_M;
  const pxPerCell = CELL_M / LC_PX;   // 20

  // plantation blocks touching this cell: rows on the block's grid
  const seen = new Set();
  for (let j = cz * pxPerCell; j < (cz + 1) * pxPerCell; j++) {
    for (let i = cx * pxPerCell; i < (cx + 1) * pxPerCell; i++) {
      const id = t.comp[j * N + i];
      if (id >= 0) seen.add(id);
    }
  }
  for (const id of seen) plantation(t, id, cellX0, cellZ0, out);

  // everything else, pixel by pixel
  for (let j = cz * pxPerCell; j < (cz + 1) * pxPerCell; j++) {
    for (let i = cx * pxPerCell; i < (cx + 1) * pxPerCell; i++) {
      const p = j * N + i;
      if (t.comp[p] >= 0 || t.air[p] === 2) continue;
      const code = t.lc[p];
      const px = t.x0 + i * LC_PX, pz = t.z0 + j * LC_PX;
      switch (code) {
        case 10: treeCover(t, p, px, pz, rng, out); break;
        case 20: if (t.air[p] === 0) shrubland(t, p, px, pz, rng, out, shrubs); break;
        case 30: if (t.air[p] === 0) grassland(t, p, px, pz, rng, out, shrubs); break;
        case 40: if (t.air[p] === 0) cropland(t, p, px, pz, rng, out); break;
        case 50: urban(t, p, px, pz, rng, out, 0); break;
        default: break;
      }
    }
  }
  const n = out.count;
  return { count: n, pos: new Float32Array(out.pos), data: new Uint8Array(out.data) };
}

/** Grey (low saturation, not green) or bright imagery colour: no tree stands there. */
function isGrey(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const s = mx > 0 ? (mx - mn) / mx : 0;
  const eg = (2 * g - r - b) / 255, l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return (s < 0.16 && eg < 0.03) || l > 0.72;
}

/** Writes one tree after the last checks (inside the cell, not on grey or water pixels). */
function emit(t, out, x, z, species, height, rng, opts = {}) {
  const { cellX0, cellZ0, grey = true, wf = 0.82 + 0.4 * rng() } = opts;
  if (cellX0 !== undefined && (x < cellX0 || x >= cellX0 + CELL_M || z < cellZ0 || z >= cellZ0 + CELL_M)) return false;
  const i = Math.floor((x - t.x0) / LC_PX), j = Math.floor((z - t.z0) / LC_PX);
  if (i < 0 || j < 0 || i >= LC_N || j >= LC_N) return false;
  const p = j * LC_N + i;
  const code = t.lc[p];
  if (code === 80 || code === 0 || code === 90 || code === 70 || t.air[p] === 2) return false;
  const sp = SPECIES[species];
  const crownR = Math.max(1.2, 0.5 * sp.crown * height * wf);
  const [r, g, b] = colourAt(t, x, z, Math.min(12, crownR * 1.6));
  // asphalt, concrete, roofs, sand: over the crown, and at the trunk itself (the one pixel: a
  // narrow road disappears in the crown's mean)
  if (grey && (isGrey(r, g, b) || isGrey(...colourAt(t, x, z, 0)))) return false;
  // mapped roads, railways, taxiways, aprons and buildings (obstacles.js): the imagery's 6 m
  // pixels cannot resolve a 7-30 m road or a roof that is not grey
  const ground = heightAt(t, x, z);
  if (t.obs && t.obs.blocked(x, z, crownR, height, ground)) return false;
  // the imagery's colour where it shows vegetation, else the species' own (lone trees in a
  // field must not take the field's colour)
  const e = (2 * g - r - b) / 255;
  const w = smooth(0.015, 0.11, e);
  const f = sp.foliage;
  const y = ground - 0.25;
  out.pos.push(x, y, z);
  const variant = rng() < 0.5 ? 0 : 1;
  out.data.push(
    species | (variant << 4) | (Math.round(w * 7) << 5),
    clamp(Math.round(height / HEIGHT_STEP), 1, 255),
    clamp(Math.round(wf * 128), 1, 255),
    Math.floor(rng() * 256),
    Math.round(f[0] + (r - f[0]) * w), Math.round(f[1] + (g - f[1]) * w), Math.round(f[2] + (b - f[2]) * w),
    Math.floor(rng() * 256),
  );
  return true;
}

function heightFor(species, rng, vigour = 0.5) {
  const [a, b] = SPECIES[species].height;
  return a + (b - a) * clamp(0.15 + 0.55 * vigour + 0.3 * rng(), 0, 1);
}

/** Expected trees per 10 m pixel for a crown cover share `cover`. */
function perPixel(species, cover, height) {
  const sp = SPECIES[species];
  const w = sp.crown * height;
  return cover * 100 / (Math.PI / 4 * w * w);
}

/** Poisson-ish count: floor(lambda + u). */
const countOf = (lambda, rng) => Math.floor(lambda + rng());

// rows of a plantation block, the part inside this cell
function plantation(t, id, cellX0, cellZ0, out) {
  const c = t.comps[id];
  const cs = Math.cos(c.theta), sn = Math.sin(c.theta);
  // grid coordinates of the cell's corners
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const [x, z] of [[cellX0, cellZ0], [cellX0 + CELL_M, cellZ0], [cellX0, cellZ0 + CELL_M], [cellX0 + CELL_M, cellZ0 + CELL_M]]) {
    const dx = x - c.cx, dz = z - c.cz;
    const u = dx * cs + dz * sn, v = -dx * sn + dz * cs;
    umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
  }
  const i0 = Math.floor(umin / c.du), i1 = Math.ceil(umax / c.du), j0 = Math.floor(vmin / c.dv), j1 = Math.ceil(vmax / c.dv);
  const vig = noise2(c.cx, c.cz, 400, 31);
  for (let jj = j0; jj <= j1; jj++) {
    for (let ii = i0; ii <= i1; ii++) {
      const r = mulberry32(Math.floor(hash2(ii, jj, c.seed) * 4294967296));
      const u = (ii + 0.5) * c.du + (r() - 0.5) * 0.5, v = (jj + 0.5) * c.dv + (r() - 0.5) * 0.4;
      const x = c.cx + u * cs - v * sn, z = c.cz + u * sn + v * cs;
      if (x < cellX0 || x >= cellX0 + CELL_M || z < cellZ0 || z >= cellZ0 + CELL_M) continue;
      const i = Math.floor((x - t.x0) / LC_PX), j = Math.floor((z - t.z0) / LC_PX);
      if (i < 0 || j < 0 || i >= LC_N || j >= LC_N || t.comp[j * LC_N + i] !== id) continue;
      if (r() < c.gap) continue;
      // trim the block's edge to the imagery: the tree must stand on green
      const [cr, cg, cb] = colourAt(t, x, z, 4);
      if ((2 * cg - cr - cb) / 255 < (c.kind === 2 ? 0.0 : 0.07)) continue;
      const hgt = c.hMin + (c.hMax - c.hMin) * clamp(0.35 + 0.4 * vig + 0.25 * r(), 0, 1);
      emit(t, out, x, z, c.species, hgt, r, { grey: c.kind !== 2, wf: 0.9 + 0.2 * r() });
    }
  }
}

// tree cover that is not a plantation block: windbreaks, garden trees, forest
function treeCover(t, p, px, pz, rng, out) {
  const exg = t.exg[p], luma = t.luma[p], elev = t.elev[p], slope = t.slope[p];
  if (t.edge[p]) {
    // beside an orchard block: a hedge tree where it is green, else the path between blocks
    if (exg > 0.12 && rng() < 0.35) {
      const sp = rng() < 0.6 ? SP.cypress : SP.eucalyptus;
      emit(t, out, px + rng() * LC_PX, pz + rng() * LC_PX, sp, heightFor(sp, rng, 0.5), rng);
    }
    return;
  }
  // among houses: garden and street trees
  if (t.built[p] > 85) { urban(t, p, px, pz, rng, out, 1); return; }
  const cover = clamp((exg - 0.03) / 0.17, 0.15, 1) * (0.75 + 0.4 * smooth(0.58, 0.36, luma));
  // a line of trees through farmland: windbreak (eucalyptus, cypress)
  if (t.tree3[p] <= 115 && t.crop[p] + t.grass[p] > 100 && elev > -100) {
    const sp = noise2(px, pz, 300, 7) < 0.68 ? SP.eucalyptus : SP.cypress;
    const n = countOf(sp === SP.cypress ? 2.2 : 1.4, rng);
    for (let k = 0; k < n; k++) {
      emit(t, out, px + rng() * LC_PX, pz + rng() * LC_PX, sp, heightFor(sp, rng, noise2(px, pz, 200, 9)), rng);
    }
    return;
  }
  // forest: species in stands
  const stand = noise2(px, pz, 150, 11);
  const vig = noise2(px, pz, 260, 13);
  const hills = elev > 180 || slope > 8;
  const nTry = 4;   // 2 x 2 strata
  for (let s = 0; s < nTry; s++) {
    const r = 0.72 * stand + 0.28 * rng();
    let sp;
    if (elev < -100) sp = r < 0.3 ? SP.datepalm : SP.broadleaf;
    else if (hills) sp = r < 0.7 ? SP.pine : r < 0.88 ? SP.broadleaf : r < 0.95 ? SP.cypress : (elev < 350 ? SP.eucalyptus : SP.pine);
    else sp = r < 0.36 ? SP.pine : r < 0.7 ? SP.eucalyptus : r < 0.9 ? SP.broadleaf : SP.cypress;
    const hgt = heightFor(sp, rng, vig);
    const lambda = perPixel(sp, cover, hgt) / nTry;
    const n = countOf(lambda, rng);
    for (let k = 0; k < n; k++) {
      const x = px + ((s & 1) + rng()) * LC_PX / 2 + (rng() - 0.5) * 3;
      const z = pz + ((s >> 1) + rng()) * LC_PX / 2 + (rng() - 0.5) * 3;
      emit(t, out, x, z, sp, k ? heightFor(sp, rng, vig) : hgt, rng);
    }
  }
}

// garden and street trees: where the imagery is green between the houses
function urban(t, p, px, pz, rng, out, fromTree) {
  const exg = t.exg[p];
  const green = clamp((exg - 0.055) / 0.12, 0, 1);
  if (green <= 0) return;
  const lambda = green * (fromTree ? 1.4 : 0.8);
  const n = countOf(lambda, rng);
  const coastal = t.elev[p] < 90;
  for (let k = 0; k < n; k++) {
    const r = rng();
    let sp;
    if (r < 0.42) sp = SP.broadleaf;
    else if (r < 0.52) sp = coastal ? SP.fanpalm : SP.cypress;
    else if (r < 0.62) sp = SP.datepalm;
    else if (r < 0.76) sp = SP.pine;
    else if (r < 0.86) sp = SP.cypress;
    else sp = SP.citrus;
    const x = px + rng() * LC_PX, z = pz + rng() * LC_PX;
    emit(t, out, x, z, sp, heightFor(sp, rng, 0.55 + 0.3 * rng()), rng);
  }
}

// shrubland: olive groves on the hills (on the terraces), garrigue shrubs
function shrubland(t, p, px, pz, rng, out, shrubs) {
  const exg = t.exg[p], elev = t.elev[p], slope = t.slope[p];
  const hills = elev > 150 || slope > 6;
  if (hills && exg > 0.055) {
    const olives = clamp((exg - 0.05) / 0.085, 0, 1) * 100 / 85;
    const n = countOf(olives, rng);
    for (let k = 0; k < n; k++) {
      let x = px + rng() * LC_PX, z = pz + rng() * LC_PX;
      [x, z] = onTerrace(t, x, z, 2.2 + 0.8 * noise2(px, pz, 300, 5));
      emit(t, out, x, z, SP.olive, heightFor(SP.olive, rng, noise2(px, pz, 300, 17)), rng);
    }
  }
  if (!shrubs) return;
  const sh = clamp((exg - 0.04) / 0.1, 0, 1) * (hills ? 0.5 : 0.7);
  shrubPatch(t, px, pz, sh, rng, out);
  if (!hills && rng() < 0.02) emit(t, out, px + rng() * LC_PX, pz + rng() * LC_PX, SP.broadleaf, heightFor(SP.broadleaf, rng, 0.3), rng);
}

/**
 * Shrubs of one 10 m pixel, lambda per pixel on average: in patches (45 m noise; garrigue is
 * never an even sprinkle) and in clumps of one to three, sizes from an 80 m vigour noise.
 */
function shrubPatch(t, px, pz, lambda, rng, out) {
  const patch = smooth(0.25, 0.8, noise2(px, pz, 45, 21));
  const n = countOf(lambda * (0.2 + 1.6 * patch) / 1.6, rng);
  const vig = noise2(px, pz, 80, 23);
  for (let k = 0; k < n; k++) {
    const x = px + rng() * LC_PX, z = pz + rng() * LC_PX;
    const m = 1 + Math.floor(rng() * rng() * 3.2);
    for (let q = 0; q < m; q++) {
      const a = rng() * 6.283, r = q ? 0.8 + 1.4 * rng() : 0;
      emit(t, out, x + Math.cos(a) * r, z + Math.sin(a) * r, SP.shrub, heightFor(SP.shrub, rng, vig * (q ? 0.7 : 1)), rng);
    }
  }
}

/** Moves a point down or up the slope onto the nearest terrace contour (step dh metres). */
function onTerrace(t, x, z, dh) {
  const e = 4;
  const h = heightAt(t, x, z);
  const gx = (heightAt(t, x + e, z) - heightAt(t, x - e, z)) / (2 * e);
  const gz = (heightAt(t, x, z + e) - heightAt(t, x, z - e)) / (2 * e);
  const g2 = gx * gx + gz * gz;
  if (g2 < 0.004) return [x, z];          // flat: no terraces
  const g = Math.sqrt(g2);
  const target = Math.round(h / dh) * dh;
  const d = clamp((target - h) / g, -6, 6);      // metres along the gradient
  return [x + gx / g * d, z + gz / g * d];
}

function grassland(t, p, px, pz, rng, out, shrubs) {
  const exg = t.exg[p], elev = t.elev[p], slope = t.slope[p];
  const hills = elev > 150 || slope > 6;
  if (shrubs) shrubPatch(t, px, pz, clamp((exg - 0.035) / 0.1, 0, 1) * 0.3, rng, out);
  if (rng() < (hills ? 0.005 : 0.0015) * (exg > 0.06 ? 2 : 1)) {
    const sp = hills && rng() < 0.5 ? SP.olive : SP.broadleaf;
    emit(t, out, px + rng() * LC_PX, pz + rng() * LC_PX, sp, heightFor(sp, rng, 0.4), rng);
  }
}

function cropland(t, p, px, pz, rng, out) {
  if (t.exg[p] > 0.11 && rng() < 0.0025) {
    const sp = rng() < 0.6 ? SP.broadleaf : SP.eucalyptus;
    emit(t, out, px + rng() * LC_PX, pz + rng() * LC_PX, sp, heightFor(sp, rng, 0.5), rng);
  }
}

/** The tiles and cells (tile ix, iz, cell cx, cz) of world x, z, or null outside the core. */
export function cellOf(x, z) {
  const gx = (x + CORE_HALF) / CELL_M, gz = (z + CORE_HALF) / CELL_M;
  if (gx < 0 || gz < 0 || gx >= TILES * CELLS || gz >= TILES * CELLS) return null;
  const X = Math.floor(gx), Z = Math.floor(gz);
  return { ix: Math.floor(X / CELLS), iz: Math.floor(Z / CELLS), cx: X % CELLS, cz: Z % CELLS, X, Z };
}
