// Obstacles for the placement: what the other world layers put on the ground, so that no tree
// stands in a traffic lane or grows through a roof. Pure JS (the placement worker and the node
// tests; no DOM, no three.js).
//
//   roads      data/world/roads/tile_X_Z.bin (RDS1, sim/tools/world/ROADS.md): every road, track
//              and railway polyline with its carriageway width and margins (shoulders,
//              sidewalks). Bridges: with the optional deck section (DCK1: the deck's height at
//              every point) a tree may stand under a deck it fits under; without it the deck is
//              drawn on the ground (the first roads runtime), so it counts as a road.
//   airfields  data/world/airfields/airfields.json: taxiways (polylines, tile-local metres) and
//              aprons (triangles)
//   buildings  data/world/buildings/tile_X_Z.bin (F35B, gzip, sim/tools/world/README.md): the
//              footprints (outer rings with their courtyards) and heights
//
// The data belongs to the roads and buildings tracks; this file only reads it. A tile's index
// holds its own obstacles and its neighbours' within PAD m of its edges (roads are cut at the
// tile edges and a building belongs to the tile of its centre, so a carriageway or a house can
// reach over the edge). blocked(x, z, crownR, height, groundY) answers per tree.
//
// Clearances beyond the paved width (half the carriageway plus its wider margin), as a fixed
// distance plus a share of the crown radius: a motorway, a trunk road or a railway keeps its
// verge clear (no crown over the lanes), a town street lets the crowns of its trees hang over the
// sidewalk, a dirt track runs right past the trees of an orchard.

export const PAD = 64;                 // m of the neighbours' obstacles kept around a tile
const TILE_M = 6400;
const CORE_HALF = 51200;
const BK = 32;                         // bucket size (m) of the spatial index
const NB = Math.ceil((TILE_M + 2 * PAD) / BK);
const CROWN_MAX = 12;                  // m: the largest crown radius a query considers
const SEG_REACH = 4 + CROWN_MAX;       // m beyond the paved half width a segment can block
const BLD_MARGIN = 0.8;                // m between a trunk and a wall (plus half the crown radius)
const BLD_CROWN = 0.5;
const APRON_MARGIN = 6;                // m from an apron's edge (plus the crown)

/** Road classes (ROADS.md): [fixed clearance m, share of the crown radius]. */
export const ROAD_CLEAR = [
  [3.0, 0.9],    // 0 motorway
  [2.0, 0.8],    // 1 motorway link
  [2.5, 0.85],   // 2 trunk
  [1.8, 0.7],    // 3 trunk / primary / secondary / tertiary link
  [1.5, 0.7],    // 4 primary
  [1.2, 0.6],    // 5 secondary
  [1.0, 0.5],    // 6 tertiary
  [0.6, 0.25],   // 7 residential, living street, unclassified
  [0.5, 0.2],    // 8 service
  [0.3, 0.0],    // 9 track
  [3.0, 0.9],    // 10 railway (the catenary and the sight lines are kept clear)
  [1.0, 0.5],    // 11 light rail, tram
  [10.0, 1.0],   // 12 taxiway (with its graded strip)
  [6.0, 1.0],    // 13 apron (not a segment; see APRON_MARGIN)
];

const tileOrigin = (ix, iz) => [-CORE_HALF + TILE_M * ix, -CORE_HALF + TILE_M * iz];

// ------------------------------------------------------------------------------------------
// parsing (one tile's sources, world metres)

/**
 * Roads of one RDS1 tile: {ax, az, bx, bz, hw, cls, deck (deck bottom at a, b; NaN: on the
 * ground)} per segment. Returns null when the bytes are not an RDS1 tile.
 */
