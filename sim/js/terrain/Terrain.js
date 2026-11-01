// Terrain: central Israel from data/terrain/ (see sim/DESIGN.md and js/terrain/README.md).
//
//   const terrain = new Terrain({ renderer, scene, env });
//   await terrain.load((fraction, label) => ...);
//   // every frame, after env.update(camera, dt):
//   terrain.update(camera);
//   terrain.heightAt(x, z); terrain.normalAt(x, z, v3); terrain.surfaceAt(x, z);
//   terrain.sunVisibilityAt(x, y, z);      // 0 = in the shadow of the hills, 1 = sunlit
//   app.addModule(terrain.module);         // quality settings
//
// Rendering: one CDLOD quadtree over the whole 409.6 km far area (js/terrain/QuadTree.js),
// drawn as instanced 64 x 64 grid patches whose vertex shader reads the heights from
// integer textures, morphs between levels and bends with the earth's curvature. Patches
// near the camera (6.4 km and smaller) are drawn with a material for their L0 colour tile
// (6.25 m / px); at most MAX_TILES tiles are resident, streamed in by distance and faded in.
// Tiles are fetched, decoded and analysed (field and row directions, fieldAnalysis.js) in
// workers (tileWorker.js). The terrain's shadows come from horizon maps (horizonMap.js).

import * as THREE from 'three';
import {
  HeightField, CORE_HALF, FAR_HALF, TILE_M, TILES, CORE_N, FAR_N, CORE_SPACING, FAR_SPACING,
} from './HeightField.js';
import { QuadTree, GRID, RANGE0, MORPH_START, MORPH_END } from './QuadTree.js';
import { Runways, LandCover, surfaceType } from './Surface.js';
import {
  makePackedHeightTexture, makePackedCodeTexture, makeColorTexture, makeTileDataTexture, releasePacked,
  renderNormalMap, floatTargetsSupported, FAR_HEIGHT_X,
} from './textures.js';
import { makeDetailArray } from './detailTextures.js';
import { TERRAIN_VERT, TERRAIN_FRAG, MAX_RWY } from './terrainShaders.js';
import { HorizonMap } from './horizonMap.js';
import { packCodes, DATA_N } from './fieldAnalysis.js';
import { fetchJSON, fetchU16, fetchBitmap, fetchCodes, runPool } from './loaders.js';

/** Most L0 colour tiles kept on the GPU at once (each ~6 MB with mipmaps, + 0.8 MB data). */
export const MAX_TILES = 64;
/** L0 tiles are wanted within this 3D distance of the camera. */
const TILE_RANGE = 17000;
const MAX_INFLIGHT = 4;
const TILE_WORKERS = 2;
const BASE_CAPACITY = 1024;
const TILE_CAPACITY = 64;
const FADE_MS = 700;
const DEFAULT_ATTRIBUTION = 'Copernicus DEM GLO-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, '
  + 'provided under COPERNICUS by the European Union and ESA | ESA WorldCover 2021 (CC BY 4.0) | OurAirports (public domain)';

/** Per quality: near ground materials, horizon map size (horizonMap.js), city light dots. */
export const TERRAIN_QUALITY = {
  low: { groundDetail: 0, horizon: 'low' },
  medium: { groundDetail: 1, horizon: 'medium' },
  high: { groundDetail: 1, horizon: 'high' },
};

const tileKey = (ix, iz) => `${ix},${iz}`;

function urlSwitch(name) {
  try {
    const p = new URLSearchParams(globalThis.location?.search || '');
    return p.has(name) ? p.get(name) !== '0' : null;
  } catch (e) { return null; }
}

function gridTemplate(n) {
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let k = 0;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { pos[k++] = i; pos[k++] = 0; pos[k++] = j; }
  const idx = new Uint16Array(n * n * 6);
  k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      // split along the NW-SE diagonal a-d (HeightField.heightAt relies on this)
      idx[k++] = a; idx[k++] = c; idx[k++] = d;
      idx[k++] = a; idx[k++] = d; idx[k++] = b;
    }
  }
  return { position: new THREE.BufferAttribute(pos, 3), index: new THREE.BufferAttribute(idx, 1) };
}

