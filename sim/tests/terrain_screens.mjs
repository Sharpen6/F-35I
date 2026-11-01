// Playwright screenshots of the terrain / environment test page (sim/dev/terrain.html).
//
//   node sim/tests/terrain_screens.mjs [--out /tmp/terrain/shots] [--only a,b] [--port 8101]
//                                      [--base http://127.0.0.1:8101/sim/] [--data <url>]
//                                      [--query depth=log] [--no-checks]
//
// Without --base it serves sim/ itself (python3 -m http.server on --port, killed at the end).
// --data points the page at another terrain folder (e.g. a synthetic one, see
// sim/dev/make_synthetic_terrain.py). Chromium runs headless on SwiftShader at 960 x 540,
// so every frame takes seconds: the page is paused, the L0 tiles are streamed with
// update-only steps, and only the final frames are rendered.
//
// Writes <out>/<view>.png and <out>/terrain_screens.json (triangles, draw calls, frame time,
// L0 tiles per view) and exits non-zero if the page logged errors or a budget was exceeded.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/terrain/shots');
const PORT = Number(arg('port', 8101));
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const BUDGET = { terrainTriangles: 1.5e6, drawCalls: 300 };

// Views. y is metres MSL unless agl is given; hdg 0 = north, pitch + = up; t = local solar time.
export const VIEWS = [
  // threshold of runway 36 at Tel Nof (LLEK), 30 m above it, 250 m short, looking along it
  { name: 'telnof_runway_30m', x: -19674.5, z: -2563.2, agl: 30, hdg: 2.82, pitch: -6, t: 10.5 },
  // the Tel Aviv coast from 3 km, looking north-north-east along the beach
  { name: 'tlv_coast_3km', x: -28500, z: -24000, y: 3000, hdg: 25, pitch: -20, t: 10.5 },
  // the Judean hills west of Jerusalem from 1.5 km, looking east
  { name: 'jerusalem_hills_1500m', x: 9000, z: 1660, y: 1500, hdg: 90, pitch: -10, t: 10.5 },
  // the north end of the Dead Sea from 2 km (MSL; 2.4 km above the water), looking south-east
  { name: 'deadsea_2km', x: 36500, z: -1500, y: 2000, hdg: 135, pitch: -14, t: 10.5 },
  // horizon from 10 km: curvature and the far area, looking west over the sea
  { name: 'horizon_10km', x: 0, z: 0, y: 10000, hdg: 265, pitch: -4, t: 10.5 },
  // the same Tel Aviv view at sunset
  { name: 'tlv_coast_sunset', x: -28500, z: -24000, y: 3000, hdg: 25, pitch: -20, t: 19.0 },
  // checks: Tel Nof from above (runway paint vs the imagery), LOD colours, wireframe, the
  // core / far boundary, the aircraft shadow on the runway
  // (the south ends of Tel Nof's three runways: thresholds 36, 33L, 33R and their overruns)
  { name: 'telnof_top_1200m', x: -18700, z: -3100, agl: 1200, hdg: 0, pitch: -89.9, t: 10.5 },
  { name: 'telnof_top_nopaint', x: -18700, z: -3100, agl: 1200, hdg: 0, pitch: -89.9, t: 10.5, paint: false },
  { name: 'lod_colours_3km', x: -20000, z: 6000, y: 3000, hdg: 0, pitch: -15, t: 10.5, lod: true },
  { name: 'wireframe_600m', x: -20150, z: 7175, y: 600, hdg: 2.8, pitch: -8, t: 10.5, wire: true },
  { name: 'core_edge_2km', x: -8000, z: -45500, y: 2000, hdg: 350, pitch: -12, t: 10.5 },
  { name: 'jet_shadow', x: -19640, z: -2850, agl: 9, hdg: 330, pitch: -18, t: 15.5, jet: { x: -19661, z: -2880, hdg: 2.82 } },
  // water and sky checks: sun glint on the sea, dawn over the rift, dusk, night, 15 km
  { name: 'sea_glint_afternoon', x: -38000, z: -10000, y: 300, hdg: 285, pitch: -4, t: 16.5 },
  { name: 'dawn_east_1500m', x: 15000, z: 0, y: 1500, hdg: 65, pitch: -2, t: 5.6 },
  { name: 'tlv_dusk', x: -28500, z: -24000, y: 3000, hdg: 25, pitch: -20, t: 19.5 },
  { name: 'tlv_night', x: -28500, z: -24000, y: 3000, hdg: 25, pitch: -20, t: 21.0 },
  { name: 'high_15km', x: 0, z: 0, y: 15000, hdg: 200, pitch: -25, t: 12.0 },
  // the test page itself with its panel (spawns, sliders, stats)
  { name: 'dev_page_panel', x: -23130.7, z: -31074.3, y: 3000, hdg: 180, pitch: -12, t: 10.5, hud: true },
];

