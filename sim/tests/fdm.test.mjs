// Flight-model tests: scripted flights with pass/fail numbers.
//   node --import ./sim/tests/node-three.mjs sim/tests/fdm.test.mjs      (from the repo root)
//   ... fdm.test.mjs --only takeoff,landing   runs a subset; exit code 1 if any check fails.
//
// The ground is a stand-in for the Terrain: a flat plane at 59 m (Tel Nof's elevation) with a
// 3,000 m x 45 m runway along the Z axis (runway heading 360 / north = -Z), surfaceAt friction 0.8
// on the runway and 0.5 beside it.  If data/aircraft/f35i_rig.json exists its gear contacts are used.
// Every tolerance below is explained next to its check (public F-35A figures, DESIGN.md targets,
// or physics: e.g. "no energy gain" is a hard conservation law).

import fs from 'node:fs';
import { Vector3 } from 'three';
import { FlightModel } from '../js/fdm/FlightModel.js';
import { F35I_CONFIG, configWithRig } from '../js/fdm/f35i_config.js';
import { atmosphere, tasFromCas, KT, G0 } from '../js/fdm/atmosphere.js';

const DT = 1 / 60;                    // the app's frame time; the FDM sub-steps at 240 Hz inside
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? new Set(process.argv[i + 1].split(',')) : null;
})();

// ------------------------------------------------------------------------------ configuration
let CONFIG = F35I_CONFIG;
let gearSource = 'default contacts (scripts/f35/gear.py + geom.py stance)';
try {
  const rigUrl = new URL('../data/aircraft/f35i_rig.json', import.meta.url);
  if (fs.existsSync(rigUrl)) {
    const c = configWithRig(F35I_CONFIG, JSON.parse(fs.readFileSync(rigUrl, 'utf8')));
    if (c.gear.contacts !== F35I_CONFIG.gear.contacts) { CONFIG = c; gearSource = 'data/aircraft/f35i_rig.json gearContacts'; }
  }
} catch (e) { gearSource += ` (rig json unreadable: ${e.message})`; }

// ------------------------------------------------------------------------------ stand-in grounds
const RWY = { zSouth: 1500, zNorth: -1500, halfWidth: 22.5, elev: 59 };
function flatGround(elev, surface = (x, z) => ({ type: 'ground', friction: 0.5 })) {
  return { heightAt: () => elev, normalAt: (x, z, out) => out.set(0, 1, 0), surfaceAt: surface };
}
const runwayGround = flatGround(RWY.elev, (x, z) => (Math.abs(x) <= RWY.halfWidth && z <= RWY.zSouth && z >= RWY.zNorth
  ? { type: 'runway', friction: 0.8 } : { type: 'ground', friction: 0.5 }));
const seaLevelLand = flatGround(0);

// ------------------------------------------------------------------------------ reporting
const results = [];
function section(name) {
  console.log(`\n== ${name}`);
}
function info(text) {
  console.log(`   ${text}`);
}
function check(name, value, lo, hi, unit, why) {
  const ok = Number.isFinite(value) && value >= lo && value <= hi;
  results.push({ name, ok });
  const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}: ${Number.isFinite(value) ? fmt(value) : value} ${unit}`
    + `   [${fmt(lo)} .. ${fmt(hi)}]  ${why}`);
  return ok;
}
function checkTrue(name, cond, detail, why) {
  results.push({ name, ok: !!cond });
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${name}: ${detail}   ${why}`);
  return !!cond;
}

function newFdm(ground = runwayGround, config = CONFIG) {
  return new FlightModel(config, ground);
}
const base = () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, parkingBrake: false, gearHandle: true, nwsEnable: true });
/** Airborne spawn at a calibrated airspeed (kt) and altitude (m). */
function airSpawn(fdm, casKt, alt, extra = {}) {
  const V = tasFromCas(casKt * KT, alt);
  return fdm.reset({ x: 0, y: alt, z: 0, heading_deg: 0, on_ground: false, speed_ms: V, ...extra });
}
function energy(st) {
  return st.mass * (G0 * st.altitude + 0.5 * st.tas * st.tas);
}
const tests = {};
const TAIL = new Vector3();

// ==============================================================================================
tests.parked = () => {
  section('Parked at idle, parking brake set, 60 s');
  const fdm = newFdm();
  fdm.reset({ x: 0, y: RWY.elev, z: 1000, heading_deg: 0, on_ground: true });
  const st = fdm.state;
  info(`gear: ${gearSource}`);
  const p0 = st.position.clone();
  const pitch0 = st.pitch;
  const inp = { ...base(), parkingBrake: true };
  let maxDrift = 0;
  for (let i = 0; i < 60 * 60; i++) {
    fdm.step(DT, inp);
    maxDrift = Math.max(maxDrift, Math.hypot(st.position.x - p0.x, st.position.z - p0.z));
  }
  const loads = st.wheels.map((w) => `${w.name} ${(w.force / 1000).toFixed(1)} kN @ ${(w.compression * 100).toFixed(1)} cm`).join(', ');
  info(`mass ${st.mass.toFixed(0)} kg, ${loads}; idle thrust ${(st.engine.thrust / 1000).toFixed(1)} kN, N2 ${st.engine.rpm.toFixed(0)} %`);
  const noseShare = st.wheels.find((w) => w.name.includes('nose')).force / st.wheels.reduce((a, w) => a + w.force, 0);
  check('horizontal drift', maxDrift, 0, 0.05, 'm', 'brakes hold idle thrust: only the tyre/brake compliance (< 5 cm)');
  check('pitch change', Math.abs(st.pitch - pitch0) * R2D, 0, 0.1, 'deg', 'struts settled at the static stance');
  check('static stance pitch', st.pitch * R2D, 1.3, 1.6, 'deg', 'model stance is 1.45 deg nose-up (scripts/f35/geom.py)');
  check('nose-wheel load share', noseShare * 100, 10, 25, '%', 'fighter tricycle gear typically 10-20 % on the nose');
  check('load factor', st.gLoad, 0.98, 1.02, 'g', 'standing still = 1 g on the struts');
  checkTrue('all wheels on the ground, no crash', st.wheels.every((w) => w.wow) && !st.crashed, st.crashReason || 'ok', '');
};

