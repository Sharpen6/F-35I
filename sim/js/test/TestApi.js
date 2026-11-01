// window.__sim: the app's automation API, installed with index.html?test=1 (tests/e2e.mjs,
// tests/smoke.mjs, or by hand from the console). In test mode the app's own render loop is paused
// (window.__sim.resume() starts it); the test drives the simulation in fixed 1/120 s steps and
// draws a frame only when asked, so a slow software renderer (SwiftShader) is never in the way.
//
//   loop      pause(), resume(), live
//   setup     start(spawn, {time, camera}), camera(mode) / view(mode), time(hours)
//   inputs    setInput({pitch, roll, yaw, throttle, brake, gear, parkingBrake, speedbrake, canopy,
//             nws}), clearInput(), autopilot(plan, opts) / autopilot(null), pilot()
//   running   step(n), advance(seconds, draw), fly({until, seconds}), settle(ms), render()
//   readouts  summary(), fdm(), visual(), gear(), runway(id, icao), hmd(), renderInfo(), timing(),
//             gpuMemory()
// See sim/README.md ("Test API") for the details.

import * as THREE from 'three';
import { TestPilot, findRunway, runwayFrame } from './TestPilot.js';
import { estimateGpuMemory, renderInfo, gpuName } from './stats.js';

const _v = new THREE.Vector3();
const _px = new Uint8Array(4);

/** Any state object as plain JSON (vectors and quaternions become arrays). */
export function plain(o, depth = 0) {
  if (typeof o === 'number') return Number.isFinite(o) ? +o.toPrecision(10) : null;
  if (o == null || typeof o !== 'object') return o;
  if (o.isVector3) return [o.x, o.y, o.z].map((v) => +v.toFixed(4));
  if (o.isQuaternion) return [o.x, o.y, o.z, o.w].map((v) => +v.toFixed(6));
  if (o.isColor) return [o.r, o.g, o.b].map((v) => +v.toFixed(4));
  if (depth > 4) return undefined;
  if (Array.isArray(o)) return o.map((v) => plain(v, depth + 1));
  const r = {};
  for (const k in o) {
    const v = o[k];
    if (typeof v !== 'function') r[k] = plain(v, depth + 1);
  }
  return r;
}

