// Height data in memory (for physics and for the GPU), pure JS (runs in node tests).
//
// Core: 16 x 16 tiles of 257 x 257 samples (25 m, shared edges) assembled into one
// 4097 x 4097 grid. Far: 2049 x 2049 samples at 200 m. Encoding: h = v * 0.05 - 500.
//
// heightAt() reproduces the rendered surface exactly where the terrain mesh is at full
// resolution (always the case around the camera and the aircraft): the mesh vertices sit on
// the 25 m samples and every grid cell is split into two triangles along its NW-SE diagonal
// (from sample (i, j) to (i + 1, j + 1), i = column / east, j = row / south). Outside the core
// the rendered surface is the bilinear interpolation of the 200 m far grid.

export const CORE_HALF = 51200;
export const FAR_HALF = 204800;
export const TILE_M = 6400;
export const TILES = 16;
export const TILE_SAMPLES = 257;
export const CORE_N = 4097;
export const FAR_N = 2049;
export const CORE_SPACING = 25;
export const FAR_SPACING = 200;
export const H_SCALE = 0.05;
export const H_OFFSET = -500;

/** Level-0 quadtree nodes are 1600 m (64 core samples); the root (level 8) is the far area. */
export const NODE0_M = 1600;
export const LEVELS = 9;

const decode = (v) => v * H_SCALE + H_OFFSET;

export class HeightField {
  constructor() {
    this.core = new Uint16Array(CORE_N * CORE_N);
    this.far = new Uint16Array(FAR_N * FAR_N);
    this.minMax = null; // per level: Float32Array [min, max] per node
  }

  /** Copies one core tile (Uint16Array of 257 x 257, row-major, row 0 = north). */
  setCoreTile(ix, iz, data) {
    if (data.length !== TILE_SAMPLES * TILE_SAMPLES) throw new Error(`tile ${ix},${iz}: ${data.length} samples`);
    const c0 = ix * (TILE_SAMPLES - 1), r0 = iz * (TILE_SAMPLES - 1);
    for (let r = 0; r < TILE_SAMPLES; r++) {
      const src = r * TILE_SAMPLES;
      this.core.set(data.subarray(src, src + TILE_SAMPLES), (r0 + r) * CORE_N + c0);
    }
  }

  setFar(data) {
    if (data.length !== FAR_N * FAR_N) throw new Error(`far.bin: ${data.length} samples`);
    this.far.set(data);
  }

  /** Core sample (column i east, row j south), metres. */
  coreSample(i, j) { return decode(this.core[j * CORE_N + i]); }
  farSample(i, j) { return decode(this.far[j * FAR_N + i]); }

  static inCore(x, z) {
    return x >= -CORE_HALF && x <= CORE_HALF && z >= -CORE_HALF && z <= CORE_HALF;
  }

  /** Terrain height (m MSL) at world x, z; matches the rendered full-resolution mesh. */
  heightAt(x, z) {
    if (HeightField.inCore(x, z)) {
      const gx = (x + CORE_HALF) / CORE_SPACING, gz = (z + CORE_HALF) / CORE_SPACING;
      let i = Math.floor(gx), j = Math.floor(gz);
      if (i >= CORE_N - 1) i = CORE_N - 2;
      if (j >= CORE_N - 1) j = CORE_N - 2;
      const fx = gx - i, fz = gz - j;
      const k = j * CORE_N + i, c = this.core;
      const ha = decode(c[k]), hd = decode(c[k + CORE_N + 1]);
      if (fx >= fz) {
        const hb = decode(c[k + 1]);
        return ha + fx * (hb - ha) + fz * (hd - hb);
      }
      const hc = decode(c[k + CORE_N]);
      return ha + fz * (hc - ha) + fx * (hd - hc);
    }
    return this.farHeightAt(x, z);
  }

  /** Bilinear height on the far grid (clamped to the far area). */
  farHeightAt(x, z) {
    const gx = Math.min(FAR_N - 1, Math.max(0, (x + FAR_HALF) / FAR_SPACING));
    const gz = Math.min(FAR_N - 1, Math.max(0, (z + FAR_HALF) / FAR_SPACING));
    let i = Math.floor(gx), j = Math.floor(gz);
    if (i >= FAR_N - 1) i = FAR_N - 2;
    if (j >= FAR_N - 1) j = FAR_N - 2;
    const fx = gx - i, fz = gz - j;
    const k = j * FAR_N + i, f = this.far;
    const h00 = decode(f[k]), h10 = decode(f[k + 1]);
    const h01 = decode(f[k + FAR_N]), h11 = decode(f[k + FAR_N + 1]);
    return (h00 + (h10 - h00) * fx) * (1 - fz) + (h01 + (h11 - h01) * fx) * fz;
  }

