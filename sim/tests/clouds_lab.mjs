// A live session for working on the clouds (js/env/Clouds.js): the app loaded once in headless
// Chromium (SwiftShader), driven over a small HTTP control port, so a change to the cloud shaders
// is seen in seconds instead of a full reload (the app's start-up with the shader warm-up takes a
// minute or more in SwiftShader).
//
//   node sim/tests/clouds_lab.mjs [--port 8800] [--ctl 8801] [--size 960x540] [--quality high]
//        [--params "buildings=0&vegetation=0"]
//
// then, from a shell:
//   curl -s localhost:8801/scene -d '{"spawn":"telnof_36","time":12.5,"cam":"chase","clouds":"few"}'
//   curl -s localhost:8801/shot -d '{"file":"/home/claude/simdata/shots/clouds/x.png","frames":8}'
//   curl -s localhost:8801/reload        (re-imports Clouds.js and swaps the module: shader edits)
//   curl -s localhost:8801/eval -d 'return __sim.app.clouds.info()'
//   curl -s localhost:8801/quit
//
// scene: spawn, time (solar hours), year (the moon: 2024 full, 2026 first quarter, 2028 none at
// 21:30), clouds (preset), climb (m: the spawn's height for this start), x / z (m: the spawn moved),
// heading (deg), doy (day of the year for this start), cam: 'chase' | 'cockpit' | 'orbit' ... | {orbit: [yaw, pitch, dist]} |
// {chase: [yaw, pitch]} | {head: [yaw, pitch]} (cockpit, deg) | {free: [x, y, z, yawDeg, pitchDeg, fovDeg]}
// (a camera placed in the world: the app's camera is moved after the frame's update), steps (1/120 s
// steps flown before the shot, default 240).
// reload re-imports only Clouds.js (its imports keep their loaded instances): an edit of
// atmosphereGLSL.js or cloudField.js needs a restart of this script.
//
// --mini: instead of the app, a page with only the sky, a flat ground, the Environment, Post and
// the clouds (no terrain, jet or other modules): a frame in seconds in SwiftShader, and a reload
// (curl /reload: the whole page, every module fresh) in a few. Its control:
//   curl -s localhost:8801/view -d '{"x":0,"y":60,"z":0,"yaw":0,"pitch":12,"fov":60,"time":12.5,
//        "clouds":"few","frames":6,"file":"/home/claude/simdata/shots/clouds/m.png"}'
// (yaw: deg from north, clockwise; pitch: deg up; year / doy: the date; quality; wind: [x, z] m,
// the field's drift; temporal: false for single frames)

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
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
const PORT = +arg('port', 8800);
const CTL = +arg('ctl', 8801);
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'high');
const EXTRA = arg('params', '');
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[lab ${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} s]`, ...a);

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

// installed in the page: scene setup and the module swap
const PAGE_HELPERS = `
window.__lab = {
  async scene(s) {
    const sim = window.__sim, app = sim.app;
    if (app.env) app.env.year = s.year || 2026;
    if (app.clouds) app.clouds.choose(s.clouds || 'few');
    const sp = app.terrain.spawns[s.spawn || 'telnof_36'];
    const keep = { x: sp.x, y: sp.y, z: sp.z, heading_deg: sp.heading_deg, day_of_year: sp.day_of_year };
    if (s.climb) sp.y = s.climb;
    if (Number.isFinite(s.doy)) sp.day_of_year = s.doy;
    if (Number.isFinite(s.x)) sp.x = s.x;
    if (Number.isFinite(s.z)) sp.z = s.z;
    if (Number.isFinite(s.heading)) sp.heading_deg = s.heading;
    sim.start(s.spawn || 'telnof_36', { time: s.time ?? 12, camera: 'chase' });
    Object.assign(sp, keep);
    if (keep.day_of_year === undefined) delete sp.day_of_year;
    sim.step(s.steps ?? 240);
    window.__lab.free = null;
    const cam = s.cam || 'chase';
    if (typeof cam === 'string') { sim.camera(cam); sim.step(24); }
    else if (cam.chase) {
      const C = app.cams.chase;
      sim.camera('chase'); sim.step(12);
      C.yaw = cam.chase[0] * Math.PI / 180; C.pitch = cam.chase[1] * Math.PI / 180; C.idle = -1e9;
      sim.step(12);
    } else if (cam.head) {
      const Hd = app.cams.head;
      sim.camera('cockpit');
      Hd.yaw = cam.head[0] * Math.PI / 180; Hd.pitch = cam.head[1] * Math.PI / 180; Hd.centering = false;
      sim.step(12);
    } else if (cam.orbit) {
      const O = app.cams.orbit;
      sim.camera('orbit');
      const q = app.drawQuat;
      const back = app.camera.position.clone().set(0, 0, 1).applyQuaternion(q);
      O.init = true; O.auto = 0;
      O.yaw = Math.atan2(back.x, back.z) + cam.orbit[0] * Math.PI / 180;
      O.pitch = cam.orbit[1] * Math.PI / 180;
      O.dist = cam.orbit[2];
      sim.step(12);
    } else if (cam.free) {
      sim.camera('chase');
      window.__lab.free = cam.free;
      sim.step(12);
    }
    return sim.summary();
  },
  // the free camera: placed after the app's own camera update (wrapped once)
  _wrap() {
    const app = window.__sim.app;
    if (app.__labWrapped) return;
    app.__labWrapped = true;
    const orig = app._render.bind(app);
    app._render = (dt, f, a, drawIt) => {
      const fr = window.__lab.free;
      if (fr && drawIt) {
        // let the app update everything, then move the camera before the frame is drawn:
        // done by patching the post's render for this call
        const post = app.post, pr = post.render.bind(post);
        post.render = (scene, camera) => {
          const [x, y, z, yaw, pitch, fov] = fr;
          camera.position.set(x, y, z);
          camera.rotation.set(pitch * Math.PI / 180, -yaw * Math.PI / 180, 0, 'YXZ');
          if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
          camera.updateMatrixWorld(true);
          app.env.uniforms.uCameraPos.value.copy(camera.position);
          app.env.uniforms.uCamAltitude.value = camera.position.y;
          return pr(scene, camera);
        };
        try { return orig(dt, f, a, drawIt); } finally { post.render = pr; }
      }
      return orig(dt, f, a, drawIt);
    };
  },
  async reload() {
    const app = window.__sim.app;
    const mod = await import('./js/env/Clouds.js?v=' + Date.now());
    const old = app.clouds;
    const ctx = old.ctx;
    const preset = old.preset, wind = old.wind.slice();
    old.dispose();
    const c = new mod.Clouds(ctx);
    const i = app.modules.indexOf(old);
    if (i >= 0) app.modules[i] = c;
    c.budgetMs = null;
    c.setQuality(app.settings.quality);
    c.choose(preset);
    c.wind[0] = wind[0]; c.wind[1] = wind[1];
    window.__labCloudsModule = mod;
    return c.info();
  },
};
window.__lab._wrap();
`;

let server = null;
const MINI = argv.includes('--mini');
const MINI_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>clouds mini lab</title>
<style>html,body{margin:0;background:#000;overflow:hidden}</style>
<script type="importmap">{"imports": {"three": "./vendor/three/build/three.module.js", "three/addons/": "./vendor/three/examples/jsm/"}}</script>
</head><body><script type="module">
import * as THREE from 'three';
import { Environment } from './js/env/Environment.js';
import { Post } from './js/env/Post.js';
import { Clouds } from './js/env/Clouds.js';
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: false, depth: false, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setSize(W, H);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, W / H, 0.5, 650000);
camera.rotation.order = 'YXZ';
const env = new Environment({ renderer, scene });
const settings = { quality: 'high', clouds: 'few' };
const app = { settings, renderer, scene, camera, env };
app.post = new Post({ renderer, env, quality: 'high' });
// the ground: a flat disc at sea level, the coastal plain's colour (no terrain here)
const ground = new THREE.Mesh(new THREE.CircleGeometry(200000, 128).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: new THREE.Color(0.33, 0.27, 0.2), roughness: 1 }));
scene.add(ground);
const clouds = new Clouds({ renderer, scene, camera, env, app });
clouds.budgetMs = null;
let last = performance.now();
window.__mini = {
  app, clouds, env, THREE,
  view(v) {
    if (v.year) env.year = v.year;
    if (v.quality) { settings.quality = v.quality; app.post.setQuality(v.quality); clouds.setQuality(v.quality); }
    if (v.clouds) clouds.choose(v.clouds);
    if (v.time != null) { env.setTime(v.time, v.doy || 172); clouds.setTime(v.time, v.doy || 172); }
    if (v.wind) { clouds.wind[0] = v.wind[0]; clouds.wind[1] = v.wind[1]; }
    if (v.temporal != null) clouds.temporal = v.temporal;
    camera.position.set(v.x ?? 0, v.y ?? 60, v.z ?? 0);
    camera.rotation.set((v.pitch ?? 10) * Math.PI / 180, -(v.yaw ?? 0) * Math.PI / 180, 0, 'YXZ');
    camera.fov = v.fov ?? 60;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    clouds.resetHistory();
    // let the exposure settle (the eye's adaptation is eased): updates without drawing
    for (let i = 0; i < 40; i++) { env.update(camera, 0.25); clouds.update({ camera, dt: 0, draw: false }); }
    return { exposure: env.exposure, sun: env.sunElevationDeg };
  },
  frame(n = 1, dt = 0) {
    let t0 = performance.now();
    for (let i = 0; i < n; i++) {
      env.update(camera, dt || 0.016);
      clouds.update({ camera, dt, draw: true });
      app.post.render(scene, camera);
    }
    const gl = renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return { ms: performance.now() - t0, gpu: app.post.gpuTimes, exposure: env.exposure };
  },
};
window.__miniReady = true;
</script></body></html>`;

