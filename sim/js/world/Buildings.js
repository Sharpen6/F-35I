// 3D buildings of the 102.4 km core: Overture Maps buildings (OpenStreetMap and Microsoft ML
// footprints) turned into tiles by sim/tools/world/buildings.py (data/world/buildings/).
//
// Levels of detail, all streamed around the camera and built off the main thread
// (BuildingsWorker.js):
//   boxes   every building of a tile within `far` is one instance of a 10-vertex box with a
//           ridge (one draw call per tile). Instances are sorted by visibility size, so a far
//           tile draws only the first n (those big enough to be seen from there); each one grows
//           out of the ground over the last quarter of its distance (size x visK) and over the
//           last tenth of the streaming distance `far`, so nothing pops (not even a late tile).
//   chunks  800 m chunks within `near` (further for chunks with tall buildings) get the full
//           geometry: walls along the real footprint, parapets, roof houses, pitched roofs, domes,
//           vaults. The switch cross-fades over FADE_S: the chunk and the tile's boxes of that
//           chunk are both drawn with complementary dither masks (uFade per chunk), then the
//           boxes are dropped in the vertex shader.
// Shading (buildingShaders.js): procedural facades and roofs, lit windows at night, the
// terrain's sun, sky and aerial perspective.
// Shadows: every building receives the sun's shadow map, and the full-detail chunks cast into it
// once the shadow camera covers more than the aircraft (half size >= 150 m: only near the ground
// with the lighting of js/env). At every height each building also casts a ground shadow: a
// decal of its box's shadow (SHADOW_VERT, within Q.shadowFar), faded out where the shadow map
// holds the buildings. Buildings are not shadowed by other buildings beyond the shadow map.
// Obstruction lights: red lights on structures of 45 m or more at dusk and night (LIGHT_VERT).
//
// Module API (main.js addModule): update(f), setTime(h, doy), setQuality(q), reset(), dispose().
// Off with ?buildings=0 or the menu's "3D buildings" option (app.settings.buildings); ground
// shadows off with ?bshadows=0, obstruction lights with ?blights=0.
// ?buildingsDebug=1 tints the boxes blue and the full-detail chunks red.
// Test hook: speckleCheck() (salt and pepper pixels in the frame last drawn on the canvas).

import * as THREE from 'three';
import { BOX_VERT, CHUNK_VERT, BUILDING_FRAG, DEPTH_FRAG, LIGHT_VERT, LIGHT_FRAG, SHADOW_VERT, SHADOW_FRAG } from './buildingShaders.js';
import { LUX_PER_UNIT, artificialLightGain, pointLightThreshold, lightsOn as lightsOnAt } from '../env/Environment.js';
import { emitterBlending } from '../env/emitters.js';

const TILE = 6400;
const CORE_HALF = 51200;
const NCH = 8;                       // chunks per tile side (800 m)
const CHUNK = TILE / NCH;
const MARGIN = 900;                  // buildings belong to the tile of their centre: they reach a bit over it

// near: full-detail radius (m); visK: visibility distance per metre of building size; far: tiles
// further than this are not loaded; maxChunks: full-detail chunks at most; shadowFar: ground
// shadow decals within this distance (m); shadowVisK: their visibility distance per metre of size
const QUALITY = {
  low: { near: 1200, visK: 300, far: 15000, maxChunks: 24, parapets: true, roofBoxes: false, shadowFar: 4000, shadowVisK: 150 },
  medium: { near: 2000, visK: 450, far: 21000, maxChunks: 44, parapets: true, roofBoxes: true, shadowFar: 8000, shadowVisK: 250 },
  high: { near: 3000, visK: 650, far: 28000, maxChunks: 72, parapets: true, roofBoxes: true, shadowFar: 12000, shadowVisK: 350 },
};

const MAX_TILE_LOADS = 2;            // tiles being fetched / parsed at once
const MAX_CHUNK_BUILDS = 2;          // chunks being built at once
const FADE_S = 0.6;                  // cross-fade between a chunk's boxes and its full detail (s)

// Night light (js/env/README.md "Lights at night": physical values x env.lightGain / LUX_PER_UNIT):
// a lit window's luminance (cd/m^2, the brightest channel of its tint: rooms behind glass and
// curtains ~10-40 cd/m^2 with the shader's spread from room to room, shop fronts x 1.8; at night
// 0.5-0.8 on the display, where Post.js keeps a light's hue) and the street lights' illuminance on
// the lowest floors of the walls (lux; streets get 10-20 lux on the ground, the walls beside them
// less, falling off upwards in the shader).
const WINDOW_CD = 20;
const FACADE_LUX = 8;

// Share of the windows lit at local solar time h: homes (an evening peak, quiet small hours),
// offices and public buildings (the working day; after 20:00 late workers, cleaners and the
// lights left on, 15-30 %)
const LIT_HOMES = [[0, 0.30], [2, 0.17], [5, 0.12], [6.5, 0.2], [8, 0.08], [17, 0.08], [19, 0.42], [21, 0.52], [23, 0.40], [24, 0.30]];
const LIT_OFFICES = [[0, 0.1], [6, 0.1], [8, 0.55], [17, 0.6], [19, 0.4], [20, 0.28], [22, 0.18], [24, 0.1]];
function litFraction(h, P = LIT_HOMES) {
  h = ((h % 24) + 24) % 24;
  for (let i = 1; i < P.length; i++) {
    if (h <= P[i][0]) {
      const [h0, v0] = P[i - 1], [h1, v1] = P[i];
      return v0 + (v1 - v0) * (h - h0) / (h1 - h0);
    }
  }
  return P[0][1];
}

