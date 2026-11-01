// Terrain look-development screenshots in the real app (index.html?test=1), driven through
// window.__sim: the scenes of the terrain brief (Tel Nof 36 at noon and 07:00, low flying over
// the fields, the Judean hills at sunset, Jerusalem from 1,500 m, the coast at 300 m, 3,000 m
// cruise, the Dead Sea) in the cockpit and chase views, with renderInfo / gpuMemory and the
// sampler count of every terrain program.
//
//   node sim/dev/terrain.shots.mjs [--port 8146] [--out DIR] [--quality high] [--size 960x540]
//                                  [--scenes a,b,c] [--root SIM_FOLDER] [--tag suffix]
//                                  [--url-extra "&terrainDetail=0"] [--view 1,5] [--perf]
//
// Every scene name is printed with its numbers; screenshots go to --out (default
// /home/claude/simdata/shots/terrain/). Needs the data in sim/data (DESIGN.md). --view adds
// false-colour shots per scene (terrain.debug.view: 1 classes, 2 row directions, 3 near detail,
// 4 crop state, 5 terrain shadow). Before each shot it waits for the horizon maps and tiles.

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
const PORT = +arg('port', 8146);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/terrain'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const ONLY = arg('scenes', '') ? arg('scenes', '').split(',') : null;
const TAG = arg('tag', '');
const EXTRA = arg('url-extra', '');
// terrain.debug.view for false-colour checks (see Terrain.js): --view 1,2,4 shoots each scene per view
const VIEWS = arg('view', '') ? arg('view', '').split(',').map(Number) : [0];
// --perf: per scene, the frame time with each terrain feature switched off in turn (same page,
// same view; on SwiftShader this is CPU time per pixel, i.e. the relative ALU cost)
const PERF = argv.includes('--perf');
const BASE = `http://127.0.0.1:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[shots ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// spawn: a name from spawns.json, or {x, z, agl, hdg, speed} (airborne, gear up)
// look: {yaw, pitch} in degrees for the cockpit head (optional)
export const SCENES = [
  { name: 'telnof36_noon_chase', spawn: 'telnof_36', time: 12, camera: 'chase', steps: 120, settle: 3500 },
  { name: 'telnof36_noon_cockpit', spawn: 'telnof_36', time: 12, camera: 'cockpit', steps: 60, settle: 1500 },
  { name: 'telnof36_0700_chase', spawn: 'telnof_36', time: 7, camera: 'chase', steps: 120, settle: 2500 },
  { name: 'telnof36_0700_cockpit', spawn: 'telnof_36', time: 7, camera: 'cockpit', steps: 60, settle: 1500 },
  // low over the fields south-west of Tel Nof, heading north-east, 120 m above the ground
  { name: 'fields120_noon_chase', spawn: { x: -24500, z: 4500, agl: 120, hdg: 35, speed: 150 }, time: 12, camera: 'chase', steps: 90, settle: 3500 },
  { name: 'fields120_noon_cockpit', spawn: { x: -24500, z: 4500, agl: 120, hdg: 35, speed: 150 }, time: 12, camera: 'cockpit', steps: 30, settle: 1500 },
  { name: 'fields120_0700_chase', spawn: { x: -24500, z: 4500, agl: 120, hdg: 35, speed: 150 }, time: 7, camera: 'chase', steps: 90, settle: 2500 },
  { name: 'fields120_0700_cockpit', spawn: { x: -24500, z: 4500, agl: 120, hdg: 35, speed: 150 }, time: 7, camera: 'cockpit', steps: 30, settle: 1500 },
  // close look at the ground materials (not in the brief's list; for tuning)
  { name: 'fields40_noon_chase', spawn: { x: -24500, z: 4500, agl: 40, hdg: 35, speed: 150 }, time: 12, camera: 'chase', steps: 30, settle: 1500 },
  { name: 'fields40_0700_chase', spawn: { x: -24500, z: 4500, agl: 40, hdg: 35, speed: 150 }, time: 7, camera: 'chase', steps: 30, settle: 1500 },
  { name: 'judean_sunset_chase', spawn: 'jerusalem_sunset', camera: 'chase', steps: 120, settle: 3500 },
  { name: 'judean_sunset_cockpit', spawn: 'jerusalem_sunset', camera: 'cockpit', steps: 30, settle: 1500 },
  { name: 'jerusalem1500_noon_chase', spawn: 'jerusalem_sunset', time: 12, camera: 'chase', steps: 120, settle: 3500 },
  { name: 'jerusalem1500_noon_cockpit', spawn: 'jerusalem_sunset', time: 12, camera: 'cockpit', steps: 30, settle: 1500 },
  { name: 'coast300_chase', spawn: 'coast_low', time: 12, camera: 'chase', steps: 120, settle: 3500 },
  { name: 'coast300_cockpit', spawn: 'coast_low', time: 12, camera: 'cockpit', steps: 30, settle: 1500 },
  { name: 'cruise3000_chase', spawn: 'tlv_3000', time: 12, camera: 'chase', steps: 120, settle: 3500 },
  { name: 'cruise3000_cockpit', spawn: 'tlv_3000', time: 12, camera: 'cockpit', steps: 30, settle: 1500 },
  { name: 'deadsea_low_chase', spawn: 'deadsea_low', time: 12, camera: 'chase', steps: 120, settle: 3500 },
  // the hills south-west of Jerusalem (terraces, garrigue), 150 m, morning sun from the east
  { name: 'hills150_0800_chase', spawn: { x: 9000, z: 5500, agl: 150, hdg: 60, speed: 150 }, time: 8, camera: 'chase', steps: 90, settle: 3500 },
  { name: 'hills150_0800_cockpit', spawn: { x: 9000, z: 5500, agl: 150, hdg: 60, speed: 150 }, time: 8, camera: 'cockpit', steps: 30, settle: 1500 },
  // Dead Sea shore (salt, mud flats, old shorelines), 150 m
  { name: 'deadsea_shore150_chase', spawn: { x: 38500, z: 6500, agl: 150, hdg: 150, speed: 150 }, time: 9, camera: 'chase', steps: 90, settle: 3500 },
  // dawn: the Moab plateau's shadow over the Dead Sea's west shore, the Judean cliffs lit above it
  { name: 'deadsea_dawn_chase', spawn: { x: 36000, z: 6500, agl: 400, hdg: 255, speed: 150 }, time: 5.35, camera: 'chase', steps: 30, settle: 2500 },
  // beach and dunes south of Ashdod, 120 m
  { name: 'dunes120_chase', spawn: { x: -41500, z: 11500, agl: 120, hdg: 20, speed: 150 }, time: 10, camera: 'chase', steps: 90, settle: 3500 },
  // night over Tel Aviv, 1,500 m
  { name: 'tlv_night_cockpit', spawn: { x: -20000, z: -27000, agl: 1500, hdg: 290, speed: 180 }, time: 21.5, camera: 'cockpit', steps: 30, settle: 2500 },
  { name: 'tlv_night_chase', spawn: { x: -20000, z: -27000, agl: 1500, hdg: 290, speed: 180 }, time: 21.5, camera: 'chase', steps: 30, settle: 2500 },
  { name: 'tlv_night400_chase', spawn: { x: -21500, z: -29500, agl: 400, hdg: 250, speed: 150 }, time: 21.5, camera: 'chase', steps: 30, settle: 2500 },
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

/** In the page: active sampler uniforms of every program three has linked (vertex + fragment). */
function samplerCounts() {
  const app = window.__sim.app, r = app.renderer, gl = r.getContext();
  const types = new Set([gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_SHADOW, gl.SAMPLER_2D_ARRAY,
    gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW, gl.INT_SAMPLER_2D, gl.INT_SAMPLER_3D, gl.INT_SAMPLER_CUBE,
    gl.INT_SAMPLER_2D_ARRAY, gl.UNSIGNED_INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_3D, gl.UNSIGNED_INT_SAMPLER_CUBE,
    gl.UNSIGNED_INT_SAMPLER_2D_ARRAY]);
  const out = [];
  for (const p of r.info.programs || []) {
    const prog = p.program;
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    const names = [];
    for (let i = 0; i < n; i++) {
      const u = gl.getActiveUniform(prog, i);
      if (types.has(u.type)) names.push(u.name + (u.size > 1 ? `[${u.size}]` : ''));
    }
    out.push({ name: p.name, samplers: names.length, names });
  }
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const problems = [];
  const warnings = new Map();
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error') problems.push(`console: ${t}`);
      if (m.type() === 'warning') warnings.set(t.slice(0, 160), (warnings.get(t.slice(0, 160)) || 0) + 1);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText || ''}`));
    page.setDefaultTimeout(600000);
    const tl = Date.now();
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${EXTRA}`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 600000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    log(`loaded in ${((Date.now() - tl) / 1000).toFixed(1)} s`);
    const S = (fn, a) => page.evaluate(fn, a);
    await page.addStyleTag({ content: '#toast { display: none !important; }' });

    for (const sc of SCENES) {
      if (ONLY && !ONLY.some((o) => sc.name.includes(o))) continue;
      const ts = Date.now();
      await S((s) => {
        const sim = window.__sim, app = sim.app;
        let name = s.spawn;
        if (typeof s.spawn === 'object') {
          const g = app.terrain.heightAt(s.spawn.x, s.spawn.z);
          name = '__shot';
          app.terrain.spawns[name] = {
            label: s.name, x: s.spawn.x, z: s.spawn.z, y: Math.max(g, 0) + s.spawn.agl, ground_y: g,
            heading_deg: s.spawn.hdg, on_ground: false, speed_ms: s.spawn.speed, gear: 0, throttle: 0.45,
          };
        }
        sim.start(name, { time: s.time, camera: s.camera });
        if (s.time != null) sim.time(s.time);
        sim.setInput({ throttle: s.spawn === 'telnof_36' ? 0 : 0.6 });
        return true;
      }, sc);
      await S((n) => window.__sim.step(n), sc.steps || 60);
      let sum = await S((ms) => window.__sim.settle(ms), sc.settle || 2500);
      // the terrain's shadows and tiles come from workers: wait for the maps of this sun and
      // place, and for the tiles in range
      const hz = await S(async () => {
        const t = window.__sim.app.terrain, h = t.horizon;
        const t1 = performance.now();
        const busy = () => (h && h.enabled && (h.busy || h.pending || !h.ready)) || t.stats.tilesLoading > 0 || t._pending.length > 0;
        while (busy() && performance.now() - t1 < 120000) {
          t.update(window.__sim.app.camera);
          await new Promise((r) => setTimeout(r, 250));
        }
        return { waited: Math.round(performance.now() - t1), ms: h ? h.stats.lastMs : 0, enabled: !!(h && h.enabled) };
      });
      if (hz.waited > 300) sum = await S((ms) => window.__sim.settle(ms), 400);
      const info = await S(() => window.__sim.renderInfo());
      const tm = await S(() => window.__sim.timing());
      const ter = await S(() => ({ ...window.__sim.app.terrain.stats }));
      const file = join(OUT, `${sc.name}${TAG}.png`);
      for (const v of VIEWS) {
        if (v) await S((vv) => { window.__sim.app.terrain.debug.view = vv; window.__sim.render(); }, v);
        await page.screenshot({ path: v ? file.replace(/\.png$/, `_view${v}.png`) : file });
      }
      if (VIEWS.some((v) => v)) await S(() => { window.__sim.app.terrain.debug.view = 0; });
      let perf = null;
      if (PERF) {
        perf = await S(() => {
          const t = window.__sim.app.terrain;
          const keep = { d: t.groundDetail, s: t.shadows, c: t.cityLights };
          const cfgs = { all: [keep.d, keep.s, keep.c], noDetail: [false, keep.s, keep.c], noShadows: [keep.d, false, keep.c],
            noCityLights: [keep.d, keep.s, 0], allOff: [false, false, 0] };
          const out = {};
          for (const [k, [d, sh, c]] of Object.entries(cfgs)) {
            t.groundDetail = d; t.shadows = sh; t.cityLights = c;
            window.__sim.render();
            out[k] = Math.min(window.__sim.render().ms, window.__sim.render().ms);
          }
          t.groundDetail = keep.d; t.shadows = keep.s; t.cityLights = keep.c;
          return out;
        });
        log(`  perf ${sc.name}: ` + Object.entries(perf).map(([k, v]) => `${k} ${v} ms`).join(', '));
      }
      results.push({ name: sc.name, file, summary: sum, render: info, ms: tm.lastRenderMs, terrain: ter, perf });
      log(`${sc.name}${TAG}: ${info.calls} calls, ${(info.triangles / 1e6).toFixed(2)} M tris, ${tm.lastRenderMs} ms, `
        + `alt ${sum.alt_m} m agl ${sum.agl_m} m, tiles ${ter.tilesResident}, horizon ${hz.enabled ? `${hz.ms} ms (waited ${hz.waited} ms)` : 'off'} `
        + `(${((Date.now() - ts) / 1000).toFixed(0)} s)`);
    }
    const mem = await S(() => window.__sim.gpuMemory());
    const samplers = await S(samplerCounts);
    const terrainProgs = samplers.filter((p) => /Terrain/.test(p.name));
    log(`GPU memory estimate ${mem.totalMB} MB (textures ${mem.texturesMB}, geometry ${mem.geometryMB})`);
    for (const p of terrainProgs) log(`program ${p.name}: ${p.samplers} samplers (${p.names.join(', ')})`);
    const maxS = Math.max(0, ...samplers.map((p) => p.samplers));
    log(`max samplers in any program: ${maxS} (${samplers.filter((p) => p.samplers === maxS).map((p) => p.name).join(', ')})`);
    for (const [w, n] of warnings) log(`warning x${n}: ${w}`);
    if (problems.length) log('PROBLEMS:', problems.slice(0, 10).join('\n'));
    writeFileSync(join(OUT, `report${TAG}.json`), JSON.stringify({ when: new Date().toISOString(), quality: QUALITY, size: [W, H],
      results, gpuMemory: mem, samplers, warnings: [...warnings], problems }, null, 1));
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error('[shots]', e); process.exit(1); });
