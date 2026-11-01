// The terrain's generated ground textures, all in one texture array (one sampler unit, see
// terrainShaders.js): ground materials for the land cover classes at 2 to 64 m per tile,
// the old "macro" detail, the water wave map and the runway designation glyphs. Every layer
// is made on the GPU at startup from periodic noise (nothing is downloaded).
//
// Material layers ("relief" layers) are made in two passes: the first writes a height field
// (metres), an albedo pattern and a mask; the second turns the heights into slopes. Texel:
//   R, G  slope dh/dx, dh/dz (m / m) as 0.5 + slope * SLOPE_SCALE
//   B     albedo pattern, 0.5 = the material's mean colour (the shader keeps the mean)
//   A     mask (what the layer's comment says: tufts, shrubs, cracks, crowns ...)
// The shader samples layer L at world xz / DETAIL_LAYERS[L].tile (seamless: the camera-
// relative coordinate it uses is exact modulo 256 m, and every tile size divides 256 m).

import * as THREE from 'three';

export const DETAIL_SIZE = 512;
export const SLOPE_SCALE = 0.25;

/** Layer index -> tile size (m). Indices are #defined in the terrain shader (DL_*). */
export const DETAIL_LAYERS = {
  MACRO: { index: 0, tile: 256 },   // R grass / crops, G canopy, B rock, A built-up (luminance)
  WATER: { index: 1, tile: 64 },    // RG wave slope, B crest
  GLYPHS: { index: 2, tile: 0 },    // runway digits and letters, 4 x 4 cells
  SOIL: { index: 3, tile: 4 },      // ploughed / bare soil: clods, crust, pebbles (A = pebbles)
  GRASS: { index: 4, tile: 4 },     // dry grass tufts on soil (A = tufts)
  SHRUB: { index: 5, tile: 16 },    // garrigue cushions among stones (A = shrubs)
  ROCK: { index: 6, tile: 16 },     // limestone karst: blocks, cracks, pits (A = cracks)
  SAND: { index: 7, tile: 8 },      // wind ripples (A = crest)
  SALT: { index: 8, tile: 16 },     // salt crust polygons with ridges (A = mud cracks)
  URBAN: { index: 9, tile: 16 },    // slabs, asphalt patches, stains, cracks (A = seams)
  CANOPY: { index: 10, tile: 64 },  // tree crowns ~5 m with gaps (A = crown cover)
  LEAF: { index: 11, tile: 2 },     // leafy crop plants (A = leaf cover)
  STRAW: { index: 12, tile: 2 },    // stubble and loose straw (A = straw)
};
export const DETAIL_LAYER_COUNT = 13;

/** Runway glyph cells in the GLYPHS layer: "0123456789LRC" in a 4 x 4 grid. */
export const GLYPHS = '0123456789LRC';
export const GLYPH_GRID = 4;

const PASS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// periodic noise for the generated textures (uv in 0..1 wraps at integer frequencies)
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// value noise on a lattice that wraps every 'per' cells
float pnoise(vec2 x, float per) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, per));
  float b = hash12(mod(i + vec2(1.0, 0.0), per));
  float c = hash12(mod(i + vec2(0.0, 1.0), per));
  float d = hash12(mod(i + vec2(1.0, 1.0), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// the same with its own period per axis (anisotropic patterns: uv * per must wrap on both)
float pnoise2(vec2 x, vec2 per) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, per));
  float b = hash12(mod(i + vec2(1.0, 0.0), per));
  float c = hash12(mod(i + vec2(0.0, 1.0), per));
  float d = hash12(mod(i + vec2(1.0, 1.0), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 uv, float f, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    s += a * pnoise(uv * f + float(o) * 17.13, f);
    n += a; a *= 0.5; f *= 2.0;
  }
  return s / n;
}
// cellular noise (distance to the nearest feature point), periodic
vec2 pworley(vec2 x, float per) {
  vec2 i = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    vec2 g = vec2(float(xx), float(y));
    vec2 o = hash22(mod(i + g, per));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return vec2(d1, d2);
}
// cellular noise with the nearest cell's random value: (F1, F2, hash), periodic
vec3 pcell(vec2 x, float per) {
  vec2 i = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    vec2 g = vec2(float(xx), float(y));
    vec2 c = mod(i + g, per);
    vec2 o = hash22(c);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; id = hash12(c + 71.3); } else if (d < d2) { d2 = d; }
  }
  return vec3(d1, d2, id);
}
// nearest cell: offset to its feature point (vec2) and its random value, periodic
vec3 pnear(vec2 x, float per) {
  vec2 i = floor(x), f = fract(x);
  float d1 = 8.0; vec3 best = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    vec2 g = vec2(float(xx), float(y));
    vec2 c = mod(i + g, per);
    vec2 r = g + hash22(c) - f;
    float d = dot(r, r);
    if (d < d1) { d1 = d; best = vec3(r, hash12(c + 13.7)); }
  }
  return best;
}
`;

// Pass 1 of the relief layers: (height m, albedo pattern, mask) for layer uLayer at uv.
const RELIEF_FRAG = /* glsl */ `
varying vec2 vUv;
uniform int uLayer;
uniform float uTile;
${NOISE_GLSL}

