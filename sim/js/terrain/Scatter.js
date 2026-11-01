// Scatter: the trees, orchards, palms and shrubs of the terrain (see terrain/VEGETATION.md).
//
//   app.addModule(new Scatter({ renderer, scene, camera, env, terrain, app }));
//
// Placement runs in a worker (vegetation/worker.js, rules in vegetation/placement.js) from the
// terrain's own data: ESA WorldCover land cover and the L0 colour imagery of each tile, per
// 200 m cell, deterministic. The main thread keeps the cells within the far range and draws:
//
//   impostors   every tree in range, one draw: a camera-facing quad with the frame of the
//               impostor atlas (rendered at start-up from the procedural meshes) for the view's
//               elevation; per-pixel normals, depth and ambient occlusion
//   near meshes the trees within the mesh range, one InstancedMesh per species and variant
//               (procedural meshes, vegetation/meshes.js), wind sway, ragged foliage edges
//   shadows     every tree's silhouette from the sun projected onto the ground, one draw
//
// Meshes and impostors cross-fade with complementary dither; impostors thin out by rank
// towards the far range; everything is lit by the environment's sun and sky with the same
// aerial perspective and logarithmic depth as the terrain. Quality: setQuality(), the table
// below. Off: ?vegetation=0 or the menu option (settings.vegetation).
//
// Instance record (20 bytes): float32 x, y (ground - 0.25 m), z; u8 species | variant << 4,
// height / 0.125 m, crown width factor * 128, rotation; u8 imagery colour R, G, B, rank.

import * as THREE from 'three';
import { SPECIES, SPECIES_COUNT } from './vegetation/species.js';
import { buildTree, VARIANTS } from './vegetation/meshes.js';
import { ImpostorBaker, bakeImpostors } from './vegetation/impostors.js';
import { MESH_VERT, MESH_FRAG, IMPOSTOR_VERT, IMPOSTOR_FRAG, DECAL_VERT, DECAL_FRAG } from './vegetation/shaders.js';
import { CELL_M, CELLS, TILES, CORE_HALF, REC_U8 } from './vegetation/placement.js';

/**
 * density: share of the trees kept (by rank); mesh: mesh range (m); band: mesh / impostor
 * cross-fade (m); far: impostor range (m); shadow: ground shadow range (m); capacity: trees in
 * the impostor buffer; meshCap: trees per near mesh; atlas: impostor frame size (px).
 */
export const VEG_QUALITY = {
  low: { density: 0.45, mesh: 70, band: 12, far: 2000, shadow: 900, capacity: 260000, meshCap: 3000, atlas: 64, shrubs: false },
  medium: { density: 0.7, mesh: 110, band: 16, far: 3000, shadow: 1600, capacity: 520000, meshCap: 6000, atlas: 128, shrubs: true },
  high: { density: 1.0, mesh: 160, band: 22, far: 4200, shadow: 2400, capacity: 900000, meshCap: 10000, atlas: 128, shrubs: true },
};

const MAX_INFLIGHT = 2;
const CELLS_PER_REQUEST = 48;
const UPLOAD_BUDGET = 200000;     // instances per frame (a new start point fills up in a few frames)
const INIT_BUDGET_MS = 6;         // start-up work per frame while flying (behind the menu: 40)
const RELEASE_MARGIN = 500;       // m beyond the wanted radius before a cell is dropped
const WORLD_CELLS = TILES * CELLS;

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

