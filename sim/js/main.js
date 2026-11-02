// F-35I Adir flight sim: the app shell.
//
// Creates the renderer, loads the terrain and the aircraft (with a progress screen), shows the
// start menu, runs the simulation at a fixed 120 Hz with an accumulator (FlightModel.step) while
// rendering at the display rate (the drawn pose is interpolated between the last two steps),
// and glues the modules of sim/DESIGN.md together: Environment (sky, sun, fog), Terrain,
// AircraftVisual, FlightModel, Input, the HMD, EngineSound, the camera modes and the menus.
//
// URL parameters:
//   stubs=1        stand-in modules from dev/stubs (flat field, box jet, simple kinematics)
//   test=1         automation API window.__sim (js/test/TestApi.js): the render loop is paused, tests
//                  step the simulation and draw frames on demand (tests/e2e.mjs, tests/smoke.mjs)
//   bench=1        scripted 60 s flight with frame-rate statistics on screen (js/test/Bench.js)
//   spawn=<name>   preselect a start point; autostart=1 starts flying at once
//   time=<h>       time of day (local solar hours, e.g. 7, 12.5, 19)
//   quality=low|medium|high, cam=cockpit|chase|orbit|flyby|tower, wingmen=0|1
//   depth=log|reversed   depth buffer (default log: the cockpit and a 400 km horizon in one view)

import * as THREE from 'three';
import { Input } from './input/Input.js';
import { HMD } from './ui/HMD.js';
import { CameraRig, VIEWS, VIEW_LABELS } from './ui/Cameras.js';
import { UI, formatHours } from './ui/Menu.js';
import { BindingsUI } from './ui/BindingsUI.js';
import { Effects } from './ui/Effects.js';
import { EngineSound } from './audio/EngineSound.js';

const params = new URLSearchParams(location.search);
const STUBS = params.get('stubs') === '1';
const TEST = params.get('test') === '1';
const BENCH = params.get('bench') === '1';

const PHYS_HZ = 120;
const H = 1 / PHYS_HZ;
const MAX_STEPS = 30;               // at most 0.25 s of simulation per frame (long frames are clamped)
const KT = 0.514444;
const DEG = Math.PI / 180;
const FAR = 650000;                 // m: the far terrain ends 205 km out, the horizon at altitude is further

const QUALITY = {
  low: { scale: 0.75, maxDpr: 1, shadow: 1024 },
  medium: { scale: 1, maxDpr: 1, shadow: 2048 },
  high: { scale: 1, maxDpr: 2, shadow: 4096 },
};

const SETTINGS_KEY = 'f35i.settings.v1';
const DEFAULTS = { spawn: null, time: 7.0, quality: 'high', volume: 0.7, wingmen: false, mouseStick: false, camera: 'cockpit', hmd: true };

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { s = {}; }
  s = { ...DEFAULTS, ...s };
  if (params.has('spawn')) s.spawn = params.get('spawn');
  if (params.has('time') && Number.isFinite(+params.get('time'))) s.time = +params.get('time');
  if (params.has('quality') && QUALITY[params.get('quality')]) s.quality = params.get('quality');
  if (params.has('cam') && VIEWS.includes(params.get('cam'))) s.camera = params.get('cam');
  if (params.has('wingmen')) s.wingmen = params.get('wingmen') === '1';
  if (!QUALITY[s.quality]) s.quality = 'high';
  return s;
}

/** The real modules (sim/DESIGN.md), or the stand-ins with ?stubs=1. */
async function loadModules() {
  if (STUBS) return import('../dev/stubs/index.js');
  const names = ['./env/Environment.js', './terrain/Terrain.js', './aircraft/AircraftVisual.js', './fdm/FlightModel.js'];
  const mods = await Promise.all(names.map((n) => import(n).catch((e) => {
    throw new Error(`Could not load the module js/${n.slice(2)}: ${e.message}`);
  })));
  let cfg = {};
  try { cfg = await import('./fdm/f35i_config.js'); } catch (e) { console.warn('FlightModel config module missing, using its defaults'); }
  return {
    Environment: mods[0].Environment,
    Terrain: mods[1].Terrain,
    AircraftVisual: mods[2].AircraftVisual,
    FlightModel: mods[3].FlightModel,
    F35I_CONFIG: cfg.F35I_CONFIG || cfg.default,
    configWithRig: cfg.configWithRig,
  };
}

/** Does this browser give reversed depth (EXT_clip_control)? Asked on a throwaway context. */
function chooseDepth() {
  const want = params.get('depth');
  if (want === 'reversed') {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ok = !!(gl && gl.getExtension('EXT_clip_control'));
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      if (ok) return 'reversed';
    } catch (e) { /* fall through */ }
  }
  return 'log';
}

