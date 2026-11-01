// Screenshots of the F-35I in the whole app (real data, Environment, terrain), for judging the
// aircraft's look: paint at noon / 07:00 / sunset / night, lights, afterburner, vapour, tyre smoke,
// the gear doors. Playwright + headless Chromium (SwiftShader), driven through window.__sim.
//
//   node sim/tests/aircraft_scenes.mjs [--port 8150] [--out DIR] [--only name,name] [--size 960x540]
//                                      [--quality high] [--list] [--pre "js"] [--root SIM_FOLDER]
//
//   --only      scene names or prefixes (e.g. --only park_noon,ab_) ; --list prints the scenes
//   --shots     only these shot names (e.g. --shots side,chase)
//   --pre       JavaScript run in the page before every scene (e.g. to try a material setting:
//               --pre "window.__sim.app.env.exposureBias = 0.5")
//   --post      JavaScript run after each scene's setup (before its shots)
//   --tag       suffix for the file names (compare variants side by side)
//   --variants / --variants-file   draw every shot once per variant (see VARIANTS below)
// Fails on console errors and page errors. Screenshots + report.json in --out
// (default /home/claude/simdata/shots/aircraft/scenes).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const PORT = +arg('port', 8150);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/aircraft/scenes'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const PRE = arg('pre', '');
const POST = arg('post', '');
const SHOTS = arg('shots', '') ? arg('shots', '').split(',') : null;
const TAG = arg('tag', '');
// --variants '[{"tag": "a", "js": "..."}, ...]' (or --variants-file FILE with that JSON): every shot is
// drawn once per variant (the js runs before the frame), so material or lighting settings can be
// compared on identical frames. Each variant's js should set absolute values (they run in turn).
const VARIANTS = arg('variants-file', '') ? JSON.parse(readFileSync(arg('variants-file', ''), 'utf8'))
  : arg('variants', '') ? JSON.parse(arg('variants', '')) : [{ tag: TAG, js: '' }];
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[scenes ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// Page-side helpers (window.__ac): an orbit camera placed relative to the jet's heading, custom
// start points, a simple g / bank holder for the turn scenes.
const PAGE_HELPERS = `
window.__ac = {
  DEG: Math.PI / 180,
  rot(q, v) {
    const { x, y, z, w } = q; const [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  },
  /** Orbit camera: rel = degrees from behind the jet (90 = its right side, 180 = ahead), pitch deg, dist m. */
  orbit(rel, pitch, dist, fov = 40) {
    const app = window.__sim.app;
    app.cams.setMode('orbit');
    app.settings.camera = 'orbit';
    const aft = this.rot(app.fdm.state.quaternion, [0, 0, 1]);
    const O = app.cams.orbit;
    O.yaw = Math.atan2(aft[0], aft[2]) + rel * this.DEG;
    O.pitch = pitch * this.DEG;
    O.dist = dist;
    O.init = true;
    O.auto = 0;
    app.cams.fov.orbit = fov;
    return true;
  },
  spawn(name, base, over) {
    const sp = window.__sim.app.terrain.spawns;
    sp[name] = { ...(sp[base] || {}), ...over };
    return name;
  },
  /** Hold a bank angle and a load factor with the stick (simple PI-ish loops), every 12 steps. */
  hold(bankDeg, g, seconds, throttle = 1) {
    const S = window.__sim;
    let pitch = 0.3, t = 0;
    while (t < seconds) {
      const s = S.summary();
      const roll = Math.max(-1, Math.min(1, (bankDeg - s.roll_deg) * 0.04));
      if (Math.abs(s.roll_deg - bankDeg) < 25) pitch = Math.max(-1, Math.min(1, pitch + (g - s.g) * 0.03));
      else pitch = 0.1;
      S.setInput({ roll, pitch, throttle });
      S.step(12);
      t += 0.1;
      if (S.summary().crashed) break;
    }
    return S.summary();
  },
};
true;
`;

// ---------------------------------------------------------------------------------------- scenes
// Each scene: setup (page function source, may be async) then shots [{name, cam}] where cam is
// 'chase' | 'cockpit' | 'flyby' | 'tower' | [rel, pitch, dist, fov] (orbit).
const PARK = (time, tag) => ({
  name: `park_${tag}`,
  setup: `async () => { window.__sim.start('telnof_36', { time: ${time}, camera: 'chase' }); window.__sim.step(60); }`,
  shots: [
    { name: 'front34', cam: [-140, 4, 21, 40] },
    { name: 'rear34', cam: [35, 10, 22, 40] },
    { name: 'side', cam: [92, 2, 24, 40] },
    { name: 'chase', cam: 'chase' },
  ],
});

const SCENES = [
  PARK(12.5, 'noon'),
  PARK(7.0, '0700'),
  PARK(18.9, 'sunset'),
  PARK(21.5, 'night'),
  {
    name: 'detail_noon',
    setup: `async () => { window.__sim.start('telnof_36', { time: 12.5, camera: 'chase' }); window.__sim.step(60); }`,
    shots: [
      { name: 'nozzle', cam: [12, 4, 9, 35] },
      { name: 'gear_left', cam: [-118, -2, 8.5, 40] },
      { name: 'top', cam: [20, 62, 22, 40] },
    ],
  },
  {
    name: 'air_noon',
    setup: `async () => { window.__sim.start('tlv_3000', { time: 12.5, camera: 'chase' }); window.__sim.step(120); }`,
    shots: [
      { name: 'chase', cam: 'chase' },
      { name: 'below34', cam: [-130, -25, 24, 40] },
      { name: 'side', cam: [95, 6, 26, 40] },
      { name: 'above', cam: [150, 35, 26, 40] },
    ],
  },
  {
    name: 'air_sunset',
    setup: `async () => { window.__sim.start('jerusalem_sunset', { camera: 'chase' }); window.__sim.step(120); }`,
    shots: [
      { name: 'chase', cam: 'chase' },
      { name: 'side', cam: [95, 6, 26, 40] },
      { name: 'front34', cam: [-140, 8, 24, 40] },
    ],
  },
  {
    name: 'ab_roll_noon',
    setup: `async () => {
      const S = window.__sim; S.start('telnof_36', { time: 12.5, camera: 'chase' }); S.autopilot('takeoff');
      for (let i = 0; i < 400; i++) { S.step(12); const s = S.summary(); if (s.ab > 0.95 && s.ias_kt > 70) break; } }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'side', cam: [100, 3, 20, 40] }, { name: 'rear34', cam: [28, 6, 18, 40] }],
  },
  {
    name: 'ab_roll_dusk',
    setup: `async () => {
      const S = window.__sim; S.start('bengurion_26', { time: 19.05, camera: 'chase' }); S.autopilot('takeoff');
      for (let i = 0; i < 400; i++) { S.step(12); const s = S.summary(); if (s.ab > 0.95 && s.ias_kt > 70) break; } }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'side', cam: [100, 3, 20, 40] }],
  },
  {
    name: 'ab_roll_night',
    setup: `async () => {
      const S = window.__sim; S.start('telnof_36', { time: 21.5, camera: 'chase' }); S.autopilot('takeoff');
      for (let i = 0; i < 400; i++) { S.step(12); const s = S.summary(); if (s.ab > 0.95 && s.ias_kt > 70) break; } }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'side', cam: [100, 3, 20, 40] }, { name: 'rear34', cam: [28, 6, 18, 40] }],
  },
  {
    name: 'ab_air_noon',
    setup: `async () => { const S = window.__sim; S.start('tlv_3000', { time: 12.5, camera: 'chase' });
      S.setInput({ throttle: 1 }); S.step(360); }`,
    shots: [{ name: 'side', cam: [95, 4, 24, 40] }, { name: 'front34_below', cam: [-150, -12, 26, 40] }, { name: 'chase', cam: 'chase' }],
  },
  {
    name: 'turn7g_noon',
    setup: `async () => { const ac = window.__ac, S = window.__sim;
      ac.spawn('ac_turn', 'coast_low', { y: 300, speed_ms: 240, heading_deg: 20 });
      S.start('ac_turn', { time: 12.5, camera: 'chase' }); ac.hold(78, 7, 6, 1); }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'above', cam: [160, 30, 28, 40] }, { name: 'rear34', cam: [30, 12, 24, 40] }],
  },
  {
    name: 'm098_sea',
    setup: `async () => { const ac = window.__ac, S = window.__sim;
      ac.spawn('ac_m098', 'coast_low', { x: -47000, y: 100, speed_ms: 334, heading_deg: 20 });
      S.start('ac_m098', { time: 12.5, camera: 'chase' }); S.setInput({ throttle: 1, pitch: 0.0 }); S.step(240); }`,
    shots: [{ name: 'side', cam: [95, 3, 30, 40] }, { name: 'chase', cam: 'chase' }, { name: 'front34', cam: [-145, 6, 30, 40] }],
  },
  {
    name: 'contrail_10km',
    setup: `async () => { const ac = window.__ac, S = window.__sim;
      ac.spawn('ac_hi', 'tlv_3000', { y: 10000, speed_ms: 250, heading_deg: 180 });
      S.start('ac_hi', { time: 12.5, camera: 'chase' }); S.setInput({ throttle: 0.8 }); S.step(1200); }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'side_far', cam: [110, 10, 140, 40] }],
  },
  {
    name: 'land_bgn_dusk',
    setup: `async () => { const ac = window.__ac, S = window.__sim;
      // 4 km final to Ben Gurion 26 (threshold -11936, -24251; heading 259.8)
      const h = 259.8 * Math.PI / 180, d = 4000;
      ac.spawn('ac_bgn_final', 'telnof_final', { x: -11936 + Math.sin(h) * -d, z: -24251 - Math.cos(h) * -d,
        y: 39.3 + d * Math.tan(3 * Math.PI / 180) + 15, heading_deg: 259.8, airport: 'LLBG', runway: '26' });
      S.start('ac_bgn_final', { time: 19.15, camera: 'chase' });
      S.autopilot('land', { runway: '26', icao: 'LLBG' });
      const r = S.fly({ until: 'touchdown', seconds: 120 }); S.step(30); return r; }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'side', cam: [100, 3, 26, 40] }, { name: 'tower', cam: 'tower' }],
  },
  {
    name: 'gear_up',
    setup: `async () => { window.__sim.start('tlv_3000', { time: 12.5, camera: 'chase' }); window.__sim.step(120); }`,
    shots: [{ name: 'below', cam: [-90, -70, 18, 40] }, { name: 'below_rear', cam: [20, -35, 18, 40] }],
  },
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

