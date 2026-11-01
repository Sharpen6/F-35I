// Fetch helpers for data/terrain/ (browser only).

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

export async function fetchJSON(url) {
  return (await get(url)).json();
}

/** Little-endian Uint16 array (all platforms the sim runs on are little-endian). */
export async function fetchU16(url) {
  const buf = await (await get(url)).arrayBuffer();
  return new Uint16Array(buf);
}

/** Decoded image, untouched pixel values (no colour management, no premultiplication). */
export async function fetchBitmap(url) {
  const blob = await (await get(url)).blob();
  return createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/**
 * 8-bit land cover PNG -> {codes: Uint8Array (row 0 = north), width, height}.
 * Read in horizontal strips to keep the temporary RGBA buffers small.
 */
export async function fetchCodes(url) {
  const bmp = await fetchBitmap(url);
  const w = bmp.width, h = bmp.height;
  const codes = new Uint8Array(w * h);
  const stripH = Math.max(1, Math.min(h, Math.floor(4194304 / w)));
  const canvas = new OffscreenCanvas(w, stripH);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  for (let y0 = 0; y0 < h; y0 += stripH) {
    const sh = Math.min(stripH, h - y0);
    g.clearRect(0, 0, w, stripH);
    g.drawImage(bmp, 0, y0, w, sh, 0, 0, w, sh);
    const px = g.getImageData(0, 0, w, sh).data;
    const base = y0 * w;
    for (let i = 0, n = w * sh; i < n; i++) codes[base + i] = px[i * 4];
  }
  bmp.close();
  return { codes, width: w, height: h };
}

/** Runs fn over items with at most `limit` promises in flight. */
export async function runPool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
