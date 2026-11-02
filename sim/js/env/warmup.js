// Shader warm-up: every shader program the app draws with is built before it is first needed,
// behind the loading screen and in parallel where the browser can, so no frame later stops for a
// compile.
//
// Why: three.js builds a material's program the first time the material is drawn. On the PC
// (Chrome, ANGLE / Direct3D 11) a new program costs 100-850 ms of main-thread time on its first
// use: the menu's first frame took 5.7 s (59 programs), the first second of a flight had two
// frames of ~0.5 s (the cockpit shadow's depth program, the roads, the near terrain), the first
// sunset another stop (a lit material has a second program without the sun's shadow map), and
// every kind of tree, road and building that streamed in later its own hitch.
//
// What is built, and how:
//  - install() wraps renderer.compile(). Program variants depend on the target drawn into: under
//    the HDR chain (Post.js) everything but the output pass goes into a float target (no tone
//    mapping, linear output), so a compile with no target bound binds a 1 x 1 float target. A
//    compile against the main scene builds its lit materials for both states of the sun's shadow
//    (by day with the shadow map, at night without); the unlit ones keep the program they are
//    first drawn with, whatever the lights do later, so they are built once, for the lights of
//    the start (their first draw is the stage pass's, below, with those lights). The modules' own
//    precompiles (terrain, buildings, vegetation, the PMREM generator) go through it unchanged;
//    the ones made before the start-up pass are made again in it (the environment map and the
//    sun's state are set by then: standard materials have other programs without them).
//  - compileAll(): the scene graph, hidden objects included (renderer.compile goes through them
//    all), a few objects at a time with the page drawing between the slices; the depth programs
//    the shadow pass draws the casters with (compileDepth: the customDepthMaterial, or a
//    MeshDepthMaterial, with the side, maps and alpha test that WebGLShadowMap.getDepthMaterial
//    gives them, into a target, without the scene's fog); and the stand-ins of what is not in the
//    scene yet or not drawn by it (module.warmup(w, camera): road chunks, street lamps, trees,
//    Post's and the clouds' passes ...; the ones in the scene's light, built with the real
//    meshes' attribute layouts, are handed to stage() as well).
//  - drawStage(): every kind of object of the scene and the staged stand-ins drawn once, one
//    primitive each, into a 1 x 1 target, a few at a time: on ANGLE / Direct3D 11 a program's
//    first draw with a vertex layout still compiles shaders (a converting vertex shader for the
//    integer attributes of roads, lamps and buildings, the point sprites' geometry shader), and
//    each buffer and texture has its first upload; the first frames would pay for all of that.
//  - finish(): with KHR_parallel_shader_compile the driver compiles and links on its own threads;
//    once a program is ready, three's first use of it (link status, uniform and attribute
//    locations) is done here, one program after another with the page drawing in between, so no
//    later frame pays for it. Without the extension the first use waits for the compile: still
//    one program at a time, the loading screen moving between them.
//  - check(): after a flight starts, a camera, time of day or quality change, the scene is
//    searched for materials (or kinds of object) not built yet; whatever is found is compiled at
//    once and logged (a miss of the start-up pass); prepare() does the same for the wingmen, a
//    few objects a frame, before they show.
//  - beforeDraw() / afterDraw(): every drawn frame. Before: when the sun starts or stops casting,
//    the scene's light state is set up again before the frame (three's shadow pass reads the state
//    of the frame before, and would build depth programs for it). After: the programs made by the
//    frame are logged. The log (late, lateCount; read by tests/e2e.mjs and tests/pc_check.py) has
//    three kinds of entry: 'drawn: ...' (a frame built a program: the stall this file is about),
//    'missed: ...' (check() found one) and 'compiled: ...' (a module's own compile or prepare(),
//    built outside the frames and finished in the background).
//
// warmUpApp(app) runs it all at start-up behind the loading screen: the environment's passes
// (compiled while the data loads: warmUpEarly), one environment update, the modules that build
// their materials over a few frames (the vegetation, the cockpit's interior) given their frames,
// compileAll, finish (and again for what such a module made meanwhile, if it was late), the stage
// pass, then a few real frames (the menu's view, the cockpit, the chase view, by day and by night,
// the menu's view again): the shadow maps' and Post's first frames at their size and whatever
// variant the passes did not foresee (the bounding spheres worked out by these frames are handed
// back after them: unworkedBounds); then a wait (a fence, polled once a frame) until the GPU has
// done them. info() has the time of each step and view.
//
// URL: ?warmup=0 turns it off (three builds each program when first drawn, as before).

import * as THREE from 'three';

/** WebGLShadowMap: the depth pass draws a material's back faces (its front faces when BackSide). */
const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

/** Does three wire the scene's lights into this material (WebGLRenderer's materialNeedsLights)? */
export function needsLights(m) {
  return !!m && (m.isMeshLambertMaterial || m.isMeshToonMaterial || m.isMeshPhongMaterial || m.isMeshStandardMaterial ||
    m.isShadowMaterial || (m.isShaderMaterial && m.lights === true));
}

/** The next animation frame (at most maxMs: frames stop in a background tab). */
export function nextFrame(maxMs = 50) {
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(go);
    setTimeout(go, maxMs);
  });
}

const drawable = (o) => o.isMesh || o.isPoints || o.isLine || o.isSprite;

/**
 * What of an object (besides its material) selects a program variant: the kind of object
 * (instanced, batched, skinned, points, lines) and the geometry's attributes that three looks at.
 */
function kindOf(o) {
  let k = o.isInstancedMesh ? 1 : o.isBatchedMesh ? 2 : o.isSkinnedMesh ? 3 : o.isPoints ? 4 : o.isLine ? 5 : o.isSprite ? 6 : 0;
  if (o.isInstancedMesh) k |= (o.instanceColor ? 8 : 0) | (o.morphTexture ? 16 : 0);
  if (o.isBatchedMesh && o._colorsTexture) k |= 8;
  const g = o.geometry;
  if (g && g.attributes) {
    const a = g.attributes, m = g.morphAttributes || {};
    if (a.position) k |= 32;
    if (a.normal) k |= 64;
    if (a.tangent) k |= 128;
    if (a.color) k |= a.color.itemSize === 4 ? 256 : 512;
    if (a.uv) k |= 1024;
    if (m.position) k |= 2048 + (Math.min(m.position.length, 255) << 16);
    if (m.normal) k |= 4096;
    if (m.color) k |= 8192;
  }
  return k;
}

/**
 * A stand-in for compiling: the object itself as the prototype (its kind, geometry, instance
 * colours ... read through it), with its own material and no children or parent. Never drawn or
 * added to the scene: renderer.compile only reads it.
 */
function proxyOf(o, material) {
  const p = Object.create(o);
  p.material = material;
  p.children = [];
  p.parent = null;
  return p;
}

const texChannel = (t) => (t ? t.channel | 0 : -1);

/** Objects per compile call in compileAll: up to twice as many programs (both shadow states). */
const SLICE_OBJECTS = 4;

/** Entries kept in the late list (lateCount counts them all). */
const LATE_MAX = 200;

/** Objects compiled per frame by prepare() (two or three materials). */
const PREPARE_OBJECTS = 2;

/** Stand-ins per draw call of the stage pass (renderer.render of the stage scene). */
const STAGE_OBJECTS = 6;

/**
 * What of a geometry selects a vertex layout on Direct3D (ANGLE builds a vertex shader per
 * layout a program is drawn with): each attribute's name, array type, size, normalisation,
 * half-float storage and whether it is per instance.
 */
