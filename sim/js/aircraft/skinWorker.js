// Worker for skin.js: the panel-tone texture of a skin atlas from its ORM image (skinTones.js),
// off the main thread (a 2048 x 2048 ORM takes ~0.1-0.3 s).
//   in:  { id, bitmap: ImageBitmap (transferred), scale }
//   out: { id, data: Uint8Array RG8, width, height, regions } or { id, error }

import { panelTones } from './skinTones.js';

self.onmessage = (e) => {
  const { id, bitmap, scale } = e.data;
  try {
    const w = bitmap.width, h = bitmap.height;
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = g.getImageData(0, 0, w, h).data;
    const r = panelTones(rgba, w, h, scale || 2);
    self.postMessage({ id, data: r.data, width: r.width, height: r.height, regions: r.regions }, [r.data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
