// Road, railway, taxiway and apron meshes draped exactly on the terrain (pure JS: runs in the
// roads worker, js/world/roadsWorker.js, and in node tests).
//
// The terrain near the camera is the 25 m height grid with every cell split into two triangles
// along its NW-SE diagonal (js/terrain/HeightField.js). A ribbon that only samples heights at its
// own vertices floats over valleys and cuts through ridges between them, and no depth bias hides
// that at a grazing angle. So every ribbon quad (and every apron triangle) is cut along the grid
// lines and the diagonals into convex pieces that each lie inside one terrain triangle, and every
// piece takes that triangle's plane: the road surface is the terrain surface, to float precision,
// at any distance and angle. A small depth bias in the shader (js/world/roadShaders.js) then
// decides who is on top, with no z-fighting and no gaps. Where the terrain is one plane over
// several cells (flattened airfields) a piece spans up to 4 x 4 of them.
//
// Input: a road tile (sim/tools/world/ROADS.md: polylines in 0.1 m units from the tile's NW
// corner, cross-section, flags, junctions), the airfield surfaces of the tile and the terrain
// heights of the tile with a one-sample border. Output: one mesh per 1600 m chunk (4 x 4 per tile,
// the terrain's level-0 nodes) and class group (main roads / minor roads), positions relative to
// the chunk's centre, triangles sorted by depth priority (soft edges blend over lower layers).

export const TILE_M = 6400;
export const CORE_HALF = 51200;
export const CELL = 25;                       // terrain grid (m)
export const TILE_N = 256;                    // cells per tile edge
export const HGRID = TILE_N + 3;              // height samples per row incl. the one-sample border (259)
export const CHUNK_M = 1600;
export const CHUNKS = TILE_M / CHUNK_M;       // 4 x 4 chunks per tile
const CHUNK_CELLS = CHUNK_M / CELL;           // 64

/** Render classes (ids in the tiles, sim/tools/world/roads.py CLS; airfields.py for 12, 13). */
export const CLASS = {
  motorway: 0, motorway_link: 1, trunk: 2, trunk_link: 3, primary: 4, secondary: 5, tertiary: 6,
  residential: 7, service: 8, track: 9, rail: 10, light_rail: 11, taxiway: 12, apron: 13,
  structure: 14,                              // bridge decks' sides, parapets, undersides and piers (built here)
};
// 128 is set by the mesh builder only: on a road, a piece of a lifted bridge deck (small depth
// bias, the deck's own normal); on a structure, a face looking down (the deck's underside)
export const FLAG = { oneway: 1, bridge: 2, urban: 4, unpaved: 8, solidCentre: 16, lit: 32, edgeMarks: 64, lifted: 128 };
/** Group 1 (residential streets, service roads, tracks) is drawn over a shorter range than group 0. */
export const groupOf = (cls) => (cls >= 7 && cls <= 9 ? 1 : 0);

// Who is drawn on top where ribbons overlap (junctions, level crossings, overpasses): a higher
// layer wins; bridges and overpasses (level >= 1) go above everything at ground level.
const LAYER = [6, 5, 5, 4, 4, 3, 3, 2, 1, 1, 7, 7, 8, 0, 0];
const BRIDGE_LAYERS = 9;
const REGION_BLOCK = 4;                       // cells (100 m): largest span of a merged planar region
export const PRIO_STEPS = 4;                  // hash steps per layer (same-class overlaps resolve consistently)

// Bridge decks (roads.py bridge_decks): structure depth under the deck surface (when the tile does
// not give one), parapet height and width, pier spacing and least size (m); structure pieces of at
// most STRUCT_STEP m, and only where the deck stands at least MIN_LIFT m off the terrain (lower,
// the road is simply on the ground)
const DECK_DEPTH = 1.6, PARAPET_H = 0.9, PARAPET_W = 0.4, PIER_STEP = 40, PIER_W = 1.4;
const STRUCT_STEP = 40, MIN_LIFT = 0.3;

/** Parses a road tile (ROADS.md); returns {polylines, points, breaks}; bridge decks in polylines[k].deck. */
export function parseRoadTile(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'RDS1') throw new Error(`road tile: bad magic ${magic}`);
  const n = dv.getUint32(4, true), np = dv.getUint32(8, true), nb = dv.getUint32(12, true);
  const ptsOff = 16 + n * 24, brOff = ptsOff + np * 4;
  const points = new Uint16Array(buf.slice(ptsOff, ptsOff + np * 4));
  const breaks = new Float32Array(buf.slice(brOff, brOff + nb * 8));
  const polylines = new Array(n);
  for (let k = 0; k < n; k++) {
    const o = 16 + k * 24;
    polylines[k] = {
      cls: dv.getUint8(o), flags: dv.getUint8(o + 1), lanes: dv.getUint8(o + 2), level: dv.getInt8(o + 3),
      cw: dv.getUint16(o + 4, true) / 100, left: dv.getUint8(o + 6) / 10, right: dv.getUint8(o + 7) / 10,
      n: dv.getUint16(o + 8, true), nBreaks: dv.getUint16(o + 10, true),
      first: dv.getUint32(o + 12, true), firstBreak: dv.getUint32(o + 16, true), u0: dv.getFloat32(o + 20, true),
      deck: null,
    };
  }
  // optional deck section: 'DCK1', count, then per deck polyline its index, the structure depth
  // under the deck surface (m) and a deck height per point
  let o = brOff + nb * 8;
  if (buf.byteLength >= o + 8 && String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)) === 'DCK1') {
    const nd = dv.getUint32(o + 4, true);
    o += 8;
    for (let d = 0; d < nd; d++) {
      const pl = polylines[dv.getUint32(o, true)];
      pl.deckDepth = dv.getFloat32(o + 4, true);
      const h = new Float32Array(pl.n);
      for (let k = 0; k < pl.n; k++) h[k] = dv.getFloat32(o + 8 + 4 * k, true);
      pl.deck = h;
      o += 8 + 4 * pl.n;
    }
  }
  return { polylines, points, breaks };
}

// ------------------------------------------------------------------------------------------
// the shaders' noise texture (tiling value noise, a different scale per channel), computed in the
// worker: octave by octave with the per-column weights computed once

export const NOISE_SIZE = 256;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 256 x 256 RGBA, every channel mean 0.5: r grain, g blotches, b streaks / stains, a large patches.
 */
