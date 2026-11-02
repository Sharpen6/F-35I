// CDLOD quadtree selection (Strugar 2010, "Continuous Distance-Dependent Level of Detail"),
// pure JS. One quadtree covers the whole 409.6 km far area; level 0 nodes are 1600 m with
// 64 x 64 quads (25 m, the core data spacing), the root (level 8) is the far area.
//
// Each level k is drawn within a sphere of radius lodRange(k) around the camera. Vertices
// morph towards the next coarser grid between MORPH_START and MORPH_END of that range
// (see the vertex shader), so neighbouring patches of levels k and k + 1 meet without
// cracks and nothing pops. A patch is either a whole node (64 x 64 grid) or a quarter of a
// node drawn at the node's level (32 x 32 grid) where only some children need more detail.

import { FAR_HALF, NODE0_M, LEVELS, CORE_SPACING } from './HeightField.js';

export const GRID = 64;
export const RANGE0 = 3 * NODE0_M; // 4800 m
export const MORPH_START = 0.8;
export const MORPH_END = 0.98;
export const EARTH_R = 6371000;

export function lodRange(k) { return RANGE0 * 2 ** k; }

/** Morph factor of a level-k vertex at 3D distance d (identical to the vertex shader). */
export function morphFactor(k, d) {
  const r = lodRange(k);
  const t = (d - MORPH_START * r) / ((MORPH_END - MORPH_START) * r);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function distSqToBox(c, x0, y0, z0, x1, y1, z1) {
  const dx = c.x < x0 ? x0 - c.x : c.x > x1 ? c.x - x1 : 0;
  const dy = c.y < y0 ? y0 - c.y : c.y > y1 ? c.y - y1 : 0;
  const dz = c.z < z0 ? z0 - c.z : c.z > z1 ? c.z - z1 : 0;
  return dx * dx + dy * dy + dz * dz;
}

export class QuadTree {
  constructor(heightField) {
    this.hf = heightField;
    this.patches = [];
    this._pool = [];
    /**
     * LOD ranges times this (a coarser selection below 1: the Dead Sea's mirror, DeadSea.js);
     * the material drawing the patches must morph with the same ranges (uRange0).
     */
    this.rangeScale = 1;
  }

  /**
   * Selects the patches for a camera position {x, y, z}. `visible(x0, y0, z0, x1, y1, z1)`
   * (optional) is a frustum test against boxes that already include the curvature drop.
   * Returns an array of {x0, z0, size, level, half, originU: [ux, uz], stepU}; positions in
   * metres, originU / stepU in 25 m units counted from the far area's north-west corner.
   */
  select(cam, visible = null) {
    for (const p of this.patches) this._pool.push(p);
    this.patches.length = 0;
    this._cam = cam;
    this._visible = visible;
    this._node(LEVELS - 1, 0, 0);
    return this.patches;
  }

  _boxVisible(x0, z0, size, mn, mx) {
    if (!this._visible) return true;
    const c = this._cam;
    const x1 = x0 + size, z1 = z0 + size;
    const dx = c.x < x0 ? x0 - c.x : c.x > x1 ? c.x - x1 : 0;
    const dz = c.z < z0 ? z0 - c.z : c.z > z1 ? c.z - z1 : 0;
    const fx = Math.max(Math.abs(c.x - x0), Math.abs(c.x - x1));
    const fz = Math.max(Math.abs(c.z - z0), Math.abs(c.z - z1));
    const dMin2 = dx * dx + dz * dz, dMax2 = fx * fx + fz * fz;
    return this._visible(x0, mn - dMax2 / (2 * EARTH_R), z0, x1, mx - dMin2 / (2 * EARTH_R), z1);
  }

  _emit(x0, z0, size, level, half) {
    const p = this._pool.pop() || { originU: [0, 0] };
    p.x0 = x0; p.z0 = z0; p.size = size; p.level = level; p.half = half;
    p.originU[0] = Math.round((x0 + FAR_HALF) / CORE_SPACING);
    p.originU[1] = Math.round((z0 + FAR_HALF) / CORE_SPACING);
    p.stepU = 2 ** level;
    this.patches.push(p);
  }

  _node(k, I, J) {
    const size = NODE0_M * 2 ** k;
    const x0 = -FAR_HALF + I * size, z0 = -FAR_HALF + J * size;
    const [mn, mx] = this.hf.nodeMinMax(k, I, J);
    const c = this._cam;
    const r = lodRange(k) * this.rangeScale;
    if (distSqToBox(c, x0, mn, z0, x0 + size, mx, z0 + size) > r * r) return false;
    if (!this._boxVisible(x0, z0, size, mn, mx)) return true;
    if (k === 0) { this._emit(x0, z0, size, 0, false); return true; }
    const rc = lodRange(k - 1) * this.rangeScale;
    if (distSqToBox(c, x0, mn, z0, x0 + size, mx, z0 + size) > rc * rc) {
      this._emit(x0, z0, size, k, false);
      return true;
    }
    const h = size / 2;
    for (let dj = 0; dj < 2; dj++) {
      for (let di = 0; di < 2; di++) {
        const ci = 2 * I + di, cj = 2 * J + dj;
        if (!this._node(k - 1, ci, cj)) {
          const cx0 = x0 + di * h, cz0 = z0 + dj * h;
          const [cmn, cmx] = this.hf.nodeMinMax(k - 1, ci, cj);
          if (this._boxVisible(cx0, cz0, h, cmn, cmx)) this._emit(cx0, cz0, h, k, true);
        }
      }
    }
    return true;
  }
}