  /** Geometric surface normal at x, z (the triangle's normal in the core). */
  normalAt(x, z, out) {
    let dhdx, dhdz;
    if (HeightField.inCore(x, z)) {
      const gx = (x + CORE_HALF) / CORE_SPACING, gz = (z + CORE_HALF) / CORE_SPACING;
      let i = Math.floor(gx), j = Math.floor(gz);
      if (i >= CORE_N - 1) i = CORE_N - 2;
      if (j >= CORE_N - 1) j = CORE_N - 2;
      const fx = gx - i, fz = gz - j;
      const k = j * CORE_N + i, c = this.core;
      const ha = decode(c[k]), hd = decode(c[k + CORE_N + 1]);
      if (fx >= fz) {
        const hb = decode(c[k + 1]);
        dhdx = (hb - ha) / CORE_SPACING; dhdz = (hd - hb) / CORE_SPACING;
      } else {
        const hc = decode(c[k + CORE_N]);
        dhdz = (hc - ha) / CORE_SPACING; dhdx = (hd - hc) / CORE_SPACING;
      }
    } else {
      const e = 1;
      dhdx = (this.farHeightAt(x + e, z) - this.farHeightAt(x - e, z)) / (2 * e);
      dhdz = (this.farHeightAt(x, z + e) - this.farHeightAt(x, z - e)) / (2 * e);
    }
    const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
    if (out && out.set) return out.set(-dhdx * inv, inv, -dhdz * inv);
    out = out || {};
    out.x = -dhdx * inv; out.y = inv; out.z = -dhdz * inv;
    return out;
  }

  /**
   * Min / max height of every quadtree node at every level (level 0 = 1600 m nodes,
   * 256 x 256 of them over the far area; level 8 = the root). Far nodes get a margin
   * because the core boundary samples (core data) can differ a little from the far grid.
   */
  buildMinMax() {
    const levels = [];
    const n0 = (2 * FAR_HALF) / NODE0_M; // 256
    const l0 = new Float32Array(n0 * n0 * 2);
    const coreFirst = (FAR_HALF - CORE_HALF) / NODE0_M; // 96
    const coreNodes = (2 * CORE_HALF) / NODE0_M; // 64
    const sPer = NODE0_M / CORE_SPACING; // 64 core samples per node
    const fPer = NODE0_M / FAR_SPACING; // 8 far samples per node
    for (let J = 0; J < n0; J++) {
      for (let I = 0; I < n0; I++) {
        let mn = Infinity, mx = -Infinity;
        const ci = I - coreFirst, cj = J - coreFirst;
        if (ci >= 0 && ci < coreNodes && cj >= 0 && cj < coreNodes) {
          for (let j = cj * sPer; j <= cj * sPer + sPer; j++) {
            const row = j * CORE_N;
            for (let i = ci * sPer; i <= ci * sPer + sPer; i++) {
              const v = this.core[row + i];
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
          }
          mn = decode(mn); mx = decode(mx);
        } else {
          for (let j = J * fPer; j <= J * fPer + fPer; j++) {
            const row = j * FAR_N;
            for (let i = I * fPer; i <= I * fPer + fPer; i++) {
              const v = this.far[row + i];
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
          }
          mn = decode(mn) - 30; mx = decode(mx) + 30;
        }
        l0[(J * n0 + I) * 2] = mn;
        l0[(J * n0 + I) * 2 + 1] = mx;
      }
    }
    levels.push(l0);
    for (let k = 1; k < LEVELS; k++) {
      const prev = levels[k - 1], np = n0 >> (k - 1), n = n0 >> k;
      const cur = new Float32Array(n * n * 2);
      for (let J = 0; J < n; J++) {
        for (let I = 0; I < n; I++) {
          let mn = Infinity, mx = -Infinity;
          for (let dj = 0; dj < 2; dj++) {
            for (let di = 0; di < 2; di++) {
              const q = ((2 * J + dj) * np + (2 * I + di)) * 2;
              if (prev[q] < mn) mn = prev[q];
              if (prev[q + 1] > mx) mx = prev[q + 1];
            }
          }
          cur[(J * n + I) * 2] = mn;
          cur[(J * n + I) * 2 + 1] = mx;
        }
      }
      levels.push(cur);
    }
    this.minMax = levels;
    return levels;
  }

  /** [min, max] of node (I, J) at level k. */
  nodeMinMax(k, I, J) {
    const n = 256 >> k;
    const a = this.minMax[k];
    return [a[(J * n + I) * 2], a[(J * n + I) * 2 + 1]];
  }
}
