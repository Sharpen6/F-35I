// node sim/dev/terrain.bench.mjs [--port 8146] [--root sim] [--size 960x540] [--frames 7] [--rounds 1]
//   [--out FILE] [--gpu] [--configs 0,5,6] [--views 0,2]
// Terrain-only frame times: dev/terrain.html (the terrain and the sky, nothing else) at three
// views (fields at 120 m at noon, Rehovot's orchards at 80 m at 08:00, Tel Aviv at night from
// 400 m), per quality and with each terrain feature switched off in turn, after the maps and
// tiles have settled. Each frame is timed with a 1-pixel readback (the GPU finished); a row's
// number is the median of its --frames frames (in each of --rounds rounds, which visit the rows
// in turn so that a slow spell of the machine is shared by all of them).
// By default on SwiftShader (CPU), where the wall time of a frame says more about whatever else
// the machine runs than about the frame: the bench also reads the CPU time the browser's GPU
// process (SwiftShader's threads) spent on each frame, which does not grow when other programs
// compete for the cores. Compare those numbers with each other, not with a GPU. --gpu uses the
// machine's GPU (a browser window opens; e.g. --gpu --size 1920x1080 on the PC): there only the
// wall time counts. --root runs another copy of sim/ (e.g. older code).
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const ROUNDS = Math.max(1, +arg('rounds', 1));
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
// The rows by horizon map size: the maps take seconds (minutes on SwiftShader) to compute, so
// each size is computed once per view and its rows are measured while it stands. Everything
// else a row changes is a uniform or a shader tier that is compiled once and kept.
const GROUPS = [];
for (const c of RUN_CONFIGS) {
  const hz = c[5] || c[1];
  let g = GROUPS.find((x) => x.hz === hz);
  if (!g) GROUPS.push(g = { hz, rows: [] });
  g.rows.push(c);
}

/** The pid of our browser's GPU process: the --type=gpu-process descendant of this process. */
function gpuProcess() {
  const parent = new Map(), gpu = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      parent.set(+d, +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      if (readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('--type=gpu-process')) gpu.push(+d);
    } catch (e) { /* the process ended meanwhile */ }
  }
  for (const p of gpu) for (let q = parent.get(p); q > 1; q = parent.get(q)) if (q === process.pid) return p;
  return 0;
}
/** Seconds of CPU (user + system, all threads) a process has used so far. */
function cpuSeconds(pid) {
  if (!pid) return NaN;
  const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
  return (+f[11] + +f[12]) / 100;      // utime, stime in clock ticks (USER_HZ = 100 on Linux)
}

// serve.py takes the next free port when --port is taken, e.g. for up to a minute after a run
// that just ended (its connections in TIME_WAIT): then wait and try again, so the bench never
// times another server's pages.
async function startServer() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const proc = spawn(process.env.PYTHON || 'python3', [join(ROOT, 'serve.py'), '--port', String(PORT)],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    let moved = false;
    for (let i = 0; i < 150 && !moved; i++) {   // up to 30 s: python starts slowly on a loaded machine
      if (out.includes('open ')) {
        moved = !out.includes(`:${PORT}/`);
        if (!moved) {
          try { if ((await fetch(BASE + 'index.html')).ok) return proc; } catch (e) { /* not up yet */ }
        }
      }
      if (!moved) await sleep(200);
    }
    proc.kill();
    if (!moved) break;
    log(`port ${PORT} is still taken, waiting`);
    await sleep(5000);
  }
  throw new Error('serve.py did not start');
}

// In the page: the horizon maps of a size computed and uploaded and the tiles loaded (the sun's
// shadows on meanwhile: a switched-off map is never recomputed). The terrain's update streams
// and uploads the tiles (one a frame) and the maps' bands without a draw, so it runs without
// one (a SwiftShader frame takes seconds), drawing every 20th frame and once at the end.
async function settle(hz) {
  const D = window.__dev, t = D.terrain, h = t.horizon;
  t.shadows = true;
  h.setQuality(hz);
  const t1 = performance.now();
  let n = 0;
  do {
    D.step(1 / 60, performance.now(), n % 20 === 19);
    await new Promise((r) => setTimeout(r, 50));
    n++;
  } while ((n < 2 || t.stats.tilesLoading > 0 || t._pending.length > 0 || t.qualityPending ||
    (h.enabled && (h.busy || h.pending || h._upload))) && performance.now() - t1 < 600000);
  D.step(1 / 60);
}