/** "15" -> 15, "08L" -> 108, "26R" -> 226, "12C" -> 312 (number + 100 * suffix). */
function designatorCode(id) {
  const m = /^(\d{1,2})([LRC]?)/i.exec(String(id || '').trim());
  if (!m) return 0;
  const suf = { '': 0, L: 1, R: 2, C: 3 }[m[2].toUpperCase()];
  return Number(m[1]) + 100 * suf;
}

class PatchGroup {
  constructor(templates, capacity, material, renderOrder) {
    this.capacity = capacity;
    this.meshes = [];
    this.attrs = [];
    this.counts = [0, 0];
    for (const tpl of templates) {
      const g = new THREE.InstancedBufferGeometry();
      g.setIndex(tpl.index);
      g.setAttribute('position', tpl.position);
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aNode', attr);
      g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
      const m = new THREE.Mesh(g, material);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.receiveShadow = true;
      m.castShadow = false;
      m.renderOrder = renderOrder;
      m.visible = false;
      m.name = 'TerrainPatches';
      this.meshes.push(m);
      this.attrs.push(attr);
    }
  }

  setMaterial(material) { for (const m of this.meshes) m.material = material; }

  reset() { this.counts[0] = this.counts[1] = 0; }

  push(p) {
    const which = p.half ? 1 : 0;
    const n = this.counts[which];
    if (n >= this.capacity) return false;
    const a = this.attrs[which].array;
    a[n * 4] = p.originU[0]; a[n * 4 + 1] = p.originU[1]; a[n * 4 + 2] = p.stepU; a[n * 4 + 3] = p.level;
    this.counts[which] = n + 1;
    return true;
  }

  commit() {
    let tris = 0;
    for (let w = 0; w < 2; w++) {
      const n = this.counts[w], attr = this.attrs[w], mesh = this.meshes[w];
      mesh.geometry.instanceCount = n;
      mesh.visible = n > 0;
      if (n > 0) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, n * 4);
        attr.needsUpdate = true;
        tris += n * (w ? GRID / 2 : GRID) ** 2 * 2;
      }
    }
    return tris;
  }
}

/** Loads, decodes and analyses L0 tiles in module workers; falls back to the main thread. */
class TileLoader {
  constructor(count) {
    this.workers = [];
    this.jobs = new Map();
    this._id = 0;
    this._next = 0;
    if (typeof Worker === 'undefined') return;
    try {
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this._done(e.data);
        w.onerror = (e) => { console.warn('terrain: tile worker error', e.message || e); this._fail(w); };
        this.workers.push(w);
      }
    } catch (e) {
      console.warn('terrain: no tile workers, loading on the main thread', e);
      this.workers = [];
    }
  }

  /** -> Promise<{bitmap, codes: {codes, width, height}, data: Uint16Array}> */
  load(colorUrl, lcUrl) {
    if (!this.workers.length) return this._mainThread(colorUrl, lcUrl);
    const id = ++this._id;
    const w = this.workers[this._next++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, worker: w, colorUrl, lcUrl });
      w.postMessage({ id, colorUrl, lcUrl });
    });
  }

  async _mainThread(colorUrl, lcUrl) {
    const [bitmap, lc] = await Promise.all([fetchBitmap(colorUrl), fetchCodes(lcUrl)]);
    return { bitmap, codes: lc, data: packCodes(lc.codes, lc.width) };
  }

  _done(m) {
    const job = this.jobs.get(m.id);
    if (!job) { m.bitmap?.close?.(); return; }
    this.jobs.delete(m.id);
    if (m.error) job.reject(new Error(m.error));
    else job.resolve({ bitmap: m.bitmap, codes: { codes: m.codes, width: m.width, height: m.width }, data: m.data });
  }

  _fail(w) {
    // a worker that cannot start (e.g. no module workers): finish its jobs on the main thread
    this.workers = this.workers.filter((x) => x !== w);
    w.terminate();
    for (const [id, job] of this.jobs) {
      if (job.worker !== w) continue;
      this.jobs.delete(id);
      this._mainThread(job.colorUrl, job.lcUrl).then(job.resolve, job.reject);
    }
  }

  dispose() { for (const w of this.workers) w.terminate(); this.workers = []; }
}

