// Screenshots of the scenes the 3D buildings are judged by (Playwright + headless Chromium,
// SwiftShader), driven through the app's automation API window.__sim (index.html?test=1).
//
//   node sim/tools/world/shots.mjs [--port 8180] [--out DIR] [--size 960x540] [--quality high]
//        [--scenes tlv300,round,...] [--query buildings=0] [--tag before] [--maxwait 90000]
//
// Two kinds of scene:
//   flying       a start point made up on the fly (lon / lat, altitude, heading) or a named spawn,
//                seen from the chase or the cockpit camera;
//   free camera  `cam: {pos, look, fov}` (lon, lat, metres above sea level): the jet is hidden and
//                the camera placed exactly (the views of the buildings review).
// Every scene waits until the buildings have streamed (no tile or chunk loading twice in a row,
// at most --maxwait ms). Writes <out>/<scene>_<tag>.png and <out>/info_<tag>.jsonl (renderInfo,
// timing, GPU memory estimate, building statistics, and for `round` the share of dark speckle
// pixels on the tower: the regression check of the style-id rounding, see tests/e2e.mjs).
//
// Scenes:
//   tlv300 / tlv300c    over the Tel Aviv beach at 300 m, heading east into the city (chase / cockpit)
//   tlv300pm            the same at 16:30 (the sun behind the camera)
//   tlvlow              140 m over the city, 1 km west of the Azrieli towers, at 16:00
//   tlv1500 / tlv1500c  3 km off the Tel Aviv coast at 1,500 m, heading east
//   azrieli             the Azrieli towers from 250 m, 1.2 km away (chase)
//   tlvnight / tlvnightc  tlv1500 at 21:30; 600 m over the coast at 21:30 (cockpit)
//   tlv3000 / tlv3000c  the tlv_3000 start point (cruise over the city)
//   jlm / jlmc          jerusalem_sunset (chase / cockpit); jlmlow 1,050 m over west Jerusalem
//   telnof / telnofchase  Tel Nof runway 36 at noon (cockpit / chase)
//   bengurion / bengurionc  Ben Gurion runway 26 at noon
//   ramatgan            the Ramat Gan diamond exchange towers from 400 m (chase)
//   free cameras: round (the round Azrieli tower, the speckle check), sarona, mosheaviv, rutenberg,
//   rutenbergn, whitecity, oldcity, bgnt3, batyam, telnofair, hatzorair, spiral, tlvshadow (the
//   city from 600 m at 07:30, long shadows), tlvnightair (night, 900 m over Tel Aviv)

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
const ROOT = resolve(arg('root', join(here, '..', '..')));
const PORT = +arg('port', 8180);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/buildings'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const QUERY = arg('query', '');
const TAG = arg('tag', 'after');
const MAXWAIT = +arg('maxwait', 90000);
const BASE = `http://127.0.0.1:${PORT}/`;

