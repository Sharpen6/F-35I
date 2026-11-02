// Procedural low-poly tree and shrub meshes, built at start-up (no model files).
//
// Every species of species.js has a builder that makes a tree of height 1 (base at the origin,
// y up) from a few primitives: a trunk tube along a bent polyline, thin branches, foliage
// clumps (icospheres displaced by value noise), palm fronds (folded strips) and fan leaves.
// Instances scale it by their height (and crown width factor) in the vertex shader.
//
// Vertex attributes:
//   position, normal  normal = the lighting normal: the clump's surface normal bent towards
//                     the direction from the crown centre, so a crown shades as one rounded mass
//   aColor            albedo, linear RGB (the species colour with per-clump variation)
//   aVert             x: ambient occlusion (rays against the other clumps and the trunk, and
//                        the depth inside the crown), y: part (PART_*), z: random per clump,
//                     w: sway weight (0 at the base, 1 at the crown's tips)
//   uv                fronds and fan leaves: (along, across) for the leaflet pattern
//
// Two variants per species (different seeds); detail 1 for the near meshes, 0 for a coarser
// mesh. The returned info has the bounding radius of the crown in x / z and the radius of
// the bounding sphere about (0, 0.5, 0), which is what the impostor frames are fitted to.

import * as THREE from 'three';
import { SPECIES, srgbToLinear } from './species.js';

export const PART_FOLIAGE = 0;
export const PART_WOOD = 1;
export const PART_FROND = 2;
export const PART_FAN = 3;

/** Variants per species (meshes and impostor frames). */
export const VARIANTS = 2;

// ------------------------------------------------------------------------------------------
// small deterministic helpers

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 3D value noise in 0..1 (smooth). */
function vnoise(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  let v = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    const w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
    v += w * hash3(xi + dx, yi + dy, zi + dz, s);
  }
  return v;
}

function fbm(x, y, z, s) {
  return 0.6 * vnoise(x, y, z, s) + 0.3 * vnoise(x * 2.1, y * 2.1, z * 2.1, s + 17) + 0.1 * vnoise(x * 4.3, y * 4.3, z * 4.3, s + 31);
}

const lin = (rgb) => rgb.map(srgbToLinear);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// icosphere: unit vertices and faces per subdivision level (cached)
const _ico = new Map();
function icosphere(level) {
  if (_ico.has(level)) return _ico.get(level);
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const mid = new Map();
    const m = (a, b) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (mid.has(k)) return mid.get(k);
      const p = v[a].map((x, i) => x + v[b][i]);
      const len = Math.hypot(...p);
      v.push(p.map((x) => x / len));
      mid.set(k, v.length - 1);
      return v.length - 1;
    };
    const nf = [];
    for (const [a, b, c] of f) {
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = nf;
  }
  const r = { v, f };
  _ico.set(level, r);
  return r;
}

// ------------------------------------------------------------------------------------------
// geometry builder

class Builder {
  constructor() {
    this.pos = []; this.nrm = []; this.col = []; this.vert = []; this.uv = []; this.idx = [];
    this.clumps = [];      // occluders for the AO pass: {x, y, z, r}
    this.trunks = [];      // occluder segments: {a: [x,y,z], b: [x,y,z], r}
    this.foliageStart = [];
  }

  get count() { return this.pos.length / 3; }

