// Checks of the jet's own shadow (js/aircraft/JetShadow.js, exterior track) without a browser:
//
//   node --import ./sim/tests/node-three.mjs sim/tests/jet_shadow.test.mjs
//
// when the shadow map and the underside map are redrawn (a turn of the light at once; a part only
// for a change a texel shows and at most every partAge; the nozzle's slow creep and the stick's
// jitter not every frame), the depth-only pass (no colour cleared or written, the colour mask
// given back), the ground shadow's fade towards GROUND.maxAgl (no cut), one ground program on every
// tier, the jet's box down to the tyres whatever the pose it was made in, and one placeholder
// texture across quality changes. The passes themselves are counted, not drawn (a fake renderer).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { JetShadow, JET_SHADOW_QUALITY, GROUND } from '../js/aircraft/JetShadow.js';
import { exteriorUniforms } from '../js/aircraft/skin.js';

const H = 1 / 120;                         // the app's physics step: a 120 fps PC draws every one
const CONTROLS = ['stick_pitch', 'stick_roll', 'pedals', 'flaps', 'speedbrake', 'gear', 'nws', 'weapon_bays', 'canopy',
  'refuel_door', 'gun_door', 'tailhook', 'strut_nose', 'strut_left', 'strut_right'];

/** A stand-in for AircraftVisual: a 16 m x 11 m body and a gear leg (down: to the tyres' plane). */
function makeVisual({ gearDown = true } = {}) {
  const body = new THREE.Group();
  const root = new THREE.Group();
  body.add(root);
  const mat = new THREE.MeshStandardMaterial();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(11, 2, 16), mat));
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 0.3), mat);
  leg.position.y = gearDown ? -1.5 : -0.5;              // its bottom at -2.1 m (down) or -1.1 m (up)
  root.add(leg);
  const ctl = {};
  for (const k of CONTROLS) ctl[k] = 0;
  ctl.gear = gearDown ? 1 : 0;
  return {
    object3d: body, root, loaded: true,
    exterior: { uniforms: exteriorUniforms(), hookState: {} },
    info: { gearContacts: [{ name: 'nose', pos: new THREE.Vector3(0, -2.1, -4.5) }, { name: 'left', pos: new THREE.Vector3(-1.4, -2.12, 1) },
      { name: 'right', pos: new THREE.Vector3(1.4, -2.12, 1) }] },
    _ctl: ctl,
    _nozzleOpen: 0.3,
  };
}

/** The renderer calls the passes make, recorded. */
function fakeRenderer() {
  const log = [];
  const r = {
    log,
    autoClear: true,
    shadowMap: { enabled: true },
    info: { autoReset: true, render: { calls: 0 } },
    state: { buffers: { depth: { getReversed: () => false }, color: { setMask: (m) => log.push(['colorMask', m]) } } },
    _target: null,
    getRenderTarget() { return this._target; },
    setRenderTarget(t) { this._target = t; log.push(['target', t ? t.texture.name : null]); },
    getClearColor(c) { return c.set(0x123456); },
    getClearAlpha() { return 1; },
    setClearColor(c, a) { log.push(['clearColor', a]); },
    clear(c, d, s) { log.push(['clear', c, d, s]); },
    render(scene) { let n = 0; scene.traverseVisible((o) => { if (o.isMesh) n++; }); this.info.render.calls += n; log.push(['render', n]); },
  };
  return r;
}

function makeEnv(sun = new THREE.Vector3(0, 0.8, 0.6)) {
  return {
    lightDirection: sun.clone().normalize(),
    sunLight: { castShadow: true, color: new THREE.Color(1, 1, 1) },
    uniforms: { uAmbient: { value: new THREE.Color(0.25, 0.3, 0.4) } },
  };
}

/** A JetShadow whose two passes are counted (at the clock's time), not drawn. */
function makeShadow(visual, quality = 'high') {
  const js = new JetShadow({ visual, terrain: { heightAt: () => 0 } });
  js.setQuality(quality);
  js.clock = 0;
  js.draws = [];
  js.aoDraws = [];
  js._render = function () { this.draws.push(this.clock); this.redraws++; };
  js._renderAO = function () { this.aoDraws.push(this.clock); this.aoRedraws++; };
  return js;
}

/** `seconds` of frames at 120 fps; `each(t)` sets the jet's state before every frame. */
function run(js, renderer, env, seconds, each = null) {
  const n = Math.round(seconds / H);
  for (let i = 0; i < n; i++) {
    js.clock += H;
    if (each) each(js.clock);
    js.update(renderer, env, H);
  }
}

const gaps = (t) => t.slice(1).map((x, i) => x - t[i]);
/** The body at a height of its tyres' plane above the (flat, 0 m) ground. */
const atAgl = (v, js, agl) => { v.object3d.position.y = agl - js.groundY; };

