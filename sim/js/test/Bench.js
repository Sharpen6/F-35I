// index.html?bench=1: a scripted 60 s flight that measures the frame rate on this machine.
//
// From telnof_36 (or ?spawn=<name>; an airborne spawn flies straight on at its altitude) the
// scripted pilot (TestPilot.js) takes off on the centreline with MIL then afterburner, rotates at
// 150 kt, raises the gear, climbs and turns toward Tel Aviv. The view changes on a fixed script
// (chase, cockpit, fly-by, chase) so every camera is measured. The first 3 s (shader compiles,
// first tiles) are left out of the statistics. At the end the sim stops and the results are drawn
// over the last frame: average and 1 % low fps (the mean frame rate of the slowest 1 % of frames),
// frame-time percentiles, draw calls and triangles per frame, and an estimate of the GPU memory the
// app uploaded. They are also in window.__bench ({done, results}) and the console ("BENCH {...}").
// Options: &time=<h> (default 12), &quality=low|medium|high, &seconds=<n> (default 60).

import { TestPilot, findRunway } from './TestPilot.js';
import { estimateGpuMemory, frameStats, gpuName } from './stats.js';

const KT = 0.514444;
const TEL_AVIV = { x: -23130, z: -31074 };
const CAMERA_SCRIPT = [[0, 'chase'], [25, 'cockpit'], [42, 'flyby'], [50, 'chase']];

function box() {
  const el = document.createElement('div');
  el.id = 'bench';
  el.style.cssText = 'position:fixed;left:12px;top:12px;z-index:50;padding:10px 14px;background:rgba(0,0,0,0.62);'
    + 'color:#9f9;font:14px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;max-width:calc(100vw - 52px);border-radius:6px;pointer-events:none';
  document.body.appendChild(el);
  return el;
}

export function runBench(app) {
  const params = new URLSearchParams(location.search);
  const seconds = Math.max(5, +(params.get('seconds') || 60));
  const warmup = Math.min(3, seconds / 10);
  const spawns = app.terrain.spawns;
  const name = spawns[params.get('spawn')] ? params.get('spawn') : (spawns.telnof_36 ? 'telnof_36' : Object.keys(spawns)[0]);
  app.selectSpawn(name);
  if (!params.has('time') && !Number.isFinite(app.spawn.time_h)) app.setTimeOfDay(12, true);
  app.settings.camera = 'chase';
  app.live = true;
  app.startFlight();
  const sp = app.spawn;
  const onGround = sp.on_ground !== false;
  const rw = onGround && sp.runway ? findRunway(app.terrain.airports, sp.runway, sp.airport) : null;
  const pilot = new TestPilot({
    plan: 'takeoff', runway: rw, altitude: onGround ? 3000 : sp.y, target: TEL_AVIV,
    cruiseKt: onGround ? 350 : (sp.speed_ms || 200) / KT, throttle: app.input.levers.throttle,
  });
  if (!onGround) { pilot.phase = 'cruise'; pilot.target = null; pilot.heading = sp.heading_deg; }
  app.testPilot = pilot;

  const el = box();
  const frames = [], calls = [], tris = [];
  let t = 0, cam = 0, shown = -1;
  const finish = () => {
    app.onFrame = null;
    app.testPilot = null;
    app.testInput = null;
    app.live = false;                      // freeze on the last frame
    const fs = frameStats(frames);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const mem = estimateGpuMemory(app.renderer, app.scene);
    const c = app.renderer.domElement;
    const results = {
      spawn: name, time_h: app.settings.time, quality: app.settings.quality, seconds, warmup,
      size: [c.width, c.height], pixelRatio: app.renderer.getPixelRatio(), gpu: gpuName(app.renderer),
      ...fs,
      drawCallsAvg: Math.round(avg(calls)), drawCallsMax: Math.max(0, ...calls),
      trianglesAvg: Math.round(avg(tris)), trianglesMax: Math.max(0, ...tris),
      gpuMemoryMB: mem.totalMB, gpuMemory: mem,
      flight: { phase: pilot.phase, events: pilot.events, crashed: app.fdm.state.crashed },
    };
    window.__bench = { done: true, results };
    document.title = 'F-35I bench: done';
    console.log('BENCH ' + JSON.stringify(results));
    const M = (n) => (n / 1e6).toFixed(2) + ' M';
    el.style.font = '16px/1.5 ui-monospace,Consolas,monospace';
    el.textContent = [
      `F-35I BENCH  ${seconds} s from ${name}, ${app.settings.time.toFixed(2)} h, quality ${results.quality}`,
      `${c.width} x ${c.height} px (pixel ratio ${results.pixelRatio}), ${results.gpu}`,
      '',
      `average  ${fs.avgFps} fps        1% low  ${fs.low1Fps} fps        min ${fs.minFps} fps`,
      `frame    p50 ${fs.p50Ms} ms   p99 ${fs.p99Ms} ms   max ${fs.maxMs} ms   (${fs.frames} frames after ${warmup} s warm-up)`,
      `draw calls   avg ${results.drawCallsAvg}   max ${results.drawCallsMax}`,
      `triangles    avg ${M(results.trianglesAvg)}   max ${M(results.trianglesMax)}`,
      `GPU memory   ~${mem.totalMB} MB (textures ${mem.texturesMB}, geometry ${mem.geometryMB}, targets ${mem.targetsMB}, framebuffer ${mem.framebufferMB})`,
      `flight       ${pilot.phase}${app.fdm.state.crashed ? ', CRASHED' : ''}`,
    ].join('\n');
  };
  app.onFrame = (raw) => {
    if (app.state !== 'flying' || app.ui.overlay) return;   // paused: not measured
    t += raw;
    while (cam < CAMERA_SCRIPT.length && t >= CAMERA_SCRIPT[cam][0]) app.cams.setMode(CAMERA_SCRIPT[cam++][1]);
    if (t > warmup) {
      frames.push(raw * 1000);
      const i = app.renderer.info.render;
      calls.push(i.calls);
      tris.push(i.triangles);
    }
    const s = Math.floor(t * 2);
    if (s !== shown) {
      shown = s;
      el.textContent = `BENCH  ${t.toFixed(0)} / ${seconds} s   ${app.fps.toFixed(0)} fps   ${app.cams.mode}   ${pilot.phase}`;
    }
    if (t >= seconds) finish();
  };
}
