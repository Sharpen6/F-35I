// Web Worker of js/world/Buildings.js: reads the building tiles of data/world/buildings/ and
// builds their geometry off the main thread. Self-contained (workers do not see the page's
// import map). Messages (all replies carry the request's `id`):
//
//   {type: 'tile', id, key, url}         fetch + parse one tile (sim/tools/world/README.md),
//                                         reply {boxes: {a, b, c, wall, roof, info, vsize, count},
//                                         shadows: {dA, dB, count}, lights: {pos, kind, count},
//                                         chunks: [{n, lo, hi, tall}], info}
//   {type: 'chunk', id, key, chunk, opts} full-detail geometry of one 800 m chunk:
//                                         reply {geo: {position, normal, facade, color, info, index,
//                                         center, sphere, vertices, triangles}}
//   {type: 'roofs', id, key, chunk, opts} the roof items of one chunk (Rooftops.js): solar water
//                                         heaters, water tanks, air conditioners, chillers; reply
//                                         {items: {a, b, c, count, center, sphere}}
//   {type: 'drop', key}                   forget a parsed tile
//
// Frames: tile-local metres are world X / Z minus the tile's north-west corner (x0, z0); chunk
// geometry is relative to the chunk's centre (Y stays metres above sea level).

const MAGIC = 0x42353346;          // 'F35B' little-endian
const TILE = 6400;
const tiles = new Map();

// wall styles and roof styles (sim/tools/world/buildings.py, buildingShaders.js)
const W = { plaster: 0, stone: 1, glass: 2, office: 3, industrial: 4, house: 5, greenhouse: 6, concrete: 7, public: 8, tower: 9, oldstone: 10, stack: 11, hangar: 12, frame: 13 };
const R = { flat_res: 0, flat: 1, industrial: 2, tiles: 3, metal: 4, greenhouse: 5, dome: 6, concrete: 7, solar: 8, gilded: 9 };
const SHAPE = { flat: 0, gabled: 1, hipped: 2, pyramidal: 3, skillion: 4, dome: 5, round: 6 };
// surface kinds (normal.w): what the fragment shader draws; door: a hangar's door wall (u runs
// from the wall's middle, 'floors' holds its half width)
const K = { wall: 0, roof: 1, parapet: 2, plain: 3, door: 4 };
// style flags: 128 the volume overlaps another (walls stepped in by INSET m, buildingShaders.js
// INSET_M); hangars: 16 doors on the - side, 32 doors in an end wall (a) instead of a long side (b)
const FLAG_INSET = 128, DOOR_NEG = 16, DOOR_END = 32, INSET = 0.3;
const ROUND_FILL = Math.PI / 4;      // area / box area of a circle

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'tile') {
      const t = await loadTile(m.url);
      tiles.set(m.key, t);
      const boxes = buildBoxes(t);
      const shadows = buildShadows(t);
      const lights = buildLights(t);
      self.postMessage({ type: 'tile', id: m.id, key: m.key, ok: true, boxes, shadows, lights, chunks: chunkInfo(t),
        info: { count: t.N, maxTop: t.maxTop, minBase: t.minBase } },
      [...['a', 'b', 'c', 'wall', 'roof', 'info', 'vsize'].map((k) => boxes[k].buffer), shadows.dA.buffer, shadows.dB.buffer,
        lights.pos.buffer, lights.kind.buffer]);
    } else if (m.type === 'chunk') {
      const t = tiles.get(m.key);
      if (!t) throw new Error(`tile ${m.key} not loaded`);
      const geo = buildChunk(t, m.chunk, m.opts || {});
      const tr = [geo.position.buffer, geo.normal.buffer, geo.facade.buffer, geo.color.buffer, geo.info.buffer, geo.index.buffer];
      self.postMessage({ type: 'chunk', id: m.id, key: m.key, chunk: m.chunk, ok: true, geo }, tr);
    } else if (m.type === 'roofs') {
      const t = tiles.get(m.key);
      if (!t) throw new Error(`tile ${m.key} not loaded`);
      const items = buildRoofItems(t, m.chunk, m.opts || {});
      self.postMessage({ type: 'roofs', id: m.id, key: m.key, chunk: m.chunk, ok: true, items }, [items.a.buffer, items.b.buffer, items.c.buffer]);
    } else if (m.type === 'drop') {
      tiles.delete(m.key);
    }
  } catch (err) {
    self.postMessage({ type: m.type, id: m.id, key: m.key, chunk: m.chunk, ok: false, error: String(err && err.message || err) });
  }
};

// ------------------------------------------------------------------------------------ parsing
async function loadTile(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  let buf = await r.arrayBuffer();
  const b = new Uint8Array(buf, 0, 2);
  if (b[0] === 0x1f && b[1] === 0x8b) {           // gzip (the files are stored compressed)
    const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(s).arrayBuffer();
  }
  return parse(buf);
}

function parse(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a building tile');
  const t = {
    version: dv.getUint16(4, true), ix: dv.getUint8(8), iz: dv.getUint8(9), nch: dv.getUint8(10),
    ox: dv.getFloat32(12, true), oz: dv.getFloat32(16, true), q: dv.getFloat32(20, true),
    N: dv.getUint32(24, true), R: dv.getUint32(28, true), V: dv.getUint32(32, true),
    maxTop: dv.getFloat32(36, true), minBase: dv.getFloat32(40, true),
  };
  t.x0 = -51200 + TILE * t.ix;
  t.z0 = -51200 + TILE * t.iz;
  let o = dv.getUint16(6, true);
  const take = (Ctor, n) => {
    const a = new Ctor(buf, o, n);
    o += a.byteLength;
    o += (4 - (a.byteLength % 4)) % 4;
    return a;
  };
  const N = t.N, Rn = t.R, V = t.V;
  t.starts = take(Uint32Array, t.nch * t.nch + 1);
  t.cx = take(Uint16Array, N); t.cz = take(Uint16Array, N);
  t.oa = take(Uint16Array, N); t.ob = take(Uint16Array, N); t.yaw = take(Uint16Array, N);
  t.base = take(Int16Array, N); t.top = take(Uint16Array, N); t.minh = take(Uint16Array, N);
  t.ringN = take(Uint16Array, Rn);
  t.vx = take(Uint16Array, V); t.vz = take(Uint16Array, V);
  t.sink = take(Uint8Array, N); t.rise = take(Uint8Array, N); t.shape = take(Uint8Array, N);
  t.style = take(Uint8Array, N); t.rstyle = take(Uint8Array, N); t.floorh = take(Uint8Array, N);
  t.bay = take(Uint8Array, N); t.vs = take(Uint8Array, N); t.seed = take(Uint8Array, N);
  t.floors = take(Uint8Array, N); t.nrings = take(Uint8Array, N);
  t.wall = take(Uint8Array, 3 * N); t.roof = take(Uint8Array, 3 * N);
  if (o !== buf.byteLength) throw new Error(`tile size mismatch ${o} != ${buf.byteLength}`);
  // ring / vertex starts per building
  t.ring0 = new Uint32Array(N + 1);
  for (let i = 0; i < N; i++) t.ring0[i + 1] = t.ring0[i] + t.nrings[i];
  t.vert0 = new Uint32Array(Rn + 1);
  for (let i = 0; i < Rn; i++) t.vert0[i + 1] = t.vert0[i] + t.ringN[i];
  t.chunkOf = new Uint8Array(N);
  for (let c = 0; c < t.nch * t.nch; c++) for (let i = t.starts[c]; i < t.starts[c + 1]; i++) t.chunkOf[i] = c;
  // tile-local vertex positions; the walls of volumes overlapping another step in a little
  t.px = new Float32Array(V); t.pz = new Float32Array(V);
  for (let k = 0; k < V; k++) { t.px[k] = t.vx[k] * t.q + (t.ox - t.x0); t.pz[k] = t.vz[k] * t.q + (t.oz - t.z0); }
  t.area = new Float32Array(N);
  for (let i = 0; i < N; i++) t.area[i] = polygonArea(t, i);
  for (let i = 0; i < N; i++) if (t.style[i] & FLAG_INSET) insetRings(t, i, INSET);
  return t;
}