function layoutOf(g) {
  if (!g || !g.attributes) return '';
  const parts = [];
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.attributes[name];
    const arr = a.isInterleavedBufferAttribute ? a.data.array : a.array;
    const inst = a.isInstancedBufferAttribute || (a.isInterleavedBufferAttribute && a.data.isInstancedInterleavedBuffer);
    parts.push(`${name}:${arr ? arr.constructor.name : '?'}${a.isFloat16BufferAttribute ? '/h' : ''}:${a.itemSize}:` +
      `${a.normalized ? 'n' : ''}${inst ? 'i' : ''}${a.gpuType != null ? a.gpuType : ''}`);
  }
  return parts.join(',');
}

const hasMorph = (g) => !!(g.morphAttributes && (g.morphAttributes.position || g.morphAttributes.normal || g.morphAttributes.color));
const O3D = THREE.Object3D.prototype;

/** A hook of the object called for its stand-in: an exception (a hook that did not expect one) does not stop the pass. */
function guarded(f) {
  return function (...a) { try { f.apply(this, a); } catch (e) { /* the stand-in's draw goes on */ } };
}

/**
 * A stand-in for the stage pass (ShaderWarmup.drawStage): the object itself as the prototype (its
 * kind, matrices, hooks, uniforms ... read through it) with its own material, no parent or
 * children, drawn whatever its own or its parents' visibility and never culled, and a geometry
 * of its own on the same buffers that draws one primitive (none if the buffers hold less: then
 * only the program, uniforms and textures are set up, as a draw of nothing does).
 */
function stageProxy(o, material, group) {
  const p = proxyOf(o, material);
  p.visible = true;
  p.frustumCulled = false;
  // three registers its dispose listeners through the stand-ins: on the objects themselves (an
  // object with no listener yet would get them on the stand-in, and its buffers would never be
  // freed when it is disposed)
  if (!Object.prototype.hasOwnProperty.call(o, '_listeners')) o._listeners = {};
  const g = o.geometry;
  if (g && g.isBufferGeometry && !hasMorph(g)) {
    // (a morphed geometry is drawn as it is: three keeps a morph texture per geometry object)
    if (!Object.prototype.hasOwnProperty.call(g, '_listeners')) g._listeners = {};
    const pg = Object.create(g);
    const pos = g.attributes.position;
    const cap = g.index ? g.index.count : pos ? pos.count : 0;
    const start = group ? group.start : 0;
    const per = o.isPoints ? 1 : o.isLine ? 2 : 3;
    pg.drawRange = { start, count: cap - start >= per ? per : 0 };
    if (g.isInstancedBufferGeometry) pg.instanceCount = 1;
    p.geometry = pg;
  }
  if (o.isInstancedMesh) p.count = Math.min(1, o.instanceMatrix ? o.instanceMatrix.count : 0);
  for (const k of ['onBeforeRender', 'onAfterRender', 'onBeforeShadow', 'onAfterShadow']) {
    if (typeof o[k] === 'function' && o[k] !== O3D[k]) p[k] = guarded(o[k]);
  }
  return p;
}

