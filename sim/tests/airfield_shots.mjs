// Screenshots of the scenes the paved airfield surfaces are judged by (Playwright + headless
// Chromium, SwiftShader), driven through the app's automation API window.__sim (?test=1).
//
//   node sim/tests/airfield_shots.mjs [--port 8600] [--out DIR] [--size 960x540] [--quality high]
//        [--scenes base|quick|close|fields|bengurion|far|tn36,tn36c,...] [--query runways=0] [--tag before] [--maxwait 90000]
//
// Scenes are placed on the runways of data/terrain/airports.json, so no coordinates are needed:
//   ground   on a runway end (a named spawn or `end`), the jet standing at `s` m past the end
//   air      on the approach to a runway end: `s` m from its threshold (negative: before it), `h` m
//            above the threshold, on the extended centreline, flying the 3 deg path (gear down)
//   takeoff  the scripted take-off from a spawn until the pilot's phase `until` (rotation)
//   cam      a free camera (the jet hidden): position and target in the runway frame of an end
//            (s along the landing direction from the threshold, t to the right, h above it);
//            the jet parked 2.5 km up, or on the runway at `jetAt` [s, t] (a sharp sun shadow map)
// Writes <out>/<scene>_<tag>.png and <out>/info_<tag>.jsonl (renderInfo, timing, GPU memory, the
// roads' and airfield surfaces' statistics, the exposure).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, appendFileSync } from 'node:fs';
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
const PORT = +arg('port', 8600);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/airfield/run'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const QUERY = arg('query', '');
const TAG = arg('tag', 'after');
const MAXWAIT = +arg('maxwait', 90000);
const BASE = `http://127.0.0.1:${PORT}/`;