/**
 * The box: 4 bottom corners, 4 eave corners, 2 ridge ends (position = (sign a, level, sign b),
 * level 0 bottom / 1 eave / 2 ridge). For a flat roof the ridge lies on the eave and the two
 * "slopes" are the roof's halves; for gables the end triangles stand in the walls' planes.
 */
function boxTemplate() {
  const P = [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1], [-1, 2, 0], [1, 2, 0]];
  // faces: corners, outward direction in (a, up, b)
  const faces = [
    [[1, 2, 6, 5], [1, 0, 0]], [[0, 3, 7, 4], [-1, 0, 0]], [[2, 3, 7, 6], [0, 0, 1]], [[0, 1, 5, 4], [0, 0, -1]],
    [[6, 7, 8, 9], [0, 1, 1]], [[4, 5, 9, 8], [0, 1, -1]], [[5, 6, 9], [1, 1, 0]], [[7, 4, 8], [-1, 1, 0]],
  ];
  // a reference hipped box (a = x, b = z: yaw 0) decides each triangle's winding
  const ref = (k) => { const [sa, l, sb] = P[k]; return [sa * (l === 2 ? 1 : 2), l === 0 ? 0 : l === 1 ? 1 : 1.6, sb]; };
  const idx = [];
  for (const [f, out] of faces) {
    const tris = f.length === 4 ? [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] : [[f[0], f[1], f[2]]];
    for (const t of tris) {
      const [a, b, c] = t.map(ref);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) t.reverse();
      idx.push(...t);
    }
  }
  return {
    position: new THREE.BufferAttribute(new Float32Array(P.flat()), 3),
    index: new THREE.BufferAttribute(new Uint16Array(idx), 1),
  };
}

/** The shadow decal: a hexagon whose corners the vertex shader places (position.x = corner). */
function hexTemplate() {
  const P = new Float32Array(18);
  for (let k = 0; k < 6; k++) P[k * 3] = k;
  return {
    position: new THREE.BufferAttribute(P, 3),
    index: new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]), 1),
  };
}