export function makeNoiseData(size = NOISE_SIZE) {
  const rnd = mulberry32(20261101);
  const octaves = [
    [[256, 0.6], [128, 0.4]],                 // r: grain
    [[8, 0.5], [16, 0.3], [32, 0.2]],         // g: blotches
    [[16, 0.45], [32, 0.35], [64, 0.2]],      // b: streaks / stains
    [[2, 0.5], [4, 0.3], [8, 0.2]],           // a: large patches
  ];
  // the lattices, drawn in the order the octaves first use them (the texture stays the same)
  const lattices = new Map();
  for (const oc of octaves) {
    for (const [n] of oc) {
      if (!lattices.has(n)) { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = rnd(); lattices.set(n, a); }
    }
  }
  const ch = octaves.map(() => new Float32Array(size * size));
  const i0 = new Int32Array(size), i1 = new Int32Array(size), sx = new Float32Array(size);
  for (let c = 0; c < 4; c++) {
    const out = ch[c];
    for (const [n, w] of octaves[c]) {
      const L = lattices.get(n);
      // smoothstep weights and lattice columns of every pixel column (rows alike)
      for (let x = 0; x < size; x++) {
        const g = (x / size) * n, xi = Math.floor(g), f = g - xi;
        i0[x] = xi % n; i1[x] = (xi + 1) % n; sx[x] = f * f * (3 - 2 * f);
      }
      for (let y = 0; y < size; y++) {
        const j0 = i0[y] * n, j1 = i1[y] * n, sy = sx[y];
        const row = y * size;
        for (let x = 0; x < size; x++) {
          const a = L[j0 + i0[x]], b = L[j0 + i1[x]], cc = L[j1 + i0[x]], d = L[j1 + i1[x]];
          const s = sx[x];
          out[row + x] += w * ((a + (b - a) * s) * (1 - sy) + (cc + (d - cc) * s) * sy);
        }
      }
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let c = 0; c < 4; c++) {
    const a = ch[c];
    let m = 0, m2 = 0;
    for (let i = 0; i < a.length; i++) { m += a[i]; m2 += a[i] * a[i]; }
    m /= a.length;
    const sd = Math.sqrt(Math.max(m2 / a.length - m * m, 1e-9));
    for (let i = 0; i < a.length; i++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(127.5 + (a[i] - m) / sd * 0.2 * 255)));
  }
  return data;
}

// ------------------------------------------------------------------------------------------
// half floats (the junction distances)

const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
export function toHalf(v) {
  _f32[0] = Math.max(-65000, Math.min(65000, v));
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112;        // rebias 127 -> 15
  const m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    return sign | (((m | 0x800000) >> (1 - e)) + 0x1000 >> 13);
  }
  return sign | ((e << 10) + ((m + 0x1000) >> 13));   // + carries a rounded-up mantissa into the exponent
}

// ------------------------------------------------------------------------------------------
// the terrain inside one tile (tile-local metres, x east, z south, origin at the NW corner)

export class TileGround {
  /** heights: Float32Array HGRID x HGRID, sample (i, j) for i, j in -1..257 at [(j + 1) * HGRID + i + 1]. */
  constructor(heights) {
    this.h = heights;
    // per-sample normals by central differences, as the terrain's normal map (js/terrain/textures.js)
    const n = HGRID, nx = new Float32Array(n * n), nz = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const il = Math.max(i - 1, 0), ir = Math.min(i + 1, n - 1), ju = Math.max(j - 1, 0), jd = Math.min(j + 1, n - 1);
        const dhdx = (heights[j * n + ir] - heights[j * n + il]) / ((ir - il) * CELL);
        const dhdz = (heights[jd * n + i] - heights[ju * n + i]) / ((jd - ju) * CELL);
        const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
        nx[j * n + i] = -dhdx * inv;
        nz[j * n + i] = -dhdz * inv;
      }
    }
    this.nx = nx;
    this.nz = nz;
  }
  H(i, j) { return this.h[(j + 1) * HGRID + i + 1]; }
  /** Height of the rendered surface at tile-local (x, z) (exactly HeightField.heightAt). */
  heightAt(x, z) {
    const gx = x / CELL, gz = z / CELL;
    const i = Math.min(Math.max(Math.floor(gx), -1), TILE_N), j = Math.min(Math.max(Math.floor(gz), -1), TILE_N);
    return this.plane(i, j, gx - i >= gz - j, x, z);
  }
  /** Height on the rendered surface (exactly HeightField.heightAt) in cell (i, j), side ne (fx >= fz). */
  plane(i, j, ne, x, z) {
    const fx = x / CELL - i, fz = z / CELL - j;
    const ha = this.H(i, j), hd = this.H(i + 1, j + 1);
    if (ne) { const hb = this.H(i + 1, j); return ha + fx * (hb - ha) + fz * (hd - hb); }
    const hc = this.H(i, j + 1);
    return ha + fz * (hc - ha) + fx * (hd - hc);
  }
  /**
   * If every sample of cells i0..i1 x j0..j1 lies on one plane (flattened airfields, the sea),
   * that plane as [h0, dh/di, dh/dj, i0, j0], else null.
   */
  regionPlane(i0, i1, j0, j1) {
    const h0 = this.H(i0, j0), di = this.H(i0 + 1, j0) - h0, dj = this.H(i0, j0 + 1) - h0;
    for (let j = j0; j <= j1 + 1; j++) {
      for (let i = i0; i <= i1 + 1; i++) {
        if (Math.abs(this.H(i, j) - (h0 + (i - i0) * di + (j - j0) * dj)) > 1e-4) return null;
      }
    }
    return [h0, di, dj, i0, j0];
  }
  /** Smooth normal (x, z components) bilinear between the samples, as the GPU filters the normal map. */
  normal(x, z, out) {
    const gx = x / CELL + 1, gz = z / CELL + 1;
    let i = Math.floor(gx), j = Math.floor(gz);
    i = Math.min(Math.max(i, 0), HGRID - 2); j = Math.min(Math.max(j, 0), HGRID - 2);
    const fx = Math.min(Math.max(gx - i, 0), 1), fz = Math.min(Math.max(gz - j, 0), 1);
    const k = j * HGRID + i;
    const a = this.nx, b = this.nz;
    out[0] = (a[k] * (1 - fx) + a[k + 1] * fx) * (1 - fz) + (a[k + HGRID] * (1 - fx) + a[k + HGRID + 1] * fx) * fz;
    out[1] = (b[k] * (1 - fx) + b[k + 1] * fx) * (1 - fz) + (b[k + HGRID] * (1 - fx) + b[k + HGRID + 1] * fx) * fz;
    return out;
  }
}

// ------------------------------------------------------------------------------------------
// convex polygon clipping (flat arrays [x0, z0, x1, z1, ...])

/** The part of convex polygon p where a * x + b * z + c >= 0 (Sutherland-Hodgman, one plane). */
function clipKeep(p, a, b, c) {
  const n = p.length >> 1;
  const out = [];
  let px = p[2 * n - 2], pz = p[2 * n - 1];
  let pd = a * px + b * pz + c;
  for (let k = 0; k < n; k++) {
    const x = p[2 * k], z = p[2 * k + 1];
    const d = a * x + b * z + c;
    if (d >= 0) {
      if (pd < 0) { const t = pd / (pd - d); out.push(px + (x - px) * t, pz + (z - pz) * t); }
      out.push(x, z);
    } else if (pd >= 0) {
      const t = pd / (pd - d);
      out.push(px + (x - px) * t, pz + (z - pz) * t);
    }
    px = x; pz = z; pd = d;
  }
  return out.length >= 6 ? out : null;
}

function area2(p) {
  let s = 0;
  const n = p.length >> 1;
  for (let k = 0, m = n - 1; k < n; m = k++) s += p[2 * m] * p[2 * k + 1] - p[2 * k] * p[2 * m + 1];
  return s;
}

/**
 * Cuts convex polygon p (tile-local metres) along the terrain grid and diagonals, inside the cell
 * range [ci0, ci1] x [cj0, cj1] (one chunk), and calls emit(piece, heightOf) for every piece
 * inside one terrain triangle (or one plane spanning several cells).
 */
