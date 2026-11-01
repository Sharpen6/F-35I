// Field analysis of one L0 tile: which way the crop rows, orchard rows and street grids run.
// Pure JS (no DOM): runs in tileWorker.js and in node tests.
//
// The 6.25 m imagery shows fields as patches of even colour with straight edges, but not the
// rows inside them. To draw rows that follow each field, the tile is segmented into regions
// of even colour (Felzenszwalb-Huttenlocher graph segmentation at 12.5 m), and each region
// gets one row direction: its long axis, snapped to the local "grid" axis of the field edges
// around it (the 4-fold symmetric average of the colour gradient direction: fields in a block
// share two perpendicular axes). Every texel of the 640 x 640 output (10 m, like the land
// cover) packs, in 16 bits:
//
//   bits 0-3   land cover class index (CLASS_CODES[index] = ESA WorldCover code)
//   bits 4-10  row direction theta in 128 steps of 180 / 128 deg, from +x (east) towards +z
//              (south); rows run along (cos theta, sin theta)
//   bits 11-15 a random number per region (0..31), so neighbouring fields differ
//
// The terrain shader unpacks it with texelFetch (TERRAIN_FRAG, l0Texel).

/** ESA WorldCover codes in class index order (index 0 = no data). */
export const CLASS_CODES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
const CODE_TO_INDEX = new Uint8Array(256);
CLASS_CODES.forEach((c, i) => { CODE_TO_INDEX[c] = i; });

export const DATA_N = 640;

/** Packs a land cover code with no direction (fallback when the analysis cannot run). */
export function packCodes(codes, n = DATA_N) {
  const out = new Uint16Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = CODE_TO_INDEX[codes[i]];
  return out;
}

function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * rgba: Uint8ClampedArray / Uint8Array of the tile image at w x w (512 recommended, 12.5 m),
 * row 0 = north. codes: Uint8Array n x n land cover. Returns Uint16Array n x n (see above).
 * opts.k (segmentation scale) and opts.minSize (smallest region in px) for experiments.
 */