export class ShaderWarmup {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} [o]
   * @param {boolean} [o.hdr] the frame is drawn into float targets (Post.js), the canvas only gets the output pass
   * @param {boolean} [o.enabled]
   */
  constructor(renderer, { hdr = false, enabled = true } = {}) {
    this.renderer = renderer;
    this.hdr = hdr;
    this.enabled = enabled;
    this.scene = null;               // the main scene (its lights, fog and environment)
    this.lights = [];                // lights whose castShadow changes while the app runs (the sun / moon)
    this.done = false;               // the start-up pass is over: from now on new programs are misses
    this.busy = false;               // the start-up pass is running
    this.holding = false;            // check(..., {hold}) is finishing programs: the app may skip drawing
    this.late = [];                  // programs made after the start-up pass: { label, programs: [names], ms } (the last LATE_MAX)
    this.lateCount = 0;              // entries ever put in late (a reader that keeps its place counts from this)
    this.stats = { programs: 0, ms: 0, totalMs: 0, compileMs: 0, finishMs: 0, framesMs: 0, frames: 0, gpuMs: 0, gpuIdle: true,
      worstGapMs: 0, gapsOver100: 0, worstGapBy: {}, uploads: 0, uploadMB: 0, uploaded: [],
      frameMade: [], added: [], parallel: false, settled: [], bounds: 0,
      steps: {}, views: [], stage: { reps: 0, draws: 0, renders: 0, ms: 0, worstMs: 0, made: [] } };
    this._raw = null;                // renderer.compile as three has it
    this._inner = 0;                 // > 0 inside our own passes (the hook passes them on as they are)
    this._early = [];                // the modules' compiles before the start-up pass, made again in it
    this._rt = null;
    this._empty = new THREE.Group();
    this._group = new THREE.Group();
    this._off = [];
    this._seen = new WeakMap();      // material -> Map(kind -> version) of what has been compiled
    this._depthMats = new Map();     // depth stand-ins by variant (kept: a program dies with its last material)
    this._dummyTex = new Map();
    this._next = 0;                  // program ids below this were made before (afterDraw)
    this._bg = new Set();            // ids of programs built outside the frames since the last one (_background)
    this._later = null;              // mark of the programs waiting for _finishLater
    this._cast = -1;
    this._doneWait = null;           // { promise, resolve }: prepare() during the start-up pass waits for its end
    this._camera = null;             // the app's camera (warmUpApp), for stand-ins staged later
    this._staged = [];               // stage(): { list: [objects], resolve } waiting for the stage pass
    this._stageJob = null;           // the background stage pass after the start-up one
    this._stageScene = null;
    this._stageCam = null;
    this._stageWarned = false;
    this._earlyMark = null;          // warmUpEarly: the first program it made
  }

  /** Resolves when the start-up pass is over (at once if it is). */
  whenDone() {
    if (this.done || !this.enabled) return Promise.resolve();
    if (!this._doneWait) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      this._doneWait = { promise, resolve };
    }
    return this._doneWait.promise;
  }

  /** The start-up pass is over (warmUpApp): from now on a new program is logged in late. */
  _setDone() {
    this.busy = false;
    this.done = true;
    if (this._doneWait) { this._doneWait.resolve(); this._doneWait = null; }
  }

  /** Wraps renderer.compile (see the top of the file). */
  install() {
    const r = this.renderer;
    if (this._raw || !this.enabled || typeof r.compile !== 'function') return this;
    this._raw = r.compile.bind(r);
    this.stats.parallel = !!(r.extensions && r.extensions.has && r.extensions.has('KHR_parallel_shader_compile'));
    r.compile = (scene, camera, targetScene = null) => {
      if (this._inner) return this._raw(scene, camera, targetScene);
      if (!this.done && scene && scene.isScene) this._early.push({ root: scene, camera, scene: targetScene });
      if (!this.done) return this.compile(scene, camera, { scene: targetScene });
      // after the start-up pass: a module's own compile (a quality change, data that came late),
      // finished in the background; logged as compiled, not as a frame's (afterDraw)
      const t0 = performance.now(), mark = this.nextId();
      const mats = this.compile(scene, camera, { scene: targetScene });
      const made = this._background(mark);
      if (made.length) {
        this._log(`compiled: ${scene && scene.name ? scene.name : 'module'}`, made, performance.now() - t0);
        this._finishLater(mark);
      }
      return mats;
    };
    return this;
  }

  /**
   * The programs made since mark by a compile outside the frames: kept out of afterDraw's list
   * (they were built in the background, not by a frame drawing them). Returns their names.
   */
  _background(mark) {
    const out = [];
    for (const p of this.renderer.info.programs) {
      if (p.id < mark) continue;
      this._bg.add(p.id);
      out.push(p.name || p.type || '?');
    }
    return out;
  }

  /** An entry of the late list (see afterDraw for the three kinds of label), with a running count. */
  _log(label, programs, ms = 0) {
    this.late.push({ label, programs: programs.slice(), ms: +ms.toFixed(1) });
    this.lateCount++;
    if (this.late.length > LATE_MAX) this.late.splice(0, this.late.length - LATE_MAX);
    console.info(`warm-up: ${label}: ${programs.length} program(s): ${programs.join(', ')}`);
  }

  /** A module's compile after the start-up pass (a quality change, data that came late): its programs finished in the background. */
  _finishLater(mark) {
    if (this._later != null && this._later <= mark) return;
    const first = this._later == null;
    this._later = this._later == null ? mark : Math.min(this._later, mark);
    if (!first) return;
    nextFrame().then(() => { const m = this._later; this._later = null; return this.finish(m); }).catch(() => {});
  }

  /** The main scene and the lights whose shadow switches on and off (the sun, which is the moon at night). */
  setScene(scene, lights = []) {
    this.scene = scene;
    this.lights = lights.filter(Boolean);
  }

  /** A 1 x 1 half-float target: the class of every target the frame is drawn into (the shadow maps too). */
  floatTarget() {
    if (!this._rt) {
      this._rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
      this._rt.texture.name = 'warmup';
    }
    return this._rt;
  }

  /** The id the next program will get (a mark for programsSince). */
  nextId() {
    let id = -1;
    for (const p of this.renderer.info.programs) if (p.id > id) id = p.id;
    return id + 1;
  }

  /** Names of the programs made since nextId() returned mark. */
  programsSince(mark) {
    return this.renderer.info.programs.filter((p) => p.id >= mark).map((p) => p.name || p.type || '?');
  }

  /**
   * Compiles root's materials as they will be drawn: into target (default: the bound target, or,
   * with nothing bound, the float target under the HDR chain; null: the canvas), with the lights
   * and fog of scene (default: root itself, as renderer.compile), and against the main scene for
   * both states of the sun's shadow (lit materials only). Returns the materials, as
   * renderer.compile does.
   */
  compile(root, camera, { scene = null, target } = {}) {
    const r = this.renderer;
    if (!this._raw) return r.compile(root, camera, scene);
    const prev = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const want = target !== undefined ? target : (prev || (this.hdr ? this.floatTarget() : null));
    const bind = want !== prev;
    const t0 = performance.now();
    this._inner++;
    try {
      if (bind) r.setRenderTarget(want);
      const T = scene || root;
      if (this.scene && T === this.scene && this.lights.length && r.shadowMap.enabled) this._otherShadowState(root, camera, scene);
      const mats = this._raw(root, camera, scene);
      this.see(root);
      return mats;
    } finally {
      if (bind) r.setRenderTarget(prev, face, mip);
      this._inner--;
      this.stats.compileMs += performance.now() - t0;
    }
  }

  /**
   * The lit materials under root once more with the sun's shadow switched the other way (and the
   * unlit ones three builds again at every draw: transparent and double-sided, drawn in two passes).
   */
  _otherShadowState(root, camera, scene) {
    const off = this._off;
    off.length = 0;
    const want = (m) => needsLights(m) || (m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass);
    // three skips an object without a material: the others are left out for this compile
    root.traverse((o) => {
      const m = o.material;
      if (!m || !drawable(o)) return;
      if (Array.isArray(m) ? !m.some(want) : !want(m)) { off.push(o, m); o.material = null; }
    });
    for (const l of this.lights) l.castShadow = !l.castShadow;
    try {
      this._raw(root, camera, scene);
    } finally {
      for (const l of this.lights) l.castShadow = !l.castShadow;
      for (let i = 0; i < off.length; i += 2) off[i].material = off[i + 1];
      off.length = 0;
    }
  }

  /**
   * The programs three's shadow pass draws root's casters with (WebGLShadowMap): the object's
   * customDepthMaterial, or a MeshDepthMaterial, either with the side the pass sets (shadowSide, or
   * the other side of the material's), its map, alpha map, alpha test and displacement; drawn into
   * the shadow map (a target), with the main scene's lights and the sun casting (the pass runs only
   * then), and without a scene (no fog). Several casters with the same variant compile once.
   */
  compileDepth(root, camera) {
    const S = this.scene, r = this.renderer;
    if (!this._raw || !S || !this.lights.length || !r.shadowMap.enabled) return;
    const shared = [], custom = [], keys = new Set();
    const vsm = r.shadowMap.type === THREE.VSMShadowMap;
    root.traverse((o) => {
      if (!o.castShadow || !(o.isMesh || o.isLine || o.isPoints)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const kind = kindOf(o);
      for (const m of mats) {
        if (!m) continue;
        const side = m.shadowSide != null ? m.shadowSide : vsm ? m.side : SHADOW_SIDE[m.side];
        const alpha = m.alphaToCoverage === true || m.alphaTest > 0;
        const combo = `${side}|${texChannel(m.map)}|${texChannel(m.alphaMap)}|${alpha ? 1 : 0}|${m.displacementMap ? texChannel(m.displacementMap) : -1}`;
        const cd = o.customDepthMaterial;
        if (cd) {
          const key = `${cd.uuid}|${combo}|${kind}`;
          if (!keys.has(key)) { keys.add(key); custom.push(cd, m, side, proxyOf(o, cd)); }
        } else {
          const dm = this._depthMaterial(m, side, alpha, combo);
          const key = `${dm.uuid}|${kind}`;
          if (!keys.has(key)) { keys.add(key); shared.push(proxyOf(o, dm)); }
        }
      }
    });
    if (!shared.length && !custom.length) return;
    const fog = S.fog;
    const flip = this.lights.filter((l) => !l.castShadow);
    const prev = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const t0 = performance.now();
    const g = this._group;
    this._inner++;
    try {
      S.fog = null;
      for (const l of flip) l.castShadow = true;
      r.setRenderTarget(this.floatTarget());
      if (shared.length) { g.children = shared; this._raw(g, camera, S); }
      for (let i = 0; i < custom.length; i += 4) {
        // the pass sets these on the custom material before each draw: the same here
        const cd = custom[i], m = custom[i + 1];
        cd.side = custom[i + 2];
        cd.alphaMap = m.alphaMap;
        cd.alphaTest = m.alphaToCoverage === true ? 0.5 : m.alphaTest;
        cd.map = m.map;
        cd.displacementMap = m.displacementMap;
        cd.displacementScale = m.displacementScale;
        cd.displacementBias = m.displacementBias;
        g.children = [custom[i + 3]];
        this._raw(g, camera, S);
      }
    } finally {
      g.children = [];
      r.setRenderTarget(prev, face, mip);
      for (const l of flip) l.castShadow = false;
      S.fog = fog;
      this._inner--;
      this.stats.compileMs += performance.now() - t0;
    }
  }

  /** A MeshDepthMaterial standing in for three's own (shared, or cloned for a map with an alpha test). */
  _depthMaterial(m, side, alpha, combo) {
    let d = this._depthMats.get(combo);
    if (d) return d;
    d = new THREE.MeshDepthMaterial({ side });
    // only whether the maps are there (and on which uv channel) selects the program
    d.map = m.map ? this._dummy(m.map.channel) : null;
    d.alphaMap = m.alphaMap ? this._dummy(m.alphaMap.channel) : null;
    d.alphaTest = alpha ? 0.5 : 0;
    d.displacementMap = m.displacementMap ? this._dummy(m.displacementMap.channel) : null;
    this._depthMats.set(combo, d);
    return d;
  }

  _dummy(channel = 0) {
    let t = this._dummyTex.get(channel);
    if (!t) { t = new THREE.Texture(); t.channel = channel; this._dummyTex.set(channel, t); }
    return t;
  }

  /**
   * The Environment's own passes (js/env/Environment.js; drawn outside the scene, into its
   * targets): the sky-view LUT, the sky of the environment map, and the PMREM generator's
   * filters, which three makes on the first PMREM (made here without drawing).
   */
  compileEnvironment(env) {
    if (!env || !this._raw) return;
    // Neither Environment.js nor three's PMREMGenerator has a public way to build these, so this
    // reads their fields: one gone after a change there is reported (tests/e2e.mjs fails on any
    // 'warm-up:' warning) instead of the passes being built quietly at the first environment
    // update, behind the loading screen but one at a time.
    const p = env._pmrem;
    const need = [[env, '_lutScene'], [env, '_lutCamera'], [env, '_skyRT'], [env, '_envScene'], [env, '_cubeCamera'], [env, '_pmrem'],
      [p, '_boxMesh'], [p, '_cubeCamera'], [p, '_applyPMREM'], [p, '_renderCube']];
    const missing = need.filter(([o, k]) => !o || o[k] == null).map(([o, k]) => (o === env ? 'Environment.' : 'PMREMGenerator.') + k);
    if (p && !('_ggxMaterial' in p)) missing.push('PMREMGenerator._ggxMaterial');
    if (missing.length) console.warn(`warm-up: environment: no ${missing.join(', ')} (Environment.js or three's PMREMGenerator changed)`);
    try {
      if (env._lutScene && env._lutCamera) this.compile(env._lutScene, env._lutCamera, { target: env._skyRT || this.floatTarget() });
      if (env._envScene && env._cubeCamera) this.compile(env._envScene, env._cubeCamera.children[0], { target: this.floatTarget() });
      if (p && p._boxMesh && p._cubeCamera) {
        if (p._ggxMaterial === null && typeof p._applyPMREM === 'function') {
          const src = p._sourceTarget;
          p._renderCube = () => {};          // (an own property over the class's: deleted below)
          if (!src) p._sourceTarget = { texture: null };
          try { p._applyPMREM({ texture: { mipmaps: [null] } }); } finally { delete p._renderCube; if (!src) p._sourceTarget = src; }
        }
        // (the generator draws them on its box mesh, with its cube camera, into float targets)
        const box = p._boxMesh, keep = box.material;
        for (const m of [p._cubemapMaterial, p._ggxMaterial, p._integrationMaterial]) {
          if (!m) continue;
          box.material = m;
          this.compile(box, p._cubeCamera.children[0], { target: this.floatTarget() });
        }
        box.material = keep;
      }
    } catch (e) {
      console.warn('warm-up: environment', e);
    }
  }

  /**
   * Everything (the start-up pass): the scene graph, hidden objects included; the shadow pass's
   * depth programs; the modules' stand-ins (module.warmup(w, camera)) and the compiles the
   * modules made before. In slices, the page drawing a frame after each one of about sliceMs:
   * building a hundred programs' sources is a few hundred ms of script on the PC (more in
   * SwiftShader), and the loading screen should keep moving. The scene's objects go in as
   * stand-ins against the whole scene's lights (as in compileUnseen; a part of the graph
   * compiled on its own would miss the lights in the rest), a few at a time, one per material
   * and kind of object (another object of the same pair would only look its program up).
   */
  async compileAll(camera, modules = [], { sliceMs = 30, onProgress = null } = {}) {
    const S = this.scene;
    if (!S || !this._raw) return;
    let t = performance.now();
    const pause = async () => {
      if (performance.now() - t < sliceMs) return;
      await nextFrame();
      t = performance.now();
    };
    const reps = [], pairs = new Map();
    S.traverse((o) => {
      if (!drawable(o) || !o.material) return;
      const k = kindOf(o);
      let fresh = false;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        let s = pairs.get(m);
        if (!s) pairs.set(m, (s = new Set()));
        if (!s.has(k)) { s.add(k); fresh = true; }
      }
      if (fresh) reps.push(o);
    });
    const g = this._slice || (this._slice = new THREE.Group());
    for (let i = 0; i < reps.length; i += SLICE_OBJECTS) {
      g.children = reps.slice(i, i + SLICE_OBJECTS).map((o) => proxyOf(o, o.material));
      try { this.compile(g, camera, { scene: S }); } finally { g.children = []; }
      onProgress?.(Math.min(1, (i + SLICE_OBJECTS) / reps.length));
      await pause();
    }
    this.compileDepth(S, camera);
    for (const m of modules) {
      if (!m || typeof m.warmup !== 'function') continue;
      await pause();
      try { m.warmup(this, camera); } catch (e) { console.warn(`warm-up: ${m.name || m.constructor?.name}`, e); }
    }
    // (a module's compile while this waits for a frame is made right away, the environment set)
    for (const c of this._early.splice(0)) {
      await pause();
      try { this.compile(c.root, c.camera, { scene: c.scene }); } catch (e) { console.warn('warm-up: precompile', e); }
    }
    this._early.length = 0;
    this.restoreLights(camera);
  }

  /** The main scene's light state as the lights are now (three's shadow pass reads it before the frame sets it up). */
  restoreLights(camera) {
    if (!this.scene || !this._raw) return;
    this._inner++;
    try { this._raw(this._empty, camera, this.scene); } finally { this._inner--; }
    this._cast = this._castMask();
  }

  _castMask() {
    let m = 0;
    for (let i = 0; i < this.lights.length; i++) if (this.lights[i].castShadow) m |= 1 << i;
    return m;
  }

  /**
   * Stand-ins of what streams in later (a module's road chunk, street lamps, a building tile ...,
   * built with the real meshes' attribute layouts), to be drawn once by the stage pass (drawStage)
   * as the main scene draws them: renderer.compile builds a program, but on ANGLE / Direct3D 11
   * the first draw of a program with a vertex layout still compiles a vertex shader for that
   * layout (an integer attribute read as a float has no Direct3D format and is converted in a
   * shader of its own), synchronously, in whatever frame first draws it. Call after the module's
   * compile; resolves (true) once they have been drawn, after which the caller may dispose them
   * (false: not drawn, no warm-up). After the start-up pass they are drawn in the background, a
   * few a frame, once their programs are finished.
   */
  stage(root, { scene = null } = {}) {
    const S = this.scene;
    if (!this._raw || !S || (scene && scene !== S)) return Promise.resolve(false);
    const list = [];
    root.traverse((o) => { if (drawable(o) && o.material) list.push(o); });
    if (!list.length) return Promise.resolve(false);
    return new Promise((resolve) => {
      this._staged.push({ list, resolve });
      if (this.done) this._stageLater();
    });
  }

  /** stage() after the start-up pass: finished, then drawn (a frame each few), in the background. */
  _stageLater() {
    if (this._stageJob || !this._camera) return;
    this._stageJob = (async () => {
      try {
        while (this._staged.length) {
          await nextFrame();
          await this.finish(0);           // (programs finished before cost nothing here)
          await this.drawStage(this._camera, { scene: false });
        }
      } catch (e) {
        console.warn('warm-up: stage', e);
      } finally {
        this._stageJob = null;
        for (const s of this._staged.splice(0)) s.resolve(false);
      }
    })();
  }

  /**
   * The stage pass: every kind of object of the main scene (hidden ones too) and the staged
   * stand-ins drawn once, as the frame will draw them, into the 1 x 1 float target: with the main
   * scene's lights, fog and environment, its shadow pass (the casters' depth programs, into a
   * 1 x 1 shadow map of the stage's own), one primitive of the real buffers each (a degenerate
   * triangle or a point: nothing shows, but the driver sets up everything a draw needs), a few
   * objects at a time with the page drawing between the slices. Once with the lights as they are,
   * then the lit materials once more with the sun's shadow the other way (its other program).
   *
   * Why draw and not only compile: on ANGLE / Direct3D 11 a program's first draw with a vertex
   * layout builds the vertex shader for that layout (and the pixel shader for the target's
   * formats); the roads, street lamps and buildings read integer attributes as floats, which
   * Direct3D cannot convert in its input assembler, so they get a converting shader of their own,
   * compiled synchronously at that draw: before, the first frames that showed them paid for it.
   * A draw also leaves each material as three leaves a drawn one: an unlit material keeps the
   * program it was first drawn with whatever the lights do later, as it does without the warm-up
   * (built by day, drawn first at dusk, it would otherwise be built again for the night's lights).
   * And the first use of each geometry's buffers (their upload) is spread over these slices.
   * One object per program, kind of object and vertex layout: another would draw the same way.
   */
  async drawStage(camera, { scene = true, sliceMs = 12, onProgress = null } = {}) {
    const S = this.scene, r = this.renderer;
    if (!S || !this._raw) return 0;
    const staged = this._staged.splice(0);
    const objs = [];
    if (scene) S.traverse((o) => { if (drawable(o) && o.material) objs.push(o); });
    for (const s of staged) objs.push(...s.list);
    const reps = this._stageReps(objs);
    const st = this.stats.stage;
    st.reps += reps.length;
    const lights = this._stageLights(camera);
    const cam = this._stageCamera(camera);
    const stage = this._stageScene || (this._stageScene = new THREE.Scene());
    stage.matrixWorldAutoUpdate = false;     // (the stand-ins share their objects' matrices: left as they are)
    stage.fog = S.fog;
    stage.environment = S.environment;
    stage.environmentIntensity = S.environmentIntensity;
    if (S.environmentRotation) stage.environmentRotation.copy(S.environmentRotation);
    const prev = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const sort = r.sortObjects, sm = r.shadowMap;
    const mark = this.nextId(), t0 = performance.now();
    // pass 0: the lights as they are; pass 1: the sun's shadow switched, the lit materials only
    const passes = this.lights.length && sm.enabled ? 2 : 1;
    const total = reps.length + (passes > 1 ? reps.filter((x) => x.twice).length : 0);
    let t = t0, n = 0;
    const render = (list) => {
      const hidden = [];
      for (const p of list) if (p.material.visible === false) { hidden.push(p.material); p.material.visible = true; }
      stage.children = lights.length ? lights.map((l) => l.proxy).concat(list) : list;
      const needs = sm.needsUpdate, t1 = performance.now();
      this._inner++;
      try {
        r.sortObjects = false;            // (no bounding spheres worked out for the stand-ins)
        sm.needsUpdate = true;            // (the shadow pass also where the app updates it by hand)
        r.setRenderTarget(this.floatTarget());
        r.render(stage, cam);
        st.renders++;
        st.draws += list.length;
      } catch (e) {
        if (!this._stageWarned) { this._stageWarned = true; console.warn('warm-up: stage draw', e); }
      } finally {
        this._inner--;
        sm.needsUpdate = needs;
        r.sortObjects = sort;
        r.setRenderTarget(prev, face, mip);
        for (const m of hidden) m.visible = false;
        stage.children = [];
        const ms = performance.now() - t1;
        if (ms > st.worstMs) st.worstMs = Math.round(ms);
      }
    };
    try {
      for (let pass = 0; pass < passes; pass++) {
        for (const l of lights) l.proxy.castShadow = pass && l.flip ? !l.light.castShadow : l.light.castShadow;
        const list = pass ? reps.filter((x) => x.twice) : reps;
        if (!list.length) continue;
        // the lights alone first: three's shadow pass reads the light state of the scene's
        // previous draw (see beforeDraw), so the depth programs get the right one
        render([]);
        for (let i = 0; i < list.length; i += STAGE_OBJECTS) {
          render(list.slice(i, i + STAGE_OBJECTS).map((x) => stageProxy(x.o, x.m, x.group)));
          n += Math.min(STAGE_OBJECTS, list.length - i);
          onProgress?.(Math.min(1, n / Math.max(1, total)));
          if (performance.now() - t > sliceMs) { await nextFrame(); t = performance.now(); }
        }
      }
    } finally {
      for (const l of lights) l.proxy.shadow?.dispose?.();
      stage.fog = null;
      stage.environment = null;
      st.ms += performance.now() - t0;
      const made = this.programsSince(mark);
      if (made.length) st.made.push(...made);
      for (const s of staged) s.resolve(true);
    }
    return reps.length;
  }

  /**
   * One stand-in per program (as compiled for the lights of now), kind of object, vertex layout
   * and depth material (and one per group of a multi-material mesh). twice: drawn again in the
   * other shadow state: lit, or transparent and double-sided (see _otherShadowState), or a caster
   * (its depth program's draw: the shadow pass runs only while the sun casts).
   */
  _stageReps(objs) {
    const props = this.renderer.properties, keys = new Set(), reps = [];
    const add = (o, m, group) => {
      // left to the frames: three would give the stage a transmission target of its own, and a
      // wireframe index to its stand-in geometry; a batched mesh draws all of its ranges
      if (!m || m.transmission > 0 || m.wireframe || o.isBatchedMesh) return;
      const prog = props.get(m).currentProgram;
      const key = `${prog ? prog.id : m.uuid}|${kindOf(o)}|${layoutOf(o.geometry)}|` +
        `${o.castShadow ? (o.customDepthMaterial ? o.customDepthMaterial.uuid : 'cast') : ''}`;
      if (keys.has(key)) return;
      keys.add(key);
      reps.push({ o, m, group, twice: needsLights(m) || (m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass) || !!o.castShadow });
    };
    for (const o of objs) {
      if (Array.isArray(o.material)) {
        const groups = o.geometry && o.geometry.groups;
        if (groups) for (const g of groups) add(o, o.material[g.materialIndex], g);
      } else add(o, o.material, null);
    }
    return reps;
  }

  /**
   * The main scene's lights for the stage (as the frame's shadow pass and light set-up find them:
   * visible, on the camera's layers): stand-ins with their own castShadow (the stage switches the
   * sun's) and, for a light with a shadow, a shadow of their own with a 1 x 1 map (the real map is
   * not touched; its size is no part of any program).
   */
  _stageLights(camera) {
    const out = [];
    const walk = (o) => {
      if (o.visible === false) return;
      if (o.isLight && o.layers.test(camera.layers)) {
        const p = Object.create(o);
        p.children = [];
        p.parent = null;
        p.castShadow = o.castShadow;
        if (o.shadow && typeof o.shadow.clone === 'function') {
          p.shadow = o.shadow.clone();
          p.shadow.mapSize.set(1, 1);
          p.shadow.autoUpdate = true;
        }
        out.push({ light: o, proxy: p, flip: this.lights.includes(o) });
      }
      for (const c of o.children) walk(c);
    };
    walk(this.scene);
    return out;
  }

  /** The app camera's view and projection, on every layer (a stand-in on another layer is drawn too). */
  _stageCamera(camera) {
    const c = this._stageCam || (this._stageCam = new THREE.PerspectiveCamera());
    // (the lens too: with a reversed depth buffer three remakes a camera's projection at its first use)
    for (const k of ['fov', 'aspect', 'near', 'far', 'zoom', 'focus', 'filmGauge', 'filmOffset']) if (typeof camera[k] === 'number') c[k] = camera[k];
    c.matrixWorldAutoUpdate = false;
    c.matrixWorld.copy(camera.matrixWorld);
    c.matrixWorldInverse.copy(camera.matrixWorldInverse);
    c.projectionMatrix.copy(camera.projectionMatrix);
    c.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    c.layers.enableAll();
    return c;
  }

  /** Marks root's (object kind, material, version) as compiled (every compile does: check() looks for the rest). */
  see(root) {
    root.traverse((o) => {
      if (!drawable(o) || !o.material) return;
      const k = kindOf(o);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) this._mark(m, k);
    });
  }

  _mark(m, k) {
    let s = this._seen.get(m);
    if (!s) { s = new Map(); this._seen.set(m, s); }
    s.set(k, this._version(m));
  }

  // a transparent double-sided material is drawn in two passes, each changing its version: not a change
  _version(m) { return m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass ? -1 : m.version; }

  _unseen(o) {
    const k = kindOf(o);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      const s = this._seen.get(m);
      if (!s || s.get(k) !== this._version(m)) return true;
    }
    return false;
  }

  /**
   * After a flight starts, a camera, time or quality change, the wingmen loading: compiles what in
   * the scene was not compiled yet (logged as a miss of the start-up pass) and finishes it in the
   * background. hold: this.holding stays true until it is finished (the app skips drawing then).
   * Returns the number of programs made.
   */
  check(label, camera, { hold = false } = {}) {
    if (!this.done || !this.scene || !this._raw) return 0;
    const t0 = performance.now(), mark = this.nextId();
    const made = this.compileUnseen(camera);
    if (made.length) {
      // (compiled here, outside the frames: afterDraw does not list them again)
      this._background(mark);
      this._log(`missed: ${label}`, made, performance.now() - t0);
      if (hold) this.holding = true;
      this.finish(mark).finally(() => { if (hold) this.holding = false; });
    }
    return made.length;
  }

  /** Compiles (with their depth programs) the scene's objects whose material or kind was not compiled yet; returns the names of the programs made. */
  compileUnseen(camera) {
    return this._compileObjects(this._unseenObjects(), camera);
  }

  _unseenObjects() {
    const fresh = [];
    this.scene.traverse((o) => { if (drawable(o) && o.material && this._unseen(o)) fresh.push(o); });
    return fresh;
  }

  /** Compiles these objects of the main scene (stand-ins, against the whole scene's lights) and their depth programs. */
  _compileObjects(list, camera) {
    if (!list.length) return [];
    const mark = this.nextId();
    const g = new THREE.Group();
    g.children = list.map((o) => proxyOf(o, o.material));
    try {
      this.compile(g, camera, { scene: this.scene });
      this.compileDepth(g, camera);
    } finally {
      g.children = [];
      for (const o of list) {
        const k = kindOf(o);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) this._mark(m, k);
      }
      this.restoreLights(camera);
    }
    return this.programsSince(mark);
  }

  /**
   * What came into the scene that was not built yet (the wingmen when they load, kept hidden
   * until this resolves): compiled a few objects per frame (building a program's source is script
   * time: eleven of them in one task were a long frame), then finished. During the start-up pass
   * it waits for its end first (whose last step builds what came meanwhile). Logged as compiled
   * (not a miss: these could not be built before they loaded). Returns the number of programs.
   */
  async prepare(label, camera) {
    await this.whenDone();
    if (!this.scene || !this._raw) return 0;
    const t0 = performance.now(), first = this.nextId(), made = [];
    const fresh = this._unseenObjects();
    for (let i = 0; i < fresh.length; i += PREPARE_OBJECTS) {
      if (i) await nextFrame();
      const mark = this.nextId();
      this._compileObjects(fresh.slice(i, i + PREPARE_OBJECTS).filter((o) => this._unseen(o)), camera);
      made.push(...this._background(mark));
    }
    if (!made.length) return 0;
    this._log(`compiled: ${label}`, made, performance.now() - t0);
    await this.finish(first);
    return made.length;
  }

  /**
   * Finishes the programs made since mark: waits for the driver where it compiles in parallel, then
   * does three's first use of each (it reads the link status and the uniform locations; without
   * KHR_parallel_shader_compile it waits for the compile), one at a time, letting the page draw a
   * frame whenever ~12 ms have gone. onProgress(fraction, done, total).
   */
  async finish(mark, onProgress = null, timeoutMs = 30000) {
    const list = this.renderer.info.programs.filter((p) => p.id >= mark);
    const N = list.length;
    if (!N) { onProgress?.(1, 0, 0); return 0; }
    const t0 = performance.now();
    let slice = t0, n = 0;
    const pending = list.slice();
    while (pending.length) {
      let progressed = false;
      for (let i = 0; i < pending.length;) {
        const p = pending[i];
        if (!p.program) { pending.splice(i, 1); n++; continue; }          // freed meanwhile
        if (!p.isReady() && performance.now() - t0 < timeoutMs) { i++; continue; }
        p.getUniforms();
        pending.splice(i, 1);
        n++;
        progressed = true;
        onProgress?.(n / N, n, N);
        if (performance.now() - slice > 12) { await nextFrame(); slice = performance.now(); }
      }
      if (pending.length && !progressed) { await new Promise((res) => setTimeout(res, 8)); slice = performance.now(); }
    }
    this.stats.finishMs += performance.now() - t0;
    return N;
  }

  /**
   * Uploads the textures of root's materials that are not on the GPU yet, as their first draw would
   * (renderer.initTexture), a few per frame: a big upload is a stall of its own, and the views
   * drawn at start-up do not show everything (the cockpit by night, the gear bays ...).
   */
  async uploadTextures(root, sliceMs = 12) {
    const list = this._pendingTextures(root);
    let t = performance.now();
    for (const tex of list) {
      const img = tex.image;
      try { this.renderer.initTexture(tex); } catch (e) { continue; }
      const w = img.width || 0, h = img.height || 0, d = img.depth || 1;
      this.stats.uploads++;
      this.stats.uploadMB += (w * h * d * 4) / 1048576;
      if (this.stats.uploaded.length < 64) this.stats.uploaded.push(`${tex.name || tex.constructor.name} ${w}x${h}${d > 1 ? `x${d}` : ''}`);
      if (performance.now() - t > sliceMs) { await nextFrame(); t = performance.now(); }
    }
    return list.length;
  }

  _pendingTextures(root) {
    const out = [], seen = new Set(), props = this.renderer.properties;
    const add = (t) => {
      if (!t || !t.isTexture || seen.has(t)) return;
      seen.add(t);
      // (render targets' textures and videos are not uploaded; version 0: no image yet)
      if (t.isRenderTargetTexture || t.isVideoTexture || t.isExternalTexture || !(t.version > 0)) return;
      if (!t.image || t.image.complete === false || props.get(t).__version === t.version) return;
      out.push(t);
    };
    root.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        for (const k in m) { const v = m[k]; if (v && v.isTexture) add(v); }
        const u = m.uniforms;
        if (u) {
          for (const k in u) {
            const v = u[k] && u[k].value;
            if (Array.isArray(v)) for (const x of v) add(x);
            else add(v);
          }
        }
      }
    });
    return out;
  }

  /** Every drawn frame, before the scene is drawn: see the top of the file. */
  beforeDraw(camera) {
    if (!this.scene || !this._raw || !this.lights.length) return;
    if (this._castMask() !== this._cast) this.restoreLights(camera);
  }

  /**
   * Every drawn frame, after it: the programs it made. After the start-up pass they go in late
   * as 'drawn: <state> <camera> <time>': a frame that built a program (the stall this file is
   * about). The other two kinds of entry: 'missed: <event>' (check() found something unbuilt
   * when a flight started, the camera, time or quality changed: compiled at once), and
   * 'compiled: <what>' (built outside the frames and finished in the background: a module's own
   * compile, prepare() for the wingmen), which no frame waits for.
   */
  afterDraw(app) {
    const P = this.renderer.info.programs;
    let made = null, last = this._next - 1;
    for (const p of P) {
      if (p.id > last) last = p.id;
      if (p.id < this._next || this._bg.has(p.id)) continue;
      (made || (made = [])).push(p.name || p.type || '?');
    }
    this._next = last + 1;
    this._bg.clear();
    if (!made) return;
    if (!this.done) { this.stats.frameMade.push(...made); return; }
    const label = app ? `${app.state} ${app.cams?.mode || ''} ${app.settings ? app.settings.time.toFixed(2) + ' h' : ''}`.trim() : 'frame';
    this._log(`drawn: ${label}`, made);
  }

  /** A summary for the tests and the bench (no references into the renderer). */
  info() {
    const s = this.stats;
    return {
      enabled: this.enabled, done: this.done, parallel: s.parallel, programs: s.programs, ms: Math.round(s.ms), totalMs: Math.round(s.totalMs),
      compileMs: Math.round(s.compileMs), finishMs: Math.round(s.finishMs), framesMs: Math.round(s.framesMs), frames: s.frames,
      gpuMs: Math.round(s.gpuMs), gpuIdle: s.gpuIdle, worstGapMs: Math.round(s.worstGapMs), gapsOver100: s.gapsOver100, worstGapBy: { ...s.worstGapBy },
      bounds: s.bounds,
      uploads: s.uploads, uploadMB: +s.uploadMB.toFixed(1), uploaded: s.uploaded.slice(),
      frameMade: s.frameMade.slice(), added: s.added.slice(), settled: s.settled.slice(),
      steps: { ...s.steps }, views: s.views.map((v) => ({ ...v })), stage: { ...s.stage, made: s.stage.made.slice() },
      lateCount: this.lateCount, late: this.late.map((l) => ({ ...l, programs: l.programs.slice() })),
    };
  }

  dispose() {
    if (this._raw) { this.renderer.compile = this._raw; this._raw = null; }
    this._rt?.dispose();
    for (const d of this._depthMats.values()) d.dispose();
    this._depthMats.clear();
  }
}