/** Tile-local x / z (metres from the tile's NW corner) of vertex k. */
const lx = (t, k) => t.px[k];
const lz = (t, k) => t.pz[k];

/** Moves every ring of building b inwards by d (mitred corners, the miter capped at 3 d). */
function insetRings(t, b, d) {
  for (let r = t.ring0[b]; r < t.ring0[b + 1]; r++) {
    const s0 = t.vert0[r], n = t.ringN[r];
    if (n < 3) continue;
    const ox = new Float64Array(n), oz = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const p = s0 + ((k + n - 1) % n), c = s0 + k, q = s0 + ((k + 1) % n);
      let ex = t.px[c] - t.px[p], ez = t.pz[c] - t.pz[p];
      let fx = t.px[q] - t.px[c], fz = t.pz[q] - t.pz[c];
      const le = Math.hypot(ex, ez) || 1, lf = Math.hypot(fx, fz) || 1;
      // inward normals of the two edges (the walls face (-dz, dx))
      const n1x = ez / le, n1z = -ex / le, n2x = fz / lf, n2z = -fx / lf;
      let mx = n1x + n2x, mz = n1z + n2z;
      const lm = Math.hypot(mx, mz);
      if (lm < 1e-6) { mx = n1x; mz = n1z; } else { mx /= lm; mz /= lm; }
      const k1 = Math.max(mx * n1x + mz * n1z, 1 / 3);
      ox[k] = t.px[c] + mx * d / k1; oz[k] = t.pz[c] + mz * d / k1;
    }
    for (let k = 0; k < n; k++) { t.px[s0 + k] = ox[k]; t.pz[s0 + k] = oz[k]; }
  }
}
const vsizeOf = (code) => 2 * Math.pow(1000, code / 255);

function polygonArea(t, b) {
  let a = 0;
  for (let r = t.ring0[b]; r < t.ring0[b + 1]; r++) {
    const s = t.vert0[r], n = t.ringN[r];
    let ar = 0;
    for (let i = 0; i < n; i++) {
      const j = s + i, k = s + ((i + 1) % n);
      ar += lx(t, j) * lz(t, k) - lx(t, k) * lz(t, j);
    }
    a += -0.5 * ar;          // outer rings have A_xz < 0, holes A_xz > 0
  }
  return Math.max(a, 1);
}

/**
 * Per chunk: building count, height range (m MSL) and the tallest building (m), for the main
 * thread's distances, culling and detail ranges.
 */
function chunkInfo(t) {
  const out = [];
  for (let c = 0; c < t.nch * t.nch; c++) {
    let lo = Infinity, hi = -Infinity, tall = 0;
    for (let i = t.starts[c]; i < t.starts[c + 1]; i++) {
      const g0 = t.base[i] * 0.1;
      lo = Math.min(lo, g0 - t.sink[i] * 0.1);
      hi = Math.max(hi, g0 + t.top[i] * 0.1);
      tall = Math.max(tall, t.top[i] * 0.1);
    }
    out.push({ n: t.starts[c + 1] - t.starts[c], lo: Number.isFinite(lo) ? lo : 0, hi: Number.isFinite(hi) ? hi : 0, tall });
  }
  return out;
}

// ------------------------------------------------------------------------------------ boxes
// One instance per building, sorted by visibility size (largest first) so the main thread can
// draw only the first n of a far tile. Three vec4 float arrays and three 4-byte arrays:
//   a: x, z (tile-local), yaw, half length     b: half width, wall bottom, floor-0 level, apex (m MSL)
//   c: roof rise, shape, chunk, vsize (m)       wall: rgb, style    roof: rgb, roof style
//   info: floor height (0.05 m), bay (0.05 m), seed, floors
function buildBoxes(t) {
  const N = t.N;
  const order = new Uint32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  order.sort((p, q) => t.vs[q] - t.vs[p]);
  const a = new Float32Array(N * 4), b = new Float32Array(N * 4), c = new Float32Array(N * 4);
  const wall = new Uint8Array(N * 4), roof = new Uint8Array(N * 4), info = new Uint8Array(N * 4);
  const vsize = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const i = order[k];
    let ha = t.oa[i] * 0.05, hb = t.ob[i] * 0.05;
    // the box keeps the footprint's area (L-shapes, round towers): shrink the OBB to match
    const s = Math.min(1, Math.max(0.72, Math.sqrt(t.area[i] / Math.max(4 * ha * hb, 1))));
    ha *= s; hb *= s;
    const g0 = t.base[i] * 0.1;
    let shape = t.shape[i];
    let rise = t.rise[i] * 0.2;
    if (shape === SHAPE.dome || shape === SHAPE.round || shape === SHAPE.skillion) { shape = SHAPE.flat; rise *= 0.5; }
    const top = g0 + t.top[i] * 0.1 - (shape === SHAPE.flat ? rise : 0);
    const bottom = t.minh[i] > 0 ? g0 + t.minh[i] * 0.1 : g0 - t.sink[i] * 0.1;
    const o = k * 4;
    a[o] = t.cx[i] * t.q + (t.ox - t.x0);
    a[o + 1] = t.cz[i] * t.q + (t.oz - t.z0);
    a[o + 2] = t.yaw[i] / 65536 * Math.PI;
    a[o + 3] = ha;
    b[o] = hb; b[o + 1] = bottom; b[o + 2] = g0; b[o + 3] = top;
    c[o] = shape === SHAPE.flat ? 0 : rise;
    c[o + 1] = shape;
    c[o + 2] = t.chunkOf[i];
    c[o + 3] = vsize[k] = vsizeOf(t.vs[i]);
    wall[o] = t.wall[3 * i]; wall[o + 1] = t.wall[3 * i + 1]; wall[o + 2] = t.wall[3 * i + 2]; wall[o + 3] = t.style[i];
    roof[o] = t.roof[3 * i]; roof[o + 1] = t.roof[3 * i + 1]; roof[o + 2] = t.roof[3 * i + 2]; roof[o + 3] = t.rstyle[i];
    info[o] = t.floorh[i]; info[o + 1] = t.bay[i]; info[o + 2] = t.seed[i]; info[o + 3] = t.floors[i];
  }
  return { a, b, c, wall, roof, info, vsize, count: N };
}