const SCENES = {
  tlv300: { lon: 34.7655, lat: 32.0790, alt: 300, hdg: 100, time: 10, view: 'chase' },
  tlv300c: { lon: 34.7655, lat: 32.0790, alt: 300, hdg: 100, time: 10, view: 'cockpit' },
  tlv300pm: { lon: 34.7655, lat: 32.0790, alt: 300, hdg: 100, time: 16.5, view: 'chase' },
  tlvlow: { lon: 34.7700, lat: 32.0745, alt: 140, hdg: 85, time: 16, view: 'chase' },
  tlv1500: { lon: 34.7350, lat: 32.0800, alt: 1500, hdg: 95, time: 10, view: 'chase' },
  tlv1500c: { lon: 34.7350, lat: 32.0800, alt: 1500, hdg: 95, time: 10, view: 'cockpit' },
  azrieli: { lon: 34.7800, lat: 32.0740, alt: 250, hdg: 92, time: 15.5, view: 'chase' },
  tlvnight: { lon: 34.7350, lat: 32.0800, alt: 1500, hdg: 95, time: 21.5, view: 'chase' },
  tlvnightc: { lon: 34.7500, lat: 32.0750, alt: 600, hdg: 95, time: 21.5, view: 'cockpit' },
  ramatgan: { lon: 34.7880, lat: 32.0650, alt: 400, hdg: 40, time: 9, view: 'chase' },
  tlv3000: { spawn: 'tlv_3000', time: 12, view: 'chase' },
  tlv3000c: { spawn: 'tlv_3000', time: 12, view: 'cockpit' },
  jlm: { spawn: 'jerusalem_sunset', view: 'chase' },
  jlmc: { spawn: 'jerusalem_sunset', view: 'cockpit' },
  jlmlow: { lon: 35.2050, lat: 31.7830, alt: 1050, hdg: 100, time: 18.6, view: 'chase' },
  telnof: { spawn: 'telnof_36', time: 12, view: 'cockpit' },
  telnofchase: { spawn: 'telnof_36', time: 12, view: 'chase' },
  bengurion: { spawn: 'bengurion_26', time: 12, view: 'chase' },
  bengurionc: { spawn: 'bengurion_26', time: 12, view: 'cockpit' },
  // free cameras (the buildings review's views and a few more)
  round: { cam: { pos: [34.7870, 32.0715, 150], look: [34.79159, 32.07462, 110], fov: 40 }, time: 10 },
  sarona: { cam: { pos: [34.7780, 32.0690, 180], look: [34.7889, 32.0722, 120], fov: 40 }, time: 10 },
  spiral: { cam: { pos: [34.7840, 32.0700, 220], look: [34.7925, 32.0758, 160], fov: 45 }, time: 10 },
  mosheaviv: { cam: { pos: [34.7960, 32.0770, 160], look: [34.8037, 32.0834, 120], fov: 40 }, time: 10 },
  rutenberg: { cam: { pos: [34.5300, 31.6550, 300], look: [34.5200, 31.6310, 120], fov: 45 }, time: 12 },
  rutenbergn: { cam: { pos: [34.5300, 31.6550, 300], look: [34.5200, 31.6310, 120], fov: 45 }, time: 21.5 },
  whitecity: { cam: { pos: [34.7700, 32.0600, 120], look: [34.7760, 32.0660, 30], fov: 55 }, time: 9.5 },
  oldcity: { cam: { pos: [35.2240, 31.7700, 900], look: [35.2350, 31.7780, 760], fov: 45 }, time: 18.6 },
  domerock: { cam: { pos: [35.2300, 31.7740, 860], look: [35.2353, 31.7780, 760], fov: 30 }, time: 16 },
  bgnt3: { cam: { pos: [34.8760, 32.0010, 120], look: [34.8860, 32.0060, 60], fov: 45 }, time: 12 },
  batyam: { cam: { pos: [34.7300, 32.0150, 200], look: [34.7450, 32.0050, 60], fov: 55 }, time: 15.5 },
  telnofair: { cam: { pos: [34.8130, 31.8550, 450], look: [34.8180, 31.8380, 60], fov: 50 }, time: 12 },
  hatzorair: { cam: { pos: [34.7200, 31.7800, 450], look: [34.7300, 31.7650, 60], fov: 50 }, time: 12 },
  tlvshadow: { cam: { pos: [34.7650, 32.0600, 600], look: [34.7850, 32.0750, 20], fov: 50 }, time: 7.5 },
  tlvshadowpm: { cam: { pos: [34.8000, 32.0600, 600], look: [34.7800, 32.0750, 20], fov: 50 }, time: 16.5 },
  tlvnightair: { cam: { pos: [34.7550, 32.0600, 900], look: [34.7900, 32.0800, 40], fov: 50 }, time: 21.5 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[shots ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const names = arg('scenes', 'tlv300,tlv1500,tlv1500c,azrieli,tlv3000,jlm,jlmc,telnof,tlvnight').split(',').filter(Boolean);
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const problems = [];
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      if (m.type() === 'warning' || m.type() === 'error' || /buildings/i.test(m.text())) log(`console.${m.type()}: ${m.text().slice(0, 300)}`);
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
    const S = (fn, a) => page.evaluate(fn, a);
    for (const name of names) {
      const sc = SCENES[name];
      if (!sc) { log(`unknown scene ${name}`); continue; }
      const t1 = Date.now();
      const sum = await S(async (sc) => {
        const sim = window.__sim, app = sim.app;
        const { lonLatToXZ } = await import('/js/world/coords.js');
        let spawn = sc.spawn;
        if (!spawn) {
          // free cameras fly the (hidden) jet well above and south of the view
          const ll = sc.cam ? [sc.cam.pos[0], sc.cam.pos[1] - 0.03, Math.max(sc.cam.pos[2], 400) + 600] : [sc.lon, sc.lat, sc.alt];
          const p = lonLatToXZ(ll[0], ll[1]);
          spawn = '_shot';
          app.terrain.spawns._shot = {
            label: 'shot', x: p.x, z: p.z, y: ll[2], ground_y: app.terrain.heightAt(p.x, p.z),
            heading_deg: sc.hdg ?? 0, on_ground: false, speed_ms: 160, gear: 0,
          };
        }
        if (app._shotCamUpdate) { app.cams.update = app._shotCamUpdate; app.visual.object3d.visible = true; }
        sim.start(spawn, { time: sc.time, camera: sc.view || 'chase' });
        if (sc.time != null) sim.time(sc.time);
        sim.step(60);
        if (sc.cam) {
          const a = lonLatToXZ(sc.cam.pos[0], sc.cam.pos[1]), b = lonLatToXZ(sc.cam.look[0], sc.cam.look[1]);
          const cam = app.camera;
          app._shotCamUpdate = app._shotCamUpdate || app.cams.update.bind(app.cams);
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
      // wait until the buildings have streamed: nothing loading twice in a row
      let quiet = 0;
      const tw = Date.now();
      while (Date.now() - tw < MAXWAIT) {
        await S(() => window.__sim.settle(1500));
        const st = await S(() => window.__sim.app.modules?.find((m) => m.name === 'Buildings')?.stats || null);
        if (!st || (st.loading === 0 && st.tiles > 0) || st.off) quiet++; else quiet = 0;
        if (quiet >= 2) break;
      }
      const s = await S(() => window.__sim.settle(800));
      const info = await S(() => ({
        render: window.__sim.renderInfo(), timing: window.__sim.timing(), mem: window.__sim.gpuMemory(),
        buildings: window.__sim.app.modules?.find((m) => m.name === 'Buildings')?.stats || null,
        exposure: window.__sim.app.env.exposure,
      }));
      if (name === 'round') info.speckle = await S(() => window.__sim.app.modules?.find((m) => m.name === 'Buildings')?.speckleCheck?.(34.79159, 32.07462) ?? null);
      const file = join(OUT, `${name}_${TAG}.png`);
      await page.screenshot({ path: file });
      appendFileSync(join(OUT, `info_${TAG}.jsonl`), JSON.stringify({ name, tag: TAG, quality: QUALITY, query: QUERY, summary: sum, settled: s, ...info, wallS: (Date.now() - t1) / 1000 }) + '\n');
      log(`${name}: ${info.render.calls} calls, ${(info.render.triangles / 1e6).toFixed(2)} M tris, GPU ${info.mem.totalMB} MB (geometry ${info.mem.geometryMB})`
        + (info.buildings ? `, buildings ${JSON.stringify(info.buildings)}` : '') + (info.speckle ? `, speckle ${JSON.stringify(info.speckle)}` : '')
        + `, ${((Date.now() - t1) / 1000).toFixed(0)} s`);
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (problems.length) { log('PROBLEMS:'); for (const p of problems.slice(0, 20)) log('  ' + p); }
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error('[shots]', e); process.exit(1); });
