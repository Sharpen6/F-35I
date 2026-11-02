// The cumulus field: where the clouds stand, the same numbers in JS and in GLSL.
//
// Fair-weather cumulus come in all sizes: many small puffs, fewer big clouds (the number of clouds
// falls off as a power of their size, ~D^-1.7 to D^-2: Neggers et al. 2003, Benner & Curry 1998),
// grouped in clusters, sometimes in streets along the wind, and differently over the land and the
// sea (Israel in autumn: cumulus over the land in the afternoon, thinner over the sea in the
// morning). Thresholded noise gives blobs all of one size; here the field is three levels of
// cells, each holding at most one cloud footprint (a disc) placed and sized by an integer hash:
//
//   level 0  cells of `scale` (4-5 km)    clouds 1-2.5 km across, rare in 'few', most of 'broken'
//   level 1  cells of 0.4 scale           clouds 350-900 m
//   level 2  cells of 0.16 scale          puffs and fragments 120-350 m
//
// The value is the signed distance (m) to the union of the discs, positive inside: the edges are
// where it crosses the preset's threshold, and the GLSL cover map stores it so the ray marcher can
// skip empty air by the distance and shape each cloud from its own radius and height. A smooth
// local factor scales the radii: coverage over the land and the sea (the coast is a line along
// Israel's shore), drier east of the mountains, clusters (value noise at ~21 km) and streets. All
// smooth in space and time, so no cloud pops in or out: a cloud drifting from the sea over the land
// grows, a street's clouds shrink between the streets.
//
// The GPU evaluates it in atmosphereGLSL.js (atmoCloudCover: the cloud shadows on the terrain, roads,
// buildings, vegetation), in js/env/cloudShadowChunk.js (three's own materials) and in the cover map
// of js/env/Clouds.js; all of them get their GLSL from cloudFieldGLSL() below, and the JS here is the
// exact twin for the CPU (the shadow on the camera, "is the camera inside a cloud", the coverage
// threshold of a preset, test scripts). The hash works on 32-bit integers (Math.imul / >>> 0 here,
// uint in GLSL), so both sides agree.

const U32 = 1 / 4294967295;

/** Integer hash of a lattice point (PCG-style), 32 bits. Must match ...HashU in the GLSL below. */
export function hash2u(ix, iz) {
  let h = (Math.imul(ix >>> 0, 1597334677) ^ Math.imul(iz >>> 0, 3812015801)) >>> 0;
  h = (Math.imul(h, 747796405) + 2891336453) >>> 0;
  h = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737) >>> 0;
  h = ((h >>> 22) ^ h) >>> 0;
  return h;
}

/** The same hash as 0..1. */
export function hash2(ix, iz) { return hash2u(ix, iz) * U32; }

export function valueNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// The three levels: cell size (x scale), radius range (x cell; log-uniform within a level),
// growth of the radii with the coverage, presence (fraction of the cells with a cloud, growing with
// the coverage), the hash's salt. lr = log2(r1 / r0). The 2 x 2 cell search below needs a cloud
// to stay within 0.75 cell of its cell's centre: jitter 0.25 + radius <= 0.72 (clamped).
export const LEVELS = [
  { f: 1.0, r0: 0.12, lr: Math.log2(0.26 / 0.12), grow: 1.6, pa: 0.12, pb: 1.3, salt: 0 },
  { f: 0.4, r0: 0.11, lr: Math.log2(0.27 / 0.11), grow: 1.0, pa: 0.35, pb: 0.6, salt: 1 },
  { f: 0.16, r0: 0.10, lr: Math.log2(0.27 / 0.10), grow: 1.0, pa: 0.30, pb: 0.5, salt: 2 },
];

