// node sim/dev/terrain.waterpop.mjs [--port 8146] [--out DIR] [--root sim]
// The sea's wave layers must not jump when the camera crosses one of the lines where the
// periodic texture coordinates wrap (uCamMod: every 256 m; uCamMod1280: every 1280 m, the
// layer turned by the 3-4-5 rotation). Renders the sea from two camera positions 2 cm apart
// across such a line and from a control pair 2 cm apart away from any line, and compares the
// pixel differences: a wrap pair may differ no more than the control pair (the waves move a
// little between frames anyway). Exits 1 on failure. Shots: OUT/waterpop_*.png.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const OUT = resolve(arg('out', '/home/claude/simdata/shots/terrain_waterpop'));
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[waterpop ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// over the open sea west of Ashdod, looking down at 25 deg from 40 m; x of the lines
const Z = 10000;
const PAIRS = [
  { name: 'wrap256', x: -176 * 256 },            // a 256 m line that is not a 1280 m one
  { name: 'wrap1280', x: -36 * 1280 },           // a 1280 m line (also a 256 m one)
  { name: 'control', x: -176 * 256 + 128 },      // 128 m from any line
];

async function startServer() {
  const proc = spawn(process.env.PYTHON || 'python3', [join(ROOT, 'serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + 'index.html')).ok) return proc; } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  proc.kill();
  throw new Error('serve.py did not start');
}

/** In the page: mean absolute difference (0..255) of two screenshots over rows 15-90 % of the
 * frame (the sea below the horizon haze and above the HUD), and the share of pixels that
 * differ by more than 12. */
async function diffPng([a64, b64]) {
  const load = async (s) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + s)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, px: g.getImageData(0, 0, bmp.width, bmp.height).data };
  };
  const a = await load(a64), b = await load(b64);
  let sum = 0, big = 0, n = 0;
  for (let y = Math.floor(a.h * 0.15); y < Math.floor(a.h * 0.9); y++) {
    for (let x = 0; x < a.w; x++) {
      const k = (y * a.w + x) * 4;
      const d = (Math.abs(a.px[k] - b.px[k]) + Math.abs(a.px[k + 1] - b.px[k + 1]) + Math.abs(a.px[k + 2] - b.px[k + 2])) / 3;
      sum += d; n++;
      if (d > 12) big++;
    }
  }
  return { mean: sum / n, big: big / n };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  let ok = false;
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errors.push('page error: ' + e.message));
    page.setDefaultTimeout(900000);
    await page.goto(BASE + 'index.html?test=1&quality=high&wingmen=0');
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 900000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app error: ${err}`);
    await page.addStyleTag({ content: '#toast, #hud, .hud { display: none !important; }' });
    // the camera placed by hand after the camera rig's own update
    await page.evaluate(([x, z]) => {
      const app = window.__sim.app, sim = window.__sim;
      const orig = app.cams.update.bind(app.cams);
      app.cams.update = (dt, o) => {
        orig(dt, o);
        const c = window.__camOverride;
        if (!c) return;
        app.camera.position.set(c.x, 40, c.z);
        app.camera.rotation.set(-25 * Math.PI / 180, -250 * Math.PI / 180, 0, 'YXZ');
        app.camera.updateMatrixWorld();
      };
      app.terrain.spawns.__sea = { label: 'sea', x, z, y: 300, ground_y: 0, heading_deg: 270, on_ground: false, speed_ms: 150, gear: 0, throttle: 0.45 };
      sim.start('__sea', { time: 10, camera: 'chase' });
      sim.time(10);
      window.__camOverride = { x, z };
    }, [PAIRS[0].x, Z]);
    await page.evaluate(() => window.__sim.step(30));
    await page.evaluate(() => window.__sim.settle(2500));
    await page.evaluate(async () => {
      const t = window.__sim.app.terrain, t1 = performance.now();
      while ((t.stats.tilesLoading > 0 || t.horizon?.busy) && performance.now() - t1 < 180000) {
        window.__sim.render();
        await new Promise((r) => setTimeout(r, 250));
      }
    });
    const results = [];
    for (const p of PAIRS) {
      const shots = [];
      for (const dx of [-0.01, 0.01]) {
        await page.evaluate(([x, z]) => {
          window.__camOverride = { x, z };
          window.__sim.render();
          window.__sim.render();
        }, [p.x + dx, Z]);
        const buf = await page.screenshot();
        writeFileSync(join(OUT, `waterpop_${p.name}_${dx < 0 ? 'a' : 'b'}.png`), buf);
        shots.push(buf.toString('base64'));
      }
      results.push({ ...p, d: await page.evaluate(diffPng, shots) });
    }
    for (const r of results) log(`${r.name.padEnd(8)} x ${r.x}: mean |diff| ${r.d.mean.toFixed(2)}, pixels > 12: ${(100 * r.d.big).toFixed(2)} %`);
    const ctrl = results.find((r) => r.name === 'control').d;
    ok = results.every((r) => r.d.mean <= 2 * ctrl.mean + 0.5 && r.d.big <= 2 * ctrl.big + 0.002);
    log(ok ? 'PASS: no jump at the wrap lines' : 'FAIL: the sea pattern jumps at a wrap line');
    if (errors.length) log('console errors:', errors.slice(0, 5).join('\n'));
  } finally {
    await browser.close();
    server.kill();
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[waterpop]', e); process.exit(1); });
