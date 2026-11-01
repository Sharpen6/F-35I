// What the wheels touch: runways (airports.json) and land cover, pure JS.
//
// Runway rectangles come from the two ends of each runway in airports.json and its width.
// Water is ESA WorldCover code 80 (plus "no data" at sea level, i.e. open sea), evaluated
// with the same bilinear weight the terrain shader uses for its shoreline, so the
// physics shoreline is where the rendered one is (weight 0.5).

import { CORE_HALF, FAR_HALF, TILE_M } from './HeightField.js';

export const FRICTION = { runway: 0.8, ground: 0.6, water: 0.1, grass_runway: 0.55 };

export const LC_WATER = 80;

// Paved overruns the terrain build measured too short: its test (low colour saturation) stops
// where the extension is paler, more yellow concrete than the runway. Measured on the L0
// imagery (6.25 m/px): a strip of the runway's width, in line with it, continues this far (m)
// past the end, up to the perimeter road. Keyed 'ICAO end'. Painted as a blast pad with
// chevrons and treated as pavement by the wheels.
export const OVERRUN_FIX = { 'LLEK 36': 390, 'LLEK 15R': 390, 'LL59 21': 300 };

export class Runways {
  constructor(airports = []) {
    this.list = [];
    for (const ap of airports) {
      for (const rw of ap.runways || []) {
        if (!rw.ends || rw.ends.length < 2) continue;
        const [a, b] = rw.ends;
        const dx = b.x - a.x, dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (!(length > 10)) continue;
        const width = rw.width_m || 45;
        const paved = !/grass|turf|dirt|gravel|sand/i.test(rw.surface || 'asphalt');
        const m = (v) => (Number.isFinite(v) && v > 0 ? Math.min(v, 1000) : 0);
        this.list.push({
          icao: ap.icao, airport: ap.name, ids: rw.ids || [a.id, b.id], ends: [a, b],
          cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, ux: dx / length, uz: dz / length,
          length, width, halfLength: length / 2, halfWidth: width / 2, paved,
          surface: rw.surface || 'asphalt',
          // paved overrun (blast pad) beyond each end, displaced threshold at each end (m)
          overrun: paved ? [m(OVERRUN_FIX[`${ap.icao} ${a.id}`] ?? a.overrun_m),
            m(OVERRUN_FIX[`${ap.icao} ${b.id}`] ?? b.overrun_m)] : [0, 0],
          displaced: [m(a.displaced_threshold_m), m(b.displaced_threshold_m)],
          y0: a.y ?? null, y1: b.y ?? null,
        });
      }
    }
  }

  /** The runway (including its paved overruns) containing world (x, z), or null. */
  find(x, z) {
    for (const r of this.list) {
      const dx = x - r.cx, dz = z - r.cz;
      const s = dx * r.ux + dz * r.uz;
      if (s < -r.halfLength - r.overrun[0] || s > r.halfLength + r.overrun[1]) continue;
      const t = -dx * r.uz + dz * r.ux;
      if (t < -r.halfWidth || t > r.halfWidth) continue;
      return r;
    }
    return null;
  }

  /** Runways whose paved rectangle (grown by margin) touches the axis-aligned box. */
  inBox(x0, z0, x1, z1, margin = 50) {
    return this.list.filter((r) => {
      // corners of the paved rectangle (overruns included)
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (const s of [-r.halfLength - r.overrun[0], r.halfLength + r.overrun[1]]) {
        for (const t of [-r.halfWidth, r.halfWidth]) {
          const x = r.cx + s * r.ux - t * r.uz, z = r.cz + s * r.uz + t * r.ux;
          mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mnz = Math.min(mnz, z); mxz = Math.max(mxz, z);
        }
      }
      return mxx + margin >= x0 && mnx - margin <= x1 && mxz + margin >= z0 && mnz - margin <= z1;
    });
  }
}

const isWater = (code, h) => code === LC_WATER || (code === 0 && Math.abs(h) < 0.5);