// ==============================================================================================
function takeoff(throttle, label, rotateKias, distRange) {
  section(`Takeoff, ${label}, 60 % fuel: brake release with the engine at idle, pull at ${rotateKias} KIAS`);
  const fdm = newFdm();
  fdm.reset({ x: 0, y: RWY.elev, z: RWY.zSouth - 50, heading_deg: 0, on_ground: true, fuel: 0.6 });
  const st = fdm.state;
  const z0 = st.position.z;
  const inp = { ...base(), throttle };
  let t = 0, rot = null, noseOff = null, lo = null, maxGroundPitch = 0, gearUp = null, maxPitch = 0, maxAlpha = 0, rotPitch = 0;
  let pitchAt5s = 0, vsAt10s = 0, altAt20s = 0;
  while (t < 45 && !st.crashed) {
    if (!rot && st.ias_kt >= rotateKias) rot = { t, ias: st.ias_kt, dist: z0 - st.position.z };
    inp.pitch = rot && (!lo || t - lo.t < 3) ? 1 : 0;      // pull, keep it pulled 3 s after lift-off
    inp.yaw = st.onGround ? clamp(-0.08 * st.position.x - 0.3 * st.velocity.x, -1, 1) : 0;
    if (lo && st.agl > 15) inp.gearHandle = false;
    fdm.step(DT, inp);
    t += DT;
    const nose = st.wheels.find((w) => w.name.includes('nose'));
    if (rot && !noseOff && !nose.wow) noseOff = { t, ias: st.ias_kt };
    if (st.onGround) maxGroundPitch = Math.max(maxGroundPitch, st.pitch * R2D);
    if (rot && (!lo || t - lo.t < 3)) rotPitch = Math.max(rotPitch, st.pitch * R2D);   // stick held aft
    if (rot && !lo && !st.onGround) lo = { t, ias: st.ias_kt, dist: z0 - st.position.z, pitch: st.pitch * R2D };
    if (lo) {
      maxPitch = Math.max(maxPitch, st.pitch * R2D);
      maxAlpha = Math.max(maxAlpha, st.alpha * R2D);
      if (!gearUp && st.gear <= 0) gearUp = t;
      if (Math.abs(t - lo.t - 5) < DT / 2) pitchAt5s = st.pitch * R2D;
      if (Math.abs(t - lo.t - 10) < DT / 2) vsAt10s = st.vs;
      if (Math.abs(t - lo.t - 20) < DT / 2) altAt20s = st.altitude - RWY.elev;
      if (t - lo.t > 21) break;
    }
  }
  if (!lo) { checkTrue('lift-off', false, st.crashReason || 'never left the ground', ''); return; }
  info(`rotation command ${rot.ias.toFixed(0)} KIAS after ${rot.dist.toFixed(0)} m, nose wheel off ${noseOff ? noseOff.ias.toFixed(0) : '-'} KIAS,`
    + ` lift-off ${lo.ias.toFixed(0)} KIAS at ${lo.t.toFixed(1)} s, pitch ${lo.pitch.toFixed(1)} deg`);
  info(`after lift-off: max pitch ${maxPitch.toFixed(1)} deg, pitch at +5 s ${pitchAt5s.toFixed(1)} deg, max AoA ${maxAlpha.toFixed(1)} deg,`
    + ` climb at +10 s ${vsAt10s.toFixed(1)} m/s, height at +20 s ${altAt20s.toFixed(0)} m, gear up at ${gearUp ? (gearUp - lo.t).toFixed(1) : '-'} s`);
  check(`${label} lift-off speed`, lo.ias, 148, 172, 'KIAS', 'DESIGN: takeoff ~150-165 KIAS with MIL at a typical weight');
  check(`${label} ground roll`, lo.dist, distRange[0], distRange[1], 'm', distRange[2]);
  check(`${label} rotation attitude (stick held aft)`, rotPitch, 10, 12.8, 'deg', 'DESIGN: a pull at ~150 kt rotates the jet to ~10-12 deg');
  check(`${label} max pitch on the runway`, maxGroundPitch, 0, 13.5, 'deg', 'below the tail-strike attitude (~15 deg: nozzle, scripts/f35 geometry)');
  check(`${label} climb rate 10 s after lift-off`, vsAt10s, 5, 80, 'm/s', 'positive, stable climb-out');
  checkTrue(`${label} no crash`, !st.crashed, st.crashReason || 'ok', '');
}
tests.takeoff = () => {
  // Ground roll by energy: V_LOF^2 / 2a with a = g (T/W - mu - D/W).  MIL: T/W 0.69, a ~6 m/s^2 -> ~580 m
  // at 162 kt, plus the spool-up from idle (clean F-16-class jets: ~1,700-2,500 ft).  A/B: T/W 1.06,
  // a ~9.5 m/s^2 -> ~350 m.  The bands allow +-25 % for drag, lift and rotation technique.
  takeoff(0.75, 'MIL', 150, [480, 900, 'energy estimate ~600 m (T/W 0.69, spool-up from idle)']);
  takeoff(1.0, 'max A/B', 140, [300, 650, 'energy estimate ~380 m (T/W 1.06); pull earlier as the jet accelerates at ~1 g']);
};

// ==============================================================================================
/** Takeoff run for the handling checks: pull `stick` at vr and hold it `hold` s after lift-off. */
function takeoffRun({ stick = 1, throttle = 0.75, vr = 150, hold = 15, gearUpAfter = null, parking = false } = {}) {
  const fdm = newFdm();
  fdm.reset({ x: 0, y: RWY.elev, z: RWY.zSouth - 50, heading_deg: 0, on_ground: true, fuel: 0.6 });
  const st = fdm.state;
  const z0 = st.position.z;
  const inp = { ...base(), throttle, parkingBrake: parking };
  let t = 0, rot = false, lo = null, maxPitch = 0, maxAlpha = 0, warnGround = false, warnAir = false;
  while (t < 90 && !st.crashed) {
    if (st.ias_kt >= vr) rot = true;
    inp.pitch = rot && (!lo || t - lo.t < hold) ? stick : 0;
    inp.yaw = st.onGround ? clamp(-0.08 * st.position.x - 0.3 * st.velocity.x, -1, 1) : 0;
    if (lo && gearUpAfter != null && t - lo.t >= gearUpAfter) inp.gearHandle = false;
    fdm.step(DT, inp);
    t += DT;
    const w = st.warnings.includes('PARKING BRAKE');
    if (st.onGround) warnGround ||= w; else warnAir ||= w;
    if (rot && !lo && !st.onGround) lo = { t, ias: st.ias_kt, dist: z0 - st.position.z };
    if (lo) {
      maxPitch = Math.max(maxPitch, st.pitch * R2D);
      maxAlpha = Math.max(maxAlpha, st.alpha * R2D);
      if (t - lo.t > hold) break;
    }
  }
  return { st, lo, maxPitch, maxAlpha, warnGround, warnAir };
}

tests.handling = () => {
  section('Handling: partial-stick rotation, stick held through gear up, parking brake, slow-flight roll');
  {
    // the ground law maps the raw stick (60 % = the full 12 deg attitude): a half pull rotates too
    const r = takeoffRun({ stick: 0.5, hold: 10 });
    info(`half aft stick at 150 KIAS (MIL): lift-off ${r.lo ? r.lo.ias.toFixed(0) : '-'} KIAS after ${r.lo ? r.lo.dist.toFixed(0) : '-'} m, max pitch ${r.maxPitch.toFixed(1)} deg`);
    check('lift-off with half aft stick', r.lo ? r.lo.ias : 999, 148, 172, 'KIAS', 'a partial pull still rotates to ~10 deg (it used to fly off at ~260 kt)');
  }
  {
    // full aft stick held through gear up (+2 s) and for 15 s: the take-off -> C* hand-over is
    // ratcheted, the jet keeps its climb path instead of pulling to the AoA limit
    const r = takeoffRun({ stick: 1, hold: 15, gearUpAfter: 2 });
    info(`full aft stick held 15 s, gear up at +2 s: max pitch ${r.maxPitch.toFixed(1)} deg, max AoA ${r.maxAlpha.toFixed(1)} deg, climbing ${r.st.vs.toFixed(1)} m/s`);
    check('max pitch, stick held through gear up', r.maxPitch, 8, 20, 'deg', 'no zoom: it used to reach 60-90 deg');
    check('max AoA, stick held through gear up', r.maxAlpha, 5, 15, 'deg', 'the climb path is held, far from the 25 deg limit');
  }
  {
    // parking brake left on with full afterburner: it brakes once the wheels slide; the warning only
    // on the ground
    const free = takeoffRun({ stick: 1, throttle: 1, vr: 140, hold: 5 });
    const park = takeoffRun({ stick: 1, throttle: 1, vr: 140, hold: 5, parking: true });
    info(`max A/B ground roll ${free.lo ? free.lo.dist.toFixed(0) : '-'} m; with the parking brake set ${park.lo ? park.lo.dist.toFixed(0) : '-'} m;`
      + ` PARKING BRAKE warning on the ground ${park.warnGround}, in the air ${park.warnAir}`);
    check('ground roll with the parking brake / without', park.lo && free.lo ? park.lo.dist / free.lo.dist : 0, 1.3, 3, '', 'the parking brake drags the sliding wheels like full brakes');
    checkTrue('PARKING BRAKE warning on the ground only', park.warnGround && !park.warnAir, `ground ${park.warnGround}, air ${park.warnAir}`, 'meaningless once airborne');
  }
  {
    // slow flight at the 25 deg AoA limit, ~120 KCAS: full right stick
    const fdm = newFdm(seaLevelLand);
    airSpawn(fdm, 160, 3000);
    const st = fdm.state;
    const inp = { ...base(), throttle: 0.75, gearHandle: false };
    let t = 0;
    while (t < 40 && !(st.alpha * R2D > 24.5 && st.ias_kt < 125)) {
      inp.pitch = st.alpha * R2D < 24.5 ? 1 : 0.6; inp.throttle = st.ias_kt > 122 ? 0.2 : 0.75; fdm.step(DT, inp); t += DT;
    }
    inp.pitch = 1; inp.roll = 1;
    const phi0 = st.roll;
    let t90 = null, bMax = 0, pMax = 0;
    for (let i = 0; i < 6 * 60 && t90 === null; i++) {
      fdm.step(DT, inp);
      bMax = Math.max(bMax, Math.abs(st.beta * R2D));
      pMax = Math.max(pMax, Math.abs(st.p * R2D));
      if (Math.abs(st.roll - phi0) * R2D >= 90) t90 = (i + 1) * DT;
    }
    info(`full stick at ${st.ias_kt.toFixed(0)} KIAS, ${(st.alpha * R2D).toFixed(1)} deg AoA: 90 deg of bank in ${t90 ? t90.toFixed(2) : '-'} s, peak ${pMax.toFixed(0)} deg/s, max sideslip ${bMax.toFixed(1)} deg`);
    check('slow flight (25 deg AoA): time to 90 deg of bank', t90 ?? 99, 1.5, 3.25, 's', 'roll capped to what the rudders can coordinate; ailerons no longer wind down when the rudders saturate');
    check('slow flight (25 deg AoA): sideslip in the roll', bMax, 0, 8, 'deg', 'coordination cap holds the sideslip near 6 deg');
  }
};