export function parseRoads(buf, ix, iz) {
  if (!buf || buf.byteLength < 16) return null;
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'RDS1') return null;
  const n = dv.getUint32(4, true), npt = dv.getUint32(8, true), nbr = dv.getUint32(12, true);
  const ptsOff = 16 + 24 * n, brOff = ptsOff + 4 * npt, end = brOff + 8 * nbr;
  if (end > buf.byteLength) return null;
  const [x0, z0] = tileOrigin(ix, iz);
  // bridge decks (optional section after the breaks): per deck record, its depth and the deck's
  // height at every point of the polyline
  const decks = new Map();
  if (end + 8 <= buf.byteLength && dv.getUint32(end, true) === 0x314b4344) {      // 'DCK1'
    const nd = dv.getUint32(end + 4, true);
    let o = end + 8;
    for (let d = 0; d < nd && o + 8 <= buf.byteLength; d++) {
      const rec = dv.getUint32(o, true), depth = dv.getFloat32(o + 4, true);
      if (rec >= n) break;
      const m = dv.getUint16(16 + 24 * rec + 8, true);
      if (o + 8 + 4 * m > buf.byteLength) break;
      const h = new Float32Array(m);
      for (let k = 0; k < m; k++) h[k] = dv.getFloat32(o + 8 + 4 * k, true);
      decks.set(rec, { depth, h });
      o += 8 + 4 * m;
    }
  }
  let nseg = 0;
  for (let k = 0; k < n; k++) nseg += Math.max(0, dv.getUint16(16 + 24 * k + 8, true) - 1);
  const S = newSegs(nseg);
  let s = 0;
  for (let k = 0; k < n; k++) {
    const r = 16 + 24 * k;
    const cls = dv.getUint8(r), level = dv.getInt8(r + 3);
    const cw = dv.getUint16(r + 4, true) / 100, lm = dv.getUint8(r + 6) / 10, rm = dv.getUint8(r + 7) / 10;
    const m = dv.getUint16(r + 8, true), first = dv.getUint32(r + 12, true);
    if (first + m > npt) continue;
    const hw = cw / 2 + Math.max(lm, rm);
    const deck = level > 0 ? decks.get(k) : null;
    for (let i = 0; i + 1 < m; i++) {
      const p = ptsOff + 4 * (first + i);
      S.ax[s] = x0 + dv.getUint16(p, true) * 0.1;
      S.az[s] = z0 + dv.getUint16(p + 2, true) * 0.1;
      S.bx[s] = x0 + dv.getUint16(p + 4, true) * 0.1;
      S.bz[s] = z0 + dv.getUint16(p + 6, true) * 0.1;
      S.hw[s] = hw;
      S.cls[s] = Math.min(cls, 12);
      S.da[s] = deck ? deck.h[i] - deck.depth : NaN;
      S.db[s] = deck ? deck.h[i + 1] - deck.depth : NaN;
      s++;
    }
  }
  return trimSegs(S, s);
}

/** Taxiways (segments, class 12) and aprons (triangles) of one airfields.json tile entry. */
export function parseAirfield(entry, ix, iz) {
  if (!entry) return null;
  const [x0, z0] = tileOrigin(ix, iz);
  const tw = entry.taxiways || [];
  let nseg = 0;
  for (const t of tw) nseg += Math.max(0, ((t.pts && t.pts.length) || 0) / 2 - 1);
  const S = newSegs(nseg);
  let s = 0;
  for (const t of tw) {
    const p = t.pts || [];
    const hw = (+t.cw || 20) / 2 + Math.max(+t.left || 0, +t.right || 0);
    for (let i = 0; i + 3 < p.length; i += 2) {
      S.ax[s] = x0 + p[i]; S.az[s] = z0 + p[i + 1]; S.bx[s] = x0 + p[i + 2]; S.bz[s] = z0 + p[i + 3];
      S.hw[s] = hw; S.cls[s] = 12; S.da[s] = NaN; S.db[s] = NaN;
      s++;
    }
  }
  let ntri = 0;
  for (const a of entry.aprons || []) ntri += Math.floor(((a.tris && a.tris.length) || 0) / 6);
  const tris = new Float32Array(ntri * 6);
  let k = 0;
  for (const a of entry.aprons || []) {
    const t = a.tris || [];
    for (let i = 0; i + 5 < t.length; i += 6) {
      for (let j = 0; j < 6; j += 2) { tris[k++] = x0 + t[i + j]; tris[k++] = z0 + t[i + j + 1]; }
    }
  }
  return { segs: trimSegs(S, s), tris };
}