export class Scatter {
  constructor({ renderer, scene, camera, env, terrain, app } = {}) {
    this.isScatter = true;
    this.name = 'vegetation';
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.env = env;
    this.terrain = terrain;
    this.app = app;
    this.attribution = 'Vegetation: procedural trees placed from ESA WorldCover 2021 and Sentinel-2 imagery';
    // needs the real terrain (heights texture, tiles); ?stubs=1 has none
    this.available = !!(terrain && terrain.textures && terrain.textures.hCore && terrain.baseUrl);
    const setting = app && app.settings ? app.settings.vegetation : undefined;
    this.enabled = this.available && params.get('vegetation') !== '0' && setting !== false;
    this.qualityName = 'high';
    this.Q = VEG_QUALITY.high;
    this.ready = false;
    this.failed = false;
    this.group = new THREE.Group();
    this.group.name = 'Vegetation';
    this.group.visible = false;
    scene.add(this.group);

    this.cells = new Map();         // key -> cell
    this._queue = [];               // cells waiting for the worker
    this._uploads = [];             // cells with data waiting for the GPU
    this._inflight = 0;
    this._free = [];                // free blocks [{off, len}] sorted by offset
    this._hw = 0;                   // high-water mark of the impostor buffer
    this._used = 0;
    this._camPos = new THREE.Vector3();
    this._lastWant = new THREE.Vector3(1e9, 0, 1e9);
    this._lastNear = new THREE.Vector3(1e9, 0, 1e9);
    this._nearDirty = true;
    this._meshScale = 1;
    this._frame = 0;
    this.stats = { cells: 0, cellsPending: 0, instances: 0, capacity: 0, highWater: 0, near: 0, nearTris: 0, bakeMs: 0, atlasMB: 0, workerMs: 0, tileMs: 0, replies: 0, initMs: 0, startMs: 0 };
    this.tuning = { tintGain: 0.72, wind: 1, brightness: 1, shadowStrength: 0.75 };
  }

  // ------------------------------------------------------------------------------ module API
  setQuality(name) {
    const q = VEG_QUALITY[name] ? name : 'high';
    this.qualityName = q;
    this.Q = VEG_QUALITY[q];
    this._lastWant.set(1e9, 0, 1e9);
    if (this.ready) this._applyQuality();      // otherwise at the end of the start-up
  }

  /** Rebuilds what the quality changes: buffers, near meshes, atlas, the uploaded instances. */
  _applyQuality() {
    const B = this._built || {}, Q = this.Q;
    if (B.meshCap !== Q.meshCap) this._buildNearMeshes();
    if (B.capacity !== Q.capacity) this._buildImpostorBuffer();
    if (B.atlas !== Q.atlas) this._bake();
    if (B.density !== Q.density || B.shrubs !== Q.shrubs || B.capacity !== Q.capacity) this._reuploadAll();
    this._built = { ...Q };
    this._lastWant.set(1e9, 0, 1e9);
    this._nearDirty = true;
  }

  setOption(key, value) {
    if (key !== 'vegetation') return;
    this.enabled = this.available && !!value;
    if (!this.enabled) this.group.visible = false;
    this._lastWant.set(1e9, 0, 1e9);
  }

  reset() {
    // a new start point: forget the queue (the wanted set is rebuilt from the new position)
    for (const c of this._queue) c.inQueue = false;
    this._queue.length = 0;
    this._lastWant.set(1e9, 0, 1e9);
    this._nearDirty = true;
  }

  update(f) {
    if (!this.enabled || this.failed) { this.group.visible = false; return; }
    if (!this._worker) this._startWorker();
    this._frame++;
    const cam = f.camera.getWorldPosition(this._camPos);
    if (cam.distanceToSquared(this._lastWant) > 60 * 60 || this._frame % 30 === 0) this._updateWanted(cam);
    this._pump();
    if (!this.ready && !this._initStep()) return;     // the start-up, a few ms per frame
    this._uploadSome(cam);
    if (cam.distanceToSquared(this._lastNear) > 15 * 15 || this._nearDirty) this._rebuildNear(cam);
    this._updateUniforms(cam);
    this.group.visible = true;
  }

  dispose() {
    this._worker?.terminate();
    this.scene.remove(this.group);
    for (const m of this._nearMeshes || []) m.geometry.dispose();
    this._impGeom?.dispose();
    for (const mat of [this._meshMat, this._depthMat, this._impMat, this._decalMat]) mat?.dispose();
    this._atlas?.albedo.dispose();
    this._atlas?.normal.dispose();
    for (const t of this._trees || []) t.geometry.dispose();
  }