void soil(vec2 uv, out float h, out float a, out float m) {
  // clods 5-25 cm on a crusted surface, a few pale pebbles
  vec3 c = pcell(uv * 22.0, 22.0);
  float clod = sqrt(max(0.0, 1.0 - c.x * c.x * 1.6)) * (0.5 + 0.5 * c.z);
  vec3 c2 = pcell(uv * 57.0, 57.0);
  float small = sqrt(max(0.0, 1.0 - c2.x * c2.x * 2.0));
  vec3 pb = pcell(uv * 41.0, 41.0);
  float pebble = smoothstep(0.32, 0.22, pb.x) * step(0.84, pb.z);
  float crust = pfbm(uv, 32.0, 4);
  h = 0.035 * clod + 0.012 * small + 0.006 * crust + 0.01 * pebble;
  a = 0.42 + 0.22 * clod + 0.08 * small + 0.12 * (crust - 0.5) + 0.25 * pebble;
  m = pebble;
}

void grass(vec2 uv, out float h, out float a, out float m) {
  // dry annual grass: tufts 10-30 cm, some bigger clumps, soil and litter between
  vec2 w = pworley(uv * 18.0, 18.0);
  float tuft = smoothstep(0.62, 0.18, w.x);
  vec2 w2 = pworley(uv * 47.0 + 0.3, 47.0);
  float fine = smoothstep(0.55, 0.15, w2.x);
  float patchy = pfbm(uv + 0.37, 8.0, 3);
  float cover = clamp(tuft * (0.55 + 0.6 * patchy) + 0.45 * fine * patchy, 0.0, 1.0);
  // (each axis wraps with its own frequency, or the tile edges would show as a grid of lines)
  float blades = pnoise2(uv * vec2(256.0, 64.0), vec2(256.0, 64.0)) * pnoise2(uv * vec2(64.0, 256.0) + 0.5, vec2(64.0, 256.0));
  h = 0.05 * cover + 0.01 * blades;
  a = mix(0.34 + 0.08 * pfbm(uv, 64.0, 2), 0.6 + 0.18 * blades, cover);
  m = cover;
}

void shrub(vec2 uv, out float h, out float a, out float m) {
  // garrigue / batha: rounded cushions 0.4-1.6 m, grey-white stones and soil between
  vec3 c = pcell(uv * 13.0, 13.0);
  float r = 0.28 + 0.24 * c.z;
  float present = step(0.3, c.z) * smoothstep(0.25, 0.6, pfbm(uv + 0.71, 4.0, 3) + 0.2);
  float dome = sqrt(max(0.0, 1.0 - (c.x / r) * (c.x / r))) * present;
  float leaf = pfbm(uv, 96.0, 3);
  vec3 st = pcell(uv * 37.0, 37.0);
  float stone = smoothstep(0.45, 0.25, st.x) * step(0.55, st.z) * (1.0 - step(0.01, dome));
  h = 0.55 * dome * (0.85 + 0.3 * leaf) + 0.06 * stone;
  float cover = smoothstep(0.0, 0.25, dome);
  a = mix(0.56 + 0.14 * pfbm(uv, 24.0, 3) + 0.22 * stone, 0.22 + 0.22 * leaf + 0.1 * dome, cover);
  m = cover;
}

