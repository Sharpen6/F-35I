// node sim/dev/terrain.bench.mjs [--port 8146] [--root sim] [--size 960x540] [--frames 7] [--out FILE] [--gpu]
//   [--configs 0,5,6] [--views 0,2]
// Terrain-only frame times: dev/terrain.html (the terrain and the sky, nothing else) at three
// views (fields at 120 m at noon, Rehovot's orchards at 80 m at 08:00, Tel Aviv at night from
// 400 m), per quality and with each terrain feature switched off in turn. Each number is the
// median of --frames frames timed with a 1-pixel readback (the GPU finished), after the maps
// and tiles have settled. By default on SwiftShader (CPU): the numbers are CPU time per frame,
// compare them with each other, not with a GPU. --gpu uses the machine's GPU (a browser window
// opens; e.g. --gpu --size 1920x1080 on the PC). --root runs another copy of sim/ (e.g. older
// code).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
const [W, H] = arg('size', '960x540').split('x').map(Number);
const FRAMES = +arg('frames', 7);
const OUT = arg('out', '');
const GPU = argv.includes('--gpu');
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[bench ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

const VIEWS = [
  { name: 'fields120_noon', q: 'x=-24500&z=4500&agl=120&hdg=35&pitch=-12&t=12' },
  { name: 'orchards80_0800', q: 'x=-22720&z=-8000&agl=80&hdg=60&pitch=-12&t=8' },
  { name: 'tlv400_night', q: 'x=-21500&z=-29500&agl=400&hdg=250&pitch=-15&t=21.5' },
];
// [label, quality, ground detail, terrain shadows, city lights, horizon map size (default: the
// quality's)]: the 1024^2 row shows what the 2048^2 maps of high cost per frame
const CONFIGS = [
  ['high', 'high', true, true, 1],
  ['high, no ground detail', 'high', false, true, 1],
  ['high, no terrain shadows', 'high', true, false, 1],
  ['high, no city lights', 'high', true, true, 0],
  ['high, 1024^2 horizon maps', 'high', true, true, 1, 'medium'],
  ['medium', 'medium', true, true, 1],
  ['low', 'low', true, true, 1],
  ['all terrain features off', 'high', false, false, 0],
];
// --configs 0,5,6 runs only those rows (by index), --views 0,2 only those views
const pick = (list, name) => {
  const v = arg(name, '');
  return v ? v.split(',').map(Number).filter((i) => list[i]).map((i) => list[i]) : list;
};
const RUN_CONFIGS = pick(CONFIGS, 'configs');
const RUN_VIEWS = pick(VIEWS, 'views');

async function startServer() {
  const proc = spawn(process.env.PYTHON || 'python3', [join(ROOT, 'serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + 'index.html')).ok) return proc; } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  proc.kill();
  throw new Error('serve.py did not start');
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch(GPU
    ? { headless: false, args: ['--ignore-gpu-blocklist'] }
    : { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const out = { when: new Date().toISOString(), root: ROOT, size: [W, H], frames: FRAMES, gpu: '', views: {} };
  try {
    for (const v of RUN_VIEWS) {
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      page.setDefaultTimeout(900000);
      await page.goto(`${BASE}dev/terrain.html?${v.q}&hud=0&dpr=1`);
      await page.waitForFunction(() => window.__dev && window.__dev.terrain && window.__dev.terrain.loaded, null, { timeout: 900000 });
      if (!out.gpu) {
        out.gpu = await page.evaluate(() => {
          const gl = window.__dev.renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info');
          return String(x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        });
        log(`GPU: ${out.gpu}`);
      }
      const res = {};
      for (const [label, q, d, s, c, hq] of RUN_CONFIGS) {
        // settle: the tiles, the horizon maps of this quality (computed and uploaded; only while
        // the shadows are on, since a switched-off map is never recomputed), the programs
        await page.evaluate(async ([qq, dd, ss, cc, hh]) => {
          const D = window.__dev, t = D.terrain, h = t.horizon;
          D.paused = true;
          if (t.quality !== qq) t.setQuality(qq);
          h.setQuality(hh || qq);          // the horizon map tiers have the quality names
          t.groundDetail = dd; t.shadows = ss; t.cityLights = cc;
          const t1 = performance.now();
          let n = 0;
          do {
            D.step(1 / 60);
            await new Promise((r) => setTimeout(r, 50));
            n++;
          } while ((n < 3 || t.stats.tilesLoading > 0 || t.qualityPending || (ss && (h.busy || h.pending || h._upload))) &&
            performance.now() - t1 < 240000);
        }, [q, d, s, c, hq]);
        const ms = await page.evaluate((N) => {
          const D = window.__dev, a = [];
          for (let i = 0; i < N; i++) a.push(D.timeFrame(1 / 60));
          a.sort((x, y) => x - y);
          return { median: a[a.length >> 1], min: a[0] };
        }, FRAMES);
        const info = await page.evaluate(() => {
          const r = window.__dev.renderer.info.render;
          return { calls: r.calls, triangles: r.triangles };
        });
        res[label] = { ...ms, ...info };
        log(`${v.name.padEnd(16)} ${label.padEnd(26)} median ${ms.median.toFixed(0)} ms (min ${ms.min.toFixed(0)}), ${info.calls} calls, ${(info.triangles / 1e6).toFixed(2)} M tris`);
      }
      out.views[v.name] = res;
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
}

main().catch((e) => { console.error('[bench]', e); process.exit(1); });
