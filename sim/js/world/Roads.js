// Roads, railways and airfield surfaces near the camera (graphics module, see main.js addModule).
//
//   const roads = new Roads({ renderer, scene, camera, env, terrain, app });
//   roads.update(f); roads.setQuality('high'); roads.setTime(h); roads.dispose();
//
// Data: data/world/roads/ (sim/tools/world/roads.py: OpenStreetMap via Overture, one file per
// terrain L0 tile) and data/world/airfields/airfields.json (sim/tools/world/airfields.py:
// taxiways, aprons, holding positions, light layouts). Both are optional: without them the module
// draws nothing and the imagery shows the roads as before.
//
// Rendering: crisp ribbons draped exactly on the terrain (js/world/roadMesh.js, built in a worker
// per 1600 m chunk), shaded by class with markings (js/world/roadShaders.js) and faded into the
// imagery before the terrain mesh coarsens (3.84 km): main roads, railways and airfields over
// the quality's long range, residential streets, service roads and tracks over a shorter one.
// The airfield lights are js/world/AirportLights.js, owned by this module (one hook in main.js).
//
// URL parameters: roads=0 turns roads and airfield surfaces off, airportlights=0 the lights.

import * as THREE from 'three';
import { HGRID, TILE_M, CORE_HALF, CHUNK_M, CHUNKS } from './roadMesh.js';
import { ROAD_VERT, ROAD_FRAG, MAX_MASTS } from './roadShaders.js';
import { AirportLights, skyIlluminance } from './AirportLights.js';

const FAR_HALF = 204800;
const LUX_TO_SCENE = 1 / 32000;          // scene irradiance unit (Environment SUN_ILLUMINANCE 4 = ~128 klux)
const ADAPTED_EXPOSURE = 1400;           // eye adapted to lit streets / aprons (daylight ~0.9 at 128 klux)

/**
 * Per quality: draw range (3D distance, m) of group 0 (main roads, railways, airfields) and group 1
 * (streets, service roads, tracks), the share of it used for the fade-out, shading detail.
 * The long range stays inside the terrain's exact level-0 mesh (0.8 x 4800 m).
 */
const QUALITY = {
  low: { range: [1500, 650], fade: 0.3, detail: 0.45, inflight: 1 },
  medium: { range: [2400, 1100], fade: 0.28, detail: 0.8, inflight: 2 },
  high: { range: [3400, 1600], fade: 0.25, detail: 1.0, inflight: 3 },
};
const PREFETCH = 350;                    // chunks are built this far beyond the draw range
const KEEP = 900;                        // and dropped this far beyond it

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

// ------------------------------------------------------------------------------------------
// procedural noise texture (tiling value noise, a different scale per channel)

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 256 x 256 RGBA, every channel mean 0.5: r grain, g blotches, b streaks / stains, a large patches. */
export function makeNoiseData(size = 256) {
  const rnd = mulberry32(20261101);
  const lattices = new Map();
  const lattice = (n) => {
    if (!lattices.has(n)) { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = rnd(); lattices.set(n, a); }
    return lattices.get(n);
  };
  const value = (n, x, y) => {      // x, y in 0..1 (tiling), n lattice cells per tile
    const L = lattice(n);
    const gx = x * n, gy = y * n;
    const xi = Math.floor(gx), yi = Math.floor(gy), fx = gx - xi, fy = gy - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const i0 = ((xi % n) + n) % n, i1 = (i0 + 1) % n, j0 = ((yi % n) + n) % n, j1 = (j0 + 1) % n;
    const a = L[j0 * n + i0], b = L[j0 * n + i1], c = L[j1 * n + i0], d = L[j1 * n + i1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
  const octaves = [
    [[256, 0.6], [128, 0.4]],                 // r: grain
    [[8, 0.5], [16, 0.3], [32, 0.2]],         // g: blotches
    [[16, 0.45], [32, 0.35], [64, 0.2]],      // b: streaks / stains
    [[2, 0.5], [4, 0.3], [8, 0.2]],           // a: large patches
  ];
  const ch = octaves.map(() => new Float32Array(size * size));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (const [n, w] of octaves[c]) s += w * value(n, u, v);
        ch[c][y * size + x] = s;
      }
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let c = 0; c < 4; c++) {
    const a = ch[c];
    let m = 0, m2 = 0;
    for (let i = 0; i < a.length; i++) { m += a[i]; m2 += a[i] * a[i]; }
    m /= a.length;
    const sd = Math.sqrt(Math.max(m2 / a.length - m * m, 1e-9));
    for (let i = 0; i < a.length; i++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(127.5 + (a[i] - m) / sd * 0.2 * 255)));
  }
  return data;
}