// ==============================================================================================
tests.climb = () => {
  section('Climb at 300 KCAS, MIL, from 1,000 m (60 % fuel)');
  const fdm = newFdm(seaLevelLand);
  airSpawn(fdm, 300, 1000);
  const st = fdm.state;
  const inp = { ...base(), throttle: 0.75, gearHandle: false };
  let prevIas = st.ias_kt, sum = 0, n = 0, t = 0;
  let iasMin = 1e9, iasMax = 0;
  while (t < 120 && st.altitude < 3200) {
    // speed-on-pitch autopilot: pull when fast, with damping on the speed trend
    const dIas = (st.ias_kt - prevIas) / DT;
    prevIas = st.ias_kt;
    inp.pitch = clamp(0.012 * (st.ias_kt - 300) + 0.05 * dIas, -0.4, 0.6);
    fdm.step(DT, inp);
    t += DT;
    if (st.altitude > 1600 && st.altitude < 3000) {
      sum += st.vs; n++;
      iasMin = Math.min(iasMin, st.ias_kt); iasMax = Math.max(iasMax, st.ias_kt);
    }
  }
  const vs = sum / Math.max(n, 1);
  info(`average climb 1,600-3,000 m: ${vs.toFixed(1)} m/s (${(vs / 0.3048 * 60).toFixed(0)} ft/min), IAS ${iasMin.toFixed(0)}-${iasMax.toFixed(0)} kt,`
    + ` pitch ${(st.pitch * R2D).toFixed(1)} deg, thrust ${(st.engine.thrust / 1000).toFixed(0)} kN`);
  check('climb rate at 300 KCAS, MIL', vs, 55, 100, 'm/s', 'excess power (T-D)V/W at MIL: ~11,000-20,000 ft/min for an F-35A');
  check('speed held by the autopilot', iasMax - iasMin, 0, 20, 'kt', 'scripted pilot holds 300 KCAS');
};

// ==============================================================================================
tests.level = () => {
  section('Hands-off level flight, 350 KCAS at 5,000 m, 60 s');
  const fdm = newFdm(seaLevelLand);
  const r = airSpawn(fdm, 350, 5000);
  const st = fdm.state;
  const inp = { ...base(), throttle: r.throttle, gearHandle: false };
  const h0 = st.altitude, v0 = st.ias_kt, psi0 = st.heading;
  let maxDev = 0, maxBank = 0;
  for (let i = 0; i < 60 * 60; i++) {
    fdm.step(DT, inp);
    maxDev = Math.max(maxDev, Math.abs(st.altitude - h0));
    maxBank = Math.max(maxBank, Math.abs(st.roll * R2D));
  }
  info(`trim: throttle ${r.throttle.toFixed(3)}, AoA ${(st.alpha * R2D).toFixed(2)} deg, stabilator ${st.controls.stick_pitch.toFixed(3)},`
    + ` Mach ${st.mach.toFixed(3)}, final IAS ${st.ias_kt.toFixed(1)} kt, heading change ${((st.heading - psi0) * R2D).toFixed(2)} deg`);
  check('altitude drift (max |dh|)', maxDev, 0, 30, 'm', 'DESIGN: hands-off holds the 1 g flight path; brief: < 30 m in 60 s');
  check('speed change', Math.abs(st.ias_kt - v0), 0, 5, 'kt', 'trimmed throttle: steady');
  check('bank angle', maxBank, 0, 0.5, 'deg', 'wings stay level hands-off');
  check('load factor', st.gLoad, 0.98, 1.02, 'g', '1 g');
};

// ==============================================================================================
function maxLevelSpeed(label, alt, startMach, range, why) {
  const fdm = newFdm(seaLevelLand);
  const atm = atmosphere(alt);
  fdm.reset({ x: 0, y: alt, z: 0, heading_deg: 90, on_ground: false, speed_ms: startMach * atm.a, fuel: 0.6 });
  const st = fdm.state;
  const inp = { ...base(), throttle: 1.0, gearHandle: false };
  let t = 0, prevV = st.tas, slow = 0, maxDh = 0;
  while (t < 600) {
    for (let i = 0; i < 60; i++) fdm.step(DT, inp);
    t += 1;
    const acc = st.tas - prevV;
    prevV = st.tas;
    maxDh = Math.max(maxDh, Math.abs(st.altitude - alt));
    slow = Math.abs(acc) < 0.03 ? slow + 1 : 0;
    if (slow >= 10) break;
  }
  info(`${label}: ${t} s in max A/B: Mach ${st.mach.toFixed(3)}, ${st.ias_kt.toFixed(0)} KCAS, ${st.tas_kt.toFixed(0)} KTAS,`
    + ` thrust ${(st.engine.thrust / 1000).toFixed(0)} kN, fuel flow ${st.engine.fuelFlow.toFixed(2)} kg/s, altitude held to ${maxDh.toFixed(0)} m`);
  return { fdm, st, range, why };
}
tests.maxspeed = () => {
  section('Maximum level speed, max afterburner, hands-off level (60 % fuel)');
  const sl = maxLevelSpeed('sea level (150 m)', 150, 0.95);
  check('max speed at sea level', sl.st.ias_kt, 660, 750, 'KCAS', 'DESIGN: about 700 KCAS at low level (the F-35A limit)');
  const hi = maxLevelSpeed('11,000 m', 11000, 1.25);
  check('max Mach at 11 km', hi.st.mach, 1.52, 1.72, '', 'DESIGN: Mach 1.6 at altitude');
};

// ==============================================================================================
tests.gpull = () => {
  section('Full aft stick at 450 KCAS, 3,000 m: g limiter');
  const fdm = newFdm(seaLevelLand);
  const r = airSpawn(fdm, 450, 3000);
  const st = fdm.state;
  const inp = { ...base(), throttle: r.throttle, gearHandle: false };
  for (let i = 0; i < 60; i++) fdm.step(DT, inp);
  inp.pitch = 1;
  let nMax = 0, t8 = null, t = 0, aMax = 0;
  for (let i = 0; i < 6 * 60; i++) {
    fdm.step(DT, inp);
    t += DT;
    if (st.gLoad > nMax) nMax = st.gLoad;
    aMax = Math.max(aMax, st.alpha * R2D);
    if (t8 === null && st.gLoad >= 8) t8 = t;
  }
  info(`peak ${nMax.toFixed(3)} g, 8 g reached after ${t8 ? t8.toFixed(2) : '-'} s, max AoA ${aMax.toFixed(1)} deg, IAS after 6 s ${st.ias_kt.toFixed(0)} kt`);
  check('peak load factor', nMax, 8.6, 9.0, 'g', 'DESIGN: +9 g limit, never exceeded; must reach it (8.6+)');
  check('time to 8 g', t8 ?? 99, 0.5, 2.0, 's', 'abrupt pull: a fighter reaches 8 g in about 1 s');
  checkTrue('no crash / overstress', !st.crashed, st.crashReason || 'ok', '');
};