// The coast (a line along Israel's shore, Gaza to Haifa, in world metres: x east, z south), the
// land side positive; the transition is ~14 km wide (the sea breeze carries the land's clouds out
// a little, the sea's in)
const COAST_N = [0.951, 0.310];
const COAST_D = 34616;               // m: -dot(Ashdod's shore (-36.4 km, 0), COAST_N)
// streets: along the wind (Clouds.js WIND, towards ~75 deg), ~4.2 km apart (2-3 x the depth of the
// convective layer), the lines wavering over ~13 km
const WIND_DIR = [0.9648, 0.2631];
const STREET_GAP = 4200;

/**
 * The field's parameters (Clouds.js sets them with the preset, the time of day and the drift):
 * scale (m: the big cells), drift [x, z] (m: field coordinates = world + drift), coverage over the
 * land and over the sea (0..1), streets (0..1), vertical development (x the clouds' heights),
 * threshold (field units, the preset's calibration), depth (m: the layer's base to top).
 */
export const FIELD = { scale: 4500, drift: [0, 0], land: 0.12, sea: 0.12, streets: 0, vert: 1, threshold: 0, depth: 1000 };

/** Local radius factor and land fraction at field point (qx, qz) (m). */
function local(qx, qz, F, out) {
  const wx = qx - F.drift[0], wz = qz - F.drift[1];
  const landF = smoothstep(-7000, 7000, wx * COAST_N[0] + wz * COAST_N[1] + COAST_D);
  const dry = smoothstep(15000, 40000, wx);
  const cmax = Math.max(F.land, F.sea, 1e-3);
  const cov = F.sea + (F.land * (1 - 0.5 * dry) - F.sea) * landF;
  let g = Math.max(cov, 0) / cmax;
  g *= 0.55 + 0.9 * smoothstep(0.2, 0.8, valueNoise(qx / 21000 + 5.3, qz / 21000 + 1.7));
  const across = -wx * WIND_DIR[1] + wz * WIND_DIR[0], along = wx * WIND_DIR[0] + wz * WIND_DIR[1];
  const s = 0.5 + 0.5 * Math.cos(6.2832 * across / STREET_GAP + 1.4 * Math.sin(along / 13000));
  g *= 1 + (0.3 + 1.4 * s - 1) * F.streets;
  if (out) out.land = landF;
  return g;
}

/** One cell's cloud: centre, radius (m) for level L, cell (cx, cz), local factor g. */
function cellCloud(L, C, c, cx, cz, g, out) {
  const h = hash2u(cx + 7919 * L.salt, cz - 3571 * L.salt);
  const rx = (h & 255) / 255, rz = ((h >>> 8) & 255) / 255, ru = ((h >>> 16) & 255) / 255, rv = (h >>> 24) / 255;
  out.x = (cx + 0.5 + (rx - 0.5) * 0.5) * C;
  out.z = (cz + 0.5 + (rz - 0.5) * 0.5) * C;
  const pres = Math.min(L.pa + L.pb * c, 0.95);
  out.r = Math.min(C * L.r0 * Math.pow(2, rv * L.lr) * (1 + L.grow * c) * clamp01((pres - ru) * 8) * g, 0.72 * C);
  return out;
}

const _cell = { x: 0, z: 0, r: 0 };
const _loc = { land: 1 };

/** Signed distance (m) to the cloud footprints at field point (qx, qz) (m), positive inside. */
export function sdfAt(qx, qz, F = FIELD) {
  const g = local(qx, qz, F, null);
  const c = Math.max(F.land, F.sea);
  let best = -1e6;
  for (const L of LEVELS) {
    const C = F.scale * L.f;
    const bx = Math.floor(qx / C - 0.5), bz = Math.floor(qz / C - 0.5);
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const k = cellCloud(L, C, c, bx + i, bz + j, g, _cell);
        best = Math.max(best, k.r - Math.hypot(qx - k.x, qz - k.z));
      }
    }
  }
  return best;
}

/** Raw field value at a point given in feature units ((world + drift) / scale): sdf / scale. */
export function fieldAt(px, pz, F = FIELD) {
  return sdfAt(px * F.scale, pz * F.scale, F) / F.scale;
}