  vertex(p, n, c, ao, part, rnd, sway, u = 0, v = 0) {
    this.pos.push(p[0], p[1], p[2]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    this.nrm.push(n[0] / l, n[1] / l, n[2] / l);
    this.col.push(c[0], c[1], c[2]);
    this.vert.push(ao, part, rnd, sway);
    this.uv.push(u, v);
    return this.count - 1;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }

  /**
   * Tube along points (each [x, y, z]) with radii; sides around. Wood colour with streaks.
   * Returns nothing; records the segments as AO occluders.
   */
  tube(points, radii, sides, color, rnd, swayAt = (y) => y * y * 0.3, aoBase = 0.55) {
    const n = points.length;
    let prevN = null;
    const rings = [];
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const q0 = points[Math.max(0, i - 1)], q1 = points[Math.min(n - 1, i + 1)];
      let T = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]];
      const tl = Math.hypot(...T) || 1;
      T = T.map((x) => x / tl);
      // frame: reuse the previous normal projected (no twisting)
      let N = prevN || (Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
      const d = N[0] * T[0] + N[1] * T[1] + N[2] * T[2];
      N = [N[0] - d * T[0], N[1] - d * T[1], N[2] - d * T[2]];
      const nl = Math.hypot(...N) || 1;
      N = N.map((x) => x / nl);
      prevN = N;
      const B = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
      const ring = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dir = [N[0] * ca + B[0] * sa, N[1] * ca + B[1] * sa, N[2] * ca + B[2] * sa];
        const r = radii[i];
        const pp = [p[0] + dir[0] * r, p[1] + dir[1] * r, p[2] + dir[2] * r];
        const streak = 0.85 + 0.3 * hash3(s, i, 7, rnd * 1e6);
        const c = [color[0] * streak, color[1] * streak, color[2] * streak];
        const ao = aoBase + (1 - aoBase) * smooth(0, 0.25, p[1]);
        ring.push(this.vertex(pp, dir, c, ao, PART_WOOD, rnd, swayAt(p[1])));
      }
      rings.push(ring);
      if (i > 0) this.trunks.push({ a: points[i - 1], b: p, r: radii[i] });
    }
    for (let i = 0; i + 1 < n; i++) {
      for (let s = 0; s < sides; s++) {
        const a = rings[i][s], b = rings[i][(s + 1) % sides], c = rings[i + 1][s], d = rings[i + 1][(s + 1) % sides];
        this.tri(a, b, d); this.tri(a, d, c);
      }
    }
  }

  /**
   * Foliage clump: icosphere of radii [rx, ry, rz] at c, displaced by noise. The lighting
   * normal bends towards the direction from crownC. AO is computed later (finishAO).
   */
  clump(c, radii, level, color, crownC, seed, opts = {}) {
    const { amp = 0.28, freq = 2.2, bend = 0.5, part = PART_FOLIAGE, swayK = 1 } = opts;
    const { v, f } = icosphere(level);
    const base = this.count;
    const rnd = hash3(seed, 3, 5, 11);
    const shade = 0.85 + 0.3 * rnd;
    for (const d of v) {
      const nz = fbm(d[0] * freq + seed * 0.37, d[1] * freq + seed * 0.11, d[2] * freq - seed * 0.23, seed);
      const k = 1 + amp * (nz - 0.5) * 2;
      const p = [c[0] + d[0] * radii[0] * k, c[1] + d[1] * radii[1] * k, c[2] + d[2] * radii[2] * k];
      // ellipsoid normal, bent towards the crown's own radial direction (and a little up)
      const en = [d[0] / radii[0], d[1] / radii[1], d[2] / radii[2]];
      const el = Math.hypot(...en);
      let cr = [p[0] - crownC[0], (p[1] - crownC[1]) * 1.3, p[2] - crownC[2]];
      const cl = Math.hypot(...cr) || 1;
      cr = cr.map((x) => x / cl);
      const n = [en[0] / el * (1 - bend) + cr[0] * bend, en[1] / el * (1 - bend) + cr[1] * bend + 0.12, en[2] / el * (1 - bend) + cr[2] * bend];
      // tips a little lighter (new growth), underside a little darker
      const tip = 0.94 + 0.12 * nz + 0.05 * d[1];
      const col = [color[0] * shade * tip, color[1] * shade * tip, color[2] * shade * tip];
      this.vertex(p, n, col, 1, part, rnd, swayK);
    }
    for (const [a, b, cc] of f) this.tri(base + a, base + b, base + cc);
    this.clumps.push({ x: c[0], y: c[1], z: c[2], r: Math.cbrt(radii[0] * radii[1] * radii[2]) * 0.92, first: base, last: this.count });
  }

  /**
   * Palm frond: a strip folded into a V along the rachis, both faces. start [x,y,z], dir
   * (unit, the frond's initial direction), length, width, droop (how much it bends down).
   */
  frond(start, dir, length, width, droop, segs, color, seed, sway = 1) {
    const side = [dir[2], 0, -dir[0]];
    const sl = Math.hypot(...side) || 1;
    const S = side.map((x) => x / sl);
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push([
        start[0] + dir[0] * length * t,
        start[1] + dir[1] * length * t - droop * length * t * t,
        start[2] + dir[2] * length * t,
      ]);
    }
    const rnd = hash3(seed, 9, 1, 2);
    const shade = 0.88 + 0.24 * rnd;
    for (const face of [1, -1]) {
      const rows = [];
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const p = pts[i];
        const q = pts[Math.min(segs, i + 1)], o = pts[Math.max(0, i - 1)];
        const T = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
        const tl = Math.hypot(...T) || 1;
        // up of the strip = cross(T, S)
        const U = [(T[1] * S[2] - T[2] * S[1]) / tl, (T[2] * S[0] - T[0] * S[2]) / tl, (T[0] * S[1] - T[1] * S[0]) / tl];
        const w = width * Math.sin(Math.PI * Math.pow(Math.min(t * 1.08, 1), 0.75)) * (t < 0.05 ? 0.3 : 1);
        const fold = 0.35 * w;    // V fold: edges higher than the rachis
        const row = [];
        for (const a of [-1, 0, 1]) {
          const pp = [p[0] + S[0] * w * a + U[0] * fold * Math.abs(a), p[1] + S[1] * w * a + U[1] * fold * Math.abs(a), p[2] + S[2] * w * a + U[2] * fold * Math.abs(a)];
          // normal: the strip's up, tilted outwards on each half of the V, flipped for the back
          const n = [U[0] * face - S[0] * a * 0.35, U[1] * face - S[1] * a * 0.35 + 0.25, U[2] * face - S[2] * a * 0.35];
          const c = [color[0] * shade * (0.92 + 0.1 * t), color[1] * shade * (0.92 + 0.1 * t), color[2] * shade * (0.92 + 0.08 * t)];
          row.push(this.vertex(pp, n, c, 0.8 + 0.2 * t, PART_FROND, rnd, sway * (0.4 + 0.6 * t), t, a));
        }
        rows.push(row);
      }
      for (let i = 0; i < segs; i++) {
        for (let j = 0; j < 2; j++) {
          const a = rows[i][j], b = rows[i][j + 1], c = rows[i + 1][j], d = rows[i + 1][j + 1];
          if (face > 0) { this.tri(a, c, d); this.tri(a, d, b); } else { this.tri(a, d, c); this.tri(a, b, d); }
        }
      }
    }
  }

  /** Fan leaf (Washingtonia): a fan of radius r at c facing n, spanning ~220 deg, both faces. */
  fan(c, n, r, color, seed, segs = 7) {
    const nl = Math.hypot(...n);
    const N = n.map((x) => x / nl);
    let A = Math.abs(N[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const d = A[0] * N[0] + A[1] * N[1] + A[2] * N[2];
    A = [A[0] - d * N[0], A[1] - d * N[1], A[2] - d * N[2]];
    const al = Math.hypot(...A);
    A = A.map((x) => x / al);
    const B = [N[1] * A[2] - N[2] * A[1], N[2] * A[0] - N[0] * A[2], N[0] * A[1] - N[1] * A[0]];
    const rnd = hash3(seed, 4, 4, 4);
    const shade = 0.9 + 0.2 * rnd;
    const span = 3.8;
    for (const face of [1, -1]) {
      const centre = this.vertex(c, N.map((x) => x * face), color.map((x) => x * shade * 0.8), 0.7, PART_FAN, rnd, 0.6, 0, 0);
      const rim = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs - 0.5) * span;
        const dir = [A[0] * Math.cos(a) + B[0] * Math.sin(a), A[1] * Math.cos(a) + B[1] * Math.sin(a), A[2] * Math.cos(a) + B[2] * Math.sin(a)];
        // pleated: the rim alternates a little in and out of the plane
        const pl = (i % 2 ? 0.12 : -0.12) * r;
        const p = [c[0] + dir[0] * r + N[0] * pl, c[1] + dir[1] * r + N[1] * pl - 0.15 * r * Math.abs(Math.sin(a)), c[2] + dir[2] * r + N[2] * pl];
        const nn = [N[0] * face + dir[0] * 0.3, N[1] * face + 0.3, N[2] * face + dir[2] * 0.3];
        rim.push(this.vertex(p, nn, color.map((x) => x * shade), 1, PART_FAN, rnd, 1, i / segs, 1));
      }
      for (let i = 0; i < segs; i++) {
        if (face > 0) this.tri(centre, rim[i], rim[i + 1]); else this.tri(centre, rim[i + 1], rim[i]);
      }
    }
  }

  /**
   * Ambient occlusion of the foliage: hemisphere rays around each normal against the other
   * clumps (spheres) and the trunk, times how deep the vertex sits in the crown and a vertical
   * gradient (the lower crown sees less sky).
   */
  finishAO(crownC, crownR, aoMin = 0.25) {
    const dirs = [];
    const rng = mulberry32(99);
    for (let i = 0; i < 10; i++) {
      const u = rng(), v = rng();
      const th = Math.acos(1 - u), ph = v * Math.PI * 2;
      dirs.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
    }
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const part = this.vert[i * 4 + 1];
      if (part === PART_WOOD) continue;
      const p = [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]];
      const N = [this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]];
      // tangent frame around N
      const T = Math.abs(N[1]) < 0.9 ? [N[2], 0, -N[0]] : [0, -N[2], N[1]];
      const tl = Math.hypot(...T) || 1;
      const t0 = T.map((x) => x / tl);
      const b0 = [N[1] * t0[2] - N[2] * t0[1], N[2] * t0[0] - N[0] * t0[2], N[0] * t0[1] - N[1] * t0[0]];
      let hit = 0;
      for (const d of dirs) {
        const r = [t0[0] * d[0] + N[0] * d[1] + b0[0] * d[2], t0[1] * d[0] + N[1] * d[1] + b0[1] * d[2], t0[2] * d[0] + N[2] * d[1] + b0[2] * d[2]];
        let blocked = 0;
        for (const s of this.clumps) {
          if (i >= s.first && i < s.last) continue;
          const ox = s.x - p[0], oy = s.y - p[1], oz = s.z - p[2];
          const tc = ox * r[0] + oy * r[1] + oz * r[2];
          if (tc <= 0) continue;
          const d2 = ox * ox + oy * oy + oz * oz - tc * tc;
          if (d2 < s.r * s.r) { blocked = Math.max(blocked, 0.8); break; }
        }
        if (!blocked) {
          for (const s of this.trunks) {
            // closest approach of the ray to the segment's midpoint, as a sphere
            const m = [(s.a[0] + s.b[0]) / 2 - p[0], (s.a[1] + s.b[1]) / 2 - p[1], (s.a[2] + s.b[2]) / 2 - p[2]];
            const tc = m[0] * r[0] + m[1] * r[1] + m[2] * r[2];
            if (tc <= 0) continue;
            const d2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] - tc * tc;
            const rr = s.r * 2.5;
            if (d2 < rr * rr) { blocked = 0.4; break; }
          }
        }
        hit += blocked;
      }
      const occl = hit / dirs.length;
      const depth = Math.hypot((p[0] - crownC[0]) / crownR[0], (p[1] - crownC[1]) / crownR[1], (p[2] - crownC[2]) / crownR[2]);
      const shell = smooth(0.25, 1.0, depth);
      const vert = 0.55 + 0.45 * smooth(crownC[1] - crownR[1], crownC[1] + crownR[1] * 0.8, p[1]);
      const ao = Math.max(aoMin, (1 - occl) * (0.45 + 0.55 * shell) * vert);
      this.vert[i * 4] = Math.min(this.vert[i * 4], ao);
    }
  }

  /** Normalises to height 1 (base at y = 0) and returns {geometry, info}. */
  build(name) {
    let maxY = 0, minY = Infinity;
    for (let i = 1; i < this.pos.length; i += 3) { maxY = Math.max(maxY, this.pos[i]); minY = Math.min(minY, this.pos[i]); }
    const k = 1 / (maxY - Math.min(0, minY));
    for (let i = 0; i < this.pos.length; i++) this.pos[i] *= k;
    let rxz = 0, rs = 0;
    for (let i = 0; i < this.pos.length; i += 3) {
      const x = this.pos[i], y = this.pos[i + 1], z = this.pos[i + 2];
      rxz = Math.max(rxz, Math.hypot(x, z));
      rs = Math.max(rs, Math.hypot(x, y - 0.5, z));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aVert', new THREE.Float32BufferAttribute(this.vert, 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const n = this.count;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.name = name;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), rs);
    return { geometry: g, info: { radiusXZ: rxz, sphere: rs, triangles: this.idx.length / 3, vertices: n } };
  }
}

