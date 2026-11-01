// Checks of the aircraft's light, burner and vapour models (no browser):
//
//   node --import ./sim/tests/node-three.mjs sim/tests/aircraft_fx.test.mjs
//
// anti-collision flash pattern, nozzle opening at idle, the burner's exposure compensation, the
// condensation model (vapour at high g in humid low air, the cone near Mach 1, contrails high up),
// the landing-light pool's visibility gain.

import test from 'node:test';
import assert from 'node:assert/strict';
import { anticollPattern, AircraftLights } from '../js/aircraft/lights.js';
import { nozzleIdleOpen } from '../js/aircraft/AircraftVisual.js';
import { flameExposureComp } from '../js/aircraft/Afterburner.js';
import { air, condensation } from '../js/aircraft/fxshared.js';
import { FX_QUALITY } from '../js/aircraft/AircraftFX.js';
import { poolGain } from '../js/aircraft/LandingPool.js';

test('anti-collision beacons: one short flash a second each, top and bottom alternating', () => {
  let topOn = 0, botOn = 0, both = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const [t, b] = anticollPattern(i / 1000);           // 10 s at 1 ms
    if (t > 0.5) topOn++;
    if (b > 0.5) botOn++;
    if (t > 0.5 && b > 0.5) both++;
  }
  assert.ok(topOn > 400 && topOn < 1600, `top on ${topOn} ms in 10 s`);
  assert.ok(botOn > 400 && botOn < 1600, `bottom on ${botOn} ms in 10 s`);
  assert.equal(both, 0, 'never both at once');
});

test('light glows: no night gain by day, strong at night', () => {
  assert.equal(AircraftLights.nightGain(0.93), 1);
  assert.ok(AircraftLights.nightGain(40) > 100);
});

test('nozzle: open at idle, closed at MIL', () => {
  assert.ok(nozzleIdleOpen(0) > 0.7);
  assert.ok(nozzleIdleOpen(0.75) < 0.01);
  assert.ok(nozzleIdleOpen(0.3) < nozzleIdleOpen(0.1));
});

test('burner: display brightness grows only with the 4th root of the exposure', () => {
  const display = (e) => flameExposureComp(e) * e;      // what the tone mapper sees
  assert.ok(Math.abs(display(0.93) - 1) < 1e-9);
  assert.ok(display(40) / display(0.93) < 3, 'night flame not a white ball');
  assert.ok(display(40) > display(0.93), 'but brighter than by day');
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

test('quality table: every level, the burner steps grow with quality', () => {
  for (const q of ['low', 'medium', 'high']) assert.ok(FX_QUALITY[q], q);
  assert.ok(FX_QUALITY.low.abSteps < FX_QUALITY.medium.abSteps && FX_QUALITY.medium.abSteps < FX_QUALITY.high.abSteps);
});

test('landing-light pool: invisible by day, faint at sunset, gentler than the glows at night', () => {
  assert.equal(poolGain(0.93), 1);                        // noon
  assert.ok(poolGain(12.7) > 3 && poolGain(12.7) < 6);   // sunset
  assert.ok(poolGain(40) > 30 && poolGain(40) < 60);     // night
  assert.ok(poolGain(40) < AircraftLights.nightGain(40) / 3);
});