test('the nozzle creeping after a throttle change does not redraw the map every frame', () => {
  const v = makeVisual(), r = fakeRenderer(), env = makeEnv();
  const js = makeShadow(v);
  atAgl(v, js, 3000);
  run(js, r, env, 0.1);
  const n0 = js.draws.length, by0 = { ...js.redrawBy };
  assert.equal(by0.first, 1, 'the first frame draws it');
  // AircraftVisual's lagged throttle: 0.2 of AB_Open over ~1.3 s, creeping for seconds
  run(js, r, env, 8, (t) => { v._nozzleOpen = 0.3 + 0.2 * (1 - Math.exp(-t / 1.3)); });
  const n = js.draws.length - n0, parts = js.redrawBy.parts - by0.parts;
  // 0.2 of travel in steps of 0.02: about 10 part redraws, plus one every 2 s (the old rule, 1e-3: ~200)
  assert.ok(parts >= 5 && parts <= 11, `${parts} part redraws`);
  assert.ok(n <= parts + 4, `${n} redraws in 8 s`);
  assert.ok(Math.min(...gaps(js.draws.slice(n0))) >= JET_SHADOW_QUALITY.high.partAge - 1e-9, 'at most every partAge');
});

test('the stick\'s jitter (under a texel) redraws nothing but the 2 s refresh', () => {
  const v = makeVisual(), r = fakeRenderer(), env = makeEnv();
  const js = makeShadow(v);
  atAgl(v, js, 3000);
  v._ctl.stick_pitch = 0.2;                                 // trimmed: the map drawn there
  run(js, r, env, 0.1);
  const by0 = { ...js.redrawBy };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  run(js, r, env, 5, () => { v._ctl.stick_pitch = 0.2 + 0.005 * rnd(); v._ctl.stick_roll = 0.004 * rnd(); v._ctl.pedals = 0.005 * rnd(); });
  assert.equal(js.redrawBy.parts - by0.parts, 0, 'no part redraws');
  assert.equal(js.redrawBy.turn - by0.turn, 0, 'no turn redraws');
  assert.ok(js.redrawBy.age - by0.age <= 2, `${js.redrawBy.age - by0.age} refreshes in 5 s`);
  // a real stick movement does redraw
  run(js, r, env, 0.2, () => { v._ctl.stick_pitch = 0.25; });
  assert.ok(js.redrawBy.parts - by0.parts >= 1, 'a stick movement of 0.05 redraws');
});

test('a turn of the light in the jet\'s frame redraws at once, a smaller one waits', () => {
  for (const q of ['high', 'medium']) {
    const v = makeVisual(), r = fakeRenderer(), env = makeEnv(new THREE.Vector3(0, 0.8, 0.6));
    const js = makeShadow(v, q);
    atAgl(v, js, 3000);
    run(js, r, env, 0.5);
    const n0 = js.draws.length, turn = JET_SHADOW_QUALITY[q].turn;
    // a roll about the body's x axis (the light at right angles to it): the light turns by the angle
    v.object3d.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.6 * turn);
    run(js, r, env, H);
    assert.equal(js.draws.length, n0, `${q}: 0.6 of the threshold: no redraw`);
    v.object3d.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2 * turn);
    run(js, r, env, H);
    assert.equal(js.draws.length, n0 + 1, `${q}: past the threshold: redrawn in the same frame`);
    assert.equal(js.redrawBy.turn, 1);
  }
});

test('a moving part (the gear) redraws at most every partAge', () => {
  const v = makeVisual(), r = fakeRenderer(), env = makeEnv();
  const js = makeShadow(v);
  atAgl(v, js, 200);
  run(js, r, env, 0.5);
  const n0 = js.draws.length;
  run(js, r, env, 3, (t) => { v._ctl.gear = Math.max(0, 1 - (t - 0.5) / 3); });
  const d = js.draws.slice(n0);
  assert.ok(Math.min(...gaps(d)) >= JET_SHADOW_QUALITY.high.partAge - 1e-9, `min gap ${Math.min(...gaps(d))} s`);
  assert.ok(d.length >= 45 && d.length <= 61, `${d.length} redraws over the 3 s retraction`);
});

test('the underside map: drawn once in the air (its program built by the warm-up), then only near the ground', () => {
  const v = makeVisual(), r = fakeRenderer(), env = makeEnv();
  const js = makeShadow(v);
  atAgl(v, js, 100);
  run(js, r, env, 3, (t) => { v._ctl.gear = Math.max(0, 1 - t / 3); v._nozzleOpen = 0.3 + 0.1 * t; });
  assert.equal(js.aoDraws.length, 1, 'the first frame only, in the air');
  // low over the ground (the occlusion is used below 14 m): redrawn while parts move, twice a second at most
  atAgl(v, js, 4);
  run(js, r, env, 3, (t) => { v._ctl.gear = Math.min(1, (t - 3) / 3); });
  const ao = js.aoDraws.slice(1);
  assert.ok(ao.length >= 4 && ao.length <= 6, `${ao.length} underside redraws in 3 s near the ground`);
  assert.ok(Math.min(...gaps(ao)) > 0.5 - 1e-9, 'at most twice a second');
  // stopped: one more to catch the last pose, then none
  run(js, r, env, 1);
  const k = js.aoDraws.length;
  assert.ok(k - 1 - ao.length <= 1, 'one catch-up redraw at most');
  run(js, r, env, 3);
  assert.equal(js.aoDraws.length, k, 'nothing moved: not redrawn');
});

