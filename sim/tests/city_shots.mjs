// Screenshots of the city scenes (track "city": night windows, rooftops, facades, the skyline),
// driven through window.__sim (index.html?test=1) in headless Chromium (SwiftShader).
//
//   node sim/tests/city_shots.mjs [--port 8900] [--out DIR] [--size 960x540] [--quality high]
//        [--scenes az_night,roofs300,...] [--query buildings=0] [--tag before] [--maxwait 90000]
//        [--eval "JS run in the page after loading"] [--list]
//
// Scenes are free cameras (`cam: {pos, look, fov}`: lon, lat, metres above sea level; the jet is
// hidden and flown well above and south of the view) or start points (`spawn`, seen from `view`).
// Each one waits until the buildings have streamed (nothing loading or cross-fading twice in a row,
// at most --maxwait ms), draws `frames` frames (the exposure and the clouds' filter settle) and
// writes <out>/<scene>_<tag>.png and a line of <out>/info_<tag>.jsonl (renderInfo, timing, the GPU
// memory estimate, the buildings' statistics, the exposure).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, appendFileSync } from 'node:fs';
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
const PORT = +arg('port', 8900);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/city/run'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const QUERY = arg('query', '');
const TAG = arg('tag', 'after');
const MAXWAIT = +arg('maxwait', 90000);
const EVAL = arg('eval', '');
const BASE = `http://127.0.0.1:${PORT}/`;

// lon, lat, m MSL; time: local solar hours
const AZ = { pos: [34.7870, 32.0715, 150], look: [34.79159, 32.07462, 110], fov: 40 };    // e2e's Azrieli view (~450 m)
const AZ_FAR = { pos: [34.7700, 32.0640, 480], look: [34.7916, 32.0746, 140], fov: 45 };   // the towers from ~2.3 km at 480 m
const SKYLINE = { pos: [34.7420, 32.0760, 520], look: [34.7950, 32.0770, 130], fov: 50 }; // from the sea, ~5 km
const SCENES = {
  az_day: { cam: AZ, time: 10 },
  az_dusk: { cam: AZ, time: 19.45 },
  az_night: { cam: AZ, time: 21.5 },
  az_late: { cam: AZ, time: 1.5 },
  azfar_day: { cam: AZ_FAR, time: 16 },
  azfar_night: { cam: AZ_FAR, time: 21.5 },
  skyline_day: { cam: SKYLINE, time: 17.5 },
  skyline_night: { cam: SKYLINE, time: 21.5 },
  ramatgan_night: { cam: { pos: [34.7880, 32.0700, 320], look: [34.8040, 32.0840, 140], fov: 45 }, time: 21.5 },
  // rooftops (residential north Tel Aviv): looking down from 300 m, 1,000 m and 3,000 m
  roofs300: { cam: { pos: [34.7735, 32.0835, 300], look: [34.7775, 32.0870, 20], fov: 50 }, time: 11 },
  roofs300pm: { cam: { pos: [34.7735, 32.0835, 300], look: [34.7775, 32.0870, 20], fov: 50 }, time: 16.5 },
  roofs1000: { cam: { pos: [34.7640, 32.0760, 1000], look: [34.7780, 32.0880, 20], fov: 50 }, time: 11 },
  roofs3000: { cam: { pos: [34.7450, 32.0550, 3000], look: [34.7800, 32.0880, 20], fov: 50 }, time: 11 },
  roofs150: { cam: { pos: [34.7748, 32.0848, 150], look: [34.7772, 32.0870, 25], fov: 50 }, time: 11 },
  givatayim300: { cam: { pos: [34.8050, 32.0640, 330], look: [34.8100, 32.0690, 60], fov: 50 }, time: 9.5 },
  whitecity: { cam: { pos: [34.7700, 32.0600, 120], look: [34.7760, 32.0660, 30], fov: 55 }, time: 9.5 },
  whitecity_night: { cam: { pos: [34.7700, 32.0600, 120], look: [34.7760, 32.0660, 30], fov: 55 }, time: 21.5 },
  facades300: { cam: { pos: [34.7650, 32.0700, 160], look: [34.7760, 32.0760, 40], fov: 45 }, time: 15.5 },
  facades300_am: { cam: { pos: [34.7650, 32.0700, 160], look: [34.7760, 32.0760, 40], fov: 45 }, time: 7 },
  tlvnightair: { cam: { pos: [34.7550, 32.0600, 900], look: [34.7900, 32.0800, 40], fov: 50 }, time: 21.5 },
  tlvnight2300: { cam: { pos: [34.7550, 32.0600, 900], look: [34.7900, 32.0800, 40], fov: 50 }, time: 23.5 },
  tlv3000: { spawn: 'tlv_3000', time: 12.5, view: 'chase' },
  tlv3000_night: { spawn: 'tlv_3000', time: 21.5, view: 'chase' },
  tlv3000c_night: { spawn: 'tlv_3000', time: 21.5, view: 'cockpit' },
  tlv3000_orbit_night: { spawn: 'tlv_3000', time: 21.5, view: 'orbit' },
  jlm: { spawn: 'jerusalem_sunset', view: 'chase' },
  jlmc: { spawn: 'jerusalem_sunset', view: 'cockpit' },
  jlm_stone: { cam: { pos: [35.2050, 31.7760, 900], look: [35.2150, 31.7800, 790], fov: 45 }, time: 18.6 },
  jlm_stone_noon: { cam: { pos: [35.2050, 31.7760, 900], look: [35.2150, 31.7800, 790], fov: 45 }, time: 12.5 },
  jlm_old: { cam: { pos: [35.2240, 31.7700, 900], look: [35.2350, 31.7780, 760], fov: 45 }, time: 18.6 },
  jlm_night: { cam: { pos: [35.2050, 31.7760, 1100], look: [35.2200, 31.7820, 780], fov: 50 }, time: 21.5 },
  bgn_night: { spawn: 'bengurion_26', time: 21.5, view: 'chase' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[city ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

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
    } catch (e) { if (String(e.message).includes('did not take')) throw e; }
    await sleep(200);
  }
  proc.kill();
  throw new Error(`serve.py did not start:\n${out}`);
}

