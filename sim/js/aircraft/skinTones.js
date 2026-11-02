// Panel tones of the skin atlases (exterior track; js/aircraft/README.md, "Exterior").
//
// The real coating is a patchwork: doors and access panels were coated, re-coated and caulked at
// different times, so neighbouring panels differ a little in tone and in sheen. The atlases carry
// the panels' outlines as caulk / tape lines in the ORM texture's roughness (green) channel (the
// satin coating ~0.46, the lines ~0.72), and nothing between UV islands (green ~0). Every region
// those lines and the islands' edges enclose is one panel: it gets a random tone and sheen shift,
// most of them small, one in eight a clearly different (replaced) panel. The lines themselves take
// the tone of the panel beside them (dilation), and so do a few texels round the islands, so
// filtering never mixes in the neutral value.
//
// Pure function (no DOM): skinWorker.js runs it off the main thread; tests/exterior_unit.mjs in node.

/**
 * ORM green thresholds (0..255): below BG nothing is mapped, above TAPE a caulk / tape line.
 * Regions up to `small` of the atlas take the full shift, from `large` up a `bigAmp` of it: the
 * lines do not close every panel, and what they leave open (most of an island, the wings of
 * atlas B) is the airframe's structure, one coat, not a panel.
 */
export const TONE = { bg: 60, tape: 150, dilate: 10, replaced: 0.125, small: 0.004, large: 0.03, bigAmp: 0.15 };

function hash(n) {
  // integer hash (lowbias32), 0..1
  let x = n | 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** A panel's shift, -1..1: mostly small (a triangular spread), sometimes a replaced panel. */
function shift(id, salt) {
  const a = hash(id * 4 + salt * 7919 + 1), b = hash(id * 4 + salt * 7919 + 2), c = hash(id * 4 + salt * 7919 + 3);
  let t = (a + b + c) / 1.5 - 1;                  // -1..1, std ~0.33
  if (hash(id * 4 + salt * 7919 + 4) < TONE.replaced) t = (t < 0 ? -1 : 1) * (0.65 + 0.35 * hash(id + salt * 31));
  return t;
}

/**
 * @param {Uint8Array|Uint8ClampedArray} rgba the ORM texture, w * h * 4 (row order does not matter)
 * @param {number} w
 * @param {number} h
 * @param {number} [scale=2] output texels are scale x scale input texels (box filtered)
 * @returns {{data: Uint8Array, width: number, height: number, regions: number}} RG8: R tone, G sheen
 *   (128 = no shift)
 */
export function panelTones(rgba, w, h, scale = 2) {
  const n = w * h;
  const lab = new Int32Array(n);                  // 0 unvisited, -1 line / outside, k > 0 region
  for (let i = 0; i < n; i++) {
    const g = rgba[i * 4 + 1];
    if (g < TONE.bg || g > TONE.tape) lab[i] = -1;
  }
  // regions: 4-connected flood fill with an explicit stack
  const stack = new Int32Array(n);
  let regions = 0;
  for (let s = 0; s < n; s++) {
    if (lab[s] !== 0) continue;
    const id = ++regions;
    let top = 0;
    stack[top++] = s;
    lab[s] = id;
    while (top > 0) {
      const p = stack[--top];
      const x = p % w;
      if (x > 0 && lab[p - 1] === 0) { lab[p - 1] = id; stack[top++] = p - 1; }
      if (x < w - 1 && lab[p + 1] === 0) { lab[p + 1] = id; stack[top++] = p + 1; }
      if (p >= w && lab[p - w] === 0) { lab[p - w] = id; stack[top++] = p - w; }
      if (p < n - w && lab[p + w] === 0) { lab[p + w] = id; stack[top++] = p + w; }
    }
  }
  // region areas (texels), for the amplitude
  const area = new Float64Array(regions + 1);
  for (let p = 0; p < n; p++) if (lab[p] > 0) area[lab[p]]++;
  // the lines and the islands' rims take a neighbouring panel's id (a few passes of dilation)
  const src = lab, tmp = new Int32Array(n);
  for (let pass = 0; pass < TONE.dilate; pass++) {
    let changed = 0;
    tmp.set(src);
    for (let p = 0; p < n; p++) {
      if (src[p] > 0) continue;
      const x = p % w;
      let v = 0;
      if (x > 0 && src[p - 1] > 0) v = src[p - 1];
      else if (x < w - 1 && src[p + 1] > 0) v = src[p + 1];
      else if (p >= w && src[p - w] > 0) v = src[p - w];
      else if (p < n - w && src[p + w] > 0) v = src[p + w];
      if (v) { tmp[p] = v; changed++; }
    }
    src.set(tmp);
    if (!changed) break;
  }
  // per region shifts, then box-filtered down
  const tone = new Float32Array(regions + 1), sheen = new Float32Array(regions + 1);
  const lo = Math.log(TONE.small * n), hi = Math.log(TONE.large * n);
  for (let k = 1; k <= regions; k++) {
    const t = Math.min(1, Math.max(0, (Math.log(Math.max(area[k], 1)) - lo) / (hi - lo)));
    const amp = 1 - (1 - TONE.bigAmp) * t * t * (3 - 2 * t);
    tone[k] = amp * shift(k, 1);
    sheen[k] = amp * shift(k, 2);
  }
  const ow = Math.max(1, Math.floor(w / scale)), oh = Math.max(1, Math.floor(h / scale));
  const data = new Uint8Array(ow * oh * 2);
  const inv = 1 / (scale * scale);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let a = 0, b = 0;
      for (let j = 0; j < scale; j++) {
        const row = (y * scale + j) * w + x * scale;
        for (let i = 0; i < scale; i++) {
          const k = src[row + i];
          if (k > 0) { a += tone[k]; b += sheen[k]; }
        }
      }
      const o = (y * ow + x) * 2;
      data[o] = Math.max(0, Math.min(255, Math.round(128 + 127 * a * inv)));
      data[o + 1] = Math.max(0, Math.min(255, Math.round(128 + 127 * b * inv)));
    }
  }
  return { data, width: ow, height: oh, regions };
}