export function analyzeTile(rgba, w, codes, n = DATA_N, opts = {}) {
  const k = opts.k ?? 0.35;
  const minSize = opts.minSize ?? 24;
  const N = w * w;

  // colour features: a 3 x 3 binomial blur against JPEG noise
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, ws = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(w - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const q = (yy * w + xx) * 4;
          const kw = (dx ? 1 : 2) * (dy ? 1 : 2);
          r += rgba[q] * kw; g += rgba[q + 1] * kw; b += rgba[q + 2] * kw; ws += kw;
        }
      }
      const p = y * w + x;
      R[p] = r / ws / 255; G[p] = g / ws / 255; B[p] = b / ws / 255;
    }
  }

  // graph: 4 edges per pixel (right, down, down-right, down-left), weight = colour distance
  const E = N * 4;
  const ea = new Int32Array(E), eb = new Int32Array(E), ew = new Uint16Array(E);
  let ne = 0;
  const add = (p, q) => {
    const dr = R[p] - R[q], dg = G[p] - G[q], db = B[p] - B[q];
    ea[ne] = p; eb[ne] = q;
    ew[ne] = Math.min(65535, Math.round(Math.sqrt(dr * dr + dg * dg + db * db) * 32768));
    ne++;
  };
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x + 1 < w) add(p, p + 1);
      if (y + 1 < w) {
        add(p, p + w);
        if (x + 1 < w) add(p, p + w + 1);
        if (x > 0) add(p, p + w - 1);
      }
    }
  }
  // counting sort by weight
  const count = new Uint32Array(65537);
  for (let i = 0; i < ne; i++) count[ew[i] + 1]++;
  for (let i = 1; i < 65537; i++) count[i] += count[i - 1];
  const order = new Int32Array(ne);
  for (let i = 0; i < ne; i++) order[count[ew[i]]++] = i;

  // Felzenszwalb-Huttenlocher: merge while the edge is no heavier than both regions' inner
  // variation + k / size
  const parent = new Int32Array(N), size = new Int32Array(N), thr = new Float32Array(N);
  for (let i = 0; i < N; i++) { parent[i] = i; size[i] = 1; thr[i] = k; }
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a, b, wt) => {
    if (size[a] < size[b]) { const t = a; a = b; b = t; }
    parent[b] = a;
    size[a] += size[b];
    thr[a] = wt + k / size[a];
    return a;
  };
  for (let o = 0; o < ne; o++) {
    const i = order[o];
    const a = find(ea[i]), b = find(eb[i]);
    if (a === b) continue;
    const wt = ew[i] / 32768;
    if (wt <= thr[a] && wt <= thr[b]) union(a, b, wt);
  }
  // small regions (lanes, ditches, single trees) join their most similar neighbour
  for (let o = 0; o < ne; o++) {
    const i = order[o];
    const a = find(ea[i]), b = find(eb[i]);
    if (a !== b && (size[a] < minSize || size[b] < minSize)) union(a, b, ew[i] / 32768);
  }

  // region ids and moments
  const label = new Int32Array(N);
  const idOf = new Int32Array(N).fill(-1);
  let nr = 0;
  for (let p = 0; p < N; p++) {
    const r = find(p);
    if (idOf[r] < 0) idOf[r] = nr++;
    label[p] = idOf[r];
  }
  const M = new Float64Array(nr * 6);      // n, sx, sy, sxx, syy, sxy
  const A4 = new Float64Array(nr * 3);     // sum |g|^2 cos 4phi, sin 4phi, sum |g|^2
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, m = label[p] * 6;
      M[m] += 1; M[m + 1] += x; M[m + 2] += y; M[m + 3] += x * x; M[m + 4] += y * y; M[m + 5] += x * y;
    }
  }
  // 4-fold gradient direction (field edges: two perpendicular axes) per region and per block
  const BS = 64, nb = Math.ceil(w / BS);
  const blk = new Float64Array(nb * nb * 3);
  for (let y = 1; y < w - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      let gx = 0, gy = 0;
      for (const C of [R, G, B]) {
        // Sobel per channel, summed with sign aligned to the strongest channel is overkill
        // here; the luminance-like sum works for field edges
        gx += (C[p - w + 1] + 2 * C[p + 1] + C[p + w + 1]) - (C[p - w - 1] + 2 * C[p - 1] + C[p + w - 1]);
        gy += (C[p + w - 1] + 2 * C[p + w] + C[p + w + 1]) - (C[p - w - 1] + 2 * C[p - w] + C[p - w + 1]);
      }
      const g2 = gx * gx + gy * gy;
      if (g2 < 1e-6) continue;
      // (gx + i gy)^4 / |g|^2 = |g|^2 e^(4 i phi)
      const re2 = gx * gx - gy * gy, im2 = 2 * gx * gy;
      const re4 = (re2 * re2 - im2 * im2) / g2, im4 = (2 * re2 * im2) / g2;
      const a = label[p] * 3;
      A4[a] += re4; A4[a + 1] += im4; A4[a + 2] += g2;
      const b = (Math.floor(y / BS) * nb + Math.floor(x / BS)) * 3;
      blk[b] += re4; blk[b + 1] += im4; blk[b + 2] += g2;
    }
  }

  // one direction per region
  const theta = new Float32Array(nr), rnd = new Uint8Array(nr);
  const angDist = (a, b) => { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
  for (let r = 0; r < nr; r++) {
    const m = r * 6, cnt = M[m];
    const mx = M[m + 1] / cnt, my = M[m + 2] / cnt;
    const cxx = M[m + 3] / cnt - mx * mx + 1 / 12, cyy = M[m + 4] / cnt - my * my + 1 / 12;
    const cxy = M[m + 5] / cnt - mx * my;
    const alpha = 0.5 * Math.atan2(2 * cxy, cxx - cyy);           // long axis
    const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const elong = Math.sqrt((tr / 2 + disc) / Math.max(1e-6, tr / 2 - disc));
    // grid axis from the region's edges, else from its 800 m block
    let a4 = A4[r * 3], b4 = A4[r * 3 + 1], s4 = A4[r * 3 + 2];
    let strength = s4 > 0 ? Math.hypot(a4, b4) / s4 : 0;
    if (strength < 0.2 || cnt < 64) {
      const bx = Math.min(nb - 1, Math.floor(mx / BS)), by = Math.min(nb - 1, Math.floor(my / BS));
      const b = (by * nb + bx) * 3;
      a4 = blk[b]; b4 = blk[b + 1]; s4 = blk[b + 2];
      strength = s4 > 0 ? Math.hypot(a4, b4) / s4 : 0;
    }
    const h = hash32(r * 7919 + Math.round(mx) * 131 + Math.round(my) * 31337);
    rnd[r] = h & 31;
    let th;
    if (strength > 0.12) {
      // edges cross at beta and beta + 90 deg; rows run along one of them
      const beta = Math.atan2(b4, a4) / 4;
      const c0 = beta, c1 = beta + Math.PI / 2;
      if (elong > 1.12) th = angDist(alpha, c0) <= angDist(alpha, c1) ? c0 : c1;
      else th = (h >>> 8) & 1 ? c0 : c1;
    } else {
      th = elong > 1.12 ? alpha : ((h >>> 9) & 255) / 256 * Math.PI;
    }
    th %= Math.PI;
    if (th < 0) th += Math.PI;
    theta[r] = th;
  }

  // pack at the land cover resolution
  const out = new Uint16Array(n * n);
  const s = w / n;
  for (let j = 0; j < n; j++) {
    const y = Math.min(w - 1, Math.floor((j + 0.5) * s));
    for (let i = 0; i < n; i++) {
      const x = Math.min(w - 1, Math.floor((i + 0.5) * s));
      const r = label[y * w + x];
      const tq = Math.round(theta[r] / Math.PI * 128) & 127;
      out[j * n + i] = CODE_TO_INDEX[codes[j * n + i]] | (tq << 4) | (rnd[r] << 11);
    }
  }
  if (opts.debug) return { data: out, label, theta, nr };
  return out;
}
