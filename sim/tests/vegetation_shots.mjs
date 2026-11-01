// Screenshots of the vegetation scenes (trees, orchards, palms, shrubs) with frame statistics, for
// judging the look against reality and measuring the cost. Playwright + headless Chromium
// (SwiftShader WebGL2), driven through window.__sim (index.html?test=1), like tests/e2e.mjs.
//
//   node sim/tests/vegetation_shots.mjs [--port 8144] [--out DIR] [--size 960x540]
//        [--quality medium] [--only telnof_chase,orchards_150] [--params "vegetation=0"]
//        [--settle 6000] [--tag before]
//
// Every scene is a start point (spawns.json or one defined here, placed at a height above the
// ground) with a time of day and a camera; the scene is flown for a moment, the streaming is given
// wall time (--settle) and a frame is drawn. Writes <out>/<tag><scene>.png and <out>/<tag>stats.json
// (renderInfo, timing, the module's own stats, the GPU memory estimate per scene).

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
  orchards_150: { spawn: { x: -24100, z: -2400, agl: 150, heading: 350, speed: 120 }, time: 10, camera: 'chase', fly: 1 },
  orchards_150_cockpit: { spawn: { x: -24100, z: -2400, agl: 150, heading: 350, speed: 120 }, time: 10, camera: 'cockpit', fly: 1 },
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
  kalia_250: { spawn: { x: 41200, z: 3200, agl: 250, heading: 0, speed: 120 }, time: 10, camera: 'chase', fly: 1 },
  // sunset over the Jerusalem hills (the spawn's time, 18:45)
  sunset_chase: { spawn: 'jerusalem_sunset', camera: 'chase', fly: 1 },
  sunset_cockpit: { spawn: 'jerusalem_sunset', camera: 'cockpit', fly: 1 },
  sunset_low: { spawn: { x: 9000, z: 1500, agl: 200, heading: 270, speed: 140 }, time: 18.7, camera: 'chase', fly: 1 },
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
  }

  async function shoot(name, sc) {
    const t1 = Date.now();
    await page.evaluate(([name, sc]) => {
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
      const opts = { camera: sc.camera };
      if (sc.time != null) opts.time = sc.time;
      sim.start(sp, opts);
      return sim.step(Math.round((sc.fly || 0) * 120));
    }, [name, sc]);
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
    results.push({ name, scene: sc, summary: st, renderInfo: info, lastRenderMs: timing.lastRenderMs, vegetation: mod });
    log(`${name}: ${info.calls} calls, ${(info.triangles / 1e6).toFixed(2)} M tris, ${timing.lastRenderMs} ms, agl ${st.agl_m} m, ${((Date.now() - t1) / 1000).toFixed(0)} s${mod ? `, veg ${JSON.stringify(mod)}` : ''}`);
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