// ------------------------------------------------------------------------------------ ground shadows
// One decal per building of 3 m or more (buildingShaders.js SHADOW_VERT), sorted by ground level,
// highest first: where shadows overlap, the first decal drawn keeps the pixel (depth test).
//   dA: x, z (tile-local + 896 m, 0.125 m), yaw (pi / 65536), half length (0.05 m)
//   dB: half width (0.05 m), ground level (0.1 m + 32768), height (0.1 m), visibility size (code)
function buildShadows(t) {
  const N = t.N;
  const idx = [];
  for (let i = 0; i < N; i++) if (t.top[i] >= 30) idx.push(i);
  idx.sort((p, q) => t.base[q] - t.base[p]);
  const n = idx.length;
  const dA = new Uint16Array(n * 4), dB = new Uint16Array(n * 4);
  const q8 = (v) => Math.max(0, Math.min(65535, Math.round(v)));
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const ha = t.oa[i] * 0.05, hb = t.ob[i] * 0.05;
    const s = Math.min(1, Math.max(0.72, Math.sqrt(t.area[i] / Math.max(4 * ha * hb, 1))));
    const x = t.cx[i] * t.q + (t.ox - t.x0), z = t.cz[i] * t.q + (t.oz - t.z0);
    const o = k * 4;
    dA[o] = q8((x + 896) / 0.125); dA[o + 1] = q8((z + 896) / 0.125); dA[o + 2] = t.yaw[i]; dA[o + 3] = q8(ha * s / 0.05);
    dB[o] = q8(hb * s / 0.05); dB[o + 1] = t.base[i] + 32768; dB[o + 2] = t.top[i]; dB[o + 3] = t.vs[i];
  }
  return { dA, dB, count: n };
}

// ------------------------------------------------------------------------------------ obstruction lights
// Red lights on structures of 45 m or more (ICAO Annex 14): at the roof corners of large roofs,
// round the rim of stacks, on the top of slender towers; an intermediate ring half way up
// structures of 150 m or more. kind: 1 flashing (medium intensity: 150 m or more, and stacks) /
// 0 steady, and a phase (s) shared by one structure's lights.
function buildLights(t) {
  const pos = [], kind = [];
  for (let i = 0; i < t.N; i++) {
    const H = t.top[i] * 0.1;
    if (H < 45) continue;
    const g0 = t.base[i] * 0.1;
    const style = t.style[i] & 15;
    const stack = style === W.stack;
    const flash = stack || H >= 150 ? 1 : 0;
    const phase = t.seed[i] / 255;
    const yaw = t.yaw[i] / 65536 * Math.PI;
    const ax = Math.cos(yaw), az = Math.sin(yaw), bx = -az, bz = ax;
    const ha = t.oa[i] * 0.05, hb = t.ob[i] * 0.05;
    const cx = t.cx[i] * t.q + (t.ox - t.x0), cz = t.cz[i] * t.q + (t.oz - t.z0);
    const round = t.area[i] / Math.max(4 * ha * hb, 1) < ROUND_FILL + 0.06;
    const pts = [];
    if (stack || (round && ha < 20)) {
      const r = Math.min(ha, hb) * 0.92;
      for (let k = 0; k < 3; k++) { const th = k * 2.0944 + phase * 6.283; pts.push([Math.cos(th) * r, Math.sin(th) * r]); }
    } else if (ha * hb * 4 > 400) {
      const ia = Math.max(ha - 1, 0.5), ib = Math.max(hb - 1, 0.5);
      pts.push([-ia, -ib], [ia, -ib], [ia, ib], [-ia, ib]);
    } else {
      pts.push([0, 0]);
    }
    const levels = H >= 150 ? [H + 0.5, 0.5 * H] : [H + 0.5];
    for (const y of levels) {
      for (const [u, w] of pts) {
        pos.push(cx + ax * u + bx * w, g0 + y, cz + az * u + bz * w);
        kind.push(flash, phase * 1.5);
      }
    }
  }
  return { pos: new Float32Array(pos), kind: new Float32Array(kind), count: pos.length / 3 };
}

// ------------------------------------------------------------------------------------ chunk geometry
class GeoBuilder {
  constructor(cap = 4096) {
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.nrm = new Int8Array(cap * 4);
    this.fac = new Int16Array(cap * 2);
    this.col = new Uint8Array(cap * 4);
    this.inf = new Uint8Array(cap * 4);
    this.idx = new Uint32Array(cap * 2);
    this.ni = 0;
  }

  _grow(nv, ni) {
    if (this.n + nv > this.pos.length / 3) {
      const cap = Math.max((this.pos.length / 3) * 2, this.n + nv);
      const g = (a, k) => { const b = new a.constructor(cap * k); b.set(a); return b; };
      this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 4); this.fac = g(this.fac, 2); this.col = g(this.col, 4); this.inf = g(this.inf, 4);
    }
    if (this.ni + ni > this.idx.length) {
      const b = new Uint32Array(Math.max(this.idx.length * 2, this.ni + ni));
      b.set(this.idx);
      this.idx = b;
    }
  }

  /** One vertex; s = the current surface (normal, kind, colour, style, info). */
  v(x, y, z, u, w, s) {
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.nrm[i * 4] = s.nx; this.nrm[i * 4 + 1] = s.ny; this.nrm[i * 4 + 2] = s.nz; this.nrm[i * 4 + 3] = s.kind;
    this.fac[i * 2] = Math.max(-32767, Math.min(32767, Math.round(u * 10)));
    this.fac[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(w * 10)));
    this.col[i * 4] = s.r; this.col[i * 4 + 1] = s.g; this.col[i * 4 + 2] = s.b; this.col[i * 4 + 3] = s.style;
    this.inf[i * 4] = s.fh; this.inf[i * 4 + 1] = s.bay; this.inf[i * 4 + 2] = s.seed; this.inf[i * 4 + 3] = s.floors;
    return i;
  }

  tri(a, b, c) { this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c; }

  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }

  setNormal(s, x, y, z) {
    const l = Math.hypot(x, y, z) || 1;
    s.nx = Math.round(x / l * 127); s.ny = Math.round(y / l * 127); s.nz = Math.round(z / l * 127);
  }
}

/**
 * Facade u at the far end of a wall of length L: stretched to a whole number of window bays, so
 * every wall starts and ends with a pier and its windows sit symmetrically (0: too short for one).
 */
function uSpan(L, bay) {
  const n = Math.round(L / bay);
  return n >= 1 ? n * bay : 0;
}

function surface(t, i, roof) {
  const s = { nx: 0, ny: 127, nz: 0, kind: roof ? K.roof : K.wall, fh: t.floorh[i], bay: t.bay[i], seed: t.seed[i], floors: t.floors[i] };
  const c = roof ? t.roof : t.wall;
  s.r = c[3 * i]; s.g = c[3 * i + 1]; s.b = c[3 * i + 2];
  s.style = roof ? t.rstyle[i] : t.style[i];
  return s;
}

/**
 * Full-detail geometry of one chunk: walls following the footprint (holes too), flat roofs with
 * parapets and a stair / lift house, gabled and hipped roofs over near-rectangular footprints,
 * domes and barrel vaults. opts: {parapets: bool, roofBoxes: bool}.
 */
function buildChunk(t, c, opts) {
  const nch = t.nch, cs = TILE / nch;
  const ccx = ((c % nch) + 0.5) * cs, ccz = (Math.floor(c / nch) + 0.5) * cs;
  const B = new GeoBuilder(16384);
  const parapets = opts.parapets !== false, roofBoxes = opts.roofBoxes !== false;
  for (let i = t.starts[c]; i < t.starts[c + 1]; i++) building(t, i, B, ccx, ccz, parapets, roofBoxes);
  const nv = B.n;
  const index = nv > 65535 ? B.idx.slice(0, B.ni) : Uint16Array.from(B.idx.subarray(0, B.ni));
  // bounding sphere (chunk-local)
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let k = 0; k < nv; k++) {
    const x = B.pos[3 * k], y = B.pos[3 * k + 1], z = B.pos[3 * k + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const sphere = nv ? [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2, 0.5 * Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) + 1] : [0, 0, 0, 1];
  return {
    position: B.pos.slice(0, nv * 3), normal: B.nrm.slice(0, nv * 4), facade: B.fac.slice(0, nv * 2),
    color: B.col.slice(0, nv * 4), info: B.inf.slice(0, nv * 4), index, center: [ccx, ccz], sphere,
    vertices: nv, triangles: B.ni / 3,
  };
}

