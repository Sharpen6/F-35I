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
};
export const FLAG = { oneway: 1, bridge: 2, urban: 4, unpaved: 8, solidCentre: 16, lit: 32, edgeMarks: 64 };
/** Group 1 (residential streets, service roads, tracks) is drawn over a shorter range than group 0. */
export const groupOf = (cls) => (cls >= 7 && cls <= 9 ? 1 : 0);

// Who is drawn on top where ribbons overlap (junctions, level crossings, overpasses): a higher
// layer wins; bridges and overpasses (level >= 1) go above everything at ground level.
const LAYER = [6, 5, 5, 4, 4, 3, 3, 2, 1, 1, 7, 7, 8, 0];
const BRIDGE_LAYERS = 9;
const REGION_BLOCK = 4;                       // cells (100 m): largest span of a merged planar region
export const PRIO_STEPS = 4;                  // hash steps per layer (same-class overlaps resolve consistently)

/** Parses a road tile (ROADS.md); returns {polylines, points, breaks}. */
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
    };
  }
  return { polylines, points, breaks };
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

// growable vertex / index buffers of one chunk (36 bytes per vertex)
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

  // one convex piece -> vertices and a triangle fan; fr: frame (P, t, r, uK), at: attributes
  const emitPiece = (piece, heightOf, fr, at) => {
    const nv = piece.length >> 1;
    c.grow(nv, 3 * (nv - 2));
    const A = c.a, base = c.n, first = c.ni;
    for (let k = 0; k < nv; k++) {
      const x = piece[2 * k], z = piece[2 * k + 1];
      const y = heightOf(x, z);
      const dx = x - fr.px, dz = z - fr.pz;
      const u = fr.uK + dx * fr.tx + dz * fr.tz;
      const v = dx * fr.rx + dz * fr.rz;
      ground.normal(x, z, nrm);
      const q = c.n;
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
  const emitPolygon = (poly, fr, at) => cutToTerrain(ground, poly, ci0, ci1, cj0, cj1, (piece, h) => emitPiece(piece, h, fr, at));

  for (const l of prepared.lines) {
    if (l.group !== group) continue;
    const b = l.box;
    if (b[2] < X0 || b[0] > X1 || b[3] < Z0 || b[1] > Z1) continue;
    lines++;
    buildPolyline(l, emitPolygon);
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
    info: A.info.slice(0, 4 * n), sect: A.sect.slice(0, 4 * n), rad: A.rad.slice(0, 2 * n), idx,
    stats: { lines, pieces, triangles: c.ni / 3, ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0 },
  };
}

/** Transferable buffers of a built chunk (postMessage). */
export function chunkTransfer(ch) {
  return ch ? [ch.pos.buffer, ch.uv.buffer, ch.jd.buffer, ch.nrm.buffer, ch.info.buffer, ch.sect.buffer, ch.rad.buffer, ch.idx.buffer] : [];
}

const MITER_MIN = 0.32;    // 1 + cos(turn): below this (turns over ~105 deg) a bevel instead of a mitre

function buildPolyline(pl, emitPolygon) {
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
  };
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
    const fr = { px, pz, tx: tx[k], tz: tz[k], rx, rz, uK: uk[k] };
    emitPolygon(quad, fr, at);
    // bevel joint: fill the wedge on the outside of a sharp turn
    if (k < n - 2 && M[k + 1][2]) {
      const cross = tx[k] * tz[k + 1] - tz[k] * tx[k + 1];   // > 0: turning right (clockwise seen from above)
      const vo = cross > 0 ? vL : vR;
      const r2x = -tz[k + 1], r2z = tx[k + 1];
      const wedge = [qx, qz, qx + rx * vo, qz + rz * vo, qx + r2x * vo, qz + r2z * vo];
      if (Math.abs(area2(wedge)) > 1e-4) emitPolygon(wedge, { px: qx, pz: qz, tx: tx[k], tz: tz[k], rx, rz, uK: uk[k + 1] }, at);
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