function cutToTerrain(ground, p, ci0, ci1, cj0, cj1, emit) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let k = 0; k < p.length; k += 2) {
    if (p[k] < x0) x0 = p[k]; if (p[k] > x1) x1 = p[k];
    if (p[k + 1] < z0) z0 = p[k + 1]; if (p[k + 1] > z1) z1 = p[k + 1];
  }
  const i0 = Math.floor(x0 / CELL), i1 = Math.floor(x1 / CELL - 1e-9);
  const j0 = Math.floor(z0 / CELL), j1 = Math.floor(z1 / CELL - 1e-9);
  const a0 = Math.max(i0, ci0), a1 = Math.min(i1, ci1), b0 = Math.max(j0, cj0), b1 = Math.min(j1, cj1);
  if (a0 > a1 || b0 > b1) return;
  // one plane over the whole range: clip to blocks of REGION_BLOCK cells only. Not larger: the
  // vertex shader lowers vertices by the earth's curvature (d^2 / 2R), which is linear only
  // over short spans; across a 1 km triangle the surface would sag a centimetre under the terrain.
  const pl = ground.regionPlane(a0, a1, b0, b1);
  if (pl) {
    const [h0, di, dj, pi0, pj0] = pl;
    const hAt = (x, z) => h0 + (x / CELL - pi0) * di + (z / CELL - pj0) * dj;
    for (let bi = a0; bi <= a1; bi += REGION_BLOCK) {
      const bi1 = Math.min(bi + REGION_BLOCK - 1, a1);
      let col = p;
      if (bi > i0) col = clipKeep(col, 1, 0, -bi * CELL);
      if (col && bi1 < i1) col = clipKeep(col, -1, 0, (bi1 + 1) * CELL);
      if (!col) continue;
      for (let bj = b0; bj <= b1; bj += REGION_BLOCK) {
        const bj1 = Math.min(bj + REGION_BLOCK - 1, b1);
        let q = col;
        if (bj > j0) q = clipKeep(q, 0, 1, -bj * CELL);
        if (q && bj1 < j1) q = clipKeep(q, 0, -1, (bj1 + 1) * CELL);
        if (q && Math.abs(area2(q)) > 1e-6) emit(q, hAt);
      }
    }
    return;
  }
  for (let i = a0; i <= a1; i++) {
    let col = p;
    if (i > i0) col = clipKeep(col, 1, 0, -i * CELL);                 // x >= i * CELL
    if (col && i < i1) col = clipKeep(col, -1, 0, (i + 1) * CELL);    // x <= (i + 1) * CELL
    if (!col) continue;
    for (let j = b0; j <= b1; j++) {
      let cell = col;
      if (j > j0) cell = clipKeep(cell, 0, 1, -j * CELL);
      if (cell && j < j1) cell = clipKeep(cell, 0, -1, (j + 1) * CELL);
      if (!cell) continue;
      // a planar cell needs no diagonal (exact: the heights are quantised to 5 cm)
      const flat = Math.abs(ground.H(i, j) + ground.H(i + 1, j + 1) - ground.H(i + 1, j) - ground.H(i, j + 1)) < 1e-4;
      if (flat) {
        if (Math.abs(area2(cell)) > 1e-6) emit(cell, (x, z) => ground.plane(i, j, true, x, z));
        continue;
      }
      // diagonal of cell (i, j): fx - fz = (x - z) / CELL - (i - j); NE side fx >= fz
      const c = -(i - j) * CELL;
      const ne = clipKeep(cell, 1, -1, c);
      const sw = clipKeep(cell, -1, 1, -c);
      if (ne && Math.abs(area2(ne)) > 1e-6) emit(ne, (x, z) => ground.plane(i, j, true, x, z));
      if (sw && Math.abs(area2(sw)) > 1e-6) emit(sw, (x, z) => ground.plane(i, j, false, x, z));
    }
  }
}

// ------------------------------------------------------------------------------------------
// one tile's polylines, prepared once (the worker caches them) and built chunk by chunk

function hash32(a, b) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** Depth priority of a polyline (0..255): layer by class, bridges on top, a hash inside the layer. */
export function priority(cls, level, flags, hash) {
  let layer = LAYER[cls] ?? 1;
  if (level >= 1 || (flags & FLAG.bridge)) layer += BRIDGE_LAYERS * Math.max(1, Math.min(level, 3));
  return Math.min(255, layer * PRIO_STEPS + (hash % PRIO_STEPS));
}

/**
 * Turns a parsed road tile plus the airfield items of the tile into build-ready items:
 *   extra     [{cls, flags, lanes, level, cw, left, right, u0, pts: [x, z, ...] tile-local, holds: [[u, dir]]}]
 *             (taxiways; dir +1: the runway lies toward +u)
 *   polygons  [{cls, flags, tris: [x, z, ...] tile-local triangles, axis: [ux, uz]}] (aprons)
 * Joins: where exactly two polylines of one group end at the same point (Overture splits a road
 * wherever an attribute changes), each end is mitred with the other's direction, so the ribbons
 * meet without a notch.
 */
export function prepareTile(road, extra = [], polygons = []) {
  const lines = [];
  if (road) {
    const { polylines: pls, points, breaks } = road;
    for (const pl of pls) {
      const pts = new Float64Array(pl.n * 2);
      for (let k = 0; k < pl.n * 2; k++) pts[k] = points[pl.first * 2 + k] * 0.1;
      const br = [];
      for (let k = 0; k < pl.nBreaks; k++) br.push([breaks[(pl.firstBreak + k) * 2], breaks[(pl.firstBreak + k) * 2 + 1]]);
      lines.push({ ...pl, pts, breaks: br });
    }
  }
  for (const e of extra) lines.push({ level: 0, u0: 0, ...e, pts: Float64Array.from(e.pts), breaks: [] });
  // bounding boxes (with the half width) for the chunk filter
  for (const l of lines) {
    const P = l.pts, hw = l.cw / 2 + Math.max(l.left, l.right) + 1;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < P.length; k += 2) {
      x0 = Math.min(x0, P[k]); x1 = Math.max(x1, P[k]); z0 = Math.min(z0, P[k + 1]); z1 = Math.max(z1, P[k + 1]);
    }
    l.box = [x0 - hw, z0 - hw, x1 + hw, z1 + hw];
    l.group = groupOf(l.cls);
  }
  // end-to-end joins
  const ends = new Map();
  const keyOf = (x, z) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
  lines.forEach((l, idx) => {
    const P = l.pts, n = P.length >> 1;
    if (n < 2) return;
    for (const end of [0, 1]) {
      const k = end ? n - 1 : 0;
      const key = keyOf(P[2 * k], P[2 * k + 1]) + ':' + l.group + ':' + (l.cls >= 10 ? l.cls : 0);
      if (!ends.has(key)) ends.set(key, []);
      ends.get(key).push([idx, end]);
    }
  });
  const dirAt = (l, end) => {
    const P = l.pts, n = P.length >> 1;
    // direction of travel at that end (start: first segment, end: last segment)
    const [a, b] = end ? [n - 2, n - 1] : [0, 1];
    const dx = P[2 * b] - P[2 * a], dz = P[2 * b + 1] - P[2 * a + 1];
    const L = Math.hypot(dx, dz) || 1;
    return [dx / L, dz / L];
  };
  for (const list of ends.values()) {
    if (list.length !== 2) continue;
    const [[ia, ea], [ib, eb]] = list;
    if (ia === ib) continue;
    const A = lines[ia], B = lines[ib];
    const da = dirAt(A, ea), db = dirAt(B, eb);
    // the neighbour's direction as seen travelling along this polyline through the joint:
    // joinEnd = where travel continues after the last point, joinStart = where it came from
    const neg = (d) => [-d[0], -d[1]];
    if (ea === 1) A.joinEnd = eb === 0 ? db : neg(db); else A.joinStart = eb === 1 ? db : neg(db);
    if (eb === 1) B.joinEnd = ea === 0 ? da : neg(da); else B.joinStart = ea === 1 ? da : neg(da);
  }
  const polys = [];
  for (const pg of polygons) {
    const T = pg.tris;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < T.length; k += 2) {
      x0 = Math.min(x0, T[k]); x1 = Math.max(x1, T[k]); z0 = Math.min(z0, T[k + 1]); z1 = Math.max(z1, T[k + 1]);
    }
    polys.push({ ...pg, tris: Float64Array.from(T), box: [x0, z0, x1, z1], group: groupOf(pg.cls) });
  }
  return { lines, polys };
}