function building(t, i, B, ccx, ccz, parapets, roofBoxes) {
  const g0 = t.base[i] * 0.1;
  const apex = g0 + t.top[i] * 0.1;
  const raised = t.minh[i] > 0;
  const bottom = raised ? g0 + t.minh[i] * 0.1 : g0 - t.sink[i] * 0.1;
  let shape = t.shape[i];
  let rise = t.rise[i] * 0.2;
  const style = t.style[i] & 15;
  const ha = t.oa[i] * 0.05, hb = t.ob[i] * 0.05;
  const rect = t.area[i] / Math.max(4 * ha * hb, 1);
  // a pitched roof is built over the oriented box: only over (nearly) rectangular footprints
  if ((shape === SHAPE.gabled || shape === SHAPE.hipped || shape === SHAPE.pyramidal || shape === SHAPE.skillion) && rect < 0.86) {
    shape = SHAPE.flat;
    rise *= 0.5;
  }
  if (shape === SHAPE.skillion) shape = SHAPE.gabled;
  const flat = shape === SHAPE.flat;
  const eave = apex - rise;                                // rise is 0 for tagged-flat roofs
  const withParapet = parapets && flat && !raised && apex - bottom > 4.5 &&
    style !== W.greenhouse && style !== W.industrial && style !== W.concrete && style !== W.glass;
  const parapet = withParapet ? (style === W.house ? 0.5 : 1.0) : 0;
  const roofY = flat ? eave - parapet : eave;
  const wallTop = eave;

  const sW = surface(t, i, false);
  const sR = surface(t, i, true);
  const bayM = Math.max(t.bay[i] * 0.05, 1);
  // OBB frame (chunk-local)
  const yaw = t.yaw[i] / 65536 * Math.PI;
  const ax_ = Math.cos(yaw), az_ = Math.sin(yaw);       // long axis a
  const bx_ = -az_, bz_ = ax_;                          // short axis b
  // a hangar's doors: in the wall facing this way (an end wall of a vault, else a long side)
  const hangar = style === W.hangar;
  const dEnd = (t.style[i] & DOOR_END) !== 0, dSgn = (t.style[i] & DOOR_NEG) ? -1 : 1;
  const dx_ = (dEnd ? ax_ : bx_) * dSgn, dz_ = (dEnd ? az_ : bz_) * dSgn;
  // ---- walls (outer ring and holes), parapet inner faces ----
  for (let r = t.ring0[i]; r < t.ring0[i + 1]; r++) {
    const s0 = t.vert0[r], n = t.ringN[r];
    for (let k = 0; k < n; k++) {
      const a = s0 + k, b = s0 + ((k + 1) % n);
      const ax = lx(t, a) - ccx, az = lz(t, a) - ccz, bx = lx(t, b) - ccx, bz = lz(t, b) - ccz;
      const dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 1e-3) continue;
      B._grow(8, 12);
      sW.kind = K.wall;
      B.setNormal(sW, -dz, 0, dx);
      let U0 = 0, U = uSpan(L, bayM);
      const door = hangar && r === t.ring0[i] && (-dz * dx_ + dx * dz_) / L > 0.8;
      if (door) { sW.kind = K.door; U0 = -L / 2; U = L / 2; sW.floors = Math.min(255, Math.round(L / 2)); }
      const v0 = B.v(ax, bottom, az, U0, bottom - g0, sW);
      const v1 = B.v(bx, bottom, bz, U, bottom - g0, sW);
      const v2 = B.v(bx, wallTop, bz, U, wallTop - g0, sW);
      const v3 = B.v(ax, wallTop, az, U0, wallTop - g0, sW);
      B.quad(v0, v1, v2, v3);
      if (door) { sW.kind = K.wall; sW.floors = t.floors[i]; }
      if (parapet > 0) {
        sW.kind = K.parapet;
        B.setNormal(sW, dz, 0, -dx);
        const p0 = B.v(bx, roofY, bz, U, roofY - g0, sW);
        const p1 = B.v(ax, roofY, az, 0, roofY - g0, sW);
        const p2 = B.v(ax, wallTop, az, 0, wallTop - g0, sW);
        const p3 = B.v(bx, wallTop, bz, U, wallTop - g0, sW);
        B.quad(p0, p1, p2, p3);
      }
    }
  }
  sW.kind = K.wall;
  const ocx = t.cx[i] * t.q + (t.ox - t.x0) - ccx, ocz = t.cz[i] * t.q + (t.oz - t.z0) - ccz;
  const P = (u, w) => [ocx + ax_ * u + bx_ * w, ocz + az_ * u + bz_ * w];

  if (flat || shape === SHAPE.dome || shape === SHAPE.round) {
    // ---- flat roof (also under domes and vaults) ----
    flatRoof(t, i, B, ccx, ccz, flat ? roofY : eave, sR, ocx, ocz, ax_, az_);
    if (shape === SHAPE.dome) dome(B, sR, P, ha, hb, eave, rise, sR);
    else if (shape === SHAPE.round) vault(B, sR, sW, P, ha, hb, eave, rise, ax_, az_, bx_, bz_, g0, hangar && dEnd ? dSgn : 0, t.floors[i]);
    else if (roofBoxes && parapet > 0 && t.area[i] > 160 && (style === W.plaster || style === W.stone || style === W.tower || style === W.office || style === W.oldstone || style === W.public)) {
      roofHouse(t, i, B, sW, P, ha, hb, roofY, ax_, az_, bx_, bz_, g0, ccx, ccz);
    }
    return;
  }
  // ---- pitched roofs over the oriented box, with a 0.35 m overhang ----
  const ov = 0.35;
  const slope = rise / Math.max(hb, 0.5);
  const A = ha + ov, Bw = hb + ov;
  const eaveO = eave - ov * slope;                       // the overhang continues the slope
  const inset = shape === SHAPE.hipped ? Math.min(hb, ha) : shape === SHAPE.pyramidal ? ha : 0;
  const rl = Math.max(0, A - (shape === SHAPE.gabled ? 0 : inset + ov));   // ridge half length
  const top = eave + rise;
  const c1 = P(-A, -Bw), c2 = P(A, -Bw), c3 = P(A, Bw), c4 = P(-A, Bw);
  const r1 = P(-rl, 0), r2 = P(rl, 0);
  B._grow(16, 24);
  // slope on the +b side: eave edge c4 -> c3, ridge r2 -> r1 (normal (0, hb, rise) in a/b/up)
  B.setNormal(sR, bx_ * rise, hb, bz_ * rise);
  let q0 = B.v(c4[0], eaveO, c4[1], -A, Bw, sR), q1 = B.v(c3[0], eaveO, c3[1], A, Bw, sR);
  let q2 = B.v(r2[0], top, r2[1], rl, 0, sR), q3 = B.v(r1[0], top, r1[1], -rl, 0, sR);
  B.quad(q0, q1, q2, q3);
  // slope on the -b side: eave c2 -> c1
  B.setNormal(sR, -bx_ * rise, hb, -bz_ * rise);
  q0 = B.v(c2[0], eaveO, c2[1], A, -Bw, sR); q1 = B.v(c1[0], eaveO, c1[1], -A, -Bw, sR);
  q2 = B.v(r1[0], top, r1[1], -rl, 0, sR); q3 = B.v(r2[0], top, r2[1], rl, 0, sR);
  B.quad(q0, q1, q2, q3);
  if (shape === SHAPE.gabled) {
    // gable walls (in the wall planes at +-ha), continuing the facade
    for (const sgn of [1, -1]) {
      const e1 = P(sgn * ha, -sgn * hb), e2 = P(sgn * ha, sgn * hb), rp = P(sgn * ha, 0);
      B.setNormal(sW, sgn * ax_, 0, sgn * az_);
      const w0 = B.v(e1[0], eave, e1[1], 0, eave - g0, sW);
      const U = uSpan(2 * hb, bayM);
      const w1 = B.v(e2[0], eave, e2[1], U, eave - g0, sW);
      const w2 = B.v(rp[0], top, rp[1], U / 2, top - g0, sW);
      B.tri(w0, w2, w1);
    }
  } else {
    // hip ends: from the overhanging eave corners to the ridge ends
    const run = Math.max(inset, 0.5);
    for (const sgn of [1, -1]) {
      const e1 = sgn > 0 ? c2 : c4, e2 = sgn > 0 ? c3 : c1, rp = sgn > 0 ? r2 : r1;
      B.setNormal(sR, sgn * ax_ * rise, run, sgn * az_ * rise);
      const w0 = B.v(e1[0], eaveO, e1[1], sgn * A, -sgn * Bw, sR);
      const w1 = B.v(e2[0], eaveO, e2[1], sgn * A, sgn * Bw, sR);
      const w2 = B.v(rp[0], top, rp[1], sgn * rl, 0, sR);
      B.tri(w0, w2, w1);
    }
  }
}

