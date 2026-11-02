// Field analysis: which way the crop rows, orchard rows and street grids run, per field.
// Pure JS (no DOM): used by the data build (sim/tools/terrain/fields_segment.mjs, the whole
// core at once, the normal source of the field data), by the tile worker when that data is
// missing (tileWorker.js, one tile at a time: fields cut by a tile edge then differ on its two
// sides) and by the node tests.
//
// The 6.25 m imagery shows fields as patches of even colour with straight edges, but not the
// rows inside them. To draw rows that follow each field, the imagery is segmented into regions
// of even colour (Felzenszwalb-Huttenlocher graph segmentation at 12.5 m; mapped land use
// polygons, where the build has them, weigh as extra edges), and each region gets one row
// direction: its long axis, snapped to the local "grid" axis of the field edges around it (the
// 4-fold symmetric average of the colour gradient direction: fields in a block share two
// perpendicular axes). Every texel of the 640 x 640 output per tile (10 m, like the land cover)
// packs, in 16 bits:
//
//   bits 0-3   class index: ESA WorldCover (CLASS_CODES[index] = the WorldCover code) or one of
//              the mapped classes 12-14 (orchard, vineyard, greenhouses; the data build takes
//              them from OpenStreetMap land use)
//   bits 4-10  row direction theta in 128 steps of 180 / 128 deg, from +x (east) towards +z
//              (south); rows run along (cos theta, sin theta)
//   bits 11-15 a random number per region (0..31), so neighbouring fields differ
//
// The terrain shader unpacks it with texelFetch (TERRAIN_FRAG).

/** ESA WorldCover codes in class index order (index 0 = no data). */
export const CLASS_CODES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
/** Mapped classes (not WorldCover codes): rows of trees, rows of vines, plastic greenhouses. */
export const CLASS_ORCHARD = 12;
export const CLASS_VINEYARD = 13;
export const CLASS_GREENHOUSE = 14;
export const CODE_TO_INDEX = new Uint8Array(256);
CLASS_CODES.forEach((c, i) => { CODE_TO_INDEX[c] = i; });

export const DATA_N = 640;
/** Block size (px) of the fallback grid axis: 64 px = 800 m at 12.5 m. */
export const BLOCK = 64;

/** Packs a land cover code with no direction (fallback when the analysis cannot run). */
export function packCodes(codes, n = DATA_N) {
  const out = new Uint16Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = CODE_TO_INDEX[codes[i]];
  return out;
}

export function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Felzenszwalb-Huttenlocher segmentation of an RGBA image (w x h, row 0 = north).
 * opts.k (scale, default 0.35), opts.minSize (smallest region in px, 24), opts.barrier
 * (optional Uint16Array w x h of mapped polygon ids, 0 = none: an edge between two different
 * ids weighs opts.barrierW more, so field outlines that a map has follow it).
 * Returns {label: Int32Array (0 .. nr-1), nr, R, G, B (Float32Array features, 0..1)}.
 */
export function segmentImage(rgba, w, h, opts = {}) {
  const k = opts.k ?? 0.35;
  const minSize = opts.minSize ?? 24;
  const barrier = opts.barrier || null;
  const barrierW = opts.barrierW ?? 0.06;
  const N = w * h;

  // colour features: a 3 x 3 binomial blur against JPEG noise
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, ws = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
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
    let wt = Math.sqrt(dr * dr + dg * dg + db * db);
    if (barrier && barrier[p] !== barrier[q]) wt += barrierW;
    ea[ne] = p; eb[ne] = q;
    ew[ne] = Math.min(65535, Math.round(wt * 32768));
    ne++;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x + 1 < w) add(p, p + 1);
      if (y + 1 < h) {
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

  const label = new Int32Array(N);
  const idOf = new Int32Array(N).fill(-1);
  let nr = 0;
  for (let p = 0; p < N; p++) {
    const r = find(p);
    if (idOf[r] < 0) idOf[r] = nr++;
    label[p] = idOf[r];
  }
  return { label, nr, R, G, B };
}

/**
 * 3 x 3 majority filter of a label image (ragged one-pixel teeth and stray pixels along region
 * edges join the region around them); a pixel keeps its label unless 5 or more of its 8
 * neighbours share another one. Returns a new Int32Array.
 */
export function majorityFilter(label, w, h) {
  const out = new Int32Array(label);
  const lab = new Int32Array(8), cnt = new Int32Array(8);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x, c = label[p];
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const l = label[p + dy * w + dx];
          if (l === c) continue;
          let j = 0;
          while (j < n && lab[j] !== l) j++;
          if (j === n) { lab[n] = l; cnt[n] = 0; n++; }
          cnt[j]++;
        }
      }
      for (let j = 0; j < n; j++) if (cnt[j] >= 5) { out[p] = lab[j]; break; }
    }
  }
  return out;
}

/**
 * Per region sums for the row directions, over the pixels of rect [x0, x1) x [y0, y1) of a
 * w x h segmented image (seg from segmentImage, its label possibly filtered). Coordinates are
 * offset by (ox, oy) so that sums of several images (tiles of a mosaic) add up in one frame.
 *   M     Float64Array, 6 per region: n, sx, sy, sxx, syy, sxy
 *   A4    Float64Array, 3 per region: the 4-fold colour gradient (sum |g|^2 cos 4phi, sin 4phi, |g|^2)
 *   blk   Float64Array, 3 per BLOCK x BLOCK block of the frame (nbx blocks across), the same sums
 * id(label) -> region index in M / A4 (the identity for a single image).
 */
