// Module worker: loads one L0 tile (colour JPEG + land cover PNG), decodes both and runs the
// field analysis (fieldAnalysis.js), so the main thread only uploads textures.
//
// in:  {id, colorUrl, lcUrl}
// out: {id, bitmap (ImageBitmap, transferred), codes (Uint8Array), data (Uint16Array), width}
//      or {id, error}

import { analyzeTile, packCodes } from './fieldAnalysis.js';

const ANALYSIS_N = 512;
const BITMAP_OPTS = { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };

async function blob(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.blob();
}

self.onmessage = async (e) => {
  const { id, colorUrl, lcUrl, analyze = true } = e.data;
  try {
    const [cb, lb] = await Promise.all([blob(colorUrl), blob(lcUrl)]);
    const [bitmap, lcBmp] = await Promise.all([createImageBitmap(cb, BITMAP_OPTS), createImageBitmap(lb, BITMAP_OPTS)]);
    // land cover codes (red channel of the 8-bit PNG)
    const w = lcBmp.width, h = lcBmp.height;
    const cv = new OffscreenCanvas(w, h);
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(lcBmp, 0, 0);
    const px = g.getImageData(0, 0, w, h).data;
    lcBmp.close();
    const codes = new Uint8Array(w * h);
    for (let i = 0; i < codes.length; i++) codes[i] = px[i * 4];
    let data;
    if (analyze && w === h) {
      const c2 = new OffscreenCanvas(ANALYSIS_N, ANALYSIS_N);
      const g2 = c2.getContext('2d', { willReadFrequently: true });
      g2.imageSmoothingEnabled = true;
      g2.imageSmoothingQuality = 'high';
      g2.drawImage(bitmap, 0, 0, ANALYSIS_N, ANALYSIS_N);
      data = analyzeTile(g2.getImageData(0, 0, ANALYSIS_N, ANALYSIS_N).data, ANALYSIS_N, codes, w);
    } else {
      data = packCodes(codes, w);
    }
    self.postMessage({ id, bitmap, codes, data, width: w }, [bitmap, codes.buffer, data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
