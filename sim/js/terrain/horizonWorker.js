// Module worker: horizon maps for the terrain's shadows (see horizonMap.js, horizonCore.js).
// It reads the height tiles itself (the browser's HTTP cache has them after Terrain.load), so
// the main thread neither copies 42 MB of heights nor blocks while the maps are computed.
//
// in:  {type: 'init', baseUrl}            out: {type: 'ready'} | {type: 'error', message}
//      {type: 'job', id, layers: [job...]} out: {type: 'result', id, maps: [Uint8Array...]}

import { HeightField, TILES } from './HeightField.js';
import { computeHorizon } from './horizonCore.js';

let hf = null;

async function u16(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint16Array(await r.arrayBuffer());
}

async function init(baseUrl) {
  const f = new HeightField();
  const jobs = [];
  for (let iz = 0; iz < TILES; iz++) for (let ix = 0; ix < TILES; ix++) jobs.push([ix, iz]);
  let next = 0;
  const pool = Array.from({ length: 6 }, async () => {
    while (next < jobs.length) {
      const [ix, iz] = jobs[next++];
      f.setCoreTile(ix, iz, await u16(`${baseUrl}height/tile_${ix}_${iz}.bin`));
    }
  });
  await Promise.all(pool);
  f.setFar(await u16(`${baseUrl}height/far.bin`));
  hf = f;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await init(msg.baseUrl);
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'job') {
      const h = (x, z) => hf.heightAt(x, z);
      const maps = msg.layers.map((job) => computeHorizon(h, job));
      self.postMessage({ type: 'result', id: msg.id, maps }, maps.map((m) => m.buffer));
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
};