/** Flat roof over the footprint (holes kept), facing up; facade coords = OBB-aligned roof coords. */
function flatRoof(t, i, B, ccx, ccz, y, sR, ocx, ocz, ax_, az_) {
  const r0 = t.ring0[i], r1 = t.ring0[i + 1];
  const pts = [];
  const holes = [];
  for (let r = r0; r < r1; r++) {
    if (r > r0) holes.push(pts.length / 2);
    const s0 = t.vert0[r], n = t.ringN[r];
    for (let k = 0; k < n; k++) pts.push(lx(t, s0 + k) - ccx, lz(t, s0 + k) - ccz);
  }
  const tris = triangulate(pts, holes);
  const nv = pts.length / 2;
  B._grow(nv, tris.length);
  sR.kind = K.roof;
  B.setNormal(sR, 0, 1, 0);
  const first = B.n;
  for (let k = 0; k < nv; k++) {
    const x = pts[2 * k], z = pts[2 * k + 1];
    const dx = x - ocx, dz = z - ocz;
    B.v(x, y, z, dx * ax_ + dz * az_, -dx * az_ + dz * ax_, sR);
  }
  for (let k = 0; k < tris.length; k += 3) B.tri(first + tris[k], first + tris[k + 1], first + tris[k + 2]);
}

/** Stair / lift house on a flat roof: a plain box near the middle, if it fits. */
function roofHouse(t, i, B, sW, P, ha, hb, y, ax_, az_, bx_, bz_, g0, ccx, ccz) {
  const big = t.top[i] * 0.1 > 40;
  const a = Math.min(big ? 7 : 2.6, 0.32 * ha), b = Math.min(big ? 5 : 2.1, 0.36 * hb);
  if (a < 1.2 || b < 1.0) return;
  const h = big ? 4.5 : 2.7;
  // a little off centre, by the seed
  const s = t.seed[i];
  const ou = ((s & 15) / 15 - 0.5) * (ha - a) * 0.8, ow = (((s >> 4) & 15) / 15 - 0.5) * (hb - b) * 0.8;
  // the (a, b) frame is mirrored on the map (x east, north = -z): this order runs counter-clockwise
  const c = [[-a, -b], [-a, b], [a, b], [a, -b]].map(([u, w]) => P(u + ou, w + ow));
  for (const p of c) if (!insideFootprint(t, i, p[0] + ccx, p[1] + ccz)) return;
  const sP = { ...sW, kind: K.plain };
  B._grow(20, 30);
  const y1 = y + h;
  for (let k = 0; k < 4; k++) {
    const p = c[k], q = c[(k + 1) % 4];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const L = Math.hypot(dx, dz);
    B.setNormal(sP, -dz, 0, dx);
    const v0 = B.v(p[0], y, p[1], 0, y - g0, sP), v1 = B.v(q[0], y, q[1], L, y - g0, sP);
    const v2 = B.v(q[0], y1, q[1], L, y1 - g0, sP), v3 = B.v(p[0], y1, p[1], 0, y1 - g0, sP);
    B.quad(v0, v1, v2, v3);
  }
  const sT = { ...sP, kind: K.roof, style: R.flat };
  sT.r = t.roof[3 * i]; sT.g = t.roof[3 * i + 1]; sT.b = t.roof[3 * i + 2];
  B.setNormal(sT, 0, 1, 0);
  const w = c.map((p) => B.v(p[0], y1, p[1], 0, 0, sT));
  B.quad(w[0], w[1], w[2], w[3]);
}

/** Dome over the oriented box's inscribed circle. */
function dome(B, sR, P, ha, hb, y, rise) {
  const r = Math.min(ha, hb), SEG = 16, RINGS = 5;
  B._grow(SEG * (RINGS + 1) + 1, SEG * RINGS * 6);
  const rows = [];
  for (let j = 0; j <= RINGS; j++) {
    const th = (j / RINGS) * Math.PI / 2;          // 0 at the base, pi/2 at the top
    const rr = r * Math.cos(th), yy = y + rise * Math.sin(th);
    const row = [];
    for (let k = 0; k < SEG; k++) {
      const ph = (k / SEG) * Math.PI * 2;
      const u = Math.cos(ph), w = Math.sin(ph);
      const p = P(rr * u, rr * w);
      // normal of the spheroid
      const pa = P(u, w);
      const pc = P(0, 0);
      B.setNormal(sR, (pa[0] - pc[0]) * Math.cos(th) / r, Math.sin(th) / Math.max(rise, 0.5), (pa[1] - pc[1]) * Math.cos(th) / r);
      row.push(B.v(p[0], yy, p[1], rr * u, rr * w, sR));
    }
    rows.push(row);
  }
  for (let j = 0; j < RINGS; j++) {
    for (let k = 0; k < SEG; k++) {
      const a = rows[j][k], b = rows[j][(k + 1) % SEG], c = rows[j + 1][(k + 1) % SEG], d = rows[j + 1][k];
      // P's frame (a, b) is turned like (x, z): counter-clockwise from above when (a x b).y < 0
      B.quad(a, d, c, b);
    }
  }
}

/** Barrel vault along the long axis (hangars): arch across b, end walls closing it; the end wall
 *  at doorSgn * a (if not 0) holds the doors. */
