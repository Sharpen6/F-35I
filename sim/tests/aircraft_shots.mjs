// Playwright screenshots of the aircraft test page (sim/dev/aircraft.html), for review against the
// Blender stills. Fails on any console error or page error.
//
//   node sim/tests/aircraft_shots.mjs [outdir] [--only name,name] [--port 8102] [--size 960x540]
//
// Starts `python3 -m http.server <port> --bind 127.0.0.1` in sim/ unless something already answers
// there. Uses the preinstalled Playwright Chromium with SwiftShader (no GPU needed).

import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch { /* global install */ }
  const root = execSync('npm root -g').toString().trim();
  return require(path.join(root, 'playwright'));
}

const SIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { out: '/tmp/aircraft/shots', only: null, port: 8102, size: [960, 540] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only') opt.only = args[++i].split(',');
  else if (args[i] === '--port') opt.port = +args[++i];
  else if (args[i] === '--size') opt.size = args[++i].split('x').map(Number);
  else opt.out = args[i];
}

// name -> state for window.dev.apply (see sim/dev/aircraft.js)
const SHOTS = {
  front34: { view: 'front34' },
  side: { view: 'side' },
  rear34: { view: 'rear34' },
  top: { view: 'top' },
  cockpit: { view: 'cockpit' },
  gear_up: { air: true, view: 'side', controls: { gear: 0 } },
  gear_half: { air: true, view: 'side', controls: { gear: 0.5 } },
  gear_down: { air: true, view: 'side', controls: { gear: 1 } },
  gear_closeup: { view: 'gear' },
  canopy_open: { view: 'canopy', controls: { canopy: 1 } },
  deflections: {
    view: 'rear34',
    controls: { stick_pitch: 1, stick_roll: 1, pedals: 1, flaps: 1, weapon_bays: 1, refuel_door: 1, gun_door: 1,
      tailhook: 1, nws: 1 },
  },
  deflections_top: { view: 'top', controls: { stick_pitch: -1, stick_roll: -1, flaps: 1, speedbrake: 1, refuel_door: 1 } },
  ab_night: {
    night: true, view: 'nozzle', ab: 1, controls: { throttle: 1 },
    lights: { nav: true, anticoll: true, formation: 1 },
  },
  ab_night_side: {
    night: true, view: 'side', ab: 1, controls: { throttle: 1 },
    lights: { nav: true, anticoll: true, formation: 1 },
  },
  nose_closeup: { view: 'nose' },
  nozzle_mil: { view: 'nozzle', controls: { throttle: 0.75 }, ab: 0 },
  ab_day: { view: 'nozzle', ab: 1, controls: { throttle: 1 } },
  lights_night: {
    night: true, view: 'front34', controls: { throttle: 0.2 },
    lights: { nav: true, anticoll: true, formation: 1, landing: true },
  },
};

async function serverUp(url) {
  try { const r = await fetch(url, { method: 'HEAD' }); return r.ok || r.status === 404; } catch { return false; }
}

async function main() {
  mkdirSync(opt.out, { recursive: true });
  const base = `http://127.0.0.1:${opt.port}/`;
  let server = null;
  if (!(await serverUp(base))) {
    server = spawn('python3', ['-m', 'http.server', String(opt.port), '--bind', '127.0.0.1'],
      { cwd: SIM, stdio: 'ignore' });
    for (let i = 0; i < 50 && !(await serverUp(base)); i++) await new Promise((r) => setTimeout(r, 100));
  }
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const errors = [];
  const files = [];
  try {
    const page = await browser.newPage({ viewport: { width: opt.size[0], height: opt.size[1] } });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const t0 = Date.now();
    await page.goto(base + 'dev/aircraft.html?ui=0&t=0', { waitUntil: 'load' });
    await page.evaluate(() => window.dev.ready);
    console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    for (const [name, spec] of Object.entries(SHOTS)) {
      if (opt.only && !opt.only.includes(name)) continue;
      const t1 = Date.now();
      await page.evaluate((s) => { window.dev.reset(); window.dev.apply(s); }, spec);
      await page.evaluate(() => window.dev.frames(1));
      const file = path.join(opt.out, `aircraft_${name}.png`);
      await page.screenshot({ path: file, timeout: 120000 });
      files.push(file);
      console.log(`${name}: ${file} (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
    }
    const stats = await page.evaluate(() => {
      const i = window.dev.renderer.info;
      return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries,
        textures: i.memory.textures, programs: i.programs.length };
    });
    console.log('renderer:', JSON.stringify(stats));
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  if (errors.length) {
    console.error(`${errors.length} console error(s):`);
    for (const e of errors.slice(0, 20)) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`ok: ${files.length} screenshots in ${opt.out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