// ==============================================================================================
tests.aoa = () => {
  section('AoA limiter: full aft stick at 200 KCAS, 3,000 m, MIL');
  for (const high of [false, true]) {
    const fdm = newFdm(seaLevelLand);
    airSpawn(fdm, 200, 3000);
    const st = fdm.state;
    const inp = { ...base(), throttle: 0.75, gearHandle: false, highAoA: high };
    for (let i = 0; i < 30; i++) fdm.step(DT, inp);
    inp.pitch = 1;
    let aMax = 0, sum = 0, n = 0, nMax = 0;
    const T = high ? 8 : 10;
    for (let i = 0; i < T * 60; i++) {
      fdm.step(DT, inp);
      aMax = Math.max(aMax, st.alpha * R2D);
      nMax = Math.max(nMax, st.gLoad);
      if (i > (T - 3) * 60) { sum += st.alpha * R2D; n++; }
    }
    const lim = high ? 50 : 25;
    info(`${high ? 'high-AoA mode' : 'normal mode'}: peak AoA ${aMax.toFixed(2)} deg, last 3 s mean ${(sum / n).toFixed(2)} deg,`
      + ` peak ${nMax.toFixed(2)} g, IAS ${st.ias_kt.toFixed(0)} kt`);
    check(`${high ? 'high-AoA' : 'normal'} peak AoA`, aMax, lim - 1.5, lim + 1.5, 'deg', `DESIGN: AoA limited to ${lim} deg (small overshoot allowed)`);
    check(`${high ? 'high-AoA' : 'normal'} held AoA`, sum / n, lim - 2.5, lim + 1.0, 'deg', 'stick held: sits on the limit');
    checkTrue(`${high ? 'high-AoA' : 'normal'} no departure / crash`, !st.crashed && Math.abs(st.beta * R2D) < 5, `beta ${(st.beta * R2D).toFixed(1)} deg`, 'carefree handling');
  }
};

// ==============================================================================================
tests.loop = () => {
  section('Loop from 450 KCAS at 3,000 m, max A/B, 6.5 g pull');
  const fdm = newFdm(seaLevelLand);
  airSpawn(fdm, 450, 3000);
  const st = fdm.state;
  const inp = { ...base(), throttle: 1.0, gearHandle: false };
  const h0 = st.altitude;
  let turned = 0, t = 0, hMax = h0, iasMin = 1e9, nMax = 0, nInt = 0;
  // pilot: holds 6.5 g, wings level.  The stick for a load factor follows from the C* law
  // (n ~ cos(gamma) + shape(stick) * cstarUp * V / (V + Vco)), plus a little feedback on the g meter;
  // over the top the stick reaches the stop and the AoA limiter flies the jet.
  const k = CONFIG.fcs.stickShapePitch;
  const shapeInv = (y) => {
    let x = clamp(y, -1, 1);
    for (let i = 0; i < 8; i++) x -= ((1 - k) * x + k * x * x * x - y) / ((1 - k) + 3 * k * x * x);
    return clamp(x, -1, 1);
  };
  while (t < 60 && turned < 360) {
    const e = 6.5 - st.gLoad;
    nInt = clamp(nInt + e * DT, -2, 2);
    const V = st.tas, Vco = CONFIG.fcs.Vco;
    const want = ((6.5 - Math.cos(st.gamma)) * (V + Vco)) / (CONFIG.fcs.cstarUp * V);
    inp.pitch = clamp(shapeInv(want) + 0.03 * e + 0.03 * nInt, 0, 1);
    fdm.step(DT, inp);
    t += DT;
    turned += st.q * R2D * DT;
    hMax = Math.max(hMax, st.altitude);
    iasMin = Math.min(iasMin, st.ias_kt);
    nMax = Math.max(nMax, st.gLoad);
    if (st.crashed) break;
  }
  inp.pitch = 0;
  info(`completed ${turned.toFixed(0)} deg in ${t.toFixed(1)} s, gain at the top ${(hMax - h0).toFixed(0)} m, exit ${(st.altitude - h0).toFixed(0)} m`
    + ` from entry, min ${iasMin.toFixed(0)} KCAS, peak ${nMax.toFixed(2)} g, exit ${st.ias_kt.toFixed(0)} KCAS`);
  check('loop completed', turned, 359, 400, 'deg', 'pitch rotation through a full circle');
  check('height gained at the top', hMax - h0, 1000, 2200, 'm', 'R = V^2/(g(n-1)) ~1.35 km at the bottom, ~0.3 km over the top (slow, gravity helps): ~1.2-1.8 km');
  check('exit altitude vs entry', st.altitude - h0, -500, 500, 'm', 'a round loop exits near its entry height');
  check('minimum speed over the top', iasMin, 120, 350, 'KCAS', 'enough energy to fly over the top');
  check('peak load factor', nMax, 6.0, 7.2, 'g', 'pilot holds 6-7 g');
};

// ==============================================================================================
tests.roll = () => {
  section('Roll rate: full stick, 350 KCAS at 3,000 m, then 160 KCAS gear down');
  {
    const fdm = newFdm(seaLevelLand);
    const r = airSpawn(fdm, 350, 3000);
    const st = fdm.state;
    const inp = { ...base(), throttle: r.throttle, gearHandle: false };
    for (let i = 0; i < 30; i++) fdm.step(DT, inp);
    inp.roll = 1;
    let pMax = 0, rolled = 0, t360 = null, t = 0, bMax = 0;
    for (let i = 0; i < 3 * 60; i++) {
      fdm.step(DT, inp);
      t += DT;
      pMax = Math.max(pMax, st.p * R2D);
      rolled += st.p * R2D * DT;
      bMax = Math.max(bMax, Math.abs(st.beta * R2D));
      if (t360 === null && rolled >= 360) t360 = t;
    }
    inp.roll = 0;
    const bankAtRelease = st.roll * R2D;
    for (let i = 0; i < 4 * 60; i++) fdm.step(DT, inp);
    info(`peak ${pMax.toFixed(0)} deg/s, 360 deg in ${t360 ? t360.toFixed(2) : '-'} s, max sideslip ${bMax.toFixed(2)} deg;`
      + ` stick released at ${bankAtRelease.toFixed(0)} deg bank -> holds ${(st.roll * R2D).toFixed(1)} deg, roll rate now ${(st.p * R2D).toFixed(1)} deg/s`);
    check('max roll rate at 350 KCAS', pMax, 180, 205, 'deg/s', 'DESIGN: roll rate up to ~200 deg/s at mid speeds');
    check('time for a full roll', t360 ?? 99, 1.6, 2.6, 's', '360 deg at ~200 deg/s plus the roll-in');
    check('sideslip during the roll', bMax, 0, 3, 'deg', 'turn coordination keeps the roll about the velocity vector');
    check('roll rate after release', Math.abs(st.p * R2D), 0, 1, 'deg/s', 'attitude hold: the jet stops rolling and holds its bank');
  }
  {
    const fdm = newFdm(seaLevelLand);
    const r = airSpawn(fdm, 160, 1000, { gear: true });
    const st = fdm.state;
    const inp = { ...base(), throttle: r.throttle };
    for (let i = 0; i < 30; i++) fdm.step(DT, inp);
    inp.roll = 1;
    let pMax = 0;
    for (let i = 0; i < 2 * 60; i++) { fdm.step(DT, inp); pMax = Math.max(pMax, st.p * R2D); }
    info(`160 KCAS, gear and flaps down: peak ${pMax.toFixed(0)} deg/s at AoA ${(st.alpha * R2D).toFixed(1)} deg`);
    check('roll rate in the landing configuration', pMax, 50, 120, 'deg/s', 'reduced at low dynamic pressure and higher AoA');
  }
};

// ==============================================================================================
tests.yaw = () => {
  section('Pedals in the air: sideslip command, 300 KCAS at 3,000 m');
  const fdm = newFdm(seaLevelLand);
  const r = airSpawn(fdm, 300, 3000);
  const st = fdm.state;
  const inp = { ...base(), throttle: r.throttle, gearHandle: false };
  for (let i = 0; i < 30; i++) fdm.step(DT, inp);
  inp.yaw = 1;
  let bSum = 0, n = 0, bankMax = 0;
  for (let i = 0; i < 4 * 60; i++) {
    fdm.step(DT, inp);
    if (i >= 2 * 60) { bSum += st.beta * R2D; n++; }
    bankMax = Math.max(bankMax, Math.abs(st.roll * R2D));
  }
  const bHeld = bSum / n;
  inp.yaw = 0;
  for (let i = 0; i < 3 * 60; i++) fdm.step(DT, inp);
  const betaCmd = clamp(CONFIG.fcs.betaMax * CONFIG.fcs.betaQbarRef / st.qbar, CONFIG.fcs.betaMin, CONFIG.fcs.betaMax) * R2D;
  info(`full right pedal: sideslip ${bHeld.toFixed(2)} deg (command ${betaCmd.toFixed(1)} deg at qbar ${st.qbar.toFixed(0)} Pa), max bank ${bankMax.toFixed(1)} deg;`
    + ` 3 s after release: sideslip ${(st.beta * R2D).toFixed(2)} deg`);
  check('pedal sideslip (nose right = negative beta)', -bHeld, 0.7 * betaCmd, 1.3 * betaCmd, 'deg', 'DESIGN: pedals command sideslip in the air, less at high qbar');
  check('sideslip after release', Math.abs(st.beta * R2D), 0, 0.3, 'deg', 'turn coordination returns to zero sideslip');
  check('bank while side-slipping', bankMax, 0, 15, 'deg', 'the roll axis holds the wings near level against the dihedral effect');
};