const NOON = 12, LOW = 18.55;    // solar time: noon and a low sun (~5 deg) on 21 June
const SCENES = {
  // Tel Nof 36: lined up at the threshold, the take-off roll at rotation speed, 2 km final, 3,000 ft
  tn36c: { kind: 'ground', spawn: 'telnof_36', time: NOON, view: 'cockpit' },
  tn36: { kind: 'ground', spawn: 'telnof_36', time: NOON, view: 'chase' },
  tn36low: { kind: 'ground', spawn: 'telnof_36', time: LOW, view: 'cockpit' },
  tn36rot: { kind: 'takeoff', spawn: 'telnof_36', until: 'rotate', time: NOON, view: 'cockpit' },
  tn36f2: { kind: 'air', icao: 'LLEK', end: '36', s: -2000, time: NOON, view: 'cockpit' },
  tn36f2low: { kind: 'air', icao: 'LLEK', end: '36', s: -2000, time: LOW, view: 'cockpit' },
  tn36f1: { kind: 'air', icao: 'LLEK', end: '36', s: -900, time: NOON, view: 'cockpit' },
  // the pilot's view on the 3 deg path 2 km out (and 1 km), through a longer lens (the runway is
  // small and low in the cockpit view)
  tn36f2z: { kind: 'cam', icao: 'LLEK', end: '36', pos: [-2000, 0, 120], look: [700, 0, 0], fov: 22, time: NOON },
  tn36f2zlow: { kind: 'cam', icao: 'LLEK', end: '36', pos: [-2000, 0, 120], look: [700, 0, 0], fov: 22, time: LOW },
  tn36f1z: { kind: 'cam', icao: 'LLEK', end: '36', pos: [-1000, 0, 67], look: [600, 0, 0], fov: 30, time: NOON },
  tn3000: { kind: 'cam', icao: 'LLEK', end: '36', pos: [600, -2600, 914], look: [1200, 0, 0], fov: 50, time: NOON },
  tn3000low: { kind: 'cam', icao: 'LLEK', end: '36', pos: [600, -2600, 914], look: [1200, 0, 0], fov: 50, time: LOW },
  tntower: { kind: 'ground', spawn: 'telnof_36', time: NOON, view: 'tower' },
  tnrottw: { kind: 'takeoff', spawn: 'telnof_36', until: 'rotate', time: NOON, view: 'tower' },
  // as from the tower but in the clear (the tower camera sees the jet past a hangar at Tel Nof):
  // 30 m up beside the runway's west side, the touchdown zone through a long lens
  tnside: { kind: 'cam', icao: 'LLEK', end: '36', pos: [1300, -330, 30], look: [600, 0, 0], fov: 22, time: NOON },
  tnsidelow: { kind: 'cam', icao: 'LLEK', end: '36', pos: [1300, -330, 30], look: [600, 0, 0], fov: 22, time: LOW },
  // close-ups from a free camera: the touchdown zone, the threshold, mid-runway, an arresting cable
  tntdz: { kind: 'cam', icao: 'LLEK', end: '36', pos: [250, -30, 6], look: [520, 5, 0], fov: 50, time: NOON },
  tnmid: { kind: 'cam', icao: 'LLEK', end: '36', pos: [1150, 18, 4], look: [1250, 0, 0], fov: 55, time: NOON },
  tnend: { kind: 'cam', icao: 'LLEK', end: '18', pos: [-120, 25, 8], look: [60, 0, 0], fov: 55, time: NOON },
  // the concrete end of 33R: from above the blast pad, over the threshold to the concrete's end
  tnconc: { kind: 'cam', icao: 'LLEK', end: '33R', pos: [-150, -12, 14], look: [200, 4, 0], fov: 55, time: NOON },
  // an arresting cable across 36 (460 m past the threshold), its discs and signs
  tncable: { kind: 'cam', icao: 'LLEK', end: '36', pos: [400, -28, 3], look: [470, 0, 0], fov: 50, time: NOON },
  tn33: { kind: 'ground', spawn: 'telnof_33r', time: NOON, view: 'cockpit' },
  tnapron: { kind: 'cam', icao: 'LLEK', end: '36', pos: [1300, -330, 60], look: [1300, -180, 0], fov: 55, time: NOON },
  // an apron (Tel Nof and Hatzor have none mapped): Ben Gurion's, among its floodlight masts
  bgapron: { kind: 'cam', icao: 'LLBG', end: '26', pos: [-300, -1900, 70], look: [-480, -2250, 0], fov: 50, time: NOON },
  // the other fields
  bg26c: { kind: 'ground', spawn: 'bengurion_26', time: NOON, view: 'cockpit' },
  // Ben Gurion 26: the spawn faces the 600 m displaced section (arrows along the centre, ICAO
  // Annex 14 fig. 5-4); the section from the side, its end at the threshold bar, and the
  // turn-off tyre marks beside the spawn
  bg26: { kind: 'ground', spawn: 'bengurion_26', time: NOON, view: 'chase' },
  bg26disp: { kind: 'cam', icao: 'LLBG', end: '26', pos: [-470, -18, 5], look: [-380, 0, 0], fov: 55, time: NOON },
  bg26thr: { kind: 'cam', icao: 'LLBG', end: '26', pos: [-90, -25, 9], look: [30, 0, 0], fov: 55, time: NOON },
  bg26turn: { kind: 'cam', icao: 'LLBG', end: '26', pos: [-450, 6, 12], look: [-535, -14, 0], fov: 55, time: NOON },
  n_bg26c: { kind: 'ground', spawn: 'bengurion_26', time: 21.5, view: 'cockpit' },
  // the approach from 9, 6, 4 and 3 km through long lenses: the runway's tone against the fields
  // (the surfaces' far fade, 4.4-11 km on high, 2.6-7 km on low)
  tn36f9z: { kind: 'cam', icao: 'LLEK', end: '36', pos: [-9000, 0, 490], look: [1200, 0, 0], fov: 9, time: NOON },
  tn36f6z: { kind: 'cam', icao: 'LLEK', end: '36', pos: [-6000, 0, 330], look: [1200, 0, 0], fov: 12, time: NOON },
  tn36f4z: { kind: 'cam', icao: 'LLEK', end: '36', pos: [-4000, 0, 225], look: [1200, 0, 0], fov: 15, time: NOON },
  tn36f3z: { kind: 'cam', icao: 'LLEK', end: '36', pos: [-3000, 0, 172], look: [1200, 0, 0], fov: 18, time: NOON },
  // the low sun of 17:30 on the cable's signs and the edge fixtures (their shadows)
  tncablelow: { kind: 'cam', icao: 'LLEK', end: '36', pos: [400, -28, 3], look: [470, 0, 0], fov: 50, time: 17.5 },
  // the same with the (hidden) jet on the runway beside the camera: a sharp shadow map there
  tncablelowg: { kind: 'cam', icao: 'LLEK', end: '36', pos: [400, -28, 3], look: [470, 0, 0], fov: 50, time: 17.5, jetAt: [380, 0] },
  bg26f2: { kind: 'air', icao: 'LLBG', end: '26', s: -2000, time: NOON, view: 'cockpit' },
  bg12f2: { kind: 'air', icao: 'LLBG', end: '12', s: -2000, time: NOON, view: 'cockpit' },
  bg3000: { kind: 'cam', icao: 'LLBG', end: '26', pos: [800, -2800, 914], look: [1400, 0, 0], fov: 50, time: NOON },
  bg26f2z: { kind: 'cam', icao: 'LLBG', end: '26', pos: [-2000, 0, 120], look: [700, 0, 0], fov: 22, time: NOON },
  hz29f2z: { kind: 'cam', icao: 'LLHS', end: '29R', pos: [-2000, 0, 120], look: [700, 0, 0], fov: 22, time: NOON },
  pm21f2z: { kind: 'cam', icao: 'LL59', end: '21', pos: [-2000, 0, 120], look: [700, 0, 0], fov: 22, time: NOON },
  hz29f2: { kind: 'air', icao: 'LLHS', end: '29R', s: -2000, time: NOON, view: 'cockpit' },
  hz23f2: { kind: 'air', icao: 'LLHS', end: '23', s: -2000, time: NOON, view: 'cockpit' },
  hz3000: { kind: 'cam', icao: 'LLHS', end: '23', pos: [700, -2600, 914], look: [1200, 0, 0], fov: 50, time: NOON },
  pm21f2: { kind: 'air', icao: 'LL59', end: '21', s: -2000, time: NOON, view: 'cockpit' },
  pm21c: { kind: 'groundEnd', icao: 'LL59', end: '21', s: 30, time: NOON, view: 'cockpit' },
};
const SETS = {
  base: 'tn36c,tn36,tn36rot,tn36f2,tn3000,tntower,tn36low,tn36f2low,bg26c,bg26,bg26disp,hz29f2,pm21f2',
  quick: 'tn36c,tn36f2z,tn3000',
  close: 'tntdz,tnmid,tnconc,tncable,bgapron',
  fields: 'bg26f2z,hz29f2z,pm21f2z,bg3000,hz3000',
  bengurion: 'bg26,bg26c,bg26disp,bg26thr,bg26turn',
  far: 'tn36f9z,tn36f6z,tn36f4z,tn36f3z',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[airfield ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

async function startServer() {
  const proc = spawn(process.env.PYTHON || 'python3', [join(ROOT, 'serve.py'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    } catch (e) { if (String(e.message).includes('did not take')) throw e; }
    await sleep(200);
  }
  proc.kill();
  throw new Error(`serve.py did not start:\n${out}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let list = arg('scenes', 'base');
  list = list.split(',').flatMap((n) => (SETS[n] ? SETS[n].split(',') : [n])).filter(Boolean);
  const server = await startServer();
  const problems = [];
  let browser = null, page = null;
  const S = (fn, a) => page.evaluate(fn, a);
  // (re)opens the browser and the app: SwiftShader pages die now and then when memory is short
  async function open() {
    if (browser) await browser.close().catch(() => {});
    browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      if ((m.type() === 'warning' && !/GPU stall|parallel_shader/.test(m.text())) || m.type() === 'error' || /airfield|runway/i.test(m.text())) log(`console.${m.type()}: ${m.text().slice(0, 300)}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
    page.setDefaultTimeout(900000);
    const tLoad = Date.now();
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0&clouds=few${QUERY ? '&' + QUERY : ''}`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 600000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    log(`loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)} s`);
  }
  try {
    await open();
    for (const name of list) {
      const sc = SCENES[name];
      if (!sc) { log(`unknown scene ${name}`); continue; }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await shoot(name, sc);
          break;
        } catch (e) {
          if (!/crash|closed|Target/i.test(String(e.message)) || attempt) throw e;
          log(`${name}: ${String(e.message).split('\n')[0]}: reopening the browser`);
          await open();
        }
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
  }
  if (problems.length) { log('PROBLEMS:'); for (const p of problems.slice(0, 20)) log('  ' + p); }
  process.exit(problems.length ? 1 : 0);

  async function shoot(name, sc) {
    const t1 = Date.now();
    const sum = await S(async (sc) => {
      const sim = window.__sim, app = sim.app;
      // the runway frame of an end: origin at its threshold, s along the landing direction, t right
      const frame = (icao, id) => {
        const ap = app.terrain.airports.find((a) => a.icao === icao);
        for (const rw of ap.runways) {
          const k = rw.ends.findIndex((e) => e.id === id);
          if (k < 0) continue;
          const a = rw.ends[k], b = rw.ends[1 - k];
          const L = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
          const d = a.displaced_threshold_m || 0;
          const ox = a.x + ux * d, oz = a.z + uz * d;
          const y0 = app.terrain.heightAt(ox, oz);
          return { P: (s, t, h) => [ox + ux * s - uz * t, y0 + h, oz + uz * s + ux * t], hdg: a.heading_deg, y0 };
        }
        throw new Error(`no runway end ${icao} ${id}`);
      };
      if (app._shotCamUpdate) { app.cams.update = app._shotCamUpdate; app._shotCamUpdate = null; app.visual.object3d.visible = true; }
      let spawn = sc.spawn;
      if (sc.kind === 'air' || sc.kind === 'groundEnd' || sc.kind === 'cam') {
        const F = frame(sc.icao, sc.end);
        let x, y, z, sp;
        if (sc.kind === 'air') {
          // on the 3 deg path to a 15 m threshold crossing height
          const h = sc.h ?? (15 - sc.s * Math.tan(3 * Math.PI / 180));
          [x, y, z] = F.P(sc.s, 0, h);
          sp = { label: 'shot', x, y, z, ground_y: app.terrain.heightAt(x, z), heading_deg: F.hdg, on_ground: false, speed_ms: 74, gear: 1, flight_path_deg: -3, fuel: 0.45 };
        } else if (sc.kind === 'groundEnd') {
          [x, y, z] = F.P(sc.s, 0, 0);
          sp = { label: 'shot', x, y: app.terrain.heightAt(x, z), z, heading_deg: F.hdg, on_ground: true, speed_ms: 0, gear: 1, throttle: 0 };
        } else if (sc.jetAt) {
          // free camera, the (hidden) jet on the runway at jetAt [s, t]: the sun's shadow map is
          // then fitted to the ground around the camera (~10 cm texels), not stretched to the jet
          [x, y, z] = F.P(sc.jetAt[0], sc.jetAt[1], 0);
          sp = { label: 'shot', x, y: app.terrain.heightAt(x, z), z, heading_deg: F.hdg, on_ground: true, speed_ms: 0, gear: 1, throttle: 0 };
        } else {
          // free camera: the jet parked high above, out of the way
          [x, y, z] = F.P(sc.pos[0], sc.pos[1], 0);
          sp = { label: 'shot', x: x + 3000, y: y + 2500, z, ground_y: app.terrain.heightAt(x + 3000, z), heading_deg: 0, on_ground: false, speed_ms: 160, gear: 0 };
        }
        app.terrain.spawns._shot = sp;
        spawn = '_shot';
      }
      sim.start(spawn, { time: sc.time, camera: sc.view || 'chase' });
      if (sc.time != null) sim.time(sc.time);
      if (sc.kind === 'takeoff') {
        sim.autopilot('takeoff');
        sim.fly({ until: sc.until, seconds: 120 });
      } else {
        sim.step(sc.kind === 'air' ? 24 : 60);
      }
      if (sc.kind === 'cam') {
        const F = frame(sc.icao, sc.end);
        const a = F.P(...sc.pos), b = F.P(...sc.look);
        const cam = app.camera;
        app._shotCamUpdate = app.cams.update.bind(app.cams);
        app.cams.update = () => {
          cam.position.set(a[0], a[1], a[2]);
          cam.up.set(0, 1, 0);
          cam.lookAt(b[0], b[1], b[2]);
          cam.fov = sc.fov || 50;
          cam.updateProjectionMatrix();
          cam.updateMatrixWorld(true);
        };
        app.visual.object3d.visible = false;
      }
      return sim.summary();
    }, sc);
    // wait until the terrain, the roads and the airfield surfaces have streamed
    let quiet = 0;
    const tw = Date.now();
    while (Date.now() - tw < MAXWAIT) {
      await S(() => window.__sim.settle(1500));
      const st = await S(() => {
        const app = window.__sim.app;
        const roads = app.modules?.find((m) => m.name === 'roads');
        const t = app.terrain.stats;
        const veg = app.modules?.find((m) => m.name === 'vegetation');
        return { terrain: t.tilesLoading, roads: roads ? roads.stats.building + (roads._queue?.length || 0) : 0, surf: app.modules?.find((m) => m.name === 'runways')?.stats?.building || 0,
          veg: veg && veg.idle ? (veg.idle() ? 0 : 1) : 0 };
      });
      if (st.terrain === 0 && st.roads === 0 && st.surf === 0 && st.veg === 0) quiet++; else quiet = 0;
      if (quiet >= 2) break;
    }
    const s = await S(() => window.__sim.settle(1000));
    const info = await S(() => {
      const app = window.__sim.app;
      const roads = app.modules?.find((m) => m.name === 'roads');
      return {
        render: window.__sim.renderInfo(), timing: window.__sim.timing(), mem: window.__sim.gpuMemory(),
        roads: roads ? roads.stats : null, runways: app.modules?.find((m) => m.name === 'runways')?.stats || null, exposure: app.env.exposure,
      };
    });
    const file = join(OUT, `${name}_${TAG}.png`);
    await page.screenshot({ path: file });
    appendFileSync(join(OUT, `info_${TAG}.jsonl`), JSON.stringify({ name, tag: TAG, quality: QUALITY, query: QUERY, summary: sum, settled: s, ...info, wallS: (Date.now() - t1) / 1000 }) + '\n');
    log(`${name}: ${info.render.calls} calls, ${(info.render.triangles / 1e6).toFixed(2)} M tris, ${info.render.programs} programs, GPU ${info.mem.totalMB} MB, ias ${s.ias_kt} kt, ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  }
}

main().catch((e) => { console.error('[airfield]', e); process.exit(1); });