function selected(scene) {
  if (!ONLY) return true;
  return ONLY.some((o) => scene.name === o || scene.name.startsWith(o));
}

async function main() {
  if (argv.includes('--list')) { for (const s of SCENES) console.log(s.name, s.shots.map((x) => x.name).join(' ')); return; }
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const problems = [];
  const report = { quality: QUALITY, size: [W, H], shots: [] };
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      if (m.type() === 'warning' && !/ReadPixels|GPU stall/.test(m.text())) log('warn:', m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
    page.setDefaultTimeout(600000);
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 600000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    await page.evaluate(PAGE_HELPERS);
    await page.addStyleTag({ content: '#toast { display: none !important; }' });
    log('loaded');
    for (const sc of SCENES) {
      if (!selected(sc)) continue;
      if (PRE) await page.evaluate(PRE);
      const setupResult = await page.evaluate(`(${sc.setup})()`);
      const sum = await page.evaluate(() => window.__sim.summary());
      log(`${sc.name}: ${sum.ias_kt} kt, alt ${sum.alt_m} m, g ${sum.g}, ab ${sum.ab}, gear ${sum.gear}, t ${sum.time} h`
        + (setupResult && setupResult.pilot ? `, pilot ${setupResult.pilot.phase}` : ''));
      if (POST) await page.evaluate(POST);
      for (const sh of sc.shots) {
        if (SHOTS && !SHOTS.includes(sh.name)) continue;
        if (Array.isArray(sh.cam)) await page.evaluate((c) => window.__ac.orbit(...c), sh.cam);
        else await page.evaluate((c) => window.__sim.camera(c), sh.cam);
        await page.evaluate(() => window.__sim.settle(1800));
        for (const v of VARIANTS) {
          if (v.js) await page.evaluate(v.js);
          // a second frame: the exposure and the environment map catch up after a time jump
          const ri = await page.evaluate(() => window.__sim.render());
          const name = `${sc.name}_${sh.name}${v.tag ? '_' + v.tag : ''}.png`;
          const file = join(OUT, name);
          await page.screenshot({ path: file });
          const mem = await page.evaluate(() => window.__sim.gpuMemory());
          const exp = await page.evaluate(() => window.__sim.app.renderer.toneMappingExposure);
          report.shots.push({ file, scene: sc.name, shot: sh.name, variant: v.tag, calls: ri.calls, triangles: ri.triangles,
            ms: ri.ms, programs: ri.programs, gpuMB: mem.totalMB, exposure: +exp.toFixed(3), summary: sum });
          log(`  ${name}  ${ri.calls} calls, ${(ri.triangles / 1e6).toFixed(2)} M tris, ${ri.ms} ms, `
            + `GPU ~${mem.totalMB} MB, exposure ${exp.toFixed(2)}`);
        }
      }
    }
  } finally {
    writeFileSync(join(OUT, 'report.json'), JSON.stringify({ ...report, problems }, null, 1));
    await browser.close();
    server.kill();
  }
  if (problems.length) {
    console.log('PROBLEMS:\n  ' + problems.slice(0, 20).join('\n  '));
    process.exitCode = 1;
  }
  log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