void rock(vec2 uv, out float h, out float a, out float m) {
  // karst limestone: blocks split by solution cracks, rough fluted surface, pits, lichen
  vec3 c = pcell(uv * 5.0, 5.0);
  float crack = 1.0 - smoothstep(0.02, 0.09, c.y - c.x);
  vec3 c2 = pcell(uv * 13.0 + 0.4, 13.0);
  float crack2 = 1.0 - smoothstep(0.015, 0.05, c2.y - c2.x);
  float rough = 1.0 - abs(2.0 * pfbm(uv + 0.11, 12.0, 5) - 1.0);
  vec2 pit = pworley(uv * 29.0, 29.0);
  float pits = smoothstep(0.25, 0.05, pit.x);
  float lichen = smoothstep(0.55, 0.75, pfbm(uv + 0.9, 24.0, 4));
  float top = 0.25 * c.z;
  h = top + 0.12 * rough - 0.3 * crack - 0.08 * crack2 - 0.03 * pits;
  a = 0.6 + 0.16 * rough + 0.1 * (c.z - 0.5) - 0.3 * crack - 0.12 * crack2 - 0.1 * pits - 0.18 * lichen;
  m = max(crack, crack2 * 0.6);
}

void sand(vec2 uv, out float h, out float a, out float m) {
  // wind ripples ~15 cm apart, crests running along z (wind from the west), sinuous and
  // forking; asymmetric profile (gentle stoss, steep lee)
  float warp = 2.0 * (pfbm(uv, 4.0, 3) - 0.5) + 0.5 * (pfbm(uv + 0.5, 16.0, 2) - 0.5);
  float ph = uv.x * 52.0 + warp * 2.0;
  float f = fract(ph);
  float prof = f < 0.7 ? f / 0.7 : (1.0 - f) / 0.3;
  prof = smoothstep(0.0, 1.0, prof);
  float big = pfbm(uv + 0.23, 2.0, 2);
  h = 0.012 * prof + 0.05 * big;
  a = 0.5 + 0.09 * (prof - 0.5) - 0.07 * smoothstep(0.15, 0.0, prof) + 0.06 * (pfbm(uv, 64.0, 2) - 0.5);
  m = prof;
}

void salt(vec2 uv, out float h, out float a, out float m) {
  // Dead Sea shore: salt crust in polygons 1-3 m with pressure ridges; cracked mud (A)
  vec3 c = pcell(uv * 8.0, 8.0);
  float ridge = 1.0 - smoothstep(0.0, 0.12, c.y - c.x);
  float crust = pfbm(uv, 48.0, 3);
  vec3 m2 = pcell(uv * 61.0, 61.0);
  float crack = 1.0 - smoothstep(0.0, 0.06, m2.y - m2.x);
  h = 0.06 * ridge + 0.01 * crust + 0.02 * c.z;
  a = 0.5 + 0.22 * ridge + 0.1 * (crust - 0.5) + 0.06 * (c.z - 0.5);
  m = crack;
}

void urban(vec2 uv, out float h, out float a, out float m) {
  // paving: 2 m slabs in places, asphalt elsewhere, stains, patches and cracks
  float slabs = smoothstep(0.45, 0.55, pfbm(uv + 0.3, 4.0, 3));
  vec2 g = fract(uv * 8.0);
  float seam = (1.0 - smoothstep(0.0, 0.025, min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y)))) * slabs;
  float stain = pfbm(uv + 0.6, 16.0, 5);
  vec3 c = pcell(uv * 6.0, 6.0);
  float crack = (1.0 - smoothstep(0.0, 0.02, c.y - c.x)) * step(0.5, pfbm(uv + 0.1, 8.0, 2));
  float patchy = step(0.82, c.z) * (1.0 - slabs);
  float grain = pnoise(uv * 256.0, 256.0);
  h = -0.01 * seam - 0.01 * crack + 0.004 * grain;
  a = 0.5 + 0.16 * (slabs - 0.5) + 0.22 * (stain - 0.5) - 0.18 * seam - 0.2 * crack - 0.1 * patchy + 0.06 * (grain - 0.5);
  m = max(seam, crack);
}

