// Screenshots of the vegetation scenes (trees, orchards, palms, shrubs) with frame statistics, for
// judging the look against reality and measuring the cost. Playwright + headless Chromium
// (SwiftShader WebGL2), driven through window.__sim (index.html?test=1), like tests/e2e.mjs.
//
//   node sim/tests/vegetation_shots.mjs [--port 8144] [--out DIR] [--size 960x540]
//        [--quality medium] [--only telnof_chase,orchards_150] [--params "vegetation=0"]
//        [--settle 6000] [--tag before] [--ab] [--shadow-radius 190] [--long]
//
// Every scene is a start point (spawns.json or one defined here, placed at a height above the
// ground) with a time of day and a camera; the scene is flown for a moment, the streaming is given
// wall time (--settle) and a frame is drawn. Writes <out>/<tag><scene>.png and <out>/<tag>stats.json
// (renderInfo, timing, the module's own stats, the GPU memory estimate per scene). --ab draws each
// scene three times with the trees and three times without (the same page, the same frame): the
// module's own draw calls, triangles and time (median; SwiftShader's, so only a ratio), and saves
// the frame without them (<tag><scene>_off.png).
//
// free_* scenes park the jet far away and place the camera by hand (pos: [x, height above the
// ground, z], or rel: offset from the jet; dir: heading and pitch in degrees), with the jet and the
// helmet display hidden: views from the ground and from the treetops that no flight gives.
// --shadow-radius R widens the main environment's shadow box around the jet to R m, as the
// lighting track's wide near-ground box does (so the near trees cast into the shadow map).
// --long flies 10 km at 250 m above the hills and fails when an upload failed or the module did
// not drain its queue (the buffer must never stall).

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
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
};
const ROOT = resolve(arg('root', join(here, '..')));
const PORT = +arg('port', 8144);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/vegetation'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'medium');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const PARAMS = arg('params', '');
const SETTLE = +arg('settle', 6000);
const TAG = arg('tag', '') ? `${arg('tag', '')}_` : '';
const AB = argv.includes('--ab');
const SHADOW_R = +arg('shadow-radius', 0);
const LONG = argv.includes('--long');
const BASE = `http://127.0.0.1:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[veg ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// Scenes: spawn (name in spawns.json, or {x, z, agl, heading, speed} placed here), time, camera,
// optional head look (cockpit yaw / pitch in degrees) and seconds flown before the shot.
const SCENES = {
  telnof_chase: { spawn: 'telnof_36', time: 12, camera: 'chase', fly: 0.5 },
  telnof_cockpit: { spawn: 'telnof_36', time: 12, camera: 'cockpit', fly: 0.5 },
  telnof_morning: { spawn: 'telnof_36', time: 7, camera: 'chase', fly: 0.5 },
  // the citrus blocks west of Tel Nof, 150 m above them, flying north toward them
  orchards_150: { spawn: { x: -24100, z: -3200, agl: 150, heading: 350, speed: 120 }, time: 10, camera: 'chase', fly: 1 },
  orchards_150_cockpit: { spawn: { x: -24100, z: -3200, agl: 150, heading: 350, speed: 120 }, time: 10, camera: 'cockpit', fly: 1 },
  // KKL forests: Ben Shemen (east of Lod) and the Jerusalem hills, 600 m above the ground
  benshemen_600: { spawn: { x: -9000, z: -15500, agl: 600, heading: 80, speed: 150 }, time: 9, camera: 'chase', fly: 1 },
  benshemen_600_cockpit: { spawn: { x: -9000, z: -15500, agl: 600, heading: 80, speed: 150 }, time: 9, camera: 'cockpit', fly: 1 },
  shaar_hagai_600: { spawn: { x: -3500, z: -1200, agl: 600, heading: 95, speed: 150 }, time: 15, camera: 'chase', fly: 1 },
  jerusalem_forest_600: { spawn: { x: 10500, z: 2500, agl: 600, heading: 60, speed: 150 }, time: 11, camera: 'chase', fly: 1 },
  // 3,000 m cruise over the foothills (forests, fields, villages) and over Tel Aviv
  cruise_3000: { spawn: { x: -9000, z: -5000, agl: 2900, heading: 90, speed: 200 }, time: 11, camera: 'chase', fly: 1 },
  cruise_3000_cockpit: { spawn: { x: -9000, z: -5000, agl: 2900, heading: 90, speed: 200 }, time: 11, camera: 'cockpit', fly: 1 },
  tlv_3000: { spawn: 'tlv_3000', time: 12, camera: 'chase', fly: 1 },
  // low over Tel Aviv (street trees, palms, the Yarkon park)
  tlv_300: { spawn: { x: -22500, z: -33500, agl: 300, heading: 180, speed: 150 }, time: 10, camera: 'chase', fly: 1 },
  // date palms of Kalia / Almog by the north end of the Dead Sea, 250 m up
  kalia_250: { spawn: { x: 41800, z: 4400, agl: 250, heading: 95, speed: 120 }, time: 10, camera: 'chase', fly: 1 },
  // sunset over the Jerusalem hills (the spawn's time, 18:45)
  sunset_chase: { spawn: 'jerusalem_sunset', camera: 'chase', fly: 1 },
  sunset_cockpit: { spawn: 'jerusalem_sunset', camera: 'cockpit', fly: 1 },
  sunset_low: { spawn: { x: 9000, z: 1500, agl: 200, heading: 270, speed: 140 }, time: 18.7, camera: 'chase', fly: 1 },
  // free cameras (the jet parked 900 m up, out of the way)
  free_forest_near: { spawn: { x: -9000, z: -15500, agl: 900, heading: 80, speed: 150 }, time: 10, free: { pos: [-9300, 12, -15600], dir: { heading: 80, pitch: -6 }, fov: 50 } },
  free_forest_low: { spawn: { x: -9000, z: -15500, agl: 900, heading: 80, speed: 150 }, time: 10, free: { pos: [-9300, 40, -15600], dir: { heading: 80, pitch: -12 }, fov: 55 } },
  free_jlm_forest_low: { spawn: { x: 10500, z: 2500, agl: 900, heading: 60, speed: 150 }, time: 11, free: { pos: [10300, 60, 2400], dir: { heading: 60, pitch: -10 }, fov: 55 } },
  free_tlv_street: { spawn: { x: -22500, z: -33500, agl: 900, heading: 180, speed: 150 }, time: 10, free: { pos: [-22500, 60, -33500], dir: { heading: 180, pitch: -15 }, fov: 55 } },
  free_road_check: { spawn: { x: -14000, z: -2000, agl: 900, heading: 0, speed: 150 }, time: 11, free: { pos: [-14000, 180, -2000], dir: { heading: 0, pitch: -50 }, fov: 50 } },
  free_orchard_top: { spawn: { x: -24100, z: -3200, agl: 900, heading: 350, speed: 120 }, time: 10, free: { pos: [-24100, 350, -3500], dir: { heading: 350, pitch: -60 }, fov: 50 } },
  free_telnof_top: { spawn: 'telnof_36', time: 12, free: { rel: [-700, 450, 300], dir: { heading: 60, pitch: -35 }, fov: 50 } },
  free_sunset_side: { spawn: 'jerusalem_sunset', free: { rel: [0, -1100, 0], dir: { heading: 270, pitch: -8 }, fov: 45 } },
  free_sunset_tele: { spawn: 'jerusalem_sunset', free: { rel: [0, 0, 0], dir: { heading: 90, pitch: -25 }, fov: 18 } },
  // a forest road in Ben Shemen from 18 m (trees beside it, none on it)
  free_forest_road: { spawn: { x: -9000, z: -15500, agl: 900, heading: 80, speed: 150 }, time: 10, free: { pos: [-8965, 18, -14815], dir: { heading: 20, pitch: -14 }, fov: 55 } },
  // the eucalyptus windbreaks and gum rows of the coastal plain, from 25 m
  free_windbreak: { spawn: { x: -24100, z: -3200, agl: 900, heading: 350, speed: 120 }, time: 15, free: { pos: [-24300, 25, -2600], dir: { heading: 20, pitch: -8 }, fov: 50 } },
};

async function startServer() {
  const proc = spawn(process.env.PYTHON || 'python3', [join(ROOT, 'serve.py'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const extra = process.env.VEG_CHROME_ARGS ? process.env.VEG_CHROME_ARGS.split(' ') : [];
  const problems = [];
  const results = [];
  let browser = null, page = null;
  // a fresh browser and page with the app loaded (again after a crash: the renderer is the first
  // process the kernel kills when the machine runs out of memory)
  async function open() {
    if (browser) await browser.close().catch(() => {});
    browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extra] });
    page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      else if (/vegetation|scatter/i.test(m.text())) log('page:', m.text());
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText || ''}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
    page.setDefaultTimeout(600000);
    const url = `${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${PARAMS ? `&${PARAMS}` : ''}`;
    log('open', url);
    await page.goto(url);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 300000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    // the free camera: while window.__vegFree is set the camera rig is bypassed
    await page.evaluate(() => {
      const app = window.__sim.app;
      const orig = app.cams.update.bind(app.cams);
      app.cams.update = (dt, ctx) => {
        const F = window.__vegFree;
        if (!F) return orig(dt, ctx);
        const c = app.camera;
        c.position.set(F.p[0], F.p[1], F.p[2]);
        c.up.set(0, 1, 0);
        c.lookAt(F.l[0], F.l[1], F.l[2]);
        c.fov = F.fov;
        c.updateProjectionMatrix();
        c.updateMatrixWorld();
      };
    });
  }

  async function shoot(name, sc) {
    const t1 = Date.now();
    await page.evaluate(([name, sc, shadowR]) => {
      const sim = window.__sim, app = sim.app;
      let sp = sc.spawn;
      if (typeof sp === 'object') {
        const g = app.terrain.heightAt(sp.x, sp.z);
        app.terrain.spawns[`veg_${name}`] = {
          label: `vegetation scene ${name}`, x: sp.x, y: g + sp.agl, z: sp.z, heading_deg: sp.heading,
          on_ground: false, speed_ms: sp.speed, gear: 0, ground_y: g,
        };
        sp = `veg_${name}`;
      }
      window.__vegFree = null;
      const opts = { camera: sc.camera || 'chase' };
      if (sc.time != null) opts.time = sc.time;
      sim.start(sp, opts);
      const r = sim.step(Math.round((sc.fly || 0) * 120));
      app.hmd.visible = !sc.free;
      app.visual.object3d.visible = !sc.free;
      if (sc.free) {
        const F = sc.free;
        let p;
        if (F.pos) {
          p = [F.pos[0], app.terrain.heightAt(F.pos[0], F.pos[2]) + F.pos[1], F.pos[2]];
        } else {
          const q = app.fdm.state.position;
          p = [q.x + F.rel[0], q.y + F.rel[1], q.z + F.rel[2]];
          p[1] = Math.max(p[1], app.terrain.heightAt(p[0], p[2]) + 30);
        }
        const h = F.dir.heading * Math.PI / 180, e = F.dir.pitch * Math.PI / 180;
        const l = [p[0] + Math.sin(h) * Math.cos(e) * 100, p[1] + Math.sin(e) * 100, p[2] - Math.cos(h) * Math.cos(e) * 100];
        window.__vegFree = { p, l, fov: F.fov || 55 };
      }
      if (shadowR) app.env._shadowRadius = shadowR;   // the lighting track's wide near-ground box
      return r;
    }, [name, sc, SHADOW_R]);
    let st = await page.evaluate((ms) => window.__sim.settle(ms), SETTLE);
    // the trees stream in the background: wait until the module has nothing left to do (90 s at most)
    for (let i = 0; i < 90; i++) {
      const idle = await page.evaluate(() => {
        const m = (window.__sim.app.modules || []).find((x) => x && x.isScatter);
        return !m || m.idle();
      });
      if (idle) break;
      st = await page.evaluate(() => window.__sim.settle(1000));
    }
    const info = await page.evaluate(() => window.__sim.renderInfo());
    const timing = await page.evaluate(() => window.__sim.timing());
    const mod = await page.evaluate(() => {
      const m = (window.__sim.app.modules || []).find((x) => x && x.isScatter);
      return m ? m.statsJSON() : null;
    });
    const file = join(OUT, `${TAG}${name}.png`);
    await page.screenshot({ path: file });
    let ab = null;
    if (AB && mod) {
      const three = () => {
        const sim = window.__sim, r = [0, 1, 2].map(() => sim.render());
        const ms = r.map((x) => x.ms).sort((a, b) => a - b)[1];
        return { ms, calls: r[2].calls, triangles: r[2].triangles };
      };
      const fn = `(${three})()`;
      const on = await page.evaluate(fn);
      await page.evaluate(() => window.__sim.app.modules.find((x) => x && x.isScatter).setOption('vegetation', false));
      const off = await page.evaluate(fn);
      await page.screenshot({ path: join(OUT, `${TAG}${name}_off.png`) });
      await page.evaluate(() => window.__sim.app.modules.find((x) => x && x.isScatter).setOption('vegetation', true));
      await page.evaluate(() => window.__sim.settle(200));
      ab = { on, off };
    }
    results.push({ name, scene: sc, summary: st, renderInfo: info, lastRenderMs: timing.lastRenderMs, vegetation: mod, ab });
    log(`${name}: ${info.calls} calls, ${(info.triangles / 1e6).toFixed(2)} M tris, ${timing.lastRenderMs} ms, agl ${st.agl_m} m, ${((Date.now() - t1) / 1000).toFixed(0)} s${mod ? `, veg ${JSON.stringify(mod)}` : ''}`);
    if (ab) log(`${name}: with trees ${ab.on.calls} calls, ${(ab.on.triangles / 1e6).toFixed(2)} M tris, ${ab.on.ms} ms; without ${ab.off.calls} calls, ${(ab.off.triangles / 1e6).toFixed(2)} M tris, ${ab.off.ms} ms`);
  }

  try {
    await open();
    for (const [name, sc] of Object.entries(SCENES)) {
      if (ONLY && !ONLY.includes(name)) continue;
      for (let attempt = 0; ; attempt++) {
        try {
          await shoot(name, sc);
          break;
        } catch (e) {
          if (attempt >= 2 || !/crash|closed/i.test(String(e.message))) throw e;
          log(`${name}: ${String(e.message).split('\n')[0]}; again with a new browser`);
          problems.push(`${name}: renderer crashed (attempt ${attempt + 1})`);
          await open();
        }
      }
    }
    if (LONG) {
      // 10 km at 250 m above the Judean foothills at 250 m/s, the worker given wall time every
      // 1 km: no upload may fail and the queue must drain (the slab buffer must not stall)
      const series = [];
      await page.evaluate(() => {
        const sim = window.__sim, app = sim.app;
        window.__vegFree = null;
        app.hmd.visible = true;
        app.visual.object3d.visible = true;
        const g = app.terrain.heightAt(-2000, 2500);
        app.terrain.spawns.veg_long = { label: 'vegetation long flight', x: -2000, y: g + 250, z: 2500, heading_deg: 95,
          on_ground: false, speed_ms: 250, gear: 0, ground_y: g };
        sim.start('veg_long', { time: 11, camera: 'chase' });
      });
      for (let k = 0; k < 10; k++) {
        const s = await page.evaluate(() => {
          const sim = window.__sim, app = sim.app, st = app.fdm.state;
          sim.setInput({ pitch: st.vs < -2 ? 0.15 : st.vs > 4 ? -0.1 : 0, roll: 0, throttle: 0.75 });
          sim.step(480);
          return { x: Math.round(st.position.x), z: Math.round(st.position.z), agl: Math.round(st.agl) };
        });
        await page.evaluate(() => window.__sim.settle(1500));
        const v = await page.evaluate(() => window.__sim.app.modules.find((x) => x && x.isScatter).statsJSON());
        series.push({ k, ...s, veg: v });
        log(`long ${k}: x ${s.x} z ${s.z} agl ${s.agl} | instances ${v.instances} high water ${v.highWater}/${v.capacity} pending ${v.pending} uploads ${v.uploads} failures ${v.uploadFailures} evicted ${v.evicted} compactions ${v.compactions}`);
      }
      // let the queue drain, then judge
      for (let i = 0; i < 60; i++) {
        const idle = await page.evaluate(() => window.__sim.app.modules.find((x) => x && x.isScatter).idle());
        if (idle) break;
        await page.evaluate(() => window.__sim.settle(1000));
      }
      const end = await page.evaluate(() => window.__sim.app.modules.find((x) => x && x.isScatter).statsJSON());
      await page.screenshot({ path: join(OUT, `${TAG}long_end.png`) });
      if (end.uploadFailures) problems.push(`long flight: ${end.uploadFailures} uploads failed`);
      if (!end.idle) problems.push(`long flight: the module did not drain (${end.pending} cells pending, ${end.uploads} uploads queued)`);
      log(`long end: ${JSON.stringify(end)}`);
      results.push({ name: 'long', series, end });
    }
    const mem = await page.evaluate(() => window.__sim.gpuMemory());
    const timing = await page.evaluate(() => window.__sim.timing());
    log(`GPU memory estimate ${mem.totalMB} MB (textures ${mem.texturesMB}, geometry ${mem.geometryMB}); ${timing.gpu}`);
    writeFileSync(join(OUT, `${TAG}stats.json`), JSON.stringify({ when: new Date().toISOString(), quality: QUALITY, params: PARAMS, size: [W, H], results, gpuMemory: mem, timing, problems }, null, 1));
    if (problems.length) log('PROBLEMS:', problems.slice(0, 8).join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
}

main().catch((e) => { console.error('[veg]', e); process.exit(1); });