export class Terrain {
  constructor({ renderer, scene, env, baseUrl = 'data/terrain/' }) {
    this.renderer = renderer;
    this.scene = scene;
    this.env = env;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.group = new THREE.Group();
    this.group.name = 'Terrain';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    this.manifest = null;
    this.airports = [];
    this.spawns = {};
    this.attribution = '';
    this.hf = new HeightField();
    this.landCover = new LandCover();
    this.runways = new Runways([]);
    this.quadTree = new QuadTree(this.hf);
    this.loaded = false;

    /** Visual tuning. */
    this.detailStrength = 0.9;
    // The imagery is graded for display (bright desert near sRGB 240); scaled down so sunlit
    // ground at noon comes out about as the imagery looks and keeps its relief shading.
    this.albedoGain = 0.7;
    /**
     * Switches (also ?terrainDetail=0, ?terrainShadows=0, ?cityLights=0 in the URL):
     * groundDetail: the near ground materials (rows, furrows, rocks ...) and the smooth
     * (bicubic) magnification of the imagery; shadows: the terrain's shadows on itself;
     * cityLights: street lights at night (a gain, 0 = off).
     */
    this.groundDetail = urlSwitch('terrainDetail') ?? true;
    this.shadows = urlSwitch('terrainShadows') ?? true;
    this.cityLights = urlSwitch('cityLights') === false ? 0 : 1;
    this.quality = 'high';
    /**
     * lod: LOD level colours; wireframe; runways: false hides the procedural runway paint;
     * heightProbe: the terrain writes (height, x, z) of its surface instead of colour, for
     * tests that compare the rendered surface with heightAt (render into a float target);
     * view: false colours: 1 land cover classes, 2 row directions, 3 near detail weight (r),
     * pattern fade (g), detail sun visibility (b), 4 crop state (stubble r, green g, ploughed b).
     */
    this.debug = { lod: false, wireframe: false, runways: true, heightProbe: false, view: 0 };
    this.stats = { patches: 0, triangles: 0, groups: 0, tilesResident: 0, tilesLoading: 0, tilesWanted: 0, horizonComputes: 0, horizonMs: 0 };

    this.tiles = new Map();
    this._tileGroupPool = [];
    this._pending = [];
    this._inflight = 0;
    this._frame = 0;
    this._camPos = new THREE.Vector3();
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.horizon = new HorizonMap();
    this._loader = null;
    /** For app.addModule(): the quality setting (update() is called by main.js itself). */
    this.module = { name: 'terrain', setQuality: (q) => this.setQuality(q) };
    // 3D trees drawn by another module within this range: no painted crowns there
    this._treeCover = new THREE.Vector2(0, 1);
  }

  // -------------------------------------------------------------------------------------
  // loading

