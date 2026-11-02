// Dusk and night across the modules: the same places and cameras at blue hour, at night and at
// noon, for judging every artificial light and self-lit surface together (airfield lights, PAPI,
// street lamps, cars, lit windows, obstruction lights, the jet's nav / strobe / landing lights and
// its pool, the burner, the cockpit's displays) against the night's exposure.
// Playwright + headless Chromium (SwiftShader), driven through window.__sim.
//
//   node sim/tests/night_shots.mjs [--port 8160] [--out DIR] [--only bgn_,tlv] [--shots chase,cockpit]
//                                  [--size 960x540] [--quality high] [--frames 3] [--tag T]
//                                  [--pre "js"] [--post "js"] [--probe "label:js;;label:js"]
//                                  [--params "a=1&b=2"] [--list] [--root SIM_FOLDER]
//
//   --only    scene names or prefixes; --list prints the scenes
//   --frames  frames drawn before each shot (the clouds' temporal filter and the exposure settle)
//   --pre     JavaScript run in the page before every scene (try a setting); --post after its setup
//   --probe   after each shot, run the steps one after another and shoot after each (which layer
//             makes a pixel); a step may leave a measurement in window.__npOut, which is logged
//   --params  extra URL parameters of the page
//   --root    the sim folder served (an exported older commit: before / after on the same scenes)
//   --tag     suffix of the file names (before / after side by side)
// Every shot's exposure, the environment's night state (sun elevation, nightLightGain, uNight,
// nightVision), renderInfo and statistics of the drawn frame (mean luma, percentiles, the share of
// clipped pixels) go to the log and to report.json in --out (default
// /home/claude/simdata/shots/night). Fails on console errors, page errors and failed requests.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NIGHT_PROBE } from './night_probe.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ROOT = resolve(arg('root', join(here, '..')));
const PORT = +arg('port', 8160);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/night'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const FRAMES = +arg('frames', 3);
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const SHOTS = arg('shots', '') ? arg('shots', '').split(',') : null;
const PRE = arg('pre', '');
const POST = arg('post', '');
// --probe "label:js;;label:js": after each shot, run the steps one after another (cumulative) and
// shoot again after each: which layer makes a pixel (e.g. switch the layers off one by one)
const PROBE = arg('probe', '') ? arg('probe', '').split(';;').map((s) => {
  const i = s.indexOf(':');
  return { label: s.slice(0, i).trim(), js: s.slice(i + 1) };
}) : [];
const TAG = arg('tag', '');
const EXTRA = arg('params', '');
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[night ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

// Page-side helpers (window.__nt): custom start points, an orbit camera, frame statistics.
const PAGE_HELPERS = `
window.__nt = {
  DEG: Math.PI / 180,
  spawn(name, base, over) {
    const sp = window.__sim.app.terrain.spawns;
    sp[name] = { ...(sp[base] || {}), ...over };
    return name;
  },
  rot(q, v) {
    const { x, y, z, w } = q; const [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  },
  /** Orbit camera: rel = degrees from behind the jet (90 = its right side), pitch deg, dist m. */
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
  /** A free camera right / up / ahead (m) of the jet, level with its heading, looking at it (night_probe free). */
  relCam(rel, fov) {
    const app = window.__sim.app, p = app.fdm.state.position, q = app.fdm.state.quaternion;
    // body frame: +X right, -Z forward; levelled
    const aft = this.rot(q, [0, 0, 1]), right = this.rot(q, [1, 0, 0]);
    const la = Math.hypot(aft[0], aft[2]) || 1, lr = Math.hypot(right[0], right[2]) || 1;
    const fx = -aft[0] / la, fz = -aft[2] / la, rx = right[0] / lr, rz = right[2] / lr;
    const pos = [p.x + rx * rel[0] + fx * rel[2], p.y + rel[1], p.z + rz * rel[0] + fz * rel[2]];
    window.__np.free(pos, [p.x, p.y + 1, p.z], fov);
    window.__sim.app.visual.object3d.visible = true;
    return pos;
  },
  /** Fly the scripted landing until the height above the ground is under agl m (short final). */
  approachTo(agl, seconds = 150) {
    const S = window.__sim;
    let t = 0;
    while (t < seconds) {
      S.step(12); t += 0.1;
      const s = S.summary();
      if (s.crashed || s.onGround || s.agl_m < agl) break;
    }
    return S.summary();
  },
  /** The environment's night state. */
  env() {
    const e = window.__sim.app.env;
    return { sunEl: +(e.sunElevationDeg ?? 0).toFixed(2), exposure: +(e.exposure ?? 0).toFixed(2),
      nightLightGain: +(e.nightLightGain ?? 1).toFixed(4), uNight: +(e.uniforms.uNight.value ?? 0).toFixed(4),
      nightVision: +(e.nightVision ?? 0).toFixed(3), adapted: e.adaptedLight ? +e.adaptedLight.toExponential(3) : null,
      lightGain: +(e.lightGain ?? 1).toFixed(3), lightNight: +(e.lightNight ?? 0).toFixed(3),
      // the sky's light on level ground as the scene has it (lux equivalent: x 32000)
      ambientLux: e.uniforms.uAmbient ? +(32000 * (0.2126 * e.uniforms.uAmbient.value.r + 0.7152 * e.uniforms.uAmbient.value.g
        + 0.0722 * e.uniforms.uAmbient.value.b)).toPrecision(3) : null };
  },
  /** Statistics of the 3D canvas (as drawn: tone mapped, sRGB): luma mean and percentiles, clipped share. */
  stats() {
    const c = window.__sim.app.renderer.domElement;
    const cv = this._cv || (this._cv = document.createElement('canvas'));
    if (cv.width !== c.width || cv.height !== c.height) { cv.width = c.width; cv.height = c.height; }
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    const hist = new Uint32Array(256);
    let sum = 0, clip = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      hist[l]++; sum += l; n++;
      if (d[i] >= 250 && d[i + 1] >= 250 && d[i + 2] >= 250) clip++;
    }
    const pct = (p) => { let acc = 0; const k = p * n; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= k) return i; } return 255; };
    return { mean: +(sum / n).toFixed(2), p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), p999: pct(0.999),
      white: +(clip / n * 1e3).toFixed(3) };
  },
};
true;
`;

// ---------------------------------------------------------------------------------------- scenes
// setup: page function source (may be async); shots: [{name, cam, measure}], cam 'chase' |
// 'cockpit' | 'flyby' | 'tower' | [rel, pitch, dist, fov] (orbit) | {papi: D, fov, near, heading}
// (a free camera on the 3 deg path D m before the PAPI next to `near`, the jet hidden) |
// {rel: [right, up, ahead], fov} (a free camera that far from the jet, looking at it: a clear
// tower's view). measure: names of window.__np measurements (night_probe.mjs) logged with the shot:
// 'papi', 'reds', 'tail', 'burner', 'pool'.
/** A 4 km final to Ben Gurion 26 (threshold -11936, -24251; heading 259.8), flown down to `agl` m. */
const BGN_FINAL = (time, agl) => `async () => { const nt = window.__nt, S = window.__sim;
  const h = 259.8 * Math.PI / 180, d = 4000;
  nt.spawn('nt_bgn_final', 'telnof_final', { x: -11936 + Math.sin(h) * -d, z: -24251 - Math.cos(h) * -d,
    y: 39.3 + d * Math.tan(3 * Math.PI / 180) + 15, heading_deg: 259.8, airport: 'LLBG', runway: '26' });
  S.start('nt_bgn_final', { time: ${time}, camera: 'chase' });
  S.autopilot('land', { runway: '26', icao: 'LLBG' });
  return nt.approachTo(${agl}); }`;
/** Tel Nof's final (telnof_final) flown down by the autopilot to `agl` m, as e2e.mjs does. */
const TN_FINAL = (time, agl) => `async () => { const nt = window.__nt, S = window.__sim;
  S.start('telnof_final', { time: ${time}, camera: 'chase' }); S.autopilot('land', { approachKt: 145 });
  return nt.approachTo(${agl}); }`;
/** Take-off roll in full burner until the burner is lit and `kt` knots. */
const AB_ROLL = (spawn, time, kt) => `async () => {
  const S = window.__sim; S.start('${spawn}', { time: ${time}, camera: 'chase' }); S.autopilot('takeoff');
  for (let i = 0; i < 400; i++) { S.step(12); const s = S.summary(); if (s.ab > 0.95 && s.ias_kt > ${kt}) break; }
  return S.summary(); }`;
const START = (spawn, time, steps = 60) => `async () => { const S = window.__sim;
  S.start('${spawn}', { ${time != null ? `time: ${time}, ` : ''}camera: 'chase' }); S.step(${steps}); return S.summary(); }`;

// the PAPI of Ben Gurion 26 (left of the runway, ~400 m past the threshold), seen on the 3 deg path
const PAPI26 = (D, fov) => ({ papi: D, fov, near: [-12912, -24024], heading: 259.8 });

const SCENES = [
  // Ben Gurion 26: short final (~1.2 km out) at blue hour and at night, then on the runway
  { name: 'bgn_final_1925', setup: BGN_FINAL(19.25, 65), shots: [{ name: 'chase', cam: 'chase' }, { name: 'cockpit', cam: 'cockpit' }] },
  { name: 'bgn_final_2130', setup: BGN_FINAL(21.5, 65), shots: [{ name: 'chase', cam: 'chase', measure: ['pool'] }, { name: 'cockpit', cam: 'cockpit' }] },
  { name: 'bgn_flare_2130', setup: BGN_FINAL(21.5, 12), shots: [{ name: 'cockpit', cam: 'cockpit' }, { name: 'side', cam: [100, 6, 40, 45] },
    { name: 'chase', cam: 'chase', measure: ['pool'] }] },
  // Tel Nof's final at night (e2e.mjs's pool checks): short final and the flare
  { name: 'telnof_final_2130', setup: TN_FINAL(21.5, 65), shots: [{ name: 'chase', cam: 'chase', measure: ['pool'] }, { name: 'cockpit', cam: 'cockpit' }] },
  { name: 'telnof_flare_2130', setup: TN_FINAL(21.5, 15), shots: [{ name: 'chase', cam: 'chase', measure: ['pool'] }, { name: 'cockpit', cam: 'cockpit' }] },
  { name: 'bgn_rwy_1925', setup: START('bengurion_26', 19.25), shots: [{ name: 'chase', cam: 'chase' }, { name: 'cockpit', cam: 'cockpit' }] },
  { name: 'bgn_rwy_2130', setup: START('bengurion_26', 21.5), shots: [{ name: 'chase', cam: 'chase', measure: ['reds'] }, { name: 'cockpit', cam: 'cockpit' },
    { name: 'front', cam: [-150, 8, 30, 45] }] },
  // the PAPI of runway 26 on the slope (2 white, 2 red) at night and in the blue hour
  { name: 'bgn_papi_2130', setup: START('bengurion_26', 21.5), shots: [{ name: 'd1500_fov12', cam: PAPI26(1500, 12), measure: ['papi', 'reds'] },
    { name: 'd800_fov60', cam: PAPI26(800, 60), measure: ['papi'] }, { name: 'd3000_fov60', cam: PAPI26(3000, 60), measure: ['reds'] }] },
  { name: 'bgn_papi_1925', setup: START('bengurion_26', 19.25), shots: [{ name: 'd1500_fov12', cam: PAPI26(1500, 12), measure: ['papi'] }] },
  // Tel Nof 36 at night, full burner on the take-off roll
  { name: 'telnof_ab_2130', setup: AB_ROLL('telnof_36', 21.5, 40), shots: [{ name: 'chase', cam: 'chase' }, { name: 'cockpit', cam: 'cockpit' },
    { name: 'tower', cam: { rel: [-260, 22, 60], fov: 30 } }, { name: 'rear34', cam: [28, 6, 18, 40], measure: ['burner'] }] },
  { name: 'telnof_idle_2130', setup: START('telnof_36', 21.5), shots: [{ name: 'rear', cam: [8, 4, 14, 40] }] },
  // over Tel Aviv at night: the city, buildings, street lamps, traffic
  { name: 'tlv_2130', setup: START('tlv_3000', 21.5, 120), shots: [{ name: 'chase', cam: 'chase', measure: ['reds', 'tail'] }, { name: 'cockpit', cam: 'cockpit' },
    { name: 'side', cam: [95, 4, 26, 40] }] },
  // Jerusalem at sunset (its own time) and in the blue hour
  { name: 'jer_1875', setup: START('jerusalem_sunset', null, 120), shots: [{ name: 'chase', cam: 'chase', measure: ['tail'] }, { name: 'cockpit', cam: 'cockpit' }] },
  { name: 'jer_1950', setup: START('jerusalem_sunset', 19.5, 120), shots: [{ name: 'chase', cam: 'chase', measure: ['tail'] }, { name: 'cockpit', cam: 'cockpit' }] },
  // noon: nothing of this may change (the burner's day look neither)
  { name: 'telnof_noon', setup: START('telnof_36', 12.5), shots: [{ name: 'chase', cam: 'chase' }, { name: 'cockpit', cam: 'cockpit' }] },
  { name: 'telnof_ab_noon', setup: AB_ROLL('telnof_36', 12.5, 40), shots: [{ name: 'chase', cam: 'chase' }, { name: 'rear34', cam: [28, 6, 18, 40] }] },
  // the burner between its looks (civil dusk, the sun ~2.4 deg down: about a quarter of the day look)
  { name: 'telnof_ab_1925', setup: AB_ROLL('telnof_36', 19.25, 40), shots: [{ name: 'rear34', cam: [28, 6, 18, 40] }] },
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

async function main() {
  if (argv.includes('--list')) { for (const s of SCENES) console.log(s.name, s.shots.map((x) => x.name).join(' ')); return; }
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const problems = [];
  const report = { quality: QUALITY, size: [W, H], frames: FRAMES, tag: TAG, shots: [] };
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      if (m.type() === 'warning' && !/ReadPixels|GPU stall/.test(m.text())) log('warn:', m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
    page.setDefaultTimeout(900000);
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${EXTRA ? '&' + EXTRA : ''}`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 900000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    await page.evaluate(PAGE_HELPERS);
    await page.evaluate(NIGHT_PROBE);
    await page.addStyleTag({ content: '#toast { display: none !important; }' });
    log('loaded');
    for (const sc of SCENES) {
      if (!selected(sc)) continue;
      if (PRE) await page.evaluate(PRE);
      await page.evaluate(() => window.__np.restore());
      const sum = await page.evaluate(`(${sc.setup})()`);
      if (POST) await page.evaluate(POST);
      log(`${sc.name}: ${sum.ias_kt} kt, alt ${sum.alt_m} m, agl ${sum.agl_m} m, ab ${sum.ab}, gear ${sum.gear}, t ${sum.time} h, phase ${sum.phase}`);
      for (const sh of sc.shots) {
        if (SHOTS && !SHOTS.includes(sh.name)) continue;
        await page.evaluate(() => window.__np.restore());
        if (Array.isArray(sh.cam)) await page.evaluate((c) => window.__nt.orbit(...c), sh.cam);
        else if (sh.cam && sh.cam.papi) {
          const r = await page.evaluate((c) => window.__np.papiCam(c.near, c.heading, c.papi, c.fov), sh.cam);
          if (!r) log('  no PAPI found near', sh.cam.near);
        } else if (sh.cam && sh.cam.rel) await page.evaluate((c) => window.__nt.relCam(c.rel, c.fov), sh.cam);
        else await page.evaluate((c) => window.__sim.camera(c), sh.cam);
        // a free camera somewhere new: the terrain and the buildings stream in round it first
        if (sh.cam && (sh.cam.papi || sh.cam.rel)) for (let i = 0; i < 3; i++) await page.evaluate(() => window.__sim.settle(1500));
        await page.evaluate(() => window.__sim.settle(1500));
        let ri = null;
        for (let i = 0; i < FRAMES; i++) ri = await page.evaluate(() => window.__sim.render());
        const name = `${sc.name}_${sh.name}${TAG ? '_' + TAG : ''}.png`;
        const file = join(OUT, name);
        const stats = await page.evaluate(() => window.__nt.stats());
        const env = await page.evaluate(() => window.__nt.env());
        await page.screenshot({ path: file });
        const mem = await page.evaluate(() => window.__sim.gpuMemory());
        // the lights measured in this frame (night_probe.mjs; 'pool' draws two more frames)
        const measured = {};
        for (const m of sh.measure || []) measured[m] = await page.evaluate((k) => window.__np[k](), m);
        report.shots.push({ file, scene: sc.name, shot: sh.name, calls: ri.calls, triangles: ri.triangles, ms: ri.ms,
          programs: ri.programs, gpuMB: mem.totalMB, env, stats, measured, summary: sum });
        log(`  ${name}  ${ri.calls} calls, ${(ri.triangles / 1e6).toFixed(2)} M tris, ${ri.ms} ms, GPU ~${mem.totalMB} MB`);
        log(`    env ${JSON.stringify(env)}  frame ${JSON.stringify(stats)}`);
        for (const [k, v] of Object.entries(measured)) log(`    ${k} ${JSON.stringify(v)}`);
        for (let p = 0; p < PROBE.length; p++) {
          await page.evaluate(PROBE[p].js);
          for (let i = 0; i < FRAMES; i++) await page.evaluate(() => window.__sim.render());
          const pf = join(OUT, `${sc.name}_${sh.name}${TAG ? '_' + TAG : ''}_p${p + 1}_${PROBE[p].label}.png`);
          await page.screenshot({ path: pf });
          // a probe step may leave a measurement in window.__npOut (e.g. window.__np.burner())
          const out = await page.evaluate(() => { const v = window.__npOut; window.__npOut = undefined; return v; });
          log(`    probe ${p + 1} ${PROBE[p].label}: ${JSON.stringify(await page.evaluate(() => window.__nt.stats()))}${out !== undefined ? '  ' + JSON.stringify(out) : ''}`);
        }
      }
    }
  } finally {
    writeFileSync(join(OUT, `report${TAG ? '_' + TAG : ''}.json`), JSON.stringify({ ...report, problems }, null, 1));
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
