// Screenshots of the jet's exterior (js/aircraft/materials.js, skin.js): the views the exterior track
// is judged in (the PC flight film's chase on the Tel Nof runway at 16:48, the take-off seen from the
// side, the menu's orbit at 26 m over Tel Aviv at 12:30, the Jerusalem sunset, the Dead Sea at 09:00),
// close-ups (nozzle, canopy, gear, inlet, the gun port), the wings and tails from the cockpit, and the
// low sun's glints. Playwright + headless Chromium (SwiftShader), driven through window.__sim.
//
//   node sim/tests/exterior_shots.mjs [--port 8700] [--out DIR] [--only name,name] [--shots a,b]
//                                     [--size 960x540] [--quality high] [--url "&exterior=0"]
//                                     [--variants '[{"tag":"a","js":"..."}]'] [--list]
//
// --url adds URL parameters (e.g. "&exterior=0" draws the skin as exported, for a before / after on
// the same code); --variants draws every shot once per variant (its js runs before the frame).
// Fails on console errors, page errors and failed requests. Screenshots and report.json in --out
// (default /home/claude/simdata/shots/exterior/run).

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
const PORT = +arg('port', 8700);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/exterior/run'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const URLX = arg('url', '');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const SHOTS = arg('shots', '') ? arg('shots', '').split(',') : null;
const VARIANTS = arg('variants-file', '') ? JSON.parse(readFileSync(arg('variants-file', ''), 'utf8'))
  : arg('variants', '') ? JSON.parse(arg('variants', '')) : [{ tag: arg('tag', ''), js: '' }];
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[exterior ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// Page-side helpers (window.__ex): cameras placed relative to the jet's heading or to the sun.
const PAGE_HELPERS = `
window.__ex = {
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
  /** Orbit camera by the sun: rel = degrees from the anti-sun side (0: the sun behind the jet, in the view). */
  orbitSun(rel, pitch, dist, fov = 40) {
    const app = window.__sim.app, s = app.env.sunDirection;
    app.cams.setMode('orbit');
    app.settings.camera = 'orbit';
    const O = app.cams.orbit;
    O.yaw = Math.atan2(-s.x, -s.z) + rel * this.DEG;
    O.pitch = pitch * this.DEG;
    O.dist = dist;
    O.init = true;
    O.auto = 0;
    app.cams.fov.orbit = fov;
    return true;
  },
  /** Cockpit view turned by the head: yaw + = left, pitch + = up (deg), fov deg. */
  look(yaw, pitch, fov = 60) {
    const app = window.__sim.app;
    app.cams.setMode('cockpit');
    app.settings.camera = 'cockpit';
    app.cams.head.yaw = yaw * this.DEG;
    app.cams.head.pitch = pitch * this.DEG;
    app.cams.fov.cockpit = fov;
    return true;
  },
  /** The menu's backdrop: orbit 26 m, 9 deg up, 50 deg lens, at an angle from behind. */
  menu(rel) { return this.orbit(rel, 9, 26, 50); },
  spawn(name, base, over) {
    const sp = window.__sim.app.terrain.spawns;
    sp[name] = { ...(sp[base] || {}), ...over };
    return name;
  },
};
true;
`;

/** Take-off roll in full burner from Tel Nof 36 at `time` until the burner is lit and `kt`. */
const AB_ROLL = (time, kt = 70) => `async () => {
  const S = window.__sim; S.start('telnof_36', { time: ${time}, camera: 'chase' }); S.autopilot('takeoff');
  for (let i = 0; i < 600; i++) { S.step(12); const s = S.summary(); if (s.ab > 0.95 && s.ias_kt > ${kt}) break; } }`;

// Each scene: setup (page function source) then shots [{name, cam}]: cam is 'chase' | 'cockpit' | 'flyby'
// | 'tower' | [rel, pitch, dist, fov] (orbit) | {sun: [rel, pitch, dist, fov]} | {look: [yaw, pitch, fov]}
// | {menu: rel}.
const SCENES = [
  {
    // PC film 0060 / 0240: the chase on the runway at 16:48 in burner
    name: 'rwy1648',
    setup: AB_ROLL(16.8, 60),
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'rear34', cam: [28, 6, 18, 40] }, { name: 'nozzle', cam: [6, 3, 8.5, 35] }],
  },
  {
    // PC film 0420: lifting off, seen from ahead and to the side, low (the fly-by's place)
    name: 'rot1648',
    setup: `async () => { const S = window.__sim; S.start('telnof_36', { time: 16.8, camera: 'chase' }); S.autopilot('takeoff');
      return S.fly({ until: 'liftoff', seconds: 90 }); }`,
    shots: [{ name: 'side', cam: [-112, -1, 34, 40] }, { name: 'below', cam: [-150, -8, 30, 40] }],
  },
  {
    // PC film 0740-1000: the menu's orbit (26 m, 9 deg) over Tel Aviv at 12:30
    name: 'menu1230',
    setup: `async () => { window.__sim.start('tlv_3000', { time: 12.5, camera: 'chase' }); window.__sim.step(120); }`,
    shots: [{ name: 'rear', cam: { menu: 25 } }, { name: 'side', cam: { menu: 100 } }, { name: 'front', cam: { menu: 200 } },
      { name: 'left', cam: { menu: 285 } }, { name: 'chase', cam: 'chase' }],
  },
  {
    // PC film 1120: the Jerusalem sunset
    name: 'sunset',
    setup: `async () => { window.__sim.start('jerusalem_sunset', { camera: 'chase' }); window.__sim.step(120); }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'side', cam: [95, 6, 26, 40] }, { name: 'front34', cam: [-140, 8, 24, 40] },
      { name: 'glint', cam: { sun: [12, 14, 24, 40] } }],
  },
  {
    // PC film 1450 / 1600: over the Dead Sea at 09:00
    name: 'deadsea0900',
    setup: `async () => { window.__sim.start('deadsea_low', { time: 9.0, camera: 'chase' }); window.__sim.step(120); }`,
    shots: [{ name: 'chase', cam: 'chase' }, { name: 'above', cam: [150, 30, 24, 40] }],
  },
  {
    // close-ups on the ramp at noon (the flyby / tower distances and nearer)
    name: 'park1230',
    setup: `async () => { window.__sim.start('telnof_36', { time: 12.5, camera: 'chase' }); window.__sim.step(60); }`,
    shots: [{ name: 'canopy', cam: [-150, 22, 10, 40] }, { name: 'gear', cam: [-95, -3, 9, 40] },
      { name: 'inlet', cam: [-165, 3, 8, 40] }, { name: 'nozzle', cam: [8, 4, 8, 35] }, { name: 'top', cam: [20, 62, 22, 40] },
      { name: 'front34', cam: [-140, 4, 21, 40] }, { name: 'tower', cam: 'tower' }],
  },
  {
    // the wings and tails from the pilot's seat
    name: 'cockpit1230',
    setup: `async () => { window.__sim.start('tlv_3000', { time: 12.5, camera: 'cockpit' }); window.__sim.step(120); }`,
    shots: [{ name: 'ahead', cam: { look: [0, 0, 60] } }, { name: 'leftwing', cam: { look: [80, -18, 60] } },
      { name: 'tails', cam: { look: [-140, 5, 60] } }],
  },
  {
    // low sun: the coating's sheen and glints, looking towards the sun and away from it
    name: 'glint1845',
    setup: `async () => { window.__sim.start('tlv_3000', { time: 18.75, camera: 'chase' }); window.__sim.step(120); }`,
    shots: [{ name: 'tosun', cam: { sun: [20, 18, 24, 40] } }, { name: 'sunlit', cam: { sun: [165, 12, 24, 40] } }],
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

const selected = (scene) => !ONLY || ONLY.some((o) => scene.name === o || scene.name.startsWith(o));

async function setCamera(page, cam) {
  if (Array.isArray(cam)) return page.evaluate((c) => window.__ex.orbit(...c), cam);
  if (cam && cam.sun) return page.evaluate((c) => window.__ex.orbitSun(...c), cam.sun);
  if (cam && cam.look) return page.evaluate((c) => window.__ex.look(...c), cam.look);
  if (cam && cam.menu != null) return page.evaluate((c) => window.__ex.menu(c), cam.menu);
  return page.evaluate((c) => window.__sim.camera(c), cam);
}

async function main() {
  if (argv.includes('--list')) { for (const s of SCENES) console.log(s.name, s.shots.map((x) => x.name).join(' ')); return; }
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const problems = [];
  const report = { quality: QUALITY, size: [W, H], url: URLX, shots: [] };
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      if (m.type() === 'warning' && !/ReadPixels|GPU stall/.test(m.text())) log('warn:', m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
    page.setDefaultTimeout(900000);
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${URLX}`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 900000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    await page.evaluate(PAGE_HELPERS);
    await page.addStyleTag({ content: '#toast, #hmd { display: none !important; }' });
    log('loaded');
    for (const sc of SCENES) {
      if (!selected(sc)) continue;
      const res = await page.evaluate(`(${sc.setup})()`);
      const sum = await page.evaluate(() => window.__sim.summary());
      log(`${sc.name}: ${sum.ias_kt} kt, alt ${sum.alt_m} m, ab ${sum.ab}, gear ${sum.gear}, t ${sum.time} h`
        + (res && res.pilot ? `, pilot ${res.pilot.phase}` : ''));
      for (const sh of sc.shots) {
        if (SHOTS && !SHOTS.includes(sh.name)) continue;
        await setCamera(page, sh.cam);
        await page.evaluate(() => window.__sim.settle(1500));
        for (const v of VARIANTS) {
          if (v.js) await page.evaluate(v.js);
          const ri = await page.evaluate(() => window.__sim.render());
          const name = `${sc.name}_${sh.name}${v.tag ? '_' + v.tag : ''}.png`;
          const file = join(OUT, name);
          await page.screenshot({ path: file });
          const mem = await page.evaluate(() => window.__sim.gpuMemory());
          const ext = await page.evaluate(() => (window.__sim.app.exterior ? window.__sim.app.exterior.stats() : null));
          report.shots.push({ file, scene: sc.name, shot: sh.name, variant: v.tag, calls: ri.calls, triangles: ri.triangles,
            ms: ri.ms, programs: ri.programs, textures: ri.textures, gpuMB: mem.totalMB, summary: sum, exterior: ext });
          log(`  ${name}  ${ri.calls} calls, ${(ri.triangles / 1e6).toFixed(2)} M tris, ${ri.programs} programs, ${ri.ms} ms, GPU ~${mem.totalMB} MB`);
          if (ext) log(`    exterior: on ${ext.on}, map ${ext.size} (${(ext.texel * 1000).toFixed(1)} mm), redraws ${ext.redraws}, ao ${ext.aoRedraws}, ${ext.calls} calls, ground ${ext.ground}, no-cast ${ext.noCast}, tones ${JSON.stringify(ext.tones)}`);
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