// ------------------------------------------------------------------------------------------
// species builders (unit: the tree's height before normalisation is ~1)

function jitter(rng, a) { return (rng() - 0.5) * 2 * a; }

function trunkPath(rng, h, lean, bends = 3) {
  const az = rng() * Math.PI * 2;
  const pts = [];
  let wob = [0, 0];
  for (let i = 0; i <= bends; i++) {
    const t = i / bends;
    wob = [wob[0] + jitter(rng, lean * 0.4), wob[1] + jitter(rng, lean * 0.4)];
    pts.push([Math.cos(az) * lean * t * t + wob[0] * t, h * t, Math.sin(az) * lean * t * t + wob[1] * t]);
  }
  return pts;
}

/** The point of a polyline (trunk) at height y (linear between its points). */
function alongY(path, y) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (y <= b[1] || i === path.length - 1) {
      const t = clamp((y - a[1]) / ((b[1] - a[1]) || 1), 0, 1);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return path[path.length - 1];
}

function pine(b, sp, rng, detail) {
  const fol = lin(sp.foliage), wood = lin(sp.wood);
  const lean = 0.03 + rng() * 0.08;
  const trunkTop = 0.84;
  const path = trunkPath(rng, trunkTop, lean, 5);
  b.tube(path, path.map((p, i) => 0.024 * (1 - 0.65 * i / (path.length - 1))), detail ? 6 : 4, wood, 0.3);
  const top = path[path.length - 1];
  const crownC = [top[0] * 0.85, 0.7, top[2] * 0.85];
  const crownR = [0.34, 0.26, 0.34];
  // Aleppo pine (planted KKL forest): a trunk bare to about half its height, then an
  // irregular, open crown of flattened tufts at the ends of the branches, roundish to flat on
  // top, with gaps through which the branches show
  const n = detail ? 12 + Math.floor(rng() * 3) : 7;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const y = 0.47 + 0.43 * Math.pow(t, 0.8) + jitter(rng, 0.025);
    const az = i * 2.39996 + rng() * 0.7;
    const spread = (0.17 * (1 - 0.45 * t) + 0.04 * rng()) * (t > 0.9 ? 0.35 : 1);
    const tp = alongY(path, Math.min(y - 0.05, trunkTop));
    const c = [tp[0] + Math.cos(az) * spread, y, tp[2] + Math.sin(az) * spread];
    const r = 0.09 + 0.035 * rng() - 0.015 * t;
    // branch from the trunk to the tuft
    if (detail) b.tube([tp, [(tp[0] + c[0]) / 2, (tp[1] + y) / 2 + 0.01, (tp[2] + c[2]) / 2], [c[0], y - 0.02, c[2]]], [0.007, 0.005, 0.0035], 3, wood, 0.5, (yy) => 0.3 + 0.5 * yy, 0.5);
    b.clump(c, [r * 1.3, r * 0.62, r * 1.3], detail ? 1 : 0, fol, crownC, 100 + i * 7 + Math.floor(rng() * 1000), { amp: 0.34, freq: 2.6, bend: 0.55 });
  }
  b.finishAO(crownC, crownR, 0.3);
}

