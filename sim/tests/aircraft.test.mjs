// Rig playback checks for js/aircraft/rig.js against the exported f35i_rig.json (no browser).
//
//   node --import ./sim/tests/node-three.mjs sim/tests/aircraft.test.mjs [path/to/f35i_rig.json]
//
// Builds stand-in nodes at their rest positions and checks the directions and sizes of the main
// motions (model frame: +X left, +Y up, +Z forward), clamping, composition and the morph.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { RigPlayer, locate, interp } from '../js/aircraft/rig.js';
import { InfoPoint } from '../js/aircraft/AircraftVisual.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RIG_PATH = process.argv[2] && process.argv[2].endsWith('.json')
  ? process.argv[2] : path.join(HERE, '..', 'data', 'aircraft', 'f35i_rig.json');
const rig = JSON.parse(readFileSync(RIG_PATH, 'utf8'));

/** Stand-in scene: an Object3D per rig node (and a mesh with the morph target for the nozzle). */
function makeScene() {
  const root = new THREE.Group();
  for (const [name, nd] of Object.entries(rig.nodes)) {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.fromArray(nd.rest);
    root.add(o);
  }
  for (const [name, targets] of Object.entries(rig.morphs || {})) {
    const m = new THREE.Mesh(new THREE.BufferGeometry());
    m.name = name;
    m.morphTargetDictionary = {};
    m.morphTargetInfluences = [];
    Object.keys(targets).forEach((t, i) => { m.morphTargetDictionary[t] = i; m.morphTargetInfluences.push(0); });
    root.add(m);
  }
  return root;
}

function fresh() {
  const root = makeScene();
  const player = new RigPlayer(rig, root);
  return { root, player, node: (n) => root.getObjectByName(n) };
}

/** Where a point given relative to a node's rest position ends up (model frame). */
function moved(o, rel) {
  return new THREE.Vector3(...rel).applyQuaternion(o.quaternion).add(o.position);
}
function restOf(name) { return new THREE.Vector3(...rig.nodes[name].rest); }
const angle = (o) => 2 * Math.acos(Math.min(1, Math.abs(o.quaternion.w)));

test('interpolation helpers', () => {
  assert.deepEqual(locate([0, 1, 2], -1), [0, 0]);
  assert.deepEqual(locate([0, 1, 2], 5), [1, 1]);
  assert.deepEqual(locate([0, 1, 2], 1.5), [1, 0.5]);
  assert.equal(interp([0, 1], [10, 20], 0.25), 12.5);
  const p = new InfoPoint(1, 2, 3);
  assert.equal(p[0], 1); assert.equal(p[2], 3); assert.equal(p.y, 2);
});

test('rig file sanity', () => {
  assert.equal(rig.format, 'f35i-rig');
  for (const c of ['stick_pitch', 'stick_roll', 'pedals', 'throttle', 'flaps', 'speedbrake', 'gear', 'nws',
    'roll_distance', 'weapon_bays', 'canopy', 'refuel_door', 'gun_door', 'tailhook']) {
    assert.ok(rig.controls[c], `control ${c}`);
  }
  const g = rig.info.gearContacts;
  assert.equal(g.length, 3);
  for (const w of g) {
    assert.ok(w.pos[1] < -1.5 && w.pos[1] > -2.5, `${w.name} contact height ${w.pos[1]}`);
    assert.ok(w.radius > 0.2 && w.radius < 0.6);
  }
  assert.ok(rig.info.eye[1] > 0.8 && rig.info.eye[2] < -3, 'eye ahead of the CG and above the reference line');
  assert.ok(Math.abs(rig.info.length - 15.7) < 0.3 && Math.abs(rig.info.span - 10.7) < 0.3);
  assert.ok(rig.info.nozzle.exit[2] > 5.5, 'nozzle at the back (+Z body)');
});

test('defaults leave every node at rest', () => {
  const { player, node } = fresh();
  assert.deepEqual(player.missing, []);
  for (const name of Object.keys(rig.nodes)) {
    const o = node(name);
    assert.ok(o.position.distanceTo(restOf(name)) < 1e-6, `${name} position`);
    assert.ok(angle(o) < 1e-6, `${name} rotation`);
  }
});

test('gear retracts into the wells and comes back', () => {
  const { player, node } = fresh();
  const wheels = ['MG_Wheel_L', 'MG_Wheel_R', 'NG_Wheel'];
  player.set({ gear: 0 });
  player.apply();
  for (const w of wheels) {
    const dy = node(w).position.y - restOf(w).y;
    assert.ok(dy > 0.6, `${w} rises ${dy.toFixed(2)} m`);
  }
  // left / right symmetric
  const l = node('MG_Wheel_L').position, r = node('MG_Wheel_R').position;
  assert.ok(Math.abs(l.x + r.x) < 1e-3 && Math.abs(l.y - r.y) < 1e-3 && Math.abs(l.z - r.z) < 1e-3, 'symmetric');
  player.set({ gear: 1 });
  player.apply();
  for (const w of wheels) assert.ok(node(w).position.distanceTo(restOf(w)) < 1e-5);
});

