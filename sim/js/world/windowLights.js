// Which windows are lit at night (js/world/Buildings.js, buildingShaders.js): two small textures
// of window cells, one for homes and one for offices, so a facade's lighting is right at every
// distance.
//
// A facade's windows are the cells of its bay x floor grid (buildingShaders.js: g = facade metres
// / (bay, floor height)). One texel of these textures is one cell; a building reads them at an
// offset of its own (its seed for the rows, the seed and the wall's direction for the columns), so
// neighbours and the sides of one building differ. Each channel is the set of windows lit at one
// lit fraction (LIT_THRESHOLDS: R the fewest .. A the most); the sets are nested (a window lit at
// 25 % stays lit at 45 %), and the shader interpolates between the channels for the fraction of the
// hour and the building (litShare in WINDOW_LIGHTS_GLSL). The mipmaps (box filtered by the GPU)
// hold the share of lit windows over 2x2, 4x4 .. cells: sampled with the facade's own derivatives
// (textureGrad, anisotropic), a window a few pixels big is lit or dark, a far facade gets exactly
// its share of lit windows, and nothing sparkles or makes moire in between.
//
// Homes: apartments (runs of 2-4 bays on a floor) are lit or dark as a whole, with their rooms
// varying a little. Offices: whole floors and tenants' sections (runs of 4-17 bays) are lit or
// dark, a few desks apart; every wall of a building reads the same rows, so a lit floor runs
// around the building.

import * as THREE from 'three';

export const LIT_SIZE = 256;
/** The lit fraction of each channel (R, G, B, A), homes and offices. */
export const LIT_THRESHOLDS = { homes: [0.1, 0.25, 0.42, 0.62], offices: [0.06, 0.18, 0.4, 0.66] };

/** mulberry32: a small deterministic generator (the same textures on every machine). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scores per cell (lower: lit sooner), row by row (a row is a floor). */
function scores(kind, seed) {
  const N = LIT_SIZE, R = rng(seed), S = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    if (kind === 'homes') {
      for (let i = 0; i < N;) {
        const w = [2, 2, 3, 3, 3, 4][Math.floor(R() * 6)];
        const a = R();
        for (let k = 0; k < w && i < N; k++, i++) S[j * N + i] = 0.66 * a + 0.34 * R();
      }
    } else {
      const f = R();
      for (let i = 0; i < N;) {
        const w = 4 + Math.floor(R() * 14);
        const t = R();
        for (let k = 0; k < w && i < N; k++, i++) S[j * N + i] = 0.52 * f + 0.38 * t + 0.1 * R();
      }
    }
  }
  return S;
}

/** RGBA8 lit masks: channel c is 255 where the cell's rank is below LIT_THRESHOLDS[kind][c]. */
export function litMaskData(kind, seed = kind === 'homes' ? 0x51A7 : 0x0FF1CE) {
  const N = LIT_SIZE, S = scores(kind, seed), T = LIT_THRESHOLDS[kind];
  // ranks (the share of cells with a lower score): exactly uniform, so each channel's mean is its
  // threshold and the mipmaps' last level is the city's mean
  const order = new Uint32Array(N * N);
  for (let k = 0; k < order.length; k++) order[k] = k;
  order.sort((a, b) => S[a] - S[b]);
  const data = new Uint8Array(N * N * 4);
  for (let r = 0; r < order.length; r++) {
    const q = (r + 0.5) / order.length, o = order[r] * 4;
    for (let c = 0; c < 4; c++) data[o + c] = q < T[c] ? 255 : 0;
  }
  return data;
}

/** The two textures (homes, offices): repeat, nearest when magnified, mipmapped and anisotropic. */
export function makeLitTextures(renderer) {
  const aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 1);
  const make = (kind) => {
    const t = new THREE.DataTexture(litMaskData(kind), LIT_SIZE, LIT_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.name = `windowLights_${kind}`;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = aniso;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { homes: make('homes'), offices: make('offices') };
}

const v4 = (a) => `vec4(${a.map((x) => x.toFixed(3)).join(', ')})`;

/**
 * GLSL: the samplers and litShare(m, T, p), the share of lit windows in a texel m of a mask for
 * lit fraction p (piecewise linear through the channels' thresholds T; 0 at p = 0, 1 at p = 1).
 * One return (HLSL through ANGLE).
 */
export const WINDOW_LIGHTS_GLSL = /* glsl */ `
uniform sampler2D uLitHomes;
uniform sampler2D uLitOffices;
const vec4 LIT_T_HOMES = ${v4(LIT_THRESHOLDS.homes)};
const vec4 LIT_T_OFFICES = ${v4(LIT_THRESHOLDS.offices)};
float litShare(vec4 m, vec4 T, float p) {
  float r = mix(m.w, 1.0, clamp((p - T.w) / (1.0 - T.w), 0.0, 1.0));
  if (p < T.w) r = mix(m.z, m.w, (p - T.z) / (T.w - T.z));
  if (p < T.z) r = mix(m.y, m.z, (p - T.y) / (T.z - T.y));
  if (p < T.y) r = mix(m.x, m.y, (p - T.x) / (T.y - T.x));
  if (p < T.x) r = m.x * max(p, 0.0) / T.x;
  return r;
}
`;
