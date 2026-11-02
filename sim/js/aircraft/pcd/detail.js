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

/**
 * The canopy's own detail, tileable linear data (canopy.js):
 *
 *   R     scratches: cleaning swirls (arcs round a few centres, a cloth wiped in circles) and a few
 *         straight ones, their coverage of the texel
 *   G     haze: smudges, wipe marks and dust specks (diffuse forward scatter)
 *   B, A  the scratches' direction as a doubled angle, 0.5 + 0.5 R (cos 2a, sin 2a), a in the
 *         texture's (u, v): a scratch scatters light into a cone about its own line, so near the
 *         sun only the scratches across the line to the sun light up (the arcs round the sun seen
 *         through every cleaned canopy). A doubled angle weighted by the coverage averages
 *         correctly in the mipmaps (a scratch and its reverse are the same line).
 *
 * Rasterised here (anti-aliased stamps along each scratch), not with a 2D canvas: the direction
 * has to follow every point of an arc. At 1024 over the canopy's 0.42 m tile (0.41 mm a texel)
 * the scratches are 0.25-0.45 mm wide: hairlines of a pixel or so at 1080p on the glass beside
 * the head (0.7-1.4 mm at 512 showed as soft strokes several pixels wide). Sizes in texels scale
 * with `size`, so the pattern is the same at any size. 1024² RGBA with mipmaps: 5.3 MB (MB of
 * 2^20 bytes, as above).
 * @param {number} size texture size (px)
 * @returns {THREE.DataTexture}
 */
export function makeGlassTexture(size = 1024, seed = 53) {
  const rand = rng(seed);
  const n = size * size;
  const px = size / 1024;                         // texels per texel at 1024
  const I = new Float32Array(n), C = new Float32Array(n), Sn = new Float32Array(n);
  // one anti-aliased dot of radius r at (x, y) (wrapped), strength a, direction ang
  const stamp = (x, y, r, a, c2, s2) => {
    const R = r + 0.5;
    const x0 = Math.floor(x - R), x1 = Math.ceil(x + R), y0 = Math.floor(y - R), y1 = Math.ceil(y + R);
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - y, row = (((py % size) + size) % size) * size;
      for (let qx = x0; qx <= x1; qx++) {
        const dx = qx + 0.5 - x;
        const f = R - Math.sqrt(dx * dx + dy * dy);
        if (f <= 0) continue;
        const k = row + (((qx % size) + size) % size);
        const add = a * (f < 1 ? f : 1) * (1 - I[k]);   // saturating: crossing scratches do not exceed 1
        I[k] += add; C[k] += add * c2; Sn[k] += add * s2;
      }
    }
  };
  // a curve stamped every quarter texel, each stamp a quarter of the strength (at half a texel
  // the hairlines came out beaded): at(s, P) sets P.x, P.y and P.d, the direction
  const P = { x: 0, y: 0, d: 0 }, DS = 0.25;
  const curve = (len, at, w, a) => {
    for (let s = 0; s <= len; s += DS) { at(s, P); stamp(P.x, P.y, w * 0.5, a * DS, Math.cos(2 * P.d), Math.sin(2 * P.d)); }
  };
  // cleaning swirls: arcs round a few centres
  for (let c = 0; c < 8; c++) {
    const cx = rand() * size, cy = rand() * size;
    const m = 26 + Math.floor(rand() * 30);
    for (let i = 0; i < m; i++) {
      const r = (0.04 + 0.5 * Math.pow(rand(), 1.5)) * size;
      const a0 = rand() * Math.PI * 2, da = (0.15 + rand() * 0.7) * (rand() < 0.5 ? -1 : 1);
      const a = 0.12 + 0.5 * Math.pow(rand(), 2);
      const w = (0.6 + rand() * 0.5) * px;
      curve(Math.abs(da) * r, (s, p) => { const t = a0 + Math.sign(da) * s / r; p.x = cx + r * Math.cos(t); p.y = cy + r * Math.sin(t); p.d = t + Math.PI / 2; }, w, a);
    }
  }
  // a few straight scratches (a ring, a buckle)
  for (let i = 0; i < 26; i++) {
    const x = rand() * size, y = rand() * size, ang = rand() * Math.PI, len = (0.02 + 0.25 * Math.pow(rand(), 2)) * size;
    const a = 0.25 + 0.6 * Math.pow(rand(), 2);
    const w = (0.6 + rand() * 0.4) * px;
    curve(len, (s, p) => { p.x = x + Math.cos(ang) * s; p.y = y + Math.sin(ang) * s; p.d = ang; }, w, a);
  }
  // haze: soft smudges and wipe marks, dust specks
  const blot = fbm(size, 4, 4, seed + 1, 0.55);
  const wipe = fbm(size, 8, 3, seed + 2, 0.5);
  const haze = new Float32Array(n);
  for (let i = 0; i < n; i++) haze[i] = 0.12 + 0.88 * smooth(0.5, 0.8, blot[i]) * (0.5 + 0.5 * wipe[i]);
  // (dust specks 1-3 mm across, the same on the tile at any size)
  for (let k = 0; k < 105; k++) {
    const x = Math.floor(rand() * size), y = Math.floor(rand() * size), r = (1.2 + rand() * 2.2) * px, v = 0.5 + rand() * 0.5;
    const R = Math.ceil(r + 0.5);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const f = Math.max(0, 1 - Math.hypot(dx, dy) / (r + 0.5));
        if (!f) continue;
        const j = ((y + dy + size) % size) * size + ((x + dx + size) % size);
        haze[j] = Math.min(1, haze[j] + v * f);
      }
    }
  }
  const data = new Uint8Array(n * 4);
  const u8 = (x) => Math.round(255 * Math.min(1, Math.max(0, x)));
  for (let i = 0; i < n; i++) {
    data[i * 4] = u8(I[i]);
    data[i * 4 + 1] = u8(haze[i]);
    data[i * 4 + 2] = u8(0.5 + 0.5 * C[i]);
    data[i * 4 + 3] = u8(0.5 + 0.5 * Sn[i]);
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.name = 'CanopyDetail';
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