// ----------------------------------------------------------------------------------------------
// the start-up pass of the app (main.js)

/** At most this long for the modules that build their materials over a few frames (behind the loading screen). */
const SETTLE_MS = 12000;

/**
 * The passes that need none of the data (the environment's and Post's), compiled as soon as they
 * exist: main.js calls this before the terrain and the aircraft load, so with
 * KHR_parallel_shader_compile the driver builds them on its own threads while the data comes in
 * (warmUpApp finishes them with the rest). Their variants are the frame's already: the tone
 * mapping is set when the Environment is made, the passes draw into targets of their own (Post's
 * output pass into the canvas, without tone mapping) and no setting changes their defines.
 */
export function warmUpEarly(app) {
  const w = app.warmup;
  if (!w || !w.enabled || !w._raw || w.done || w._earlyMark != null) return;
  const t0 = performance.now();
  w._earlyMark = w.nextId();
  try {
    w.compileEnvironment(app.env);
    app.post?.warmup?.(w);
  } catch (e) {
    console.warn('warm-up: early', e);
  }
  w.stats.steps.early = Math.round(performance.now() - t0);
}

/**
 * The whole start-up pass, behind the loading screen (main.js calls it after toMenu()): see the
 * top of the file. progress(fraction, label) for the loading screen. The time of each step is in
 * info().steps, of each view drawn in info().views.
 */