/**
 * Building footprints of one F35B tile (the decompressed bytes): per building its rings
 * (vertex ranges), bounding box and height. Returns null when the bytes are not a building tile
 * or their layout is not the one this reader knows.
 */
export function parseBuildings(buf) {
  if (!buf || buf.byteLength < 64) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x42353346) return null;          // 'F35B'
  const nch = dv.getUint8(10);
  const ox = dv.getFloat32(12, true), oz = dv.getFloat32(16, true), q = dv.getFloat32(20, true);
  const N = dv.getUint32(24, true), R = dv.getUint32(28, true), V = dv.getUint32(32, true);
  let o = dv.getUint16(6, true);
  const skip = (bytes) => { const at = o; o += bytes + ((4 - (bytes % 4)) % 4); return at; };
  skip(4 * (nch * nch + 1));                                        // chunk starts
  for (let i = 0; i < 5; i++) skip(2 * N);                          // cx, cz, oa, ob, yaw
  skip(2 * N);                                                      // base
  const topAt = skip(2 * N);
  skip(2 * N);                                                      // minh
  const ringAt = skip(2 * R);
  const vxAt = skip(2 * V), vzAt = skip(2 * V);
  for (let i = 0; i < 10; i++) skip(N);                             // sink .. floors
  const nrAt = skip(N);
  if (o > buf.byteLength) return null;
  const nrings = new Uint8Array(buf, nrAt, N);
  const ringN = new Uint16Array(buf.slice(ringAt, ringAt + 2 * R));
  // the layout's own check: the rings add up to R, their vertices to V
  let rs = 0, vs = 0;
  for (let i = 0; i < N; i++) rs += nrings[i];
  for (let i = 0; i < R; i++) vs += ringN[i];
  if (rs !== R || vs !== V) return null;
  const vx = new Uint16Array(buf.slice(vxAt, vxAt + 2 * V)), vz = new Uint16Array(buf.slice(vzAt, vzAt + 2 * V));
  const top = new Uint16Array(buf.slice(topAt, topAt + 2 * N));
  const px = new Float32Array(V), pz = new Float32Array(V);
  for (let k = 0; k < V; k++) { px[k] = ox + vx[k] * q; pz[k] = oz + vz[k] * q; }
  const ring0 = new Uint32Array(N + 1), vert0 = new Uint32Array(R + 1);
  for (let i = 0; i < N; i++) ring0[i + 1] = ring0[i] + nrings[i];
  for (let r = 0; r < R; r++) vert0[r + 1] = vert0[r] + ringN[r];
  const box = new Float32Array(4 * N), height = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const v0 = vert0[ring0[i]], v1 = vert0[ring0[i + 1]];
    for (let k = v0; k < v1; k++) {
      const x = px[k], z = pz[k];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    box[4 * i] = x0; box[4 * i + 1] = z0; box[4 * i + 2] = x1; box[4 * i + 3] = z1;
    height[i] = top[i] * 0.1;
  }
  return { N, px, pz, ring0, vert0, box, height };
}

function newSegs(n) {
  return {
    ax: new Float32Array(n), az: new Float32Array(n), bx: new Float32Array(n), bz: new Float32Array(n),
    hw: new Float32Array(n), cls: new Uint8Array(n), da: new Float32Array(n), db: new Float32Array(n), n,
  };
}

function trimSegs(S, n) {
  if (n === S.n) return S;
  const o = {};
  for (const k of ['ax', 'az', 'bx', 'bz', 'hw', 'cls', 'da', 'db']) o[k] = S[k].slice(0, n);
  o.n = n;
  return o;
}

