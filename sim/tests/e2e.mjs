// End-to-end test of the whole app with the real data and modules (Playwright + headless Chromium,
// SwiftShader WebGL2), driven through the automation API window.__sim (index.html?test=1).
//
//   node sim/tests/e2e.mjs [--root <sim folder>] [--port 8110] [--out <dir>] [--size 960x540]
//                          [--quality low|medium|high]
//
// The render loop stays paused: the simulation runs in fixed 1/120 s steps (much faster than real
// time) and a frame is drawn only for the checks and screenshots that need one.
//   1. Tel Nof runway 36 at noon: the jet stands on its gear (every wheel on the runway, tyres
//      pressed in by their modelled deflection, FDM struts and modelled oleos at their static
//      compression, the stance pitch, nose wheel on the centreline, no sinking or floating);
//      screenshots chase + cockpit; HMD numbers against the flight model; every camera mode.
//   2. Takeoff with the scripted pilot (js/test/TestPilot.js): MIL then afterburner, nose-wheel
//      steering on the centreline, rotation at ~150 kt, gear up after a positive climb, climb to
//      3,000 m and a turn toward Tel Aviv; screenshots of the roll in burner, the climb-out
//      (chase), the HMD in the cockpit and a fly-by; rig controls against the flight model.
//   3. telnof_final: 3 deg glide slope at ~145 kt, flare, touchdown below 3 m/s, brakes to a stop
//      on the runway; screenshots on short final (cockpit) and after the stop; canopy opens.
//   4. jerusalem_sunset: screenshots chase + cockpit at the spawn's sunset time.
// Fails on any console error, page error, failed request or failed check. Screenshots and
// report.json go to /home/claude/simdata/shots/e2e/ (or --out).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const PORT = +arg('port', 8110);
const OUT = resolve(arg('out', '/home/claude/simdata/shots/e2e'));
const [W, H] = arg('size', '960x540').split('x').map(Number);
const QUALITY = arg('quality', 'medium');
const BASE = `http://127.0.0.1:${PORT}/`;
const KT = 0.514444, FT = 0.3048, DEG = Math.PI / 180;
const TEL_AVIV = { x: -23130, z: -31074 };      // the tlv_3000 spawn, over the city

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}
const f2 = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

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
        if (!out.includes(`:${PORT}/`)) { proc.kill(); throw new Error(`serve.py did not take port ${PORT} (another server?):\n${out}`); }
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const problems = [];
  const shots = [];
  const frames = [];
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText || ''}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
    page.setDefaultTimeout(240000);
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 300000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    log('loaded; spawns:', (await page.evaluate(() => window.__sim.spawns())).join(', '));

    const S = (fn, a) => page.evaluate(fn, a);
    const step = (n) => S((k) => window.__sim.step(k), n);
    async function shot(name, settleMs = 2500) {
      const s = await S((ms) => window.__sim.settle(ms), settleMs);
      const info = await S(() => window.__sim.renderInfo());
      const file = join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
      frames.push({ name, camera: s.camera, calls: info.calls, triangles: info.triangles, ms: (await S(() => window.__sim.timing())).lastRenderMs });
      log(`shot ${name}.png (${s.camera}, ${info.calls} draw calls, ${(info.triangles / 1e6).toFixed(2)} M triangles)`);
      return s;
    }
    /** HMD numbers against the flight model state (both read after the same drawn frame). */
    async function hmdCheck(where) {
      const { h, st } = await S(() => ({ h: window.__sim.hmd(), st: window.__sim.fdm() }));
      const hdg = ((st.heading / DEG) % 360 + 360) % 360;
      // the HMD shows magnetic heading; hdgGrid is the flight model's (map grid) heading it starts from
      const dh = Math.abs((((h.hdgGrid ?? h.hdg) - hdg + 540) % 360) - 180);
      check(`${where}: HMD airspeed = flight model IAS`, Math.abs(h.iasKt - st.ias / KT) < 0.5, `${f2(h.iasKt, 1)} kt vs ${f2(st.ias / KT, 1)} kt`);
      check(`${where}: HMD altitude = flight model altitude (ft)`, Math.abs(h.altFt - st.altitude / FT) < 1, `${f2(h.altFt, 0)} ft vs ${f2(st.altitude, 1)} m`);
      check(`${where}: HMD heading = flight model heading`, dh < 0.1, `${f2(h.hdgGrid ?? h.hdg, 1)} vs ${f2(hdg, 1)} deg`);
      if (h.magVar != null) {
        const dm = Math.abs((((h.hdg - (h.hdgGrid + h.conv - h.magVar)) + 540) % 360) - 180);
        check(`${where}: HMD magnetic heading = grid + convergence - variation (about 5 deg E)`, dm < 0.01 && h.magVar > 4.5 && h.magVar < 5.5,
          `${f2(h.hdg, 1)} M, ${f2(h.hdgTrue, 1)} T, variation ${f2(h.magVar, 2)} E, convergence ${f2(h.conv, 2)}`);
      }
      check(`${where}: HMD g = flight model load factor`, Math.abs(h.g - st.gLoad) < 0.01, `${f2(h.g)} vs ${f2(st.gLoad)}`);
      check(`${where}: HMD vertical speed and Mach`, Math.abs(h.vsFpm - st.vs / FT * 60) < 1 && Math.abs(h.mach - st.mach) < 1e-3,
        `VS ${f2(h.vsFpm, 0)} fpm, M ${f2(h.mach, 3)}`);
    }
    /** Every rig control the app hands to the AircraftVisual is what the model shows. */
    async function rigCheck(where) {
      const v = await S(() => window.__sim.visual());
      const st = await S(() => window.__sim.fdm());
      const keys = Object.keys(v.rig).filter((k) => Number.isFinite(v.given[k]));
      const bad = keys.filter((k) => Math.abs(v.rig[k] - v.given[k]) > 1e-6);
      check(`${where}: model controls = flight model controls`, keys.length > 8 && bad.length === 0,
        `${keys.length} controls (${keys.slice(0, 8).join(', ')}...)${bad.length ? `, differ: ${bad.join(', ')}` : ''}`);
      check(`${where}: model gear / canopy / burner follow the flight model`,
        Math.abs(v.rig.gear - st.gear) < 1e-6 && Math.abs(v.rig.canopy - st.controls.canopy) < 1e-6
        && Math.abs((v.plume?.ab ?? 0) - st.engine.ab) < 1e-3 && v.plume.visible === st.engine.ab > 0.005,
        `gear ${f2(v.rig.gear, 3)}/${f2(st.gear, 3)}, canopy ${f2(v.rig.canopy, 3)}, ab ${f2(v.plume?.ab, 3)}/${f2(st.engine.ab, 3)}`);
      return v;
    }
    /** Camera placement in every mode. */
    async function cameraCheck(where) {
      const r = await S(async () => {
        const sim = window.__sim, app = sim.app;
        const out = {};
        for (const m of ['cockpit', 'chase', 'orbit', 'flyby', 'tower']) {
          sim.camera(m);
          sim.step(24);
          const c = app.camera.position, p = app.drawPos;
          const fwd = c.clone().set(0, 0, -1).applyQuaternion(app.camera.quaternion);
          const toJet = p.clone().sub(c);
          const d = toJet.length();
          const jetFwd = c.clone().set(0, 0, -1).applyQuaternion(app.drawQuat);
          out[m] = {
            dist: d, eyeDist: c.distanceTo(app.visual.eyeWorld()), look: d > 1 ? fwd.dot(toJet.normalize()) : null,
            behind: -jetFwd.dot(c.clone().sub(p)), agl: c.y - app.terrain.heightAt(c.x, c.z), head: app.visual.head?.visible,
          };
        }
        sim.camera('chase');
        sim.step(12);
        return out;
      });
      check(`${where}: cockpit camera at the pilot's eye, head hidden`, r.cockpit.eyeDist < 0.15 && r.cockpit.head === false, `${f2(r.cockpit.eyeDist, 3)} m from the eye`);
      check(`${where}: chase camera behind the jet, looking at it`, r.chase.behind > 8 && r.chase.dist < 80 && r.chase.look > 0.95, `${f2(r.chase.dist, 1)} m, ${f2(r.chase.behind, 1)} m behind`);
      check(`${where}: orbit camera around the jet`, r.orbit.dist > 10 && r.orbit.dist < 200 && r.orbit.look > 0.95, `${f2(r.orbit.dist, 1)} m`);
      check(`${where}: fly-by camera beside the path, looking at the jet`, r.flyby.dist > 20 && r.flyby.dist < 3000 && r.flyby.look > 0.9 && r.flyby.agl > 0.5, `${f2(r.flyby.dist, 0)} m, ${f2(r.flyby.agl, 1)} m above ground`);
      check(`${where}: tower camera above ground, looking at the jet`, r.tower.agl > 2 && r.tower.look > 0.9, `${f2(r.tower.dist, 0)} m away, ${f2(r.tower.agl, 1)} m up`);
    }

    // =============================================================== 1. on the runway at noon
    log('--- Tel Nof 36, noon: the jet on its gear');
    await S(() => window.__sim.start('telnof_36', { time: 12, camera: 'chase' }));
    await step(240);
    const g0 = await S(() => window.__sim.gear());
    const y0 = (await S(() => window.__sim.fdm())).position[1];
    await step(240);
    const st0 = await S(() => window.__sim.fdm());
    const g1 = await S(() => window.__sim.gear());
    const rw0 = await S(() => window.__sim.runway());
    for (const w of g1) {
      check(`gear ${w.name}: weight on wheels`, w.wow);
      check(`gear ${w.name}: flight-model strut at its static compression`, Math.abs(w.fdmCompression - w.fdmStatic) < 0.15 * w.fdmStatic, `${f2(w.fdmCompression, 4)} m (static ${w.fdmStatic})`);
      check(`gear ${w.name}: modelled oleo at its parked compression`, Math.abs(w.oleo - w.rigStatic) < 0.005 && Math.abs(w.rigValue) < 0.005, `${f2(w.oleo, 4)} m (parked ${w.rigStatic}), rig value ${f2(w.rigValue, 4)}`);
      check(`gear ${w.name}: tyre on the runway (pressed in by its deflection, no sinking / floating)`,
        Math.abs(w.gap + w.tyreDeflection) < 0.015, `tyre bottom ${f2(w.gap * 100, 1)} cm vs the ground (deflection ${w.tyreDeflection * 100} cm)`);
    }
    const nose = g1.find((w) => w.name === 'nose');
    const mains = g1.filter((w) => w.name !== 'nose');
    check('nose wheel on the runway centreline', Math.abs(nose.cross) < 0.3, `${f2(nose.cross, 3)} m`);
    check('main wheels either side of the centreline', Math.abs(mains[0].cross + mains[1].cross) < 0.3, mains.map((w) => f2(w.cross, 2)).join(' / ') + ' m');
    check('jet lined up with the runway', Math.abs(rw0.cross) < 0.3 && Math.abs(rw0.headingError_deg) < 0.3 && rw0.onRunway, `cross ${rw0.cross} m, heading error ${rw0.headingError_deg} deg`);
    const dist = Math.hypot(nose.tyreBottom[0] - (mains[0].tyreBottom[0] + mains[1].tyreBottom[0]) / 2, nose.tyreBottom[2] - (mains[0].tyreBottom[2] + mains[1].tyreBottom[2]) / 2);
    const slope = Math.atan2(nose.ground - (mains[0].ground + mains[1].ground) / 2, dist) / DEG;
    check('stance pitch 1.45 deg (+ runway slope)', Math.abs(st0.pitch / DEG - (1.45 + slope)) < 0.15, `${f2(st0.pitch / DEG)} deg (slope ${f2(slope, 3)} deg)`);
    check('standing still on the gear (no sinking)', Math.abs(st0.position[1] - y0) < 0.002 && g0.every((w, i) => Math.abs(w.gap - g1[i].gap) < 0.002), `${f2((st0.position[1] - y0) * 1000, 2)} mm in 2 s`);
    await shot('01_telnof36_noon_chase', 3500);
    await hmdCheck('runway');
    await rigCheck('runway');
    await S(() => window.__sim.camera('cockpit'));
    await shot('02_telnof36_noon_cockpit', 1500);
    await cameraCheck('runway');

    // =============================================================== 2. takeoff, climb, turn
    log('--- takeoff: MIL, afterburner, rotate, gear up, climb to 3,000 m toward Tel Aviv');
    await S(() => window.__sim.camera('chase'));
    await S((tlv) => window.__sim.autopilot('takeoff', { altitude: 3000, target: tlv, vrKt: 150 }), TEL_AVIV);
    let maxCross = 0, maxNoseCross = 0, abSeen = false, rollShot = false, plumeOk = true;
    for (let i = 0; i < 120; i++) {
      const s = await step(30);
      const r = await S(() => ({ rw: window.__sim.runway(), nose: window.__sim.gear()[0], v: window.__sim.visual(), ab: window.__sim.fdm().engine.ab }));
      if (s.onGround) { maxCross = Math.max(maxCross, Math.abs(r.rw.cross)); maxNoseCross = Math.max(maxNoseCross, Math.abs(r.nose.cross)); }
      if (r.ab > 0.9) abSeen = true;
      if (r.v.plume.visible !== (r.ab > 0.005)) plumeOk = false;
      if (!rollShot && r.ab > 0.95 && s.ias_kt > 60) { rollShot = true; await shot('03_takeoff_roll_afterburner_chase', 2000); }
      if (s.phase !== 'roll' || s.crashed) break;
    }
    let p = await S(() => window.__sim.pilot());
    const ev = (name) => p.events.find((e) => e.phase === name);
    check('MIL first, then afterburner on the roll', ev('afterburner') && ev('afterburner').t >= 2.9 && abSeen, ev('afterburner') ? `burner at ${ev('afterburner').t} s, ${ev('afterburner').ias_kt} kt` : 'no burner');
    check('burner plume shown exactly while the engine burns', plumeOk);
    check('nose-wheel steering held the centreline', maxCross < 2 && maxNoseCross < 2, `max ${f2(maxCross)} m (nose wheel ${f2(maxNoseCross)} m)`);
    check('rotation at ~150 kt', ev('rotate') && Math.abs(ev('rotate').ias_kt - 150) < 5, ev('rotate') ? `${ev('rotate').ias_kt} kt after ${ev('rotate').t} s` : 'no rotation');
    let fl = await S(() => window.__sim.fly({ until: 'climb', seconds: 60 }));
    p = fl.pilot;
    check('lift-off', !!ev('liftoff'), ev('liftoff') ? `${ev('liftoff').ias_kt} kt, pitch ${ev('liftoff').pitch_deg} deg` : '');
    check('gear up only after a positive climb', ev('gear up') && ev('gear up').vs > 1 && ev('gear up').agl_m > 5, ev('gear up') ? `vs ${ev('gear up').vs} m/s at ${ev('gear up').agl_m} m` : '');
    check('gear retracted (flight model and model)', fl.summary.gear < 0.01 && (await S(() => window.__sim.visual())).rig.gear < 0.01, `gear ${fl.summary.gear}`);
    await step(360);
    await shot('04_climbout_chase', 2500);
    await rigCheck('climb-out');
    fl = await S(() => window.__sim.fly({ until: 'cruise', seconds: 240 }));
    await step(1200);
    const sc = await S(() => window.__sim.summary());
    const pos = (await S(() => window.__sim.fdm())).position;
    const brg = (Math.atan2(TEL_AVIV.x - pos[0], -(TEL_AVIV.z - pos[2])) / DEG + 360) % 360;
    const dBrg = Math.abs(((sc.heading_deg - brg + 540) % 360) - 180);
    check('climbed to ~3,000 m and levelled off', !sc.crashed && Math.abs(sc.alt_m - 3000) < 150 && Math.abs(sc.vs) < 4, `${sc.alt_m} m, vs ${sc.vs} m/s, ${sc.ias_kt} kt`);
    check('turned toward Tel Aviv', dBrg < 10, `heading ${sc.heading_deg} deg, bearing to Tel Aviv ${f2(brg, 1)} deg`);
    await S(() => window.__sim.camera('cockpit'));
    await shot('05_cruise_cockpit_hmd', 2000);
    await hmdCheck('cruise');
    await cameraCheck('cruise');
    await S(() => window.__sim.camera('flyby'));
    await step(340);                                 // the camera stands 3.2 s ahead: the jet about to pass
    await shot('06_flyby', 2000);

    // =============================================================== 3. approach and landing
    log('--- telnof_final: glide slope, flare, touchdown, stop');
    await S(() => window.__sim.start('telnof_final', { time: 12, camera: 'chase' }));
    await S(() => window.__sim.autopilot('land', { approachKt: 145 }));
    let maxDev = 0, maxLoc = 0, minKt = 1e9, maxKt = 0, finalShot = false;
    for (let i = 0; i < 400; i++) {
      const s = await step(60);
      const r = await S(() => ({ rw: window.__sim.runway(), y: window.__sim.fdm().position[1] }));
      if (r.rw.along > -9000 && s.phase === 'approach') {
        const gs = r.rw.threshold[1] + 2 + Math.tan(3 * DEG) * (300 - r.rw.along);
        maxDev = Math.max(maxDev, Math.abs(r.y - gs));
        maxLoc = Math.max(maxLoc, Math.abs(r.rw.cross));
        minKt = Math.min(minKt, s.ias_kt); maxKt = Math.max(maxKt, s.ias_kt);
      }
      if (!finalShot && r.rw.along > -1500) {
        finalShot = true;
        await S(() => window.__sim.camera('cockpit'));
        await shot('07_short_final_cockpit', 2000);
        await S(() => window.__sim.camera('chase'));
      }
      if (s.phase !== 'approach' || s.crashed) break;
    }
    check('on the 3 deg glide slope', maxDev < 12, `max deviation ${f2(maxDev, 1)} m`);
    check('on the localizer', maxLoc < 10, `max ${f2(maxLoc, 1)} m off the centreline`);
    check('approach speed ~145 kt', minKt > 135 && maxKt < 155, `${f2(minKt, 1)}-${f2(maxKt, 1)} kt`);
    fl = await S(() => window.__sim.fly({ until: 'stopped', seconds: 120 }));
    const stL = await S(() => window.__sim.fdm());
    const rwL = await S(() => window.__sim.runway());
    const td = stL.lastTouchdown || {};
    check('landed without crashing', !stL.crashed, stL.crashReason || '');
    check('touchdown sink rate below 3 m/s', td.sink != null && td.sink < 3, `${f2(td.sink)} m/s at ${f2((td.ias || 0) / KT, 0)} kt, pitch ${f2((td.pitch || 0) / DEG, 1)} deg`);
    check('stopped on the runway', fl.pilot.phase === 'stopped' && rwL.onRunway && Math.abs(rwL.cross) < 5, `${f2(rwL.along, 0)} m past the threshold of ${rwL.length} m, ${f2(rwL.cross, 2)} m off the centreline`);
    await shot('08_landed_chase', 2500);
    await S(() => { window.__sim.autopilot(null); window.__sim.setInput({ brake: 1, parkingBrake: true, throttle: 0, canopy: true }); });
    await step(720);
    const vC = await rigCheck('canopy open');
    check('canopy opens on the ground', vC.rig.canopy > 0.95, `canopy ${f2(vC.rig.canopy, 3)}`);

    // =============================================================== 4. Jerusalem at sunset
    log('--- jerusalem_sunset');
    const sj = await S(() => window.__sim.start('jerusalem_sunset', { camera: 'chase' }));
    await step(120);
    check('sunset spawn at its time of day', Math.abs(sj.time - 18.75) < 0.01, `${sj.time} h`);
    await shot('09_jerusalem_sunset_chase', 3500);
    await S(() => window.__sim.camera('cockpit'));
    await shot('10_jerusalem_sunset_cockpit', 1500);
    const s4 = await S(() => window.__sim.summary());
    check('sunset flight trimmed (hands off for 1 s)', !s4.crashed && Math.abs(s4.vs) < 3, `${s4.ias_kt} kt, vs ${s4.vs} m/s`);

    const timing = await S(() => window.__sim.timing());
    const mem = await S(() => window.__sim.gpuMemory());
    log(`timing: ${timing.steps} steps at ${timing.stepMsAvg} ms, ${timing.renders} frames at ${timing.renderMsAvg} ms (${timing.gpu})`);
    log(`GPU memory estimate ${mem.totalMB} MB (textures ${mem.texturesMB}, geometry ${mem.geometryMB})`);
    check('no console errors, page errors or failed requests', problems.length === 0, problems.slice(0, 5).join(' | '));
    writeFileSync(join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), size: [W, H], quality: QUALITY, checks, frames, timing, gpuMemory: mem, problems, shots }, null, 1));
  } finally {
    await browser.close();
    server.kill();
  }
  const failed = checks.filter((c) => !c.ok);
  log(`${checks.length - failed.length} / ${checks.length} checks passed; ${shots.length} screenshots in ${OUT}`);
  if (failed.length) for (const c of failed) log('FAILED:', c.name, c.detail);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('[e2e]', e); process.exit(1); });