  async load(onProgress = () => {}) {
    const B = this.baseUrl;
    const progress = (f, label) => { try { onProgress(Math.min(1, f), label); } catch (e) { /* ignore UI errors */ } };
    progress(0, 'terrain: manifest');
    try {
      this.manifest = await fetchJSON(B + 'manifest.json');
    } catch (e) {
      // the file layout is fixed by DESIGN.md, so the manifest is informational only
      console.warn(`terrain: ${e.message}; using the DESIGN.md layout and default attribution`);
      this.manifest = { attribution: DEFAULT_ATTRIBUTION };
    }
    const att = this.manifest.attribution ?? DEFAULT_ATTRIBUTION;
    this.attribution = Array.isArray(att) ? att.join(' | ') : (typeof att === 'object' && att ? Object.values(att).join(' | ') : (att || ''));
    const [airports, spawns] = await Promise.all([fetchJSON(B + 'airports.json'), fetchJSON(B + 'spawns.json')]);
    this.airports = airports;
    this.spawns = spawns;
    this.runways = new Runways(airports);

    // heights: 256 core tiles + far grid
    const jobs = [];
    for (let iz = 0; iz < TILES; iz++) for (let ix = 0; ix < TILES; ix++) jobs.push([ix, iz]);
    let done = 0;
    await runPool(jobs, 8, async ([ix, iz]) => {
      this.hf.setCoreTile(ix, iz, await fetchU16(`${B}height/tile_${ix}_${iz}.bin`));
      done++;
      if (done % 8 === 0) progress(0.02 + 0.45 * done / jobs.length, `terrain: heights ${done}/${jobs.length}`);
    });
    this.hf.setFar(await fetchU16(B + 'height/far.bin'));
    progress(0.5, 'terrain: imagery');
    this.hf.buildMinMax();

    // overview / far colour and land cover
    const [ovBmp, farBmp, lcOv, lcFar] = await Promise.all([
      fetchBitmap(B + 'color/overview.jpg'), fetchBitmap(B + 'color/far.jpg'),
      fetchCodes(B + 'landcover/overview.png'), fetchCodes(B + 'landcover/far.png'),
    ]);
    this.landCover.overview = lcOv.codes;
    this.landCover.overviewN = lcOv.width;
    this.landCover.far = lcFar.codes;
    this.landCover.farN = lcFar.width;
    progress(0.85, 'terrain: GPU');

    this._buildGpu(ovBmp, farBmp, lcOv, lcFar);
    progress(0.95, 'terrain: shaders');
    this._precompile();
    this._loader = new TileLoader(TILE_WORKERS);
    // the horizon worker reads the heights again (from the HTTP cache) in the background
    this.horizon.start(new URL(B, globalThis.location?.href ?? 'http://localhost/').href);
    this.loaded = true;
    progress(1, 'terrain: ready');
    return this;
  }

  _buildGpu(ovBmp, farBmp, lcOv, lcFar) {
    const r = this.renderer, aniso = this._maxAniso;
    const tex = {};
    // texelFetch grids share textures (sampler budget, see textures.js)
    tex.heights = makePackedHeightTexture(this.hf.core, this.hf.far);
    r.initTexture(tex.heights);
    this._normalCoreRT = renderNormalMap(r, tex.heights, CORE_N, CORE_SPACING, aniso, 0);
    this._normalFarRT = renderNormalMap(r, tex.heights, FAR_N, FAR_SPACING, aniso, FAR_HEIGHT_X);
    releasePacked(tex.heights);
    tex.overview = makeColorTexture(ovBmp, aniso);
    tex.far = makeColorTexture(farBmp, aniso);
    tex.lc = makePackedCodeTexture(lcOv.codes, lcFar.codes);
    r.initTexture(tex.lc);
    releasePacked(tex.lc);
    this._detailRT = makeDetailArray(r, aniso);
    for (const k of ['overview', 'far']) r.initTexture(tex[k]);
    this.textures = tex;

    this._shared = {
      uHeights: { value: tex.heights },
      uCamHiU: { value: new THREE.Vector2() },
      uCamLo: { value: new THREE.Vector3() },
      uCamMod: { value: new THREE.Vector2() },
      uRange0: { value: RANGE0 },
      uMorphStart: { value: MORPH_START },
      uMorphEnd: { value: MORPH_END },
      uOverview: { value: tex.overview },
      uFarColor: { value: tex.far },
      uNormalCore: { value: this._normalCoreRT.texture },
      uNormalFar: { value: this._normalFarRT.texture },
      uLc: { value: tex.lc },
      uDetailArr: { value: this._detailRT.texture },
      uDetailStrength: { value: this.detailStrength },
      uGroundDetail: { value: 1 },
      uAlbedoGain: { value: this.albedoGain },
      uCityLights: { value: this.cityLights },
      uTreeCover: { value: this._treeCover },
      uDebugLod: { value: 0 },
      uDebugHeight: { value: 0 },
      uDebugView: { value: 0 },
      ...this.horizon.uniforms,
    };
    this._defines = floatTargetsSupported(r) ? {} : { NORMAL_UNORM: 1 };
    this._templates = [gridTemplate(GRID), gridTemplate(GRID / 2)];
    this.baseMaterial = this._makeMaterial(false);
    this._baseGroup = new PatchGroup(this._templates, BASE_CAPACITY, this.baseMaterial, 0);
    for (const m of this._baseGroup.meshes) this.group.add(m);
  }