function vault(B, sR, sW, P, ha, hb, y, rise, ax_, az_, bx_, bz_, g0, doorSgn = 0, floors = 0) {
  const SEG = 10;
  B._grow((SEG + 1) * 2 + (SEG + 2) * 2, SEG * 6 + SEG * 6);
  const prof = [];
  for (let k = 0; k <= SEG; k++) {
    const th = (k / SEG) * Math.PI;                 // 0 at +b, pi at -b
    prof.push([hb * Math.cos(th), y + rise * Math.sin(th), Math.cos(th) / hb, Math.sin(th) / Math.max(rise, 0.5)]);
  }
  const L0 = [], L1 = [];
  for (const [w, yy, nw, ny] of prof) {
    B.setNormal(sR, bx_ * nw, ny, bz_ * nw);
    const p0 = P(-ha, w), p1 = P(ha, w);
    L0.push(B.v(p0[0], yy, p0[1], -ha, w, sR));
    L1.push(B.v(p1[0], yy, p1[1], ha, w, sR));
  }
  for (let k = 0; k < SEG; k++) B.quad(L0[k], L1[k], L1[k + 1], L0[k + 1]);
  // end walls (semi-ellipses at +-ha)
  for (const sgn of [1, -1]) {
    B.setNormal(sW, sgn * ax_, 0, sgn * az_);
    const door = sgn === doorSgn;
    sW.kind = door ? K.door : K.wall;
    sW.floors = door ? Math.min(255, Math.round(hb)) : floors;
    const u0 = door ? 0 : hb;                         // the door wall: u from its middle
    const c = P(sgn * ha, 0);
    const ci = B.v(c[0], y, c[1], u0, 0.0 + y - g0, sW);
    const ring = prof.map(([w, yy]) => { const p = P(sgn * ha, w); return B.v(p[0], yy, p[1], u0 - sgn * w, yy - g0, sW); });
    for (let k = 0; k < SEG; k++) {
      if (sgn > 0) B.tri(ci, ring[k + 1], ring[k]);
      else B.tri(ci, ring[k], ring[k + 1]);
    }
  }
  sW.kind = K.wall;
  sW.floors = floors;
}

// ------------------------------------------------------------------------------------ roof items
// What stands on the flat roofs (Rooftops.js draws it, buildingShaders.js ROOF_ITEM_*): one
// instance per item, a unit box the vertex shader shapes (x along the item's length, z across it
// with -z its front, y up; a wedge when its front is lower). Placed here, deterministic per
// building (its index and seed), so a roof always looks the same.
//   Solar water heaters on the roofs of homes (Israeli law since 1980: nearly every flat up to
//   ~9 floors has one): a collector of dark glass (1 m x 2 m on a frame tilted ~40 deg to the
//   south) or two side by side, a white or grey horizontal tank (150-200 l, ~0.55 m) on the frame
//   behind its top edge; in rows facing the side of the building closest to south, about one per
//   flat (roofSwhCover: their share of the roof by floors, the far roofs' mean in the shader).
//   Water tanks (black or white plastic, ~1 m), outdoor units of air conditioners in pairs; on
//   offices and public buildings chillers and rows of condensers.
const ITEM = { collector: 0, tank: 1, water: 2, ac: 3, chiller: 4 };
// the share of a home's flat roof under solar water heaters (panels and tanks) by its floors; the
// shader blends the same share into far roofs (buildingShaders.js SWH_COVER)
const roofSwhCover = (floors) => (floors >= 10 ? 0.08 : Math.min(0.23, Math.max(0.04, 0.0255 * floors)));
const SWH_DEPTH = 1.9;                 // a unit front to back: the panel's run (2 m at 40 deg) and the tank
const SWH_ROW = SWH_DEPTH + 0.8;       // the rows' pitch (a walkway between)

class ItemBuilder {
  constructor(cap = 4096) {
    this.n = 0;
    this.a = new Float32Array(cap * 4);
    this.b = new Uint8Array(cap * 4);
    this.c = new Uint8Array(cap * 4);
  }

  /**
   * One item: centre of its base (x, y, z chunk-local), yaw (its x axis = (cos, sin) in x / z),
   * half length, half depth, height (m), the front's height as a share of it (1: a box), colour
   * (sRGB bytes), kind (ITEM).
   */
  add(x, y, z, yaw, hl, hd, h, front, r, g, b, kind) {
    if (this.n >= this.a.length / 4) {
      const grow = (a) => { const o = new a.constructor(a.length * 2); o.set(a); return o; };
      this.a = grow(this.a); this.b = grow(this.b); this.c = grow(this.c);
    }
    const k = 4 * this.n++;
    this.a[k] = x; this.a[k + 1] = y; this.a[k + 2] = z; this.a[k + 3] = yaw;
    this.b[k] = Math.min(255, Math.round(hl / 0.025)); this.b[k + 1] = Math.min(255, Math.round(hd / 0.025));
    this.b[k + 2] = Math.min(255, Math.round(h / 0.05)); this.b[k + 3] = Math.round(Math.min(1, Math.max(0, front)) * 255);
    this.c[k] = r; this.c[k + 1] = g; this.c[k + 2] = b; this.c[k + 3] = kind;
  }
}

/** mulberry32: deterministic per building */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let q = s;
    q = Math.imul(q ^ (q >>> 15), q | 1);
    q ^= q + Math.imul(q ^ (q >>> 7), q | 61);
    return ((q ^ (q >>> 14)) >>> 0) / 4294967296;
  };
}