  /** Small summary for tests and the console. */
  statsJSON() {
    const s = this.stats;
    return {
      enabled: this.enabled, ready: this.ready, quality: this.qualityName, cells: s.cells, pending: s.cellsPending,
      instances: s.instances, highWater: s.highWater, capacity: s.capacity, near: s.near,
      nearTris: s.nearTris, bakeMs: Math.round(s.bakeMs), atlasMB: +s.atlasMB.toFixed(1), initMs: Math.round(s.initMs), startMs: Math.round(s.startMs),
      workerMs: Math.round(s.workerMs), tileMs: Math.round(s.tileMs), replies: s.replies, inflight: this._inflight, queued: this._queue.length,
      idle: this.idle(),
    };
  }

  /** Nothing left to do for the current position (tests wait for it before a screenshot). */
  idle() {
    return !this.enabled || this.failed || (this.ready && !this._queue.length && !this._inflight && !this._uploads.length && !this._nearDirty);
  }

  // ------------------------------------------------------------------------------ set-up
  /** Runs the start-up for INIT_BUDGET_MS; true once it is done. */
  _initStep() {
    const t0 = performance.now();
    const budget = this.app && this.app.state === 'flying' ? INIT_BUDGET_MS : 40;
    try {
      if (!this._initIter) this._initIter = this._initSteps();
      while (!this.ready && performance.now() - t0 < budget) {
        if (this._initIter.next().done) break;
      }
    } catch (e) {
      console.error('vegetation: initialisation failed', e);
      this.failed = true;
      this.group.visible = false;
      return false;
    }
    this.stats.initMs += performance.now() - t0;
    return this.ready;
  }

  /**
   * The start-up in small steps (a generator, resumed every frame): the tree meshes one by one,
   * materials and buffers, the programs (compiled in parallel where the browser can), the
   * impostor atlas one model at a time, its mips a few layers at a time.
   */
  *_initSteps() {
    const t0 = performance.now();
    this._trees = [];
    for (let sp = 0; sp < SPECIES_COUNT; sp++) {
      for (let v = 0; v < VARIANTS; v++) { this._trees.push(buildTree(sp, v, 1)); yield; }
    }
    this._makeUniforms();
    this._makeMaterials(this._uniforms);
    this._buildImpostorBuffer();
    this._buildNearMeshes();
    yield;
    const baker = new ImpostorBaker(this.renderer, this._trees, this._bakeOptions());
    let compiled = false;
    this._compile(baker).then(() => { compiled = true; }, (e) => { console.warn('vegetation: compile', e); compiled = true; });
    while (!compiled) yield;
    while (baker.renderModel()) yield;
    while (!baker.finishSome(6)) yield;
    this._setAtlas(baker.result(), baker.ms);
    this._built = { ...this.Q };
    this.ready = true;
    this._applyQuality();       // in case the quality changed meanwhile
    this.stats.startMs = performance.now() - t0;
    console.info(`vegetation: ready after ${this.stats.startMs.toFixed(0)} ms (${this.stats.initMs.toFixed(0)} ms of work, impostor bake ${this.stats.bakeMs.toFixed(0)} ms, atlas ${this.stats.atlasMB.toFixed(1)} MB)`);
  }

  _makeUniforms() {
    const U = this._uniforms = {
      uSpA: { value: SPECIES.map((s) => new THREE.Vector4(s.tint, s.translucency, s.sway, s.far)) },
      uSpB: { value: SPECIES.map((s) => new THREE.Vector4(s.fluff, s.specular, s.shadow, 0)) },
      uVeg: { value: new THREE.Vector4(this.tuning.tintGain, this.tuning.wind, this.tuning.brightness, 0) },
      uLod: { value: new THREE.Vector4(this.Q.mesh, this.Q.band, this.Q.far, 0.22) },
      uMainCam: { value: new THREE.Vector3() },
      uModel: { value: this._trees.map((t) => new THREE.Vector4(t.info.sphere, t.info.radiusXZ, 0, 0)) },
      uAtlasA: { value: null },
      uAtlasN: { value: null },
      uHCore: { value: this.terrain.textures.hCore },
      uShadow: { value: new THREE.Vector4(this.Q.shadow, this.tuning.shadowStrength, 0.3, 1) },
    };
    return U;
  }