class App {
  constructor() {
    this.settings = loadSettings();
    this.state = 'loading';
    this.ui = new UI(this);
    this.acc = 0;
    this.last = performance.now();
    this.maxG = 1;
    this.lights = { ext: true, landing: true };
    this.prevPos = new THREE.Vector3();
    this.currPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.currQuat = new THREE.Quaternion();
    this.drawPos = new THREE.Vector3();
    this.drawQuat = new THREE.Quaternion();
    this.testInput = null;
    this.testPilot = null;                  // js/test/TestPilot.js, set by the test API or the bench
    this.onFrame = null;                    // per displayed frame hook (the bench's statistics)
    this.live = !TEST;
    this.fps = 0;
    this._fpsN = 0;
    this._fpsT = 0;
    this._gAvg = 1;
    this._vc = { lights: { nav: true, anticoll: true, formation: 0, landing: false }, wheels: [] };
    this._wheelMap = null;
    this._crashShown = false;
    this._prevCam = null;
    this._frame = (t) => this.frame(t);
    this.modules = [];                      // graphics modules beside the terrain: see addModule()
  }

  // ------------------------------------------------------------------------------ start-up
  async init() {
    try {
      this._createRenderer();
      this.mods = await loadModules();
      const { Environment, Terrain, AircraftVisual } = this.mods;
      this.env = new Environment({ renderer: this.renderer, scene: this.scene });
      this.effects = new Effects(this.scene);
      this.terrain = new Terrain({ renderer: this.renderer, scene: this.scene, env: this.env, baseUrl: 'data/terrain/' });
      this.visual = new AircraftVisual({ scene: this.scene, baseUrl: 'data/aircraft/' });
      this.ui.progress('terrain', 0, 'starting');
      this.ui.progress('aircraft', 0, 'starting');
      const prog = (which) => (f, label) => this.ui.progress(which, f, label);
      await Promise.all([
        this.terrain.load(prog('terrain')).catch((e) => { throw new Error(`Terrain: ${e.message}${STUBS ? '' : '\nThe terrain data is built into sim/data/terrain/ by sim/tools/terrain (see sim/README.md).'}`); }),
        this.visual.load(prog('aircraft')).catch((e) => { throw new Error(`Aircraft: ${e.message}${STUBS ? '' : '\nThe aircraft is exported into sim/data/aircraft/ by sim/tools/aircraft (see sim/README.md).'}`); }),
      ]);
      this.ui.progress('terrain', 1, 'ready');
      this.ui.progress('aircraft', 1, 'ready');
      this._setupSim();
      this._addGraphicsModules();
    } catch (e) {
      console.error(e);
      this.ui.loadError(`${e.message}\n\nTo try the app without the generated data, open index.html?stubs=1`);
      if (TEST) window.__sim.error = e.message;
      return;
    }
    this.ui.buildMenu({
      spawns: this.terrain.spawns,
      settings: this.settings,
      attribution: this.terrain.attribution || this.terrain.manifest?.attribution || '',
      model: 'Aircraft: the procedural F-35I Adir Blender model of this project (scripts/f35, scripts/pilot).',
    });
    if (!this.terrain.spawns[this.settings.spawn]) this.settings.spawn = Object.keys(this.terrain.spawns)[0];
    this.selectSpawn(this.settings.spawn);
    this.setQuality(this.settings.quality, true);
    this.toMenu();
    if (TEST) { await this._testApi; window.__sim.ready = true; }
    requestAnimationFrame(this._frame);
    if (BENCH) {
      import('./test/Bench.js').then((m) => m.runBench(this)).catch((e) => console.error('bench:', e));
    } else if (params.get('autostart') === '1') this.startFlight();
  }