export function installTestApi(app, { H, KT, DEG }) {
  const T = { steps: 0, stepMs: 0, renders: 0, renderMs: 0, lastRenderMs: 0, lastInfo: null };

  /** n fixed physics steps, as the live loop does them, without drawing. */
  function physics(n) {
    const t0 = performance.now();
    let f = null;
    for (let i = 0; i < n; i++) {
      f = app.input.update(H);
      app._applyTestInput(f, H);
      app._handleEdges(f);
      if (app.state === 'flying' && !app.ui.overlay) app._step(f);
      // cameras, crash handling and terrain streaming follow every 0.1 s (no GPU work)
      if (i % 12 === 11) app._render(H * 12, f, 1, false);
    }
    if (n % 12 !== 0 || n === 0) app._render(H * (n % 12), f || app.input.update(0), 1, false);
    T.steps += n;
    T.stepMs += performance.now() - t0;
  }

  /** Draw one frame; the time includes the GPU (a one-pixel read waits for it; gl.finish does not). */
  function draw() {
    const t0 = performance.now();
    app._render(0.016, app.input.update(0), 1, true);
    const gl = app.renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _px);
    T.lastRenderMs = performance.now() - t0;
    T.renders++;
    T.renderMs += T.lastRenderMs;
    T.lastInfo = renderInfo(app.renderer);
    return { ms: +T.lastRenderMs.toFixed(1), ...T.lastInfo };
  }

  function wheelNode(g) {
    return g.node ? app.visual.root.getObjectByName(g.node) : null;
  }

  /** Lowest point of a wheel's meshes in world space (the tyre's bottom). */
  function tyreBottom(node) {
    let minY = Infinity, x = 0, z = 0;
    node.updateWorldMatrix(true, true);
    node.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        _v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        if (_v.y < minY) { minY = _v.y; x = _v.x; z = _v.z; }
      }
    });
    return [x, minY, z];
  }

  function spawnRunway() {
    const sp = app.spawn || {};
    return sp.runway ? findRunway(app.terrain.airports, sp.runway, sp.airport) : null;
  }

  const api = {
    app,
    get state() { return app.state; },
    get live() { return app.live; },
    spawns: () => Object.keys(app.terrain?.spawns || {}),

    // ------------------------------------------------------------------------ loop
    /** Stop the app's own requestAnimationFrame loop (test mode starts paused). */
    pause() { app.live = false; return true; },
    /** Let the app run in real time again (rendering every display frame). */
    resume() { app.live = true; app.last = performance.now(); return true; },
    setLive(on) { return on ? api.resume() : api.pause(); },

    // ------------------------------------------------------------------------ setup
    /** Start flying at a spawn (as the Fly button does), hands off. opts: {time, camera}. */
    start(name, opts = {}) {
      app.testPilot = null;
      app.testInput = null;
      if (name) app.selectSpawn(name);
      if (opts.time != null) app.setTimeOfDay(opts.time, true);
      if (opts.camera) app.settings.camera = opts.camera;
      app.startFlight();
      return api.summary();
    },
    camera(mode) { app.cams.setMode(mode); app.settings.camera = mode; return app.cams.mode; },
    view(mode) { return api.camera(mode); },
    time(h) { app.setTimeOfDay(h, true); return app.settings.time; },

    // ------------------------------------------------------------------------ inputs
    /**
     * Override pilot inputs until changed (merged with the previous call; null clears all):
     * pitch, roll, yaw (-1..1, + = nose up / right / right), throttle (0..1, 0.75 = MIL, above = AB),
     * brake (0..1), gear (true = down), parkingBrake, speedbrake, canopy (true = open), nws.
     */
    setInput(o) { app.testInput = o ? { ...(app.testInput || {}), ...o } : null; return app.testInput; },
    clearInput() { app.testInput = null; app.testPilot = null; },
    /**
     * Scripted pilot (js/test/TestPilot.js) flying through the same inputs: plan 'takeoff' or
     * 'land'. opts: runway (end id, default the spawn's), icao, vrKt, altitude, heading | target {x, z},
     * cruiseKt, approachKt, glideDeg, aimM. autopilot(null) hands back to setInput / the keyboard.
     */
    autopilot(plan, opts = {}) {
      if (!plan) { app.testPilot = null; app.testInput = null; return null; }
      const rw = opts.runway ? findRunway(app.terrain.airports, opts.runway, opts.icao) : spawnRunway();
      app.testPilot = new TestPilot({ ...opts, plan, runway: rw, throttle: opts.throttle ?? app.input.levers.throttle });
      return api.pilot();
    },
    pilot() {
      const p = app.testPilot;
      return p ? { plan: p.plan, phase: p.phase, done: p.done, t: +p.t.toFixed(2), events: p.events.slice(), out: plain(p.out) } : null;
    },

    // ------------------------------------------------------------------------ running
    /** n fixed steps of 1/120 s, no drawing. */
    step(n = 1) { physics(Math.max(0, Math.round(n))); return api.summary(); },
    /** `seconds` of simulated time (fast), then draw one frame (draw = false: none). */
    advance(seconds, draw_ = true) {
      physics(Math.round(seconds / H));
      if (draw_) draw();
      return api.summary();
    },
    /**
     * Run until the scripted pilot reaches `until` (a phase name), is done, the jet crashes, or
     * `seconds` of simulated time pass. Returns the summary, the pilot and the elapsed time.
     */
    fly({ until = null, seconds = 300 } = {}) {
      const p = app.testPilot;
      let t = 0;
      while (t < seconds) {
        physics(12);
        t += 12 * H;
        const st = app.fdm.state;
        if (st.crashed || (p && (p.done || (until && p.phase === until)))) break;
      }
      return { t: +t.toFixed(2), summary: api.summary(), pilot: api.pilot() };
    },
    /**
     * Let `ms` of wall time pass without simulating (terrain tiles stream in; the terrain is updated
     * but not drawn, the exposure adapts), then draw one frame.
     */
    async settle(ms = 1500) {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        app._render(0.016, app.input.update(0), 1, false);
        app.env.update(app.camera, 0.04);
        await new Promise((r) => setTimeout(r, 40));
      }
      draw();
      return api.summary();
    },
    /** Draw one frame now: {ms, calls, triangles, points, lines, geometries, textures, programs}. */
    render() { return draw(); },

    // ------------------------------------------------------------------------ readouts
    summary() {
      const s = app.fdm?.state;
      if (!s) return { state: app.state };
      return {
        state: app.state, camera: app.cams.mode, ias_kt: +(s.ias / KT).toFixed(1), alt_m: +s.altitude.toFixed(1),
        agl_m: +(s.agl || 0).toFixed(2), vs: +(s.vs || 0).toFixed(2), onGround: !!s.onGround, gear: +(s.gear ?? 0).toFixed(3),
        throttle: +app.input.levers.throttle.toFixed(3), pitch_deg: +((s.pitch || 0) / DEG).toFixed(2),
        roll_deg: +((s.roll || 0) / DEG).toFixed(1), heading_deg: +((((s.heading || 0) / DEG) % 360 + 360) % 360).toFixed(1),
        g: +(s.gLoad || 1).toFixed(2), crashed: !!s.crashed, crashReason: s.crashReason || '',
        rpm: s.engine ? +(+s.engine.rpm || 0).toFixed(1) : null, ab: s.engine ? +(+s.engine.ab || 0).toFixed(2) : null,
        phase: app.testPilot ? app.testPilot.phase : null, time: +app.settings.time.toFixed(2),
        wingmen: app.wingmen ? app.wingmen.count : 0, fps: +app.fps.toFixed(1),
      };
    },
    /** The FlightModel state (sim/DESIGN.md) as plain JSON, SI units and radians. */
    fdm() { return plain(app.fdm.state); },
    /** What the AircraftVisual shows: rig control values, plume, glow, head, eye. */
    visual() {
      const v = app.visual;
      const ab = v.afterburner;
      return {
        loaded: v.loaded,
        rig: plain(v.player.values),
        given: plain(app._vc),
        headVisible: v.head ? v.head.visible : null,
        plume: ab ? { visible: ab.plume.visible, ab: +ab.ab.toFixed(3), length: +ab.uniforms.uLen.value.toFixed(2) } : null,
        glow: ab ? plain(ab.glowUniforms.uColour.value) : null,
        eye: plain(v.info.raw.eye), eyeWorld: plain(v.eyeWorld(new THREE.Vector3())),
        visible: v.object3d.visible,
      };
    },
    /**
     * Each wheel: FDM (wow, compression from extended, static compression), the modelled oleo
     * (compression from extended, rig static, rig control value) and the tyre's lowest point
     * against the terrain (gap < 0: the tyre is pressed into the ground, by design its deflection).
     */
    gear() {
      const v = app.visual, st = app.fdm.state;
      const rw = spawnRunway();
      return v.rig.info.gearContacts.map((g) => {
        const w = (st.wheels || []).find((x) => x.name === g.name) || {};
        const node = wheelNode(g);
        const b = node ? tyreBottom(node) : [NaN, NaN, NaN];
        const ground = app.terrain.heightAt(b[0], b[2]);
        const r = {
          name: g.name, wow: !!w.wow, fdmCompression: +(w.compression || 0).toFixed(4), fdmStatic: w.staticCompression,
          oleo: +app._strutFromFdm(w).toFixed(4), rigStatic: g.staticCompression, rigValue: +(v.player.values[g.control] ?? NaN).toFixed(4),
          travel: g.travel, tyreDeflection: g.tyreDeflection,
          tyreBottom: b.map((x) => +x.toFixed(3)), ground: +ground.toFixed(3), gap: +(b[1] - ground).toFixed(4),
          steer_deg: +((w.steer || 0) / DEG).toFixed(2),
        };
        if (rw) { const f = runwayFrame(rw, { x: b[0], z: b[2] }); r.along = +f.along.toFixed(2); r.cross = +f.cross.toFixed(3); }
        return r;
      });
    },
    /** The jet against a runway end (default: the spawn's): along / cross track (m), heading error. */
    runway(id = null, icao = null) {
      const rw = id ? findRunway(app.terrain.airports, id, icao) : spawnRunway();
      if (!rw) return null;
      const st = app.fdm.state;
      const f = runwayFrame(rw, st.position);
      const he = ((((st.heading - rw.hdg) / DEG) + 540) % 360) - 180;
      return {
        airport: rw.airport, id: rw.id, heading_deg: +(rw.hdg / DEG).toFixed(2), length: rw.length, width: rw.width,
        threshold: [rw.thr.x, rw.thr.y, rw.thr.z], along: +f.along.toFixed(2), cross: +f.cross.toFixed(3),
        headingError_deg: +he.toFixed(2), onRunway: f.along >= -1 && f.along <= rw.length + 1 && Math.abs(f.cross) <= rw.width / 2,
      };
    },
    /** The numbers the helmet display drew last (IAS kt, altitude ft, heading deg, g, ...). */
    hmd() { return app.hmd.last ? plain(app.hmd.last) : null; },
    /** renderer.info of the last frame drawn through render() / advance() / settle(). */
    renderInfo() { return T.lastInfo || renderInfo(app.renderer); },
    timing() {
      return {
        steps: T.steps, stepMsAvg: T.steps ? +(T.stepMs / T.steps).toFixed(4) : null,
        renders: T.renders, renderMsAvg: T.renders ? +(T.renderMs / T.renders).toFixed(1) : null,
        lastRenderMs: +T.lastRenderMs.toFixed(1), fps: +app.fps.toFixed(1), gpu: gpuName(app.renderer),
        pixelRatio: app.renderer.getPixelRatio(), size: [app.renderer.domElement.width, app.renderer.domElement.height],
      };
    },
    gpuMemory() { return estimateGpuMemory(app.renderer, app.scene); },
  };
  // keep the fields main.js set (ready / error) and the getters
  Object.defineProperties(window.__sim, Object.getOwnPropertyDescriptors(api));
  return window.__sim;
}