  _makeMaterial(l0) {
    const lights = THREE.UniformsUtils.clone(THREE.UniformsLib.lights);
    const uniforms = { ...lights, ...this.env.uniforms, ...this._shared };
    if (l0) {
      uniforms.uL0Color = { value: null };
      uniforms.uL0Data = { value: null };
      uniforms.uL0Origin = { value: new THREE.Vector2() };
      uniforms.uL0Fade = { value: 0 };
      uniforms.uRwyA = { value: Array.from({ length: MAX_RWY }, () => new THREE.Vector4()) };
      uniforms.uRwyB = { value: Array.from({ length: MAX_RWY }, () => new THREE.Vector4()) };
      uniforms.uRwyC = { value: Array.from({ length: MAX_RWY }, () => new THREE.Vector4()) };
      uniforms.uRwyCount = { value: 0 };
    }
    const m = new THREE.ShaderMaterial({
      name: l0 ? 'TerrainL0' : 'Terrain',
      uniforms,
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      defines: l0 ? { ...this._defines, USE_L0: 1 } : { ...this._defines },
      lights: true,
      fog: false,
    });
    m.wireframe = this.debug.wireframe;
    return m;
  }

  /** Compiles both terrain programs now instead of on first sight (avoids a hitch). */
  _precompile() {
    const tmp = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(60, 1, 1, 1000);
    const l0 = this._makeMaterial(true);
    for (const mat of [this.baseMaterial, l0]) {
      const m = new THREE.Mesh(this._baseGroup.meshes[0].geometry, mat);
      m.receiveShadow = true;
      m.frustumCulled = false;
      tmp.add(m);
    }
    // lights come from the real scene (targetScene), so the program variants match
    try { this.renderer.compile(tmp, cam, this.scene); } catch (e) { console.warn('terrain precompile', e); }
    this._tileMaterialProto = l0;
  }

  // -------------------------------------------------------------------------------------
  // settings

  /** 'low' | 'medium' | 'high' (TERRAIN_QUALITY). */
  setQuality(q) {
    this.quality = TERRAIN_QUALITY[q] ? q : 'high';
    this.horizon.setQuality(TERRAIN_QUALITY[this.quality].horizon);
  }

  /**
   * For a module that draws 3D trees on the tree class (ESA 10) within `range` metres of the
   * camera: there the ground shows soil and litter instead of painted crowns and their
   * shadows, blending back to painted crowns over `fade` metres. range 0 turns it off.
   */
  setVegetationCover({ range = 0, fade = 300 } = {}) {
    this._treeCover.set(Math.max(0, range), Math.max(1, fade));
  }

  // -------------------------------------------------------------------------------------
  // physics queries

  /** Ground height (m MSL) at world x, z; matches the rendered surface near the camera. */
  heightAt(x, z) {
    return this.loaded ? this.hf.heightAt(x, z) : 0;
  }

  /** Surface normal of the rendered triangle at x, z (THREE.Vector3 or {x, y, z}). */
  normalAt(x, z, out = new THREE.Vector3()) {
    if (!this.loaded) { if (out.set) return out.set(0, 1, 0); out.x = 0; out.y = 1; out.z = 0; return out; }
    return this.hf.normalAt(x, z, out);
  }