// growable vertex / index buffers of one chunk (38 bytes per vertex)
class ChunkBuilder {
  constructor(ox, oz, baseY) {
    this.ox = ox; this.oz = oz; this.baseY = baseY;
    this.cap = 4096;
    this.alloc(this.cap);
    this.n = 0;
    this.icap = 8192;
    this.idx = new Uint32Array(this.icap);
    this.ni = 0;
    this.pieces = [];            // [prio, first index, index count]
    this.minY = Infinity; this.maxY = -Infinity;
  }
  alloc(cap, old) {
    const a = {
      pos: new Float32Array(cap * 3), uv: new Float32Array(cap * 2), jd: new Uint16Array(cap * 2),
      nrm: new Int8Array(cap * 2), info: new Uint8Array(cap * 4), sect: new Uint8Array(cap * 4), rad: new Uint8Array(cap * 2),
      dir: new Int8Array(cap * 2),
    };
    if (old) for (const k in a) a[k].set(old[k]);
    this.a = a;
  }
  grow(nv, ni) {
    if (this.n + nv > this.cap) {
      while (this.n + nv > this.cap) this.cap *= 2;
      this.alloc(this.cap, this.a);
    }
    if (this.ni + ni > this.icap) {
      while (this.ni + ni > this.icap) this.icap *= 2;
      const i = new Uint32Array(this.icap); i.set(this.idx); this.idx = i;
    }
  }
}

/**
 * Builds chunk (cx, cz) of a prepared tile, class group `group` (0 main roads, railways and
 * airfields; 1 residential, service and tracks). Returns null when the chunk has nothing.
 */