function olive(b, sp, rng, detail) {
  const fol = lin(sp.foliage), wood = lin(sp.wood);
  // short gnarled trunk, often splitting into two or three stems
  const stems = 1 + Math.floor(rng() * 2.6);
  const crownC = [0, 0.58, 0];
  const crownR = [0.56, 0.36, 0.56];
  for (let s = 0; s < stems; s++) {
    const az = rng() * Math.PI * 2;
    const lean = 0.06 + rng() * 0.1;
    const pts = [[0, 0, 0], [Math.cos(az) * lean * 0.3 + jitter(rng, 0.03), 0.16, Math.sin(az) * lean * 0.3 + jitter(rng, 0.03)],
      [Math.cos(az) * lean, 0.34, Math.sin(az) * lean], [Math.cos(az) * lean * 1.6, 0.48, Math.sin(az) * lean * 1.6]];
    b.tube(pts, [0.06 / Math.sqrt(stems), 0.045 / Math.sqrt(stems), 0.03, 0.015], detail ? 6 : 4, wood, 0.2 + s * 0.1);
  }
  const n = detail ? 8 + Math.floor(rng() * 3) : 6;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const az = t * Math.PI * 2 + rng() * 0.7;
    const up = rng();
    const rad = 0.3 * (1 - 0.5 * up) + 0.08 * rng();
    const c = [crownC[0] + Math.cos(az) * rad, 0.48 + 0.34 * up, crownC[2] + Math.sin(az) * rad];
    const r = 0.2 + 0.07 * rng();
    b.clump(c, [r * 1.1, r * 0.75, r * 1.1], detail ? 1 : 0, fol, crownC, 300 + i * 13 + Math.floor(rng() * 1000), { amp: 0.34, freq: 2.4, bend: 0.5 });
  }
  b.finishAO(crownC, crownR);
}