  /** {type: 'runway' | 'ground' | 'water', friction}. */
  surfaceAt(x, z) {
    return surfaceType(this.runways, this.landCover, x, z, this.heightAt(x, z));
  }

  /**
   * How much of the sun the terrain lets through to (x, y, z): 1 lit, 0 behind a hill (soft
   * over the sun's disc). Uses the horizon maps the renderer has, so it matches the ground's
   * shadows; points more than 30 m above the ground count as lit.
   */
  sunVisibilityAt(x, y, z) {
    const sun = this.env?.sunDirection;
    if (!sun || !this.loaded || !this.shadows) return 1;
    if (y - this.heightAt(x, z) > 30) return 1;
    const ang = this.horizon.horizonAt(x, z);
    if (ang == null) return 1;
    const el = Math.asin(Math.max(-1, Math.min(1, sun.y)));
    const t = Math.min(1, Math.max(0, (el - ang + 0.0075) / 0.015));
    return t * t * (3 - 2 * t);
  }

  // -------------------------------------------------------------------------------------
  // per frame

  update(camera) {
    if (!this.loaded) return;
    this._frame++;
    const now = performance.now();
    camera.updateMatrixWorld();
    const cam = camera.getWorldPosition(this._camPos);
    const S = this._shared;

    // camera split into an exact integer part (25 m units, multiple of 64) and a remainder
    const ux = (cam.x + FAR_HALF) / CORE_SPACING, uz = (cam.z + FAR_HALF) / CORE_SPACING;
    const hiX = Math.floor(ux / 64) * 64, hiZ = Math.floor(uz / 64) * 64;
    S.uCamHiU.value.set(hiX, hiZ);
    S.uCamLo.value.set(cam.x - (hiX * CORE_SPACING - FAR_HALF), cam.y, cam.z - (hiZ * CORE_SPACING - FAR_HALF));
    // camera modulo 256 m in double precision: the periodic ground textures use
    // camera-relative position + this, exact near the camera
    S.uCamMod.value.set(cam.x - 256 * Math.floor(cam.x / 256), cam.z - 256 * Math.floor(cam.z / 256));
    S.uDetailStrength.value = this.detailStrength;
    S.uAlbedoGain.value = this.albedoGain;
    S.uGroundDetail.value = this.groundDetail && TERRAIN_QUALITY[this.quality].groundDetail ? 1 : 0;
    S.uCityLights.value = this.cityLights;
    S.uDebugLod.value = this.debug.lod ? 1 : 0;
    S.uDebugHeight.value = this.debug.heightProbe ? 1 : 0;
    S.uDebugView.value = this.debug.view || 0;

    // terrain shadows: new horizon maps when the sun or the camera moved
    this.horizon.setEnabled(this.shadows);
    if (this.env?.sunDirection) this.horizon.update(cam, this.env.sunDirection);
    this.stats.horizonComputes = this.horizon.stats.computes;
    this.stats.horizonMs = this.horizon.stats.lastMs;

    // LOD selection with frustum culling (boxes include the curvature drop)
    this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen, camera.coordinateSystem, camera.reversedDepth === true);
    const box = this._box, fr = this._frustum;
    const visible = (x0, y0, z0, x1, y1, z1) => {
      box.min.set(x0, y0, z0); box.max.set(x1, y1, z1);
      return fr.intersectsBox(box);
    };
    const patches = this.quadTree.select(cam, visible);

    this._updateTiles(cam, now);