export function buildChunk(prepared, ground, cx, cz, group) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const X0 = cx * CHUNK_M, Z0 = cz * CHUNK_M, X1 = X0 + CHUNK_M, Z1 = Z0 + CHUNK_M;
  const ci0 = cx * CHUNK_CELLS, ci1 = ci0 + CHUNK_CELLS - 1, cj0 = cz * CHUNK_CELLS, cj1 = cj0 + CHUNK_CELLS - 1;
  // base height: middle of the chunk's height range (keeps float32 positions small)
  let hmin = Infinity, hmax = -Infinity;
  for (let j = cj0; j <= cj1 + 1; j += 8) for (let i = ci0; i <= ci1 + 1; i += 8) { const h = ground.H(i, j); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
  const c = new ChunkBuilder(X0 + CHUNK_M / 2, Z0 + CHUNK_M / 2, Math.round((hmin + hmax) / 2));
  const nrm = [0, 0];
  let pieces = 0, lines = 0;

  // one convex piece -> vertices and a triangle fan; fr: frame (P, t, r, uK), at: attributes,
  // nrmOv: a fixed normal (x, z) instead of the terrain's (lifted bridge decks)
  const emitPiece = (piece, heightOf, fr, at, nrmOv = null) => {
    const nv = piece.length >> 1;
    c.grow(nv, 3 * (nv - 2));
    const A = c.a, base = c.n, first = c.ni;
    for (let k = 0; k < nv; k++) {
      const x = piece[2 * k], z = piece[2 * k + 1];
      const y = heightOf(x, z);
      const dx = x - fr.px, dz = z - fr.pz;
      const u = fr.uK + dx * fr.tx + dz * fr.tz;
      const v = dx * fr.rx + dz * fr.rz;
      const q = c.n;
      // the direction this vertex moves per metre of v when the shader widens a thin ribbon:
      // the mitre at either end, blended along the segment (fraction tau between the two mitre
      // lines), so pieces on both sides of a joint move alike; none on aprons
      let mx = 0, mz = 0;
      if (fr.mA) {
        const den = fr.len + (fr.aE - fr.aK) * v;
        const tau = den > 1e-6 ? Math.min(Math.max((u - fr.uK - fr.aK * v) / den, 0), 1) : 0;
        mx = fr.mA[0] + (fr.mB[0] - fr.mA[0]) * tau;
        mz = fr.mA[1] + (fr.mB[1] - fr.mA[1]) * tau;
      }
      A.dir[2 * q] = Math.round(mx * DIR_SCALE);
      A.dir[2 * q + 1] = Math.round(mz * DIR_SCALE);
      if (nrmOv) { nrm[0] = nrmOv[0]; nrm[1] = nrmOv[1]; } else {
        ground.normal(x, z, nrm);
        // A built road is level across: it keeps the terrain's slope along it but not the
        // natural ground's cross slope (it was cut and filled out of it), so its carriageway is
        // not shaded as the slope it crosses. Across = the mitre direction, the same on both
        // sides of a joint.
        const ml = at.levelX ? Math.hypot(mx, mz) : 0;
        if (ml > 1e-6) {
          const ax = mx / ml, az = mz / ml, d = nrm[0] * ax + nrm[1] * az;
          const nx = nrm[0] - d * ax, nz = nrm[1] - d * az;
          const ny = Math.sqrt(Math.max(1 - nrm[0] * nrm[0] - nrm[1] * nrm[1], 0.01));
          const L = Math.hypot(nx, ny, nz);
          nrm[0] = nx / L; nrm[1] = nz / L;
        }
      }
      A.pos[3 * q] = x - c.ox; A.pos[3 * q + 1] = y - c.baseY; A.pos[3 * q + 2] = z - c.oz;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      A.uv[2 * q] = u; A.uv[2 * q + 1] = v;
      // junctions / holds: distances along u (linear, so they interpolate exactly)
      A.jd[2 * q] = toHalf(u - at.jPrev); A.jd[2 * q + 1] = toHalf(at.jNext - u);
      A.nrm[2 * q] = Math.round(nrm[0] * 127); A.nrm[2 * q + 1] = Math.round(nrm[1] * 127);
      A.info[4 * q] = at.cls; A.info[4 * q + 1] = at.flags; A.info[4 * q + 2] = at.lanes; A.info[4 * q + 3] = at.prio;
      A.sect[4 * q] = at.cwDm; A.sect[4 * q + 1] = at.leftDm; A.sect[4 * q + 2] = at.rightDm; A.sect[4 * q + 3] = at.tone;
      A.rad[2 * q] = at.rPrev; A.rad[2 * q + 1] = at.rNext;
      c.n++;
    }
    // counter-clockwise seen from above (+Y): area2 > 0 in (x, z) is clockwise
    const flip = area2(piece) > 0;
    for (let k = 1; k < nv - 1; k++) {
      if (flip) { c.idx[c.ni++] = base; c.idx[c.ni++] = base + k + 1; c.idx[c.ni++] = base + k; }
      else { c.idx[c.ni++] = base; c.idx[c.ni++] = base + k; c.idx[c.ni++] = base + k + 1; }
    }
    c.pieces.push(at.prio, first, c.ni - first);
    pieces++;
  };
  // A ribbon polygon cut to the terrain's triangles. On a bridge deck (fr.deck: height d0 at the
  // frame's origin, slope ds along it) the surface is max(terrain, deck): each piece is split
  // where the two planes cross, the part under the deck line stays on the terrain, the rest is
  // lifted to the deck (exact, watertight: both parts meet on the crossing line).
  const emitPolygon = (poly, fr, at) => cutToTerrain(ground, poly, ci0, ci1, cj0, cj1, (piece, h) => {
    const D = fr.deck;
    if (!D) { emitPiece(piece, h, fr, at); return; }
    // deck plane y = A0 + Ax x + Az z against this piece's terrain plane: both parts are clipped
    // by the same line (identical crossing points), so they meet without a crack
    const x0 = piece[0], z0 = piece[1];
    const t0 = h(x0, z0), gx = h(x0 + 1, z0) - t0, gz = h(x0, z0 + 1) - t0;
    const deckH = (x, z) => D.A0 + D.Ax * x + D.Az * z;
    const a = D.Ax - gx, b = D.Az - gz, cc = deckH(x0, z0) - t0 - a * x0 - b * z0;
    const down = clipKeep(piece, -a, -b, -cc), up = clipKeep(piece, a, b, cc);
    if (down && Math.abs(area2(down)) > 1e-6) emitPiece(down, h, fr, at);
    if (up && Math.abs(area2(up)) > 1e-6) emitPiece(up, deckH, fr, D.at, D.nrm);
  });
  // a planar quad in 3D (bridge structures): corners [x, y, z] (tile-local x, z) in order around
  // it; (nx, ny, nz) the way it faces (the triangles are wound counter-clockwise seen from there).
  // Stored normal: (nx, nz); flag 128 on a structure marks a face looking down (the underside).
  const emitQuad = (q, nx, ny, nz, at, u0, u1) => {
    c.grow(4, 6);
    const A = c.a, base = c.n, first = c.ni;
    const yTop = Math.max(q[0][1], q[1][1], q[2][1], q[3][1]);
    for (let k = 0; k < 4; k++) {
      const [x, y, z] = q[k];
      const i = c.n;
      A.pos[3 * i] = x - c.ox; A.pos[3 * i + 1] = y - c.baseY; A.pos[3 * i + 2] = z - c.oz;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      A.uv[2 * i] = k === 0 || k === 3 ? u0 : u1; A.uv[2 * i + 1] = y - yTop;       // u along, v down from the top
      A.jd[2 * i] = A.jd[2 * i + 1] = toHalf(1e4);
      A.nrm[2 * i] = Math.round(nx * 127); A.nrm[2 * i + 1] = Math.round(nz * 127);
      A.info[4 * i] = at.cls; A.info[4 * i + 1] = at.flags; A.info[4 * i + 2] = 0; A.info[4 * i + 3] = at.prio;
      A.sect[4 * i] = at.cwDm; A.sect[4 * i + 1] = 0; A.sect[4 * i + 2] = 0; A.sect[4 * i + 3] = at.tone;
      A.rad[2 * i] = A.rad[2 * i + 1] = 0;
      A.dir[2 * i] = A.dir[2 * i + 1] = 0;
      c.n++;
    }
    // (q1 - q0) x (q2 - q0) points to the side the triangle is counter-clockwise from
    const ex = q[1][0] - q[0][0], ey = q[1][1] - q[0][1], ez = q[1][2] - q[0][2];
    const fx = q[2][0] - q[0][0], fy = q[2][1] - q[0][1], fz = q[2][2] - q[0][2];
    const dot = (ey * fz - ez * fy) * nx + (ez * fx - ex * fz) * ny + (ex * fy - ey * fx) * nz;
    if (dot >= 0) {
      c.idx[c.ni++] = base; c.idx[c.ni++] = base + 1; c.idx[c.ni++] = base + 2;
      c.idx[c.ni++] = base; c.idx[c.ni++] = base + 2; c.idx[c.ni++] = base + 3;
    } else {
      c.idx[c.ni++] = base; c.idx[c.ni++] = base + 2; c.idx[c.ni++] = base + 1;
      c.idx[c.ni++] = base; c.idx[c.ni++] = base + 3; c.idx[c.ni++] = base + 2;
    }
    c.pieces.push(at.prio, first, 6);
    pieces++;
  };
  // is a disc (x, z, radius r) clear of every road at ground level? (no pier on a road under a bridge)
  const clearOf = (x, z, r) => {
    for (const l of prepared.lines) {
      if (l.deck || (l.flags & FLAG.bridge) || (l.level | 0) > 0) continue;
      const b = l.box;
      if (x < b[0] - r || x > b[2] + r || z < b[1] - r || z > b[3] + r) continue;
      const P = l.pts, hw = l.cw / 2 + Math.max(l.left, l.right) + r;
      for (let k = 0; k + 3 < P.length; k += 2) {
        const ax = P[k], az = P[k + 1], dx = P[k + 2] - ax, dz = P[k + 3] - az;
        const L2 = dx * dx + dz * dz;
        const t = L2 > 0 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / L2, 0), 1) : 0;
        const ex = ax + dx * t - x, ez = az + dz * t - z;
        if (ex * ex + ez * ez < hw * hw) return false;
      }
    }
    return true;
  };
  const ctx = { emitPolygon, emitQuad, ground, clearOf, inChunk: (x, z) => x >= X0 && x < X1 && z >= Z0 && z < Z1 };

  for (const l of prepared.lines) {
    if (l.group !== group) continue;
    const b = l.box;
    if (b[2] < X0 || b[0] > X1 || b[3] < Z0 || b[1] > Z1) continue;
    lines++;
    buildPolyline(l, ctx);
  }
  for (const pg of prepared.polys) {
    if (pg.group !== group) continue;
    const b = pg.box;
    if (b[2] < X0 || b[0] > X1 || b[3] < Z0 || b[1] > Z1) continue;
    buildPolygon(pg, emitPolygon);
  }
  if (!c.ni) return null;

  // triangles in priority order (counting sort over the pieces), so soft edges blend over lower layers
  const counts = new Uint32Array(257);
  const P = c.pieces;
  for (let k = 0; k < P.length; k += 3) counts[P[k] + 1] += P[k + 2];
  for (let p = 1; p < 257; p++) counts[p] += counts[p - 1];
  const big = c.n > 65535;
  const idx = big ? new Uint32Array(c.ni) : new Uint16Array(c.ni);
  for (let k = 0; k < P.length; k += 3) {
    let o = counts[P[k]];
    for (let m = 0; m < P[k + 2]; m++) idx[o++] = c.idx[P[k + 1] + m];
    counts[P[k]] = o;
  }
  const A = c.a, n = c.n;
  return {
    cx, cz, group, n, ni: c.ni, ox: c.ox, oz: c.oz, baseY: c.baseY, minY: c.minY, maxY: c.maxY,
    pos: A.pos.slice(0, 3 * n), uv: A.uv.slice(0, 2 * n), jd: A.jd.slice(0, 2 * n), nrm: A.nrm.slice(0, 2 * n),
    info: A.info.slice(0, 4 * n), sect: A.sect.slice(0, 4 * n), rad: A.rad.slice(0, 2 * n), dir: A.dir.slice(0, 2 * n), idx,
    stats: { lines, pieces, triangles: c.ni / 3, ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0 },
  };
}

/** Transferable buffers of a built chunk (postMessage). */
export function chunkTransfer(ch) {
  return ch ? [ch.pos.buffer, ch.uv.buffer, ch.jd.buffer, ch.nrm.buffer, ch.info.buffer, ch.sect.buffer, ch.rad.buffer, ch.dir.buffer, ch.idx.buffer] : [];
}