/**
 * The cloud at field point (qx, qz) as the cover map stores it (Clouds.js): signed distance (m),
 * the cloud's height above the base (m), its radius (m), its raggedness (0 billowy .. 1 fractus).
 * Where clouds meet, the values are weighted towards the deeper one (no crease in the tops).
 */
export function cloudAt(qx, qz, F = FIELD, out = {}) {
  const g = local(qx, qz, F, _loc);
  const c = Math.max(F.land, F.sea);
  let m = -1e6, sw = 0, sh = 0, sr = 0, sg = 0;
  for (let li = 0; li < LEVELS.length; li++) {
    const L = LEVELS[li];
    const C = F.scale * L.f;
    const bx = Math.floor(qx / C - 0.5), bz = Math.floor(qz / C - 0.5);
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const k = cellCloud(L, C, c, bx + i, bz + j, g, _cell);
        const d = k.r - Math.hypot(qx - k.x, qz - k.z);
        const a = cellShape(li, bx + i, bz + j, k.r, _loc.land, F);
        // online soft maximum: weights exp((d - max) / 30 m)
        if (d > m) { const s = Math.exp((m - d) / 30); sw *= s; sh *= s; sr *= s; sg *= s; m = d; }
        const w = Math.exp((d - m) / 30);
        sw += w; sh += w * a.h; sr += w * k.r; sg += w * a.rag;
      }
    }
  }
  out.sdf = m; out.h = sh / sw; out.r = sr / sw; out.rag = sg / sw;
  return out;
}

const _shape = { h: 0, rag: 0 };
const RAG = [0, 0.3, 0.75];
// a cloud's height and raggedness from a second hash: humilis to mediocris (height 0.5-1.15 x the
// radius), now and then a congestus among the big ones (twice as tall); flatter over the sea and
// early in the day (FIELD.vert); the small ones are ragged fragments
function cellShape(li, cx, cz, r, landF, F) {
  const h = hash2u(cx + 12011 * (li + 1), cz + 7193 * (li + 1));
  const a = (h & 255) / 255, b = ((h >>> 8) & 255) / 255;
  let asp = (0.5 + 0.65 * a) * F.vert * (0.7 + 0.3 * landF);
  if (li === 0 && a > 0.93) asp *= 2.0;
  _shape.h = Math.min(r * asp, F.depth);
  _shape.rag = Math.min(1, RAG[li] + 0.25 * b);
  return _shape;
}

/** Width of a cloud's soft edge in field units (atmoCloudCover uses the same). */
export const EDGE = 0.02;

/** 0..1: inside a cloud's footprint at world (x, z); layer = {threshold, scale}, wind = [x, z] drift. */
export function coverAt(x, z, layer, wind) {
  const v = fieldAt((x + wind[0]) / layer.scale, (z + wind[1]) / layer.scale);
  return smoothstep(layer.threshold, layer.threshold + EDGE, v);
}

/**
 * Field value above which a point is cloud, for a covered fraction of the land: the quantile of the
 * field's values over a large area (the levels' discs give roughly the coverage already; this trims
 * it), with the field's parameters F (give it the afternoon's) but the land everywhere.
 */
export function thresholdFor(coverage, F = FIELD) {
  const G = { ...F, drift: [0, 0], land: F.land, sea: F.land };
  // 16000 scattered points west of the dry east (the land and the sea alike in G), over 600 x 600
  // km: many of the clusters' 21 km cells, so the quantile is the field's, not a neighbourhood's
  const n = 16000, a = new Float32Array(n);
  for (let k = 0; k < n; k++) a[k] = sdfAt(-600000 * hash2(k, 11), (hash2(k, 12) - 0.5) * 600000, G) / G.scale;
  a.sort();
  const c = Math.min(0.98, Math.max(0.01, coverage));
  // the soft edge counts half
  const q = a[Math.min(a.length - 1, Math.floor((1 - c) * a.length))];
  return q - EDGE * 0.5;
}

