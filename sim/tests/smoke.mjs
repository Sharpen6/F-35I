// Smoke test for the app shell (Playwright + headless Chromium with SwiftShader WebGL2).
//
//   node sim/tests/smoke.mjs [--root <sim folder>] [--port 8103] [--out <dir>] [--mode stubs|real|both]
//
// Starts serve.py on the port, opens index.html?test=1 (with stubs=1 for the stand-in modules,
// and without it when the real data and modules are present), waits for the start menu, flies
// from the first start point with full afterburner (parking brake off, rotation at 150 kt, gear
// up after lift-off) using the ?test=1 hook to step the simulation faster than real time, and
// saves screenshots of the menu and of 2, 10 and 30 s of simulated time, then of the tower view
// and of two more start points (the coast at 3,000 m, Jerusalem at sunset). Fails on any console
// error, page error or failed request, or when the take-off goes wrong.
// Screenshots: /home/claude/simdata/shots/smoke_<mode>_*.png (or --out).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
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
const PORT = +arg('port', 8103);
const OUT = resolve(arg('out', '/home/claude/simdata/shots'));
const MODE = arg('mode', 'both');
const BASE = `http://127.0.0.1:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

function realAvailable() {
  const need = ['data/terrain/manifest.json', 'data/aircraft/f35i_rig.json', 'data/aircraft/f35i.glb',
    'js/env/Environment.js', 'js/terrain/Terrain.js', 'js/aircraft/AircraftVisual.js', 'js/fdm/FlightModel.js'];
  const missing = need.filter((p) => !existsSync(join(ROOT, p)));
  return { ok: missing.length === 0, missing };
}

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
        if (!out.includes(`:${PORT}/`)) throw new Error(`serve.py did not take port ${PORT}:\n${out}`);
        return proc;
      }
    } catch (e) {
      if (String(e.message).includes('did not take')) { proc.kill(); throw e; }
    }
    await sleep(200);
  }
  proc.kill();
  throw new Error(`serve.py did not start:\n${out}`);
}

async function flight(browser, mode) {
  const stubs = mode === 'stubs';
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    else if (m.type() === 'warning') log(`  (${mode}) warning: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });

  const url = `${BASE}index.html?test=1&quality=low&time=7&cam=chase&wingmen=0${stubs ? '&stubs=1' : ''}`;
  log(`(${mode}) open ${url}`);
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 300000 });
  const err = await page.evaluate(() => window.__sim.error);
  if (err) throw new Error(`(${mode}) the app failed to load: ${err}`);
  log(`(${mode}) menu after ${((Date.now() - t0) / 1000).toFixed(1)} s; spawns: ${(await page.evaluate(() => window.__sim.spawns())).join(', ')}`);
  await page.evaluate((ms) => window.__sim.settle(ms), stubs ? 300 : 4000);
  await page.screenshot({ path: join(OUT, `smoke_${mode}_menu.png`) });

  // fly: the Fly button (a real click, so audio may start), then the keys a player would press
  await page.click('#btn-fly');
  await page.waitForFunction(() => window.__sim.state === 'flying');
  await page.keyboard.press('Shift+KeyB');          // parking brake off
  await page.keyboard.press('PageUp');              // full afterburner
  const shots = [2, 10, 30];
  let t = 0, rotated = false, gearUp = false;
  const summaries = [];
  for (const target of shots) {
    while (t < target) {
      // half a second at a time without drawing (SwiftShader takes seconds per frame)
      const s = await page.evaluate(() => window.__sim.advance(0.5, false));
      t += 0.5;
      if (s.crashed) throw new Error(`(${mode}) crashed at ${t} s: ${s.crashReason}`);
      if (!rotated && s.onGround && s.ias_kt > 150) rotated = true;
      if (rotated) {
        // standing in for the pilot: most of the stick for the rotation (on the ground the
        // F-35I's stick sets a pitch attitude, 12 deg at full aft), then an attitude hold
        // at 12 deg in the climb
        const pitch = s.onGround ? 0.8 : Math.max(-0.4, Math.min(0.75, (12 - s.pitch_deg) * 0.05));
        await page.evaluate((p) => window.__sim.setInput({ pitch: p }), pitch);
      }
      if (rotated && !gearUp && !s.onGround && s.agl_m > 25) { await page.keyboard.press('KeyG'); gearUp = true; }
    }
    if (target === 30) await page.evaluate(() => window.__sim.camera('cockpit'));
    const s = await page.evaluate((ms) => window.__sim.settle(ms), stubs ? 200 : 3000);
    summaries.push({ t, ...s });
    log(`(${mode}) t=${t}s ${JSON.stringify(s)}`);
    await page.screenshot({ path: join(OUT, `smoke_${mode}_${String(target).padStart(2, '0')}s.png`) });
  }
  // a look at the other cameras and the pause screen (no screenshots needed: errors would show)
  for (const cam of ['orbit', 'flyby', 'tower']) await page.evaluate((c) => { window.__sim.camera(c); window.__sim.advance(0.25); }, cam);
  await page.screenshot({ path: join(OUT, `smoke_${mode}_tower.png`) });
  // the coast and Jerusalem from altitude (sunset there): other start points, other light
  const tour = stubs ? [['stub_air', 'chase']] : [['tlv_3000', 'chase'], ['jerusalem_sunset', 'cockpit']];
  const spawns = await page.evaluate(() => window.__sim.spawns());
  for (const [name, cam] of tour) {
    if (!spawns.includes(name)) { log(`(${mode}) no start point ${name}, skipped`); continue; }
    await page.evaluate(([n, c]) => window.__sim.start(n, { camera: c }), [name, cam]);
    const s = await page.evaluate(() => window.__sim.advance(3, false));
    if (s.crashed) problems.push(`crashed 3 s after starting at ${name}: ${s.crashReason}`);
    const s2 = await page.evaluate((ms) => window.__sim.settle(ms), stubs ? 200 : 3000);
    log(`(${mode}) ${name} ${JSON.stringify(s2)}`);
    await page.screenshot({ path: join(OUT, `smoke_${mode}_${name}.png`) });
  }
  await page.keyboard.press('KeyP');
  await page.evaluate(() => window.__sim.advance(0.1));
  const paused = await page.evaluate(() => window.__sim.state);
  await page.close();

  const fails = [...problems];
  const end = summaries[summaries.length - 1];
  const at10 = summaries.find((s) => s.t === 10);
  // 2 s: the engine is still spooling up from idle, but the jet must be rolling
  if (!summaries[0] || summaries[0].ias_kt < 1) fails.push(`not rolling at 2 s (${summaries[0] && summaries[0].ias_kt} kt)`);
  if (!at10 || at10.ias_kt < 100) fails.push(`too slow at 10 s (${at10 && at10.ias_kt} kt)`);
  if (!end || end.onGround || end.agl_m < 100) fails.push(`not climbing at 30 s (agl ${end && end.agl_m} m)`);
  if (end && end.gear > 0.5) fails.push('gear still down at 30 s');
  if (paused !== 'paused') fails.push(`P did not pause (state ${paused})`);
  return { mode, fails, summaries };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const modes = [];
  if (MODE === 'stubs' || MODE === 'both') modes.push('stubs');
  if (MODE === 'real' || MODE === 'both') {
    const r = realAvailable();
    if (r.ok) modes.push('real');
    else if (MODE === 'real') throw new Error(`real data / modules missing under ${ROOT}: ${r.missing.join(', ')}`);
    else log(`real run skipped: missing ${r.missing.join(', ')}`);
  }
  log(`root ${ROOT}, port ${PORT}, screenshots in ${OUT}`);
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const results = [];
  try {
    for (const m of modes) {
      try { results.push(await flight(browser, m)); } catch (e) { results.push({ mode: m, fails: [e.message], summaries: [] }); }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  let failed = false;
  for (const r of results) {
    if (r.fails.length) {
      failed = true;
      log(`FAIL (${r.mode}):`);
      for (const f of r.fails) log(`  - ${f}`);
    } else {
      log(`PASS (${r.mode})`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[smoke]', e); process.exit(1); });