function makeNoiseTexture(renderer) {
  const size = 256;
  const t = new THREE.DataTexture(makeNoiseData(size), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'RoadNoise';
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------------------------------

export class Roads {
  constructor({ renderer, scene, camera, env, terrain, app, baseUrl = 'data/world/' }) {
    this.name = 'roads';
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.env = env;
    this.terrain = terrain;
    this.app = app;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    // off with ?roads=0, and on the stand-in terrain of ?stubs=1 (no height field to drape on)
    this.enabled = params.get('roads') !== '0' && !!terrain.hf;
    // shown in the start menu after the terrain's credits (main.js); the data's own attribution
    // (index.json, airfields.json) says the same
    this.credits = this.enabled ? 'Roads, railways and airfields: \u00a9 OpenStreetMap contributors (ODbL), via Overture Maps Foundation.' : '';
    this.quality = 'high';
    this.Q = QUALITY.high;
    this.index = null;
    this.airfields = null;
    this.ready = false;
    this.attribution = '';
    this.stats = { chunks: 0, visible: 0, triangles: 0, building: 0, tiles: 0, bytes: 0, buildMs: 0 };

    this.group = new THREE.Group();
    this.group.name = 'Roads';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    this._tiles = new Map();          // 'ix,iz' -> {state, ix, iz, chunks: Set of chunk keys}
    this._chunks = new Map();         // 'ix,iz,cx,cz,g' -> {state, mesh, ix, iz, cx, cz, group, dist}
    this._queue = [];
    this._inflight = 0;
    this._nextId = 1;
    this._cam = new THREE.Vector3();
    this._lastSel = new THREE.Vector3(1e9, 0, 0);
    this._selFrame = -1e9;
    this._frame = 0;
    this._lightsOn = 0;

    const noise = makeNoiseTexture(renderer);
    this._noise = noise;
    const ov = terrain.textures && terrain.textures.overview;
    if (!ov) {
      this._grey = new THREE.DataTexture(new Uint8Array([120, 110, 95, 255]), 1, 1);
      this._grey.needsUpdate = true;
    }
    this._shared = {
      uNoise: { value: noise },
      uOverview: { value: ov || this._grey },
      uAlbedoGain: { value: terrain.albedoGain ?? 0.7 },
      uArt: { value: new THREE.Vector4(0, LUX_TO_SCENE, 1, 0) },
      uMasts: { value: Array.from({ length: MAX_MASTS }, () => new THREE.Vector4()) },
      uMastCount: { value: 0 },
    };
    this.materials = [this._makeMaterial(0), this._makeMaterial(1)];
    this.lights = params.get('airportlights') === '0' ? null : new AirportLights({ renderer, scene, camera, env, terrain, app, roads: this });

    this._worker = null;
    if (this.enabled) this._load();
  }

  _makeMaterial(group) {
    const lights = THREE.UniformsUtils.clone(THREE.UniformsLib.lights);
    const m = new THREE.ShaderMaterial({
      name: `Roads${group}`,
      uniforms: { ...lights, ...this.env.uniforms, ...this._shared, uFade: { value: new THREE.Vector2(2500, 3400) } },
      vertexShader: ROAD_VERT,
      fragmentShader: ROAD_FRAG,
      lights: true,
      fog: false,
      // opaque list (drawn after the terrain, before anything transparent), but blended: the soft
      // edges and the distance fade mix into the terrain under them
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthWrite: true,
    });
    return m;
  }

  async _load() {
    const B = this.baseUrl;
    const get = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [index, airfields] = await Promise.all([get(B + 'roads/index.json'), get(B + 'airfields/airfields.json')]);
    if (!index && !airfields) {
      console.warn('Roads: no data in data/world/roads/ or data/world/airfields/ (sim/tools/world/ROADS.md); roads off');
      return;
    }
    this.index = index;
    this.airfields = airfields;
    this.attribution = [index && index.attribution, airfields && airfields.attribution].filter(Boolean).join(' | ');
    try {
      this._worker = new Worker(new URL('./roadsWorker.js', import.meta.url), { type: 'module' });
      this._worker.onmessage = (e) => this._onWorker(e.data);
      this._worker.onerror = (e) => { console.warn('Roads worker:', e.message); };
    } catch (e) {
      console.warn('Roads: no module worker', e);
      return;
    }
    this.lights?.setAirfields(airfields);
    this.ready = true;
  }

  // -------------------------------------------------------------------------------------- module API

  setQuality(q) {
    this.quality = QUALITY[q] ? q : 'high';
    this.Q = QUALITY[this.quality];
    this._selFrame = -1e9;
    this.lights?.setQuality(q);
  }

  setTime(h, day) {
    this.lights?.setTime(h, day);
  }

  reset() {
    this._selFrame = -1e9;
    this.lights?.reset();
  }

  update(f) {
    this._frame++;
    const cam = f.camera.getWorldPosition(this._cam);
    this.lights?.update(f);
    if (!this.ready || !this.enabled) { this.group.visible = false; return; }
    this.group.visible = true;
    const Q = this.Q;
    for (let g = 0; g < 2; g++) this.materials[g].uniforms.uFade.value.set(Q.range[g] * (1 - Q.fade), Q.range[g]);
    this._updateLightUniforms(cam);

    if (this._frame - this._selFrame > 20 || cam.distanceToSquared(this._lastSel) > 60 * 60) this._select(cam);
    this._pump();

    // visibility by 3D distance (frustum culling is three's, by the chunk spheres)
    let vis = 0, tris = 0;
    for (const c of this._chunks.values()) {
      if (!c.mesh) continue;
      c.dist = this._chunkDistance(c.ix, c.iz, c.cx, c.cz, cam);
      c.mesh.visible = c.dist < Q.range[c.group];
      if (c.mesh.visible) { vis++; tris += c.tris; }
    }
    this.stats.visible = vis;
    this.stats.triangles = tris;
  }

  /** Street lights and floodlights: on from a little before sunset; brightness for night eyes. */
  _updateLightUniforms(cam) {
    const S = this._shared;
    const el = this.env.sunElevationDeg ?? 30;
    const on = Math.min(1, Math.max(0, (2.5 - el) / 3.5));
    // The display keeps a night scene darker than a dark-adapted eye sees it (the exposure is
    // capped). Once the sky's own light is negligible next to the lamps (below ~30 lux, sun
    // under -4 deg), lit surfaces get the missing adaptation: up to the exposure of an eye
    // adapted to lit streets and aprons. At dusk the sky still lights the ground, the lamps add
    // their few tens of lux to it and the gain stays 1 (a lit apron is a little brighter, no more).
    const exp = Math.max(this.env.exposure ?? 1, 1e-3);
    const t = Math.min(1, Math.max(0, (1.5 - Math.log10(skyIlluminance(el))) / 2));
    const night = t * t * (3 - 2 * t);
    const gain = Math.max(1, 1 + night * (ADAPTED_EXPOSURE / exp - 1));
    S.uArt.value.set(on, LUX_TO_SCENE * gain, this.Q.detail, 0);
    S.uAlbedoGain.value = this.terrain.albedoGain ?? 0.7;
    this._lightsOn = on;
    // the floodlight masts nearest the camera
    const masts = this.airfields && this.airfields.masts;
    let n = 0;
    if (on > 0 && masts && masts.length) {
      const near = [];
      for (const m of masts) {
        const d2 = (m[0] - cam.x) ** 2 + (m[1] - cam.z) ** 2;
        if (d2 < 5000 * 5000) near.push([d2, m]);
      }
      near.sort((a, b) => a[0] - b[0]);
      for (const [, m] of near.slice(0, MAX_MASTS)) S.uMasts.value[n++].set(m[0], m[1], m[2], m[3]);
    }
    S.uMastCount.value = n;
  }

  // -------------------------------------------------------------------------------------- streaming

  _chunkDistance(ix, iz, cx, cz, cam) {
    const x0 = -CORE_HALF + ix * TILE_M + cx * CHUNK_M, z0 = -CORE_HALF + iz * TILE_M + cz * CHUNK_M;
    const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - CHUNK_M);
    const dz = Math.max(z0 - cam.z, 0, cam.z - z0 - CHUNK_M);
    let dy = 0;
    const hf = this.terrain.hf;
    if (hf && hf.minMax) {
      const [mn, mx] = hf.nodeMinMax(0, (x0 + FAR_HALF) / CHUNK_M, (z0 + FAR_HALF) / CHUNK_M);
      dy = Math.max(0, cam.y - mx, mn - cam.y);
    }
    return Math.hypot(dx, dy, dz);
  }

  _hasData(ix, iz) {
    const k = `${ix},${iz}`;
    return !!((this.index && this.index.files && this.index.files[k]) || (this.airfields && this.airfields.tiles && this.airfields.tiles[k]));
  }

  _select(cam) {
    this._selFrame = this._frame;
    this._lastSel.copy(cam);
    const Q = this.Q, R = Math.max(Q.range[0], Q.range[1]) + PREFETCH;
    const want = [];
    const i0 = Math.max(0, Math.floor((cam.x - R + CORE_HALF) / TILE_M)), i1 = Math.min(15, Math.floor((cam.x + R + CORE_HALF) / TILE_M));
    const j0 = Math.max(0, Math.floor((cam.z - R + CORE_HALF) / TILE_M)), j1 = Math.min(15, Math.floor((cam.z + R + CORE_HALF) / TILE_M));
    for (let iz = j0; iz <= j1; iz++) {
      for (let ix = i0; ix <= i1; ix++) {
        if (!this._hasData(ix, iz)) continue;
        for (let cz = 0; cz < CHUNKS; cz++) {
          for (let cx = 0; cx < CHUNKS; cx++) {
            const d = this._chunkDistance(ix, iz, cx, cz, cam);
            for (let g = 0; g < 2; g++) if (d < Q.range[g] + PREFETCH) want.push({ ix, iz, cx, cz, g, d });
          }
        }
      }
    }
    want.sort((a, b) => a.d - b.d);
    const wanted = new Set();
    this._queue = [];
    for (const w of want) {
      const key = `${w.ix},${w.iz},${w.cx},${w.cz},${w.g}`;
      wanted.add(key);
      if (!this._chunks.has(key)) this._queue.push({ ...w, key });
    }
    // drop chunks well out of range
    for (const [key, c] of this._chunks) {
      if (c.state === 'queued') continue;
      const d = this._chunkDistance(c.ix, c.iz, c.cx, c.cz, cam);
      if (d > Q.range[c.group] + KEEP && !wanted.has(key)) this._dropChunk(key, c);
    }
    // drop worker tiles nothing needs any more
    for (const [tk, t] of this._tiles) {
      let used = false;
      for (const key of t.chunks) if (this._chunks.has(key)) { used = true; break; }
      if (!used && !this._queue.some((q) => `${q.ix},${q.iz}` === tk)) {
        if (t.state === 'ready') this._worker.postMessage({ type: 'drop', key: tk });
        if (t.state !== 'loading') this._tiles.delete(tk);
      }
    }
    this.stats.tiles = this._tiles.size;
  }

  _pump() {
    while (this._inflight < this.Q.inflight && this._queue.length) {
      const w = this._queue[0];
      const tk = `${w.ix},${w.iz}`;
      let t = this._tiles.get(tk);
      if (!t) { t = this._loadTile(w.ix, w.iz); }
      if (t.state === 'loading') return;              // wait for this tile (nearest first)
      this._queue.shift();
      if (t.state === 'failed') continue;
      if (this._chunks.has(w.key)) continue;
      const id = this._nextId++;
      this._chunks.set(w.key, { state: 'queued', id, mesh: null, ix: w.ix, iz: w.iz, cx: w.cx, cz: w.cz, group: w.g, dist: w.d, tris: 0 });
      t.chunks.add(w.key);
      this._inflight++;
      this._worker.postMessage({ type: 'chunk', id, key: tk, cx: w.cx, cz: w.cz, group: w.g });
    }
    this.stats.building = this._inflight;
  }

  _loadTile(ix, iz) {
    const key = `${ix},${iz}`;
    const t = { key, ix, iz, state: 'loading', chunks: new Set() };
    this._tiles.set(key, t);
    const hasRoad = !!(this.index && this.index.files && this.index.files[key]);
    const p = hasRoad ? fetch(`${this.baseUrl}roads/tile_${ix}_${iz}.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null) : Promise.resolve(null);
    p.then((buf) => {
      if (this._tiles.get(key) !== t) return;
      const af = this.airfields && this.airfields.tiles && this.airfields.tiles[key];
      const heights = this._tileHeights(ix, iz);
      const msg = { type: 'tile', key, road: buf, heights, extra: af ? af.taxiways || [] : [], polygons: af ? af.aprons || [] : [] };
      this._worker.postMessage(msg, [heights.buffer].concat(buf ? [buf] : []));
      t.state = 'ready';
    }).catch((e) => { console.warn('Roads tile', key, e); t.state = 'failed'; });
    return t;
  }

  /** Terrain heights of tile (ix, iz) with a one-sample border, HGRID x HGRID (roadMesh.js layout). */
  _tileHeights(ix, iz) {
    const H = new Float32Array(HGRID * HGRID);
    const hf = this.terrain.hf;
    const x0 = -CORE_HALF + ix * TILE_M, z0 = -CORE_HALF + iz * TILE_M;
    const gi0 = ix * 256, gj0 = iz * 256;
    for (let j = -1; j <= 257; j++) {
      for (let i = -1; i <= 257; i++) {
        const gi = gi0 + i, gj = gj0 + j;
        const h = hf && gi >= 0 && gj >= 0 && gi <= 4096 && gj <= 4096
          ? hf.coreSample(gi, gj) : this.terrain.heightAt(x0 + i * 25, z0 + j * 25);
        H[(j + 1) * HGRID + i + 1] = h;
      }
    }
    return H;
  }

  _onWorker(m) {
    if (m.type !== 'chunk') return;
    this._inflight = Math.max(0, this._inflight - 1);
    const key = `${m.key},${m.cx},${m.cz},${m.group}`;
    const c = this._chunks.get(key);
    if (!c || c.id !== m.id) return;                   // dropped meanwhile
    if (m.error) { console.warn('Roads chunk', key, m.error); c.state = 'failed'; return; }
    if (!m.chunk) { c.state = 'empty'; return; }
    c.mesh = this._makeMesh(m.chunk, c);
    c.tris = m.chunk.ni / 3;
    c.bytes = m.chunk.n * 36 + m.chunk.idx.byteLength;
    c.state = 'built';
    this.group.add(c.mesh);
    this.stats.chunks++;
    this.stats.bytes += c.bytes;
    this.stats.buildMs += m.chunk.stats.ms;
  }

  _makeMesh(ch, c) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(ch.pos, 3));
    g.setAttribute('aUV', new THREE.BufferAttribute(ch.uv, 2));
    g.setAttribute('aJd', new THREE.Float16BufferAttribute(ch.jd, 2));
    g.setAttribute('aNrm', new THREE.BufferAttribute(ch.nrm, 2, true));
    g.setAttribute('aInfo', new THREE.BufferAttribute(ch.info, 4));
    g.setAttribute('aSect', new THREE.BufferAttribute(ch.sect, 4));
    g.setAttribute('aRad', new THREE.BufferAttribute(ch.rad, 2));
    g.setIndex(new THREE.BufferAttribute(ch.idx, 1));
    const cy = (ch.minY + ch.maxY) / 2 - ch.baseY;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, cy, 0), Math.hypot(CHUNK_M / 2, CHUNK_M / 2, (ch.maxY - ch.minY) / 2) + 30);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-CHUNK_M / 2, ch.minY - ch.baseY - 1, -CHUNK_M / 2), new THREE.Vector3(CHUNK_M / 2, ch.maxY - ch.baseY + 1, CHUNK_M / 2));
    const mesh = new THREE.Mesh(g, this.materials[ch.group]);
    mesh.name = `Roads ${c.ix},${c.iz} ${c.cx},${c.cz} g${ch.group}`;
    mesh.position.set(-CORE_HALF + c.ix * TILE_M + ch.ox, ch.baseY, -CORE_HALF + c.iz * TILE_M + ch.oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 1;
    mesh.visible = false;
    return mesh;
  }

  _dropChunk(key, c) {
    if (c.mesh) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
      this.stats.chunks--;
      this.stats.bytes -= c.bytes || 0;
    }
    this._chunks.delete(key);
  }

  dispose() {
    for (const [key, c] of [...this._chunks]) this._dropChunk(key, c);
    this._worker?.terminate();
    this.scene.remove(this.group);
    for (const m of this.materials) m.dispose();
    this._noise.dispose();
    this._grey?.dispose();
    this.lights?.dispose();
  }
}