test('the ground shadow fades out towards GROUND.maxAgl instead of vanishing in one frame', () => {
  const v = makeVisual(), r = fakeRenderer(), env = makeEnv(new THREE.Vector3(-0.12, 0.98, 0.14));   // Tel Nof at 12:30
  const js = makeShadow(v);
  const at = (agl) => { atAgl(v, js, agl); run(js, r, env, H); return js.ground.visible ? js.groundU.uGround.value.x : 0; };
  assert.equal(at(20), 1);
  assert.equal(at(0.7 * GROUND.maxAgl - 0.5), 1, 'full strength below 70 % of maxAgl');
  assert.ok(Math.abs(at(0.85 * GROUND.maxAgl) - 0.5) < 0.01, 'half way at 85 %');
  const near = at(GROUND.maxAgl - 0.3);
  assert.ok(near > 0 && near < 0.01, `just below maxAgl: ${near}`);
  at(GROUND.maxAgl + 1);
  assert.equal(js.ground.visible, false, 'off above maxAgl');
  let prev = at(30), worst = 0;
  for (let h = 30; h <= GROUND.maxAgl + 2; h += 0.1) { const x = at(h); worst = Math.max(worst, Math.abs(x - prev)); prev = x; }
  assert.ok(worst < 0.01, `largest change for 0.1 m of climb: ${worst.toFixed(4)}`);
});

test('one ground program on every tier: a quality change in flight builds no shader', () => {
  const v = makeVisual();
  const js = new JetShadow({ visual: v, terrain: { heightAt: () => 0 } });
  const version = js.groundMaterial.version;
  for (const q of ['medium', 'low', 'high', 'medium']) {
    js.setQuality(q);
    assert.equal(js.groundMaterial.defines.TAPS, 8, q);
  }
  assert.equal(js.groundMaterial.version, version, 'never marked for a rebuild');
  for (const q of ['medium', 'high']) assert.equal(JET_SHADOW_QUALITY[q].taps, 8, q);
});

test('the jet\'s box reaches the tyres\' plane even when made with the gear up (a menu in the air)', () => {
  const up = new JetShadow({ visual: makeVisual({ gearDown: false }), terrain: null });
  assert.ok(up.box.min.y <= up.groundY - 0.05 + 1e-9, `box bottom ${up.box.min.y.toFixed(3)}, tyres ${up.groundY.toFixed(3)}`);
  const down = new JetShadow({ visual: makeVisual({ gearDown: true }), terrain: null });
  assert.ok(Math.abs(down.box.min.y - (-2.1 - 0.25)) < 1e-6, 'gear down: the meshes\' own box (unchanged)');
});

test('one placeholder depth texture across quality changes (none made per change)', () => {
  const v = makeVisual(), r = fakeRenderer(), env = makeEnv();
  const U = v.exterior.uniforms, p0 = U.uF35Shadow.value;
  const js = makeShadow(v);
  run(js, r, env, H);
  assert.equal(U.uF35Shadow.value, js.target.depthTexture, 'the map bound on the first frame');
  const seen = new Set();
  for (const q of ['medium', 'high', 'low', 'medium', 'high']) {
    js.setQuality(q);
    seen.add(U.uF35Shadow.value);
    run(js, r, env, H);
    if (js.size) assert.equal(U.uF35Shadow.value, js.target.depthTexture, `${q}: its map bound`);
  }
  assert.equal(seen.size, 1, 'one placeholder');
  assert.ok(seen.has(p0), 'the skin\'s own');
});

test('the shadow map pass is depth only: no colour cleared or written, the colour mask given back', () => {
  const v = makeVisual(), r = fakeRenderer(), env = makeEnv();
  const js = new JetShadow({ visual: v, terrain: { heightAt: () => 0 } });
  const sprite = new THREE.Sprite();
  v.root.add(sprite);
  const mats = [];
  v.root.traverse((o) => { if (o.isMesh) mats.push([o, o.material]); });
  js.update(r, env, H);                                     // the first frame: allocate, then draw
  assert.equal(js.redraws, 1);
  assert.equal(js.depthMaterial.colorWrite, false);
  const i = r.log.findIndex((e) => e[0] === 'target' && e[1] === 'JetShadow' && r.log.indexOf(e) > 2);
  const pass = r.log.slice(i, r.log.findIndex((e, k) => k > i && e[0] === 'target'));
  assert.deepEqual(pass.find((e) => e[0] === 'clear'), ['clear', false, true, false], 'depth only');
  assert.ok(!pass.some((e) => e[0] === 'clearColor'), 'the clear colour untouched');
  const after = pass.findIndex((e) => e[0] === 'render');
  assert.ok(after > 0 && pass.slice(after).some((e) => e[0] === 'colorMask' && e[1] === true), 'colour mask on again after the pass');
  for (const [o, m] of mats) assert.equal(o.material, m, `${o.geometry.type}: its material back`);
  assert.equal(sprite.visible, true, 'what was hidden for the pass is shown again');
  assert.equal(r.shadowMap.enabled, true);
  assert.equal(r.autoClear, true);
});
