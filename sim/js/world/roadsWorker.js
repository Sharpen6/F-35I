// Roads worker (module worker, created by js/world/Roads.js): builds the draped road meshes off
// the main thread. Messages in:
//   {type: 'tile', key, ix, iz, road: ArrayBuffer | null, heights: Float32Array, extra, polygons, lanes}
//        a tile's road file, its terrain heights (js/world/roadMesh.js HGRID layout) and its
//        airfield surfaces; kept until 'drop'. lanes: send the tile's traffic lanes back
//   {type: 'chunk', id, key, cx, cz, group}   build one chunk of a kept tile
//   {type: 'drop', key}
// Messages out:
//   {type: 'noise', data: Uint8Array}   the shaders' noise texture (once, at start)
//   {type: 'lanes', key, ix, iz, lanes}  roadMesh.js trafficLanes of a tile (js/world/Traffic.js)
//   {type: 'chunk', id, key, cx, cz, group, chunk | null, error} (buffers transferred)

import { parseRoadTile, prepareTile, buildChunk, chunkTransfer, TileGround, makeNoiseData, trafficLanes, lanesTransfer } from './roadMesh.js';

const tiles = new Map();

{
  const data = makeNoiseData();
  self.postMessage({ type: 'noise', data }, [data.buffer]);
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'tile') {
    try {
      const road = m.road ? parseRoadTile(m.road) : null;
      const ground = new TileGround(m.heights);
      tiles.set(m.key, { prep: prepareTile(road, m.extra || [], m.polygons || []), ground });
      const lanes = m.lanes ? trafficLanes(road, ground, m.ix, m.iz) : null;
      if (lanes) self.postMessage({ type: 'lanes', key: m.key, ix: m.ix, iz: m.iz, lanes }, lanesTransfer(lanes));
    } catch (err) {
      tiles.set(m.key, { error: err.message });
    }
  } else if (m.type === 'drop') {
    tiles.delete(m.key);
  } else if (m.type === 'chunk') {
    const t = tiles.get(m.key);
    let chunk = null, error = null;
    if (!t) error = 'tile not loaded';
    else if (t.error) error = t.error;
    else {
      try { chunk = buildChunk(t.prep, t.ground, m.cx, m.cz, m.group); } catch (err) { error = err.message; }
    }
    self.postMessage({ type: 'chunk', id: m.id, key: m.key, cx: m.cx, cz: m.cz, group: m.group, chunk, error }, chunkTransfer(chunk));
  }
};
