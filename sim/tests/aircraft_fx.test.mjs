// Checks of the aircraft's light, burner and vapour models (no browser):
//
//   node --import ./sim/tests/node-three.mjs sim/tests/aircraft_fx.test.mjs
//
// anti-collision flash pattern, nozzle opening at idle and its lag behind the lever, the burner's
// exposure compensation and day look, the light level (day / night from the sun, not the exposure),
// the condensation model (vapour at high g in humid low air, the cone near Mach 1, contrails high
// up), the contrail's ring buffer (it fades out before it runs out of points), the landing-light
// pool's visibility gain and roll-off.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { anticollPattern, AircraftLights } from '../js/aircraft/lights.js';
import { nozzleIdleOpen, lagThrottle, NOZZLE_TAU } from '../js/aircraft/AircraftVisual.js';
import { flameExposureComp, flameDayLook } from '../js/aircraft/Afterburner.js';
import { air, condensation, skyLogLux, darknessOf, fxEnv, Ribbon } from '../js/aircraft/fxshared.js';
import { FX_QUALITY } from '../js/aircraft/AircraftFX.js';
import { poolGain, poolFactor } from '../js/aircraft/LandingPool.js';

test('anti-collision beacons: one short flash a second each, top and bottom alternating', () => {
  let topOn = 0, botOn = 0, both = 0;
  const N = 10000;
  const out = [0, 0];
  for (let i = 0; i < N; i++) {
    const [t, b] = anticollPattern(i / 1000, out);        // 10 s at 1 ms
    if (t > 0.5) topOn++;
    if (b > 0.5) botOn++;
    if (t > 0.5 && b > 0.5) both++;
  }
  assert.ok(topOn > 400 && topOn < 1600, `top on ${topOn} ms in 10 s`);
  assert.ok(botOn > 400 && botOn < 1600, `bottom on ${botOn} ms in 10 s`);
  assert.equal(both, 0, 'never both at once');
  assert.equal(anticollPattern(0.3, out), out, 'fills the array it is given (no allocation)');
});

test('light level: from the sun, darkness 0 by day and at sunset, 1 after civil twilight', () => {
  for (let e = -20; e < 90; e += 0.5) assert.ok(skyLogLux(e + 0.5) >= skyLogLux(e), `monotonic at ${e} deg`);
  assert.ok(Math.abs(skyLogLux(90) - 5.1) < 0.05, 'noon ~120 klx');
  assert.ok(Math.abs(skyLogLux(-6) - 0.5) < 0.05, 'end of civil twilight ~3 lx');
  assert.equal(darknessOf(skyLogLux(60)), 0);
  assert.equal(darknessOf(skyLogLux(1.6)), 0, 'sunset scene (sun 1.6 deg up): still day');
  assert.ok(darknessOf(skyLogLux(-1.2)) < 0.3, 'dusk: mostly day');
  assert.equal(darknessOf(skyLogLux(-6.5)), 1, 'night');
  // the same answer from an elevation or a sun direction (no exposure involved)
  fxEnv.update({ sunElevationDeg: -4 });
  const d1 = fxEnv.darkness;
  const el = THREE.MathUtils.degToRad(-4);
  fxEnv.update({ sunDirection: new THREE.Vector3(Math.cos(el), Math.sin(el), 0) });
  assert.ok(Math.abs(fxEnv.darkness - d1) < 1e-9);
  fxEnv.update({ sunElevationDeg: 45 });
});

test('light glows: no night gain by day, strong at night', () => {
  assert.equal(AircraftLights.nightGain(0), 1);
  assert.ok(AircraftLights.nightGain(1) > 100);
  assert.ok(AircraftLights.nightGain(0.5) < AircraftLights.nightGain(1));
});

test('nozzle: open at idle, closed at MIL', () => {
  assert.ok(nozzleIdleOpen(0) > 0.7);
  assert.ok(nozzleIdleOpen(0.75) < 0.01);
  assert.ok(nozzleIdleOpen(0.3) < nozzleIdleOpen(0.1));
});

test('nozzle: the petals follow the engine, lagging the lever', () => {
  assert.equal(lagThrottle(null, 0.4, 0.016), 0.4, 'starts at the lever');
  let e = 0.1;
  for (let i = 0; i < 6; i++) e = lagThrottle(e, 1, 1 / 60);          // 0.1 s after a slam
  assert.ok(e < 0.2, `0.1 s after the slam: ${e.toFixed(3)}`);
  for (let i = 0; i < 60 * 6; i++) e = lagThrottle(e, 1, 1 / 60);
  assert.ok(e > 0.98, `6 s after: ${e.toFixed(3)}`);
  assert.ok(NOZZLE_TAU >= 1 && NOZZLE_TAU <= 1.5);
});

test('burner: display brightness grows only with the 4th root of the exposure', () => {
  const display = (e) => flameExposureComp(e) * e;      // what the tone mapper sees
  assert.ok(Math.abs(display(0.93) - 1) < 1e-9);
  assert.ok(display(40) / display(0.93) < 3, 'night flame not a white ball');
  assert.ok(display(40) > display(0.93), 'but brighter than by day');
});

