// The cumulus field: where the clouds are, the same numbers in JS and in GLSL, pure JS.
//
// One procedural 2D field (four octaves of value noise on an integer hash) decides where the
// cumulus stand. The GPU evaluates it in atmosphereGLSL.js (atmoCloudCover: the cloud shadows on
// the terrain, the coverage map the cloud renderer reads); this file is its exact twin for the CPU
// (the shadow on the jet, "is the camera inside a cloud", the coverage threshold of a preset). The
// hash works on 32-bit integers (Math.imul / >>> 0 here, uint in GLSL), so both sides agree.

const U32 = 1 / 4294967295;

/** Integer hash of a lattice point (PCG-style), 0..1. Must match atmoHash2 in atmosphereGLSL.js. */
export function hash2(ix, iz) {
  let h = (Math.imul(ix >>> 0, 1597334677) ^ Math.imul(iz >>> 0, 3812015801)) >>> 0;
  h = (Math.imul(h, 747796405) + 2891336453) >>> 0;
  h = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737) >>> 0;
  h = ((h >>> 22) ^ h) >>> 0;
  return h * U32;
}

function valueNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz;
}

/** Raw field value 0..1 at a point given in feature units ((world + wind) / scale). */
export function fieldAt(px, pz) {
  const v = 0.5 * valueNoise(px, pz) + 0.25 * valueNoise(px * 2.03 + 17.1, pz * 2.03 + 17.1)
    + 0.125 * valueNoise(px * 4.07 + 31.7, pz * 4.07 + 31.7) + 0.0625 * valueNoise(px * 8.13 + 7.3, pz * 8.13 + 7.3);
  return v / 0.9375;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Width of a cloud's soft edge in field units (atmoCloudCover uses the same). */
export const EDGE = 0.06;

/** 0..1: inside a cloud's footprint at world (x, z); layer = {threshold, scale}, wind = [x, z] offset. */
export function coverAt(x, z, layer, wind) {
  const v = fieldAt((x + wind[0]) / layer.scale, (z + wind[1]) / layer.scale);
  return smoothstep(layer.threshold, layer.threshold + EDGE, v);
}

/**
 * Field value above which a point is cloud, for a covered fraction of the sky: the quantile of the
 * field's distribution (measured once on a large grid; the field is not uniform, values cluster
 * around 0.5).
 */
let _sorted = null;
export function thresholdFor(coverage) {
  if (!_sorted) {
    const n = 96, a = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) a[j * n + i] = fieldAt(i * 0.731 + 0.13, j * 0.731 + 0.29);
    _sorted = a.sort();
  }
  const c = Math.min(0.98, Math.max(0.01, coverage));
  // the soft edge counts half
  const q = _sorted[Math.min(_sorted.length - 1, Math.floor((1 - c) * _sorted.length))];
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