    // group patches by material: L0 tile material where available, else the base material
    this._baseGroup.reset();
    for (const t of this.tiles.values()) if (t.group) t.group.reset();
    for (const p of patches) {
      let g = this._baseGroup;
      if (p.size <= TILE_M && p.x0 >= -CORE_HALF && p.z0 >= -CORE_HALF && p.x0 < CORE_HALF && p.z0 < CORE_HALF) {
        const t = this.tiles.get(tileKey(Math.floor((p.x0 + CORE_HALF) / TILE_M), Math.floor((p.z0 + CORE_HALF) / TILE_M)));
        if (t && t.group) { g = t.group; t.lastUsed = this._frame; }
      }
      if (!g.push(p)) this._baseGroup.push(p);
    }
    let tris = this._baseGroup.commit(), groups = this._baseGroup.meshes.filter((m) => m.visible).length;
    for (const t of this.tiles.values()) {
      if (!t.group) continue;
      tris += t.group.commit();
      groups += t.group.meshes.filter((m) => m.visible).length;
      const f = Math.min(1, (now - t.readyAt) / FADE_MS);
      t.material.uniforms.uL0Fade.value = f * f * (3 - 2 * f);
      t.material.uniforms.uRwyCount.value = this.debug.runways ? t.rwyCount : 0;
    }
    // wireframe toggle
    if (this.baseMaterial.wireframe !== this.debug.wireframe) {
      this.baseMaterial.wireframe = this.debug.wireframe;
      for (const t of this.tiles.values()) if (t.material) t.material.wireframe = this.debug.wireframe;
    }
    const st = this.stats;
    st.patches = patches.length;
    st.triangles = tris;
    st.groups = groups;
  }

  // -------------------------------------------------------------------------------------
  // L0 colour tile streaming

  _tileDistance(ix, iz, cam) {
    const x0 = -CORE_HALF + ix * TILE_M, z0 = -CORE_HALF + iz * TILE_M;
    const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - TILE_M);
    const dz = Math.max(z0 - cam.z, 0, cam.z - z0 - TILE_M);
    const [, mx] = this.hf.nodeMinMax(2, ix + 24, iz + 24); // a tile is a level-2 node
    const dy = Math.max(0, cam.y - mx);
    return Math.hypot(dx, dy, dz);
  }

  _updateTiles(cam, now) {
    const want = [];
    for (let iz = 0; iz < TILES; iz++) {
      for (let ix = 0; ix < TILES; ix++) {
        const d = this._tileDistance(ix, iz, cam);
        if (d < TILE_RANGE) want.push({ ix, iz, d });
      }
    }
    want.sort((a, b) => a.d - b.d);
    if (want.length > MAX_TILES) want.length = MAX_TILES;
    const wanted = new Set(want.map((w) => tileKey(w.ix, w.iz)));
    this.stats.tilesWanted = want.length;

    // start loads, nearest first
    for (const w of want) {
      if (this._inflight >= MAX_INFLIGHT) break;
      const k = tileKey(w.ix, w.iz);
      if (!this.tiles.has(k)) this._loadTile(w.ix, w.iz);
    }

    // evict tiles that are no longer wanted once over budget (farthest first)
    const resident = [...this.tiles.values()].filter((t) => t.state !== 'failed');
    let count = resident.length;
    if (count > MAX_TILES) {
      const extra = resident.filter((t) => !wanted.has(t.key))
        .sort((a, b) => this._tileDistance(b.ix, b.iz, cam) - this._tileDistance(a.ix, a.iz, cam));
      for (let i = 0; i < extra.length && count > MAX_TILES; i++, count--) this._evictTile(extra[i]);
    }

    // activate at most one decoded tile per frame (GPU upload ~ a few ms)
    this._pending.sort((a, b) => this._tileDistance(a.ix, a.iz, cam) - this._tileDistance(b.ix, b.iz, cam));
    const t = this._pending.shift();
    if (t && this.tiles.get(t.key) === t) this._activateTile(t, now);

    let loading = 0, ready = 0;
    for (const e of this.tiles.values()) { if (e.state === 'ready') ready++; else if (e.state !== 'failed') loading++; }
    this.stats.tilesResident = ready;
    this.stats.tilesLoading = loading;
  }

  _loadTile(ix, iz) {
    const key = tileKey(ix, iz);
    const entry = { key, ix, iz, state: 'loading', lastUsed: this._frame };
    this.tiles.set(key, entry);
    this._inflight++;
    const B = this.baseUrl;
    // absolute URLs: the workers resolve relative ones against their own location
    const abs = (u) => new URL(u, globalThis.location?.href ?? 'http://localhost/').href;
    this._loader.load(abs(`${B}color/L0/tile_${ix}_${iz}.jpg`), abs(`${B}landcover/tile_${ix}_${iz}.png`))
      .then(({ bitmap, codes, data }) => {
        if (this.tiles.get(key) !== entry) { bitmap.close(); return; }
        entry.bitmap = bitmap;
        entry.codes = codes;
        entry.data = data;
        entry.state = 'decoded';
        this._pending.push(entry);
      })
      .catch(() => { entry.state = 'failed'; })
      .finally(() => { this._inflight--; });
  }

  _activateTile(t, now) {
    const color = makeColorTexture(t.bitmap, this._maxAniso);
    const n = t.codes.width;
    const data = makeTileDataTexture(t.data && t.data.length === n * n ? t.data : packCodes(t.codes.codes, n), n);
    this.renderer.initTexture(color);
    this.renderer.initTexture(data);
    releasePacked(data);
    t.bitmap.close();
    t.bitmap = null;
    t.data = null;
    const material = this._tileMaterialProto && !this._tileMaterialProto.userData.used
      ? this._tileMaterialProto : this._makeMaterial(true);
    material.userData.used = true;
    material.wireframe = this.debug.wireframe;
    const U = material.uniforms;
    U.uL0Color.value = color;
    U.uL0Data.value = data;
    const x0 = -CORE_HALF + t.ix * TILE_M, z0 = -CORE_HALF + t.iz * TILE_M;
    U.uL0Origin.value.set(x0, z0);
    U.uL0Fade.value = 0;
    const rws = this.runways.inBox(x0, z0, x0 + TILE_M, z0 + TILE_M, 20).slice(0, MAX_RWY);
    rws.forEach((rw, i) => {
      U.uRwyA.value[i].set(rw.cx, rw.cz, rw.ux, rw.uz);
      U.uRwyB.value[i].set(rw.halfLength, rw.halfWidth, designatorCode(rw.ends[0].id ?? rw.ids[0]), designatorCode(rw.ends[1].id ?? rw.ids[1]));
      U.uRwyC.value[i].set(rw.overrun[0], rw.overrun[1], rw.displaced[0], rw.displaced[1]);
    });
    U.uRwyCount.value = rws.length;
    t.rwyCount = rws.length;
    const group = this._tileGroupPool.pop() || new PatchGroup(this._templates, TILE_CAPACITY, material, -10);
    group.setMaterial(material);
    for (const m of group.meshes) if (!m.parent) this.group.add(m);
    t.textures = [color, data];
    t.material = material;
    t.group = group;
    t.state = 'ready';
    t.readyAt = now;
    this.landCover.tiles.set(t.key, t.codes.codes);
    t.codes = null;
  }

  _evictTile(t) {
    this.tiles.delete(t.key);
    this.landCover.tiles.delete(t.key);
    const i = this._pending.indexOf(t);
    if (i >= 0) this._pending.splice(i, 1);
    if (t.bitmap) { t.bitmap.close(); t.bitmap = null; }
    if (t.group) {
      t.group.reset();
      t.group.commit();
      for (const m of t.group.meshes) m.visible = false;
      this._tileGroupPool.push(t.group);
      t.group = null;
    }
    if (t.material) {
      if (t.material === this._tileMaterialProto) this._tileMaterialProto = null;
      t.material.dispose();
    }
    if (t.textures) for (const x of t.textures) x.dispose();
    t.state = 'evicted';
  }

  dispose() {
    for (const t of [...this.tiles.values()]) this._evictTile(t);
    this.scene.remove(this.group);
    this._loader?.dispose();
    this.horizon.dispose();
    if (!this.textures) return;
    for (const x of Object.values(this.textures)) x.dispose?.();
    this._normalCoreRT.dispose();
    this._normalFarRT.dispose();
    this._detailRT.dispose();
    this.baseMaterial.dispose();
  }
}

export { DATA_N };