export function accumulateRegions(seg, label, w, h, rect, ox, oy, id, M, A4, blk, nbx) {
  const { R, G, B } = seg;
  const [x0, y0, x1, y1] = rect;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = y * w + x, r = id(label[p]), m = r * 6;
      const X = x + ox, Y = y + oy;
      M[m] += 1; M[m + 1] += X; M[m + 2] += Y; M[m + 3] += X * X; M[m + 4] += Y * Y; M[m + 5] += X * Y;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      let gx = 0, gy = 0;
      for (const C of [R, G, B]) {
        // Sobel on the sum of the channels: enough for field edges
        gx += (C[p - w + 1] + 2 * C[p + 1] + C[p + w + 1]) - (C[p - w - 1] + 2 * C[p - 1] + C[p + w - 1]);
        gy += (C[p + w - 1] + 2 * C[p + w] + C[p + w + 1]) - (C[p - w - 1] + 2 * C[p - w] + C[p - w + 1]);
      }
      const g2 = gx * gx + gy * gy;
      if (g2 < 1e-6) continue;
      // (gx + i gy)^4 / |g|^2 = |g|^2 e^(4 i phi)
      const re2 = gx * gx - gy * gy, im2 = 2 * gx * gy;
      const re4 = (re2 * re2 - im2 * im2) / g2, im4 = (2 * re2 * im2) / g2;
      const a = r * 3;
      A4[a] += re4; A4[a + 1] += im4; A4[a + 2] += g2;
      if (blk) {
        const b = (Math.floor(Y / BLOCK) * nbx + Math.floor(X / BLOCK)) * 3;
        blk[b] += re4; blk[b + 1] += im4; blk[b + 2] += g2;
      }
    }
  }
}

const angDist = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };

/**
 * Row direction (radians, 0..pi) of region r from its sums (accumulateRegions) and the random
 * bits h (32-bit hash, the caller's seed for the region). Long, narrow regions run along their
 * long axis snapped to the grid axis of the field edges (the region's own, else its block's);
 * roundish ones take one of the two grid axes at random.
 */
export function regionDirection(M, A4, blk, nbx, r, h) {
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
  if ((strength < 0.2 || cnt < 64) && blk) {
    const bx = Math.max(0, Math.min(nbx - 1, Math.floor(mx / BLOCK)));
    const by = Math.max(0, Math.floor(my / BLOCK));
    const b = (by * nbx + bx) * 3;
    if (b + 2 < blk.length) {
      a4 = blk[b]; b4 = blk[b + 1]; s4 = blk[b + 2];
      strength = s4 > 0 ? Math.hypot(a4, b4) / s4 : 0;
    }
  }
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
  return th;
}

/** The 16-bit texel (layout at the top). */
export function packTexel(classIndex, theta, rnd) {
  const tq = Math.round(theta / Math.PI * 128) & 127;
  return (classIndex & 15) | (tq << 4) | ((rnd & 31) << 11);
}

/**
 * One tile on its own (the runtime fallback when the data build's field data is missing).
 * rgba: Uint8ClampedArray / Uint8Array of the tile image at w x w (512 recommended, 12.5 m),
 * row 0 = north. codes: Uint8Array n x n land cover. Returns Uint16Array n x n (see above).
 * opts.k (segmentation scale) and opts.minSize (smallest region in px) for experiments.
 */
export function analyzeTile(rgba, w, codes, n = DATA_N, opts = {}) {
  const seg = segmentImage(rgba, w, w, opts);
  const label = majorityFilter(seg.label, w, w);
  const nr = seg.nr;
  const M = new Float64Array(nr * 6), A4 = new Float64Array(nr * 3);
  const nb = Math.ceil(w / BLOCK);
  const blk = new Float64Array(nb * nb * 3);
  accumulateRegions(seg, label, w, w, [0, 0, w, w], 0, 0, (l) => l, M, A4, blk, nb);

  const theta = new Float32Array(nr), rnd = new Uint8Array(nr);
  for (let r = 0; r < nr; r++) {
    if (!M[r * 6]) continue;
    const m = r * 6;
    const h = hash32(r * 7919 + Math.round(M[m + 1] / M[m]) * 131 + Math.round(M[m + 2] / M[m]) * 31337);
    rnd[r] = h & 31;
    theta[r] = regionDirection(M, A4, blk, nb, r, h);
  }

  // pack at the land cover resolution
  const out = new Uint16Array(n * n);
  const s = w / n;
  for (let j = 0; j < n; j++) {
    const y = Math.min(w - 1, Math.floor((j + 0.5) * s));
    for (let i = 0; i < n; i++) {
      const x = Math.min(w - 1, Math.floor((i + 0.5) * s));
      const r = label[y * w + x];
      out[j * n + i] = packTexel(CODE_TO_INDEX[codes[j * n + i]], theta[r], rnd[r]);
    }
  }
  if (opts.debug) return { data: out, label, theta, nr };
  return out;
}