  _createRenderer() {
    const depth = chooseDepth();
    const r = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: depth === 'log',
      reversedDepthBuffer: depth === 'reversed',
      preserveDrawingBuffer: TEST,
    });
    r.outputColorSpace = THREE.SRGBColorSpace;
    // tone mapping, exposure, shadow maps, fog and scene.environment belong to the Environment
    r.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('view').appendChild(r.domElement);
    r.domElement.tabIndex = 0;
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, FAR);
    this.camera.rotation.order = 'YXZ';
    window.addEventListener('resize', () => this._resize());
    r.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ui.showMessage('GRAPHICS RESET', 'The browser lost the WebGL context (driver reset or out of video memory).', 'Reload the page to continue.');
    });
  }

  _setupSim() {
    const { FlightModel, F35I_CONFIG } = this.mods;
    const info = this.visual.info || {};
    // gear contacts = the modelled stance: the rig's parked tyre bottom (oleo at its static
    // compression, round tyre) raised by the tyre's deflection under the jet's weight. That is the
    // Blender ground line (rig groundStance, 1.45 deg nose-up), the FDM's own default contacts and
    // the FCS's ground pitch; the names (nose / left / right) are the rig's, so state.wheels maps
    // onto the visual's struts.
    let config = F35I_CONFIG;
    if (config && this.mods.configWithRig && Array.isArray(info.gearContacts) && info.gearContacts.every((g) => g.posParked)) {
      config = this.mods.configWithRig(F35I_CONFIG, {
        gearContacts: info.gearContacts.map((g) => {
          const p = g.posParked;
          return { name: g.name, pos: [p[0], p[1] + (Number.isFinite(g.tyreDeflection) ? g.tyreDeflection : 0), p[2]], radius: g.radius };
        }),
      });
    }
    this.fdm = new FlightModel(config, this.terrain);
    this.input = new Input(this.renderer.domElement);
    this.input.setMouseStick(this.settings.mouseStick);
    this.bindingsUI = new BindingsUI(this.input, this.ui);
    this.cams = new CameraRig(this.camera, { heightAt: (x, z) => this.terrain.heightAt(x, z) });
    this.cams.setMode(this.settings.camera);
    this.hmd = new HMD(document.getElementById('hmd'));
    this.hmd.visible = this.settings.hmd !== false;
    this.sound = new EngineSound();
    this.sound.setVolume(this.settings.volume);
    this._shadowTarget = this.visual.object3d;
    this.env.setShadowTarget?.(this._shadowTarget);
    this.env.setTime(this.settings.time, 172);
    // static compression of each strut in the rig, to map the FDM's strut travel onto the model
    this._rigStatic = {};
    for (const g of info.gearContacts || []) this._rigStatic[g.name] = Number.isFinite(g.staticCompression) ? g.staticCompression : 0;
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'flying') this.pause(); });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.state === 'flying' && this.input.mouseStick && !this.ui.overlay) this.pause();
    });
    this._lazyWingmen();
  }

  // ------------------------------------------------------------------------------ graphics modules
  /**
   * The visual modules that live beside the terrain and the aircraft (buildings, roads and
   * airfield lights, vegetation, clouds, post-processing helpers ...). Each one is created here
   * with one line and registered with addModule(); keep the order: things drawn on the ground
   * first. A module streams its own data and must not block start-up.
   */
  _addGraphicsModules() {
    const ctx = { renderer: this.renderer, scene: this.scene, camera: this.camera, env: this.env, terrain: this.terrain, visual: this.visual, app: this };
    void ctx;
    // --- graphics modules: one line each, e.g. this.addModule(new Buildings(ctx)); ---
  }

  /**
   * Register a graphics module. A module is any object with some of these methods:
   *   update(f)                 every frame, after the environment and the terrain;
   *                             f = { camera, dt, draw (false when the frame is not drawn),
   *                                   sunDirection (world, unit), time (hours), quality, state }
   *   setTime(hours, dayOfYear) the time of day changed
   *   setQuality(name)          'low' | 'medium' | 'high' (each module keeps its own table)
   *   reset()                   a new start point or a restart
   *   dispose()
   */
  addModule(m) {
    this.modules.push(m);
    m.setQuality?.(this.settings.quality);
    m.setTime?.(this.settings.time, (this.spawn && this.spawn.day_of_year) || 172);
    return m;
  }

  _updateModules(cam, dt, draw) {
    if (!this.modules.length) return;
    const f = { camera: cam, dt, draw, sunDirection: this.env.sunDirection, time: this.settings.time,
      quality: this.settings.quality, state: this.state };
    for (const m of this.modules) m.update?.(f);
  }

  _saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* private mode */ }
  }

  // ------------------------------------------------------------------------------ menu actions
  get spawn() { return this.terrain.spawns[this.settings.spawn]; }

  selectSpawn(name) {
    if (!this.terrain.spawns[name]) return;
    this.settings.spawn = name;
    const sp = this.spawn;
    if (Number.isFinite(sp.time_h)) this.setTimeOfDay(sp.time_h, true);
    this._saveSettings();
    this._placeAtSpawn();
    this.ui.syncMenu(this.settings, sp);
  }

  setTimeOfDay(h, quiet = false) {
    h = ((h % 24) + 24) % 24;
    this.settings.time = h;
    this.env.setTime(h, (this.spawn && this.spawn.day_of_year) || 172);
    for (const m of this.modules) m.setTime?.(h, (this.spawn && this.spawn.day_of_year) || 172);
    this.env.snapExposure?.();
    this._saveSettings();
    if (!quiet && this.state !== 'flying') this.ui.syncMenu(this.settings, this.spawn);
  }

  setQuality(q, quiet = false) {
    if (!QUALITY[q]) return;
    this.settings.quality = q;
    const Q = QUALITY[q];
    const pr = Math.min(window.devicePixelRatio || 1, Q.maxDpr) * Q.scale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    const sun = this.env.sunLight;
    if (sun && sun.shadow && sun.shadow.mapSize.x !== Q.shadow) {
      sun.shadow.mapSize.set(Q.shadow, Q.shadow);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    for (const m of this.modules) m.setQuality?.(q);
    this._saveSettings();
    if (!quiet) this.ui.syncMenu(this.settings, this.spawn);
  }

  setOption(key, value) {
    this.settings[key] = value;
    if (key === 'volume') this.sound.setVolume(value);
    if (key === 'mouseStick') this.input.setMouseStick(value);
    if (key === 'wingmen') this._lazyWingmen();      // loads them once, then shows / hides
    this._saveSettings();
  }

  openBindings() {
    this.bindingsUI.show();
    this._syncInput();
  }

  overlayClosed(which) {
    if (which === 'bindings') this.bindingsUI.hide();
    this._syncInput();
    // help / bindings opened in flight paused the sim: carry on
    if (this.state === 'flying') this.acc = 0;
  }

  _syncInput() {
    this.input.enabled = this.state === 'flying' && !this.ui.overlay;
  }

  /** Put the jet (and the wingmen) at the selected spawn, levers to match. */
  _placeAtSpawn() {
    const sp = this.spawn;
    const r = this.fdm.reset(sp) || {};
    const onGround = sp.on_ground !== false;
    this.input.setLevers({
      throttle: r.throttle != null ? r.throttle : (sp.throttle || 0),
      gearDown: r.gearDown != null ? r.gearDown : onGround || (sp.gear || 0) > 0.5,
      parkingBrake: onGround,
      canopy: false,
      speedbrake: false,
      apc: !!r.apc,                        // flight track: an approach spawn starts on the auto-throttle
    });
    this._apcShown = !!r.apc;
    const st = this.fdm.state;
    this.currPos.copy(st.position); this.prevPos.copy(st.position);
    this.currQuat.copy(st.quaternion); this.prevQuat.copy(st.quaternion);
    this.drawPos.copy(st.position); this.drawQuat.copy(st.quaternion);
    this.acc = 0;
    this.maxG = 1;
    this._gAvg = 1;
    this._crashShown = false;
    this.ui.hideMessage();
    this.effects.clear();
    this.visual.object3d.visible = true;
    this.cams.snap();
    this.env.snapExposure?.();
    if (this.wingmen) this.wingmen.reset(st);
    for (const m of this.modules) m.reset?.();
  }

  startFlight() {
    if (this.state === 'loading') return;
    this.sound.start();
    this.sound.setPaused(false);
    this._placeAtSpawn();
    if (this._prevCam) { this.cams.setMode(this._prevCam); this._prevCam = null; }
    this.cams.setMode(this.settings.camera);
    this.cams.orbit.auto = 0;
    this.camera.clearViewOffset();
    this.state = 'flying';
    this.ui.show('flying');
    this.ui.closeOverlay();
    this._syncInput();
    this.renderer.domElement.focus({ preventScroll: true });
    const sp = this.spawn;
    // flight track: the hint names the controls of the device in use (gamepad: L3, right stick),
    // and the mouse-stick hint is added to it (one toast replaces the other)
    const pad = this.input.lastDevice === 'gamepad';
    let hint = sp.on_ground !== false
      ? (pad ? 'Parking brake set: L3 releases it. Throttle: right stick up or the right trigger. Start: menu'
        : 'Parking brake set: Shift+B releases it. Throttle: Shift / Page Up. F1: help')
      : `${sp.label}.${this.input.levers.apc ? ` Auto-throttle on${pad ? '' : ' (Y)'}.` : ''} ${pad ? 'Start: menu' : 'F1: help'}`;
    if (this.settings.mouseStick && !pad) hint += '. Mouse stick: click the view to capture the mouse';
    this.ui.toast(hint, 4200);
  }

  pause() {
    if (this.state !== 'flying') return;
    this.state = 'paused';
    this.ui.show('pause');
    this.sound.setPaused(true);
    if (document.pointerLockElement) document.exitPointerLock?.();
    this._syncInput();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'flying';
    this.ui.show('flying');
    this.ui.closeOverlay();
    this.sound.setPaused(false);
    this.acc = 0;
    this._syncInput();
    this.renderer.domElement.focus({ preventScroll: true });
  }

  restart() {
    if (this.state === 'menu' || this.state === 'loading') return;
    this._placeAtSpawn();
    if (this._prevCam) { this.cams.setMode(this._prevCam); this._prevCam = null; }
    if (this.state === 'paused') this.resume();
    this.ui.toast(`Restart: ${this.spawn.label}`);
  }

  toMenu() {
    this.state = 'menu';
    this.ui.show('menu');
    this.ui.closeOverlay();
    this.sound.setPaused(true);
    if (document.pointerLockElement) document.exitPointerLock?.();
    this._placeAtSpawn();
    // menu backdrop: the jet at the start point, slowly circled
    this._prevCam = null;
    this.cams.setMode('orbit');
    this.cams.orbit.init = false;
    this.cams.orbit.dist = 26;
    this.cams.orbit.pitch = 9 * DEG;
    this.cams.orbit.auto = 0.06;
    this._applyMenuOffset();
    this.ui.syncMenu(this.settings, this.spawn);
    this._syncInput();
  }

  /** Centre the jet in the part of the screen the menu panel leaves free. */
  _applyMenuOffset() {
    const w = window.innerWidth, h = window.innerHeight;
    const panel = Math.min(470, w);
    if (this.state === 'menu' && w > 760) this.camera.setViewOffset(w, h, -panel / 2, 0, w, h);
    else this.camera.clearViewOffset();
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.visual) this.visual.viewportHeight = h;
    this._applyMenuOffset();
  }

  // ------------------------------------------------------------------------------ wingmen
  async _lazyWingmen() {
    if (this.wingmen) {
      const on = !!this.settings.wingmen;
      if (on && !this.wingmen.enabled) this.wingmen.reset(this.fdm.state);   // back beside the jet
      this.wingmen.setEnabled(on);
      return;
    }
    if (!this.settings.wingmen || this._wingmenLoading) return;
    this._wingmenLoading = true;
    try {
      const { Wingmen } = await import('./ai/Wingmen.js');
      const w = new Wingmen({
        scene: this.scene, AircraftVisual: this.mods.AircraftVisual, terrain: this.terrain,
        baseUrl: 'data/aircraft/', leader: this.visual,
      });
      if (this.state !== 'loading' && !TEST) this.ui.toast('Loading the wingmen...');
      await w.load();
      this.wingmen = w;
      w.setEnabled(!!this.settings.wingmen);
      w.reset(this.fdm.state);
      if (this.state === 'flying' && this.settings.wingmen) this.ui.toast(this.fdm.state.onGround ? 'Two wingmen lined up with you' : 'Two wingmen are joining');
    } catch (e) {
      console.warn('wingmen not available:', e);
      this.ui.toast('Wingmen could not be loaded');
    } finally {
      this._wingmenLoading = false;
    }
  }

  // ------------------------------------------------------------------------------ main loop
  frame(now) {
    requestAnimationFrame(this._frame);
    const raw = Math.max(0, (now - this.last) / 1000);
    const dt = Math.min(raw, 0.25);         // a long frame (tab switch, hitch) is clamped
    this.last = now;
    this._fpsN++;
    this._fpsT += raw;
    if (this._fpsT >= 0.5) { this.fps = this._fpsN / this._fpsT; this._fpsN = 0; this._fpsT = 0; }
    if (!this.live) return;                 // test mode: window.__sim drives the frames
    this.tick(dt);
    if (this.onFrame) this.onFrame(raw);
  }

  /** One displayed frame: input, fixed simulation steps, then drawing. */
  tick(dt) {
    const f = this.input.update(dt);
    this._applyTestInput(f, dt);
    this._handleEdges(f);
    const flying = this.state === 'flying' && !this.ui.overlay;
    if (flying) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= H && n < MAX_STEPS) { this._step(f); this.acc -= H; n++; }
      if (n >= MAX_STEPS) this.acc = 0;   // a very long frame: drop the rest instead of spiralling
    }
    this._render(dt, f, flying ? this.acc / H : 1);
  }

  /** Test / bench inputs over the pilot's: the scripted pilot first, then window.__sim.setInput. */
  _applyTestInput(f, dt = H) {
    if (this.testPilot && this.state === 'flying' && !this.ui.overlay) {
      const o = this.testPilot.update(this.fdm.state, dt);
      const t = this.testInput || (this.testInput = {});
      t.pitch = o.pitch; t.roll = o.roll; t.yaw = o.yaw; t.throttle = o.throttle; t.brake = o.brake;
      t.gear = o.gearHandle; t.parkingBrake = o.parkingBrake; t.speedbrake = o.speedbrake; t.nws = o.nwsEnable;
    }
    const t = this.testInput;
    if (!t) return;
    for (const k of ['pitch', 'roll', 'yaw', 'brake']) if (t[k] != null) f[k] = t[k];
    const L = this.input.levers;
    // a scripted throttle takes over from the auto-throttle, as the pilot's lever does
    if (t.throttle != null) { L.throttle = clamp(t.throttle, 0, 1); f.throttle = L.throttle; L.apc = false; f.apc = false; }
    if (t.gear != null) f.gearHandle = L.gearHandle = !!t.gear;
    if (t.parkingBrake != null) f.parkingBrake = L.parkingBrake = !!t.parkingBrake;
    if (t.speedbrake != null) { L.speedbrake = !!t.speedbrake; f.speedbrake = L.speedbrake ? 1 : 0; }
    if (t.canopy != null) f.canopy = L.canopy = !!t.canopy;
    if (t.nws != null) f.nwsEnable = L.nwsEnable = !!t.nws;
  }

  /** One fixed physics step (1/120 s). */
  _step(f) {
    const st = this.fdm.state;
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.fdm.step(H, f);
    this.currPos.copy(st.position);
    this.currQuat.copy(st.quaternion);
    if (!st.onGround && !st.crashed) this.maxG = Math.max(this.maxG, st.gLoad || 1);
    if (this.wingmen) this.wingmen.step(H, st, f);
  }

  _handleEdges(f) {
    const ui = this.ui;
    // menus and overlays: Esc / B back, Enter / A confirm, P / Start pause toggles
    if (!this.input.enabled) {
      if (f.menuBack) {
        if (this.bindingsUI.open && this.input.capturing) this.input.cancelCapture();
        else if (ui.overlay) ui.closeOverlay();
        else if (this.state === 'paused') this.resume();
      }
      if (f.help) { if (ui.overlay === 'help') ui.closeOverlay(); else { ui.showHelp(true); this._syncInput(); } }
      if (f.pause && this.state === 'paused' && !ui.overlay) this.resume();
      else if (f.pause && ui.overlay && this.state !== 'menu') ui.closeOverlay();
      if (f.confirm && !ui.overlay) {
        if (this.state === 'menu') this.startFlight();
        else if (this.state === 'paused') this.resume();
      }
      if (f.reset && this.state === 'paused' && !ui.overlay) this.restart();
      return;
    }
    if (this.state !== 'flying') return;
    const st = this.fdm.state;
    const L = this.input.levers;
    // flight track: hints for Input, used from the next frame: in the air L3 is the high-AoA mode
    // (the parking brake on the ground); R restarts at once when crashed or stopped, but must be
    // held for a second in flight, so a stray key press does not end the flight
    this.input.airborne = !st.onGround;
    this.input.resetNeedsHold = !(st.crashed || (st.onGround && (st.groundSpeed ?? 0) < 2));
    if (f.reset) { this.restart(); return; }
    if (f.resetHint) ui.toast(this.input.lastDevice === 'keyboard' ? 'Hold R for a second to restart at the start point' : 'Hold the button for a second to restart', 2000);
    if (f.highAoAToggle) ui.toast(L.highAoA ? 'High-AoA mode: AoA limit 50 deg' : 'Normal mode: AoA limit 25 deg');
    // auto-throttle (APC): only with the gear down in the air; while it flies, the lever follows
    // the engine command, so taking over (any throttle input turns it off) does not jump
    if (L.apc && st.apc) { L.throttle = st.engine.throttle; this._apcFlying = true; }
    if (L.apc && (st.onGround || st.crashed || st.gear < 0.999 || L.highAoA || !L.gearHandle)) {
      if (this._apcFlying && st.onGround) L.throttle = 0;               // touchdown: idle, as the flight model does
      L.apc = false;
      if (f.apcToggle) { ui.toast('Auto-throttle: with the gear down, in the air'); this._apcShown = false; }
    }
    if (!L.apc) this._apcFlying = false;
    if (L.apc !== !!this._apcShown) {
      this._apcShown = L.apc;
      ui.toast(L.apc ? 'Auto-throttle on: it flies 13 deg AoA; move the throttle to take over' : 'Auto-throttle off');
    }
    if (f.gearToggle) {
      if (!L.gearHandle && st.onGround) {
        L.gearHandle = true;
        ui.toast('Gear handle locked: weight on the wheels');
      } else ui.toast(L.gearHandle ? 'Gear down' : 'Gear up');
    }
    if (f.canopyToggle) {
      if (L.canopy && !(st.onGround && (st.groundSpeed ?? 0) < 15)) {
        L.canopy = false;
        ui.toast('The canopy opens only on the ground below 30 kt');
      } else ui.toast(L.canopy ? 'Canopy opening' : 'Canopy closing');
    }
    if (L.canopy && (st.groundSpeed ?? 0) > 18) { L.canopy = false; ui.toast('Canopy closed'); }
    if (f.parkingBrakeToggle) ui.toast(L.parkingBrake ? 'Parking brake set' : 'Parking brake released');
    if (f.speedbrakeToggle) ui.toast(L.speedbrake ? 'Speed brake out' : 'Speed brake in');
    if (f.lightsToggle) { this.lights.ext = !this.lights.ext; ui.toast(this.lights.ext ? 'Exterior lights on' : 'Exterior lights off'); }
    if (f.landingLightToggle) { this.lights.landing = !this.lights.landing; ui.toast(this.lights.landing ? 'Landing light on' : 'Landing light off'); }
    if (f.hmdToggle) {
      this.hmd.visible = !this.hmd.visible;
      this.settings.hmd = this.hmd.visible;
      this._saveSettings();
      ui.toast(this.hmd.visible ? 'Helmet display on' : 'Helmet display off');
    }
    if (f.mute) ui.toast(this.sound.toggleMute() ? 'Sound off' : 'Sound on');
    if (f.timeEarlier || f.timeLater) {
      this.setTimeOfDay(this.settings.time + (f.timeLater ? 0.25 : -0.25), true);
      ui.toast(`Time of day ${formatHours(this.settings.time)}`);
    }
    let cam = null;
    if (f.cameraNext) cam = this.cams.next(1);
    if (f.cameraPrev) cam = this.cams.next(-1);
    if (f.camera >= 1 && f.camera <= VIEWS.length) { cam = VIEWS[f.camera - 1]; this.cams.setMode(cam); }
    if (cam) {
      this._prevCam = null;
      this.settings.camera = cam;
      this._saveSettings();
      ui.toast(cam === 'tower' ? `Tower: ${this._towerToast()}` : VIEW_LABELS[cam]);
    }
    if (f.fullscreen) {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    }
    // last, so keys pressed in the same (slow) frame still count
    if (f.pause) this.pause();
    else if (f.help) { ui.showHelp(true); this._syncInput(); }
  }

  _towerToast() {
    // the tower camera picks its field on the next update; name it from the nearest airport
    const p = this.fdm.state.position;
    let best = null, bd = Infinity;
    for (const ap of this.terrain.airports || []) {
      for (const rw of ap.runways || []) {
        const e = rw.ends && rw.ends[0];
        if (!e) continue;
        const d = Math.hypot(p.x - e.x, p.z - e.z);
        if (d < bd) { bd = d; best = ap; }
      }
    }
    return best ? best.name : 'nearest field';
  }

  // ------------------------------------------------------------------------------ drawing
  /** Pose, cameras and effects for this frame; with draw = false (fast test runs) no GPU work. */
  _render(dt, f, alpha, draw = true) {
    const st = this.fdm.state;
    const cam = this.camera;
    // pose drawn this frame: between the last two physics steps
    this.drawPos.lerpVectors(this.prevPos, this.currPos, clamp(alpha, 0, 1));
    this.drawQuat.slerpQuaternions(this.prevQuat, this.currQuat, clamp(alpha, 0, 1));
    const info = this.visual.info || {};

    // aircraft: pose and every moving part
    this.visual.setPose(this.drawPos, this.drawQuat);
    this.visual.setControls(this._visualControls(st));

    // crash: message, fireball, outside view
    if (st.crashed && !this._crashShown) this._onCrash(st);

    // cameras (look input only while flying or in the menu backdrop)
    const look = (this.state === 'flying' && !this.ui.overlay) || this.state === 'menu' || this.state === 'paused' ? f : {};
    this.cams.update(dt, {
      position: this.drawPos, quaternion: this.drawQuat, velocity: st.velocity, gLoad: st.gLoad, alpha: st.alpha,
      qbar: st.qbar, onGround: st.onGround, groundSpeed: st.groundSpeed, eye: info.eye, eyeForward: info.eyeForward,
      airports: this.terrain.airports, look,
    });
    this.visual.update(dt, cam);
    if (this.wingmen) this.wingmen.update(dt, cam, this.state === 'flying', alpha, this._vc.lights, this.drawPos);
    // the sun's shadow follows the jet, or the whole line-up while the wingmen stand beside it
    const shadowTarget = this.wingmen && this.wingmen.sharedShadow ? this.wingmen.shadowProxy : this.visual.object3d;
    if (shadowTarget !== this._shadowTarget) { this._shadowTarget = shadowTarget; this.env.setShadowTarget?.(shadowTarget); }
    this.effects.update(dt);
    if (!draw) { this.terrain.update(cam); this._updateModules(cam, dt, false); return; }
    this.env.update(cam, dt);
    this.terrain.update(cam);
    this._updateModules(cam, dt, true);
    this.renderer.render(this.scene, cam);

    // helmet display / info strip
    const mode = this.cams.mode;
    if (this.state === 'flying' || this.state === 'paused') {
      this.hmd.draw(st, cam, mode, {
        quaternion: this.drawQuat, position: this.drawPos, throttleLever: this.input.levers.throttle,
        parkingBrake: this.input.levers.parkingBrake, brakes: f.brake > 0.1, speedbrake: this.input.levers.speedbrake,
        maxG: this.maxG, mouseStick: this.input.mouseStick && this.input.pointerLocked ? this.input.mouseStickPos : null,
      });
    } else {
      this.hmd.clear();
    }
    // g-induced grey-out (cockpit only, gentle)
    this._gAvg += ((st.gLoad || 1) - this._gAvg) * (1 - Math.exp(-dt / 1.2));
    const grey = mode === 'cockpit' && this.state === 'flying' ? clamp((this._gAvg - 6.8) / 3.5, 0, 0.6) : 0;
    const vg = document.getElementById('vignette');
    const vo = grey.toFixed(2);
    if (vg.style.opacity !== vo) vg.style.opacity = vo;

    // sound
    this.sound.update(st, mode, dt, {
      cameraPosition: cam.position, canopyOpen: st.controls ? st.controls.canopy : 0,
      active: this.state === 'flying' && !this.ui.overlay,
    });
  }

  _visualControls(st) {
    const c = this._vc;
    const src = st.controls || {};
    for (const k in src) if (k !== 'lights') c[k] = src[k];
    c.ab = st.engine ? st.engine.ab : 0;
    const night = this.env.sunDirection ? this.env.sunDirection.y < 0.08 : false;
    const L = c.lights;
    L.nav = this.lights.ext;
    L.anticoll = this.lights.ext;
    L.formation = this.lights.ext && night ? 0.8 : 0;
    L.landing = this.lights.landing && (st.gear || 0) > 0.9;
    // struts: the FDM's strut (oleo + tyre) compresses by staticCompression under the jet's
    // weight, the modelled oleo by the rig's staticCompression (the tyre is a rigid round mesh).
    // Up to the static point the oleo takes its share of the FDM's travel, beyond it all of it, so
    // the struts stand at the parked pose when the FDM sits at rest and are fully out in the air.
    const wheels = st.wheels || [];
    if (c.wheels.length !== wheels.length) c.wheels = wheels.map((w) => ({ name: w.name, compression: 0, steer: 0 }));
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i], o = c.wheels[i];
      o.name = w.name;
      o.compression = this._strutFromFdm(w);
      o.steer = w.steer;
    }
    return c;
  }

  /** Modelled oleo compression (m from fully extended) for one of the FDM's state.wheels. */
  _strutFromFdm(w) {
    const c = Math.max(0, w.compression || 0);
    const rs = this._rigStatic[w.name] ?? 0;
    const cs = w.staticCompression;
    if (!(Number.isFinite(cs) && cs > 0)) return c;
    return c <= cs ? c * rs / cs : rs + (c - cs);
  }

  _onCrash(st) {
    this._crashShown = true;
    const reason = st.crashReason || 'Crashed';
    const severe = !/landing gear|gear collapsed|Hard landing|Tail strike|Belly landing/i.test(reason);
    this.ui.showMessage('CRASHED', reason, 'Press <kbd>R</kbd> to try again, <kbd>Esc</kbd> for the menu');
    this.effects.explode(this.currPos, severe ? 1 : 0.45);
    if (severe) this.visual.object3d.visible = false;
    // pull back to see it (not from inside the fireball)
    if (this.cams.mode === 'cockpit' || this.cams.mode === 'chase') {
      this._prevCam = this.cams.mode;
      this.cams.setMode('orbit');
      this.cams.orbit.dist = 110;
      this.cams.orbit.pitch = 16 * DEG;
    }
  }
}

const app = new App();
if (TEST) {
  window.__sim = { ready: false, error: null };
  app._testApi = import('./test/TestApi.js')
    .then((m) => m.installTestApi(app, { H, KT, DEG }))
    .catch((e) => { window.__sim.error = `test API: ${e.message}`; });
}
app.init();