// ==============================================================================================
tests.turn = () => {
  section('Turns: sustained g at M 0.8 / 15,000 ft (max A/B) and a hands-off 60 deg banked turn');
  const fdm = newFdm(seaLevelLand);
  // point performance with the FDM's own aero and engine: highest CL with thrust = drag
  const h = 4572, atm = atmosphere(h), M = 0.8, V = M * atm.a;
  airSpawn(fdm, 300, h);
  const mass = fdm.mass();
  const qbar = 0.5 * atm.rho * V * V;
  const T = fdm.engine.limits(atm, M, {}).max;
  const ao = {};
  let lo = 0, hi = 0.45;
  for (let i = 0; i < 50; i++) {
    const a = 0.5 * (lo + hi);
    fdm.aero.evaluate({ alpha: a, beta: 0, mach: M, V, p: 0, q: 0, r: 0, flaps: 0, gear: 0, speedbrake: 0, canopy: 0, hWing: Infinity }, { de: 0, da: 0, dr: 0 }, ao);
    const Treq = qbar * fdm.cfg.aero.S * ao.CD;
    if (Treq < T) lo = a; else hi = a;
  }
  const nSust = (qbar * fdm.cfg.aero.S * ao.CL) / (mass * G0);
  info(`max A/B ${(T / 1000).toFixed(0)} kN, sustained CL ${ao.CL.toFixed(3)} at ${(lo * R2D).toFixed(1)} deg AoA, mass ${mass.toFixed(0)} kg`);
  check('sustained load factor M 0.8 / 15,000 ft', nSust, 4.3, 5.4, 'g', 'F-35A published 4.6 g (spec was 5.3 g)');
  // 6-DOF: roll to 60 deg at a moderate rate and let go; the jet should hold bank and altitude
  // (bank-compensated flight-path hold).  The "pilot" only adds power to hold 350 KCAS.
  const r = airSpawn(fdm, 350, 3000);
  const st = fdm.state;
  const inp = { ...base(), throttle: r.throttle, gearHandle: false };
  let thrI = r.throttle;
  const holdSpeed = () => {
    const e = 350 - st.ias_kt;
    thrI = clamp(thrI + 0.004 * e * DT, 0.1, 0.75);
    inp.throttle = clamp(thrI + 0.02 * e, 0, 0.75);
  };
  const h0 = st.altitude;
  let dev = 0, t = 0, trkSum = 0, theorySum = 0, bankLo = 99, bankHi = -99, betaMax = 0, iasLo = 999, iasHi = 0;
  const track = () => Math.atan2(st.velocity.x, -st.velocity.z);
  while (st.roll * R2D < 60) { inp.roll = 0.35; holdSpeed(); fdm.step(DT, inp); dev = Math.max(dev, Math.abs(st.altitude - h0)); }
  inp.roll = 0;
  for (let i = 0; i < 3 * 60; i++) { holdSpeed(); fdm.step(DT, inp); dev = Math.max(dev, Math.abs(st.altitude - h0)); }
  let prev = track();
  for (let i = 0; i < 20 * 60; i++) {
    holdSpeed();
    fdm.step(DT, inp);
    t += DT;
    dev = Math.max(dev, Math.abs(st.altitude - h0));
    const trk = track();
    let d = trk - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    prev = trk;
    trkSum += d;
    theorySum += (G0 * Math.tan(st.roll) / st.tas) * DT;     // coordinated level turn at this bank and speed
    bankLo = Math.min(bankLo, st.roll * R2D); bankHi = Math.max(bankHi, st.roll * R2D);
    betaMax = Math.max(betaMax, Math.abs(st.beta * R2D));
    iasLo = Math.min(iasLo, st.ias_kt); iasHi = Math.max(iasHi, st.ias_kt);
  }
  const ratio = trkSum / theorySum;
  info(`bank ${bankLo.toFixed(1)}-${bankHi.toFixed(1)} deg, ${st.gLoad.toFixed(2)} g, ${iasLo.toFixed(0)}-${iasHi.toFixed(0)} KIAS at throttle ${inp.throttle.toFixed(2)},`
    + ` turn rate ${(trkSum / t * R2D).toFixed(2)} deg/s (g tan(phi)/V: ${(theorySum / t * R2D).toFixed(2)}), max sideslip ${betaMax.toFixed(2)} deg`);
  check('hands-off 60 deg turn: altitude (roll-in + 23 s)', dev, 0, 30, 'm', 'DESIGN: hands-off holds the 1 g flight path, bank compensated (brief: 30 m)');
  check('hands-off 60 deg turn: bank held', (bankLo + bankHi) / 2, 57, 63, 'deg', 'bank-angle hold after the stick is released');
  check('turn rate vs coordinated level turn', ratio, 0.95, 1.05, '', 'track rate / (g tan(phi) / V); lift-vector bank sits ~0.3 deg below phi at 7 deg AoA');
  check('sideslip in the turn', betaMax, 0, 1, 'deg', 'turn coordination');
};

