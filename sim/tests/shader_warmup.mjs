// Shader warm-up probe: which shader programs (and first texture uploads) does the app make AFTER
// the loading screen? Every one of them is a main-thread stall on the PC (ANGLE / Direct3D 11:
// ~100-850 ms per program the first time it is drawn), so the lists this prints should be empty.
//
//   node sim/tests/shader_warmup.mjs [--port 8400] [--out DIR] [--size 960x540] [--quality high]
//                                    [--phases menu,flight,cameras,burner,gear,vapour,wingmen,time,quality,stream]
//                                    [--root SIM_FOLDER] [--extra 'post=0'] [--frames 4]
//
// --phases shots: only the noon and 21:30 views (cmp_*.png) for comparing two versions pixel by
// pixel (run both with --extra clouds=clear; --root serves the other checkout), each taken once
// the vegetation is idle and after two settled frames. A server already on --port is used as it is.
//
// Headless Chromium with SwiftShader (Playwright), index.html?test=1. The page's WebGL2 context is
// hooked before the app starts (compileShader, linkProgram, the texture uploads, the synchronous
// queries), and the app's renderer.info.programs is read after every frame, so each phase lists
// the programs created in it by name (the material's name or type) with the GL calls and the
// slowest frame. SwiftShader compiles too: its times are not the PC's, but a program made in a
// phase shows the same way. Report: <out>/shader_warmup.json; screenshots of the noon and night
// scenes (<out>/*.png) to compare before / after a change.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const PORT = +arg('port', 8400);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/startup/probe'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const EXTRA = arg('extra', '');
const FRAMES = +arg('frames', 4);
const PHASES = arg('phases', 'menu,flight,cameras,burner,gear,vapour,wingmen,time,quality,stream').split(',');
const BASE = `http://127.0.0.1:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[warmup ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// ---------------------------------------------------------------------------------------------
// in the page, before any script: count the GL calls that compile, link, upload or wait
const HOOK = () => {
  const P = window.__probe = { phase: 'load', phases: {}, frame: 0 };
  const cur = () => P.phases[P.phase] || (P.phases[P.phase] = { calls: {}, ms: {}, uploads: [], frames: [] });
  // the page's long tasks (script that kept it from drawing for 50 ms or more), by phase
  try {
    new PerformanceObserver((l) => {
      const c = cur();
      for (const e of l.getEntries()) (c.long || (c.long = [])).push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* no long task timing */ }
  const proto = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  if (!proto) return;
  const UP = new Set(['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D', 'copyTexImage2D']);
  const size = (name, a) => {
    // texImage2D(target, level, internalformat, width, height, border, format, type, src) or (..., format, type, source)
    if (name === 'texImage2D' || name === 'texSubImage2D') {
      if (a.length >= 8 && typeof a[3] === 'number' && typeof a[4] === 'number') return [a[3], a[4], 1, a[1]];
      const s = a[a.length - 1];
      return [s && (s.width || s.videoWidth) || 0, s && (s.height || s.videoHeight) || 0, 1, a[1]];
    }
    if (name === 'texImage3D' || name === 'texSubImage3D') return [a[3], a[4], a[5], a[1]];
    return [0, 0, 0, a[1]];
  };
  for (const name of ['compileShader', 'linkProgram', 'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D',
    'texStorage2D', 'texStorage3D', 'compressedTexImage2D', 'generateMipmap', 'getProgramParameter',
    'getShaderParameter', 'getProgramInfoLog', 'readPixels', 'getError', 'finish', 'clientWaitSync', 'getBufferSubData']) {
    const f = proto[name];
    if (typeof f !== 'function') continue;
    proto[name] = function (...a) {
      const t = performance.now();
      const r = f.apply(this, a);
      const dt = performance.now() - t;
      const c = cur();
      c.calls[name] = (c.calls[name] || 0) + 1;
      c.ms[name] = (c.ms[name] || 0) + dt;
      if (UP.has(name) && a[1] === 0) {
        const [w, h, d] = size(name, a);
        if (w * h * d >= 256 * 256) c.uploads.push({ name, w, h, d, ms: +dt.toFixed(1) });
      }
      return r;
    };
  }
};

// ---------------------------------------------------------------------------------------------
// in the page, after the app is up: frames with the programs they created
const INSTALL = () => {
  const P = window.__probe, app = window.__sim.app, r = app.renderer;
  const info = (p) => ({ id: p.id, name: p.name || p.type || '?', type: p.type, key: hash(p.cacheKey) });
  function hash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); }
  P.seen = new Set(r.info.programs.map((p) => p.id));
  P.newPrograms = () => {
    const out = [];
    for (const p of r.info.programs) if (!P.seen.has(p.id)) { P.seen.add(p.id); out.push(info(p)); }
    return out;
  };
  P.programs = () => r.info.programs.map(info);
  // every drawn frame: its time and the programs it created
  const raw = app._render.bind(app);
  app._render = (dt, f, alpha, draw = true) => {
    if (!draw) return raw(dt, f, alpha, draw);
    const t = performance.now();
    const before = { ...(P.phases[P.phase]?.calls || {}) };
    const res = raw(dt, f, alpha, draw);
    const gl = r.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ms = performance.now() - t;
    const c = P.phases[P.phase] || (P.phases[P.phase] = { calls: {}, ms: {}, uploads: [], frames: [] });
    const after = c.calls;
    const progs = P.newPrograms();
    c.frames.push({ n: ++P.frame, ms: +ms.toFixed(0), state: app.state, camera: app.cams.mode, time: +app.settings.time.toFixed(2),
      compiles: (after.compileShader || 0) - (before.compileShader || 0), links: (after.linkProgram || 0) - (before.linkProgram || 0),
      programs: progs.map((p) => p.name) });
    (c.created || (c.created = [])).push(...progs);
    return res;
  };
};

async function startServer() {
  // a server already on the port (serve.py started by hand): used as it is
  try { if ((await fetch(BASE + 'index.html')).ok) return null; } catch (e) { /* none: start one */ }
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const problems = [];
  const report = { when: new Date().toISOString(), size: [W, H], quality: QUALITY, extra: EXTRA, phases: {}, problems };
  const save = () => {
    report.totalAfterLoad = Object.values(report.phases).reduce((a, p) => a + p.count, 0);
    writeFileSync(join(OUT, 'shader_warmup.json'), JSON.stringify(report, null, 1));
  };
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      if (/warmup|shader|program/i.test(m.text())) log('page:', m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.setDefaultTimeout(600000);
    await page.addInitScript(HOOK);
    const tl = Date.now();
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${EXTRA ? `&${EXTRA}` : ''}`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 600000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    report.loadS = +((Date.now() - tl) / 1000).toFixed(1);
    await page.evaluate(INSTALL);
    const S = (fn, a) => page.evaluate(fn, a);
    const ext = await S(() => {
      const gl = window.__sim.app.renderer.getContext();
      return { parallel: !!gl.getExtension('KHR_parallel_shader_compile'), programs: window.__sim.app.renderer.info.programs.length,
        warmup: window.__sim.app.warmup ? window.__sim.app.warmup.info?.() || true : null };
    });
    report.load = { ...ext, gl: await S(() => window.__probe.phases.load), gpuMemory: await S(() => window.__sim.gpuMemory?.() || null) };
    log(`loaded in ${report.loadS} s: ${ext.programs} programs, KHR_parallel_shader_compile ${ext.parallel}`);
    // the loading screen's long tasks: the page drew nothing during each one
    const long = (report.load.gl?.long || []).map((x) => x[1]).sort((a, b) => b - a);
    report.load.longTasks = { count: long.length, over200: long.filter((d) => d > 200).length, over500: long.filter((d) => d > 500).length,
      over1000: long.filter((d) => d > 1000).length, longest: long.slice(0, 8) };
    log(`loading: ${long.length} long tasks, ${report.load.longTasks.over500} over 0.5 s, longest ${long.slice(0, 8).join(', ')} ms`);

    const phase = (name) => S((n) => { window.__probe.phase = n; window.__probe.newPrograms(); }, name);
    const frames = async (n, dt = 0.25) => { for (let i = 0; i < n; i++) await S((d) => window.__sim.advance(d), dt); };
    const done = async (name) => {
      const p = await S((n) => window.__probe.phases[n] || null, name);
      const created = (p && p.created) || [];
      const worst = p && p.frames.length ? Math.max(...p.frames.map((f) => f.ms)) : 0;
      report.phases[name] = { programs: created.map((c) => c.name), count: created.length, worstFrameMs: worst,
        calls: p ? p.calls : {}, uploads: p ? p.uploads : [], frames: p ? p.frames : [], longTasks: p ? p.long || [] : [] };
      log(`${name.padEnd(18)} ${String(created.length).padStart(3)} new programs${created.length ? `: ${created.map((c) => c.name).join(', ')}` : ''}` +
        `; ${(p?.calls?.texImage2D || 0) + (p?.calls?.texSubImage2D || 0) + (p?.calls?.texImage3D || 0)} uploads (${(p?.uploads || []).length} >= 256^2); worst frame ${worst} ms`);
      save();       // after every phase: a crash later leaves what was measured
    };
    const shot = async (name) => { const f = join(OUT, `${name}.png`); await page.screenshot({ path: f }); return f; };

    // ------------------------------------------------------------------ the menu (orbit backdrop)
    if (PHASES.includes('menu')) {
      await phase('menu');
      for (let i = 0; i < 3; i++) await S(() => window.__sim.render());
      await done('menu');
      await shot('menu');
    }
    // ------------------------------------------------------------------ a flight from the menu
    if (PHASES.includes('flight')) {
      await phase('flight');
      await S(() => window.__sim.start('telnof_36', { time: 12, camera: 'cockpit' }));
      await frames(FRAMES);
      await done('flight');
      await shot('noon_telnof36_cockpit');
    }
    if (PHASES.includes('cameras')) {
      for (const m of ['chase', 'tower', 'flyby', 'orbit', 'cockpit']) {
        await phase(`camera_${m}`);
        await S((c) => window.__sim.camera(c), m);
        await frames(2, 0.1);
        await done(`camera_${m}`);
        if (m === 'chase') await shot('noon_telnof36_chase');
      }
    }
    if (PHASES.includes('burner')) {
      await phase('burner');
      await S(() => { window.__sim.camera('chase'); window.__sim.setInput({ throttle: 1, brake: 0, parkingBrake: false }); });
      await frames(3, 0.5);
      await done('burner');
    }
    if (PHASES.includes('gear')) {
      // take-off: the gear and the doors move
      await phase('gear');
      await S(() => { window.__sim.start('telnof_36', { time: 12, camera: 'chase' }); window.__sim.autopilot('takeoff', { altitude: 1500, heading: 0 }); });
      await S(() => window.__sim.fly({ until: 'gear up', seconds: 60 }));
      await frames(4, 0.6);
      await done('gear');
    }
    if (PHASES.includes('vapour')) {
      await phase('vapour');
      await S(() => { window.__sim.start('coast_low', { time: 12, camera: 'chase' }); window.__sim.setInput({ throttle: 1, pitch: 0.9 }); });
      await frames(4, 0.4);
      await S(() => window.__sim.setInput({ pitch: 0, throttle: 0.8 }));
      await done('vapour');
    }
    if (PHASES.includes('wingmen')) {
      await phase('wingmen');
      await S(() => { window.__sim.start('tlv_3000', { time: 12, camera: 'chase' }); window.__sim.app.setOption('wingmen', true); });
      await page.waitForFunction(() => !!window.__sim.app.wingmen, null, { timeout: 120000 }).catch(() => {});
      await frames(4, 0.5);
      await done('wingmen');
      await S(() => window.__sim.app.setOption('wingmen', false));
    }
    if (PHASES.includes('time')) {
      await S(() => window.__sim.start('bengurion_26', { time: 12, camera: 'chase' }));
      for (const [h, m] of [[19.25, 'chase'], [21.5, 'chase'], [21.5, 'cockpit'], [5.0, 'chase'], [12, 'chase']]) {
        const nm = `time_${h}_${m}`;
        await phase(nm);
        await S(({ h, m }) => { window.__sim.time(h); window.__sim.camera(m); }, { h, m });
        await frames(2, 0.2);
        await done(nm);
        if (h === 21.5) await shot(`night_bengurion26_${m}`);
      }
    }
    if (PHASES.includes('quality')) {
      for (const q of ['low', 'medium', 'high']) {
        await phase(`quality_${q}`);
        await S((x) => window.__sim.app.setQuality(x), q);
        await frames(2, 0.2);
        await done(`quality_${q}`);
      }
    }
    if (PHASES.includes('stream')) {
      // low over Tel Aviv: buildings, roads, trees and street lamps stream in
      await phase('stream');
      await S(() => {
        const sim = window.__sim, app = sim.app;
        const sp = app.terrain.spawns.tlv_3000;
        app.terrain.spawns._probe = { ...sp, label: 'probe', y: app.terrain.heightAt(sp.x, sp.z) + 250, speed_ms: 140, gear: 0 };
        sim.start('_probe', { time: 12, camera: 'chase' });
      });
      for (let i = 0; i < 6; i++) { await S(() => window.__sim.settle(2500)); await frames(1, 1.0); }
      await done('stream');
      await shot('noon_tlv250_chase');
      await phase('stream_night');
      await S(() => window.__sim.time(21.5));
      for (let i = 0; i < 3; i++) { await S(() => window.__sim.settle(1500)); }
      await done('stream_night');
      await shot('night_tlv250_chase');
    }
    if (PHASES.includes('shots')) {
      // the same views for a before / after comparison (run both with --extra clouds=clear): noon, 21:30
      await phase('shots');
      for (const [sp, h] of [['telnof_36', 12], ['bengurion_26', 21.5]]) {
        await S(({ sp, h }) => window.__sim.start(sp, { time: h, camera: 'chase' }), { sp, h });
        // the streaming modules idle first (the vegetation's start-up and cells): a version without
        // the warm-up starts them later, and what is compared is the settled picture. Update-only
        // frames, as settle() runs them (a drawn frame takes many seconds in SwiftShader), up to 90 s
        await S(async () => {
          const app = window.__sim.app, t0 = performance.now();
          const idle = () => app.modules.every((x) => typeof x.idle !== 'function' || x.idle());
          while (!idle() && performance.now() - t0 < 90000) {
            app._render(0.016, app.input.update(0), 1, false);
            app.env.update(app.camera, 0.04);
            await new Promise((r) => setTimeout(r, 40));
          }
        });
        for (const m of ['chase', 'cockpit']) {
          await S((c) => window.__sim.camera(c), m);
          // settle() draws a frame at its end: twice, because a version without the warm-up builds
          // its programs at the first frame, and one frame after a long compile is not the settled
          // picture yet (the shot is the second one)
          for (let k = 0; k < 2; k++) await S(() => window.__sim.settle(4000));
          await shot(`cmp_${sp}_${String(h).replace('.', '')}_${m}`);
        }
      }
      await done('shots');
    }
    report.programsAtEnd = await S(() => window.__probe.programs().map((p) => p.name));
    // the same point in two versions: what the warm-up costs in memory, and the last frame's draws
    report.gpuMemoryAtEnd = await S(() => window.__sim.gpuMemory?.() || null);
    report.renderInfoAtEnd = await S(() => window.__sim.renderInfo?.() || null);
    // what the app's own warm-up logged (js/env/warmup.js): its start-up pass and its misses
    report.warmup = await S(() => window.__sim.app.warmup?.info?.() || null);
  } finally {
    await browser.close();
    server?.kill();
  }
  save();
  const total = report.totalAfterLoad;
  log(`${total} programs created after the loading screen (${Object.keys(report.phases).length} phases); report ${join(OUT, 'shader_warmup.json')}`);
  if (problems.length) log('problems:', problems.slice(0, 5).join(' | '));
}

main().catch((e) => { console.error('[warmup]', e); process.exit(1); });
