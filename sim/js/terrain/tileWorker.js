// Module worker: loads one L0 tile, its colour JPEG and its field data, and decodes both, so
// the main thread only uploads textures.
//
// The field data (class, row direction, field random per 10 m texel: fieldAnalysis.js) comes
// from the data build (sim/tools/terrain/fields.py, data/terrain_extra/fields/), made over the
// whole core so that fields keep their rows across tile edges. Without it (fieldsUrl null) the
// worker reads the land cover PNG and runs the field analysis on this tile alone.
//
// in:  {id, colorUrl, lcUrl, fieldsUrl}
// out: {id, bitmap (ImageBitmap, transferred), codes (Uint8Array, WorldCover), data (Uint16Array), width}
//      or {id, error}

import { analyzeTile, packCodes, CLASS_CODES, DATA_N } from './fieldAnalysis.js';

const ANALYSIS_N = 512;
const BITMAP_OPTS = { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
// WorldCover code of every class index (the mapped classes 12-14 stand on tree, crop and built-up
// land; only the water code matters to the physics, LandCover.waterWeight)
const CODE_OF = new Uint8Array(16);
CLASS_CODES.forEach((c, i) => { CODE_OF[i] = c; });
CODE_OF[12] = 10; CODE_OF[13] = 40; CODE_OF[14] = 50;

async function blob(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.blob();
}

/** The data build's field data: gzip of n x n little-endian uint16 (a server may already have
 *  unpacked it: then the bytes do not start with the gzip magic). */
async function fieldData(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  let buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = new Uint8Array(await new Response(s).arrayBuffer());
  }
  if (buf.byteLength !== DATA_N * DATA_N * 2) throw new Error(`${url}: ${buf.byteLength} bytes`);
  return new Uint16Array(buf.buffer, buf.byteOffset, DATA_N * DATA_N);
}

async function landCover(url) {
  const lcBmp = await createImageBitmap(await blob(url), BITMAP_OPTS);
  const w = lcBmp.width, h = lcBmp.height;
  const cv = new OffscreenCanvas(w, h);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(lcBmp, 0, 0);
  const px = g.getImageData(0, 0, w, h).data;
  lcBmp.close();
  const codes = new Uint8Array(w * h);
  for (let i = 0; i < codes.length; i++) codes[i] = px[i * 4];
  return { codes, w, h };
}

self.onmessage = async (e) => {
  const { id, colorUrl, lcUrl, fieldsUrl, analyze = true } = e.data;
  try {
    const bitmapP = blob(colorUrl).then((b) => createImageBitmap(b, BITMAP_OPTS));
    let data = null;
    if (fieldsUrl) {
      try { data = await fieldData(fieldsUrl); } catch (err) { data = null; }
    }
    let codes, w;
    if (data) {
      w = DATA_N;
      codes = new Uint8Array(w * w);
      for (let i = 0; i < codes.length; i++) codes[i] = CODE_OF[data[i] & 15];
    } else {
      const lc = await landCover(lcUrl);
      codes = lc.codes;
      w = lc.w;
      if (analyze && lc.w === lc.h) {
        const bmp = await bitmapP;
        const c2 = new OffscreenCanvas(ANALYSIS_N, ANALYSIS_N);
        const g2 = c2.getContext('2d', { willReadFrequently: true });
        g2.imageSmoothingEnabled = true;
        g2.imageSmoothingQuality = 'high';
        g2.drawImage(bmp, 0, 0, ANALYSIS_N, ANALYSIS_N);
        data = analyzeTile(g2.getImageData(0, 0, ANALYSIS_N, ANALYSIS_N).data, ANALYSIS_N, codes, w);
      } else {
        data = packCodes(codes, w);
      }
    }
    const bitmap = await bitmapP;
    const copy = data.byteOffset === 0 && data.buffer.byteLength === data.byteLength ? data : data.slice();
    self.postMessage({ id, bitmap, codes, data: copy, width: w }, [bitmap, codes.buffer, copy.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