export async function warmUpApp(app, { progress = null } = {}) {
  const w = app.warmup;
  if (!w || !w.enabled || !w.scene) { w?._setDone(); return; }
  const cam = app.camera;
  const t0 = performance.now();
  const say = (f, label) => { try { progress?.(f, label); } catch (e) { /* the page is going away */ } };
  const gaps = frameGaps();
  const steps = w.stats.steps;
  let current = null, since = t0;
  const step = (name) => {
    const now = performance.now();
    if (current) steps[current] = Math.round((steps[current] || 0) + now - since);
    current = name;
    since = now;
    if (name) gaps.at(name);
  };
  w.busy = true;
  w._camera = cam;
  const early = w._earlyMark;
  const mark = early != null ? early : w.nextId();
  try {
    // 1. the environment's passes (made while the data loaded: warmUpEarly), finished, then one
    // update of it: scene.environment, the sun and the shadow casters as the first frame will have them
    say(0.02, 'sky');
    step('sky');
    if (early == null) w.compileEnvironment(app.env);
    await w.finish(mark);
    app.env.update(cam, 0);
    // 2. the modules that make their materials over a few frames: update-only frames for them
    say(0.06, 'vegetation, cockpit');
    step('settle');
    w.stats.settled = await settle(app, SETTLE_MS);
    // 3. everything else, compiled (in parallel where the browser can)
    say(0.1, 'preparing');
    step('compile');
    const t1 = performance.now();
    await w.compileAll(cam, [app.post, ...app.modules], { onProgress: (f) => say(0.1 + 0.2 * f, 'preparing') });
    // the cockpit's own shadow pass (js/aircraft/pcd/shadow.js), drawn without the scene's lights
    app.cockpit?.shadow?.precompile?.(w);
    const total = app.renderer.info.programs.filter((p) => p.id >= mark).length;
    say(0.3, `${total} programs`);
    step('finish');
    // (all of them: the ones the modules made while their data loaded, the terrain's, too)
    await w.finish(0, (f, n, N) => say(0.3 + 0.45 * f, `${n} / ${N}`));
    w.stats.ms = performance.now() - t1;
    // the textures of what the views below do not show
    say(0.75, 'textures');
    step('textures');
    await w.uploadTextures(w.scene);
    // what a module made meanwhile (a pass that had not settled in time, as the cockpit's interior
    // patching the jet's materials on a slow machine): built and finished like the rest, not by
    // the frames below, which would build them one at a time on the main thread
    step('added');
    const m1 = w.nextId();
    w.stats.added.push(...w.compileUnseen(cam));
    if (w.nextId() > m1) await w.finish(m1);
    // 4. one draw of every kind of thing in the scene and of the modules' stand-ins, a few at a
    // time into a 1 x 1 target: the first use of each program with its vertex layout, of each
    // buffer and texture (drawStage)
    say(0.78, 'first draws');
    step('stage');
    await w.drawStage(cam, { onProgress: (f) => say(0.78 + 0.08 * f, 'first draws') });
    // 5. real frames behind the loading screen, and the GPU's work on them
    say(0.86, 'first frames');
    step('frames');
    const t2 = performance.now();
    w._next = w.nextId();
    await drawViews(app, w, (f) => say(0.86 + 0.1 * f, 'first frames'));
    w.stats.framesMs = performance.now() - t2;
    say(0.96, 'GPU');
    step('gpu');
    const t3 = performance.now();
    w.stats.gpuIdle = await gpuDone(app.renderer, GPU_WAIT_MS);
    w.stats.gpuMs = performance.now() - t3;
  } catch (e) {
    console.warn('warm-up:', e);
  }
  // what came into the scene during the pass (an object a module added late, the wingmen if they
  // loaded meanwhile): built and finished before the menu shows
  try {
    step('added');
    const m2 = w.nextId();
    const added = w.compileUnseen(cam);
    w.stats.added.push(...added);
    if (added.length) await w.finish(m2);
  } catch (e) {
    console.warn('warm-up:', e);
  } finally {
    step(null);
    w.stats.programs = app.renderer.info.programs.filter((p) => p.id >= mark).length;
    w._early.length = 0;        // (a module's compile late in the pass was made as it came)
    w._next = w.nextId();
    w.restoreLights(cam);
    w._setDone();
    // (stand-ins a module staged after the stage pass: drawn in the background)
    if (w._staged.length) w._stageLater();
  }
  say(1, 'ready');
  const s = w.stats, st = s.stage;
  s.totalMs = performance.now() - t0;
  Object.assign(s, gaps.stop());
  const list = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');
  console.info(`warm-up: ${s.programs} programs in ${(s.totalMs / 1000).toFixed(1)} s ` +
    `(compile calls ${s.compileMs.toFixed(0)} ms, finishing ${s.finishMs.toFixed(0)} ms, ${s.uploads} textures uploaded ` +
    `(${s.uploadMB.toFixed(1)} MB), stage ${st.draws} stand-ins in ${st.renders} draws ${st.ms.toFixed(0)} ms, ` +
    `${s.frames} frames ${s.framesMs.toFixed(0)} ms (${s.views.map((v) => `${v.view} ${v.ms}`).join(', ')}), ` +
    `GPU ${s.gpuMs.toFixed(0)} ms${s.gpuIdle ? '' : ' (still busy)'}${s.parallel ? ', in parallel' : ''}; ` +
    `steps ms: ${list(s.steps)}; the loading screen's longest frame ${s.worstGapMs.toFixed(0)} ms, ${s.gapsOver100} over 100 ms: ` +
    `${list(s.worstGapBy)})` +
    `${s.frameMade.length ? `; made by the frames: ${s.frameMade.join(', ')}` : ''}` +
    `${st.made.length ? `; made by the stage pass: ${st.made.join(', ')}` : ''}` +
    `${s.added.length ? `; added during the pass: ${s.added.join(', ')}` : ''}${s.settled.length ? `; not settled: ${s.settled.join(', ')}` : ''}`);
}