// ------------------------------------------------------------------------------------------
// the index of one tile

/**
 * The obstacles of tile (ix, iz) from the sources of the tile and its neighbours:
 * sources = [{roads, airfield, buildings}] (any of them null). Returns an Obstacles object, or
 * null when there is no source at all.
 */
export function buildObstacles(ix, iz, sources) {
  const [x0, z0] = tileOrigin(ix, iz);
  const gx0 = x0 - PAD, gz0 = z0 - PAD, gx1 = x0 + TILE_M + PAD, gz1 = z0 + TILE_M + PAD;
  const segLists = [], triLists = [], bldLists = [];
  let any = false, hasRoads = false, hasBuildings = false;
  for (const s of sources) {
    if (!s) continue;
    if (s.roads) { segLists.push(s.roads); any = hasRoads = true; }
    if (s.airfield) { segLists.push(s.airfield.segs); triLists.push(s.airfield.tris); any = true; }
    if (s.buildings) { bldLists.push(s.buildings); any = hasBuildings = true; }
  }
  if (!any) return null;
  const bx = (x) => Math.floor((x - gx0) / BK), bz = (z) => Math.floor((z - gz0) / BK);
  const cl = (v) => (v < 0 ? 0 : v >= NB ? NB - 1 : v);
  /** add(bucket) for every bucket of the box [x0, x1] x [z0, z1] inside the grid. */
  const boxBuckets = (x0_, z0_, x1_, z1_, add, test) => {
    const a0 = bx(x0_), a1 = bx(x1_), b0 = bz(z0_), b1 = bz(z1_);
    if (a1 < 0 || b1 < 0 || a0 >= NB || b0 >= NB) return;
    for (let b = cl(b0), be = cl(b1); b <= be; b++) {
      for (let a = cl(a0), ae = cl(a1); a <= ae; a++) if (!test || test(gx0 + a * BK, gz0 + b * BK)) add(b * NB + a);
    }
  };

  // segments: those that reach the tile (with their clearance), bucketed by their padded box
  const keep = [];
  let nseg = 0;
  for (const S of segLists) {
    const idx = [];
    for (let i = 0; i < S.n; i++) {
      const r = S.hw[i] + SEG_REACH;
      const mx0 = Math.min(S.ax[i], S.bx[i]) - r, mx1 = Math.max(S.ax[i], S.bx[i]) + r;
      const mz0 = Math.min(S.az[i], S.bz[i]) - r, mz1 = Math.max(S.az[i], S.bz[i]) + r;
      if (mx1 < gx0 || mx0 > gx1 || mz1 < gz0 || mz0 > gz1) continue;
      idx.push(i);
    }
    keep.push(idx);
    nseg += idx.length;
  }
  const seg = newSegs(nseg);
  let s = 0;
  segLists.forEach((S, j) => {
    for (const i of keep[j]) {
      seg.ax[s] = S.ax[i]; seg.az[s] = S.az[i]; seg.bx[s] = S.bx[i]; seg.bz[s] = S.bz[i];
      seg.hw[s] = S.hw[i]; seg.cls[s] = S.cls[i]; seg.da[s] = S.da[i]; seg.db[s] = S.db[i];
      s++;
    }
  });
  const segIdx = csr(nseg, (i, add) => {
    const r = seg.hw[i] + SEG_REACH;
    // a long diagonal segment: only the buckets its padded line actually passes
    boxBuckets(Math.min(seg.ax[i], seg.bx[i]) - r, Math.min(seg.az[i], seg.bz[i]) - r,
      Math.max(seg.ax[i], seg.bx[i]) + r, Math.max(seg.az[i], seg.bz[i]) + r, add,
      (x, z) => segBucketDist(seg, i, x, z) <= r);
  });

  // apron triangles
  let ntri = 0;
  for (const T of triLists) ntri += T.length / 6;
  const tri = new Float32Array(ntri * 6);
  let t = 0;
  for (const T of triLists) { tri.set(T, t); t += T.length; }
  const triIdx = csr(ntri, (i, add) => {
    const r = APRON_MARGIN + CROWN_MAX;
    let x0_ = Infinity, z0_ = Infinity, x1_ = -Infinity, z1_ = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = tri[i * 6 + 2 * k], z = tri[i * 6 + 2 * k + 1];
      x0_ = Math.min(x0_, x); x1_ = Math.max(x1_, x); z0_ = Math.min(z0_, z); z1_ = Math.max(z1_, z);
    }
    boxBuckets(x0_ - r, z0_ - r, x1_ + r, z1_ + r, add);
  });

  // buildings: [source, building] pairs bucketed by their padded boxes
  const bRef = [];
  bldLists.forEach((B, j) => {
    for (let i = 0; i < B.N; i++) {
      const r = BLD_MARGIN + BLD_CROWN * CROWN_MAX;
      if (B.box[4 * i + 2] + r < gx0 || B.box[4 * i] - r > gx1 || B.box[4 * i + 3] + r < gz0 || B.box[4 * i + 1] - r > gz1) continue;
      bRef.push(j, i);
    }
  });
  const nb = bRef.length / 2;
  const bldIdx = csr(nb, (k, add) => {
    const B = bldLists[bRef[2 * k]], i = bRef[2 * k + 1];
    const r = BLD_MARGIN + BLD_CROWN * CROWN_MAX;
    boxBuckets(B.box[4 * i] - r, B.box[4 * i + 1] - r, B.box[4 * i + 2] + r, B.box[4 * i + 3] + r, add);
  });
  return new Obstacles({ gx0, gz0, seg, segIdx, tri, triIdx, bldLists, bRef, bldIdx, hasRoads, hasBuildings });
}