void canopy(vec2 uv, out float h, out float a, out float m) {
  // crowns 3-7 m (12 cells per 64 m), leaf clumps, gaps of soil and litter
  vec3 c = pcell(uv * 12.0, 12.0);
  float r = 0.36 + 0.14 * c.z;
  float d = c.x / r;
  float crown = sqrt(max(0.0, 1.0 - d * d));
  float clump = pfbm(uv, 96.0, 3);
  h = 4.0 * crown * (0.8 + 0.4 * clump);
  float cover = smoothstep(0.0, 0.2, crown);
  a = mix(0.62 + 0.1 * pfbm(uv, 32.0, 3), 0.3 + 0.25 * clump + 0.12 * crown, cover);
  m = cover;
}

void leaf(vec2 uv, out float h, out float a, out float m) {
  // leafy plants ~25 cm on a 2 m tile: overlapping leaf blobs with veins of shade
  vec3 c = pcell(uv * 9.0, 9.0);
  float plant = smoothstep(0.75, 0.2, c.x);
  vec3 l = pcell(uv * 31.0 + 0.5, 31.0);
  float lf = smoothstep(0.7, 0.1, l.x);
  float cover = clamp(plant * (0.6 + 0.6 * lf), 0.0, 1.0);
  h = 0.08 * plant + 0.02 * lf;
  a = mix(0.35, 0.5 + 0.3 * lf * (0.6 + 0.4 * l.z), cover);
  m = cover;
}

void straw(vec2 uv, out float h, out float a, out float m) {
  // cut stalks and loose straw: short bright strokes in random directions
  float s = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = 13.0 + 7.0 * float(k);
    vec3 n = pnear(uv * fk + float(k) * 0.37, fk);
    float ang = n.z * 6.2831;
    vec2 dir = vec2(cos(ang), sin(ang));
    float along = dot(n.xy, dir), across = dot(n.xy, vec2(-dir.y, dir.x));
    float len = 0.35 + 0.3 * fract(n.z * 7.3);
    float stroke = (1.0 - smoothstep(0.02, 0.05, abs(across))) * (1.0 - smoothstep(len * 0.8, len, abs(along)));
    s = max(s, stroke);
  }
  float stub = smoothstep(0.35, 0.1, pworley(uv * 60.0, 60.0).x);
  float cover = max(s, 0.7 * stub);
  h = 0.01 * cover;
  a = mix(0.38 + 0.08 * pfbm(uv, 32.0, 2), 0.72, cover);
  m = cover;
}

void main() {
  vec2 uv = vUv;
  float h = 0.0, a = 0.5, m = 0.0;
  if (uLayer == ${DETAIL_LAYERS.SOIL.index}) soil(uv, h, a, m);
  else if (uLayer == ${DETAIL_LAYERS.GRASS.index}) grass(uv, h, a, m);
  else if (uLayer == ${DETAIL_LAYERS.SHRUB.index}) shrub(uv, h, a, m);
  else if (uLayer == ${DETAIL_LAYERS.ROCK.index}) rock(uv, h, a, m);
  else if (uLayer == ${DETAIL_LAYERS.SAND.index}) sand(uv, h, a, m);
  else if (uLayer == ${DETAIL_LAYERS.SALT.index}) salt(uv, h, a, m);
  else if (uLayer == ${DETAIL_LAYERS.URBAN.index}) urban(uv, h, a, m);
  else if (uLayer == ${DETAIL_LAYERS.CANOPY.index}) canopy(uv, h, a, m);
  else if (uLayer == ${DETAIL_LAYERS.LEAF.index}) leaf(uv, h, a, m);
  else if (uLayer == ${DETAIL_LAYERS.STRAW.index}) straw(uv, h, a, m);
  gl_FragColor = vec4(h, a, m, 1.0);
}
`;

// Pass 2: slopes from the height pass (wrapping central differences).
const SLOPE_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform float uTexelM;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = ${DETAIL_SIZE};
  ivec2 l = ivec2((p.x + n - 1) % n, p.y), r = ivec2((p.x + 1) % n, p.y);
  ivec2 u = ivec2(p.x, (p.y + n - 1) % n), d = ivec2(p.x, (p.y + 1) % n);
  vec4 c = texelFetch(uSrc, p, 0);
  float hx = texelFetch(uSrc, r, 0).r - texelFetch(uSrc, l, 0).r;
  float hz = texelFetch(uSrc, d, 0).r - texelFetch(uSrc, u, 0).r;
  vec2 slope = vec2(hx, hz) / (2.0 * uTexelM);
  gl_FragColor = vec4(clamp(0.5 + slope * ${SLOPE_SCALE.toFixed(3)}, 0.0, 1.0), clamp(c.g, 0.0, 1.0), clamp(c.b, 0.0, 1.0));
}
`;