/**
 * Watches the page's animation frames until stop(): the longest gap between two (the loading
 * screen's worst frame: script that ran that long kept it from moving), how many were over
 * 100 ms, and the longest in each step of the pass (at(step) names the step; a gap that spans
 * two steps is counted as "a>b").
 */
function frameGaps() {
  let last = performance.now(), worst = 0, over = 0, on = true, step = 'start', from = step;
  const by = {};
  const note = (d) => {
    if (d > worst) worst = d;
    if (d > 100) over++;
    const k = from === step ? step : `${from}>${step}`;
    if (!(by[k] >= d)) by[k] = Math.round(d);
    from = step;
  };
  // (performance.now(), not the frame's time stamp: that is when the frame began, which on a
  // loaded machine can be long before this runs)
  const f = () => {
    const now = performance.now();
    note(now - last);
    last = now;
    if (on) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
  return {
    at(name) { step = name; },
    stop() {
      on = false;
      note(performance.now() - last);           // the stretch since the last frame counts too
      return { worstGapMs: worst, gapsOver100: over, worstGapBy: by };
    },
  };
}

/** Update-only frames until the modules that build their materials over frames are done (or maxMs). */
async function settle(app, maxMs) {
  const t0 = performance.now();
  const f = app.input.update(0);
  let waiting = [];
  for (;;) {
    waiting = [];
    // the cockpit's interior patches the jet's materials when its analysis comes back (ready, failed or not)
    const ck = app.cockpit;
    if (ck && ck.enabled && ck.interior && !ck.interior.ready && !ck.interior.disposed) waiting.push('cockpit interior');
    for (const m of app.modules) if (m.ready === false && m.enabled !== false && !m.failed) waiting.push(m.name || m.constructor?.name || 'module');
    if (!waiting.length || performance.now() - t0 > maxMs) break;
    app._render(1 / 60, f, 1, false);
    await nextFrame();
  }
  return waiting;
}

/**
 * A few frames drawn behind the loading screen, one per view: the menu's view, the cockpit and the
 * chase view, the same two by the other light (by night if the start is by day, at noon if it is
 * by night: street lamps, building windows, the moon's or no shadow), then the menu's view again
 * at its own time. They make what the stage pass could not (the shadow maps and Post's targets at
 * their size, the textures the stage left to them) and whatever variant the passes did not
 * foresee; the work they queue is waited for (without blocking the page) before the menu. The
 * time of day and the camera are put back whatever happens, and the warm-up's own times are
 * never saved as the user's.
 */
async function drawViews(app, w, say) {
  const hours = app.settings.time, mode = app.cams.mode;
  const env = app.env;
  // by day: the sun above the horizon (a bright moon casts shadows too: not daylight)
  const day = env && env.sunDirection ? !env.lightIsMoon && env.sunDirection.y > 0 : true;
  const other = day ? 0.5 : 12;
  const views = [[null, 'orbit'], [null, 'cockpit'], [null, 'chase'], [other, 'chase'], [other, 'cockpit']];
  const f = app.input.update(0);
  const n = views.length + 1;
  let k = 0, bounds = null, failed = null;
  const draw = (view) => {
    const t = performance.now();
    app._render(1 / 60, f, 1, true);
    w.afterDraw(app);
    w.stats.frames++;
    w.stats.views.push({ view, h: +app.settings.time.toFixed(2), ms: Math.round(performance.now() - t) });
    say(++k / n);
  };
  try {
    for (const [h, view] of views) {
      if (h != null && app.settings.time !== h) app.setTimeOfDay(h, true, false);
      app.cams.setMode(view);
      app.cams.snap?.();
      draw(view);
      // (the menu's own view first: what it works out is what the menu's first frame would)
      if (!bounds) bounds = unworkedBounds(w.scene);
      await nextFrame();
    }
  } catch (e) {
    failed = e;
  }
  try {
    if (app.settings.time !== hours) app.setTimeOfDay(hours, true, false);
    app.cams.setMode(mode);
    app.cams.snap?.();
    if (!failed) draw(mode);
  } catch (e) {
    failed = failed || e;
  } finally {
    if (bounds) w.stats.bounds = bounds();
  }
  if (failed) throw failed;
}

/**
 * The bounding spheres not worked out yet (a geometry's, or an instanced, batched or skinned
 * mesh's own), to be handed back (null) after the warm-up's other views: three works one out at
 * an object's first draw (the frustum test, the order of the transparent draws), Post.js for the
 * near transparent things it keeps above the clouds, so each is worked out where and when the
 * object is first really drawn, as without the warm-up. That matters for a geometry rewritten in
 * place without a new sphere: the landing light's pool (js/aircraft/LandingPool.js) keeps the one
 * of its first draw, which would otherwise be the warm-up's night view at the menu's start point.
 * Returns the function that hands them back (it returns how many it did).
 */
function unworkedBounds(scene) {
  const list = [];
  scene.traverse((o) => {
    if (!drawable(o)) return;
    if (o.boundingSphere === null) list.push(o);
    if (o.geometry && o.geometry.boundingSphere === null) list.push(o.geometry);
  });
  return () => {
    let n = 0;
    for (const x of list) if (x.boundingSphere !== null) { x.boundingSphere = null; n++; }
    return n;
  };
}

/** At most this long for the GPU to work through the frames drawn behind the loading screen. */
const GPU_WAIT_MS = 15000;

/**
 * Waits until the GPU has done the work queued so far (a fence, polled once a frame: the page
 * keeps drawing), or maxMs. True if it has.
 */
async function gpuDone(renderer, maxMs) {
  const gl = renderer.getContext();
  if (typeof gl.fenceSync !== 'function') return true;
  const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!s) return true;
  gl.flush();
  const t0 = performance.now();
  try {
    for (;;) {
      await nextFrame();
      const st = gl.clientWaitSync(s, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) return true;
      if (st === gl.WAIT_FAILED || performance.now() - t0 > maxMs) return false;
    }
  } finally {
    gl.deleteSync(s);
  }
}