/** Compressed lists per bucket: fill(i, add) calls add(bucket) for every bucket of item i. */
function csr(n, fill) {
  const count = new Uint32Array(NB * NB + 1);
  for (let i = 0; i < n; i++) fill(i, (b) => { count[b + 1]++; });
  for (let b = 0; b < NB * NB; b++) count[b + 1] += count[b];
  const list = new Uint32Array(count[NB * NB]);
  const at = count.slice(0, NB * NB);
  for (let i = 0; i < n; i++) fill(i, (b) => { list[at[b]++] = i; });
  return { start: count, list };
}

/** Distance from a bucket (its corner x, z; BK square) to segment i. */
function segBucketDist(S, i, bx, bz) {
  const cx = bx + BK / 2, cz = bz + BK / 2;
  const d = segDist(S.ax[i], S.az[i], S.bx[i], S.bz[i], cx, cz).d;
  return Math.max(0, d - BK * Math.SQRT1_2);
}

const _q = { d: 0, t: 0 };
/** Distance from (x, z) to the segment a-b, and the position along it (0..1). */
function segDist(ax, az, bx, bz, x, z) {
  const ux = bx - ax, uz = bz - az;
  const l2 = ux * ux + uz * uz;
  let t = l2 > 1e-9 ? ((x - ax) * ux + (z - az) * uz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + ux * t - x, dz = az + uz * t - z;
  _q.d = Math.sqrt(dx * dx + dz * dz);
  _q.t = t;
  return _q;
}

export class Obstacles {
  constructor(o) {
    Object.assign(this, o);
    this.stats = { roads: 0, aprons: 0, buildings: 0, underDeck: 0 };
  }

  /**
   * Does something stand where a tree of crown radius crownR (m) and height (m) would grow at
   * world x, z (ground at groundY)? Counts what stopped it (stats).
   */
  blocked(x, z, crownR, height, groundY) {
    const a = Math.floor((x - this.gx0) / BK), b = Math.floor((z - this.gz0) / BK);
    if (a < 0 || b < 0 || a >= NB || b >= NB) return false;
    const bi = b * NB + a;
    const cr = crownR < CROWN_MAX ? crownR : CROWN_MAX;
    // roads, railways, taxiways
    const S = this.seg, I = this.segIdx;
    for (let k = I.start[bi], e = I.start[bi + 1]; k < e; k++) {
      const i = I.list[k];
      const c = ROAD_CLEAR[S.cls[i]];
      const lim = S.hw[i] + c[0] + c[1] * cr;
      // quick box test before the distance
      const mx = S.ax[i] < S.bx[i] ? S.ax[i] : S.bx[i], Mx = S.ax[i] < S.bx[i] ? S.bx[i] : S.ax[i];
      if (x < mx - lim || x > Mx + lim) continue;
      const mz = S.az[i] < S.bz[i] ? S.az[i] : S.bz[i], Mz = S.az[i] < S.bz[i] ? S.bz[i] : S.az[i];
      if (z < mz - lim || z > Mz + lim) continue;
      const q = segDist(S.ax[i], S.az[i], S.bx[i], S.bz[i], x, z);
      if (q.d >= lim) continue;
      // under a bridge deck: fine if the tree fits below it
      const da = S.da[i];
      if (da === da) {
        const deck = da + (S.db[i] - da) * q.t;
        if (groundY + height + 1.0 < deck) { this.stats.underDeck++; continue; }
      }
      this.stats.roads++;
      return true;
    }
    // aprons
    const T = this.tri, J = this.triIdx;
    for (let k = J.start[bi], e = J.start[bi + 1]; k < e; k++) {
      const i = J.list[k] * 6;
      if (triDist(T[i], T[i + 1], T[i + 2], T[i + 3], T[i + 4], T[i + 5], x, z) < APRON_MARGIN + cr) { this.stats.aprons++; return true; }
    }
    // buildings: inside the footprint, or too close to a wall
    const L = this.bldIdx, R = this.bRef;
    const lim = BLD_MARGIN + BLD_CROWN * cr;
    for (let k = L.start[bi], e = L.start[bi + 1]; k < e; k++) {
      const r = L.list[k];
      const B = this.bldLists[R[2 * r]], i = R[2 * r + 1];
      const bx = B.box;
      if (x < bx[4 * i] - lim || x > bx[4 * i + 2] + lim || z < bx[4 * i + 1] - lim || z > bx[4 * i + 3] + lim) continue;
      if (footprintDist(B, i, x, z) < lim) { this.stats.buildings++; return true; }
    }
    return false;
  }
}

/**
 * Signed distance from (x, z) to the footprint of building i (even-odd over its rings, so a
 * courtyard is outside): negative inside.
 */
function footprintDist(B, i, x, z) {
  let inside = false, d2 = Infinity;
  const px = B.px, pz = B.pz;
  for (let r = B.ring0[i]; r < B.ring0[i + 1]; r++) {
    const v0 = B.vert0[r], v1 = B.vert0[r + 1];
    for (let k = v0, j = v1 - 1; k < v1; j = k++) {
      const xi = px[k], zi = pz[k], xj = px[j], zj = pz[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
      const ux = xj - xi, uz = zj - zi, l2 = ux * ux + uz * uz;
      let t = l2 > 1e-9 ? ((x - xi) * ux + (z - zi) * uz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = xi + ux * t - x, dz = zi + uz * t - z;
      const e = dx * dx + dz * dz;
      if (e < d2) d2 = e;
    }
  }
  const d = Math.sqrt(d2);
  return inside ? -d : d;
}

/** Distance from (x, z) to a triangle (0 inside). */
function triDist(ax, az, bx, bz, cx, cz, x, z) {
  const s1 = (bx - ax) * (z - az) - (bz - az) * (x - ax);
  const s2 = (cx - bx) * (z - bz) - (cz - bz) * (x - bx);
  const s3 = (ax - cx) * (z - cz) - (az - cz) * (x - cx);
  if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return 0;
  return Math.min(segDist(ax, az, bx, bz, x, z).d, segDist(bx, bz, cx, cz, x, z).d, segDist(cx, cz, ax, az, x, z).d);
}