// The old detail texture (now 512^2 over 256 m): luminance patterns per class family.
const MACRO_FRAG = /* glsl */ `
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec2 uv = vUv;
  // R: vegetation micro variation: 4 m and 1 m grain plus 16 m patches
  float r = 0.55 * pfbm(uv, 64.0, 4) + 0.45 * pfbm(uv + 0.37, 16.0, 3);
  // G: canopy: crowns ~5 m with dark gaps
  vec2 w = pworley(uv * 52.0, 52.0);
  float crown = smoothstep(0.75, 0.15, w.x);
  float g = 0.18 + 0.75 * crown * (0.75 + 0.25 * pnoise(uv * 128.0, 128.0));
  g = mix(g, 0.5, 0.15) + 0.1 * (pfbm(uv, 32.0, 3) - 0.5);
  // B: rock and bare soil: ridged noise and stones
  float rn = 1.0 - abs(2.0 * pfbm(uv + 0.11, 24.0, 4) - 1.0);
  vec3 st = pcell(uv * 128.0, 128.0);
  float stone = smoothstep(0.42, 0.18, st.x) * (0.4 + 0.6 * st.z);
  float b = 0.28 + 0.38 * rn + 0.16 * pnoise(uv * 256.0, 256.0) + 0.2 * stone;
  // A: built-up: soft blotches from 8 m down to 1 m with a faint patchwork of ~2.5 m cells
  vec3 c2 = pcell(uv * 104.0, 104.0);
  float a = 0.5 + 0.7 * (pfbm(uv + 0.53, 32.0, 4) - 0.5) + 0.12 * (c2.z - 0.5);
  gl_FragColor = vec4(r, g, b, a);
}
`;

// Wave slopes for water: RG = slope x / z * 0.5 + 0.5, B = crest mask.
const WATER_FRAG = /* glsl */ `
varying vec2 vUv;
${NOISE_GLSL}
float waves(vec2 uv) {
  float h = 0.0, a = 0.5, f = 6.0;
  for (int o = 0; o < 6; o++) {
    h += a * pnoise(uv * f + float(o) * 0.31, f);
    a *= 0.55; f *= 2.0;
  }
  return h;
}
void main() {
  float e = 1.0 / ${DETAIL_SIZE}.0;
  float hx1 = waves(vUv + vec2(e, 0.0)), hx0 = waves(vUv - vec2(e, 0.0));
  float hz1 = waves(vUv + vec2(0.0, e)), hz0 = waves(vUv - vec2(0.0, e));
  vec2 slope = vec2(hx1 - hx0, hz1 - hz0) / (2.0 * e) * 0.012;
  float crest = smoothstep(0.62, 0.8, waves(vUv));
  gl_FragColor = vec4(clamp(slope * 0.5 + 0.5, 0.0, 1.0), crest, 1.0);
}
`;

