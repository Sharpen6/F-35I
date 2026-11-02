// End-to-end test of the whole app with the real data and modules (Playwright + headless Chromium,
// SwiftShader WebGL2), driven through the automation API window.__sim (index.html?test=1).
//
//   node sim/tests/e2e.mjs [--root <sim folder>] [--port 8110] [--out <dir>] [--size 960x540]
//                          [--quality low|medium|high]
//
// The render loop stays paused: the simulation runs in fixed 1/120 s steps (much faster than real
// time) and a frame is drawn only for the checks and screenshots that need one.
//   0. start-up (js/env/warmup.js): the shader warm-up ran behind the loading screen, and no
//      shader program is made when the menu draws, in the first 5 s of a flight started from it,
//      nor on the first switch to each camera (a new program is a stall of 0.1-0.8 s on the PC).
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
//   5. buildings: the Azrieli towers from a free camera (the jet hidden) once the tiles have
//      streamed: no speckle on the facades (Buildings.speckleCheck), ground shadows by day,
//      obstruction lights at night, no cross-fade left running; the gain of artificial lights
//      (env.lightGain: 1 by day, 1400 / exposure at night); screenshots day and night; the red
//      lights in the night frame stay red (CIE x of what they add over their background).
//   6. lights at night, read off the drawn frame (tests/night_probe.mjs): the PAPI of Ben Gurion 26
//      from the 3 deg path (two red, two white), the landing light's pool on short final and in
//      the flare (x1.5 at least), the burner
//      with night vision on (an orange body, yellow-white diamonds, a red-orange tail; not pink),
//      the tail light in the blue hour (a point as at night, not a ball).
// Fails on any console error, page error, failed request or failed check. Screenshots and
// report.json go to /home/claude/simdata/shots/e2e/ (or --out).

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
    const ckWarnings = [];   // (pcd/parts.js warns when a cockpit part is not rebuilt; Cockpit.js when the interior fails)
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      else if (m.type() === 'warning' && /^Cockpit: /.test(m.text())) ckWarnings.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText || ''}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
    page.setDefaultTimeout(240000);
    await page.goto(`${BASE}index.html?test=1&quality=${QUALITY}&wingmen=0`);
    await page.waitForFunction(() => window.__sim && (window.__sim.ready || window.__sim.error), null, { timeout: 300000 });
    const err = await page.evaluate(() => window.__sim.error);
    if (err) throw new Error(`app did not load: ${err}`);
    log('loaded; spawns:', (await page.evaluate(() => window.__sim.spawns())).join(', '));
    await page.evaluate(NIGHT_PROBE);                // window.__np: the lights in the drawn frame

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

    // =============================================================== 0. start-up: the shader programs
    // (js/env/warmup.js) every program is built behind the loading screen: one made later is a
    // stop of 0.1-0.8 s on the PC (ANGLE / Direct3D 11), here it shows as a new program id
    log('--- start-up: no shader program made after the loading screen');
    const progMark = () => S(() => { let id = -1; for (const p of window.__sim.app.renderer.info.programs) id = Math.max(id, p.id); return id + 1; });
    const progSince = (m) => S((k) => window.__sim.app.renderer.info.programs.filter((p) => p.id >= k).map((p) => p.name || p.type || '?'), m);
    const wu = await S(() => window.__sim.app.warmup?.info?.() || null);
    check('start-up: shader warm-up done behind the loading screen', wu && wu.enabled && wu.done,
      wu ? `${wu.programs} programs, ${f2(wu.ms / 1000, 1)} s compiling + ${f2(wu.framesMs / 1000, 1)} s of first frames${wu.frameMade.length ? `; made by the frames: ${wu.frameMade.join(', ')}` : ''}` : 'no warm-up');
    let pm = await progMark();
    for (let i = 0; i < 2; i++) await S(() => window.__sim.render());
    const menuMade = await progSince(pm);
    check('start-up: the menu draws with no new shader program', menuMade.length === 0, menuMade.join(', '));
    pm = await progMark();
    await S(() => window.__sim.start('telnof_36', { time: 12, camera: 'cockpit' }));
    for (let i = 0; i < 10; i++) await S(() => window.__sim.advance(0.5));      // 5 s, a frame every 0.5 s
    const flightMade = await progSince(pm);
    check('start-up: no shader program made in the first 5 s of a flight from the menu', flightMade.length === 0, flightMade.join(', '));
    for (const m of ['chase', 'tower', 'flyby', 'orbit', 'cockpit']) {
      pm = await progMark();
      await S((c) => window.__sim.camera(c), m);
      for (let i = 0; i < 2; i++) await S(() => window.__sim.advance(0.25));
      const made = await progSince(pm);
      check(`start-up: first switch to the ${m} camera makes no shader program`, made.length === 0, made.join(', '));
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
        // flight track: on speed the flight path marker flies free, above the coaming
        const hF = await S(() => window.__sim.hmd());
        check('short final: the flight path marker is free, above the coaming', !hF.fpmLimited && hF.fpmY < hF.coamingY,
          `AoA ${f2(hF.alphaDeg, 1)} deg, marker y ${f2(hF.fpmY, 0)} px, coaming ${f2(hF.coamingY, 0)} px`);
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

    // ---- the cockpit (js/aircraft/Cockpit.js): the interior analysis, the live display redrawn only
    //      where it can be seen, the cockpit's own sun shadow, the stick and throttle moving the way
    //      the pilot's inputs go
    const hasCockpit = await S(() => !!(window.__sim.app.cockpit && window.__sim.app.cockpit.enabled));
    if (hasCockpit) {
      const ckState = () => S(() => {
        const c = window.__sim.app.cockpit;
        return { stats: c.interiorStats || null, redraws: c.pcd.redraws, shadow: c.shadow ? c.shadow.uniforms.uCkShadowOn.value : 0, tips: c.leverTips() };
      });
      await S(() => window.__sim.camera('chase'));
      await step(24);
      await S(() => window.__sim.render());
      const cOut = await ckState();
      await step(24);
      await S(() => window.__sim.render());
      const cOut2 = await ckState();
      check('cockpit display not redrawn from outside (too small to read)', cOut2.redraws === cOut.redraws, `${cOut.redraws} -> ${cOut2.redraws}`);
      await S(() => window.__sim.camera('cockpit'));
      await step(24);
      await S(() => window.__sim.render());
      const cIn = await ckState();
      const st = cIn.stats;
      check('cockpit interior analysed: inner skin faces repainted, no gap', !!st && !st.leak && st.interiorTris > 3000, st ? `${st.interiorTris} faces, ${st.edgeTris} along the paint's edge, leak ${st.leak}` : 'no analysis');
      // the rebuilt parts (js/aircraft/pcd/parts.js): every one built, in its own task, nothing left out
      const pk = await S(async () => {
        const c = window.__sim.app.cockpit, m = await import('./js/aircraft/pcd/parts.js');
        const p = c.parts, st = p.stats || {};
        return { steps: m.STEPS, expected: m.EXPECTED_DRAWS, off: !!st.off, bad: m.STEPS.filter((k) => !st[k] || st[k].err).map((k) => `${k}: ${st[k] ? st[k].err : 'not built'}`),
          added: p.added.length, ms: st.ms, maxTaskMs: st.maxTaskMs };
      });
      check('cockpit parts rebuilt: every part, the expected draws, no warning',
        !pk.off && pk.bad.length === 0 && pk.added === pk.expected && ckWarnings.length === 0,
        `${pk.added}/${pk.expected} draws, ${pk.steps.length} parts in ${f2(pk.ms, 0)} ms (longest task ${f2(pk.maxTaskMs, 0)} ms)${pk.bad.length ? `; ${pk.bad.join(', ')}` : ''}${ckWarnings.length ? `; ${ckWarnings.slice(0, 3).join(' | ')}` : ''}`);
      check('cockpit display redrawn in the cockpit view', cIn.redraws > cOut2.redraws, `${cOut2.redraws} -> ${cIn.redraws}`);
      check('cockpit sun shadow on in the cockpit view', cIn.shadow === 1);
      const tip = async (input) => { await S((o) => window.__sim.setInput(o), input); await step(30); return (await ckState()).tips; };
      const t0 = await tip({ pitch: 0, roll: 0, throttle: 0 });
      const tP = await tip({ pitch: 1 });
      const tR = await tip({ pitch: 0, roll: 1 });
      const tT = await tip({ roll: 0, throttle: 0.75 });
      await tip({ throttle: 0 });
      const dd = (a, b) => b.map((v, i) => +((v - a[i]) * 100).toFixed(1));   // cm, glTF frame: +X left, +Z forward
      const dP = dd(t0.stick, tP.stick), dR = dd(t0.stick, tR.stick), dT = dd(t0.throttle, tT.throttle);
      check('side-stick: a pull moves it aft', dP[2] < -2 && Math.abs(dP[0]) < 1, `${dP} cm`);
      check('side-stick: roll right moves it to the right', dR[0] < -2 && Math.abs(dR[2]) < 1, `${dR} cm`);
      check('throttle: MIL moves it forward', dT[2] > 4 && Math.abs(dT[0]) < 1, `${dT} cm`);
    }
    // flight track: pulled to 22 deg AoA the flight path marker would sit on the cockpit displays;
    // it must be held above the coaming (crossed out)
    await S(() => { window.__sim.start('telnof_final', { time: 12, camera: 'cockpit' }); window.__sim.setInput({ throttle: 0.75, pitch: 0.9 }); });
    for (let i = 0; i < 80 && (await S(() => window.__sim.fdm().alpha)) < 22 * DEG; i++) await step(6);
    await shot('08b_aoa22_cockpit', 1200);
    const hA = await S(() => window.__sim.hmd());
    check('22 deg AoA: the flight path marker is held above the coaming', hA.alphaDeg > 21.5 && hA.fpmLimited && hA.fpmY < hA.coamingY - 5,
      `AoA ${f2(hA.alphaDeg, 1)} deg, marker y ${f2(hA.fpmY, 0)} px, coaming ${f2(hA.coamingY, 0)} px`);
    await S(() => window.__sim.clearInput());

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

    // =============================================================== 5. Buildings over Tel Aviv
    log('--- buildings over Tel Aviv');
    const bstats = () => S(() => window.__sim.app.modules?.find((m) => m.name === 'Buildings')?.stats || null);
    /** A free camera (lon, lat, metres above sea level) with the jet hidden, then the tiles stream. */
    async function viewFrom(cam, time) {
      await S(async ({ cam, time }) => {
        const sim = window.__sim, app = sim.app;
        const { lonLatToXZ } = await import('/js/world/coords.js');
        const p = lonLatToXZ(cam.pos[0], cam.pos[1] - 0.03);
        app.terrain.spawns._e2e = {
          label: 'e2e', x: p.x, z: p.z, y: Math.max(cam.pos[2], 400) + 600, ground_y: app.terrain.heightAt(p.x, p.z),
          heading_deg: 0, on_ground: false, speed_ms: 160, gear: 0,
        };
        sim.start('_e2e', { time, camera: 'chase' });
        sim.time(time);
        sim.step(60);
        const a = lonLatToXZ(cam.pos[0], cam.pos[1]), b = lonLatToXZ(cam.look[0], cam.look[1]);
        const c = app.camera;
        app._e2eCamUpdate = app._e2eCamUpdate || app.cams.update.bind(app.cams);
        app.cams.update = () => {
          c.position.set(a.x, cam.pos[2], a.z);
          c.up.set(0, 1, 0);
          c.lookAt(b.x, cam.look[2], b.z);
          c.fov = cam.fov;
          c.updateProjectionMatrix();
          c.updateMatrixWorld(true);
        };
        app.visual.object3d.visible = false;
      }, { cam, time });
      let st = null;
      for (let quiet = 0, i = 0; quiet < 2 && i < 80; i++) {
        await S(() => window.__sim.settle(1500));
        st = await bstats();
        quiet = st && st.loading === 0 && st.tiles > 0 && !st.fading ? quiet + 1 : 0;
      }
      return st;
    }
    const AZRIELI = { pos: [34.7870, 32.0715, 150], look: [34.79159, 32.07462, 110], fov: 40 };
    const bd = await viewFrom(AZRIELI, 10);
    check('buildings streamed around the Azrieli towers', bd && bd.tiles > 0 && bd.chunks > 0 && bd.loading === 0,
      bd ? `${bd.tiles} tiles, ${bd.boxes} boxes, ${bd.chunks} full-detail chunks` : 'no Buildings module');
    check('no chunk left cross-fading', bd && bd.fading === 0, `${bd?.fading} fading`);
    check('ground shadows of the buildings by day', bd && bd.shadows > 0, `${bd?.shadows} decals`);
    // the round tower's glass and its neighbours' facades fill most of this view: style ids
    // compared bit-exact after interpolation salted them with pixels of another style (that
    // shader: ~52,000 per million here; rounded ids: ~1,600, window corners and edges)
    const sp = await S(() => window.__sim.app.modules.find((m) => m.name === 'Buildings').speckleCheck());
    check('no speckle on the facades', sp && sp.perMillion < 10000, sp ? `${sp.speckles} speckle pixels of ${sp.pixels} (${sp.perMillion} per million)` : 'no result');
    await shot('11_tlv_azrieli_buildings', 800);
    // lights at night (js/env/README.md "Lights at night"): one gain for every artificial light,
    // 1 by day, at night that of an eye adapted to lit streets (gain x exposure = 1400)
    const lightLevels = () => S(() => { const e = window.__sim.app.env; return { gain: e.lightGain, night: e.lightNight, exposure: e.exposure }; });
    const lgDay = await lightLevels();
    await S(() => window.__sim.time(21.5));
    await S(() => window.__sim.settle(1500));
    const lgNight = await lightLevels();
    check('lights at night: physical by day, the street-adapted eye at night (gain x exposure = 1400)',
      lgDay.gain === 1 && lgNight.night === 1 && Math.abs(lgNight.gain * lgNight.exposure - 1400) < 1,
      `day gain ${f2(lgDay.gain, 3)}; night gain ${f2(lgNight.gain, 3)} x exposure ${f2(lgNight.exposure, 1)}`);
    const bn = await bstats();
    check('obstruction lights on the towers at night, no ground shadows', bn && bn.lights > 0 && bn.shadows === 0,
      `${bn?.lights} lights, ${bn?.shadows} shadow decals`);
    await shot('12_tlv_azrieli_night', 800);
    // the red lights in that frame (the towers' obstruction lights, the cars' tail lights) keep their
    // hue: AgX alone turned them white or salmon (CIE x ~0.42 as drawn, ~0.48 what they add over
    // their background; red's primary is 0.64). Judged by what a light adds over its background: a
    // far one is a pixel on the lit facade it sits on, which pales the pixel whatever the light's colour
    const redsTlv = await S(() => window.__np.reds());
    check('red lights at night stay red (their own light: median CIE x >= 0.55)', redsTlv.n >= 3 && redsTlv.lightX >= 0.55,
      `${redsTlv.n} red lights: their own light CIE x ${redsTlv.lightX} (quartiles ${redsTlv.lightP25}-${redsTlv.lightP75}); `
        + `as drawn ${redsTlv.medianX} (${redsTlv.p25}-${redsTlv.p75})`);
    await S(() => {
      const app = window.__sim.app;
      app.cams.update = app._e2eCamUpdate;
      app.visual.object3d.visible = true;
    });

    // =============================================================== 6. lights at night: the pixels
    // (js/env/README.md "Lights at night"; tests/night_probe.mjs reads the drawn frame)
    log('--- lights at night');
    // the PAPI of Ben Gurion 26 from the 3 deg path, 1.5 km out (a 12 deg field of view): the two
    // units set above 3 deg red, the two below white
    await S(() => window.__sim.start('bengurion_26', { time: 21.5, camera: 'chase' }));
    await step(60);
    const pc = await S(() => window.__np.papiCam([-12912, -24024], 259.8, 1500, 12));
    for (let i = 0; i < 3; i++) await S(() => window.__sim.settle(1500));
    await shot('13_bgn26_papi_night', 1500);
    const papi = pc ? await S(() => window.__np.papi()) : [];
    const pRed = papi.filter((u) => u.ang > 3), pWhite = papi.filter((u) => u.ang < 3);
    check('PAPI on the slope at night: two red (r >= 3 g), two white (r ~ g)',
      pRed.length === 2 && pWhite.length === 2 && pRed.every((u) => u.rgb && u.rgb[0] >= 200 && u.rgb[0] >= 3 * u.rgb[1])
        && pWhite.every((u) => u.rgb && u.rgb[1] >= 200 && u.rg <= 1.15),
      papi.map((u) => `${u.ang} deg (${u.seen} seen): ${u.rgb} r/g ${u.rg}`).join('; ') || 'no PAPI');
    await S(() => window.__np.restore());
    // the landing light's pool on the runway on short final (~65 m up: the beam meets the runway
    // ~370 m ahead, its ~0.5 lux tens of times the real moonlit ground's) and in the flare (~15 m)
    // (night, telnof_final flown down by the autopilot)
    await S(() => { window.__sim.start('telnof_final', { time: 21.5, camera: 'chase' }); window.__sim.autopilot('land', { approachKt: 145 }); });
    // flown down in the page, 0.1 s a step: the spawn is ~500 m up, ~2 min from short final
    const down = (agl) => S((h) => {
      const sim = window.__sim;
      let s = sim.summary();
      for (let t = 0; t < 150 && !(s.crashed || s.onGround || s.agl_m < h); t += 0.1) s = sim.step(12);
      return s;
    }, agl);
    const sFinal = await down(65);
    const poolFinal = sFinal.agl_m < 65 && !sFinal.onGround ? await S(() => window.__np.pool()) : null;
    const sF = await down(15);
    const poolText = (p, s) => (p ? `${f2(s.agl_m, 1)} m up: the ground ${p.lamp} m ahead of the lamp x${p.ratio} (${p.off} -> ${p.on}; `
      + `its light ${p.ground} lux as drawn, ${p.real} without the night's boosts)` : `${f2(s.agl_m, 1)} m up: beam does not reach the ground`);
    check('landing light: its pool lights the runway on short final (x1.5 at least)', poolFinal && poolFinal.ratio >= 1.5, poolText(poolFinal, sFinal));
    await shot('14_telnof_flare_night_chase', 1200);
    const pool = sF.agl_m < 15 && !sF.onGround ? await S(() => window.__np.pool()) : null;
    check('landing light: its pool lights the runway in the flare, brighter than on final', pool && pool.ratio >= 1.5
      && (!poolFinal || pool.ratio > poolFinal.ratio), poolText(pool, sF));
    // the burner at night with night vision on (the default): an orange flame, not pink
    await S(() => { window.__sim.start('telnof_36', { time: 21.5, camera: 'chase' }); window.__sim.autopilot('takeoff'); });
    for (let i = 0; i < 300; i++) { const s = await step(12); if (s.ab > 0.95 && s.ias_kt > 40) break; }
    await S(() => {
      const app = window.__sim.app, q = app.fdm.state.quaternion;
      // orbit 28 deg off the tail, 6 deg up, 18 m (the burner seen from behind and aside)
      const { x, y, z, w } = q, tx = 2 * y, ty = -2 * x, tz = 0;   // body +Z (aft) rotated: q * (0, 0, 1)
      const aft = [tx * w + (y * tz - z * ty), ty * w + (z * tx - x * tz), 1 + tz * w + (x * ty - y * tx)];
      app.cams.setMode('orbit');
      app.settings.camera = 'orbit';
      const O = app.cams.orbit;
      O.yaw = Math.atan2(aft[0], aft[2]) + 28 * Math.PI / 180; O.pitch = 6 * Math.PI / 180; O.dist = 18;
      O.init = true; O.auto = 0;
      app.cams.fov.orbit = 40;
    });
    await shot('15_telnof_burner_night', 1500);
    const nv = await S(() => window.__sim.app.env.nightVision);
    const ab = await S(() => window.__np.burner());
    check('burner at night (night vision on): orange (r > g > b, g / r 0.4-0.6)',
      ab && nv > 0.9 && ab.rgb[0] > ab.rgb[1] && ab.rgb[1] > ab.rgb[2] && ab.gr >= 0.4 && ab.gr <= 0.6,
      ab ? `body ${ab.rgb}, g/r ${ab.gr}, CIE xy ${ab.xy}; night vision ${f2(nv, 2)}` : 'no plume');
    // its shock diamonds yellow-white over the body (soft peach blobs were barely brighter than it),
    // its tail a deeper red-orange that still glows (not a dim brown)
    check('burner at night: yellow-white diamonds (r >= 225, g / r 0.15 over the body), a red-orange tail (r >= 150)',
      ab && ab.dia && ab.tail && ab.dia.rgb[0] >= 225 && ab.dia.gr >= ab.gr + 0.15
        && ab.tail.rgb[0] >= 150 && ab.tail.rgb[0] > ab.tail.rgb[1] && ab.tail.rgb[1] > ab.tail.rgb[2] && ab.tail.gr <= ab.gr,
      ab && ab.dia && ab.tail ? `diamonds ${ab.dia.rgb} g/r ${ab.dia.gr}; tail (${ab.tailAt} of the core) ${ab.tail.rgb} g/r ${ab.tail.gr}` : 'no plume');
    // the blue hour (sun 5 deg down): the tail light a point, as at night, not a ball
    await S(() => window.__sim.start('jerusalem_sunset', { time: 19.5, camera: 'chase' }));
    await step(120);
    await shot('16_jerusalem_1930_chase', 2500);
    const tail = await S(() => window.__np.tail());
    // as at night: a white core no wider than 6 px, the size of any point light at the cap (the ball it
    // grew into was 21 px, then a grown 8 px core) and a soft skirt: its steps between neighbours shrink
    // outwards (the ball's sprite cut it off, a drop of ~40 in luma after steps of ~20: a kink of ~15)
    check('blue hour: the tail light a point as at night (white core <= 6 px, a soft skirt)', tail && tail.core <= 6 && tail.kink <= 8,
      tail ? `white core ${tail.core} px, half width ${tail.width} px, kink in its skirt ${tail.kink} (steepest step under luma 100: ${tail.step})` : 'not found');

    const timing = await S(() => window.__sim.timing());
    const mem = await S(() => window.__sim.gpuMemory());
    log(`timing: ${timing.steps} steps at ${timing.stepMsAvg} ms, ${timing.renders} frames at ${timing.renderMsAvg} ms (${timing.gpu})`);
    log(`GPU memory estimate ${mem.totalMB} MB (textures ${mem.texturesMB}, geometry ${mem.geometryMB})`);
    // every program made after the loading screen in the whole run (for the record: the checks above fail on theirs)
    const warmup = await S(() => window.__sim.app.warmup?.info?.() || null);
    if (warmup) log(`shader programs made after the loading screen: ${warmup.late.length ? warmup.late.map((l) => `${l.label}: ${l.programs.join(', ')}`).join('; ') : 'none'}`);
    check('no console errors, page errors or failed requests', problems.length === 0, problems.slice(0, 5).join(' | '));
    writeFileSync(join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), size: [W, H], quality: QUALITY, checks, frames, timing, gpuMemory: mem, warmup, problems, shots }, null, 1));
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