// ==============================================================================================
tests.landing = () => {
  section('Approach at 13 deg AoA on a 3 deg glide path, landing, braking to a stop (35 % fuel)');
  const fdm = newFdm();
  const aimZ = RWY.zSouth - 300;                       // aim 300 m past the threshold
  const startDist = 7000;
  const z0 = aimZ + startDist;
  const gs = 3 * D2R;
  const y0 = RWY.elev + 1.95 + startDist * Math.tan(gs);
  const r = fdm.reset({ x: 0, y: y0, z: z0, heading_deg: 0, on_ground: false, speed_ms: 145 * KT, gear: true, fuel: 0.35, flight_path_deg: -3 });
  const st = fdm.state;
  const inp = { ...base(), throttle: r.throttle };
  let t = 0, thrI = r.throttle, phase = 'approach', td = null, stopT = null;
  const ap = { ias: 0, aoa: 0, n: 0, thr: 0 };
  let nosedown = null, maxDecel = 0, prevGs = 0, maxPitch = 0, minTailClear = 99;
  while (t < 160 && !st.crashed) {
    const distToAim = st.position.z - aimZ;
    const hWheels = st.agl;                              // height of the wheels above the runway
    if (phase === 'approach') {
      // throttle holds 13 deg AoA (on-speed), stick tracks the glide path
      const eA = st.alpha * R2D - 13;
      thrI = clamp(thrI + 0.02 * eA * DT, 0.05, 0.75);
      inp.throttle = clamp(thrI + 0.03 * eA, 0, 0.75);
      const hTarget = Math.max(0, distToAim) * Math.tan(gs);
      const gCmd = -gs + clamp(0.004 * (hTarget - hWheels), -0.03, 0.03);
      inp.pitch = clamp(3.0 * (gCmd - st.gamma) - 0.6 * st.q, -0.5, 0.5);
      inp.yaw = 0;
      inp.roll = clamp(-0.01 * st.position.x - 0.05 * st.velocity.x - 1.5 * st.roll, -0.3, 0.3);
      if (distToAim < 4000 && distToAim > 800) { ap.ias += st.ias_kt; ap.aoa += st.alpha * R2D; ap.thr += inp.throttle; ap.n++; }
      if (hWheels < 12) phase = 'flare';
    } else if (phase === 'flare') {
      // flare: bring the sink rate down towards ~0.7 m/s; power stays on the AoA until 2 m, then idle
      const vsT = -Math.max(0.6, Math.min(3.6, 0.28 * hWheels + 0.6));
      inp.pitch = clamp(0.25 * (vsT - st.vs) - 0.5 * st.q, -0.3, 0.6);
      const eA = st.alpha * R2D - 13;
      thrI = clamp(thrI + 0.02 * eA * DT, 0.05, 0.75);
      inp.throttle = hWheels < 2 ? 0 : clamp(thrI + 0.03 * eA, 0, 0.75);
      inp.roll = clamp(-1.5 * st.roll, -0.3, 0.3);
      if (st.onGround) { phase = 'rollout'; td = { t, z: st.position.z }; }
    } else {
      // roll-out: stick neutral (the FCS lowers the nose), brakes once the nose wheel is down
      inp.pitch = 0;
      inp.throttle = 0;
      inp.roll = 0;
      const nose = st.wheels.find((w) => w.name.includes('nose'));
      if (nose.wow && !nosedown) nosedown = t;
      inp.brake = nosedown && t - nosedown > 1 ? 1 : 0;
      inp.yaw = clamp(-0.08 * st.position.x - 0.3 * st.velocity.x, -1, 1);
      const dec = (prevGs - st.groundSpeed) / DT;
      if (t - td.t > 0.5) maxDecel = Math.max(maxDecel, dec);
      if (st.groundSpeed < 0.3) { stopT = t; break; }
    }
    prevGs = st.groundSpeed;
    fdm.step(DT, inp);
    t += DT;
    if (phase !== 'approach') maxPitch = Math.max(maxPitch, st.pitch * R2D);
    // tail clearance: nozzle point height above the runway
    const tail = TAIL.set(0, -0.45, 15.6 - 7.835).applyQuaternion(st.quaternion).add(st.position);
    minTailClear = Math.min(minTailClear, tail.y - RWY.elev);
  }
  const lt = st.lastTouchdown;
  const apIas = ap.ias / Math.max(ap.n, 1), apAoa = ap.aoa / Math.max(ap.n, 1);
  info(`approach (4 km - 800 m out): ${apIas.toFixed(1)} KIAS at ${apAoa.toFixed(2)} deg AoA, throttle ${(ap.thr / Math.max(ap.n, 1)).toFixed(2)},`
    + ` mass ${st.mass.toFixed(0)} kg`);
  if (lt) {
    info(`touchdown ${lt.ias / KT >= 0 ? (lt.ias / KT).toFixed(0) : '-'} KIAS, sink ${lt.sink.toFixed(2)} m/s, pitch ${(lt.pitch * R2D).toFixed(1)} deg,`
      + ` ${(RWY.zSouth - td.z).toFixed(0)} m past the threshold; max pitch ${maxPitch.toFixed(1)} deg, min tail clearance ${minTailClear.toFixed(2)} m`);
  }
  if (stopT) info(`stopped ${(td.z - st.position.z).toFixed(0)} m after touchdown, ${(stopT - td.t).toFixed(1)} s, peak decel ${(maxDecel / G0).toFixed(2)} g, centreline offset ${st.position.x.toFixed(1)} m`);
  check('approach speed at 13 deg AoA', apIas, 132, 150, 'KIAS', 'DESIGN: approach about 140 KIAS at 13 deg AoA');
  check('approach AoA held', apAoa, 12.5, 13.5, 'deg', 'on-speed AoA flown with the throttle');
  check('touchdown sink rate', lt ? lt.sink : 99, 0.2, 3.0, 'm/s', 'brief: touchdown < 3 m/s (gear limit ~4 m/s)');
  check('landing roll', stopT ? td.z - st.position.z : 1e9, 500, 1500, 'm', 'wheel brakes (anti-skid, 0.8 runway): ~0.3-0.4 g');
  check('peak braking deceleration', maxDecel / G0, 0.2, 0.6, 'g', 'tyre friction 0.8 x anti-skid efficiency on the mains');
  checkTrue('stopped on the runway, no crash', stopT && !st.crashed && Math.abs(st.position.x) < RWY.halfWidth && st.position.z > RWY.zNorth,
    st.crashReason || `x ${st.position.x.toFixed(1)} m`, '');
};

// ==============================================================================================
tests.final = () => {
  section('Hands-off final (140 KCAS, 13 deg AoA, gear down, 45 % fuel) and a landing without a flare');
  {
    const fdm = newFdm();
    const V = tasFromCas(140 * KT, 595);
    fdm.reset({ x: 0, y: 595, z: 10000, heading_deg: 0, on_ground: false, speed_ms: V, gear: true, flight_path_deg: -3, fuel: 0.45 });
    const st = fdm.state;
    const inp = { ...base(), throttle: st.trimThrottle };
    const ias0 = st.ias_kt, aoa0 = st.alpha * R2D;
    let gDev = 0, vDev = 0;
    for (let i = 0; i < 20 * 60; i++) {
      fdm.step(DT, inp);
      if (i < 10 * 60) gDev = Math.max(gDev, Math.abs(st.gamma * R2D + 3));
      vDev = Math.max(vDev, Math.abs(st.ias_kt - ias0));
    }
    info(`start ${ias0.toFixed(1)} KIAS at ${aoa0.toFixed(1)} deg AoA, throttle ${inp.throttle.toFixed(3)}; first 10 s path within ${gDev.toFixed(2)} deg of -3;`
      + ` 20 s: ${st.ias_kt.toFixed(1)} KIAS, ${(st.alpha * R2D).toFixed(1)} deg AoA`);
    check('hands-off final: flight path, first 10 s', gDev, 0, 0.1, 'deg', 'no 1 g bias at high AoA in the path hold (it flattened the path by 0.2 deg and bled speed)');
    check('hands-off final: speed change in 20 s', vDev, 0, 3, 'kt', 'trimmed start; the back of the drag curve diverges only slowly (fly the AoA with the throttle)');
  }
  {
    // 146 KCAS on the 3 deg path straight into the runway, hands off, no flare
    const fdm = newFdm();
    const dist = 1500;
    const y = RWY.elev + 15 + dist * Math.tan(3 * D2R);
    const r = fdm.reset({ x: 0, y, z: RWY.zSouth + dist, heading_deg: 0, on_ground: false, speed_ms: tasFromCas(146 * KT, y), gear: true, flight_path_deg: -3, fuel: 0.6 });
    const st = fdm.state;
    const inp = { ...base(), throttle: r.throttle };
    for (let i = 0; i < 60 * 60 && !st.crashed && !(st.onGround && st.groundSpeed < 30); i++) fdm.step(DT, inp);
    const td = st.lastTouchdown;
    info(`no flare: ${st.crashReason || 'landed'}; touchdown sink ${td ? td.sink.toFixed(2) : '-'} m/s, closing ${td ? td.closing.toFixed(2) : '-'} m/s, bounces ${td ? td.bounces : '-'}, hard ${td ? td.hard : '-'}`);
    check('no-flare touchdown: logged sink (first contact)', td ? td.sink : 0, 3.0, 4.6, 'm/s', 'a bounce no longer overwrites the landing (it used to log ~0.5 m/s)');
    checkTrue('no-flare touchdown: hard landing, not a crash', !st.crashed && td && td.hard, st.crashReason || `hard ${td ? td.hard : '-'}`, '3 deg path at 146 kt: ~3.9 m/s, between 3.05 and 4.6 m/s');
  }
};