const MITER_MIN = 0.32;    // 1 + cos(turn): below this (turns over ~133 deg) a bevel instead of a mitre
// aDir (int8, normalised): mitre directions, |m| = 1 / cos(turn / 2) <= 2.5, stored as m / 3
export const DIR_SCALE = 127 / 3;

function buildPolyline(pl, ctx) {
  const emitPolygon = ctx.emitPolygon;
  const P = pl.pts;
  const n = P.length >> 1;
  if (n < 2) return;
  const vL = -(pl.cw / 2 + pl.left), vR = pl.cw / 2 + pl.right;
  const h = hash32(Math.round(P[0] * 10), Math.round(P[1] * 10) ^ (pl.cls << 20));
  const at = {
    cls: pl.cls, flags: pl.flags, lanes: Math.min(255, pl.lanes | 0), prio: priority(pl.cls, pl.level | 0, pl.flags, h),
    cwDm: Math.min(255, Math.round(pl.cw * 10)), leftDm: Math.min(255, Math.round(pl.left * 10)),
    rightDm: Math.min(255, Math.round(pl.right * 10)), tone: (h >>> 8) & 255,
    jPrev: -1e4, rPrev: 0, jNext: 1e4, rNext: 0,
    // shaded level across (emitPiece): paved roads and railways; tracks follow the ground,
    // taxiways lie on flattened airfields
    levelX: pl.cls <= 8 || pl.cls === 10 || pl.cls === 11,
  };
  const deck = pl.deck && pl.deck.length === n ? pl.deck : null;
  // segment frames and arc lengths
  const tx = new Float64Array(n - 1), tz = new Float64Array(n - 1), len = new Float64Array(n - 1), uk = new Float64Array(n);
  uk[0] = pl.u0 || 0;
  for (let k = 0; k < n - 1; k++) {
    const dx = P[2 * k + 2] - P[2 * k], dz = P[2 * k + 3] - P[2 * k + 1];
    const L = Math.hypot(dx, dz) || 1e-9;
    tx[k] = dx / L; tz[k] = dz / L; len[k] = L;
    uk[k + 1] = uk[k] + L;
  }
  // junctions (roads) or holding positions (taxiways), u relative to the polyline start
  const marks = (pl.breaks || []).map(([u, r]) => [uk[0] + u, r]).sort((a, b) => a[0] - b[0]);
  const holds = pl.holds || null;
  // right normal of a direction (tx, tz) is (-tz, tx) (x east, z south: right of travel)
  const mit = (ax, az, bx, bz) => {
    const sx = -az - bz, sz = ax + bx;           // sum of the two right normals
    const d = sx * -bz + sz * bx;                // = 1 + cos(turn)
    if (d < MITER_MIN) return null;
    return [sx / d, sz / d];                     // |m| = 1 / cos(turn / 2)
  };
  const M = new Array(n);
  for (let k = 0; k < n; k++) {
    let m = null;
    if (k === 0) m = pl.joinStart ? mit(pl.joinStart[0], pl.joinStart[1], tx[0], tz[0]) : null;
    else if (k === n - 1) m = pl.joinEnd ? mit(tx[n - 2], tz[n - 2], pl.joinEnd[0], pl.joinEnd[1]) : null;
    else m = mit(tx[k - 1], tz[k - 1], tx[k], tz[k]);
    // ends without a join (or too sharp a turn): square to the segment (bevel at inner vertices)
    M[k] = m ? [m[0], m[1], false] : [0, 0, k > 0 && k < n - 1];
  }
  // bridge decks: does sub-piece s (STRUCT_STEP m at most) of segment k stand off the ground?
  const nSub = (k) => Math.max(1, Math.ceil(len[k] / STRUCT_STEP));
  const lifted = (k, s) => {
    if (k < 0 || k >= n - 1 || s < 0 || s >= nSub(k)) return false;
    const ns = nSub(k);
    for (const t of [s / ns, (s + 0.5) / ns, (s + 1) / ns]) {
      const x = P[2 * k] + (P[2 * k + 2] - P[2 * k]) * t, z = P[2 * k + 1] + (P[2 * k + 3] - P[2 * k + 1]) * t;
      if (deck[k] + (deck[k + 1] - deck[k]) * t - ctx.ground.heightAt(x, z) >= MIN_LIFT) return true;
    }
    return false;
  };
  for (let k = 0; k < n - 1; k++) {
    const px = P[2 * k], pz = P[2 * k + 1], qx = P[2 * k + 2], qz = P[2 * k + 3];
    const rx = -tz[k], rz = tx[k];
    let [ax, az] = M[k][0] || M[k][1] ? M[k] : [rx, rz];
    let [bx, bz] = M[k + 1][0] || M[k + 1][1] ? M[k + 1] : [rx, rz];
    // quad: left start, left end, right end, right start
    let quad = [px + ax * vL, pz + az * vL, qx + bx * vL, qz + bz * vL, qx + bx * vR, qz + bz * vR, px + ax * vR, pz + az * vR];
    if (!convex(quad)) {
      ax = rx; az = rz; bx = rx; bz = rz;
      quad = [px + ax * vL, pz + az * vL, qx + bx * vL, qz + bz * vL, qx + bx * vR, qz + bz * vR, px + ax * vR, pz + az * vR];
    }
    // the junction marks before and after this segment (by its middle)
    const um = uk[k] + len[k] / 2;
    at.jPrev = -1e4; at.rPrev = 0; at.jNext = 1e4; at.rNext = 0;
    for (const [u, r] of marks) {
      if (u <= um) { at.jPrev = u; at.rPrev = Math.min(255, Math.round(r * 4)); } else { at.jNext = u; at.rNext = Math.min(255, Math.round(r * 4)); break; }
    }
    if (holds) {
      // taxiway holding position nearest to this segment: jPrev = its u, rPrev = 1 (runway toward +u) or 2
      let best = 1e9;
      for (const [u, dir] of holds) {
        const d = Math.abs(uk[0] + u - um);
        if (d < best) { best = d; at.jPrev = uk[0] + u; at.rPrev = dir > 0 ? 1 : 2; }
      }
    }
    // frame; mA, mB: the offset directions at the two ends (the mitres), which the vertex shader
    // follows to widen a ribbon thinner than a pixel without opening its joints
    const fr = {
      px, pz, tx: tx[k], tz: tz[k], rx, rz, uK: uk[k], len: len[k],
      mA: [ax, az], mB: [bx, bz], aK: ax * tx[k] + az * tz[k], aE: bx * tx[k] + bz * tz[k], deck: null,
    };
    let dat = null, dn = null;
    if (!deck) emitPolygon(quad, fr, at);
    else {
      // the deck as two triangles with exact corner heights (start corners at the deck height of
      // point k, end corners at point k + 1): neighbouring segments share the mitre edge at one
      // height, so the deck is watertight through any turn
      const d0 = deck[k], d1 = deck[k + 1], ds = (d1 - d0) / len[k], sq = Math.sqrt(1 + ds * ds);
      dn = [-ds * tx[k] / sq, -ds * tz[k] / sq];
      dat = { ...at, flags: at.flags | FLAG.lifted };
      deckTri(quad, 0, 1, 2, d0, d1, d1, fr, at, dat, dn, emitPolygon);
      deckTri(quad, 0, 2, 3, d0, d1, d0, fr, at, dat, dn, emitPolygon);
      deckStructure(ctx, P, k, uk, len, deck, pl.deckDepth || DECK_DEPTH, ax, az, bx, bz, vL, vR, at, nSub, lifted);
    }
    // bevel joint: fill the wedge on the outside of a sharp turn
    if (k < n - 2 && M[k + 1][2]) {
      const cross = tx[k] * tz[k + 1] - tz[k] * tx[k + 1];   // > 0: turning right (clockwise seen from above)
      const vo = cross > 0 ? vL : vR;
      const r2x = -tz[k + 1], r2z = tx[k + 1];
      const wedge = [qx, qz, qx + rx * vo, qz + rz * vo, qx + r2x * vo, qz + r2z * vo];
      const wfr = { px: qx, pz: qz, tx: tx[k], tz: tz[k], rx, rz, uK: uk[k + 1], len: 1, mA: [rx, rz], mB: [rx, rz], aK: 0, aE: 0, deck: null };
      if (deck) wfr.deck = { A0: deck[k + 1], Ax: 0, Az: 0, nrm: dn, at: dat };
      if (Math.abs(area2(wedge)) > 1e-4) emitPolygon(wedge, wfr, at);
    }
  }
}