function citrus(b, sp, rng, detail) {
  const fol = lin(sp.foliage), wood = lin(sp.wood);
  b.tube([[0, 0, 0], [jitter(rng, 0.02), 0.12, jitter(rng, 0.02)], [jitter(rng, 0.03), 0.3, jitter(rng, 0.03)]], [0.045, 0.035, 0.02], detail ? 5 : 4, wood, 0.4, (y) => y * 0.2, 0.4);
  const crownC = [0, 0.52, 0];
  const crownR = [0.52, 0.46, 0.52];
  // one dense rounded mass (pruned skirt close to the ground) with a few bulges
  b.clump([0, 0.5, 0], [0.47, 0.42, 0.47], detail ? 2 : 1, fol, crownC, 500 + Math.floor(rng() * 1000), { amp: 0.16, freq: 2.0, bend: 0.3 });
  const n = detail ? 5 : 3;
  for (let i = 0; i < n; i++) {
    const az = i * 2.39996 + rng();
    const c = [Math.cos(az) * 0.24, 0.45 + 0.35 * rng(), Math.sin(az) * 0.24];
    const r = 0.22 + 0.06 * rng();
    b.clump(c, [r, r * 0.9, r], detail ? 1 : 0, fol, crownC, 520 + i * 17 + Math.floor(rng() * 1000), { amp: 0.25, freq: 2.8, bend: 0.5 });
  }
  b.finishAO(crownC, crownR, 0.3);
}