// In the page: a row's switches. The quality is set as such (not with setQuality, which would
// also recompute the horizon maps); with tiered shaders (this code) the tier's programs are
// compiled once and then only swapped. Returns true when the shader changed.
async function apply([q, d, s, c]) {
  const t = window.__dev.terrain;
  let changed = false;
  t.quality = q;
  if (t._applyTier) {
    const { TERRAIN_QUALITY } = await import('/js/terrain/Terrain.js');
    const gd = TERRAIN_QUALITY[q].groundDetail;
    if (t._gd !== gd) {
      await t._tier(gd).ready;
      t._applyTier(gd);
      changed = true;
    }
  }
  t.groundDetail = d; t.shadows = s; t.cityLights = c;
  return changed;
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

async function main() {
  const server = await startServer();
  const browser = await chromium.launch(GPU
    ? { headless: false, args: ['--ignore-gpu-blocklist'] }
    : { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const out = { when: new Date().toISOString(), root: ROOT, size: [W, H], frames: FRAMES, rounds: ROUNDS, gpu: '', views: {} };
  try {
    for (const v of RUN_VIEWS) {
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      page.setDefaultTimeout(1800000);
      await page.goto(`${BASE}dev/terrain.html?${v.q}&hud=0&dpr=1`);
      await page.waitForFunction(() => window.__dev && window.__dev.terrain && window.__dev.terrain.loaded, null, { timeout: 900000 });
      await page.evaluate(() => { window.__dev.paused = true; });
      if (!out.gpu) {
        out.gpu = await page.evaluate(() => {
          const gl = window.__dev.renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info');
          return String(x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        });
        log(`GPU: ${out.gpu}`);
      }
      const pid = GPU ? 0 : gpuProcess();
      if (!GPU && !pid) log('GPU process not found: wall times only');
      const acc = new Map(RUN_CONFIGS.map((c) => [c[0], { wall: [], cpu: [] }]));
      const frame = () => page.evaluate(() => window.__dev.timeFrame(1 / 60));
      for (const g of GROUPS) {
        await page.evaluate(settle, g.hz);
        for (let r = 0; r < ROUNDS; r++) {
          const k = r % g.rows.length, rows = g.rows.slice(k).concat(g.rows.slice(0, k));
          for (const row of rows) {
            // one frame unmeasured after a shader change (programs found, SwiftShader's routines
            // built); the other switches are uniforms, and the settling drew the group's first
            if (await page.evaluate(apply, row.slice(1, 5))) await frame();
            const a = acc.get(row[0]);
            for (let i = 0; i < FRAMES; i++) {
              const c0 = cpuSeconds(pid);
              a.wall.push(await frame());
              a.cpu.push(cpuSeconds(pid) - c0);
            }
          }
        }
        const info = await page.evaluate(() => {
          const r = window.__dev.renderer.info.render;
          return { calls: r.calls, triangles: r.triangles };
        });
        for (const row of g.rows) acc.get(row[0]).info = info;
      }
      const res = {};
      for (const [label] of RUN_CONFIGS) {
        const a = acc.get(label);
        res[label] = {
          median: median(a.wall), min: Math.min(...a.wall),
          cpu: pid ? median(a.cpu) : null, cpuMin: pid ? Math.min(...a.cpu) : null,
          ...a.info,
        };
        const x = res[label];
        log(`${v.name.padEnd(16)} ${label.padEnd(26)} wall ${x.median.toFixed(0)} ms (min ${x.min.toFixed(0)})` +
          (pid ? `, GPU process CPU ${x.cpu.toFixed(2)} s (min ${x.cpuMin.toFixed(2)})` : '') +
          `, ${x.calls} calls, ${(x.triangles / 1e6).toFixed(2)} M tris`);
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