/** Sun transmittance through the cumulus layer at a world point (the CPU twin of atmoCloudShadow). */
export function shadowAt(x, y, z, sun, layer, wind) {
  if (!layer || !(layer.opticalDepth > 0) || y > layer.top) return 1;
  const mid = 0.5 * (layer.base + layer.top);
  const sy = Math.max(sun.y, 0.06);
  const k = (mid - y) / sy;
  const c = coverAt(x + sun.x * k, z + sun.z * k, layer, wind);
  return Math.exp(-layer.opticalDepth * c);
}

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * The field in GLSL, for a prefix P and the names of its three uniforms (vec4 each):
 *   layer  base, top (m MSL), threshold (field units), optical depth (0: no clouds)
 *   wind   drift x, z (m), scale (m), -
 *   field  coverage over the land, over the sea, streets (0..1), vertical development
 * Defines P+'HashU', P+'Hash2', P+'ValueNoise', P+'CloudLocal', P+'CloudCell', P+'CloudLevel',
 * P+'CloudSdf', P+'CloudField'.
 */
export function cloudFieldGLSL(P, layer, wind, field) {
  const level = (li) => {
    const L = LEVELS[li];
    return `${P}CloudLevel(q, S * ${f(L.f)}, ${f(L.r0)}, ${L.lr.toFixed(6)}, 1.0 + ${f(L.grow)} * c, min(${f(L.pa)} + ${f(L.pb)} * c, 0.95), ${L.salt}, g)`;
  };
  let s = /* glsl */`
uint ${P}HashU(ivec2 p) {
  uvec2 q = uvec2(p);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = h * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return h;
}
float ${P}Hash2(ivec2 p) { return float(${P}HashU(p)) * (1.0 / 4294967295.0); }
float ${P}ValueNoise(vec2 x) {
  vec2 i = floor(x), f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = ${P}Hash2(c), b = ${P}Hash2(c + ivec2(1, 0)), d = ${P}Hash2(c + ivec2(0, 1)), e = ${P}Hash2(c + ivec2(1, 1));
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
// the radius factor at field point q (m): land and sea, drier east, clusters, streets
float ${P}CloudLocal(vec2 q, out float landF) {
  vec2 w = q - ${wind}.xy;
  landF = smoothstep(-7000.0, 7000.0, dot(w, vec2(${COAST_N[0]}, ${COAST_N[1]})) + ${f(COAST_D)});
  float dry = smoothstep(15000.0, 40000.0, w.x);
  float cmax = max(max(${field}.x, ${field}.y), 1e-3);
  float cov = mix(${field}.y, ${field}.x * (1.0 - 0.5 * dry), landF);
  float g = max(cov, 0.0) / cmax;
  g *= 0.55 + 0.9 * smoothstep(0.2, 0.8, ${P}ValueNoise(q / 21000.0 + vec2(5.3, 1.7)));
  float across = dot(w, vec2(${-WIND_DIR[1]}, ${WIND_DIR[0]})), along = dot(w, vec2(${WIND_DIR[0]}, ${WIND_DIR[1]}));
  float st = 0.5 + 0.5 * cos(6.2832 * across / ${f(STREET_GAP)} + 1.4 * sin(along / 13000.0));
  return g * (1.0 + (0.3 + 1.4 * st - 1.0) * ${field}.z);
}
// one cell's cloud of a level: centre (m) and radius (m); h: the cell's hash
vec3 ${P}CloudCell(ivec2 cell, float C, float r0, float lr, float grow, float pres, int salt, float g, out uint h) {
  h = ${P}HashU(cell + ivec2(7919 * salt, -3571 * salt));
  vec4 r = vec4(uvec4(h, h >> 8u, h >> 16u, h >> 24u) & 255u) / 255.0;
  vec2 ctr = (vec2(cell) + 0.5 + (r.xy - 0.5) * 0.5) * C;
  float rad = min(C * r0 * exp2(r.w * lr) * grow * clamp((pres - r.z) * 8.0, 0.0, 1.0) * g, 0.72 * C);
  return vec3(ctr, rad);
}
// a level's union: the 2 x 2 cells whose centres surround q
float ${P}CloudLevel(vec2 q, float C, float r0, float lr, float grow, float pres, int salt, float g) {
  ivec2 b = ivec2(floor(q / C - 0.5));
  float best = -1e6;
  uint h;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec3 k = ${P}CloudCell(b + ivec2(i, j), C, r0, lr, grow, pres, salt, g, h);
      best = max(best, k.z - length(q - k.xy));
    }
  }
  return best;
}
// signed distance (m) to the footprints at field point q (m: world xz + drift), positive inside
float ${P}CloudSdf(vec2 q) {
  float landF;
  float g = ${P}CloudLocal(q, landF);
  float c = max(${field}.x, ${field}.y);
  float S = ${wind}.z;
  float d = ${level(0)};
  d = max(d, ${level(1)});
  d = max(d, ${level(2)});
  return d;
}
// raw field value at a point in feature units ((world xz + drift) / scale)
float ${P}CloudField(vec2 p) { return ${P}CloudSdf(p * ${wind}.z) / ${wind}.z; }
`;
  return s;
}