function broadleaf(b, sp, rng, detail) {
  const fol = lin(sp.foliage), wood = lin(sp.wood);
  const path = trunkPath(rng, 0.42, 0.04, 3);
  b.tube(path, [0.045, 0.038, 0.032, 0.026], detail ? 6 : 4, wood, 0.3);
  const top = path[path.length - 1];
  const crownC = [top[0], 0.66, top[2]];
  const crownR = [0.48, 0.32, 0.48];
  // main limbs
  const limbs = 3;
  for (let i = 0; i < limbs; i++) {
    const az = (i / limbs) * Math.PI * 2 + rng();
    const e = [top[0] + Math.cos(az) * 0.22, 0.62 + 0.08 * rng(), top[2] + Math.sin(az) * 0.22];
    if (detail) b.tube([top, [(top[0] + e[0]) / 2, (top[1] + e[1]) / 2 + 0.03, (top[2] + e[2]) / 2], e], [0.022, 0.016, 0.01], 4, wood, 0.6, (y) => 0.2 + 0.6 * y);
  }
  const n = detail ? 9 + Math.floor(rng() * 3) : 7;
  for (let i = 0; i < n; i++) {
    const up = rng();
    const az = i * 2.39996 + rng() * 0.5;
    const rad = 0.3 * Math.sqrt(1 - up * up * 0.7) + jitter(rng, 0.04);
    const c = [crownC[0] + Math.cos(az) * rad, 0.5 + 0.38 * up, crownC[2] + Math.sin(az) * rad];
    const r = 0.17 + 0.06 * rng();
    b.clump(c, [r * 1.1, r * 0.85, r * 1.1], detail ? 1 : 0, fol, crownC, 700 + i * 11 + Math.floor(rng() * 1000), { amp: 0.3, freq: 2.5, bend: 0.5 });
  }
  b.finishAO(crownC, crownR);
}

function datepalm(b, sp, rng, detail) {
  const fol = lin(sp.foliage), wood = lin(sp.wood);
  // trunk with the knobbly leaf bases: radius modulated along the height
  const top = 0.74;
  const lean = 0.02 + rng() * 0.05, az = rng() * Math.PI * 2;
  const segs = detail ? 8 : 4;
  const pts = [], radii = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([Math.cos(az) * lean * t * t, top * t, Math.sin(az) * lean * t * t]);
    radii.push((0.026 - 0.006 * t) * (1 + (detail ? 0.1 * Math.sin(t * 60) : 0)) * (t < 0.06 ? 1.25 : 1));
  }
  b.tube(pts, radii, detail ? 7 : 5, wood, 0.2, (y) => 0.1 * y, 0.6);
  const c = pts[pts.length - 1];
  // crown core
  b.clump([c[0], c[1] + 0.01, c[2]], [0.045, 0.05, 0.045], 0, fol.map((x) => x * 0.7), c, 900, { amp: 0.2, part: PART_FOLIAGE });
  // fronds in spirals: upper ones steep, lower ones drooping
  const nf = detail ? 24 : 12;
  for (let i = 0; i < nf; i++) {
    const t = i / nf;
    const a = i * 2.39996 + rng() * 0.3;
    const elev = (65 - 85 * t + jitter(rng, 8)) * Math.PI / 180;
    const dir = [Math.cos(a) * Math.cos(elev), Math.sin(elev), Math.sin(a) * Math.cos(elev)];
    const L = 0.38 + 0.1 * rng();      // 4-5 m fronds on a 10 m palm: a crown as wide as it is high
    const col = t > 0.85 ? lin([118, 104, 70]) : fol;     // a few old, yellowing fronds below
    b.frond([c[0] + dir[0] * 0.02, c[1] + 0.02, c[2] + dir[2] * 0.02], dir, L, 0.06, 0.25 + 0.3 * t, detail ? 5 : 2, col, 1000 + i * 7, 1);
  }
  b.clumps.push({ x: c[0], y: c[1] + 0.02, z: c[2], r: 0.06, first: 0, last: 0 });
  b.finishAO([c[0], c[1], c[2]], [0.32, 0.18, 0.32], 0.45);
}

