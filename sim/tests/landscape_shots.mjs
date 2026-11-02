// Landscape screenshots (the Dead Sea basin, the rift walls, the evaporation ponds, the
// Mediterranean coast and its ports) in the real app (index.html?test=1), driven through
// window.__sim, with renderInfo / gpuMemory, the landscape module's stats and the sampler
// count of every program it adds.
//
//   node sim/tests/landscape_shots.mjs [--port 8500] [--out DIR] [--quality high] [--size 960x540]
//                                      [--scenes a,b,c] [--root SIM_FOLDER] [--tag suffix]
//                                      [--url-extra "&deadSea=0"] [--mirror] [--list]
//
// --mirror also saves the Dead Sea's mirror picture of each scene (<name>_mirror.png, simple
// tone map; DeadSea.js), when it was drawn.
//
// Screenshots go to --out (default /home/claude/simdata/shots/landscape/). Needs the data in
// sim/data (DESIGN.md). Every scene waits for the terrain's horizon maps, tiles and programs.

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
const PORT = +arg('port', 8500);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/landscape'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const ONLY = arg('scenes', '') ? arg('scenes', '').split(',') : null;
const TAG = arg('tag', '');
const EXTRA = arg('url-extra', '');
const BASE = `http://127.0.0.1:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[landscape ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// spawn: a name from spawns.json, or {x, z, agl | alt, hdg, speed} (airborne, gear up; agl above
// the ground or the sea, alt: metres above sea level); look: {yaw, pitch} (deg, + = left / up)
// for the cockpit head.
const DS = { x: 45489, z: 7661 };            // deadsea_low (31.73 N 35.51 E)
export const SCENES = [
  // the Dead Sea 300 m above the water, heading south, morning, noon and late afternoon
  { name: 'deadsea_low_0700_chase', spawn: 'deadsea_low', time: 7, camera: 'chase' },
  { name: 'deadsea_low_0700_cockpit', spawn: 'deadsea_low', time: 7, camera: 'cockpit' },
  { name: 'deadsea_low_1200_chase', spawn: 'deadsea_low', time: 12, camera: 'chase' },
  { name: 'deadsea_low_1200_cockpit', spawn: 'deadsea_low', time: 12, camera: 'cockpit' },
  { name: 'deadsea_low_1730_chase', spawn: 'deadsea_low', time: 17.5, camera: 'chase' },
  { name: 'deadsea_low_1730_cockpit', spawn: 'deadsea_low', time: 17.5, camera: 'cockpit' },
  // the PC flight film's frame (capture_v2/1450.jpg): 09:00, chase
  { name: 'deadsea_low_0900_chase', spawn: 'deadsea_low', time: 9, camera: 'chase' },
  // the walls from the water: east to Moab, west to the Judean cliffs (cockpit head turned)
  { name: 'deadsea_low_0900_west', spawn: 'deadsea_low', time: 9, camera: 'cockpit', look: { yaw: -80, pitch: 2 } },
  { name: 'deadsea_low_1500_east', spawn: 'deadsea_low', time: 15, camera: 'cockpit', look: { yaw: 80, pitch: 2 } },
  // from 3,000 m: south down the basin, east over the Moab escarpment
  { name: 'deadsea3000_south_1000_chase', spawn: { ...DS, alt: 3000, hdg: 180, speed: 200 }, time: 10, camera: 'chase' },
  { name: 'deadsea3000_south_1000_cockpit', spawn: { ...DS, alt: 3000, hdg: 180, speed: 200 }, time: 10, camera: 'cockpit', look: { yaw: 0, pitch: -8 } },
  { name: 'deadsea3000_east_1000_cockpit', spawn: { x: 38000, z: 20000, alt: 3000, hdg: 90, speed: 200 }, time: 10, camera: 'cockpit', look: { yaw: 0, pitch: -6 } },
  { name: 'deadsea3000_east_1600_chase', spawn: { x: 38000, z: 20000, alt: 3000, hdg: 90, speed: 200 }, time: 16, camera: 'chase' },
  // Ein Gedi (Nahal David, Nahal Arugot): 500 m above the water, along the shore
  { name: 'eingedi500_0900_chase', spawn: { x: 36500, z: 46000, alt: 70, hdg: 345, speed: 160 }, time: 9, camera: 'chase' },
  { name: 'eingedi500_1600_cockpit', spawn: { x: 37500, z: 44000, alt: 70, hdg: 330, speed: 160 }, time: 16, camera: 'cockpit', look: { yaw: 30, pitch: -2 } },
  // the sinkholes and the waterline on the flats south of Ein Gedi (-400 .. -425 m), 150 m up
  { name: 'sinkholes150_1000_cockpit', spawn: { x: 35400, z: 47600, alt: -270, hdg: 0, speed: 130 }, time: 10, camera: 'cockpit', look: { yaw: -60, pitch: -28 } },
  // the same shore from above and west of the jet (the orbit camera 420 m above the flats)
  { name: 'sinkholes150_1000_orbit', spawn: { x: 35400, z: 47600, alt: -270, hdg: 0, speed: 130 }, time: 10, camera: 'orbit', orbit: { yaw: -90, pitch: 50, dist: 350 } },
  // the evaporation ponds south of the Lisan, from 3,000 m over the Lisan strait looking south
  { name: 'ponds3000_1100_cockpit', spawn: { x: 41000, z: 50000, alt: 3000, hdg: 185, speed: 200 }, time: 11, camera: 'cockpit', look: { yaw: 0, pitch: -12 } },
  // pond 5 and the Ein Bokek hotels from over the western cliffs, 1,200 m, looking east-south-east
  { name: 'einbokek1200_1100_cockpit', spawn: { x: 29000, z: 64000, alt: 1200, hdg: 110, speed: 160 }, time: 11, camera: 'cockpit', look: { yaw: 0, pitch: -20 } },
  { name: 'einbokek1200_1600_chase', spawn: { x: 29000, z: 64000, alt: 1200, hdg: 110, speed: 160 }, time: 16, camera: 'chase' },
  // the Ein Bokek hotels (Shore.js blocks): the hotel strip from its west side, the sun behind
  // the camera, looking east over it to the ponds; then from 300 m south-east of them, by day
  // and at night
  { name: 'einbokek_hotels_1600_orbit', spawn: { x: 31565, z: 66478, alt: 0, hdg: 90, speed: 130 }, time: 16, camera: 'orbit', orbit: { yaw: -90, pitch: 15, dist: 250 } },
  { name: 'einbokek300_1600_chase', spawn: { x: 33500, z: 68500, alt: -80, hdg: 327, speed: 130 }, time: 16, camera: 'chase' },
  { name: 'einbokek300_2030_cockpit', spawn: { x: 33500, z: 68500, alt: -80, hdg: 327, speed: 130 }, time: 20.5, camera: 'cockpit', look: { yaw: 0, pitch: -8 } },
  // the coast
  { name: 'tlv3000_1200_chase', spawn: 'tlv_3000', time: 12, camera: 'chase' },
  { name: 'tlv3000_1845_chase', spawn: 'tlv_3000', time: 18.75, camera: 'chase' },
  { name: 'coast_low_1200_chase', spawn: 'coast_low', time: 12, camera: 'chase' },
  { name: 'coast_low_1200_cockpit', spawn: 'coast_low', time: 12, camera: 'cockpit', look: { yaw: -40, pitch: -6 } },
  { name: 'coast_low_0700_chase', spawn: 'coast_low', time: 7, camera: 'chase' },
  { name: 'coast_low_1845_chase', spawn: 'coast_low', time: 18.75, camera: 'chase' },
  // Tel Aviv's detached breakwaters and the marina, Jaffa port, from 600 m over the sea
  { name: 'tlv_breakwaters600_1100_cockpit', spawn: { x: -27000, z: -27500, alt: 600, hdg: 20, speed: 160 }, time: 11, camera: 'cockpit', look: { yaw: -18, pitch: -11 } },
  { name: 'tlv_breakwaters200_1100_chase', spawn: { x: -26000, z: -28800, alt: 200, hdg: 20, speed: 140 }, time: 11, camera: 'chase' },
  // Ashdod port from 1,000 m, west of it heading north-east
  { name: 'ashdod1000_1100_cockpit', spawn: { x: -40500, z: -1000, alt: 1000, hdg: 30, speed: 160 }, time: 11, camera: 'cockpit', look: { yaw: -15, pitch: -18 } },
  { name: 'ashdod1000_1100_chase', spawn: { x: -40500, z: -1000, alt: 1000, hdg: 30, speed: 160 }, time: 11, camera: 'chase' },
  // the kurkar cliffs at Apollonia (Herzliya) and Ashkelon, 150 m
  { name: 'apollonia150_1500_chase', spawn: { x: -21800, z: -40500, alt: 150, hdg: 10, speed: 150 }, time: 15, camera: 'chase' },
  { name: 'ashkelon150_1500_chase', spawn: { x: -46200, z: 11500, alt: 150, hdg: 20, speed: 150 }, time: 15, camera: 'chase' },
  // the Apollonia cliff (35-40 m of kurkar) from 60 m over the sea, 700 m out, the head turned to it
  { name: 'apollonia_cliff60_1500_cockpit', spawn: { x: -21300, z: -43800, alt: 60, hdg: 15, speed: 140 }, time: 15, camera: 'cockpit', look: { yaw: -55, pitch: -3 } },
  { name: 'apollonia_cliff60_1500_chase', spawn: { x: -21500, z: -43400, alt: 60, hdg: 25, speed: 140 }, time: 15, camera: 'chase' },
  // Tel Nof: the ground beside the runway (capture_v2/0480.jpg, 70 m at 16:48) and on the runway
  { name: 'telnof70_1648_chase', spawn: { x: -19661, z: -2838, agl: 70, hdg: 358, speed: 110 }, time: 16.8, camera: 'chase', steps: 30 },
  { name: 'telnof36_1200_chase', spawn: 'telnof_36', time: 12, camera: 'chase' },
  { name: 'telnof70_1648_chase_lc', spawn: { x: -19661, z: -2838, agl: 70, hdg: 358, speed: 110 }, time: 16.8, camera: 'chase', steps: 30, debugView: 1 },
  { name: 'telnof70_1648_chase_gd', spawn: { x: -19661, z: -2838, agl: 70, hdg: 358, speed: 110 }, time: 16.8, camera: 'chase', steps: 30, debugView: 3 },
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

/** In the page: the Dead Sea's mirror target as a PNG data URL (x / (1 + x) tone map), or null. */
function mirrorPicture() {
  const app = window.__sim.app, lake = app.terrain?.lake, t = lake?.mirrorTarget;
  if (!t) return null;
  const w = t.width, h = t.height;
  const raw = new Uint16Array(w * h * 4);          // half floats (the target's type)
  try {
    app.renderer.readRenderTargetPixels(t, 0, 0, w, h, raw);
  } catch (e) {
    return null;
  }
  const half = (v) => {
    const e = (v >> 10) & 31, m = v & 1023, sgn = v & 32768 ? -1 : 1;
    return e === 0 ? sgn * m * 2 ** -24 : e === 31 ? 0 : sgn * (1 + m / 1024) * 2 ** (e - 15);
  };
  const buf = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = half(raw[i]);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const ex = (app.env?.exposure ?? 1) * (app.env?.exposureBias ?? 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((h - 1 - y) * w + x) * 4, o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = buf[i + k] * ex;
        img.data[o + k] = Math.round(255 * Math.pow(v / (1 + v), 1 / 2.2));
      }
      // no terrain (alpha 0): magenta, to see the coverage
      if (buf[i + 3] < 0.5) { img.data[o] = 120; img.data[o + 1] = 0; img.data[o + 2] = 120; }
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/**
 * In the page (--probe): the mirror lookup of LAKE_FRAG redone on the CPU for a column of
 * screen points (unrippled): lake point, reflected ray, mirror uv and the mirror's alpha there.
 */
function mirrorProbe() {
  const app = window.__sim.app, lake = app.terrain?.lake, t = lake?.mirrorTarget, cam = app.camera;
  if (!t) return null;
  const THREE = window.__sim.THREE || null;
  const w = t.width, h = t.height;
  const raw = new Uint16Array(w * h * 4);
  app.renderer.readRenderTargetPixels(t, 0, 0, w, h, raw);
  const e = cam.matrixWorld.elements, pe = cam.projectionMatrixInverse.elements;
  const C = [e[12], e[13], e[14]];
  const H2 = lake.uniforms.uMirrorInfo.value.y;
  const M = lake._mirrorMatrix.elements;
  const mc = lake.mirrorCamera;
  const out = { cam: C.map((v) => +v.toFixed(1)), H2, mirrorPos: mc.position.toArray().map((v) => +v.toFixed(1)),
    mirrorFwd: mc.getWorldDirection(mc.position.clone()).toArray().map((v) => +v.toFixed(3)),
    camFwd: [-e[8], -e[9], -e[10]].map((v) => +v.toFixed(3)), mirrorUp: mc.up.toArray().map((v) => +v.toFixed(3)), pts: [] };
  const mul = (m, v) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
  for (const ny of [-0.05, -0.1, -0.15, -0.2, -0.3, -0.45, -0.6, -0.8]) {
    // camera-space direction of NDC (0, ny), to world
    const v = mul(pe, [0, ny, 1, 1]);
    const dc = [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
    const d = [e[0] * dc[0] + e[4] * dc[1] + e[8] * dc[2], e[1] * dc[0] + e[5] * dc[1] + e[9] * dc[2], e[2] * dc[0] + e[6] * dc[1] + e[10] * dc[2]];
    const L = Math.hypot(...d); for (let k = 0; k < 3; k++) d[k] /= L;
    if (d[1] >= 0) { out.pts.push({ ny, sky: true }); continue; }
    const s = (-427 - C[1]) / d[1];
    const rel = [d[0] * s, d[1] * s, d[2] * s];
    const R = [d[0], -d[1], d[2]];
    const pm = [rel[0] + R[0] * 6000, rel[1] + H2 + R[1] * 6000, rel[2] + R[2] * 6000, 1];
    const c = mul(M, pm);
    const u = c[0] / c[3] * 0.5 + 0.5, vv = c[1] / c[3] * 0.5 + 0.5;
    const px = Math.min(w - 1, Math.max(0, Math.floor(u * w))), py = Math.min(h - 1, Math.max(0, Math.floor(vv * h)));
    const half = (q) => { const ex = (q >> 10) & 31, m = q & 1023; return ex === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (ex - 15); };
    const a = half(raw[(py * w + px) * 4 + 3]);
    // where along this column the mirror has terrain
    let rows = [];
    for (let y = 0; y < h; y++) if (half(raw[(y * w + px) * 4 + 3]) > 0.5) rows.push(y);
    out.pts.push({ ny, dist: Math.round(s), u: +u.toFixed(3), v: +vv.toFixed(3), w: +c[3].toFixed(1), alpha: +a.toFixed(2),
      terrainRows: rows.length ? [rows[0], rows[rows.length - 1]] : null });
  }
  return out;
}

async function main() {
  if (argv.includes('--list')) { for (const s of SCENES) console.log(s.name); return; }
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
    page.setDefaultTimeout(900000);
    const tl = Date.now();
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${EXTRA}`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 900000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    log(`loaded in ${((Date.now() - tl) / 1000).toFixed(1)} s`);
    const S = (fn, a) => page.evaluate(fn, a);
    await page.addStyleTag({ content: '#toast { display: none !important; }' });
    const look = (l) => S((v) => { const h = window.__sim.app.cams.head; h.yaw = v.yaw * Math.PI / 180; h.pitch = v.pitch * Math.PI / 180; }, l);
    // the orbit camera placed: world yaw (0: from the south, -90: from the west), pitch above the jet, distance
    const orbit = (o) => S((v) => {
      const O = window.__sim.app.cams.orbit;
      O.init = true; O.auto = 0; O.yaw = v.yaw * Math.PI / 180; O.pitch = v.pitch * Math.PI / 180; O.dist = v.dist;
    }, o);

    for (const sc of SCENES) {
      // a filter that is a scene's whole name picks that scene alone, else every scene containing it
      if (ONLY && !ONLY.some((o) => (SCENES.some((x) => x.name === o) ? sc.name === o : sc.name.includes(o)))) continue;
      const ts = Date.now();
      await S((s) => {
        const sim = window.__sim, app = sim.app;
        let name = s.spawn;
        if (typeof s.spawn === 'object') {
          const g = app.terrain.heightAt(s.spawn.x, s.spawn.z);
          name = '__shot';
          app.terrain.spawns[name] = {
            label: s.name, x: s.spawn.x, z: s.spawn.z, y: s.spawn.alt ?? Math.max(g, 0) + s.spawn.agl, ground_y: g,
            heading_deg: s.spawn.hdg, on_ground: false, speed_ms: s.spawn.speed, gear: 0, throttle: 0.45,
          };
        }
        sim.start(name, { time: s.time, camera: s.camera });
        // debug: the terrain's false-colour view (Terrain.js debug.view: 1 land cover, 3 ground detail ...)
        app.terrain.debug.view = s.debugView || 0;
        if (s.time != null) sim.time(s.time);
        sim.setInput({ throttle: s.spawn === 'telnof_36' ? 0 : 0.6 });
        return true;
      }, sc);
      await S((n) => window.__sim.step(n), sc.steps ?? 60);
      if (sc.look) await look(sc.look);
      if (sc.orbit) await orbit(sc.orbit);
      let sum = await S((ms) => window.__sim.settle(ms), sc.settle || 2500);
      const hz = await S(async () => {
        const t = window.__sim.app.terrain, h = t.horizon;
        const t1 = performance.now();
        const busy = () => (h && h.enabled && (h.busy || h.pending || h._upload || !h.ready)) ||
          t.stats.tilesLoading > 0 || t._pending.length > 0 || t.qualityPending;
        while (busy() && performance.now() - t1 < 120000) {
          t.update(window.__sim.app.camera);
          await new Promise((r) => setTimeout(r, 250));
        }
        return { waited: Math.round(performance.now() - t1), ms: h ? h.stats.lastMs : 0, enabled: !!(h && h.enabled) };
      });
      if (hz.waited > 300) sum = await S((ms) => window.__sim.settle(ms), 400);
      if (sc.look) await look(sc.look);
      if (sc.orbit) await orbit(sc.orbit);
      // one more frame: temporal filters (clouds) and the module's own passes settle
      await S(() => window.__sim.render());
      const info = await S(() => window.__sim.renderInfo());
      const tm = await S(() => window.__sim.timing());
      const ls = await S(() => {
        const app = window.__sim.app, out = {};
        if (app.terrain?.lake) out.lake = { ...app.terrain.lake.stats };
        const m = (app.modules || []).find((x) => x && x.name === 'landscape');
        if (m?.stats) out.landscape = { ...m.stats };
        const sh = (app.modules || []).find((x) => x && x.name === 'shore');
        if (sh?.stats) out.shore = { ...sh.stats };
        return Object.keys(out).length ? out : null;
      });
      const file = join(OUT, `${sc.name}${TAG}.png`);
      await page.screenshot({ path: file });
      if (argv.includes('--mirror')) {
        const url = await S(mirrorPicture);
        if (url) writeFileSync(join(OUT, `${sc.name}${TAG}_mirror.png`), Buffer.from(url.split(',')[1], 'base64'));
      }
      if (argv.includes('--probe')) log('probe', JSON.stringify(await S(mirrorProbe)));
      results.push({ name: sc.name, file, summary: sum, render: info, ms: tm.lastRenderMs, landscape: ls });
      log(`${sc.name}${TAG}: ${info.calls} calls, ${(info.triangles / 1e6).toFixed(2)} M tris, ${tm.lastRenderMs} ms, `
        + `alt ${sum.alt_m} m agl ${sum.agl_m} m${ls ? `, landscape ${JSON.stringify(ls)}` : ''} (${((Date.now() - ts) / 1000).toFixed(0)} s)`);
    }
    const mem = await S(() => window.__sim.gpuMemory());
    const samplers = await S(samplerCounts);
    log(`GPU memory estimate ${mem.totalMB} MB (textures ${mem.texturesMB}, geometry ${mem.geometryMB})`);
    for (const p of samplers.filter((q) => /Terrain|DeadSea|Water|Coast|Landscape|Port|Mirror/i.test(q.name))) log(`program ${p.name}: ${p.samplers} samplers (${p.names.join(', ')})`);
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

main().catch((e) => { console.error('[landscape]', e); process.exit(1); });