async function main() {
  server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const problems = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') { problems.push(t); log('console error:', t.slice(0, 400)); }
    else if (m.type() === 'warning' && !/ReadPixels|GPU stall/.test(t)) log('warn:', t.slice(0, 300));
  });
  page.on('pageerror', (e) => { problems.push(e.message); log('page error:', e.message); });
  page.setDefaultTimeout(900000);
  const loadMini = async () => {
    await page.route(/\/cloudlab\.html/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: MINI_HTML }));
    await page.goto(`${BASE}cloudlab.html?${EXTRA}`);
    await page.waitForFunction(() => window.__miniReady, null, { timeout: 300000 });
  };
  if (MINI) {
    await loadMini();
  } else {
    log(`loading ${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${EXTRA ? '&' + EXTRA : ''}`);
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0${EXTRA ? '&' + EXTRA : ''}`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 900000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    await page.evaluate(PAGE_HELPERS);
    await page.evaluate(() => { const C = window.__sim.app.clouds; if (C) { C.budgetMs = null; C.setQuality(C.quality); } });
  }
  log('ready');

  let busy = Promise.resolve();
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      busy = busy.then(async () => {
        const t1 = Date.now();
        let out;
        try {
          const url = new URL(req.url, 'http://x');
          if (url.pathname === '/eval') {
            out = await page.evaluate(`(async () => { ${body} })()`);
          } else if (url.pathname === '/scene') {
            const s = JSON.parse(body || '{}');
            out = await page.evaluate((s) => window.__lab.scene(s), s);
            if (s.settle !== 0) out = await page.evaluate((ms) => window.__sim.settle(ms), s.settle ?? 2500);
          } else if (url.pathname === '/shot') {
            const s = JSON.parse(body || '{}');
            await page.evaluate(() => { const t = document.getElementById('toast'); if (t) { t.classList.remove('show'); t.style.transition = 'none'; t.style.opacity = '0'; } });
            const n = s.frames ?? 8;
            const info = await page.evaluate((n) => { let r; for (let i = 0; i < n; i++) r = window.__sim.render(); return r; }, n);
            if (s.file) { mkdirSync(dirname(s.file), { recursive: true }); await page.screenshot({ path: s.file }); }
            out = { info, exposure: await page.evaluate(() => window.__sim.app.env.exposure), gpu: await page.evaluate(() => window.__sim.app.post?.gpuTimes) };
          } else if (url.pathname === '/view' && MINI) {
            const v = JSON.parse(body || '{}');
            const st = await page.evaluate((v) => window.__mini.view(v), v);
            const fr = await page.evaluate((n) => window.__mini.frame(n), v.frames ?? 6);
            if (v.file) { mkdirSync(dirname(v.file), { recursive: true }); await page.screenshot({ path: v.file }); }
            out = { ...st, ...fr };
          } else if (url.pathname === '/reload' && MINI) {
            await page.reload();
            await page.waitForFunction(() => window.__miniReady, null, { timeout: 300000 });
            out = 'reloaded';
          } else if (url.pathname === '/reload') {
            out = await page.evaluate(() => window.__lab.reload());
          } else if (url.pathname === '/problems') {
            out = problems.splice(0);
          } else if (url.pathname === '/quit') {
            res.end('bye\n');
            await browser.close();
            server.kill();
            process.exit(0);
          } else out = { error: 'unknown ' + url.pathname };
        } catch (e) {
          out = { error: String(e.message || e).slice(0, 2000) };
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ms: Date.now() - t1, out }, null, 1) + '\n');
      });
    });
  });
  http.listen(CTL, '127.0.0.1', () => log(`control on http://127.0.0.1:${CTL}/`));
}

main().catch((e) => { console.error('[lab]', e); server?.kill(); process.exit(1); });