function cypress(b, sp, rng, detail) {
  const fol = lin(sp.foliage), wood = lin(sp.wood);
  b.tube([[0, 0, 0], [0, 0.1, 0]], [0.03, 0.025], 4, wood, 0.1, () => 0, 0.4);
  // a narrow flame-shaped column: stacked clumps along a slightly wavy axis
  const crownC = [0, 0.52, 0];
  const n = detail ? 9 : 5;
  const wob = jitter(rng, 0.015);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const y = 0.1 + 0.82 * t;
    const prof = Math.sin(Math.PI * Math.min(1, 0.12 + 0.88 * Math.pow(t, 0.8))) * (1 - 0.35 * t);
    const r = 0.035 + 0.075 * prof;
    const c = [wob * t + jitter(rng, 0.01), y, jitter(rng, 0.01)];
    b.clump(c, [r, 0.1, r], detail ? 1 : 0, fol, [c[0], y, c[2]], 1200 + i * 5 + Math.floor(rng() * 1000), { amp: 0.22, freq: 3.0, bend: 0.6 });
  }
  b.clump([wob, 0.95, 0], [0.025, 0.05, 0.025], 0, fol, [0, 0.9, 0], 1299, { amp: 0.2 });
  b.finishAO(crownC, [0.1, 0.46, 0.1], 0.35);
}

function eucalyptus(b, sp, rng, detail) {
  const fol = lin(sp.foliage), wood = lin(sp.wood);
  // river red gum: a pale smooth trunk forking low into a few long limbs; an open, irregular,
  // tall crown of small drooping masses with sky between them
  const fork = 0.32 + 0.08 * rng();
  const path = trunkPath(rng, fork, 0.05, 3);
  b.tube(path, [0.03, 0.027, 0.024, 0.021], detail ? 6 : 4, wood, 0.25, (y) => y * y * 0.5, 0.6);
  const top = path[path.length - 1];
  const crownC = [top[0], 0.7, top[2]];
  const crownR = [0.3, 0.3, 0.3];
  const limbs = 3 + Math.floor(rng() * 2);
  const ends = [];
  for (let i = 0; i < limbs; i++) {
    const az = (i / limbs) * Math.PI * 2 + rng() * 0.8;
    const r = 0.13 + 0.12 * rng();
    const e = [top[0] + Math.cos(az) * r, 0.6 + 0.3 * rng(), top[2] + Math.sin(az) * r];
    ends.push(e);
    const mid = [(top[0] + e[0]) / 2 + jitter(rng, 0.03), (top[1] + e[1]) / 2, (top[2] + e[2]) / 2 + jitter(rng, 0.03)];
    b.tube([top, mid, e], [0.017, 0.012, 0.007], detail ? 4 : 3, wood, 0.5, (y) => 0.3 + 0.5 * y, 0.7);
  }
  // foliage masses along the outer half of every limb and beyond its end, hanging a little
  const n = detail ? 14 + Math.floor(rng() * 3) : 7;
  for (let i = 0; i < n; i++) {
    const e = ends[i % limbs];
    const s = 0.5 + 0.65 * rng();
    const az = rng() * Math.PI * 2;
    const out = 0.04 + 0.07 * rng();
    const c = [top[0] + (e[0] - top[0]) * s + Math.cos(az) * out, top[1] + (e[1] - top[1]) * s + jitter(rng, 0.05),
      top[2] + (e[2] - top[2]) * s + Math.sin(az) * out];
    const r = 0.06 + 0.035 * rng();
    b.clump(c, [r, r * 1.2, r], detail ? 1 : 0, fol, crownC, 1400 + i * 9 + Math.floor(rng() * 1000), { amp: 0.42, freq: 2.4, bend: 0.4 });
  }
  b.finishAO(crownC, crownR, 0.45);
}