// ==============================================================================================
tests.gear = () => {
  section('Landing gear: retraction, weight-on-wheels interlock, steering, spool-up, fuel flow');
  {
    const fdm = newFdm(seaLevelLand);
    const r = airSpawn(fdm, 220, 1000, { gear: true });
    const st = fdm.state;
    const inp = { ...base(), throttle: r.throttle, gearHandle: false };
    let t = 0;
    while (st.gear > 0 && t < 20) { fdm.step(DT, inp); t += DT; }
    const tUp = t;
    inp.gearHandle = true;
    t = 0;
    while (st.gear < 1 && t < 20) { fdm.step(DT, inp); t += DT; }
    check('gear retraction time', tUp, 5.5, 6.5, 's', 'brief: ~6 s');
    check('gear extension time', t, 5.5, 6.5, 's', 'same actuators down');
  }
  {
    const fdm = newFdm();
    fdm.reset({ x: 0, y: RWY.elev, z: 1000, heading_deg: 0, on_ground: true });
    const st = fdm.state;
    const inp = { ...base(), parkingBrake: true, gearHandle: false };
    for (let i = 0; i < 10 * 60; i++) fdm.step(DT, inp);
    checkTrue('weight-on-wheels interlock', st.gear === 1 && !st.crashed && st.onGround, `gear ${st.gear} after 10 s with the handle up on the ground`, 'gear cannot retract on the ground');
  }
  {
    // taxi turn: 10 kt, full right pedal
    const fdm = newFdm();
    fdm.reset({ x: 0, y: RWY.elev, z: 1000, heading_deg: 0, on_ground: true });
    const st = fdm.state;
    const inp = { ...base(), throttle: 0.0 };
    let t = 0;
    while (st.groundSpeed < 5.1 && t < 30) { inp.throttle = 0.35; fdm.step(DT, inp); t += DT; }
    const psi0 = st.heading;
    inp.yaw = 1;
    let turned = 0, prev = st.heading, sumV = 0, n = 0;
    for (let i = 0; i < 8 * 60; i++) {
      inp.throttle = st.groundSpeed < 5 ? 0.3 : 0.05;
      inp.brake = st.groundSpeed > 5.5 ? 0.3 : 0;
      fdm.step(DT, inp);
      let d = st.heading - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      turned += d; prev = st.heading; sumV += st.groundSpeed; n++;
    }
    const rate = turned / 8, radius = (sumV / n) / Math.max(rate, 1e-3);
    info(`taxi at ${(sumV / n / KT).toFixed(1)} kt, full pedal: nose wheel ${(st.wheels[0].steer * R2D).toFixed(0)} deg (nws ${st.controls.nws.toFixed(2)}),`
      + ` turn rate ${(rate * R2D).toFixed(1)} deg/s, radius ${radius.toFixed(1)} m, wheels rolled ${st.controls.roll_distance.toFixed(0)} m`);
    check('taxi turn radius', radius, 6, 25, 'm', 'nose-wheel steering: tight turns at taxi speed');
    check('roll_distance tracks the wheels', st.controls.roll_distance, 40, 400, 'm', 'integrated wheel travel for the visual');
  }
  {
    // nose-wheel steering authority shrinks with speed: full pedal at 60 KIAS on the takeoff roll
    const fdm = newFdm();
    fdm.reset({ x: 0, y: RWY.elev, z: RWY.zSouth - 50, heading_deg: 0, on_ground: true });
    const st = fdm.state;
    const inp = { ...base(), throttle: 0.75 };
    let t = 0;
    while (st.ias_kt < 60 && t < 40) { inp.yaw = clamp(-0.08 * st.position.x - 0.3 * st.velocity.x, -1, 1); fdm.step(DT, inp); t += DT; }
    const x0 = st.position.x;
    let steerMax = 0;
    inp.yaw = 1;
    inp.throttle = 0;
    for (let i = 0; i < 60; i++) { fdm.step(DT, inp); steerMax = Math.max(steerMax, Math.abs(st.wheels[0].steer * R2D)); }
    info(`full pedal for 1 s at ${st.ias_kt.toFixed(0)} KIAS: nose wheel ${steerMax.toFixed(1)} deg, drift ${(st.position.x - x0).toFixed(1)} m to the right`);
    check('nose-wheel angle at 60-70 KIAS, full pedal', steerMax, 0.3, 4, 'deg', 'NWS limited to ~0.35 g of side load at speed (60 deg only when taxiing)');
    checkTrue('still on the runway', Math.abs(st.position.x) < RWY.halfWidth && !st.crashed, `x ${st.position.x.toFixed(1)} m`, '');
  }
  {
    // the engine on its own at sea level, static (the brakes cannot hold the jet at MIL)
    const eng = newFdm().engine;
    const atm = atmosphere(0);
    const h = 1 / CONFIG.substepHz;
    eng.setSteady(0, true);
    let t = 0, tMil = null;
    while (t < 8) { eng.update(h, 0.75, atm, 0, 0, 5000); t += h; if (tMil === null && eng.rpm >= 99) tMil = t; }
    const thrMil = eng.thrust, ffMil = eng.fuelFlow;
    let tAb = null;
    t = 0;
    while (t < 4) { eng.update(h, 1.0, atm, 0, 0, 5000); t += h; if (tAb === null && eng.ab >= 0.99) tAb = t; }
    info(`sea level static: idle -> MIL ${tMil ? tMil.toFixed(2) : '-'} s, MIL ${(thrMil / 1000).toFixed(1)} kN at ${ffMil.toFixed(2)} kg/s;`
      + ` max A/B ${(eng.thrust / 1000).toFixed(1)} kN at ${eng.fuelFlow.toFixed(2)} kg/s`);
    check('spool-up idle -> MIL (N2 99 %)', tMil ?? 99, 3.8, 5.2, 's', 'brief: idle to MIL ~4-5 s');
    check('afterburner light-off to full', tAb ?? 99, 0.7, 1.3, 's', 'brief: A/B light ~1 s');
    check('MIL thrust, sea level static', thrMil / 1000, 123, 127, 'kN', 'DESIGN: ~125 kN');
    check('max A/B thrust, sea level static', eng.thrust / 1000, 188, 194, 'kN', 'DESIGN: ~191 kN');
    check('fuel flow at MIL', ffMil, 0.75, 0.85, 'kg/s', 'brief: MIL ~0.8 kg/s');
    check('fuel flow at max A/B', eng.fuelFlow, 3.3, 3.7, 'kg/s', 'brief: full A/B ~3.5 kg/s');
  }
};

// ==============================================================================================
tests.crash = () => {
  section('Crash detection');
  const drop = (sinkMs, gear, ground = runwayGround) => {
    const fdm = newFdm(ground);
    const V = 72;
    fdm.reset({ x: 0, y: (ground === runwayGround ? RWY.elev : 0) + 1.95 + 2.5, z: 0, heading_deg: 0, on_ground: false, speed_ms: V,
      gear, fuel: 0.3, flight_path_deg: -Math.asin(sinkMs / V) * R2D });
    const st = fdm.state;
    const inp = { ...base(), throttle: st.trimThrottle, gearHandle: gear };
    for (let i = 0; i < 4 * 60 && !st.crashed; i++) fdm.step(DT, inp);
    return st;
  };
  let st = drop(2.0, true);
  checkTrue('2 m/s touchdown: no crash', !st.crashed && st.lastTouchdown, `${st.crashReason || 'landed'}, sink ${st.lastTouchdown ? st.lastTouchdown.sink.toFixed(2) : '-'} m/s`, 'within the gear limit');
  {
    // 3.6 m/s (12 ft/s): beyond the 10 ft/s design sink rate, below the 15 ft/s collapse
    const fdm = newFdm(runwayGround);
    const V = 72;
    fdm.reset({ x: 0, y: RWY.elev + 1.95 + 2.5, z: 0, heading_deg: 0, on_ground: false, speed_ms: V, gear: true, fuel: 0.3,
      flight_path_deg: -Math.asin(3.6 / V) * R2D });
    const s1 = fdm.state;
    const inp = { ...base(), throttle: s1.trimThrottle };
    let shown = false;
    for (let i = 0; i < 4 * 60 && !s1.crashed; i++) { fdm.step(DT, inp); shown ||= s1.warnings.includes('HARD LANDING'); }
    const td = s1.lastTouchdown;
    checkTrue('3.6 m/s touchdown: hard landing, no crash', !s1.crashed && td && td.hard && shown,
      `${s1.crashReason || 'landed'}, sink ${td ? td.sink.toFixed(2) : '-'} m/s, hard ${td ? td.hard : '-'}, HARD LANDING shown ${shown}`,
      'graded: 3.05 m/s (10 ft/s) design sink rate .. 4.6 m/s collapse');
  }
  st = drop(5.0, true);
  checkTrue('5 m/s touchdown: crash', st.crashed && /hard landing|collapsed/i.test(st.crashReason), st.crashReason || 'no crash', 'brief: sink > ~4.6 m/s breaks the gear');
  st = drop(1.5, false);
  checkTrue('gear-up landing: crash', st.crashed && /belly|gear/i.test(st.crashReason), st.crashReason || 'no crash', 'airframe on the runway');
  const water = flatGround(0, () => ({ type: 'water', friction: 0.0 }));
  st = drop(1.0, true, water);
  checkTrue('touchdown on water: crash', st.crashed && /water|ditch/i.test(st.crashReason), st.crashReason || 'no crash', 'water contact');
  {
    // terrain: fly level at 200 m into a ridge 400 m high, 3 km ahead
    const ridge = { heightAt: (x, z) => (z < -3000 ? 400 : 0), normalAt: (x, z, o) => o.set(0, 1, 0), surfaceAt: () => ({ type: 'ground', friction: 0.5 }) };
    const fdm = newFdm(ridge);
    const r = fdm.reset({ x: 0, y: 200, z: 0, heading_deg: 0, on_ground: false, speed_ms: 200 });
    const s2 = fdm.state;
    const inp = { ...base(), throttle: r.throttle, gearHandle: false };
    for (let i = 0; i < 30 * 60 && !s2.crashed; i++) fdm.step(DT, inp);
    checkTrue('flight into terrain: crash', s2.crashed, s2.crashReason || 'no crash', 'airframe points against the terrain');
  }
  {
    // overstress: the same jet with the g limiter switched off, full pull at 600 KCAS
    const cfg = { ...CONFIG, fcs: { ...CONFIG.fcs, nMax: 40, cstarUp: 40, pitchRateMax: 3 } };
    const fdm = newFdm(seaLevelLand, cfg);
    airSpawn(fdm, 600, 2000);
    const s3 = fdm.state;
    const inp = { ...base(), throttle: 0.75, gearHandle: false, pitch: 1 };
    let nMax = 0;
    for (let i = 0; i < 5 * 60 && !s3.crashed; i++) { fdm.step(DT, inp); nMax = Math.max(nMax, s3.gLoad); }
    checkTrue('overstress (g limiter disabled): structural failure', s3.crashed && /structural/i.test(s3.crashReason), s3.crashReason || `no crash, peak ${nMax.toFixed(1)} g`, '1.5 x the 9 g limit');
  }
  {
    // tail strike: over-rotate on the runway (attitude law bypassed by a custom 20 deg takeoff pitch)
    const cfg = { ...CONFIG, fcs: { ...CONFIG.fcs, takeoffPitch: 20 * D2R, rotationRate: 15 * D2R } };
    const fdm = newFdm(runwayGround, cfg);
    fdm.reset({ x: 0, y: RWY.elev, z: RWY.zSouth - 50, heading_deg: 0, on_ground: true, fuel: 0.9 });
    const s4 = fdm.state;
    const inp = { ...base(), throttle: 0.75 };
    for (let i = 0; i < 40 * 60 && !s4.crashed; i++) { inp.pitch = s4.ias_kt > 125 ? 1 : 0; fdm.step(DT, inp); if (!s4.onGround && s4.agl > 5) break; }
    checkTrue('over-rotation on the runway: tail strike', s4.crashed && /tail/i.test(s4.crashReason), s4.crashReason || 'no crash', 'nozzle hits ~15 deg nose-up on the gear');
  }
};