  _bakeOptions() {
    return {
      size: this.Q.atlas, spB: this._uniforms.uSpB.value,
      refHeights: SPECIES.map((s) => (s.height[0] + s.height[1]) / 2), variants: VARIANTS,
    };
  }

  /** The whole atlas at once (a quality change). */
  _bake() {
    const a = bakeImpostors(this.renderer, this._trees, this._bakeOptions());
    this._setAtlas(a, a.ms);
  }

  _setAtlas(atlas, ms) {
    const old = this._atlas;
    this._atlas = atlas;
    this._uniforms.uAtlasA.value = atlas.albedo;
    this._uniforms.uAtlasN.value = atlas.normal;
    if (old) { old.albedo.dispose(); old.normal.dispose(); }
    this.stats.bakeMs = ms;
    this.stats.atlasMB = atlas.bytes / 1048576;
  }

  _makeMaterials(U) {
    const env = this.env.uniforms;
    const lights = () => THREE.UniformsUtils.clone(THREE.UniformsLib.lights);
    this._meshMat = new THREE.ShaderMaterial({
      name: 'VegetationMesh', uniforms: { ...lights(), ...env, ...U },
      vertexShader: MESH_VERT, fragmentShader: MESH_FRAG, lights: true, fog: false, side: THREE.FrontSide,
    });
    this._meshMat.alphaToCoverage = true;
    this._depthMat = new THREE.ShaderMaterial({
      name: 'VegetationMeshDepth', uniforms: { ...env, ...U }, defines: { VEG_DEPTH: 1 },
      vertexShader: MESH_VERT, fragmentShader: MESH_FRAG, fog: false, side: THREE.FrontSide,
    });
    this._impMat = new THREE.ShaderMaterial({
      name: 'VegetationImpostor', uniforms: { ...lights(), ...env, ...U },
      vertexShader: IMPOSTOR_VERT, fragmentShader: IMPOSTOR_FRAG, lights: true, fog: false, side: THREE.DoubleSide,
    });
    this._impMat.alphaToCoverage = true;
    this._decalMat = new THREE.ShaderMaterial({
      name: 'VegetationShadow', uniforms: { ...env, ...U },
      vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG, fog: false, side: THREE.DoubleSide,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
  }

  _buildImpostorBuffer() {
    const cap = this.Q.capacity;
    const old = this._impGeom;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this._aPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this._aD0 = new THREE.InstancedBufferAttribute(new Uint8Array(cap * 4), 4, true);
    this._aD1 = new THREE.InstancedBufferAttribute(new Uint8Array(cap * 4), 4, true);
    for (const a of [this._aPos, this._aD0, this._aD1]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aPos', this._aPos);
    g.setAttribute('aD0', this._aD0);
    g.setAttribute('aD1', this._aD1);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8);
    this._impGeom = g;
    if (!this._impMesh) {
      this._impMesh = new THREE.Mesh(g, this._impMat);
      this._impMesh.name = 'VegetationImpostors';
      this._impMesh.frustumCulled = false;
      this._impMesh.renderOrder = 1;
      this._impMesh.receiveShadow = true;
      this._impMesh.matrixAutoUpdate = false;
      this._decalMesh = new THREE.Mesh(g, this._decalMat);
      this._decalMesh.name = 'VegetationShadows';
      this._decalMesh.frustumCulled = false;
      this._decalMesh.renderOrder = -1;
      this._decalMesh.matrixAutoUpdate = false;
      this.group.add(this._impMesh, this._decalMesh);
    } else {
      this._impMesh.geometry = g;
      this._decalMesh.geometry = g;
    }
    old?.dispose();
    this._free.length = 0;
    this._hw = 0;
    this._used = 0;
    for (const c of this.cells.values()) c.block = null;
    this.stats.capacity = cap;
  }

  _buildNearMeshes() {
    for (const m of this._nearMeshes || []) { this.group.remove(m); m.geometry.dispose(); }
    this._nearMeshes = [];
    const cap = this.Q.meshCap;
    this._nearCap = cap;
    for (let m = 0; m < this._trees.length; m++) {
      const src = this._trees[m].geometry;
      const g = new THREE.InstancedBufferGeometry();
      g.setIndex(src.index);
      for (const name of ['position', 'normal', 'aColor', 'aVert', 'uv']) g.setAttribute(name, src.getAttribute(name));
      g.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aD0', new THREE.InstancedBufferAttribute(new Uint8Array(cap * 4), 4, true).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aD1', new THREE.InstancedBufferAttribute(new Uint8Array(cap * 4), 4, true).setUsage(THREE.DynamicDrawUsage));
      g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8);
      const mesh = new THREE.Mesh(g, this._meshMat);
      mesh.name = `VegetationMesh_${SPECIES[Math.floor(m / VARIANTS)].name}_${m % VARIANTS}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.receiveShadow = true;
      mesh.castShadow = !!this._casting;      // see _updateUniforms
      mesh.customDepthMaterial = this._depthMat;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.userData.tris = src.index.count / 3;
      this._nearMeshes.push(mesh);
      this.group.add(mesh);
    }
  }

  _startWorker() {
    this._worker = new Worker(new URL('./vegetation/worker.js', import.meta.url), { type: 'module' });
    this._worker.onmessage = (e) => this._onWorker(e.data);
    this._worker.onerror = (e) => { console.error('vegetation worker:', e.message || e); };
    const baseUrl = new URL(this.terrain.baseUrl, location.href).href;
    const runways = (this.terrain.runways?.list || []).map((r) => ({ cx: r.cx, cz: r.cz, ux: r.ux, uz: r.uz, halfLength: r.halfLength, halfWidth: r.halfWidth }));
    this._worker.postMessage({ type: 'init', baseUrl, runways });
  }

  /**
   * Compiles the programs ahead (in parallel where the browser has KHR_parallel_shader_compile):
   * the bake program as it renders into the bake target, then the three drawn ones.
   */
  _compile(baker) {
    const r = this.renderer;
    if (!r.compileAsync) return Promise.resolve();
    const prev = r.getRenderTarget();
    r.setRenderTarget(baker.rt);
    const bake = r.compileAsync(baker.scene, baker.cam);
    r.setRenderTarget(prev);
    const tmp = new THREE.Scene();
    const geo = this._nearMeshes[0].geometry;
    for (const [g, mat] of [[geo, this._meshMat], [this._impGeom, this._impMat], [this._impGeom, this._decalMat]]) {
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false;
      m.receiveShadow = true;
      tmp.add(m);
    }
    return Promise.all([bake, r.compileAsync(tmp, this.camera, this.scene)]);
  }

  // ------------------------------------------------------------------------------ streaming
  _updateWanted(cam) {
    this._lastWant.copy(cam);
    const R = this.Q.far + 150;
    const g = this.terrain.heightAt(cam.x, cam.z);
    const dy = Math.max(0, cam.y - g - 30);
    const wanted = new Set();
    if (dy < R) {
      const rh = Math.sqrt(R * R - dy * dy);
      const X0 = Math.max(0, Math.floor((cam.x - rh + CORE_HALF) / CELL_M)), X1 = Math.min(WORLD_CELLS - 1, Math.floor((cam.x + rh + CORE_HALF) / CELL_M));
      const Z0 = Math.max(0, Math.floor((cam.z - rh + CORE_HALF) / CELL_M)), Z1 = Math.min(WORLD_CELLS - 1, Math.floor((cam.z + rh + CORE_HALF) / CELL_M));
      for (let Z = Z0; Z <= Z1; Z++) {
        for (let X = X0; X <= X1; X++) {
          const d = this._cellDist(X, Z, cam);
          if (d > rh) continue;
          const key = Z * WORLD_CELLS + X;
          wanted.add(key);
          let c = this.cells.get(key);
          if (!c) {
            c = { key, X, Z, ix: Math.floor(X / CELLS), iz: Math.floor(Z / CELLS), cx: X % CELLS, cz: Z % CELLS, state: 'queued', block: null, d, inQueue: true };
            this.cells.set(key, c);
            this._queue.push(c);
          } else if (c.state === 'queued' && !c.inQueue) {
            c.inQueue = true;
            this._queue.push(c);
          }
          c.d = d;
        }
      }
      this._releaseBeyond(cam, rh + RELEASE_MARGIN);
    } else {
      this._releaseBeyond(cam, -1);
    }
    this._queue = this._queue.filter((c) => (c.inQueue = c.state === 'queued' && wanted.has(c.key)));
    this._queue.sort((a, b) => a.d - b.d);
    this._uploads.sort((a, b) => a.d - b.d);
    let pending = 0;
    for (const c of this.cells.values()) if (c.state !== 'ready') pending++;
    this.stats.cells = this.cells.size;
    this.stats.cellsPending = pending;
  }

  _cellDist(X, Z, cam) {
    const x0 = -CORE_HALF + X * CELL_M, z0 = -CORE_HALF + Z * CELL_M;
    const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - CELL_M);
    const dz = Math.max(z0 - cam.z, 0, cam.z - z0 - CELL_M);
    return Math.hypot(dx, dz);
  }

  _releaseBeyond(cam, r) {
    for (const [key, c] of this.cells) {
      const d = r < 0 ? Infinity : this._cellDist(c.X, c.Z, cam);
      if (d <= r) continue;
      if (c.state === 'requested') continue;     // released when its answer comes back
      this._freeCell(c);
      this.cells.delete(key);
    }
    this._uploads = this._uploads.filter((c) => this.cells.get(c.key) === c);
  }

  _pump() {
    while (this._inflight < MAX_INFLIGHT && this._queue.length) {
      const first = this._queue[0];
      const batch = [];
      const rest = [];
      for (const c of this._queue) {
        if (batch.length < CELLS_PER_REQUEST && c.ix === first.ix && c.iz === first.iz) batch.push(c);
        else rest.push(c);
      }
      this._queue = rest;
      for (const c of batch) { c.state = 'requested'; c.inQueue = false; }
      this._inflight++;
      this._worker.postMessage({ type: 'cells', ix: first.ix, iz: first.iz, cells: batch.map((c) => [c.cx, c.cz]), shrubs: true });
    }
  }

  _onWorker(m) {
    this._inflight = Math.max(0, this._inflight - 1);
    this.stats.replies++;
    this.stats.workerMs += m.cellMs || 0;
    this.stats.tileMs = Math.max(this.stats.tileMs, m.waitMs || 0);
    if (m.type === 'error') {
      console.warn(`vegetation: tile ${m.ix},${m.iz}: ${m.message}`);
      for (const [cx, cz] of m.cells) {
        const c = this.cells.get((m.iz * CELLS + cz) * WORLD_CELLS + m.ix * CELLS + cx);
        if (c) { c.state = 'ready'; c.count = 0; c.pos = null; c.data = null; }
      }
      return;
    }
    for (const r of m.cells) {
      const key = (m.iz * CELLS + r.cz) * WORLD_CELLS + m.ix * CELLS + r.cx;
      const c = this.cells.get(key);
      if (!c || c.state !== 'requested') continue;
      c.state = 'ready';
      c.count = r.count;
      c.pos = r.pos;
      c.data = r.data;
      if (r.count) this._uploads.push(c);
      if (c.d < this.Q.mesh * 1.2 + 250) this._nearDirty = true;
    }
    this._uploads.sort((a, b) => a.d - b.d);
    this._pump();      // keep the worker busy whatever the frame rate
  }

  /** Is instance i of cell c drawn at this quality? */
  _keep(c, i) {
    const d = c.data;
    if (d[i * REC_U8 + 7] >= this.Q.density * 256) return false;
    if (!this.Q.shrubs && (d[i * REC_U8] & 15) === 7) return false;
    return true;
  }

  _uploadSome(cam) {
    let budget = UPLOAD_BUDGET;
    while (this._uploads.length && budget > 0) {
      const c = this._uploads[0];
      if (this.cells.get(c.key) !== c || c.block) { this._uploads.shift(); continue; }
      const n = this._uploadCell(c);
      if (n < 0) break;           // buffer full: try again once far cells are released
      this._uploads.shift();
      budget -= n;
    }
    void cam;
  }

  _uploadCell(c) {
    let n = 0;
    for (let i = 0; i < c.count; i++) if (this._keep(c, i)) n++;
    if (!n) { c.block = { off: 0, len: 0 }; return 1; }
    const off = this._alloc(n);
    if (off < 0) return -1;
    c.block = { off, len: n };
    const P = this._aPos.array, A = this._aD0.array, B = this._aD1.array;
    let k = off;
    for (let i = 0; i < c.count; i++) {
      if (!this._keep(c, i)) continue;
      P[k * 3] = c.pos[i * 3]; P[k * 3 + 1] = c.pos[i * 3 + 1]; P[k * 3 + 2] = c.pos[i * 3 + 2];
      const s = i * REC_U8;
      A[k * 4] = c.data[s]; A[k * 4 + 1] = c.data[s + 1]; A[k * 4 + 2] = c.data[s + 2]; A[k * 4 + 3] = c.data[s + 3];
      B[k * 4] = c.data[s + 4]; B[k * 4 + 1] = c.data[s + 5]; B[k * 4 + 2] = c.data[s + 6]; B[k * 4 + 3] = c.data[s + 7];
      k++;
    }
    this._aPos.addUpdateRange(off * 3, n * 3);
    this._aD0.addUpdateRange(off * 4, n * 4);
    this._aD1.addUpdateRange(off * 4, n * 4);
    this._aPos.needsUpdate = this._aD0.needsUpdate = this._aD1.needsUpdate = true;
    this._impGeom.instanceCount = this._hw;
    this._used += n;
    this.stats.instances = this._used;
    this.stats.highWater = this._hw;
    return n;
  }

  _freeCell(c) {
    const b = c.block;
    c.block = null;
    if (!b || !b.len) return;
    const A = this._aD0.array;
    for (let k = b.off; k < b.off + b.len; k++) A[k * 4 + 1] = 0;     // height 0: culled
    this._aD0.addUpdateRange(b.off * 4, b.len * 4);
    this._aD0.needsUpdate = true;
    this._used -= b.len;
    this._release(b.off, b.len);
    this._impGeom.instanceCount = this._hw;
    this.stats.instances = this._used;
    this.stats.highWater = this._hw;
  }

  _alloc(n) {
    for (let i = 0; i < this._free.length; i++) {
      const f = this._free[i];
      if (f.len < n) continue;
      const off = f.off;
      f.off += n; f.len -= n;
      if (!f.len) this._free.splice(i, 1);
      return off;
    }
    if (this._hw + n > this.Q.capacity) return -1;
    const off = this._hw;
    this._hw += n;
    return off;
  }

  _release(off, len) {
    const F = this._free;
    let i = 0;
    while (i < F.length && F[i].off < off) i++;
    F.splice(i, 0, { off, len });
    // merge with the neighbours
    if (i + 1 < F.length && F[i].off + F[i].len === F[i + 1].off) { F[i].len += F[i + 1].len; F.splice(i + 1, 1); }
    if (i > 0 && F[i - 1].off + F[i - 1].len === F[i].off) { F[i - 1].len += F[i].len; F.splice(i, 1); i--; }
    // a free block at the top lowers the high-water mark
    const last = F[F.length - 1];
    if (last && last.off + last.len === this._hw) { this._hw = last.off; F.pop(); }
  }

  _reuploadAll() {
    this._aD0.array.fill(0);
    this._aD0.clearUpdateRanges();
    this._aD0.needsUpdate = true;
    this._free.length = 0;
    this._hw = 0;
    this._used = 0;
    this._uploads = [];
    for (const c of this.cells.values()) {
      c.block = null;
      if (c.state === 'ready' && c.count) this._uploads.push(c);
    }
    this._uploads.sort((a, b) => a.d - b.d);
    this._impGeom.instanceCount = 0;
  }

  // ------------------------------------------------------------------------------ near meshes
  _rebuildNear(cam) {
    this._lastNear.copy(cam);
    this._nearDirty = false;
    const R = this.Q.mesh * 1.15 * this._meshScale + 30;
    const R2 = R * R;
    const counts = new Int32Array(this._nearMeshes.length);
    const cap = this._nearCap;
    const meshes = this._nearMeshes;
    const arrays = meshes.map((m) => [m.geometry.getAttribute('aPos').array, m.geometry.getAttribute('aD0').array, m.geometry.getAttribute('aD1').array]);
    let overflow = false;
    const X0 = Math.floor((cam.x - R + CORE_HALF) / CELL_M), X1 = Math.floor((cam.x + R + CORE_HALF) / CELL_M);
    const Z0 = Math.floor((cam.z - R + CORE_HALF) / CELL_M), Z1 = Math.floor((cam.z + R + CORE_HALF) / CELL_M);
    for (let Z = Z0; Z <= Z1; Z++) {
      for (let X = X0; X <= X1; X++) {
        const c = this.cells.get(Z * WORLD_CELLS + X);
        if (!c || c.state !== 'ready' || !c.count || !c.block) continue;
        const P = c.pos, D = c.data;
        for (let i = 0; i < c.count; i++) {
          const dx = P[i * 3] - cam.x, dz = P[i * 3 + 2] - cam.z;
          if (dx * dx + dz * dz > R2) continue;
          const s = i * REC_U8;
          const h = D[s + 1] * 0.125;
          const dy = P[i * 3 + 1] + 0.5 * h - cam.y;
          if (dx * dx + dy * dy + dz * dz > R2) continue;
          if (!this._keep(c, i)) continue;
          const m = (D[s] & 15) * VARIANTS + ((D[s] >> 4) & 1);
          const k = counts[m];
          if (k >= cap) { overflow = true; continue; }
          const [ap, a0, a1] = arrays[m];
          ap[k * 3] = P[i * 3]; ap[k * 3 + 1] = P[i * 3 + 1]; ap[k * 3 + 2] = P[i * 3 + 2];
          a0[k * 4] = D[s]; a0[k * 4 + 1] = D[s + 1]; a0[k * 4 + 2] = D[s + 2]; a0[k * 4 + 3] = D[s + 3];
          a1[k * 4] = D[s + 4]; a1[k * 4 + 1] = D[s + 5]; a1[k * 4 + 2] = D[s + 6]; a1[k * 4 + 3] = D[s + 7];
          counts[m] = k + 1;
        }
      }
    }
    // too many trees for the buffers: draw meshes over a shorter range (the impostors take over)
    if (overflow) this._meshScale = Math.max(0.3, this._meshScale * 0.8);
    else if (this._meshScale < 1) this._meshScale = Math.min(1, this._meshScale * 1.05);
    let near = 0, tris = 0;
    for (let m = 0; m < meshes.length; m++) {
      const g = meshes[m].geometry, n = counts[m];
      g.instanceCount = n;
      meshes[m].visible = n > 0;
      if (n) {
        for (const name of ['aPos', 'aD0', 'aD1']) {
          const a = g.getAttribute(name);
          a.clearUpdateRanges();
          a.addUpdateRange(0, n * a.itemSize);
          a.needsUpdate = true;
        }
      }
      near += n;
      tris += n * meshes[m].userData.tris;
    }
    this.stats.near = near;
    this.stats.nearTris = tris;
  }

  // ------------------------------------------------------------------------------ per frame
  _updateUniforms(cam) {
    const U = this._uniforms;
    U.uMainCam.value.copy(cam);
    U.uLod.value.set(this.Q.mesh * this._meshScale, this.Q.band, this.Q.far, 0.22);
    U.uVeg.value.set(this.tuning.tintGain, this.tuning.wind, this.tuning.brightness, 0);
    U.uShadow.value.set(this.Q.shadow, this.tuning.shadowStrength, 0.3, 1);
    // cast into the sun's shadow map only when it covers more than the aircraft
    const sc = this.env.sunLight?.shadow?.camera;
    const cast = !!(sc && this.env.sunLight.castShadow && (sc.right - sc.left) > 120);
    if (cast !== this._casting) {
      this._casting = cast;
      for (const m of this._nearMeshes) m.castShadow = cast;
    }
  }
}