/** The roof items of chunk c (chunk-local, as buildChunk). opts: {parapets, roofBoxes}, the chunks'. */
function buildRoofItems(t, c, opts) {
  const nch = t.nch, cs = TILE / nch;
  const ccx = ((c % nch) + 0.5) * cs, ccz = (Math.floor(c / nch) + 0.5) * cs;
  const IB = new ItemBuilder(4096);
  const parapets = opts.parapets !== false, roofBoxes = opts.roofBoxes !== false;
  let lo = Infinity, hi = -Infinity;
  for (let i = t.starts[c]; i < t.starts[c + 1]; i++) {
    const n0 = IB.n;
    roofItems(t, i, IB, ccx, ccz, parapets, roofBoxes);
    for (let k = n0; k < IB.n; k++) { const y = IB.a[4 * k + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
  }
  const n = IB.n;
  return {
    a: IB.a.slice(0, n * 4), b: IB.b.slice(0, n * 4), c: IB.c.slice(0, n * 4), count: n, center: [ccx, ccz],
    sphere: n ? [0, (lo + hi) / 2 + 1, 0, Math.hypot(cs / 2, cs / 2, (hi - lo) / 2 + 3) + 6] : [0, 0, 0, 1],
  };
}

function roofItems(t, i, IB, ccx, ccz, parapets, roofBoxes) {
  if (t.shape[i] !== SHAPE.flat) return;
  const style = t.style[i] & 15, rs = t.rstyle[i];
  const homes = rs === R.flat_res;
  if (!homes && rs !== R.flat) return;
  if (style === W.greenhouse || style === W.industrial || style === W.hangar || style === W.stack || style === W.frame ||
    style === W.concrete) return;
  const area = t.area[i];
  if (area < 45) return;
  const g0 = t.base[i] * 0.1, apex = g0 + t.top[i] * 0.1;
  const raised = t.minh[i] > 0;
  const bottom = raised ? g0 + t.minh[i] * 0.1 : g0 - t.sink[i] * 0.1;
  if (apex - bottom <= 4.5) return;
  const eave = apex - t.rise[i] * 0.2;
  // the roof's level as building() makes it (behind the parapet)
  const parapet = parapets && !raised && style !== W.glass ? (style === W.house ? 0.5 : 1.0) : 0;
  const y = eave - parapet;
  const floors = t.floors[i];
  const ha = t.oa[i] * 0.05, hb = t.ob[i] * 0.05;
  const yaw = t.yaw[i] / 65536 * Math.PI;
  const ax_ = Math.cos(yaw), az_ = Math.sin(yaw), bx_ = -az_, bz_ = ax_;
  const ocx = t.cx[i] * t.q + (t.ox - t.x0) - ccx, ocz = t.cz[i] * t.q + (t.oz - t.z0) - ccz;
  const R0 = rng((t.ix * 977 + t.iz) * 100003 + i * 7919 + t.seed[i]);
  // the stair / lift house of building() roofHouse, kept clear (OBB coordinates, with a margin)
  let house = null;
  if (roofBoxes && parapet > 0 && area > 160 && (style === W.plaster || style === W.stone || style === W.tower ||
    style === W.office || style === W.oldstone || style === W.public)) {
    const big = t.top[i] * 0.1 > 40;
    const a = Math.min(big ? 7 : 2.6, 0.32 * ha), b = Math.min(big ? 5 : 2.1, 0.36 * hb);
    if (a >= 1.2 && b >= 1.0) {
      const sd = t.seed[i];
      const ou = ((sd & 15) / 15 - 0.5) * (ha - a) * 0.8, ow = (((sd >> 4) & 15) / 15 - 0.5) * (hb - b) * 0.8;
      house = [ou - a - 0.6, ou + a + 0.6, ow - b - 0.6, ow + b + 0.6];
    }
  }
  // the rows face the building's side closest to south (+z): F (front, an OBB axis), S along them
  let fOnA = true, fs = 1, bestZ = az_;
  if (-az_ > bestZ) { fs = -1; bestZ = -az_; }
  if (bz_ > bestZ) { fOnA = false; fs = 1; bestZ = bz_; }
  if (-bz_ > bestZ) { fOnA = false; fs = -1; }
  const hf = fOnA ? ha : hb, hs = fOnA ? hb : ha;
  // OBB coordinates (u along a, w along b) of the point t along F (+: to the front) and s along S
  const U = (tt, ss) => (fOnA ? fs * tt : ss);
  const Wo = (tt, ss) => (fOnA ? ss : fs * tt);
  const X = (u, w) => ocx + ax_ * u + bx_ * w, Z = (u, w) => ocz + az_ * u + bz_ * w;
  const at = (tt, ss) => { const u = U(tt, ss), w = Wo(tt, ss); return [X(u, w), Z(u, w)]; };
  // the items' frame: z = -F (their front faces F), x = (-Fz, Fx) (x cross up = z: a rotation)
  const Fx = fOnA ? fs * ax_ : fs * bx_, Fz = fOnA ? fs * az_ : fs * bz_;
  const iyaw = Math.atan2(Fx, -Fz);
  const free = (t0, t1, s0, s1) => {
    // the middle first (most misses), then the corners; no arrays (this runs for every slot)
    for (let q = 0; q < 5; q++) {
      const tt = q === 0 ? (t0 + t1) / 2 : (q & 1 ? t0 : t1), ss = q === 0 ? (s0 + s1) / 2 : (q & 2 ? s0 : s1);
      const u = U(tt, ss), w = Wo(tt, ss);
      if (!insideFootprint(t, i, X(u, w) + ccx, Z(u, w) + ccz)) return false;
    }
    if (house) {
      const u0 = Math.min(U(t0, s0), U(t1, s1)), u1 = Math.max(U(t0, s0), U(t1, s1));
      const w0 = Math.min(Wo(t0, s0), Wo(t1, s1)), w1 = Math.max(Wo(t0, s0), Wo(t1, s1));
      if (u1 > house[0] && u0 < house[1] && w1 > house[2] && w0 < house[3]) return false;
    }
    return true;
  };
  // free slots: rows of SWH_ROW from the back (north) of the roof, along them from one end, clear
  // of the parapet; one or two collectors wide
  const edge = parapet > 0 ? 0.9 : 0.6;
  const slots = [];
  for (let tt = -hf + edge + SWH_DEPTH / 2; tt + SWH_DEPTH / 2 <= hf - edge + 1e-6; tt += SWH_ROW) {
    for (let ss = -hs + edge; ss + 1.05 <= hs - edge + 1e-6;) {
      const w = R0() < 0.38 && ss + 2.15 <= hs - edge ? 2.1 : 1.05;
      if (free(tt - SWH_DEPTH / 2, tt + SWH_DEPTH / 2, ss, ss + w)) slots.push([tt, ss + w / 2, w]);
      ss += w + 0.3;
    }
  }
  if (!slots.length) return;
  if (homes) {
    // solar water heaters: one per flat (~110 m^2 a floor), one or two on a house; on towers of
    // flats (10 floors or more: central systems) a field of collectors (as the far roofs' mean in
    // the shader: roofSwhCover)
    let want = floors >= 10 ? Math.round(area * roofSwhCover(floors) / 2.6) : Math.round(floors * area / 110);
    if (floors <= 2) want = Math.min(want, 1 + (R0() < 0.4 ? 1 : 0));
    const keep = Math.min(1, want / slots.length) * 1.15;
    const greyTanks = R0() < 0.25;
    for (let k = 0, used = 0; k < slots.length && used < want; k++) {
      if (R0() > keep) continue;
      const [tt, ss, w] = slots[k];
      slots[k] = null;
      used++;
      // the panel (a wedge: 0.3 m high at the front, 1.6 m at the back) and the tank on the frame
      // behind its top edge: white, galvanized grey or cream
      let [x, z] = at(tt + 0.17, ss);
      IB.add(x, y, z, iyaw, w / 2 - 0.03, 0.78, 1.6, 0.19, 28, 34, 48, ITEM.collector);
      [x, z] = at(tt - SWH_DEPTH / 2 + 0.3, ss);
      const r = R0();
      const tc = greyTanks || r < 0.12 ? [176, 178, 174] : (r < 0.3 ? [224, 216, 192] : [234, 234, 228]);
      IB.add(x, y + 1.35, z, iyaw, Math.min(w / 2 - 0.08, 0.75), 0.28, 0.56, 1, tc[0], tc[1], tc[2], ITEM.tank);
    }
  }
  // water tanks (homes: black or white plastic, ~1 m, on a low stand), air conditioners, on
  // offices chillers; in the slots left, shuffled
  const left = slots.filter(Boolean);
  for (let k = left.length - 1; k > 0; k--) { const j = Math.floor(R0() * (k + 1)); const q = left[k]; left[k] = left[j]; left[j] = q; }
  let nWater = homes && floors >= 2 && R0() < 0.7 ? 1 + (R0() < 0.35 ? 1 : 0) : 0;
  let nAc = homes ? Math.min(12, Math.round(floors * area / 240 * R0())) : Math.min(36, Math.round(area / 70));
  let nCh = homes ? 0 : Math.min(6, Math.round(area / 650) + (area > 500 ? 1 : 0));
  for (const [tt, ss, w] of left) {
    if (nCh <= 0 && nWater <= 0 && nAc <= 0) break;
    if (nCh > 0 && w > 2) {
      const [x, z] = at(tt, ss);
      IB.add(x, y, z, iyaw, 0.98, 0.85, 1.9 + 0.4 * R0(), 1, 170, 172, 170, ITEM.chiller);
      nCh--;
    } else if (nWater > 0) {
      const [x, z] = at(tt, ss);
      const r = R0();
      const wc = r < 0.62 ? [36, 36, 36] : (r < 0.88 ? [216, 216, 206] : [70, 98, 142]);
      IB.add(x, y + 0.25, z, iyaw, 0.5, 0.5, 1.15 + 0.3 * R0(), 1, wc[0], wc[1], wc[2], ITEM.water);
      nWater--;
    } else {
      // outdoor units, two deep (one or two across): 0.82 x 0.34 x 0.62 m, white or pale grey
      const cols = w > 2 ? 2 : 1;
      for (let ci = 0; ci < cols; ci++) {
        for (const dt of [-0.45, 0.45]) {
          if (nAc <= 0) break;
          const [x, z] = at(tt + dt, ss + (cols === 2 ? (ci ? 0.52 : -0.52) : 0));
          const g = 206 + Math.floor(R0() * 24);
          IB.add(x, y + 0.08, z, iyaw, 0.41, 0.17, 0.62, 1, g, g, g - 6, ITEM.ac);
          nAc--;
        }
      }
    }
  }
}

function insideFootprint(t, i, x, z) {
  let inside = false;
  for (let r = t.ring0[i]; r < t.ring0[i + 1]; r++) {
    const s0 = t.vert0[r], n = t.ringN[r];
    for (let k = 0, j = n - 1; k < n; j = k++) {
      const xi = lx(t, s0 + k), zi = lz(t, s0 + k), xj = lx(t, s0 + j), zj = lz(t, s0 + j);
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

// ------------------------------------------------------------------------------------ triangulation
// Ear clipping with hole bridging (Eberly, "Triangulation by Ear Clipping"). pts = [x, z, ...] with
// the outer ring first (counter-clockwise on a north-up map: signed area in x / z < 0) and holes
// starting at the vertex indices in `holes` (clockwise). Returns vertex index triples, each
// triangle counter-clockwise on the map, i.e. facing up.
function triangulate(pts, holes) {
  const n = pts.length / 2;
  // work in map coordinates (x east, y north = -z): the outer ring is counter-clockwise there
  const X = (i) => pts[2 * i], Y = (i) => -pts[2 * i + 1];
  const outerEnd = holes.length ? holes[0] : n;
  let poly = [];
  for (let i = 0; i < outerEnd; i++) poly.push(i);
  if (signedArea(poly, X, Y) < 0) poly.reverse();
  // convex and no holes: a fan
  if (!holes.length && isConvex(poly, X, Y)) {
    const out = [];
    for (let k = 1; k < poly.length - 1; k++) out.push(poly[0], poly[k], poly[k + 1]);
    return out;
  }
  // holes, rightmost first
  const hl = [];
  for (let h = 0; h < holes.length; h++) {
    const s = holes[h], e = h + 1 < holes.length ? holes[h + 1] : n;
    const ring = [];
    for (let i = s; i < e; i++) ring.push(i);
    if (ring.length < 3) continue;
    if (signedArea(ring, X, Y) > 0) ring.reverse();
    let m = 0;
    for (let k = 1; k < ring.length; k++) if (X(ring[k]) > X(ring[m])) m = k;
    hl.push({ ring, m, mx: X(ring[m]) });
  }
  hl.sort((a, b) => b.mx - a.mx);
  for (const h of hl) poly = bridge(poly, h, X, Y) || poly;
  return earClip(poly, X, Y);
}

function signedArea(p, X, Y) {
  let a = 0;
  for (let k = 0, j = p.length - 1; k < p.length; j = k++) a += X(p[j]) * Y(p[k]) - X(p[k]) * Y(p[j]);
  return a / 2;
}

function isConvex(p, X, Y) {
  for (let k = 0; k < p.length; k++) {
    const a = p[(k + p.length - 1) % p.length], b = p[k], c = p[(k + 1) % p.length];
    if (cross(a, b, c, X, Y) < 0) return false;
  }
  return true;
}

const cross = (a, b, c, X, Y) => (X(b) - X(a)) * (Y(c) - Y(b)) - (Y(b) - Y(a)) * (X(c) - X(b));

/** Splice a hole into the polygon through a mutually visible vertex pair. */
function bridge(poly, h, X, Y) {
  const M = h.ring[h.m];
  const mx = X(M), my = Y(M);
  // closest edge crossed by the ray from M towards +x
  let best = Infinity, bi = -1;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const ay = Y(a), by = Y(b);
    if ((ay > my) === (by > my) && !(ay === my || by === my)) continue;
    if (ay === by) continue;
    const t = (my - ay) / (by - ay);
    if (t < 0 || t > 1) continue;
    const x = X(a) + t * (X(b) - X(a));
    if (x >= mx && x - mx < best) { best = x - mx; bi = k; }
  }
  if (bi < 0) return null;
  const a = poly[bi], b = poly[(bi + 1) % poly.length];
  let pk = X(a) > X(b) ? bi : (bi + 1) % poly.length;
  const ix = mx + best;
  // a reflex vertex inside the triangle (M, I, P) blocks the view: take the one closest in angle
  const P = poly[pk];
  let bestAng = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const v = poly[k];
    if (v === P) continue;
    const pr = poly[(k + poly.length - 1) % poly.length], nx = poly[(k + 1) % poly.length];
    if (cross(pr, v, nx, X, Y) >= 0) continue;             // convex
    if (!inTri(mx, my, ix, my, X(P), Y(P), X(v), Y(v))) continue;
    const ang = Math.abs(Math.atan2(Y(v) - my, X(v) - mx));
    if (ang < bestAng) { bestAng = ang; pk = k; }
  }
  const hole = [];
  for (let k = 0; k <= h.ring.length; k++) hole.push(h.ring[(h.m + k) % h.ring.length]);
  return [...poly.slice(0, pk + 1), ...hole, poly[pk], ...poly.slice(pk + 1)];
}

function inTri(ax, ay, bx, by, cx, cy, px, py) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function earClip(poly, X, Y) {
  const out = [];
  const p = poly.slice();
  let guard = p.length * p.length + 10;
  while (p.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < p.length; k++) {
      const a = p[(k + p.length - 1) % p.length], b = p[k], c = p[(k + 1) % p.length];
      if (cross(a, b, c, X, Y) <= 1e-9) continue;              // reflex or flat
      let ok = true;
      for (let j = 0; j < p.length; j++) {
        const v = p[j];
        if (v === a || v === b || v === c) continue;
        if ((X(v) === X(a) && Y(v) === Y(a)) || (X(v) === X(b) && Y(v) === Y(b)) || (X(v) === X(c) && Y(v) === Y(c))) continue;
        if (inTri(X(a), Y(a), X(b), Y(b), X(c), Y(c), X(v), Y(v))) { ok = false; break; }
      }
      if (!ok) continue;
      out.push(a, b, c);
      p.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // numerically stuck (self-touching footprint): clip the most convex corner anyway
      let bk = 0, bc = -Infinity;
      for (let k = 0; k < p.length; k++) {
        const v = cross(p[(k + p.length - 1) % p.length], p[k], p[(k + 1) % p.length], X, Y);
        if (v > bc) { bc = v; bk = k; }
      }
      if (bc > 0) out.push(p[(bk + p.length - 1) % p.length], p[bk], p[(bk + 1) % p.length]);
      p.splice(bk, 1);
    }
  }
  if (p.length === 3 && cross(p[0], p[1], p[2], X, Y) > 0) out.push(p[0], p[1], p[2]);
  return out;
}