// ==============================================================================================
tests.robust = () => {
  section('Robustness: random full-deflection inputs with jittery frame times; zoom to zero airspeed');
  const finite = (st) => [st.position.x, st.position.y, st.position.z, st.quaternion.x, st.quaternion.y, st.quaternion.z,
    st.quaternion.w, st.velocity.x, st.velocity.y, st.velocity.z, st.alpha, st.beta, st.ias, st.mach, st.gLoad, st.heading,
    st.pitch, st.roll, st.engine.thrust, st.controls.stick_pitch, st.controls.stick_roll, st.controls.pedals].every(Number.isFinite);
  let seed = 20261101;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const hills = { heightAt: (x, z) => 50 + 30 * Math.sin(x / 700) * Math.cos(z / 900), surfaceAt: () => ({ type: 'ground', friction: 0.5 }) };
  let allFinite = true, aMax = 0, rateMax = 0, flown = 0;
  for (const sp of [{ y: 3000, speed_ms: 250 }, { y: 6000, speed_ms: 120 }, { y: 1500, speed_ms: 75, gear: true }]) {
    const fdm = newFdm(hills);
    const r = fdm.reset({ x: 0, z: 0, heading_deg: 0, on_ground: false, ...sp });
    const st = fdm.state;
    const inp = { ...base(), throttle: r.throttle, gearHandle: !!sp.gear };
    for (let i = 0; i < 60 * 60 && !st.crashed; i++) {
      if (i % 30 === 0) {
        inp.pitch = rnd() < 0.3 ? 0 : rnd() * 2 - 1;
        inp.roll = rnd() < 0.3 ? 0 : rnd() * 2 - 1;
        inp.yaw = rnd() < 0.5 ? 0 : rnd() * 2 - 1;
        if (rnd() < 0.2) inp.throttle = rnd();
      }
      const dt = DT * (0.5 + rnd());
      fdm.step(dt, inp);
      flown += dt;
      if (!finite(st)) { allFinite = false; break; }
      if (!st.crashed) { aMax = Math.max(aMax, Math.abs(st.alpha * R2D)); rateMax = Math.max(rateMax, Math.abs(st.p), Math.abs(st.q), Math.abs(st.r)); }
    }
  }
  // zoom: pull to the vertical at 450 KCAS with the engine at idle, then let go until the speed is gone
  const fdm = newFdm(seaLevelLand);
  airSpawn(fdm, 450, 2000);
  const st = fdm.state;
  const inp = { ...base(), throttle: 0, gearHandle: false, pitch: 0.8 };
  let t = 0, vMin = 1e9, aZoom = 0;
  while (st.pitch < 80 * D2R && t < 20) { fdm.step(DT, inp); t += DT; }
  inp.pitch = 0;
  for (let i = 0; i < 60 * 60 && !st.crashed; i++) {
    fdm.step(DT, inp);
    if (!finite(st)) { allFinite = false; break; }
    vMin = Math.min(vMin, st.tas);
    aZoom = Math.max(aZoom, Math.abs(st.alpha * R2D));
  }
  info(`random inputs: ${flown.toFixed(0)} s flown, max |AoA| ${aMax.toFixed(1)} deg, max body rate ${(rateMax * R2D).toFixed(0)} deg/s;`
    + ` zoom: min TAS ${vMin.toFixed(0)} m/s, max |AoA| ${aZoom.toFixed(1)} deg, then ${st.ias_kt.toFixed(0)} KIAS at ${st.altitude.toFixed(0)} m`);
  checkTrue('state stays finite', allFinite, allFinite ? 'yes' : 'NaN/Infinity found', 'any input sequence, any frame time');
  check('AoA under random inputs (normal mode)', aMax, 0, 26.5, 'deg', 'carefree handling: the 25 deg limit holds whatever the stick does');
  check('AoA in the zoom to zero airspeed', aZoom, 0, 30, 'deg', 'the limiter keeps flying the jet as the speed goes');
  checkTrue('zoom recovers to flying speed', !st.crashed && st.ias_kt > 100, `${st.ias_kt.toFixed(0)} KIAS`, 'nose falls through, the jet flies out');
};

// ==============================================================================================
tests.energy = () => {
  section('No energy gain without thrust (engine out, 3,000 m, 350 KCAS, manoeuvring)');
  const fdm = newFdm(seaLevelLand);
  airSpawn(fdm, 350, 3000, { fuelKg: 0 });
  const st = fdm.state;
  const inp = { ...base(), throttle: 0.75, gearHandle: false };
  const E0 = energy(st);
  let Eprev = E0, maxRise = 0, t = 0;
  const plan = [[5, 0, 0], [4, 1, 0], [3, 0, 0], [2, 0, 1], [3, 0, -1], [4, 0.5, 0], [3, -0.6, 0], [10, 0, 0], [3, 1, 0.5], [8, 0, 0]];
  for (const [dur, p, r] of plan) {
    inp.pitch = p; inp.roll = r;
    for (let i = 0; i < dur * 60; i++) {
      fdm.step(DT, inp);
      t += DT;
      const E = energy(st);
      maxRise = Math.max(maxRise, E - Eprev);
      Eprev = E;
    }
  }
  info(`engine ${st.engine.running ? 'running' : 'out'} (thrust ${(st.engine.thrust / 1000).toFixed(1)} kN), ${t.toFixed(0)} s:`
    + ` energy ${(E0 / 1e6).toFixed(1)} -> ${(energy(st) / 1e6).toFixed(1)} MJ, largest one-frame rise ${(maxRise / 1e3).toFixed(3)} kJ`);
  check('largest rise of mechanical energy in one frame', maxRise / E0 * 1e6, -1e9, 1, 'ppm', 'only drag acts along the path: energy can only fall');
  check('energy at the end vs start', energy(st) / E0, 0, 0.999, '', 'net loss');
  checkTrue('no crash', !st.crashed, st.crashReason || 'ok', '');
};

// ------------------------------------------------------------------------------ run
const t0 = Date.now();
console.log(`F-35I flight model tests (config "${CONFIG.name}", ${CONFIG.substepHz} Hz physics, frames of ${(DT * 1000).toFixed(1)} ms)`);
for (const [name, fn] of Object.entries(tests)) {
  if (only && !only.has(name)) continue;
  try { fn(); } catch (e) { results.push({ name, ok: false }); console.log(`   FAIL  ${name}: exception ${e.stack}`); }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`
  + (failed.length ? `; FAILED: ${failed.map((r) => r.name).join('; ')}` : ''));
process.exit(failed.length ? 1 : 0);