function shrub(b, sp, rng, detail) {
  const fol = lin(sp.foliage);
  // a low cushion of a few hemispheres (garrigue: thorny burnet, sage, mastic)
  const crownC = [0, 0.35, 0];
  const n = detail ? 4 + Math.floor(rng() * 2) : 3;
  for (let i = 0; i < n; i++) {
    const az = i * 2.39996 + rng();
    const rad = i ? 0.28 + 0.12 * rng() : 0;
    const r = (i ? 0.26 : 0.38) + 0.08 * rng();
    const c = [Math.cos(az) * rad, r * 0.55, Math.sin(az) * rad];
    const col = fol.map((x) => x * (0.85 + 0.3 * rng()));
    b.clump(c, [r, r * 0.95, r], detail ? 1 : 0, col, crownC, 1600 + i * 3 + Math.floor(rng() * 1000), { amp: 0.32, freq: 2.8, bend: 0.4, swayK: 0.3 });
  }
  b.finishAO(crownC, [0.6, 0.4, 0.6], 0.35);
}

function fanpalm(b, sp, rng, detail) {
  const fol = lin(sp.foliage), wood = lin(sp.wood);
  const top = 0.88;
  const lean = 0.01 + rng() * 0.04, az = rng() * Math.PI * 2;
  const segs = detail ? 8 : 4;
  const pts = [], radii = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([Math.cos(az) * lean * t, top * t, Math.sin(az) * lean * t]);
    radii.push(0.014 * (1 - 0.3 * t) * (t < 0.05 ? 1.4 : 1));
  }
  b.tube(pts, radii, detail ? 6 : 4, wood, 0.2, (y) => 0.1 * y, 0.6);
  const c = pts[pts.length - 1];
  // skirt of dead leaves (often trimmed in town: short)
  b.clump([c[0], c[1] - 0.03, c[2]], [0.035, 0.05, 0.035], 0, lin([120, 98, 70]), c, 1700, { amp: 0.15, part: PART_FOLIAGE });
  const nf = detail ? 14 : 9;
  for (let i = 0; i < nf; i++) {
    const a = i * 2.39996 + rng() * 0.3;
    const elev = (55 - 70 * (i / nf) + jitter(rng, 10)) * Math.PI / 180;
    const dir = [Math.cos(a) * Math.cos(elev), Math.sin(elev), Math.sin(a) * Math.cos(elev)];
    const L = 0.06 + 0.02 * rng();
    const fc = [c[0] + dir[0] * L, c[1] + 0.02 + dir[1] * L, c[2] + dir[2] * L];
    // the fan faces outwards and up
    b.fan(fc, [dir[0], dir[1] + 0.6, dir[2]], 0.055 + 0.01 * rng(), fol, 1800 + i, detail ? 7 : 4);
  }
  b.clumps.push({ x: c[0], y: c[1], z: c[2], r: 0.05, first: 0, last: 0 });
  b.finishAO([c[0], c[1], c[2]], [0.1, 0.08, 0.1], 0.45);
}

const BUILDERS = { pine, olive, citrus, broadleaf, datepalm, cypress, eucalyptus, shrub, fanpalm };

/**
 * One species mesh: {geometry, info}. species: id (species.js), variant 0..VARIANTS-1,
 * detail 1 (near meshes) or 0 (coarse).
 */
export function buildTree(species, variant = 0, detail = 1) {
  const sp = SPECIES[species];
  const b = new Builder();
  const rng = mulberry32(1009 * (species + 1) + 7919 * (variant + 1));
  BUILDERS[sp.name](b, sp, rng, detail);
  return b.build(`tree_${sp.name}_${variant}_${detail}`);
}

/** All species x variants at one detail: array indexed by species * VARIANTS + variant. */
export function buildAllTrees(detail = 1) {
  const out = [];
  for (const sp of SPECIES) for (let v = 0; v < VARIANTS; v++) out.push(buildTree(sp.id, v, detail));
  return out;
}