/** One triangle of a deck quad (corners i0, i1, i2 at heights y0, y1, y2): its plane, then emitPolygon. */
function deckTri(q, i0, i1, i2, y0, y1, y2, fr, at, dat, nrm, emitPolygon) {
  const x0 = q[2 * i0], z0 = q[2 * i0 + 1], x1 = q[2 * i1], z1 = q[2 * i1 + 1], x2 = q[2 * i2], z2 = q[2 * i2 + 1];
  const e1x = x1 - x0, e1z = z1 - z0, e2x = x2 - x0, e2z = z2 - z0;
  const det = e1x * e2z - e1z * e2x;
  if (Math.abs(det) < 1e-6) return;
  const dy1 = y1 - y0, dy2 = y2 - y0;
  const Ax = (dy1 * e2z - dy2 * e1z) / det, Az = (e1x * dy2 - e2x * dy1) / det;
  emitPolygon([x0, z0, x1, z1, x2, z2], { ...fr, deck: { A0: y0 - Ax * x0 - Az * z0, Ax, Az, nrm, at: dat } }, at);
}

/**
 * The structure of a lifted bridge deck along segment k: the slab's sides with the parapets on
 * them (fascia), the parapets' inner faces and caps, the slab's underside, end faces where the
 * deck comes down to the ground, and piers every PIER_STEP m of u (fewer and wider as the deck
 * gets higher; none on another road). Built in sub-pieces of at most STRUCT_STEP m, each by the
 * chunk that holds its middle (so exactly once); lifted(k, s): sub-piece s of segment k is off
 * the ground.
 */
function deckStructure(ctx, P, k, uk, len, deck, depth, ax, az, bx, bz, vL, vR, at, nSub, lifted) {
  const G = ctx.ground, emitQuad = ctx.emitQuad;
  const px = P[2 * k], pz = P[2 * k + 1], qx = P[2 * k + 2], qz = P[2 * k + 3];
  const tx = (qx - px) / len[k], tz = (qz - pz) / len[k], rx = -tz, rz = tx;
  const d0 = deck[k], d1 = deck[k + 1], ns = nSub(k);
  const sat = { cls: CLASS.structure, flags: 0, prio: 0, cwDm: at.cwDm, tone: at.tone };
  const down = { ...sat, flags: FLAG.lifted };
  // a point of the edge line at offset v, fraction t along the segment (mitred ends)
  const E = (t, v) => [px + (qx - px) * t + (ax + (bx - ax) * t) * v, pz + (qz - pz) * t + (az + (bz - az) * t) * v];
  for (let s = 0; s < ns; s++) {
    const t0 = s / ns, t1 = (s + 1) / ns;
    if (!ctx.inChunk(px + (qx - px) * (t0 + t1) / 2, pz + (qz - pz) * (t0 + t1) / 2)) continue;
    if (!lifted(k, s)) continue;
    const h0 = d0 + (d1 - d0) * t0, h1 = d0 + (d1 - d0) * t1;
    const u0 = uk[k] + len[k] * t0, u1 = uk[k] + len[k] * t1;
    // vertical faces along the deck: offset v, bottom and top relative to the deck, outward side
    const wall = (v, lo, hi, side) => {
      const A = E(t0, v), B = E(t1, v);
      emitQuad([[A[0], h0 + lo, A[1]], [B[0], h1 + lo, B[1]], [B[0], h1 + hi, B[1]], [A[0], h0 + hi, A[1]]], side * rx, 0, side * rz, sat, u0, u1);
    };
    wall(vR, -depth, PARAPET_H, 1);
    wall(vL, -depth, PARAPET_H, -1);
    wall(vR - PARAPET_W, 0, PARAPET_H, -1);
    wall(vL + PARAPET_W, 0, PARAPET_H, 1);
    // horizontal faces: the parapets' caps (up), the slab's underside (down)
    const flat = (va, vb, dy, up) => {
      const A = E(t0, va), B = E(t1, va), C = E(t1, vb), D = E(t0, vb);
      emitQuad([[A[0], h0 + dy, A[1]], [B[0], h1 + dy, B[1]], [C[0], h1 + dy, C[1]], [D[0], h0 + dy, D[1]]], 0, up ? 1 : -1, 0, up ? sat : down, u0, u1);
    };
    flat(vR - PARAPET_W, vR, PARAPET_H, true);
    flat(vL, vL + PARAPET_W, PARAPET_H, true);
    flat(vL, vR, -depth, false);
    // end faces where the deck comes down to the ground (the neighbouring sub-piece is not lifted)
    const prev = s > 0 ? lifted(k, s - 1) : lifted(k - 1, k > 0 ? nSub(k - 1) - 1 : 0);
    const next = s < ns - 1 ? lifted(k, s + 1) : lifted(k + 1, 0);
    for (const [t, hh, side, open] of [[t0, h0, -1, !prev], [t1, h1, 1, !next]]) {
      if (!open) continue;
      const cap = (va, vb, lo, hi) => {
        const A = E(t, va), B = E(t, vb);
        emitQuad([[A[0], hh + lo, A[1]], [B[0], hh + lo, B[1]], [B[0], hh + hi, B[1]], [A[0], hh + hi, A[1]]], side * tx, 0, side * tz, sat, va, vb);
      };
      cap(vL, vR, -depth, 0);
      cap(vL, vL + PARAPET_W, 0, PARAPET_H);
      cap(vR - PARAPET_W, vR, 0, PARAPET_H);
    }
  }
  // piers: square columns under the slab, one or two across the deck
  const W = vR - vL, vc = (vL + vR) / 2;
  for (let m = Math.ceil(uk[k] / PIER_STEP - 0.5); (m + 0.5) * PIER_STEP < uk[k + 1]; m++) {
    const t = ((m + 0.5) * PIER_STEP - uk[k]) / len[k];
    if (t < 0) continue;
    const cx = px + (qx - px) * t, cz = pz + (qz - pz) * t;
    if (!ctx.inChunk(cx, cz)) continue;
    const top = d0 + (d1 - d0) * t - depth;
    const tall = top - G.heightAt(cx, cz);
    // spans of 40 m on low decks, 80 m over 20 m and 120 m over 45 m, with wider piers (as viaducts)
    const every = tall > 45 ? 3 : tall > 20 ? 2 : 1;
    if (tall < 1.0 || ((m % every) + every) % every) continue;
    const pw = Math.min(5, PIER_W + 0.035 * tall), hw = pw / 2;
    for (const vo of W > 14 ? [vc - (W / 2 - 3), vc + (W / 2 - 3)] : [vc]) {
      const ox = cx + rx * vo, oz = cz + rz * vo;
      if (!ctx.clearOf(ox, oz, hw + 1)) continue;
      let bot = Infinity;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) bot = Math.min(bot, G.heightAt(ox + (tx * a + rx * b) * hw, oz + (tz * a + rz * b) * hw));
      bot -= 0.5;
      if (top - bot < 1.0) continue;
      // four faces with outward normals +-t, +-r (emitQuad orients the corners)
      for (const [nx, nz] of [[tx, tz], [-tx, -tz], [rx, rz], [-rx, -rz]]) {
        const fx = ox + nx * hw, fz = oz + nz * hw, sx = nz * hw, sz = -nx * hw;
        emitQuad([[fx - sx, bot, fz - sz], [fx + sx, bot, fz + sz], [fx + sx, top, fz + sz], [fx - sx, top, fz - sz]], nx, 0, nz, sat, 0, pw);
      }
    }
  }
}

