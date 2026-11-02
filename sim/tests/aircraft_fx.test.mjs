// Checks of the aircraft's light, burner and vapour models (no browser):
//
//   node --import ./sim/tests/node-three.mjs sim/tests/aircraft_fx.test.mjs
//
// anti-collision flash pattern, nozzle opening at idle and its lag behind the lever, the burner's
// exposure compensation, day look and night look (a fixed picture level), the light level (day /
// night from the sun, not the exposure), the rule for lights at night (Environment.js lightGain) and
// the point lights' visibility floor, the condensation model (vapour at high g in humid low air, the
// cone near Mach 1, contrails high up), the contrail's ring buffer (it fades out before it runs out
// of points), the landing-light pool's roll-off.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { anticollPattern, AircraftLights } from '../js/aircraft/lights.js';
import { nozzleIdleOpen, lagThrottle, NOZZLE_TAU } from '../js/aircraft/AircraftVisual.js';
import { flameExposureComp, flameDayLook, Afterburner, FLAME_DAY, FLAME_NIGHT, throatGlow } from '../js/aircraft/Afterburner.js';
import { air, condensation, skyLogLux, darknessOf, fxEnv, Ribbon } from '../js/aircraft/fxshared.js';
import { FX_QUALITY } from '../js/aircraft/AircraftFX.js';
import { poolFactor, POOL_KNEE } from '../js/aircraft/LandingPool.js';
import { artificialLightGain, lightNight, pointLightThreshold, NIGHT_ADAPTED_EXPOSURE } from '../js/env/Environment.js';

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

test('lights at night: physical by day and in the dusk, the same on screen at any night exposure', () => {
  assert.equal(artificialLightGain(0.93, 60), 1, 'noon');
  assert.equal(artificialLightGain(25, -2.35), 1, 'blue hour (sun 2.35 deg down): physical');
  assert.equal(lightNight(-3), 0);
  assert.equal(lightNight(-12), 1);
  for (const e of [40, 120, 285]) {
    const display = artificialLightGain(e, -20) * e;              // radiance x exposure per unit radiance
    assert.ok(Math.abs(display - NIGHT_ADAPTED_EXPOSURE) < 1e-6, `exposure ${e}: ${display}`);
  }
  // in between, never below the physical light and never more than the night's
  for (let el = -8; el <= 0; el += 0.5) {
    const g = artificialLightGain(150, el);
    assert.ok(g >= 1 && g <= NIGHT_ADAPTED_EXPOSURE / 150 + 1e-9, `sun ${el}: ${g}`);
  }
  // a point light is seen against a darker ground with less light at the eye
  assert.ok(pointLightThreshold(-20) < pointLightThreshold(-4) && pointLightThreshold(-4) < pointLightThreshold(30));
});

test('light glows: a point many times over the threshold stays a visible dot, none below it', () => {
  assert.equal(AircraftLights.visibleFloor(1), 0, 'at the threshold');
  assert.equal(AircraftLights.visibleFloor(0.2), 0);
  assert.ok(AircraftLights.visibleFloor(8) >= 0.3, 'three stops over: a clear dot');
  assert.ok(AircraftLights.visibleFloor(4) < AircraftLights.visibleFloor(8));
  assert.ok(AircraftLights.visibleFloor(1e6) <= 0.85, 'never a white blob');
});

test('light glows: at night a centre no brighter on the display than any point light, by day as it was', () => {
  assert.equal(AircraftLights.coreCap(0.93, 1, 0), Infinity, 'noon: no cap');
  assert.equal(AircraftLights.coreCap(25, 1, 0), Infinity, 'blue hour before the lights take over');
  // a 40 cd tail light 18 m from the camera at night: ~1,000 on the display uncapped, 64 capped
  for (const e of [40, 230, 285]) {
    const cap = AircraftLights.coreCap(e, 1, 1);
    assert.ok(Math.abs(cap * e - 64) < 1e-9, `exposure ${e}: ${cap * e}`);
  }
  // a red light (brightest channel 1, the others low) the same by its brightest channel
  assert.ok(Math.abs(AircraftLights.coreCap(230, 0.9, 1) * 230 * 0.9 - 64) < 1e-9);
  // eased in: half way into the night the cap is twice as high
  assert.ok(Math.abs(AircraftLights.coreCap(230, 1, 0.5) / AircraftLights.coreCap(230, 1, 1) - 2) < 1e-9);
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

test('burner: noon draws the day table exactly, the night its own look (long, diamonds yellower than the body)', () => {
  const ab = new Afterburner({ exit: [0, 0.12, 6.205], radius: 0.47, radiusAB: 0.56, axis: [0, 0, 1],
    throat: [0, 0.12, 5.785], throatRadius: 0.405 });
  const u = ab.uniforms;
  ab._setLook(1);
  assert.deepEqual(u.uC1.value.toArray(), FLAME_DAY.c1);
  assert.deepEqual(u.uDiaCol.value.toArray(), FLAME_DAY.dia);
  assert.deepEqual(u.uSat.value.toArray(), FLAME_DAY.sat);
  assert.equal(u.uKappa.value, FLAME_DAY.kappa);
  assert.equal(u.uKnee.value, ab.shoulder.knee);
  ab._setLook(0);
  assert.deepEqual(u.uC2.value.toArray(), FLAME_NIGHT.c2);
  assert.equal(u.uDia.value.x, FLAME_NIGHT.diaShape[0]);
  assert.ok(FLAME_NIGHT.length > FLAME_DAY.length);
  assert.ok(FLAME_NIGHT.dia[1] / FLAME_NIGHT.dia[0] > FLAME_NIGHT.c2[1] / FLAME_NIGHT.c2[0], 'diamonds yellower');
  assert.ok(FLAME_NIGHT.lip[2] > FLAME_NIGHT.lip[0], 'a blue-violet sheath');
  // the idle throat at night: a dull red-orange, the burner's throat a bright yellow-white
  const idle = throatGlow(FLAME_NIGHT, 0, 0, 1);
  assert.ok(idle[0] > 0.03 && idle[0] < 0.1 && idle[1] < 0.3 * idle[0] && idle[2] < idle[1], `idle ${idle}`);
  const burner = throatGlow(FLAME_NIGHT, 1, 1, 1);
  assert.ok(burner[0] > 1 && burner[1] > 0.5 * burner[0], `burner ${burner}`);
  // noon's engine heat as before (only the dark shows it)
  const noon = throatGlow(FLAME_DAY, 0, 0, 0);
  assert.ok(Math.abs(noon[0] - 0.012 * 0.15) < 1e-12);
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

test('landing-light pool: physical by day and at dusk, the rule for lights at night, a soft roll-off', () => {
  // gain 1 (day, dusk): nearly the physical 1 + E_lamp / E_amb
  assert.ok(Math.abs(poolFactor(0.5, 1) - 1.5) < 0.01, 'physical');
  assert.equal(poolFactor(0, 6), 1);
  // at night (lightGain ~6 at exposure 230) the lamp counts six times over the moonlit ground
  const g = artificialLightGain(230, -20);
  assert.ok(poolFactor(1, g) > 5 && poolFactor(1, g) < 1 + g + 1e-9);
  // roll-off: grows with the lamp's light, ever slower (a lit runway, not a white wedge)
  assert.ok(poolFactor(1, g) < poolFactor(2, g));
  assert.ok(poolFactor(2, g) - poolFactor(1, g) < poolFactor(1, g) - poolFactor(0, g));
  assert.ok(poolFactor(100, g) < 1 + POOL_KNEE * 3, `bounded: ${poolFactor(100, g).toFixed(0)}`);
});
