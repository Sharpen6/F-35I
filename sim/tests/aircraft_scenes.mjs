// Screenshots of the F-35I in the whole app (real data, Environment, terrain), for judging the
// aircraft's look: paint at noon / 07:00 / sunset / night, lights, afterburner, vapour, tyre smoke,
// the gear doors. Playwright + headless Chromium (SwiftShader), driven through window.__sim.
//
//   node sim/tests/aircraft_scenes.mjs [--port 8150] [--out DIR] [--only name,name] [--size 960x540]
//                                      [--quality high] [--list] [--pre "js"] [--root SIM_FOLDER]
//
//   --only      scene names or prefixes (e.g. --only park_noon,ab_) ; --list prints the scenes
//   --shots     only these shot names (e.g. --shots side,chase)
//   --pre       JavaScript run in the page before every scene (e.g. to try a material setting:
//               --pre "window.__sim.app.env.exposureBias = 0.5")
//   --post      JavaScript run after each scene's setup (before its shots)
//   --tag       suffix for the file names (compare variants side by side)
//   --variants / --variants-file   draw every shot once per variant (see VARIANTS below)
// Fails on console errors and page errors, and on failed checks: some shots measure pixels of the
// frame (the nozzle's centre seen from behind, the ground ahead of the nose drawn with the landing
// light's pool and without it, the colour of a distant nav light) or effect state (the contrail's
// length, the shader programs built) and check them (see
// MEASURE and the `check` functions below). Screenshots + report.json in --out
// (default /home/claude/simdata/shots/aircraft/scenes).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ROOT = resolve(arg('root', join(here, '..')));
const PORT = +arg('port', 8150);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/aircraft/scenes'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const PRE = arg('pre', '');
const POST = arg('post', '');
const SHOTS = arg('shots', '') ? arg('shots', '').split(',') : null;
const TAG = arg('tag', '');
// --variants '[{"tag": "a", "js": "..."}, ...]' (or --variants-file FILE with that JSON): every shot is
// drawn once per variant (the js runs before the frame), so material or lighting settings can be
// compared on identical frames. Each variant's js should set absolute values (they run in turn).
const VARIANTS = arg('variants-file', '') ? JSON.parse(readFileSync(arg('variants-file', ''), 'utf8'))
  : arg('variants', '') ? JSON.parse(arg('variants', '')) : [{ tag: TAG, js: '' }];
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[scenes ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// Page-side helpers (window.__ac): an orbit camera placed relative to the jet's heading, custom
// start points, a simple g / bank holder for the turn scenes.
const PAGE_HELPERS = `
window.__ac = {
  DEG: Math.PI / 180,
  rot(q, v) {
    const { x, y, z, w } = q; const [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  },
  /** Orbit camera: rel = degrees from behind the jet (90 = its right side, 180 = ahead), pitch deg, dist m. */
  orbit(rel, pitch, dist, fov = 40) {
    const app = window.__sim.app;
    app.cams.setMode('orbit');
    app.settings.camera = 'orbit';
    const aft = this.rot(app.fdm.state.quaternion, [0, 0, 1]);
    const O = app.cams.orbit;
    O.yaw = Math.atan2(aft[0], aft[2]) + rel * this.DEG;
    O.pitch = pitch * this.DEG;
    O.dist = dist;
    O.init = true;
    O.auto = 0;
    app.cams.fov.orbit = fov;
    return true;
  },
  spawn(name, base, over) {
    const sp = window.__sim.app.terrain.spawns;
    sp[name] = { ...(sp[base] || {}), ...over };
    return name;
  },
  /** Hold a bank angle and a load factor with the stick (simple PI-ish loops), every 12 steps. */
  hold(bankDeg, g, seconds, throttle = 1) {
    const S = window.__sim;
    let pitch = 0.3, t = 0;
    while (t < seconds) {
      const s = S.summary();
      const roll = Math.max(-1, Math.min(1, (bankDeg - s.roll_deg) * 0.04));
      if (Math.abs(s.roll_deg - bankDeg) < 25) pitch = Math.max(-1, Math.min(1, pitch + (g - s.g) * 0.03));
      else pitch = 0.1;
      S.setInput({ roll, pitch, throttle });
      S.step(12);
      t += 0.1;
      if (S.summary().crashed) break;
    }
    return S.summary();
  },
  // ------------------------------------------------------------------ measuring the drawn frame
  vec(x, y, z) { return new (window.__sim.app.visual.object3d.position.constructor)(x, y, z); },
  /** A body-frame point (+X right, +Y up, -Z forward) in world coordinates. */
  bodyToWorld(p) { return window.__sim.app.visual.object3d.localToWorld(this.vec(p[0], p[1], p[2])); },
  /** World point -> CSS px on the 3D canvas ([x, y]), null when behind the camera or off screen. */
  screen(w) {
    const app = window.__sim.app, cam = app.camera, c = app.renderer.domElement;
    cam.updateMatrixWorld();
    const v = w.clone().project(cam);
    if (!(v.z > -1 && v.z < 1) || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return [(v.x + 1) / 2 * c.clientWidth, (1 - v.y) / 2 * c.clientHeight];
  },
  /** Mean RGB (0..255) of the (2r+1)^2 CSS px around (x, y) of the last frame (3D canvas only). */
  px(x, y, r = 2) {
    const c = window.__sim.app.renderer.domElement;
    const k = c.width / c.clientWidth;
    const cv = this._cv || (this._cv = document.createElement('canvas'));
    if (cv.width !== c.width || cv.height !== c.height) { cv.width = c.width; cv.height = c.height; }
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0);
    const R = Math.max(0, Math.round(r * k)), X = Math.round(x * k), Y = Math.round(y * k);
    const d = g.getImageData(X - R, Y - R, 2 * R + 1, 2 * R + 1).data;
    const s = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
    const n = d.length / 4;
    return s.map((v) => Math.round(v / n));
  },
  /** The brightest pixel (luma) within r CSS px of (x, y): {at, rgb, luma}. */
  peak(x, y, r = 4) {
    const c = window.__sim.app.renderer.domElement;
    const k = c.width / c.clientWidth;
    const cv = this._cv || (this._cv = document.createElement('canvas'));
    if (cv.width !== c.width || cv.height !== c.height) { cv.width = c.width; cv.height = c.height; }
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0);
    const R = Math.max(0, Math.round(r * k)), X = Math.round(x * k), Y = Math.round(y * k);
    const d = g.getImageData(X - R, Y - R, 2 * R + 1, 2 * R + 1).data;
    let best = -1, bi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (l > best) { best = l; bi = i; }
    }
    const j = bi / 4, w = 2 * R + 1;
    return { at: [Math.round((X - R + (j % w)) / k), Math.round((Y - R + Math.floor(j / w)) / k)],
      rgb: [d[bi], d[bi + 1], d[bi + 2]], luma: Math.round(best) };
  },
  /** The nozzle exit's centre on screen and its colour (5 x 5 px mean). */
  nozzle() {
    const p = this.screen(this.bodyToWorld(window.__sim.app.visual.info.raw.nozzle.exit));
    return p ? { at: p.map(Math.round), rgb: this.px(p[0], p[1], 2) } : null;
  },
  /** The ground d m ahead of the nose (along the heading) and side m to the right: world point. */
  ground(d, side = 0) {
    const app = window.__sim.app, st = app.fdm.state, h = st.heading || 0;
    const nose = this.bodyToWorld([0, 0, -6.5]);
    const x = nose.x + Math.sin(h) * d + Math.cos(h) * side, z = nose.z - Math.cos(h) * d + Math.sin(h) * side;
    return this.vec(x, app.terrain.heightAt(x, z) + 0.05, z);
  },
  /** Colours of the ground at distances ahead, in the beam (side 0) and beside it (side s). */
  groundPts(ds, s = 18) {
    const out = [];
    for (const d of ds) {
      const a = this.screen(this.ground(d, 0)), b = this.screen(this.ground(d, s));
      out.push({ d, lit: a ? this.px(a[0], a[1], 2) : null, ref: b ? this.px(b[0], b[1], 2) : null });
    }
    return out;
  },
  /**
   * The landing light's own effect on the ground ahead of the nose: the same pixels drawn with the
   * pool and without it ({d, on, off}), so the runway's paint and the asphalt beside it cancel out.
   */
  poolPts(ds) {
    const S = window.__sim, fx = S.app.modules.find((m) => m.name === 'AircraftFX');
    const at = ds.map((d) => this.screen(this.ground(d, 0)));
    const read = () => at.map((p) => (p ? this.px(p[0], p[1], 2) : null));
    const on = read();
    let off = at.map(() => null);
    if (fx && fx.pool) {
      fx.pool.enabled = false;
      S.render();
      off = read();
      fx.pool.enabled = true;
      S.render();
    }
    return ds.map((d, i) => ({ d, on: on[i], off: off[i] }));
  },
  /**
   * Colour of each nav light (red left, green right) on screen: the brightest pixel within 4 px of
   * any light of that colour (the core: a white core with a coloured rim shows there).
   */
  navLights() {
    const L = window.__sim.app.visual.lights, out = {};
    for (let i = 0; i < L.sources.length; i++) {
      const s = L.sources[i];
      if (s.role !== 'nav') continue;
      // a light that sends nothing towards the camera (its lens faces away) has no glow to measure:
      // its spot on screen may hold another light's glow
      let sent = 0;
      for (let k = 0; k < 3; k++) sent += L._core[i * 4 + k] + L._halo[i * 4 + k];
      if (!(sent > 0)) continue;
      const p = this.screen(s.pos.clone().applyMatrix4(s.node.matrixWorld));
      if (!p) continue;
      const key = s.colour.r > s.colour.g ? 'red' : 'green';
      const pk = this.peak(p[0], p[1], 4);
      if (!out[key] || pk.luma > out[key].luma) out[key] = pk;
    }
    return out;
  },
  /** The contrail ribbon: points, the oldest point's age and the trail's length. */
  contrail() {
    const fx = window.__sim.app.modules.find((m) => m.name === 'AircraftFX');
    const r = fx && fx.vapor && fx.vapor.contrail.r;
    if (!r) return null;
    const t = window.__sim.app.fdm.state.time;
    const pts = r.points ? r.points() : r.pts;
    if (!pts.length) return { n: 0 };
    const oldest = pts[0], newest = pts[pts.length - 1];
    // the drawn alpha of the oldest point (the ribbon's buffer is newest first: the last pair)
    const endAlpha = r.alphaAt ? r.alphaAt(0, t) : r.data[(pts.length - 1) * 8 + 2];
    return { n: pts.length, max: r.o.max, life: r.o.life, oldestAge: +(t - oldest.t).toFixed(2),
      length: Math.round(oldest.p.distanceTo(newest.p)), endAlpha: +endAlpha.toFixed(3) };
  },
  /** Shader programs the renderer has made so far (names). */
  programs() { return window.__sim.app.renderer.info.programs.map((p) => p.name); },
};
true;
`;

// Page-side measurements a shot can ask for (measure: [...]); checks run on their results.
const MEASURE = {
  nozzle: 'window.__ac.nozzle()',
  ground: 'window.__ac.groundPts([6, 12, 25, 50])',
  // from behind and above the parked jet (POOL_CAM): ahead of the nose wheel, in the beam and 9 m aside
  groundNear: 'window.__ac.groundPts([6, 10, 16, 25], 9)',
  // the same points ahead of the nose wheel drawn with the pool and without it (the pool's own effect)
  poolNear: 'window.__ac.poolPts([6, 10, 16, 25])',
  // the approach (APPROACH_CAM): the touchdown zone ahead, with the pool and without it
  poolApp: 'window.__ac.poolPts([60, 120, 200, 300])',
  groundApp: 'window.__ac.groundPts([60, 120, 200, 300], 60)',
  groundFar: 'window.__ac.groundPts([40, 80, 150, 250], 45)',
  nav: 'window.__ac.navLights()',
  contrail: 'window.__ac.contrail()',
  programs: 'window.__ac.programs()',
};

/** The burner seen from behind: a warm yellow-orange core, never a white disc (dusk, night). */
const warmNozzle = (m) => {
  const c = m.nozzle && m.nozzle.rgb;
  if (!c) return ['the nozzle is not on screen'];
  const f = [];
  if (c[0] < 200) f.push(`nozzle centre R ${c[0]} < 200 (no flame?)`);
  if (c[1] > 225) f.push(`nozzle centre G ${c[1]} > 225 (white)`);
  if (c[2] > 170) f.push(`nozzle centre B ${c[2]} > 170 (white)`);
  return f;
};
const luma = (c) => (c ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : NaN);
/** How much the pool brightens a point (luma with the pool / without it), null when not measured. */
const poolRatio = (g) => (g && g.on && g.off ? luma(g.on) / Math.max(1, luma(g.off)) : null);
/** The pool at dusk: a modest brightening near the nose wheel that fades out along the beam. */
const duskPool = (m) => {
  const f = [];
  const pts = (m.poolNear || []).filter((g) => poolRatio(g) !== null);
  if (!pts.length) return ['pool points off screen'];
  for (const g of pts) {
    const r = poolRatio(g);
    if (r > (g.d <= 12 ? 2.5 : 1.6)) f.push(`dusk pool ${g.d} m ahead: ${r.toFixed(2)} x the same ground without it`);
  }
  return f;
};
/** The pool at night: clearly lit ahead of the nose wheel, in the lamp's warm white. */
const nightPool = (m) => {
  const g = (m.poolNear || []).find((x) => x.d === 10);
  const r = poolRatio(g);
  if (r === null) return ['pool points off screen'];
  const f = r < 2 ? [`night pool ${g.d} m ahead only ${r.toFixed(2)} x the same ground without it`] : [];
  // a lit runway, not a flat white wedge: the pool's ground keeps some of its texture's range
  if (g.on.every((c) => c >= 250)) f.push(`night pool ${g.d} m ahead clipped to white (${g.on})`);
  // the lamp's light, not the night's blue made brighter: on the asphalt and on the paint, wherever
  // the pool shows
  for (const p of m.poolNear || []) {
    if (poolRatio(p) > 1.5 && p.on[2] > 1.3 * p.on[0]) f.push(`night pool ${p.d} m ahead is blue (${p.on})`);
  }
  return f;
};
/** Night approach: the beam lights the ground ahead (the touchdown zone), not just the sky. */
const approachPool = (m) => {
  const pts = m.poolApp || [];
  const lit = pts.filter((g) => poolRatio(g) !== null && poolRatio(g) > 2 && luma(g.on) > luma(g.off) + 6);
  return lit.length ? [] : ['no ground lit ahead on the approach'];
};
/**
 * A distant nav light keeps its colour (no white core with a coloured fringe). A light whose peak is
 * nearly black is not seen from there (its lens faces away or the airframe hides it).
 */
const navColour = (m) => {
  const f = [];
  const n = m.nav || {};
  const red = n.red && n.red.luma >= 25 ? n.red : null, green = n.green && n.green.luma >= 25 ? n.green : null;
  if (red && !(red.rgb[0] > 1.6 * Math.max(red.rgb[1], red.rgb[2]))) f.push(`red nav light ${red.rgb} not red`);
  if (green && !(green.rgb[1] > 1.3 * Math.max(green.rgb[0], green.rgb[2]))) f.push(`green nav light ${green.rgb} not green`);
  if (!red && !green) f.push('no nav light on screen');
  return f;
};
/** The contrail fades out before its oldest point is dropped (no blunt end). */
const contrailEnd = (m) => {
  const c = m.contrail;
  if (!c || !c.n) return ['no contrail'];
  return c.endAlpha !== null && c.endAlpha > 0.15 ? [`contrail ends at alpha ${c.endAlpha} (${c.length} m, ${c.oldestAge} s)`] : [];
};

// ---------------------------------------------------------------------------------------- scenes
// Each scene: setup (page function source, may be async) then shots [{name, cam}] where cam is
// 'chase' | 'cockpit' | 'flyby' | 'tower' | [rel, pitch, dist, fov] (orbit).
// The cameras the pool is measured from: behind and above the jet (the ground ahead of the nose wheel
// in view, the jet itself not over the points), and further back on the approach.
const POOL_CAM = [10, 22, 26, 60];
const APPROACH_CAM = [25, 22, 45, 55];
const PARK = (time, tag) => ({
  name: `park_${tag}`,
  setup: `async () => { window.__sim.start('telnof_36', { time: ${time}, camera: 'chase' }); window.__sim.step(60); }`,
  shots: [
    { name: 'front34', cam: [-140, 4, 21, 40] },
    { name: 'rear34', cam: [35, 10, 22, 40] },
    { name: 'side', cam: [92, 2, 24, 40] },
    { name: 'chase', cam: 'chase' },
    { name: 'tower', cam: 'tower' },
    // the landing light's pool on the ground ahead (gear down, lights on)
    ...(tag === 'night' ? [{ name: 'pool', cam: POOL_CAM, measure: ['poolNear'], check: nightPool },
      { name: 'pool_front', cam: [-160, 16, 34, 55] }] : []),
    ...(tag === 'dusk' ? [{ name: 'pool', cam: POOL_CAM, measure: ['poolNear'], check: duskPool },
      { name: 'pool_front', cam: [-160, 16, 34, 55] }] : []),
  ],
});

/** Take-off roll in full burner: from `spawn` at `time` until the burner is lit and 70 kt. */
const AB_ROLL = (spawn, time) => `async () => {
  const S = window.__sim; S.start('${spawn}', { time: ${time}, camera: 'chase' }); S.autopilot('takeoff');
  for (let i = 0; i < 400; i++) { S.step(12); const s = S.summary(); if (s.ab > 0.95 && s.ias_kt > 70) break; } }`;

/** Every effect's shader program exists before the effect first shows (no compile hitch in flight). */
const EFFECT_PROGRAMS = ['F35_AB_Plume', 'F35_Nozzle_Glow', 'F35_VapourSheet', 'F35_VapourTrail', 'F35_VapourConeBack',
  'F35_VapourConeFront', 'F35_TyreSmoke', 'F35_LandingPool', 'F35_LandingPoolAdd', 'F35_LightGlow'];
const precompiled = (m) => {
  const have = new Set(m.programs || []);
  const miss = EFFECT_PROGRAMS.filter((n) => !have.has(n));
  return miss.length ? [`not compiled before use: ${miss.join(', ')}`] : [];
};

const SCENES = [
  {
    name: 'compile',
    setup: `async () => { const S = window.__sim; S.start('telnof_36', { time: 12.5, camera: 'chase' }); S.step(12); }`,
    shots: [{ name: 'parked', cam: 'chase', measure: ['programs'], check: precompiled }],
  },
  PARK(12.5, 'noon'),
  PARK(7.0, '0700'),
  PARK(18.9, 'sunset'),
  PARK(19.15, 'dusk'),
  PARK(21.5, 'night'),
  {
    name: 'detail_noon',
    setup: `async () => { window.__sim.start('telnof_36', { time: 12.5, camera: 'chase' }); window.__sim.step(60); }`,
    shots: [
      { name: 'nozzle', cam: [12, 4, 9, 35] },
      { name: 'gear_left', cam: [-118, -2, 8.5, 40] },
      { name: 'top', cam: [20, 62, 22, 40] },
    ],
  },
  {
    name: 'air_noon',
    setup: `async () => { window.__sim.start('tlv_3000', { time: 12.5, camera: 'chase' }); window.__sim.step(120); }`,
    shots: [
      { name: 'chase', cam: 'chase' },
      { name: 'flyby', cam: 'flyby' },
      { name: 'below34', cam: [-130, -25, 24, 40] },
      { name: 'side', cam: [95, 6, 26, 40] },
      { name: 'above', cam: [150, 35, 26, 40] },
    ],
  },
  {
    name: 'air_sunset',
    setup: `async () => { window.__sim.start('jerusalem_sunset', { camera: 'chase' }); window.__sim.step(120); }`,
    shots: [
      { name: 'chase', cam: 'chase' },
      { name: 'flyby', cam: 'flyby' },
      { name: 'side', cam: [95, 6, 26, 40] },
      { name: 'front34', cam: [-140, 8, 24, 40] },
    ],
  },
  {
    name: 'ab_roll_noon',
    setup: AB_ROLL('telnof_36', 12.5),
    shots: [{ name: 'chase', cam: 'chase', measure: ['nozzle'] }, { name: 'side', cam: [100, 3, 20, 40] },
      { name: 'rear34', cam: [28, 6, 18, 40] }],
  },
  {
    name: 'ab_roll_sunset',
    setup: AB_ROLL('telnof_36', 18.9),
    shots: [{ name: 'chase', cam: 'chase', measure: ['nozzle'], check: warmNozzle }, { name: 'rear34', cam: [28, 6, 18, 40] }],
  },
  {
    name: 'ab_roll_dusk',
    setup: AB_ROLL('bengurion_26', 19.05),
    shots: [{ name: 'chase', cam: 'chase', measure: ['nozzle'], check: warmNozzle }, { name: 'side', cam: [100, 3, 20, 40] },
      { name: 'front34', cam: [-140, 4, 21, 40] }, { name: 'pool', cam: POOL_CAM, measure: ['poolNear'], check: duskPool }],
  },
  {
    name: 'ab_roll_night',
    setup: AB_ROLL('telnof_36', 21.5),
    shots: [{ name: 'chase', cam: 'chase', measure: ['nozzle'], check: warmNozzle }, { name: 'side', cam: [100, 3, 20, 40] },
      { name: 'rear34', cam: [28, 6, 18, 40] }, { name: 'pool', cam: POOL_CAM, measure: ['poolNear'], check: nightPool }],
  },
  {
    // night approach to Tel Nof 36: the landing light must light the touchdown zone ahead
    name: 'land_night',
    setup: `async () => { const S = window.__sim;
      S.start('telnof_final', { time: 21.5, camera: 'chase' }); S.autopilot('land');
      const r = S.fly({ until: 'flare', seconds: 150 }); return r; }`,
    shots: [{ name: 'approach', cam: APPROACH_CAM, measure: ['poolApp'], check: approachPool },
      { name: 'chase', cam: 'chase' }, { name: 'side', cam: [100, 3, 30, 45] }, { name: 'cockpit', cam: 'cockpit' }],
  },
  {
    name: 'ab_air_noon',
    setup: `async () => { const S = window.__sim; S.start('tlv_3000', { time: 12.5, camera: 'chase' });
      S.setInput({ throttle: 1 }); S.step(360); }`,
    shots: [{ name: 'side', cam: [95, 4, 24, 40] }, { name: 'front34_below', cam: [-150, -12, 26, 40] }, { name: 'chase', cam: 'chase' }],
  },
  {
    name: 'turn7g_noon',
    setup: `async () => { const ac = window.__ac, S = window.__sim;
      ac.spawn('ac_turn', 'coast_low', { y: 300, speed_ms: 240, heading_deg: 20 });
      S.start('ac_turn', { time: 12.5, camera: 'chase' }); ac.hold(78, 7, 6, 1); }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'above', cam: [160, 30, 28, 40] }, { name: 'rear34', cam: [30, 12, 24, 40] },
      // the sheets seen from ahead (edge-on: no bright lines) and from the side above the wing
      { name: 'front', cam: [180, 4, 30, 40] }, { name: 'side_top', cam: [95, 35, 26, 40] }],
  },
  {
    name: 'm098_sea',
    setup: `async () => { const ac = window.__ac, S = window.__sim;
      ac.spawn('ac_m098', 'coast_low', { x: -47000, y: 100, speed_ms: 334, heading_deg: 20 });
      S.start('ac_m098', { time: 12.5, camera: 'chase' }); S.setInput({ throttle: 1, pitch: 0.0 }); S.step(240); }`,
    shots: [{ name: 'side', cam: [95, 3, 30, 40] }, { name: 'chase', cam: 'chase' }, { name: 'front34', cam: [-145, 6, 30, 40] },
      { name: 'behind', cam: [0, 2, 30, 40] }, { name: 'front', cam: [180, 2, 34, 40] }],
  },
  {
    name: 'contrail_10km',
    setup: `async () => { const ac = window.__ac, S = window.__sim;
      ac.spawn('ac_hi', 'tlv_3000', { y: 10000, speed_ms: 250, heading_deg: 180 });
      S.start('ac_hi', { time: 12.5, camera: 'chase' }); S.setInput({ throttle: 0.8 }); S.step(1200); }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'side_far', cam: [110, 10, 140, 40] }],
  },
  {
    // the contrail after a minute: it must fade out over its life, not end bluntly where its
    // point buffer runs out
    name: 'contrail_end',
    setup: `async () => { const ac = window.__ac, S = window.__sim;
      ac.spawn('ac_hi2', 'tlv_3000', { y: 10000, speed_ms: 270, heading_deg: 180 });
      S.start('ac_hi2', { time: 12.5, camera: 'chase' }); S.setInput({ throttle: 0.85 }); S.step(120 * 40); }`,
    shots: [{ name: 'side_far', cam: [100, 8, 2600, 40], measure: ['contrail'], check: contrailEnd },
      { name: 'behind_high', cam: [8, 12, 400, 50] }],
  },
  {
    // nav lights at night from 600 m: coloured points, not white dots with a coloured rim
    name: 'night_far',
    setup: `async () => { window.__sim.start('tlv_3000', { time: 21.5, camera: 'chase' }); window.__sim.step(120); }`,
    shots: [{ name: 'front_600', cam: [-160, 3, 600, 12], measure: ['nav'], check: navColour },
      { name: 'side_150', cam: [80, 3, 150, 25], measure: ['nav'] }],
  },
  {
    name: 'land_bgn_dusk',
    setup: `async () => { const ac = window.__ac, S = window.__sim;
      // 4 km final to Ben Gurion 26 (threshold -11936, -24251; heading 259.8)
      const h = 259.8 * Math.PI / 180, d = 4000;
      ac.spawn('ac_bgn_final', 'telnof_final', { x: -11936 + Math.sin(h) * -d, z: -24251 - Math.cos(h) * -d,
        y: 39.3 + d * Math.tan(3 * Math.PI / 180) + 15, heading_deg: 259.8, airport: 'LLBG', runway: '26' });
      S.start('ac_bgn_final', { time: 19.15, camera: 'chase' });
      S.autopilot('land', { runway: '26', icao: 'LLBG' });
      const r = S.fly({ until: 'touchdown', seconds: 120 }); S.step(30); return r; }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'side', cam: [100, 3, 26, 40] }, { name: 'tower', cam: 'tower' }],
  },
  {
    name: 'gear_up',
    setup: `async () => { window.__sim.start('tlv_3000', { time: 12.5, camera: 'chase' }); window.__sim.step(120); }`,
    shots: [{ name: 'below', cam: [-90, -70, 18, 40] }, { name: 'below_rear', cam: [20, -35, 18, 40] }],
  },
];

async function startServer() {
  const py = process.env.PYTHON || 'python3';
  const proc = spawn(py, [join(ROOT, 'serve.py'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + 'index.html');
      if (r.ok) {
        if (!out.includes(`:${PORT}/`)) { proc.kill(); throw new Error(`serve.py did not take port ${PORT}:\n${out}`); }
        return proc;
      }
    } catch (e) {
      if (String(e.message).includes('did not take')) throw e;
    }
    await sleep(200);
  }
  proc.kill();
  throw new Error(`serve.py did not start:\n${out}`);
}

function selected(scene) {
  if (!ONLY) return true;
  return ONLY.some((o) => scene.name === o || scene.name.startsWith(o));
}

async function main() {
  if (argv.includes('--list')) { for (const s of SCENES) console.log(s.name, s.shots.map((x) => x.name).join(' ')); return; }
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const problems = [];
  const checkFails = [];
  const report = { quality: QUALITY, size: [W, H], shots: [] };
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      if (m.type() === 'warning' && !/ReadPixels|GPU stall/.test(m.text())) log('warn:', m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
    page.setDefaultTimeout(600000);
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 600000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    await page.evaluate(PAGE_HELPERS);
    await page.addStyleTag({ content: '#toast { display: none !important; }' });
    log('loaded');
    for (const sc of SCENES) {
      if (!selected(sc)) continue;
      if (PRE) await page.evaluate(PRE);
      const setupResult = await page.evaluate(`(${sc.setup})()`);
      const sum = await page.evaluate(() => window.__sim.summary());
      log(`${sc.name}: ${sum.ias_kt} kt, alt ${sum.alt_m} m, g ${sum.g}, ab ${sum.ab}, gear ${sum.gear}, t ${sum.time} h`
        + (setupResult && setupResult.pilot ? `, pilot ${setupResult.pilot.phase}` : ''));
      if (POST) await page.evaluate(POST);
      for (const sh of sc.shots) {
        if (SHOTS && !SHOTS.includes(sh.name)) continue;
        if (Array.isArray(sh.cam)) await page.evaluate((c) => window.__ac.orbit(...c), sh.cam);
        else await page.evaluate((c) => window.__sim.camera(c), sh.cam);
        await page.evaluate(() => window.__sim.settle(1800));
        for (const v of VARIANTS) {
          if (v.js) await page.evaluate(v.js);
          // a second frame: the exposure and the environment map catch up after a time jump
          const ri = await page.evaluate(() => window.__sim.render());
          const name = `${sc.name}_${sh.name}${v.tag ? '_' + v.tag : ''}.png`;
          const file = join(OUT, name);
          // measurements of this frame (before the screenshot: the same frame)
          const measured = {};
          for (const k of sh.measure || []) measured[k] = await page.evaluate(MEASURE[k] || k);
          await page.screenshot({ path: file });
          const mem = await page.evaluate(() => window.__sim.gpuMemory());
          const exp = await page.evaluate(() => window.__sim.app.renderer.toneMappingExposure);
          const fails = sh.check ? sh.check(measured) : [];
          for (const f of fails) checkFails.push(`${name}: ${f}`);
          report.shots.push({ file, scene: sc.name, shot: sh.name, variant: v.tag, calls: ri.calls, triangles: ri.triangles,
            ms: ri.ms, programs: ri.programs, gpuMB: mem.totalMB, exposure: +exp.toFixed(3), summary: sum,
            ...(sh.measure ? { measured } : {}), ...(sh.check ? { check: fails.length ? fails : 'ok' } : {}) });
          log(`  ${name}  ${ri.calls} calls, ${(ri.triangles / 1e6).toFixed(2)} M tris, ${ri.ms} ms, `
            + `GPU ~${mem.totalMB} MB, exposure ${exp.toFixed(2)}`);
          if (sh.measure) log(`    measured ${JSON.stringify(measured, (k, x) => (k === 'programs' ? x.length : x))}`);
          if (sh.check) log(`    check: ${fails.length ? 'FAIL ' + fails.join('; ') : 'ok'}`);
        }
      }
    }
  } finally {
    writeFileSync(join(OUT, 'report.json'), JSON.stringify({ ...report, problems, checkFails }, null, 1));
    await browser.close();
    server.kill();
  }
  if (problems.length) {
    console.log('PROBLEMS:\n  ' + problems.slice(0, 20).join('\n  '));
    process.exitCode = 1;
  }
  if (checkFails.length) {
    console.log('FAILED CHECKS:\n  ' + checkFails.join('\n  '));
    process.exitCode = 1;
  }
  log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