const GLYPH_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uCanvas;
void main() { gl_FragColor = vec4(texture(uCanvas, vUv).r, 0.0, 0.0, 1.0); }
`;

/**
 * Runway designation glyphs in a 4 x 4 grid of square cells, white on black, in a heavy
 * condensed sans like the painted ones (each glyph fills the middle 60 % of its cell's width).
 */
function glyphCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const cell = size / GLYPH_GRID;
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < GLYPHS.length; i++) {
    const cx = (i % GLYPH_GRID + 0.5) * cell;
    const cy = (Math.floor(i / GLYPH_GRID) + 0.5) * cell;
    g.save();
    g.translate(cx, cy);
    // cell is square; the glyph box is 0.6 x 1.0 of it (the shader maps q into that box);
    // condensed like the painted numbers, which are tall and narrow
    g.scale(0.62, 1.0);
    g.font = `bold ${Math.round(cell * 1.12)}px "Arial Black", "Helvetica Neue", Arial, "DejaVu Sans", sans-serif`;
    g.fillText(GLYPHS[i], 0, cell * 0.04);
    g.restore();
  }
  return canvas;
}

let _scene = null, _mesh = null, _cam = null;
function runLayerPass(renderer, material, target, layer) {
  if (!_scene) {
    _scene = new THREE.Scene();
    _mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    _mesh.frustumCulled = false;
    _scene.add(_mesh);
    _cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  _mesh.material = material;
  const prev = renderer.getRenderTarget();
  const prevLayer = renderer.getActiveCubeFace();
  const prevXr = renderer.xr.enabled;
  renderer.xr.enabled = false;
  renderer.setRenderTarget(target, layer);
  renderer.render(_scene, _cam);
  renderer.setRenderTarget(prev, prevLayer);
  renderer.xr.enabled = prevXr;
}

/**
 * Builds the detail array: WebGLArrayRenderTarget (DETAIL_SIZE^2 x DETAIL_LAYER_COUNT,
 * RGBA8, repeat, mipmapped, anisotropic). document is needed for the glyph canvas; without
 * it (tests) the glyph layer stays black.
 */
export function makeDetailArray(renderer, anisotropy) {
  const N = DETAIL_SIZE;
  const rt = new THREE.WebGLArrayRenderTarget(N, N, DETAIL_LAYER_COUNT, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
  });
  rt.texture.anisotropy = anisotropy;
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.name = 'TerrainDetailArray';
  const float = renderer.extensions.has('EXT_color_buffer_float');
  const tmp = new THREE.WebGLRenderTarget(N, N, {
    type: float ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const common = { vertexShader: PASS_VERT, depthTest: false, depthWrite: false };
  const relief = new THREE.ShaderMaterial({
    ...common, fragmentShader: RELIEF_FRAG, uniforms: { uLayer: { value: 0 }, uTile: { value: 1 } },
  });
  const slope = new THREE.ShaderMaterial({
    ...common, fragmentShader: SLOPE_FRAG, uniforms: { uSrc: { value: tmp.texture }, uTexelM: { value: 1 } },
  });
  const macro = new THREE.ShaderMaterial({ ...common, fragmentShader: MACRO_FRAG });
  const water = new THREE.ShaderMaterial({ ...common, fragmentShader: WATER_FRAG });
  let glyphTex = null;
  const glyph = new THREE.ShaderMaterial({ ...common, fragmentShader: GLYPH_FRAG, uniforms: { uCanvas: { value: null } } });
  if (typeof document !== 'undefined') {
    glyphTex = new THREE.CanvasTexture(glyphCanvas(N));
    glyphTex.colorSpace = THREE.NoColorSpace;
    glyphTex.minFilter = THREE.LinearFilter;
    glyphTex.generateMipmaps = false;
    glyph.uniforms.uCanvas.value = glyphTex;
  }

  const L = DETAIL_LAYERS;
  const order = Object.keys(L);
  order.forEach((name, k) => {
    // mipmaps once, after the last layer (three regenerates them after every render)
    rt.texture.generateMipmaps = k === order.length - 1;
    const { index, tile } = L[name];
    if (name === 'MACRO') runLayerPass(renderer, macro, rt, index);
    else if (name === 'WATER') runLayerPass(renderer, water, rt, index);
    else if (name === 'GLYPHS') runLayerPass(renderer, glyph, rt, index);
    else {
      relief.uniforms.uLayer.value = index;
      relief.uniforms.uTile.value = tile;
      runLayerPass(renderer, relief, tmp, 0);
      slope.uniforms.uTexelM.value = tile / N;
      runLayerPass(renderer, slope, rt, index);
    }
  });
  for (const m of [relief, slope, macro, water, glyph]) m.dispose();
  glyphTex?.dispose();
  tmp.dispose();
  return rt;
}
