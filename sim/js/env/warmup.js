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
//    first drawn with, whatever the lights do later, so they are built once (and made to keep the
//    compiled one: three would build them again at their first draw, see _keep). The modules' own
//    precompiles (terrain, buildings, vegetation, the PMREM generator) go through it unchanged;
//    the ones made before the start-up pass are made again in it (the environment map and the
//    sun's state are set by then: standard materials have other programs without them).
//  - compileAll(): the scene graph, hidden objects included (renderer.compile goes through them
//    all), a few objects at a time with the page drawing between the slices; the depth programs
//    the shadow pass draws the casters with (compileDepth: the customDepthMaterial, or a
//    MeshDepthMaterial, with the side, maps and alpha test that WebGLShadowMap.getDepthMaterial
//    gives them, into a target, without the scene's fog); and the stand-ins of what is not in the
//    scene yet or not drawn by it (module.warmup(w, camera): road chunks, street lamps, trees,
//    Post's and the clouds' passes ...).
//  - finish(): with KHR_parallel_shader_compile the driver compiles and links on its own threads;
//    once a program is ready, three's first use of it (link status, uniform and attribute
//    locations) is done here, one program after another with the page drawing in between, so no
//    later frame pays for it. Without the extension the first use waits for the compile: still
//    one program at a time, the loading screen moving between them.
//  - check(): after a flight starts, a camera, time of day or quality change and when the wingmen
//    load, the scene is searched for materials (or kinds of object) not built yet; whatever is
//    found is compiled at once and logged (a miss of the start-up pass: `late`).
//  - beforeDraw() / afterDraw(): every drawn frame. Before: when the sun starts or stops casting,
//    the scene's light state is set up again before the frame (three's shadow pass reads the state
//    of the frame before, and would build depth programs for it). After: the programs made by the
//    frame are logged (late, for the tests and tests/pc_check.py).
//
// warmUpApp(app) runs it all at start-up behind the loading screen: the environment's passes, one
// environment update, the modules that build their materials over a few frames (the vegetation,
// the cockpit's interior) given their frames, compileAll, finish, then a few real frames drawn
// behind the loading screen (the menu's view, the cockpit, the chase view, by day and by night):
// the first uploads of the textures, the driver's per-draw state, and whatever variant the passes
// did not foresee; then a wait (a fence, polled once a frame) until the GPU has done them.
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
    this.late = [];                  // programs made after the start-up pass: { label, programs: [names], ms }
    this.stats = { programs: 0, ms: 0, totalMs: 0, compileMs: 0, finishMs: 0, framesMs: 0, frames: 0, gpuMs: 0, gpuIdle: true,
      worstGapMs: 0, gapsOver100: 0, worstGapBy: {}, uploads: 0, uploadMB: 0, uploaded: [],
      frameMade: [], added: [], parallel: false, settled: [] };
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
    this._later = null;              // mark of the programs waiting for _finishLater
    this._cast = -1;
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
      const mark = this.done ? this.nextId() : -1;
      const mats = this.compile(scene, camera, { scene: targetScene });
      if (mark >= 0) this._finishLater(mark);
      return mats;
    };
    return this;
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
      this._keep(mats);
      this.see(root);
      return mats;
    } finally {
      if (bind) r.setRenderTarget(prev, face, mip);
      this._inner--;
      this.stats.compileMs += performance.now() - t0;
    }
  }

  /**
   * The number of lights and shadows is part of every program's key, but three builds an unlit
   * material's program only once more, at its first draw (with the lights of that moment), and
   * keeps it after that whatever the lights do. Compiled here, it keeps the compiled program from
   * the start, as if it had been drawn once: a street lamp built by day and first drawn at dusk,
   * when the sun no longer casts, would have been a new program then.
   */
  _keep(mats) {
    if (!mats) return;
    const props = this.renderer.properties;
    for (const m of mats) {
      if (needsLights(m)) continue;
      const p = props.get(m);
      if (p.__version === undefined && p.currentProgram) p.__version = m.version;
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
    try {
      if (env._lutScene && env._lutCamera) this.compile(env._lutScene, env._lutCamera, { target: env._skyRT || this.floatTarget() });
      if (env._envScene && env._cubeCamera) this.compile(env._envScene, env._cubeCamera.children[0], { target: this.floatTarget() });
      const p = env._pmrem;
      if (p && typeof p._compileMaterial === 'function') {
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
      const ms = performance.now() - t0;
      this.late.push({ label, programs: made, ms: +ms.toFixed(1) });
      console.info(`warm-up: ${label}: ${made.length} program(s) not built at start-up: ${made.join(', ')}`);
      if (hold) this.holding = true;
      this.finish(mark).finally(() => { if (hold) this.holding = false; });
    }
    return made.length;
  }

  /** Compiles (with their depth programs) the scene's objects whose material or kind was not compiled yet; returns the names of the programs made. */
  compileUnseen(camera) {
    const mark = this.nextId();
    const fresh = [];
    this.scene.traverse((o) => { if (drawable(o) && o.material && this._unseen(o)) fresh.push(o); });
    if (!fresh.length) return [];
    const g = new THREE.Group();
    g.children = fresh.map((o) => proxyOf(o, o.material));
    try {
      this.compile(g, camera, { scene: this.scene });
      this.compileDepth(g, camera);
    } finally {
      g.children = [];
      for (const o of fresh) {
        const k = kindOf(o);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) this._mark(m, k);
      }
      this.restoreLights(camera);
    }
    return this.programsSince(mark);
  }

  /** check(), then waits until the programs it made are finished. */
  async prepare(label, camera) {
    const mark = this.nextId();
    if (this.check(label, camera)) await this.finish(mark);
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

  /** Every drawn frame, after it: the programs it made (after the start-up pass: logged in late). */
  afterDraw(app) {
    const P = this.renderer.info.programs;
    let made = null;
    for (const p of P) {
      if (p.id < this._next) continue;
      (made || (made = [])).push(p.name || p.type || '?');
    }
    if (!made) return;
    this._next = this.nextId();
    if (!this.done) { this.stats.frameMade.push(...made); return; }
    const label = app ? `${app.state} ${app.cams?.mode || ''} ${app.settings ? app.settings.time.toFixed(2) + ' h' : ''}`.trim() : 'frame';
    this.late.push({ label: `drawn: ${label}`, programs: made, ms: 0 });
    if (this.late.length > 200) this.late.splice(0, this.late.length - 200);
  }

  /** A summary for the tests and the bench (no references into the renderer). */
  info() {
    const s = this.stats;
    return {
      enabled: this.enabled, done: this.done, parallel: s.parallel, programs: s.programs, ms: Math.round(s.ms), totalMs: Math.round(s.totalMs),
      compileMs: Math.round(s.compileMs), finishMs: Math.round(s.finishMs), framesMs: Math.round(s.framesMs), frames: s.frames,
      gpuMs: Math.round(s.gpuMs), gpuIdle: s.gpuIdle, worstGapMs: Math.round(s.worstGapMs), gapsOver100: s.gapsOver100, worstGapBy: { ...s.worstGapBy },
      uploads: s.uploads, uploadMB: +s.uploadMB.toFixed(1), uploaded: s.uploaded.slice(),
      frameMade: s.frameMade.slice(), added: s.added.slice(), settled: s.settled.slice(), late: this.late.map((l) => ({ ...l, programs: l.programs.slice() })),
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
 * The whole start-up pass, behind the loading screen (main.js calls it after toMenu()): see the
 * top of the file. progress(fraction, label) for the loading screen.
 */
export async function warmUpApp(app, { progress = null } = {}) {
  const w = app.warmup;
  if (!w || !w.enabled || !w.scene) { if (w) w.done = true; return; }
  const cam = app.camera;
  const t0 = performance.now();
  const say = (f, label) => { try { progress?.(f, label); } catch (e) { /* the page is going away */ } };
  const gaps = frameGaps();
  w.busy = true;
  const mark = w.nextId();
  try {
    // 1. the environment's passes, then one update of it: scene.environment, the sun and the
    // shadow casters as the first frame will have them
    say(0.02, 'sky');
    gaps.at('sky');
    w.compileEnvironment(app.env);
    await w.finish(mark);
    app.env.update(cam, 0);
    // 2. the modules that make their materials over a few frames: update-only frames for them
    say(0.06, 'vegetation, cockpit');
    gaps.at('settle');
    w.stats.settled = await settle(app, SETTLE_MS);
    // 3. everything else, compiled (in parallel where the browser can)
    say(0.1, 'preparing');
    gaps.at('compile');
    const t1 = performance.now();
    await w.compileAll(cam, [app.post, ...app.modules], { onProgress: (f) => say(0.1 + 0.2 * f, 'preparing') });
    // the cockpit's own shadow pass (js/aircraft/pcd/shadow.js), drawn without the scene's lights
    app.cockpit?.shadow?.precompile?.(w);
    const total = app.renderer.info.programs.filter((p) => p.id >= mark).length;
    say(0.3, `${total} programs`);
    gaps.at('finish');
    await w.finish(mark, (f, n, N) => say(0.3 + 0.5 * f, `${n} / ${N}`));
    w.stats.ms = performance.now() - t1;
    // the textures of what the views below do not show
    say(0.8, 'textures');
    gaps.at('textures');
    await w.uploadTextures(w.scene);
    // 4. real frames behind the loading screen, and the GPU's work on them
    say(0.82, 'first frames');
    gaps.at('frames');
    const t2 = performance.now();
    w._next = w.nextId();
    await drawViews(app, w, (f) => say(0.82 + 0.14 * f, 'first frames'));
    w.stats.framesMs = performance.now() - t2;
    say(0.96, 'GPU');
    gaps.at('gpu');
    const t3 = performance.now();
    w.stats.gpuIdle = await gpuDone(app.renderer, GPU_WAIT_MS);
    w.stats.gpuMs = performance.now() - t3;
    w.stats.programs = app.renderer.info.programs.filter((p) => p.id >= mark).length;
  } catch (e) {
    console.warn('warm-up:', e);
  }
  // what came into the scene during the pass (an object a module added late, the wingmen if they
  // loaded meanwhile): built and finished before the menu shows
  try {
    gaps.at('added');
    const m2 = w.nextId();
    w.stats.added = w.compileUnseen(cam);
    if (w.stats.added.length) await w.finish(m2);
  } catch (e) {
    console.warn('warm-up:', e);
  } finally {
    w.busy = false;
    w.done = true;
    w._early.length = 0;        // (a module's compile late in the pass was made as it came)
    w._next = w.nextId();
    w.restoreLights(cam);
  }
  say(1, 'ready');
  const s = w.stats;
  s.totalMs = performance.now() - t0;
  Object.assign(s, gaps.stop());
  console.info(`warm-up: ${s.programs} programs in ${(s.totalMs / 1000).toFixed(1)} s ` +
    `(compile calls ${s.compileMs.toFixed(0)} ms, finishing ${s.finishMs.toFixed(0)} ms, ${s.uploads} textures uploaded ` +
    `(${s.uploadMB.toFixed(1)} MB), ${s.frames} frames ${s.framesMs.toFixed(0)} ms, ` +
    `GPU ${s.gpuMs.toFixed(0)} ms${s.gpuIdle ? '' : ' (still busy)'}${s.parallel ? ', in parallel' : ''}; ` +
    `the loading screen's longest frame ${s.worstGapMs.toFixed(0)} ms, ${s.gapsOver100} over 100 ms: ` +
    `${Object.entries(s.worstGapBy).map(([k, v]) => `${k} ${v}`).join(', ')})` +
    `${s.frameMade.length ? `; made by the frames: ${s.frameMade.join(', ')}` : ''}` +
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
 * at the time put back. They upload the textures the views show and make the driver's own
 * per-draw state; the work they queue is waited for (without blocking the page) before the menu.
 */
async function drawViews(app, w, say) {
  const hours = app.settings.time;
  const sun = app.env.sunLight;
  const day = sun ? !!sun.castShadow : true;
  const other = day ? 0.5 : 12;
  const mode = app.cams.mode;
  const views = [[null, 'orbit'], [null, 'cockpit'], [null, 'chase'], [other, 'chase'], [other, 'cockpit'], [hours, mode]];
  const f = app.input.update(0);
  let k = 0;
  for (const [h, view] of views) {
    if (h != null && app.settings.time !== h) app.setTimeOfDay(h, true);
    app.cams.setMode(view);
    app.cams.snap?.();
    app._render(1 / 60, f, 1, true);
    w.afterDraw(app);
    w.stats.frames++;
    say(++k / views.length);
    await nextFrame();
  }
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