/** Distance from point (x, y, z) to the box [x0, x1] x [y0, y1] x [z0, z1]. */
function boxDistance(x, y, z, x0, y0, z0, x1, y1, z1) {
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
  const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class Buildings {
  constructor({ renderer, scene, env, terrain, app }, { baseUrl = 'data/world/buildings/' } = {}) {
    this.name = 'Buildings';
    this.renderer = renderer;
    this.scene = scene;
    this.env = env;
    this.terrain = terrain;
    this.app = app;
    this.baseUrl = baseUrl;
    this.attribution = 'Buildings: © OpenStreetMap contributors and Microsoft ML Building Footprints (ODbL), via the Overture Maps Foundation; air bases traced from ESA WorldCover Sentinel-2 imagery (CC BY 4.0).';
    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    this.forcedOff = params.get('buildings') === '0';
    this.shadowsOn = params.get('bshadows') !== '0';
    this.lightsOn = params.get('blights') !== '0';
    this.quality = 'high';
    this.Q = QUALITY.high;
    this.hours = 12;
    this.index = null;
    this.tiles = new Map();
    this._tileList = [];                 // the same tiles, for the per-frame loops (no iterators)
    this.stats = { tiles: 0, boxes: 0, chunks: 0, chunkVertices: 0, chunkMB: 0, boxMB: 0, shadows: 0, shadowMB: 0, lights: 0, fading: 0, off: false };

    this.group = new THREE.Group();
    this.group.name = 'Buildings';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    // uniforms shared by every building material (by reference)
    this._shared = {
      uLight: { value: new THREE.Vector4() },
      uLitOffice: { value: 0 },
      uAlbedo: { value: new THREE.Vector3(0.78, terrain?.albedoGain ?? 0.7, 1) },
      uVis: { value: new THREE.Vector4(this.Q.visK, 0.25, 0.0012, this.Q.far) },
      uDebug: { value: params.get('buildingsDebug') === '1' ? 1 : 0 },
    };
    this._template = boxTemplate();
    this._hex = hexTemplate();
    this.chunkMaterial = this._material(false);
    this.chunkDepthMaterial = this._depthMaterial();
    // ground shadow decals and obstruction lights: one material each for every tile
    this._shadowU = {
      uShadowSun: { value: new THREE.Vector4(0, 1, 0, 0) },
      uShadowVis: { value: new THREE.Vector4(this.Q.shadowVisK, this.Q.shadowFar, 0, 0) },
      uRealShadow: { value: new THREE.Vector4(0, 0, 0, 0) },
      uShadowGamma: { value: 1 },
      uShadowView: { value: new THREE.Vector4(0, 0, 1, 1) },
    };
    this.shadowMaterial = this._shadowMaterial();
    // obstruction lights: on, time; and the point-light rule's uniforms (AirportLights.js)
    this._lightU = {
      uLightOn: { value: new THREE.Vector3(0, 0, 1) },
      uThreshold: { value: 1e-7 }, uExposure: { value: 1 }, uPxAngle: { value: 1e-3 }, uGain: { value: 1 / LUX_PER_UNIT },
      uLightsOn: { value: 0 },
    };
    this._dbSize = new THREE.Vector2();
    this.lightMaterial = this._lightMaterial();
    this._fading = new Set();            // chunks cross-fading with their boxes
    this._cand = [];                     // _streamChunks: candidates, pooled (no garbage per frame)
    this._candPool = [];
    this._byP = (a, b) => a.p - b.p;
    this._frame = 0;
    this._lastT = 0;
    this._cam = new THREE.Vector3();
    this._reqId = 0;
    this._waiting = new Map();
    this._tileLoads = 0;
    this._chunkBuilds = 0;
    this._castShadow = false;
    this._disposed = false;

    // the stand-in environment of ?stubs=1 has no atmosphere (and there is no data): stay off;
    // with ?buildings=0 nothing is loaded or compiled at all
    if (!env?.uniforms?.uSkyViewLUT || this.forcedOff) {
      this.failed = !this.forcedOff;
      this.worker = null;
      this.ready = Promise.resolve();
      return;
    }
    this.worker = new Worker(new URL('./BuildingsWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => { console.warn('Buildings: worker failed', e.message || e); this.failed = true; };
    this.ready = this._loadIndex();
  }

  // ------------------------------------------------------------------------------ data
  async _loadIndex() {
    try {
      const r = await fetch(this.baseUrl + 'index.json');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const idx = await r.json();
      if (idx.format !== 'f35i-buildings' || idx.version !== 1) throw new Error('unknown index format');
      if (this._disposed) return;
      this.index = idx;
      if (idx.attribution) this.attribution = idx.attribution;
      for (const t of idx.tiles) {
        if (!t.count) continue;
        const key = `${t.ix}_${t.iz}`;
        const tile = {
          key, ix: t.ix, iz: t.iz, file: t.file, count: t.count, maxTop: t.maxTop, minBase: t.minBase,
          x0: -CORE_HALF + t.ix * TILE, z0: -CORE_HALF + t.iz * TILE, state: 'idle', retryAt: 0,
          mesh: null, vsize: null, chunks: null, lod: new Map(), dist: Infinity,
          fade: null, boxMat: null, boxDither: null, fadeMark: -1, shadowMesh: null, lights: null,
        };
        this.tiles.set(key, tile);
        this._tileList.push(tile);
      }
      this._precompile();
    } catch (e) {
      console.warn(`Buildings: no building data (${e.message}); build it with sim/tools/world/buildings.py`);
    }
  }

  _request(msg, transfer) {
    const id = ++this._reqId;
    return new Promise((resolve, reject) => {
      this._waiting.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  _onMessage(m) {
    const w = this._waiting.get(m.id);
    if (!w) return;
    this._waiting.delete(m.id);
    if (m.ok) w.resolve(m); else w.reject(new Error(m.error || 'worker error'));
  }

  // ------------------------------------------------------------------------------ materials
  /**
   * Box (one per tile: its uFade) or chunk material; dither: the cross-fading variant (discard
   * costs the early depth test, so only fading meshes use it). fade: the tile's uFade to share.
   */
  _material(box, dither = false, fade = null) {
    const lights = THREE.UniformsUtils.clone(THREE.UniformsLib.lights);
    const uniforms = { ...lights, ...this.env.uniforms, ...this._shared };
    if (box) uniforms.uFade = fade || { value: Array.from({ length: 16 }, () => new THREE.Vector4()) };
    else if (dither) uniforms.uFadeIn = { value: 0 };
    const defines = box ? { BOX: 1 } : {};
    if (dither) defines.DITHER = 1;
    return new THREE.ShaderMaterial({
      name: (box ? 'BuildingBoxes' : 'BuildingChunks') + (dither ? 'Dither' : ''),
      uniforms,
      vertexShader: box ? BOX_VERT : CHUNK_VERT,
      fragmentShader: BUILDING_FRAG,
      defines,
      lights: true,
      fog: false,
    });
  }

  _depthMaterial() {
    return new THREE.ShaderMaterial({
      name: 'BuildingChunksDepth',
      uniforms: { ...this.env.uniforms, ...this._shared },
      vertexShader: CHUNK_VERT,
      fragmentShader: DEPTH_FRAG,
      defines: { DEPTH_PASS: 1 },
    });
  }

  /** Ground shadows: multiplied into what is drawn (dst * src), depth-tested and depth-written. */
  _shadowMaterial() {
    return new THREE.ShaderMaterial({
      name: 'BuildingShadows',
      uniforms: { ...this.env.uniforms, ...this._shadowU },
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.LessDepth,
      side: THREE.DoubleSide,
      fog: false,
    });
  }

  _lightMaterial() {
    // added light with its mark as a light in the alpha (js/env/emitters.js)
    return emitterBlending(new THREE.ShaderMaterial({
      name: 'BuildingLights',
      uniforms: { ...this.env.uniforms, ...this._lightU },
      vertexShader: LIGHT_VERT,
      fragmentShader: LIGHT_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      fog: false,
    }));
  }

  /**
   * Compiles the building programs in the background (no hitch when the first tile shows): boxes
   * and chunks with their cross-fade variants, ground shadows, lights, and the chunks' shadow-map
   * depth program. Program parameters depend on the render target (colour space, tone mapping):
   * the depth program is compiled with a target bound, as the shadow pass draws it, and with
   * parallel compilation the colour programs both for the canvas and for a post chain's target.
   * They depend on the lights too: with the sun casting shadows (by day) and without (at night,
   * and at start-up, before js/env switches them on), so both are compiled, the depth program
   * only with (the shadow pass runs only then).
   */
  _precompile() {
    const tmp = new THREE.Scene(), tmpD = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(60, 1, 1, 1000);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(this._template.index.clone());
    g.setAttribute('position', this._template.position.clone());
    for (const k of ['iA', 'iB', 'iC', 'iInfo']) g.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(4), 4));
    for (const k of ['iWall', 'iRoof']) g.setAttribute(k, new THREE.InstancedBufferAttribute(new Uint8Array(4), 4, true));
    g.instanceCount = 1;
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    cg.setAttribute('aNrm', new THREE.BufferAttribute(new Int8Array(12), 4, true));
    cg.setAttribute('aFac', new THREE.BufferAttribute(new Int16Array(6), 2));
    cg.setAttribute('aCol', new THREE.BufferAttribute(new Uint8Array(12), 4, true));
    cg.setAttribute('aInf', new THREE.BufferAttribute(new Uint8Array(12), 4));
    const sg = new THREE.InstancedBufferGeometry();
    sg.setIndex(this._hex.index.clone());
    sg.setAttribute('position', this._hex.position.clone());
    for (const k of ['dA', 'dB']) sg.setAttribute(k, new THREE.InstancedBufferAttribute(new Uint16Array(4), 4));
    sg.instanceCount = 1;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    pg.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(2), 2));
    // the prototypes stay alive: a program is freed with the last material using it
    this._boxMaterialProto = this._material(true);
    this._boxDitherProto = this._material(true, true);
    this._chunkDitherProto = this._material(false, true);
    const objs = [new THREE.Mesh(g, this._boxMaterialProto), new THREE.Mesh(g, this._boxDitherProto),
      new THREE.Mesh(cg, this.chunkMaterial), new THREE.Mesh(cg, this._chunkDitherProto),
      new THREE.Mesh(sg, this.shadowMaterial), new THREE.Points(pg, this.lightMaterial)];
    for (const m of objs) { m.frustumCulled = false; m.receiveShadow = true; tmp.add(m); }
    const dm = new THREE.Mesh(cg, this.chunkDepthMaterial);
    dm.frustumCulled = false;
    tmpD.add(dm);
    const rt = new THREE.WebGLRenderTarget(1, 1);
    const done = () => { g.dispose(); cg.dispose(); sg.dispose(); pg.dispose(); rt.dispose(); };
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const sun = this.env?.sunLight, cast = sun ? sun.castShadow : false;
    const states = sun && r.shadowMap.enabled ? [false, true] : [cast];
    // in parallel where the browser can (KHR_parallel_shader_compile), else now (the menu shows)
    const parallel = r.extensions.has('KHR_parallel_shader_compile');
    const p = [];
    try {
      for (const s of states) {
        if (sun) sun.castShadow = s;     // only for these calls: put back below, before any frame
        if (parallel) {
          p.push(r.compileAsync(tmp, cam, this.scene));
          r.setRenderTarget(rt);
          if (s || states.length === 1) p.push(r.compileAsync(tmpD, cam, this.scene));
          p.push(r.compileAsync(tmp, cam, this.scene));
        } else {
          r.compile(tmp, cam, this.scene);
          r.setRenderTarget(rt);
          if (s || states.length === 1) r.compile(tmpD, cam, this.scene);
        }
        r.setRenderTarget(prev);
      }
    } catch (e) {
      r.setRenderTarget(prev);
      console.warn('Buildings: precompile', e);
    } finally {
      if (sun) sun.castShadow = cast;
    }
    Promise.all(p).then(done, (e) => { console.warn('Buildings: precompile', e); done(); });
  }

  // ------------------------------------------------------------------------------ module API
  update(f) {
    const on = !this.forcedOff && !this.failed && this.app?.settings?.buildings !== false;
    if (this.group.visible !== on) this.group.visible = on;
    this.stats.off = !on;                // for the tests: nothing will stream
    if (!on) {
      // switched off: free the video memory too (switching on streams everything in again)
      if (this._loaded) { for (const t of this.tiles.values()) this._unloadTile(t); this._loaded = false; }
      return;
    }
    if (!this.index) return;
    f.camera.getWorldPosition(this._cam);
    this._streamTiles();
    this._streamChunks();
    if (f.draw) this._prepareDraw(f.camera);
  }

  setTime(hours) {
    this.hours = hours;
  }

  setQuality(q) {
    if (!QUALITY[q]) return;
    const old = this.Q;
    this.quality = q;
    this.Q = QUALITY[q];
    this._shared.uVis.value.x = this.Q.visK;
    this._shared.uVis.value.w = this.Q.far;
    this._shadowU.uShadowVis.value.x = this.Q.shadowVisK;
    this._shadowU.uShadowVis.value.y = this.Q.shadowFar;
    // chunks built with the other options (roof houses, parapets) are built again: released
    // here, the streaming asks for them anew (tiles beyond the new `far` go by themselves)
    if (old.parapets !== this.Q.parapets || old.roofBoxes !== this.Q.roofBoxes) {
      for (const t of this._tileList) for (const k of [...t.lod.keys()]) this._releaseChunk(t, k, true);
    }
  }

  reset() {
    // a new start point: the streaming follows the camera (chunks far from it go by distance)
  }

  dispose() {
    this._disposed = true;
    for (const t of this._tileList) this._unloadTile(t);
    this.worker?.terminate();
    this.scene.remove(this.group);
    for (const m of [this.chunkMaterial, this.chunkDepthMaterial, this.shadowMaterial, this.lightMaterial,
      this._boxMaterialProto, this._boxDitherProto, this._chunkDitherProto]) m?.dispose();
  }

  // ------------------------------------------------------------------------------ tiles (boxes)
  _streamTiles() {
    const c = this._cam, far = this.Q.far;
    let want = null, wantD = Infinity;
    const now = performance.now();
    for (let i = 0; i < this._tileList.length; i++) {
      const t = this._tileList[i];
      const d = boxDistance(c.x, c.y, c.z, t.x0 - MARGIN, t.minBase, t.z0 - MARGIN, t.x0 + TILE + MARGIN, t.maxTop, t.z0 + TILE + MARGIN);
      t.dist = d;
      if (t.state === 'ready' && d > far + 3000) this._unloadTile(t);
      else if (t.state === 'idle' && d < far && d < wantD) { want = t; wantD = d; }
      else if (t.state === 'failed' && now > t.retryAt && d < far && d < wantD) { want = t; wantD = d; }
    }
    if (want && this._tileLoads < MAX_TILE_LOADS) this._loadTile(want);
  }

  async _loadTile(t) {
    t.state = 'loading';
    const token = t.token = {};          // a tile unloaded and loaded again while this one runs
    this._tileLoads++;
    this._loaded = true;
    try {
      const m = await this._request({ type: 'tile', key: t.key, url: new URL(this.baseUrl + t.file, location.href).href });
      if (this._disposed) return;
      if (t.token !== token) return;     // superseded: the newer request owns the worker's copy
      if (t.state !== 'loading') { this.worker.postMessage({ type: 'drop', key: t.key }); return; }
      this._buildTileMesh(t, m.boxes);
      this._buildShadowMesh(t, m.shadows);
      this._buildLights(t, m.lights);
      t.chunks = m.chunks;
      t.state = 'ready';
    } catch (e) {
      if (t.token !== token) return;
      console.warn(`Buildings: tile ${t.key}: ${e.message}`);
      t.state = 'failed';
      t.retryAt = performance.now() + 30000;
    } finally {
      this._tileLoads--;
    }
  }

  _buildTileMesh(t, b) {
    // own copies of the 10-vertex template: disposing a geometry frees its attributes' buffers
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(this._template.index.clone());
    g.setAttribute('position', this._template.position.clone());
    g.setAttribute('iA', new THREE.InstancedBufferAttribute(b.a, 4));
    g.setAttribute('iB', new THREE.InstancedBufferAttribute(b.b, 4));
    g.setAttribute('iC', new THREE.InstancedBufferAttribute(b.c, 4));
    g.setAttribute('iWall', new THREE.InstancedBufferAttribute(b.wall, 4, true));
    g.setAttribute('iRoof', new THREE.InstancedBufferAttribute(b.roof, 4, true));
    g.setAttribute('iInfo', new THREE.InstancedBufferAttribute(b.info, 4));
    g.instanceCount = 0;
    const h = Math.max(t.maxTop - t.minBase, 1);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(TILE / 2, (t.maxTop + t.minBase) / 2, TILE / 2),
      Math.hypot(TILE / 2 + MARGIN, TILE / 2 + MARGIN, h / 2) + 20);
    const material = this._boxMaterialProto && !this._boxMaterialProto.userData.used ? this._boxMaterialProto : this._material(true);
    material.userData.used = true;
    material.uniforms.uFade.value.forEach((v) => v.set(0, 0, 0, 0));
    t.boxMat = material;
    t.fade = material.uniforms.uFade;
    const mesh = new THREE.Mesh(g, material);
    mesh.name = `buildings_${t.key}`;
    mesh.position.set(t.x0, 0, t.z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 1;
    mesh.visible = false;
    this.group.add(mesh);
    mesh.updateMatrixWorld(true);
    t.mesh = mesh;
    t.vsize = b.vsize;
    t.boxBytes = b.a.byteLength * 3 + b.wall.byteLength * 3;
  }

  /** The tile's ground shadow decals (sorted by ground level in the worker). */
  _buildShadowMesh(t, sh) {
    if (!sh || !sh.count || !this.shadowsOn) return;     // ?bshadows=0: not built at all
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(this._hex.index.clone());
    g.setAttribute('position', this._hex.position.clone());
    g.setAttribute('dA', new THREE.InstancedBufferAttribute(sh.dA, 4));
    g.setAttribute('dB', new THREE.InstancedBufferAttribute(sh.dB, 4));
    g.instanceCount = sh.count;
    g.boundingSphere = t.mesh.geometry.boundingSphere.clone();
    g.boundingSphere.radius += 300;                    // shadows reach beyond the buildings
    const mesh = new THREE.Mesh(g, this.shadowMaterial);
    mesh.name = `buildingShadows_${t.key}`;
    mesh.position.set(t.x0, 0, t.z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // first among the transparent things: after the opaque world (terrain, buildings, trees),
    // before clouds and effects, which must not be darkened (draped layers that should be
    // shadowed draw before this)
    mesh.renderOrder = -50;
    mesh.visible = false;
    mesh.onBeforeRender = this._shadowHook || (this._shadowHook = (renderer) => {
      // a target holds radiance (a post chain); the canvas holds display values
      const U = this._shadowU;
      U.uShadowGamma.value = renderer.getRenderTarget() ? 1 : 1 / 2.2;
      // the viewport (pixels) the fragment shader turns gl_FragCoord into view rays with
      const v = renderer.getCurrentViewport(this._vp || (this._vp = new THREE.Vector4()));
      U.uShadowView.value.set(v.x, v.y, 1 / Math.max(v.z, 1), 1 / Math.max(v.w, 1));
    });
    this.group.add(mesh);
    mesh.updateMatrixWorld(true);
    t.shadowMesh = mesh;
    t.shadowBytes = sh.dA.byteLength * 2;
  }

  /** The tile's obstruction lights (one Points object). */
  _buildLights(t, li) {
    if (!li || !li.count || !this.lightsOn) return;       // ?blights=0: not built at all
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(li.pos, 3));
    g.setAttribute('aLight', new THREE.BufferAttribute(li.kind, 2));
    g.computeBoundingSphere();
    const pts = new THREE.Points(g, this.lightMaterial);
    pts.name = `buildingLights_${t.key}`;
    pts.position.set(t.x0, 0, t.z0);
    pts.matrixAutoUpdate = false;
    pts.updateMatrix();
    pts.renderOrder = 20;
    pts.visible = false;
    this.group.add(pts);
    pts.updateMatrixWorld(true);
    t.lights = pts;
    t.lightCount = li.count;
  }

  _unloadTile(t) {
    for (const c of [...t.lod.keys()]) this._releaseChunk(t, c, true);
    if (t.mesh) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      if (t.boxMat === this._boxMaterialProto) this._boxMaterialProto = null;
      t.boxMat.dispose();
      t.boxDither?.dispose();
      t.mesh = null;
      t.boxMat = null;
      t.boxDither = null;
      t.fade = null;
    }
    for (const k of ['shadowMesh', 'lights']) {
      if (!t[k]) continue;
      this.group.remove(t[k]);
      t[k].geometry.dispose();
      t[k] = null;
    }
    if (t.state === 'ready') this.worker.postMessage({ type: 'drop', key: t.key });
    t.vsize = null;
    t.chunks = null;
    t.state = 'idle';
  }

  // ------------------------------------------------------------------------------ chunks (full detail)
  _chunkRange(info) {
    // chunks with towers keep their full detail further out
    return this.Q.near * Math.min(2.2, Math.max(1, Math.sqrt(info.tall / 45)));
  }

  _streamChunks() {
    const c = this._cam, Q = this.Q;
    const maxRange = Q.near * 2.2 + CHUNK;
    const cand = this._cand, pool = this._candPool;
    let n = 0;
    for (let ti = 0; ti < this._tileList.length; ti++) {
      const t = this._tileList[ti];
      if (t.state !== 'ready') continue;
      if (t.dist > maxRange && !t.lod.size) continue;
      for (let k = 0; k < NCH * NCH; k++) {
        const info = t.chunks[k];
        if (!info.n) continue;
        const x0 = t.x0 + (k % NCH) * CHUNK, z0 = t.z0 + Math.floor(k / NCH) * CHUNK;
        const d = boxDistance(c.x, c.y, c.z, x0, info.lo, z0, x0 + CHUNK, info.hi, z0 + CHUNK);
        const r = this._chunkRange(info);
        const L = t.lod.get(k);
        if (d < r) {
          const o = pool[n] || (pool[n] = { t: null, k: 0, p: 0, L: null });
          o.t = t; o.k = k; o.p = d / r; o.L = L || null;
          cand[n++] = o;
        } else if (L && L.state !== 'building' && d > r * 1.1) this._releaseChunk(t, k);
      }
    }
    cand.length = n;
    cand.sort(this._byP);
    for (let i = 0; i < n; i++) {
      const { t, k, L } = cand[i];
      if (i >= Q.maxChunks) {
        if (L && L.state === 'ready' && i >= Q.maxChunks + 6) this._releaseChunk(t, k);
        continue;
      }
      if (L && L.target === 0 && L.mesh) this._startFade(t, k, L, 1);     // wanted again while fading out
      if (!L && this._chunkBuilds < MAX_CHUNK_BUILDS) this._buildChunk(t, k);
    }
    for (let i = 0; i < n; i++) cand[i].t = cand[i].L = null;           // no references kept
  }

  async _buildChunk(t, k) {
    const L = { state: 'building', mesh: null };
    t.lod.set(k, L);
    this._chunkBuilds++;
    try {
      const m = await this._request({ type: 'chunk', key: t.key, chunk: k, opts: { parapets: this.Q.parapets, roofBoxes: this.Q.roofBoxes } });
      if (this._disposed || t.lod.get(k) !== L || t.state !== 'ready') return;
      const geo = m.geo;
      if (!geo.vertices) { L.state = 'empty'; return; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(geo.position, 3));
      g.setAttribute('aNrm', new THREE.BufferAttribute(geo.normal, 4, true));
      g.setAttribute('aFac', new THREE.BufferAttribute(geo.facade, 2));
      g.setAttribute('aCol', new THREE.BufferAttribute(geo.color, 4, true));
      g.setAttribute('aInf', new THREE.BufferAttribute(geo.info, 4));
      g.setIndex(new THREE.BufferAttribute(geo.index, 1));
      const s = geo.sphere;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(s[0], s[1], s[2]), s[3]);
      const mesh = new THREE.Mesh(g, this.chunkMaterial);
      mesh.name = `buildings_${t.key}_${k}`;
      mesh.customDepthMaterial = this.chunkDepthMaterial;
      mesh.position.set(t.x0 + geo.center[0], 0, t.z0 + geo.center[1]);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.receiveShadow = true;
      mesh.castShadow = this._castShadow;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      mesh.updateMatrixWorld(true);
      L.mesh = mesh;
      L.state = 'ready';
      L.vertices = geo.vertices;
      L.bytes = g.attributes.position.array.byteLength * 7 / 3 + geo.index.byteLength;
      L.fade = 0;
      this._startFade(t, k, L, 1);
    } catch (e) {
      console.warn(`Buildings: chunk ${t.key}/${k}: ${e.message}`);
      if (t.lod.get(k) === L) L.state = 'failed';
    } finally {
      this._chunkBuilds--;
    }
  }

  /** Releases a chunk: cross-fading back to its boxes first, unless `now`. */
  _releaseChunk(t, k, now = false) {
    const L = t.lod.get(k);
    if (!L) return;
    if (!now && L.state === 'ready' && L.mesh) {
      if (L.target !== 0) this._startFade(t, k, L, 0);
      return;
    }
    t.lod.delete(k);
    this._fading.delete(L);
    this._setFade(t, k, 0);
    if (L.mesh) {
      this.group.remove(L.mesh);
      L.mesh.geometry.dispose();
      L.mesh = null;
    }
    if (L.dither) { L.dither.dispose(); L.dither = null; }
  }

  /** Starts a cross-fade of chunk k towards full detail (target 1) or back to its boxes (0). */
  _startFade(t, k, L, target) {
    L.t = t; L.k = k; L.target = target;
    if (!L.dither) L.dither = this._material(false, true);
    L.dither.uniforms.uFadeIn.value = L.fade;
    L.mesh.material = L.dither;
    this._fading.add(L);
    this._setFade(t, k, L.fade);
  }

  _setFade(t, k, v) {
    if (t.fade) t.fade.value[k >> 2].setComponent(k & 3, v);
  }

  /** Advances the cross-fades; a tile's boxes use the dithered material while one of its chunks fades. */
  _updateFades(dt) {
    const step = dt / FADE_S;
    for (const L of this._fading) {
      L.fade = L.target > L.fade ? Math.min(L.target, L.fade + step) : Math.max(L.target, L.fade - step);
      L.dither.uniforms.uFadeIn.value = L.fade;
      this._setFade(L.t, L.k, L.fade);
      if (L.fade !== L.target) { L.t.fadeMark = this._frame; continue; }
      if (L.target === 0) { this._releaseChunk(L.t, L.k, true); continue; }
      L.mesh.material = this.chunkMaterial;
      L.dither.dispose();
      L.dither = null;
      this._fading.delete(L);
    }
  }

  // ------------------------------------------------------------------------------ per drawn frame
  _prepareDraw(camera) {
    const visK = this.Q.visK, far = this.Q.far;
    const now = performance.now();
    // wall time since the last drawn frame: a fade runs its FADE_S whatever the frame rate (after
    // a long gap between frames, a test's settle or a stall, it is simply done)
    const dt = this._lastT ? Math.min((now - this._lastT) / 1000, 1) : 0;
    this._lastT = now;
    this._frame++;
    this._updateFades(dt);
    // the sun: ground shadows by day; lit windows and obstruction lights by the one switch-on
    // schedule of every light (js/env "Lights at night": env.lightsOn, from just before sunset)
    const sunY = this.env.sunDirection ? this.env.sunDirection.y : 1;
    const kOn = this.env.lightsOn ?? lightsOnAt(this.env.sunElevationDeg ?? 90);
    const shadowK = this.shadowsOn ? Math.min(1, Math.max(0, (sunY - 0.02) / 0.1)) : 0;
    const shadowFar = this.Q.shadowFar;
    const lightsOn = this.lightsOn && kOn > 0.01;
    let boxes = 0, tiles = 0, chunks = 0, verts = 0, chunkBytes = 0, boxBytes = 0, shadows = 0, shadowBytes = 0, lights = 0;
    for (let ti = 0; ti < this._tileList.length; ti++) {
      const t = this._tileList[ti];
      if (t.state !== 'ready' || !t.mesh) continue;
      tiles++;
      boxBytes += t.boxBytes;
      // dithered boxes only while one of the tile's chunks cross-fades
      const mat = t.fadeMark === this._frame ? (t.boxDither || (t.boxDither = this._material(true, true, t.fade))) : t.boxMat;
      if (t.mesh.material !== mat) t.mesh.material = mat;
      if (t.shadowMesh) {
        const on = shadowK > 0 && t.dist < shadowFar;
        t.shadowMesh.visible = on;
        shadowBytes += t.shadowBytes;
        if (on) shadows += t.shadowMesh.geometry.instanceCount;
      }
      if (t.lights) {
        const on = lightsOn && t.dist < far;
        t.lights.visible = on;
        if (on) lights += t.lightCount;
      }
      // instances are sorted by size: draw those visible from the tile's nearest point
      let n = 0;
      if (t.dist < far) {
        const need = t.dist / visK, v = t.vsize;
        let lo = 0, hi = v.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (v[mid] > need) lo = mid + 1; else hi = mid; }
        n = lo;
      }
      t.mesh.geometry.instanceCount = n;
      t.mesh.visible = n > 0;
      boxes += n;
      for (const L of t.lod.values()) {
        if (L.state !== 'ready') continue;
        chunks++;
        verts += L.vertices;
        chunkBytes += L.bytes;
      }
    }
    // the shadow camera only covers the aircraft unless the lighting makes it bigger
    const sl = this.env.sunLight, sc = sl?.shadow?.camera;
    const cast = !!(sl?.castShadow && sc && sc.right - sc.left >= 300);
    if (cast !== this._castShadow) {
      this._castShadow = cast;
      for (const t of this._tileList) for (const L of t.lod.values()) if (L.mesh) L.mesh.castShadow = cast;
    }
    // ground shadows: the sun's direction and strength; faded out inside the shadow map's box
    // when the buildings cast into it (its target is the box's centre on the ground)
    const SU = this._shadowU;
    if (this.env.sunDirection) SU.uShadowSun.value.set(this.env.sunDirection.x, this.env.sunDirection.y, this.env.sunDirection.z, shadowK);
    else SU.uShadowSun.value.w = 0;
    if (cast && sl.target) {
      sl.target.getWorldPosition(this._tmpV || (this._tmpV = new THREE.Vector3()));
      SU.uRealShadow.value.set(this._tmpV.x, this._tmpV.z, 0.5 * (sc.right - sc.left), 1);
    } else SU.uRealShadow.value.set(0, 0, 0, 0);
    // obstruction lights: on, time (flashing); the rule for point lights (env: the eye's
    // adaptation and the threshold of a point light; the renderer's exposure and pixel size)
    const env = this.env, el = env.sunElevationDeg ?? 90;
    const lightGain = env.lightGain ?? artificialLightGain(env.exposure, el);
    const LUo = this._lightU;
    LUo.uLightOn.value.set(kOn, now / 1000, 0);
    LUo.uThreshold.value = env.pointThreshold ?? pointLightThreshold(el);
    LUo.uExposure.value = this.renderer.toneMappingExposure || 1;
    LUo.uGain.value = lightGain / LUX_PER_UNIT;
    LUo.uLightsOn.value = env.lightsOn ?? lightsOnAt(el);
    if (camera && camera.isPerspectiveCamera) {
      const hPx = this.renderer.getDrawingBufferSize(this._dbSize).y || 1;
      LUo.uPxAngle.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1) / hPx;
    }
    // the terrain's albedo gain (it may change at run time): roofs match the ground under them
    this._shared.uAlbedo.value.y = this.terrain?.albedoGain ?? this._shared.uAlbedo.value.y;
    // night: lit windows and street light, switched on through the dusk (kOn), physical
    // values seen by the eye's adaptation (lightGain)
    const U = this._shared.uLight.value;
    const h = this.hours;
    const art = kOn * lightGain / LUX_PER_UNIT;
    U.set(litFraction(h), WINDOW_CD * art, FACADE_LUX * art, h > 22.5 || h < 6 ? 0.25 : 0.85);
    this._shared.uLitOffice.value = litFraction(h, LIT_OFFICES);
    const S = this.stats;
    S.tiles = tiles; S.boxes = boxes; S.chunks = chunks; S.chunkVertices = verts;
    S.chunkMB = +(chunkBytes / 1048576).toFixed(1); S.boxMB = +(boxBytes / 1048576).toFixed(1);
    S.shadows = shadows; S.shadowMB = +(shadowBytes / 1048576).toFixed(1); S.lights = lights;
    S.fading = this._fading.size;
    S.loading = this._tileLoads + this._chunkBuilds;
  }

  /**
   * Test hook: speckle in the frame last drawn on the canvas, as shown (tone mapped, sRGB; with
   * ?test=1 the canvas keeps its drawing buffer): pixels at least 0.1 darker or brighter than the
   * median of their eight neighbours while six of those agree with that median. The salt and
   * pepper that style ids compared bit-exact after interpolation left on facades (a share of their
   * pixels took another style's colour) counts tens of thousands per million; a clean view of the
   * towers a few hundred (window corners, edges). Returns {pixels, speckles, perMillion}.
   */
  speckleCheck() {
    const r = this.renderer, gl = r.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (!w || !h || w * h > 1 << 23) return null;
    const buf = new Uint8Array(w * h * 4);
    const prev = r.getRenderTarget();
    r.setRenderTarget(null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    r.setRenderTarget(prev);
    const L = new Float32Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) L[i] = (0.2126 * buf[j] + 0.7152 * buf[j + 1] + 0.0722 * buf[j + 2]) / 255;
    const off = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
    const n = new Float32Array(8);
    let speckles = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        for (let k = 0; k < 8; k++) {                     // the neighbours, sorted
          const v = L[i + off[k]];
          let m = k;
          while (m > 0 && n[m - 1] > v) { n[m] = n[m - 1]; m--; }
          n[m] = v;
        }
        const med = 0.5 * (n[3] + n[4]);
        if (Math.abs(L[i] - med) < 0.1) continue;
        let agree = 0;
        for (let k = 0; k < 8; k++) if (Math.abs(n[k] - med) < 0.04) agree++;
        if (agree >= 6) speckles++;
      }
    }
    const pixels = (w - 2) * (h - 2);
    return { pixels, speckles, perMillion: Math.round(speckles / pixels * 1e6) };
  }
}
