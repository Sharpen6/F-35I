// A procedural, tileable detail texture for the cockpit (made at start-up, nothing downloaded):
//
//   R  scratches: cleaning swirls (short arcs) and a few straight scratches   -> canopy glass
//   G  smudges: soft blotches and wipe marks                                  -> canopy, interior
//   B  grain: fine value noise around 0.5                                      -> interior paint
//   A  dust: sparse specks                                                     -> canopy glass
//
// 512 x 512 RGBA (1 MB, 1.3 MB with mipmaps), linear data (not colour), repeat wrapping. Used with
// triplanar mapping in object space (the glb's cockpit parts have no detail UVs).

import * as THREE from 'three';

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value-noise fBm on a size x size grid: octaves from `period` lattice cells up. */
function fbm(size, period, octaves, seed, gain = 0.5) {
  const out = new Float32Array(size * size);
  const rand = rng(seed);
  let amp = 1, norm = 0;
  for (let o = 0, p = period; o < octaves; o++, p *= 2) {
    const lat = new Float32Array(p * p);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    const cell = size / p;
    for (let y = 0; y < size; y++) {
      const fy = y / cell, y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % p) * p, r1 = ((y0 + 1) % p) * p;
      for (let x = 0; x < size; x++) {
        const fx = x / cell, x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % p, c1 = (x0 + 1) % p;
        const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
        const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
        out[y * size + x] += amp * (a + (b - a) * sy);
      }
    }
    norm += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * @param {number} size texture size (px)
 * @returns {THREE.DataTexture}
 */
export function makeDetailTexture(size = 512, seed = 35) {
  const rand = rng(seed);
  // ---- R: scratches, drawn on a canvas with wrap-around (tileable)
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  const wrap = (draw) => { for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) { g.save(); g.translate(ox, oy); draw(); g.restore(); } };
  // cleaning swirls: faint arcs around a few centres (a cloth wiped in circles), lines a pixel wide
  // or more (thinner ones break up into dots when the texture is minified)
  for (let c = 0; c < 7; c++) {
    const cx = rand() * size, cy = rand() * size;
    const n = 24 + Math.floor(rand() * 30);
    for (let i = 0; i < n; i++) {
      const r = (0.04 + 0.5 * Math.pow(rand(), 1.5)) * size;
      const a0 = rand() * Math.PI * 2, da = (0.15 + rand() * 0.6) * (rand() < 0.5 ? -1 : 1);
      const a = 0.05 + 0.18 * Math.pow(rand(), 2);
      const w = 1 + rand() * 0.8;
      wrap(() => {
        g.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        g.lineWidth = w;
        g.beginPath();
        g.arc(cx, cy, r, a0, a0 + da, da < 0);
        g.stroke();
      });
    }
  }
  // a few straight scratches
  for (let i = 0; i < 22; i++) {
    const x = rand() * size, y = rand() * size, ang = rand() * Math.PI, len = (0.02 + 0.22 * Math.pow(rand(), 2)) * size;
    const a = 0.1 + 0.35 * Math.pow(rand(), 2);
    wrap(() => {
      g.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      g.lineWidth = 1 + rand() * 0.6;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      g.stroke();
    });
  }
  const scratch = g.getImageData(0, 0, size, size).data;

  // ---- G: smudges (soft blotches, a few elongated wipes), B: grain, A: dust
  const blot = fbm(size, 4, 4, seed + 1, 0.55);
  const wipe = fbm(size, 8, 3, seed + 2, 0.5);
  const grain = fbm(size, 64, 2, seed + 3, 0.5);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const s = smooth(0.52, 0.78, blot[i]) * (0.55 + 0.45 * wipe[i]);
    data[i * 4] = scratch[i * 4];
    data[i * 4 + 1] = Math.round(255 * Math.min(1, s));
    data[i * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + (grain[i] - 0.5) * 2.2)));
    data[i * 4 + 3] = 0;
  }
  // dust specks (1-3 px soft dots)
  for (let k = 0; k < size * size / 3000; k++) {
    const x = Math.floor(rand() * size), y = Math.floor(rand() * size), r = 0.6 + rand() * 1.2, v = 0.4 + rand() * 0.6;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const f = Math.max(0, 1 - Math.hypot(dx, dy) / (r + 0.5));
        if (!f) continue;
        const j = (((y + dy + size) % size) * size + ((x + dx + size) % size)) * 4 + 3;
        data[j] = Math.min(255, data[j] + Math.round(255 * v * f));
      }
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.name = 'CockpitDetail';
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** GLSL: triplanar sample of the detail texture (object-space position p, normal n, metres per tile). */
export const TRIPLANAR_GLSL = /* glsl */`
vec4 ckTriplanar(sampler2D tex, vec3 p, vec3 n, float metresPerTile) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= max(w.x + w.y + w.z, 1e-4);
  vec3 q = p / metresPerTile;
  vec4 a = texture2D(tex, q.zy);
  vec4 b = texture2D(tex, q.xz + 0.37);
  vec4 c = texture2D(tex, q.xy + 0.71);
  return a * w.x + b * w.y + c * w.z;
}
`;