test('burner: day look by the light level (sun elevation), not by the exposure', () => {
  assert.equal(flameDayLook(skyLogLux(60)), 1);
  assert.ok(flameDayLook(skyLogLux(1.6)) > 0.9, 'sunset scene: day look');
  assert.equal(flameDayLook(skyLogLux(-4)), 0, 'dusk, sun 4 deg down: night look');
});

test('air: warm humid coast, cold dry high', () => {
  const lo = air(100), hi = air(10000);
  assert.ok(lo.Tc > 15 && lo.Tc < 30 && lo.rh > 0.5);
  assert.ok(hi.Tc < -40 && hi.rh < 0.2);
  assert.ok(lo.dewDep > 3 && lo.dewDep < 12);
});

test('condensation: vapour in a 7 g turn low, none in 1 g cruise', () => {
  const st = (o) => ({ tas: 200, qbar: 0.5 * 1.18 * 200 * 200, mach: 0.6, altitude: 350, gLoad: 1, onGround: false, ...o });
  const turn = condensation(st({ gLoad: 7 }));
  assert.ok(turn.vortex > 0.9 && turn.wing > 0.5, JSON.stringify(turn));
  const cruise = condensation(st({ gLoad: 1 }));
  assert.ok(cruise.vortex < 0.05 && cruise.wing < 0.05, JSON.stringify(cruise));
  // reuses the object it is given
  const out = { air: {} };
  const airObj = out.air;
  assert.equal(condensation(st({ gLoad: 7 }), undefined, out), out);
  assert.equal(out.air, airObj);
  assert.ok(out.vortex > 0.9);
});

test('condensation: the vapour cone near Mach 1 low over the sea, not at Mach 0.8 or 1.2', () => {
  const st = (M) => ({ tas: M * 345, qbar: 0.5 * 1.2 * (M * 345) ** 2, mach: M, altitude: 100, gLoad: 1, onGround: false });
  assert.ok(condensation(st(0.98)).cone > 0.5);
  assert.ok(condensation(st(0.8)).cone < 0.01);
  assert.ok(condensation(st(1.2)).cone < 0.01);
});

test('condensation: contrail above ~9 km, none low or on the ground', () => {
  const st = (h, o = {}) => ({ tas: 250, qbar: 9000, mach: 0.85, altitude: h, gLoad: 1, onGround: false, ...o });
  assert.ok(condensation(st(10000)).contrail > 0.9);
  assert.ok(condensation(st(3000)).contrail < 0.01);
  assert.ok(condensation(st(10000, { onGround: true })).contrail === 0);
});

test('contrail: its points cover the whole life at any speed, the end fades out', () => {
  for (const V of [120, 250, 600]) {
    const r = new Ribbon({ max: 160, spacing: 20, life: 25, fadeIn: 0.15, fadeOut: 0.6 });
    const p = new THREE.Vector3();
    let t = 0;
    for (let i = 0; i < 60 * 40; i++) { t += 1 / 60; p.set(0, 10000, -V * t); r.push(p, t, 1, V); }
    r.build(t, new THREE.Vector3(0, 10050, -V * t));
    const pts = r.points();
    const oldest = t - pts[0].t;
    assert.ok(oldest > 24, `${V} m/s: the oldest point is ${oldest.toFixed(1)} s old (life 25 s)`);
    assert.ok(r.alphaAt(0, t) < 0.05, `${V} m/s: the end fades out (alpha ${r.alphaAt(0, t).toFixed(3)})`);
    let maxStep = 0;
    for (let k = 1; k < r.count; k++) maxStep = Math.max(maxStep, r.alphaAt(k, t) - r.alphaAt(k - 1, t));
    assert.ok(maxStep < 0.15, `${V} m/s: no step in alpha along the trail (${maxStep.toFixed(3)})`);
  }
});

test('quality table: every level, the burner steps and the cone shells grow with quality', () => {
  for (const q of ['low', 'medium', 'high']) assert.ok(FX_QUALITY[q], q);
  assert.ok(FX_QUALITY.low.abSteps < FX_QUALITY.medium.abSteps && FX_QUALITY.medium.abSteps < FX_QUALITY.high.abSteps);
  assert.ok(FX_QUALITY.low.shells >= 1 && FX_QUALITY.low.shells <= FX_QUALITY.medium.shells
    && FX_QUALITY.medium.shells <= FX_QUALITY.high.shells);
});

test('landing-light pool: physics only by day and at dusk, a visibility gain in the dark', () => {
  assert.equal(poolGain(skyLogLux(79)), 1);                   // noon
  assert.ok(poolGain(skyLogLux(1.6)) < 1.001, 'sunset: physics only');
  assert.ok(poolGain(skyLogLux(-1.24)) < 1.05, 'dusk: physics only');
  assert.ok(poolGain(skyLogLux(-10)) > 250, 'night');
  // roll-off: grows with the lamp's light, ever slower (a lit runway, not a white wedge)
  const L = skyLogLux(-12);
  assert.ok(poolFactor(1, L) < poolFactor(2, L));
  assert.ok(poolFactor(2, L) - poolFactor(1, L) < poolFactor(1, L) - poolFactor(0, L));
  assert.ok(poolFactor(10, L) < 300, `bounded: ${poolFactor(10, L).toFixed(0)}`);
  assert.equal(poolFactor(0, L), 1);
});