function convex(q) {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = q[(2 * k + 2) % 8] - q[2 * k], az = q[(2 * k + 3) % 8] - q[2 * k + 1];
    const bx = q[(2 * k + 4) % 8] - q[(2 * k + 2) % 8], bz = q[(2 * k + 5) % 8] - q[(2 * k + 3) % 8];
    const cr = ax * bz - az * bx;
    if (Math.abs(cr) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
  }
  return sign !== 0;
}

function buildPolygon(pg, emitPolygon) {
  const T = pg.tris;
  const ux = pg.axis ? pg.axis[0] : 1, uz = pg.axis ? pg.axis[1] : 0;
  const h = hash32(Math.round(T[0] * 10), Math.round(T[1] * 10));
  const at = {
    cls: pg.cls, flags: pg.flags || 0, lanes: 0, prio: priority(pg.cls, 0, 0, h), cwDm: 0, leftDm: 0, rightDm: 0,
    tone: (h >>> 8) & 255, jPrev: -1e4, rPrev: 0, jNext: 1e4, rNext: 0,
  };
  // slab joints follow the apron's axis: u along it, v across, from the tile corner (continuous grid)
  const fr = { px: 0, pz: 0, tx: ux, tz: uz, rx: -uz, rz: ux, uK: 0 };
  for (let k = 0; k + 5 < T.length; k += 6) emitPolygon([T[k], T[k + 1], T[k + 2], T[k + 3], T[k + 4], T[k + 5]], fr, at);
}

// ------------------------------------------------------------------------------------------
// traffic lanes (js/world/Traffic.js): the centre lines of the roads with cars (classes 0-6), with the
// height of the surface the ribbons are draped on (the terrain, or a bridge deck where it stands
// higher) at most LANE_STEP m apart and the cross slope there, and each polyline's end points as
// keys on the tiles' 0.1 m grid. Tile corners are multiples of 0.1 m and roads.py cuts polylines
// exactly on the tile lines, so the pieces of a road meet on the same key across segment, piece
// and tile ends: that is how cars carry on from one polyline to the next.

const LANE_STEP = 20;
const KEY_B = 1048576;                        // 2^20: decimetre coordinates (|x| < 102.4 km) made positive

/** Key of a world point given in decimetres (integers). */
export const laneKey = (xd, zd) => (xd + KEY_B) * 2 * KEY_B + (zd + KEY_B);

/**
 * The traffic lanes of a parsed tile: {first, count (Uint32 per polyline), info (Uint8 x 4: class,
 * flags, lanes, level), cw (carriageway width, m), keys (Float64 x 2: start, end), pts (Float32 x 4
 * per point: tile-local x, z, surface height, cross slope dh/dm to the right of the polyline)}, or
 * null when the tile has none of those roads.
 */
export function trafficLanes(road, ground, ix, iz) {
  if (!road) return null;
  const P = road.points;
  const sel = [];
  let np = 0;
  for (const pl of road.polylines) {
    if (pl.cls > 6 || pl.n < 2) continue;
    let m = 1;
    for (let k = 1; k < pl.n; k++) {
      const a = (pl.first + k - 1) * 2, b = a + 2;
      m += Math.max(1, Math.ceil(Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1]) * 0.1 / LANE_STEP));
    }
    sel.push([pl, m]);
    np += m;
  }
  if (!sel.length) return null;
  const nl = sel.length;
  const first = new Uint32Array(nl), count = new Uint32Array(nl), info = new Uint8Array(nl * 4);
  const cw = new Float32Array(nl), keys = new Float64Array(nl * 2), pts = new Float32Array(np * 4);
  const X0 = Math.round((-CORE_HALF + ix * TILE_M) * 10), Z0 = Math.round((-CORE_HALF + iz * TILE_M) * 10);
  let o = 0;
  for (let li = 0; li < nl; li++) {
    const [pl, m] = sel[li];
    first[li] = o;
    count[li] = m;
    info[li * 4] = pl.cls; info[li * 4 + 1] = pl.flags; info[li * 4 + 2] = pl.lanes; info[li * 4 + 3] = pl.level & 255;
    cw[li] = pl.cw;
    const a = pl.first * 2, b = (pl.first + pl.n - 1) * 2;
    keys[li * 2] = laneKey(X0 + P[a], Z0 + P[a + 1]);
    keys[li * 2 + 1] = laneKey(X0 + P[b], Z0 + P[b + 1]);
    // the cross slope from the surface at +-e (the middle of the outer lanes)
    const e = Math.max(1, 0.3 * pl.cw), deck = pl.deck;
    const put = (x, z, tx, tz, hd) => {
      const rx = -tz, rz = tx;                 // right of the direction (x east, z south)
      let hC = ground.heightAt(x, z), hL = ground.heightAt(x - rx * e, z - rz * e), hR = ground.heightAt(x + rx * e, z + rz * e);
      if (hd !== null) { hC = Math.max(hC, hd); hL = Math.max(hL, hd); hR = Math.max(hR, hd); }
      pts[o * 4] = x; pts[o * 4 + 1] = z; pts[o * 4 + 2] = hC; pts[o * 4 + 3] = (hR - hL) / (2 * e);
      o++;
    };
    let tx = 1, tz = 0;
    for (let k = 0; k < pl.n - 1; k++) {
      const i = (pl.first + k) * 2;
      const x0 = P[i] * 0.1, z0 = P[i + 1] * 0.1, x1 = P[i + 2] * 0.1, z1 = P[i + 3] * 0.1;
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L > 1e-6) { tx = (x1 - x0) / L; tz = (z1 - z0) / L; }
      const ms = Math.max(1, Math.ceil(L / LANE_STEP));
      for (let s = 0; s < ms; s++) {
        const t = s / ms;
        put(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, tx, tz, deck ? deck[k] + (deck[k + 1] - deck[k]) * t : null);
      }
    }
    const i = (pl.first + pl.n - 1) * 2;
    put(P[i] * 0.1, P[i + 1] * 0.1, tx, tz, deck ? deck[pl.n - 1] : null);
  }
  return { first, count, info, cw, keys, pts };
}

/** The transferable buffers of a trafficLanes() result. */
export const lanesTransfer = (L) => (L ? [L.first.buffer, L.count.buffer, L.info.buffer, L.cw.buffer, L.keys.buffer, L.pts.buffer] : []);