/**
 * The cover map's GLSL (js/env/Clouds.js; needs cloudFieldGLSL with the same names first):
 * P+'CloudMap'(q, levels) = (signed distance m, the cloud's height above the base m, its radius m,
 * raggedness), the twin of cloudAt above; levels 2 leaves out the small puffs (the far map).
 */
export function cloudMapGLSL(P, layer, wind, field) {
  return /* glsl */`
// the cover map's values at field point q (m): signed distance (m), the cloud's height above the
// base (m), its radius (m), raggedness; levels: 2 leaves out the small puffs (the far map)
void ${P}CloudMapLevel(vec2 q, int li, float C, float r0, float lr, float grow, float pres, float g, float landF, inout float m, inout vec4 acc) {
  ivec2 b = ivec2(floor(q / C - 0.5));
  uint h;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      ivec2 cell = b + ivec2(i, j);
      vec3 k = ${P}CloudCell(cell, C, r0, lr, grow, pres, li, g, h);
      float d = k.z - length(q - k.xy);
      uint h2 = ${P}HashU(cell + ivec2(12011 * (li + 1), 7193 * (li + 1)));
      float a = float(h2 & 255u) / 255.0, bb = float((h2 >> 8u) & 255u) / 255.0;
      float asp = (0.5 + 0.65 * a) * ${field}.w * (0.7 + 0.3 * landF);
      if (li == 0 && a > 0.93) asp *= 2.0;
      float hc = min(k.z * asp, ${layer}.y - ${layer}.x);
      float rag = min(1.0, (li == 0 ? 0.0 : (li == 1 ? 0.3 : 0.75)) + 0.25 * bb);
      if (d > m) { float sc = exp((m - d) / 30.0); acc *= sc; m = d; }
      float w = exp((d - m) / 30.0);
      acc += w * vec4(1.0, hc, k.z, rag);
    }
  }
}
vec4 ${P}CloudMap(vec2 q, float levels) {
  float landF;
  float g = ${P}CloudLocal(q, landF);
  float c = max(${field}.x, ${field}.y);
  float S = ${wind}.z;
  float m = -1e6;
  vec4 acc = vec4(0.0);
${[0, 1, 2].map((li) => {
    const L = LEVELS[li];
    const call = `${P}CloudMapLevel(q, ${li}, S * ${f(L.f)}, ${f(L.r0)}, ${L.lr.toFixed(6)}, 1.0 + ${f(L.grow)} * c, min(${f(L.pa)} + ${f(L.pb)} * c, 0.95), g, landF, m, acc);`;
    return li === 2 ? `  if (levels > 2.5) ${call}` : `  ${call}`;
  }).join('\n')}
  return vec4(m, acc.yzw / acc.x);
}
`;
}
