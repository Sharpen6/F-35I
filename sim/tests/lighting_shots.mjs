// Screenshots for the light, sky, clouds and post-processing work (js/env): the same places at
// several times of day, through the automation API window.__sim (index.html?test=1).
//
//   node sim/tests/lighting_shots.mjs [--port 8148] [--out DIR] [--size 960x540] [--quality high]
//        [--set times|quick|clouds|night|twilight|flicker|all] [--only name1,name2]
//        [--params "clouds=few&post=1"] [--frames 10]
//        [--resume]   (skip the shots already in --out: to finish a run whose browser was killed)
//
// Every shot: start a spawn at a time of day, fly a few seconds hands off, place the camera, let the
// exposure and the terrain tiles settle, draw --frames frames (the clouds' temporal filter fills
// up), screenshot (pair: the next frame too, NAME_b.png, to measure what changes from one frame to
// the next: tests/frame_diff.py). A log line per shot gives the
// draw calls, triangles, the frame time (SwiftShader: not the real cost) and the exposure; at the end
// renderInfo() and gpuMemory() go to report.json beside the pictures.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const PORT = +arg('port', 8148);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/lighting/run'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const SET = arg('set', 'quick');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const EXTRA = arg('params', '');
const RESUME = argv.includes('--resume');
const FRAMES = +arg('frames', 10);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[shots ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// cam: 'chase' | 'cockpit' | {orbit: [yawDeg (from the jet's tail, + = right), pitchDeg, dist]}
const TIMES = [5.75, 7.0, 12.0, 17.5, 18.75, 20.0];
const hh = (h) => `${String(Math.floor(h)).padStart(2, '0')}${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
function sets() {
  const s = {};
  s.times = [];
  for (const t of TIMES) {
    s.times.push({ name: `telnof_${hh(t)}_chase`, spawn: 'telnof_36', time: t, cam: 'chase' });
    s.times.push({ name: `jlm_${hh(t)}_chase`, spawn: 'jerusalem_sunset', time: t, cam: 'chase' });
    s.times.push({ name: `sea_${hh(t)}_chase`, spawn: 'coast_low', time: t, cam: 'chase' });
  }
  s.quick = [
    { name: 'telnof_1200_chase', spawn: 'telnof_36', time: 12, cam: 'chase' },
    { name: 'telnof_1200_front34', spawn: 'telnof_36', time: 12, cam: { orbit: [150, 8, 24] } },
    { name: 'telnof_1200_cockpit', spawn: 'telnof_36', time: 12, cam: 'cockpit' },
    { name: 'telnof_0700_side', spawn: 'telnof_36', time: 7, cam: { orbit: [95, 6, 26] } },
    { name: 'tlv_1200_chase', spawn: 'tlv_3000', time: 12, cam: 'chase' },
    { name: 'jlm_1845_chase', spawn: 'jerusalem_sunset', time: 18.75, cam: 'chase' },
    { name: 'jlm_1845_cockpit', spawn: 'jerusalem_sunset', time: 18.75, cam: 'cockpit' },
    { name: 'sea_1845_chase', spawn: 'coast_low', time: 18.75, cam: 'chase' },
    { name: 'sea_1845_sun', spawn: 'coast_low', time: 18.75, cam: { orbit: [-75, 2, 30] } },
    { name: 'deadsea_1200_chase', spawn: 'deadsea_low', time: 12, cam: 'chase' },
    { name: 'bgn_1915_chase', spawn: 'bengurion_26', time: 19.25, cam: 'chase' },
    { name: 'telnof_2030_chase', spawn: 'telnof_36', time: 20.5, cam: 'chase' },
  ];
  s.night = [
    { name: 'telnof_2000_chase', spawn: 'telnof_36', time: 20.0, cam: 'chase' },
    { name: 'telnof_2200_chase', spawn: 'telnof_36', time: 22.0, cam: 'chase' },
    { name: 'tlv_2200_chase', spawn: 'tlv_3000', time: 22.0, cam: 'chase' },
    { name: 'tlv_2200_up', spawn: 'tlv_3000', time: 22.0, cam: { orbit: [0, -30, 30] } },
    { name: 'jlm_0500_chase', spawn: 'jerusalem_sunset', time: 5.0, cam: 'chase' },
  ];
  // clouds: from below (300 m over the sea), through a cloud, from above (3,000 and 6,000 m), the
  // presets, dusk, night, and the cloud shadows on the ground. clouds: the preset; inside: move the
  // jet into the nearest cumulus at that height
  s.clouds = [
    { name: 'cl_coast_1200_up', spawn: 'coast_low', time: 12, cam: { orbit: [180, -25, 40] }, clouds: 'few' },
    { name: 'cl_coast_1200_chase', spawn: 'coast_low', time: 12, cam: 'chase', clouds: 'few' },
    { name: 'cl_coast_1200_sct', spawn: 'coast_low', time: 12, cam: 'chase', clouds: 'scattered' },
    { name: 'cl_coast_1200_bkn', spawn: 'coast_low', time: 12, cam: 'chase', clouds: 'broken' },
    { name: 'cl_coast_1600_ci', spawn: 'coast_low', time: 16, cam: { head: [0, 35] }, clouds: 'cirrus' },
    { name: 'cl_inside_1200_bkn', spawn: 'jerusalem_sunset', time: 12, cam: 'chase', clouds: 'broken', inside: 1700 },
    { name: 'cl_edge_1200_bkn', spawn: 'jerusalem_sunset', time: 12, cam: 'chase', clouds: 'broken', inside: 1700, back: 650 },
    { name: 'cl_tlv_1200_chase', spawn: 'tlv_3000', time: 12, cam: 'chase', clouds: 'few' },
    { name: 'cl_tlv_1600_cockpit', spawn: 'tlv_3000', time: 16, cam: 'cockpit', clouds: 'scattered' },
    { name: 'cl_high_1100_chase', spawn: 'tlv_3000', time: 11, cam: 'chase', climb: 6000, clouds: 'scattered' },
    { name: 'cl_telnof_0800_side', spawn: 'telnof_36', time: 8, cam: { orbit: [95, 10, 60] }, clouds: 'broken' },
    { name: 'cl_jlm_1845_chase', spawn: 'jerusalem_sunset', time: 18.75, cam: 'chase', clouds: 'few' },
    { name: 'cl_sea_1915_chase', spawn: 'coast_low', time: 19.25, cam: 'chase', clouds: 'scattered' },
    { name: 'cl_tlv_2200_moon', spawn: 'tlv_3000', time: 22, cam: 'chase', clouds: 'scattered', year: 2024 },
  ];
  // shadows near the ground: test blocks (hangar-sized boxes, castShadow) ahead of and beside the
  // jet on the runway; boxes: [right, ahead, width, height, depth] in m, in the jet's frame
  const blocks = [[45, 60, 30, 14, 20], [-60, 140, 40, 22, 25], [30, 230, 20, 30, 20], [-35, -20, 12, 8, 12]];
  s.shadows = [
    { name: 'sh_telnof_0700_chase', spawn: 'telnof_36', time: 7, cam: 'chase', boxes: blocks },
    { name: 'sh_telnof_0700_side', spawn: 'telnof_36', time: 7, cam: { orbit: [100, 12, 70] }, boxes: blocks },
    { name: 'sh_telnof_1600_cockpit', spawn: 'telnof_36', time: 16, cam: 'cockpit', boxes: blocks },
    { name: 'sh_telnof_1200_close', spawn: 'telnof_36', time: 12, cam: { orbit: [150, 8, 24] } },
  ];
  // sky details: sun glare, the Dead Sea basin, the moon (2026: first quarter on 21 June at dusk,
  // 2024: full moon), dusk
  s.sky = [
    { name: 'sky_telnof_0615_sun', spawn: 'telnof_36', time: 6.25, cam: { orbit: [-65, 4, 30] } },
    { name: 'sky_deadsea_1200_east', spawn: 'deadsea_low', time: 12, cam: { orbit: [90, 2, 30] } },
    { name: 'sky_deadsea_1730_chase', spawn: 'deadsea_low', time: 17.5, cam: 'chase' },
    { name: 'sky_tlv_2000_moon', spawn: 'tlv_3000', time: 20.0, cam: { head: [-49, 40] } },
    { name: 'sky_tlv_2200_fullmoon_up', spawn: 'tlv_3000', time: 22.0, cam: { head: [13, 26] }, year: 2024 },
    { name: 'sky_tlv_2200_fullmoon', spawn: 'tlv_3000', time: 22.0, cam: 'chase', year: 2024 },
    { name: 'sky_sea_1930_chase', spawn: 'coast_low', time: 19.5, cam: 'chase' },
  ];
  // dusk at Ben Gurion looking west, sun from +0.5 to -15 deg, then night (the moon: first quarter)
  s.twilight = [19.0, 19.25, 19.4, 19.5, 19.6, 19.75, 20.0, 20.5, 21.5].map((t) => ({ name: `tw_bgn_${hh(t)}`, spawn: 'bengurion_26', time: t, cam: 'chase' }));
  s.twilight.push({ name: 'tw_tlv_2130_cities', spawn: 'tlv_3000', time: 21.5, cam: { orbit: [0, -18, 40] } });
  s.twilight.push({ name: 'tw_tlv_2130_clouds', spawn: 'tlv_3000', time: 21.5, cam: 'chase', clouds: 'scattered' });
  s.twilight.push({ name: 'tw_tlv_2200_fullmoon_cl', spawn: 'tlv_3000', time: 22.0, cam: 'chase', clouds: 'scattered', year: 2024 });
  s.twilight.push({ name: 'tw_telnof_2130_cockpit', spawn: 'telnof_36', time: 21.5, cam: 'cockpit' });
  // frame-to-frame change (cloud boil): the same view, two consecutive frames
  s.flicker = [
    { name: 'fl_coast_1200_up', spawn: 'coast_low', time: 12, cam: { orbit: [180, -25, 40] }, clouds: 'scattered', pair: true },
    { name: 'fl_jlm_1200_chase', spawn: 'jerusalem_sunset', time: 12, cam: 'chase', clouds: 'broken', pair: true },
    { name: 'fl_edge_1200_bkn', spawn: 'jerusalem_sunset', time: 12, cam: 'chase', clouds: 'broken', inside: 1900, back: 650, pair: true },
  ];
  s.all = [...s.quick, ...s.times, ...s.night, ...s.sky, ...s.clouds, ...s.shadows, ...s.twilight, ...s.flicker];
  return s;
}

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
  const all = sets();
  let list = all[SET] || all.quick;
  if (ONLY) list = Object.values(all).flat().filter((s, i, a) => ONLY.includes(s.name) && a.findIndex((x) => x.name === s.name) === i);
  // one line a shot, written as it is taken, so a run that dies (the browser killed for memory)
  // keeps what it took and --resume goes on from there
  const lines = join(OUT, 'shots.jsonl');
  if (RESUME) list = list.filter((s) => !existsSync(join(OUT, `${s.name}.png`)));
  else writeFileSync(lines, '');
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const problems = [];
  const report = [];
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      if (m.type() === 'warning' && !/ReadPixels|GPU stall/.test(m.text())) log('warn:', m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.setDefaultTimeout(300000);
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${EXTRA ? '&' + EXTRA : ''}`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 300000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    const S = (fn, a) => page.evaluate(fn, a);
    // the software renderer's GPU timer reads ~1 s for the clouds, so their budget (Clouds.js
    // budgetMs) would step high down to medium after two seconds: keep the tier asked for
    await S(() => { const C = window.__sim.app.clouds; if (C && 'budgetMs' in C) { C.budgetMs = null; C.setQuality(C.quality); } });
    for (const s of list) {
      await S(async ({ spawn, time, climb, year, clouds, inside, back }) => {
        const sim = window.__sim, app = sim.app;
        if (app.env) app.env.year = year || 2026;     // the moon's phase
        if (app.clouds) app.clouds.choose(clouds || 'few');
        // a different height or place: the spawn itself is moved for this start (in memory only),
        // so the flight model trims there
        const sp = app.terrain.spawns[spawn];
        const keep = { x: sp.x, y: sp.y, z: sp.z };
        if (climb) sp.y = climb;
        const C = app.clouds;
        if (inside && C && C.layer) {
          // the nearest point (on a spiral) where the cumulus is solid for 900 m along the heading,
          // so the jet is still in it after the 2 s of flight below; back: start that far before the
          // cloud's edge on the way in (the field below its threshold: the rendered cloud is that
          // footprint pushed around by the 3D noise, up to ~150 m)
          const F = await import('./js/env/cloudField.js');
          const hd = (sp.heading_deg || 0) * Math.PI / 180;
          const fx = Math.sin(hd), fz = -Math.cos(hd);
          const solid = (x, z) => F.fieldAt((x + C.wind[0]) / C.layer.scale, (z + C.wind[1]) / C.layer.scale) > C.layer.threshold + 0.1;
          let best = null;
          for (let r = 0; r < 40000 && !best; r += 150) {
            for (let a = 0; a < 6.283; a += 150 / Math.max(r, 150)) {
              const x = sp.x + r * Math.cos(a), z = sp.z + r * Math.sin(a);
              if (solid(x, z) && solid(x + fx * 450, z + fz * 450) && solid(x + fx * 900, z + fz * 900)) { best = [x, z]; break; }
            }
          }
          if (best) {
            let [x, z] = best;
            if (back) {
              const field = (px, pz) => F.fieldAt((px + C.wind[0]) / C.layer.scale, (pz + C.wind[1]) / C.layer.scale);
              for (let k = 0; k < 6000 && field(x, z) > C.layer.threshold - 0.02; k += 25) { x -= fx * 25; z -= fz * 25; }
              x -= fx * back; z -= fz * back;
            }
            sp.x = x; sp.z = z; sp.y = inside;
          }
        }
        sim.start(spawn, { time, camera: 'chase' });
        Object.assign(sp, keep);
        sim.step(240);
      }, s);
      // test blocks (removed after the shot)
      await S(async (boxes) => {
        const app = window.__sim.app;
        if (app._testBlocks) { for (const m of app._testBlocks) app.scene.remove(m); app._testBlocks = null; }
        if (!boxes) return;
        const THREE = await import('three');
        const st = app.fdm.state, p = st.position;
        const hd = st.heading || 0;     // rad, 0 north (-z), + clockwise
        const fx = Math.sin(hd), fz = -Math.cos(hd), rx = Math.cos(hd), rz = Math.sin(hd);
        const mat = new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.9 });
        app._testBlocks = boxes.map(([r, a, w, h, d]) => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
          const x = p.x + rx * r + fx * a, z = p.z + rz * r + fz * a;
          const g = app.terrain.heightAt(x, z);
          m.position.set(x, g + h / 2, z);
          m.rotation.y = -hd;
          m.castShadow = true; m.receiveShadow = true;
          app.scene.add(m);
          return m;
        });
      }, s.boxes || null);
      if (typeof s.cam === 'string') await S((c) => { window.__sim.camera(c); window.__sim.step(24); }, s.cam);
      else if (s.cam.head) {
        // cockpit view with the head turned: yaw + = left, pitch + = up (degrees)
        await S(([yaw, pitch]) => {
          const sim = window.__sim, H = sim.app.cams.head;
          sim.camera('cockpit');
          H.yaw = yaw * Math.PI / 180; H.pitch = pitch * Math.PI / 180; H.centering = false;
          sim.step(12);
        }, s.cam.head);
      } else {
        const [yaw, pitch, dist] = s.cam.orbit;
        await S(({ yaw, pitch, dist }) => {
          const sim = window.__sim, app = sim.app, O = app.cams.orbit;
          sim.camera('orbit');
          const q = app.drawQuat;
          const back = app.camera.position.clone().set(0, 0, 1).applyQuaternion(q);
          O.init = true;
          O.auto = 0;
          O.yaw = Math.atan2(back.x, back.z) + yaw * Math.PI / 180;
          O.pitch = pitch * Math.PI / 180;
          O.dist = dist;
          sim.step(12);
        }, { yaw, pitch, dist });
      }
      const ms0 = Date.now();
      await S(() => window.__sim.settle(2500));
      // the start-up toast would cover the sky in every picture
      await S(() => { const t = document.getElementById('toast'); if (t) { t.classList.remove('show'); t.style.transition = 'none'; t.style.opacity = '0'; } });
      await sleep(300);
      await S((n) => { for (let i = 0; i < n; i++) window.__sim.render(); }, Math.max(1, FRAMES));
      const info = await S(() => {
        const sim = window.__sim, env = sim.app.env;
        return { ri: sim.renderInfo(), t: sim.timing().lastRenderMs, exposure: env.exposure, bias: env.exposureBias,
          sunEl: env.sunElevationDeg, nightVision: env.nightVision, K: env.meteredLight, albedo: env.groundAlbedo,
          datum: env.groundDatum, post: sim.app.post ? sim.app.post.info?.() : null,
          clouds: sim.app.clouds ? sim.app.clouds.info() : null };
      });
      const file = join(OUT, `${s.name}.png`);
      await page.screenshot({ path: file });
      if (s.pair) {
        await S(() => window.__sim.render());
        await page.screenshot({ path: join(OUT, `${s.name}_b.png`) });
      }
      report.push({ ...s, file, ...info, wallMs: Date.now() - ms0 });
      appendFileSync(lines, JSON.stringify(report[report.length - 1]) + '\n');
      log(`${s.name}: ${info.ri.calls} calls, ${(info.ri.triangles / 1e6).toFixed(2)} M tris, ${info.t} ms, exposure ${(+info.exposure).toFixed(3)}, sun ${(+info.sunEl).toFixed(1)} deg, nv ${(+info.nightVision || 0).toFixed(2)}, albedo ${(+info.albedo || 0).toFixed(3)}, datum ${(+info.datum || 0).toFixed(0)}${info.clouds ? `, clouds ${info.clouds.preset} ${info.clouds.low.join('x')}` : ''}`);
    }
    // gpuMemory() counts the modules' own targets now (stats.js moduleTargets); the share of the
    // HDR chain, the clouds and the sky LUTs, for the report
    const mem = await S(async () => {
      const sim = window.__sim, app = sim.app;
      const st = await import('./js/test/stats.js');
      const THREE = await import('three');
      const empty = new THREE.Scene();
      const only = (m) => (m && m.targets ? st.estimateGpuMemory(app.renderer, empty, m.targets()).targetsMB : 0);
      return { ...sim.gpuMemory(), postMB: only(app.post), cloudsMB: only(app.clouds), envMB: only(app.env) };
    });
    const timing = await S(() => window.__sim.timing());
    log(`GPU memory estimate ${mem.totalMB} MB (textures ${mem.texturesMB}, targets ${mem.targetsMB} of which post ${mem.postMB}, clouds ${mem.cloudsMB}, sky ${mem.envMB}; framebuffer ${mem.framebufferMB}, geometry ${mem.geometryMB})`);
    // every shot of the run, the earlier sessions' too (the memory and timing are this session's)
    const shots = new Map();
    for (const l of (existsSync(lines) ? readFileSync(lines, 'utf8') : '').split('\n')) {
      try { const e = JSON.parse(l); shots.set(e.name, e); } catch { /* blank line */ }
    }
    writeFileSync(join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), size: [W, H], quality: QUALITY, params: EXTRA, session: report.map((e) => e.name), shots: [...shots.values()], gpuMemory: mem, timing, problems }, null, 1));
    if (problems.length) log('PROBLEMS:', problems.slice(0, 8).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error('[shots]', e); process.exit(1); });