/**
 * Runs in the page: renders the terrain's surface height (debug.heightProbe) under the camera
 * at many points into a float target and compares it with heightAt() there; checks surfaceAt()
 * on runways, beside them, on the sea, the Dead Sea and on land (real data only).
 */
async function surfaceChecks() {
  const d = window.__dev, T = d.THREE, terrain = d.terrain;
  const rt = new T.WebGLRenderTarget(16, 16, { type: T.FloatType, depthBuffer: true });
  const buf = new Float32Array(4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const pts = [];
  for (let i = 0; i < 24; i++) pts.push([(rnd() * 2 - 1) * 50000, (rnd() * 2 - 1) * 50000]);
  for (const r of terrain.runways.list.slice(0, 6)) pts.push([r.cx + r.ux * 300 + 7.3, r.cz + r.uz * 300 - 3.1]);
  pts.push([51200 + 12.5, 3000], [-60000, 20000], [120000, -90000]);
  const heights = [];
  let maxCoreErr = 0, maxFarErr = 0;
  const failures = [];
  terrain.debug.heightProbe = true;
  for (const [x, z] of pts) {
    d.setView({ x, z, agl: 40, hdg: 0, pitch: -90 });
    d.step(1 / 60, performance.now(), false);
    d.renderer.setRenderTarget(rt);
    d.renderer.render(d.scene, d.camera);
    d.renderer.setRenderTarget(null);
    d.renderer.readRenderTargetPixels(rt, 8, 8, 1, 1, buf);
    const [gpu, gx, gz] = buf;
    const cpu = terrain.heightAt(gx, gz);
    const err = Math.abs(gpu - cpu);
    const core = Math.max(Math.abs(gx), Math.abs(gz)) < 51200;
    if (core) maxCoreErr = Math.max(maxCoreErr, err); else maxFarErr = Math.max(maxFarErr, err);
    heights.push({ x: Math.round(gx * 100) / 100, z: Math.round(gz * 100) / 100, gpu: Math.round(gpu * 1000) / 1000, cpu: Math.round(cpu * 1000) / 1000 });
    if (err > (core ? 0.02 : 0.5) || !Number.isFinite(gpu)) failures.push(`height at ${gx.toFixed(1)}, ${gz.toFixed(1)}: GPU ${gpu} vs heightAt ${cpu}`);
  }
  terrain.debug.heightProbe = false;
  rt.dispose();

  const surface = [];
  const expect = (label, x, z, type) => {
    const s = terrain.surfaceAt(x, z);
    surface.push({ label, x: Math.round(x), z: Math.round(z), type: s.type, friction: s.friction, expected: type });
    if (type && s.type !== type) failures.push(`surfaceAt ${label}: ${s.type}, expected ${type}`);
  };
  // physics queries without the L0 tile land cover (only the overview grids), as at load
  for (const r of terrain.runways.list) {
    expect(`${r.icao} ${r.ids.join('/')} centre`, r.cx, r.cz, 'runway');
    expect(`${r.icao} ${r.ids.join('/')} 150 m beside`, r.cx - r.uz * (r.halfWidth + 150), r.cz + r.ux * (r.halfWidth + 150), null);
  }
  if (!terrain.manifest.synthetic) {
    expect('Mediterranean off Ashdod', -40000, -20000, 'water');
    expect('Dead Sea, north basin', 45000, 10000, 'water');
    expect('Jerusalem', 19900, 2400, 'ground');
    expect('Judean desert', 30000, 5000, 'ground');
    const sea = terrain.heightAt(-40000, -20000), ds = terrain.heightAt(45000, 10000);
    surface.push({ label: 'heights', sea, deadSea: ds });
    if (Math.abs(sea) > 0.05) failures.push(`sea height ${sea}`);
    if (ds > -400 || ds < -440) failures.push(`Dead Sea height ${ds}`);
  }
  for (const [name, sp] of Object.entries(terrain.spawns)) {
    if (sp.on_ground) expect(`spawn ${name}`, sp.x, sp.z, 'runway');
  }
  return { heights, maxCoreErr, maxFarErr, surface, failures };
}

async function startServer() {
  const p = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', SIM],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  const base = `http://127.0.0.1:${PORT}/`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + 'dev/terrain.html'); if (r.ok) return { p, base }; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  p.kill();
  throw new Error('server did not start');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server = null;
  let base = arg('base', '');
  if (!base) { server = await startServer(); base = server.base; }
  if (!base.endsWith('/')) base += '/';
  const data = arg('data', '');
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const results = [];
  let checks = null;
  let failed = false;
  try {
    const q = new URLSearchParams({ hud: '0', dpr: '1', x: '0', z: '0', y: '3000' });
    if (data) q.set('data', data);
    // extra page parameters, e.g. --query depth=log
    for (const [k, v] of new URLSearchParams(arg('query', ''))) q.set(k, v);
    const t0 = Date.now();
    await page.goto(`${base}dev/terrain.html?${q}`);
    await page.waitForFunction(() => window.__dev && window.__dev.terrain.loaded, null, { timeout: 240000, polling: 250 });
    const loadMs = Date.now() - t0;
    console.log(`page loaded in ${loadMs} ms`);
    await page.evaluate(() => { window.__dev.paused = true; });

    if (!process.argv.includes('--no-checks')) {
      const c = await page.evaluate(surfaceChecks);
      checks = c;
      for (const k of c.failures) errors.push(`check: ${k}`);
      console.log(`surface checks: ${c.heights.length} GPU height probes, max |GPU - heightAt| `
        + `${c.maxCoreErr.toFixed(4)} m in the core, ${c.maxFarErr.toFixed(3)} m outside; `
        + `${c.surface.length} surfaceAt checks; ${c.failures.length ? 'FAIL' : 'ok'}`);
    }

    for (const v of VIEWS) {
      if (ONLY && !ONLY.includes(v.name)) continue;
      const t1 = Date.now();
      const r = await page.evaluate(async (v) => {
        const d = window.__dev, sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        document.body.classList.toggle('hud-off', !v.hud);
        document.getElementById('lod').checked = !!v.lod;
        document.getElementById('wire').checked = !!v.wire;
        d.terrain.debug.runways = v.paint !== false;
        d.env.setTime(v.t ?? 10.5, v.day ?? 172);
        d.setView(v);
        await d.placeJet(!!v.jet, v.jet || {});
        // stream L0 tiles without rendering
        let calm = 0;
        const tEnd = performance.now() + 90000;
        while (performance.now() < tEnd && calm < 4) {
          d.step(1 / 60, performance.now(), false);
          calm = d.settled() ? calm + 1 : 0;
          await sleep(40);
        }
        for (let i = 0; i < 25; i++) { d.step(1 / 60, performance.now(), false); await sleep(40); } // fade-in, env map
        d.env.snapExposure();
        d.step(1 / 60);
        const ms = d.timeFrame(1 / 60);
        const ri = d.renderer.info.render, st = d.terrain.stats, p = d.camera.position;
        return {
          frameMs: Math.round(ms), drawCalls: ri.calls, triangles: ri.triangles,
          terrainTriangles: st.triangles, patches: st.patches, groups: st.groups,
          l0Resident: st.tilesResident, l0Wanted: st.tilesWanted,
          camera: [p.x, p.y, p.z].map((a) => Math.round(a * 10) / 10),
          ground: Math.round(d.terrain.heightAt(p.x, p.z) * 100) / 100,
          surface: d.terrain.surfaceAt(p.x, p.z).type,
          sunElevationDeg: Math.round(d.env.sunElevationDeg * 10) / 10,
          exposure: Math.round(d.renderer.toneMappingExposure * 1000) / 1000,
        };
      }, v);
      const file = path.join(OUT, `${v.name}.png`);
      await page.screenshot({ path: file, timeout: 120000 });
      // budget: terrain triangles, and draw calls of the scene without the (test) aircraft
      const over = r.terrainTriangles > BUDGET.terrainTriangles || (!v.jet && r.drawCalls > BUDGET.drawCalls);
      if (over) failed = true;
      results.push({ view: v.name, file, ...r, wallMs: Date.now() - t1, overBudget: over });
      console.log(`${v.name}: ${(r.terrainTriangles / 1e6).toFixed(2)} M terrain tris, ${r.drawCalls} calls, `
        + `frame ${r.frameMs} ms, L0 ${r.l0Resident}/${r.l0Wanted}${over ? '  OVER BUDGET' : ''} -> ${file}`);
    }
  } catch (e) {
    failed = true;
    errors.push(`test: ${e.message}`);
    await page.screenshot({ path: path.join(OUT, 'error.png') }).catch(() => {});
  } finally {
    await browser.close();
    if (server) server.p.kill();
  }
  writeFileSync(path.join(OUT, 'terrain_screens.json'), JSON.stringify({ budget: BUDGET, results, checks, errors }, null, 1));
  if (errors.length) { failed = true; console.log('page errors:\n  ' + errors.slice(0, 20).join('\n  ')); }
  console.log(failed ? 'FAIL' : 'PASS');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