/**
 * Land cover codes on the CPU: the 4096 x 4096 overview of the core, the 2048 x 2048 far
 * grid, and the 640 x 640 tiles (10 m) the renderer has resident.
 */
export class LandCover {
  constructor() {
    this.overview = null; // Uint8Array 4096^2
    this.far = null; // Uint8Array 2048^2
    this.overviewN = 4096;
    this.farN = 2048;
    this.tileN = 640;
    this.tiles = new Map(); // "ix,iz" -> Uint8Array
  }

  _sampleGrid(codes, n, x0, size, x, z, h) {
    // pixel-is-area: texel centres at x0 + (i + 0.5) * size / n
    const px = (x - x0) / size * n - 0.5, pz = (z - x0) / size * n - 0.5;
    const i0 = Math.floor(px), j0 = Math.floor(pz);
    const fx = px - i0, fz = pz - j0;
    let w = 0;
    for (let dj = 0; dj < 2; dj++) {
      const j = Math.min(n - 1, Math.max(0, j0 + dj));
      for (let di = 0; di < 2; di++) {
        const i = Math.min(n - 1, Math.max(0, i0 + di));
        if (isWater(codes[j * n + i], h)) w += (di ? fx : 1 - fx) * (dj ? fz : 1 - fz);
      }
    }
    return w;
  }

  /** Water weight 0..1 at (x, z); h = terrain height there (for open-sea "no data"). */
  waterWeight(x, z, h) {
    if (x >= -CORE_HALF && x <= CORE_HALF && z >= -CORE_HALF && z <= CORE_HALF) {
      const ix = Math.min(15, Math.floor((x + CORE_HALF) / TILE_M));
      const iz = Math.min(15, Math.floor((z + CORE_HALF) / TILE_M));
      const t = this.tiles.get(`${ix},${iz}`);
      if (t) {
        const x0 = -CORE_HALF + ix * TILE_M, z0 = -CORE_HALF + iz * TILE_M;
        // tile-local sampling (the shader clamps at the tile edge too)
        return this._sampleGrid(t, this.tileN, 0, TILE_M, x - x0, z - z0, h);
      }
      if (this.overview) return this._sampleGrid(this.overview, this.overviewN, -CORE_HALF, 2 * CORE_HALF, x, z, h);
    }
    if (this.far) return this._sampleGrid(this.far, this.farN, -FAR_HALF, 2 * FAR_HALF, x, z, h);
    return h < 0.5 && h > -0.5 ? 1 : 0;
  }

  /** Nearest land cover code (finest source available). */
  codeAt(x, z) {
    const pick = (codes, n, x0, size, lx, lz) => {
      const i = Math.min(n - 1, Math.max(0, Math.floor((lx - x0) / size * n)));
      const j = Math.min(n - 1, Math.max(0, Math.floor((lz - x0) / size * n)));
      return codes[j * n + i];
    };
    if (x >= -CORE_HALF && x <= CORE_HALF && z >= -CORE_HALF && z <= CORE_HALF) {
      const ix = Math.min(15, Math.floor((x + CORE_HALF) / TILE_M));
      const iz = Math.min(15, Math.floor((z + CORE_HALF) / TILE_M));
      const t = this.tiles.get(`${ix},${iz}`);
      if (t) return pick(t, this.tileN, 0, TILE_M, x + CORE_HALF - ix * TILE_M, z + CORE_HALF - iz * TILE_M);
      if (this.overview) return pick(this.overview, this.overviewN, -CORE_HALF, 2 * CORE_HALF, x, z);
    }
    if (this.far) return pick(this.far, this.farN, -FAR_HALF, 2 * FAR_HALF, x, z);
    return 0;
  }
}

/** {type, friction} for the wheels at (x, z); h is the terrain height there. */
export function surfaceType(runways, landCover, x, z, h) {
  const r = runways.find(x, z);
  if (r) return { type: 'runway', friction: r.paved ? FRICTION.runway : FRICTION.grass_runway };
  if (landCover && landCover.waterWeight(x, z, h) >= 0.5) return { type: 'water', friction: FRICTION.water };
  return { type: 'ground', friction: FRICTION.ground };
}