// a browser with the app loaded (again after a crash: the machine's memory is shared)
async function openApp(problems) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    if ((m.type() === 'warning' && !/GPU stall|parallel_shader/.test(m.text())) || m.type() === 'error') log(`console.${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  page.setDefaultTimeout(900000);
  const tLoad = Date.now();
  await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${QUERY ? '&' + QUERY : ''}`);
  await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 600000 });
  const err = await page.evaluate(() => window.__sim.error);
  if (err) throw new Error(`app did not load: ${err}`);
  log(`loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)} s`);
  if (EVAL) log('eval:', await page.evaluate(EVAL));
  return { browser, page };
}

async function shoot(page, name, sc) {
  const S = (fn, a) => page.evaluate(fn, a);
  const t1 = Date.now();
  const sum = await S(async (sc) => {
    const sim = window.__sim, app = sim.app;
    const { lonLatToXZ } = await import('/js/world/coords.js');
    let spawn = sc.spawn;
    if (!spawn) {
      const ll = [sc.cam.pos[0], sc.cam.pos[1] - 0.03, Math.max(sc.cam.pos[2], 400) + 600];
      const p = lonLatToXZ(ll[0], ll[1]);
      spawn = '_city';
      app.terrain.spawns._city = {
        label: 'city', x: p.x, z: p.z, y: ll[2], ground_y: app.terrain.heightAt(p.x, p.z),
        heading_deg: 0, on_ground: false, speed_ms: 160, gear: 0,
      };
    }
    if (app._cityCamUpdate) { app.cams.update = app._cityCamUpdate; app.visual.object3d.visible = true; }
    sim.start(spawn, { time: sc.time, camera: sc.view || 'chase' });
    if (sc.time != null) sim.time(sc.time);
    sim.step(60);
    if (sc.cam) {
      const a = lonLatToXZ(sc.cam.pos[0], sc.cam.pos[1]), b = lonLatToXZ(sc.cam.look[0], sc.cam.look[1]);
      const cam = app.camera;
      app._cityCamUpdate = app._cityCamUpdate || app.cams.update.bind(app.cams);
      app.cams.update = () => {
        cam.position.set(a.x, sc.cam.pos[2], a.z);
        cam.up.set(0, 1, 0);
        cam.lookAt(b.x, sc.cam.look[2], b.z);
        cam.fov = sc.cam.fov || 50;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
      };
      app.visual.object3d.visible = false;
    }
    return sim.summary();
  }, sc);
  let quiet = 0;
  const tw = Date.now();
  while (Date.now() - tw < MAXWAIT) {
    await S(() => window.__sim.settle(1500));
    const st = await S(() => window.__sim.app.modules?.find((m) => m.name === 'Buildings')?.stats || null);
    if (!st || (st.loading === 0 && st.tiles > 0 && !st.fading) || st.off) quiet++; else quiet = 0;
    if (quiet >= 2) break;
  }
  for (let i = 0; i < (sc.frames ?? 2); i++) await S(() => window.__sim.settle(400));
  const info = await S(() => ({
    render: window.__sim.renderInfo(), timing: window.__sim.timing(), mem: window.__sim.gpuMemory(),
    buildings: window.__sim.app.modules?.find((m) => m.name === 'Buildings')?.stats || null,
    exposure: window.__sim.app.env.exposure, lightGain: window.__sim.app.env.lightGain,
  }));
  const file = join(OUT, `${name}_${TAG}.png`);
  await page.screenshot({ path: file });
  appendFileSync(join(OUT, `info_${TAG}.jsonl`), JSON.stringify({ name, tag: TAG, quality: QUALITY, query: QUERY, summary: sum, ...info, wallS: (Date.now() - t1) / 1000 }) + '\n');
  log(`${name}: ${info.render.calls} calls, ${(info.render.triangles / 1e6).toFixed(2)} M tris, GPU ${info.mem.totalMB} MB (geometry ${info.mem.geometryMB}), exposure ${info.exposure?.toFixed?.(1)}`
    + (info.buildings ? `, buildings ${JSON.stringify(info.buildings)}` : '') + `, ${((Date.now() - t1) / 1000).toFixed(0)} s`);
}

async function main() {
  if (argv.includes('--list')) { console.log(Object.keys(SCENES).join('\n')); return; }
  mkdirSync(OUT, { recursive: true });
  const names = arg('scenes', 'az_day,az_night,roofs300,tlvnightair').split(',').filter(Boolean);
  const server = await startServer();
  const problems = [];
  let app = null;
  try {
    for (const name of names) {
      const sc = SCENES[name];
      if (!sc) { log(`unknown scene ${name}`); continue; }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!app) app = await openApp(problems);
          await shoot(app.page, name, sc);
          break;
        } catch (e) {
          // a crashed page (out of memory on a shared machine): a new browser, the scene once more
          if (!/crash|closed|Target/i.test(String(e.message)) || attempt) throw e;
          log(`${name}: ${String(e.message).split('\n')[0]}; again in a new browser`);
          await app?.browser.close().catch(() => {});
          app = null;
        }
      }
    }
  } finally {
    await app?.browser.close().catch(() => {});
    server.kill();
  }
  if (problems.length) { log('PROBLEMS:'); for (const p of problems.slice(0, 20)) log('  ' + p); }
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error('[city]', e); process.exit(1); });