test('surfaces move the right way', () => {
  const { player, node } = fresh();
  const aft = [0, 0, -1.0];     // a point 1 m behind the hinge pivot (trailing edge side)
  // pull: stabilator trailing edges up (nose up)
  player.set({ stick_pitch: 1 }); player.apply();
  for (const s of ['Stabilator_L', 'Stabilator_R']) {
    const p = moved(node(s), aft);
    const rest = restOf(s).add(new THREE.Vector3(...aft));
    assert.ok(p.y - rest.y > 0.2, `${s} TE up on pull`);
  }
  // roll right: left flaperon TE down, right TE up
  player.set({ stick_pitch: 0, stick_roll: 1 }); player.apply();
  const fl = moved(node('Flaperon_L'), aft).y - (restOf('Flaperon_L').y);
  const fr = moved(node('Flaperon_R'), aft).y - (restOf('Flaperon_R').y);
  assert.ok(fl < -0.1 && fr > 0.1, `flaperons ${fl.toFixed(2)} ${fr.toFixed(2)}`);
  // yaw right: rudder trailing edges to the right (model -X)
  player.set({ stick_roll: 0, pedals: 1 }); player.apply();
  for (const s of ['Rudder_L', 'Rudder_R']) {
    const p = moved(node(s), aft);
    const rest = restOf(s).add(new THREE.Vector3(...aft));
    assert.ok(p.x - rest.x < -0.1, `${s} TE right on right pedal`);
  }
  // flaps: both flaperons down
  player.set({ pedals: 0, flaps: 1 }); player.apply();
  for (const s of ['Flaperon_L', 'Flaperon_R']) {
    assert.ok(moved(node(s), aft).y - restOf(s).y < -0.2, `${s} down with flaps`);
  }
});

test('stabilator mixing is clamped like the Blender driver', () => {
  const { player, node } = fresh();
  player.set({ stick_pitch: 1, stick_roll: 1 });
  player.apply();
  const lim = rig.nodes.Stabilator_L.hinge.max;
  for (const s of ['Stabilator_L', 'Stabilator_R']) assert.ok(angle(node(s)) <= lim + 1e-6, `${s} within limit`);
  assert.ok(Math.abs(angle(node('Stabilator_L')) - lim) < 1e-3 || Math.abs(angle(node('Stabilator_R')) - lim) < 1e-3);
});

test('canopy opens 40 degrees, nose up', () => {
  const { player, node } = fresh();
  player.set({ canopy: 1 });
  player.apply();
  const c = node('Canopy');
  assert.ok(Math.abs(angle(c) - THREE.MathUtils.degToRad(40)) < 0.01, `canopy ${angle(c)}`);
  const rearRel = [0, 0.5, -2.0];        // a point at the back of the canopy goes up
  assert.ok(moved(c, rearRel).y > restOf('Canopy').y + 0.5 + 0.5);
});

test('wheels spin with roll distance and follow the strut', () => {
  const { player, node } = fresh();
  const w = rig.info.gearContacts.find((g) => g.name === 'left');
  const d = Math.PI * w.radius;          // half a turn
  player.set({ roll_distance: d });
  player.apply();
  const o = node('MG_Wheel_L');
  assert.ok(Math.abs(angle(o) - Math.PI) < 0.02, `half a turn: ${angle(o)}`);
  assert.ok(o.position.distanceTo(restOf('MG_Wheel_L')) < 0.01, 'spins about its axle');
  player.set({ roll_distance: 0, strut_left: 0.1 });
  player.apply();
  const dy = o.position.y - restOf('MG_Wheel_L').y;
  assert.ok(Math.abs(dy - 0.1) < 0.01, `strut compression lifts the wheel ${dy}`);
  // combined: retracting gear and spin keep the wheel centre where gear alone puts it
  player.set({ strut_left: 0, gear: 0.5 }); player.apply();
  const p0 = o.position.clone();
  player.set({ roll_distance: 3.0 }); player.apply();
  assert.ok(o.position.distanceTo(p0) < 0.01, 'spin composes inside the retraction');
});

test('nozzle petals open with the burner', () => {
  const { player, root } = fresh();
  const m = root.getObjectByName('Nozzle');
  player.set({ throttle: 0.75 }); player.apply();
  assert.ok(m.morphTargetInfluences[0] < 0.01);
  player.set({ throttle: 1 }); player.apply();
  assert.ok(m.morphTargetInfluences[0] > 0.99);
  player.overrideMorph('AB_Open', 0.5); player.apply();
  assert.ok(Math.abs(m.morphTargetInfluences[0] - 0.5) < 1e-6);
});
