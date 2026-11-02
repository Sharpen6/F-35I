// The cockpit parts rebuilt at load time (js/aircraft/pcd/parts.js) against the glb, in node.
//
//   node --import ./sim/tests/node-three.mjs sim/tests/cockpit_parts.test.mjs
//
// * every part is built (no error, the expected draws), each in a task of its own;
// * the coaming's outline seen from the rig's eye against the helmet's line (js/ui/HMD.js
//   COAMING, which holds the flight path marker above it): not above it (0.03 deg, half a pixel),
//   nowhere more than 0.1 deg under it (exact rays through the rebuilt meshes, every 0.5 deg);
// * the canopy bow keeps the glb's band (no wider) and reads slimmer from the eye;
// * a part that fails half way leaves the glb's part exactly as it was (a transaction);
// * setEnabled(false) puts the glb's parts back exactly, setEnabled(true) the rebuilt ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(HERE, '..');
const GLB = path.join(SIM, 'data', 'aircraft', 'f35i.glb');
const RIG = path.join(SIM, 'data', 'aircraft', 'f35i_rig.json');
const DEG = Math.PI / 180;

globalThis.self ??= globalThis;
const quiet = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes("Couldn't load texture")) quiet(...a); };

const have = existsSync(GLB) && existsSync(RIG);
const { CockpitParts, STEPS, EXPECTED_DRAWS } = await import('../js/aircraft/pcd/parts.js');
const { bowRings, buildBow } = await import('../js/aircraft/pcd/frame.js');

const rig = have ? JSON.parse(readFileSync(RIG, 'utf8')) : null;
const buf = have ? readFileSync(GLB) : null;
async function load() {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}
/** A built set of parts on a fresh model (patch: changes to the instance before build()). */
async function built(patch = null) {
  const root = await load();
  const warns = [];
  const w = console.warn;
  console.warn = (...a) => { if (String(a[0]).includes('not rebuilt')) warns.push(a.join(' ')); else w(...a); };
  const p = new CockpitParts({ visual: { root, player: null, info: { raw: rig.info } } });
  if (patch) patch(p);
  try { await p.build(); } finally { console.warn = w; }
  root.updateMatrixWorld(true);
  return { root, p, warns };
}

// the design eye (glTF root frame: +X left, +Y up, +Z forward; the rig's body frame turned)
const EYE = have ? new THREE.Vector3(-rig.info.eye[0], rig.info.eye[1], -rig.info.eye[2]) : null;
const dirOf = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
const angles = (p) => { const d = p.clone().sub(EYE); return [Math.atan2(d.x, d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))]; };

/** The helmet's coaming line (HMD.js COAMING, body frame, mirrored as HMD.js does), as [az, el] (rad) by azimuth. */
function helmetLine() {
  const src = readFileSync(path.join(SIM, 'js', 'ui', 'HMD.js'), 'utf8');
  const m = /const COAMING = (\[[\s\S]*?\]);/.exec(src);
  assert.ok(m, 'HMD.js has its COAMING line');
  const C = JSON.parse(m[1].replace(/,\s*\]/g, ']'));
  for (let i = C.length - 2; i >= 0; i--) C.push([-C[i][0], C[i][1], C[i][2]]);
  return C.map(([x, y, z]) => angles(new THREE.Vector3(-x, y, -z))).sort((a, b) => a[0] - b[0]);
}
function lineAt(line, az) {
  for (let i = 0; i + 1 < line.length; i++) {
    const [a0, e0] = line[i], [a1, e1] = line[i + 1];
    if (az >= a0 && az <= a1 && a1 > a0) return e0 + (e1 - e0) * (az - a0) / (a1 - a0);
  }
  return null;
}

/** The highest elevation (rad) at azimuth az where a ray from the eye meets `meshes` (from `top` down to `bottom`). */
function outlineAt(ray, meshes, az, top, bottom, step) {
  let miss = top;
  for (let el = top; el >= bottom; el -= step) {
    ray.set(EYE, dirOf(az, el));
    if (ray.intersectObjects(meshes, false).length) {
      let lo = el, hi = miss;
      for (let k = 0; k < 18; k++) {
        const m = (lo + hi) / 2;
        ray.set(EYE, dirOf(az, m));
        if (ray.intersectObjects(meshes, false).length) lo = m; else hi = m;
      }
      return lo;
    }
    miss = el;
  }
  return null;
}

test('every cockpit part is rebuilt, in short tasks', { skip: !have && 'no glb (sim/data)' }, async () => {
  const { p, warns } = await built();
  for (const s of STEPS) assert.ok(p.stats[s] && !p.stats[s].err, `${s}: ${JSON.stringify(p.stats[s])}`);
  assert.deepEqual(warns, []);
  assert.equal(p.added.length, EXPECTED_DRAWS, p.added.map((m) => m.name).join(', '));
  assert.equal(p.stats.merged.draws, EXPECTED_DRAWS);
  // no bare-metal fastener material any more: heads are painted with their part
  assert.ok(p.added.every((m) => m.material.name !== 'F35_canopy_fastener'));
  console.log(`  build: ${p.stats.ms} ms in ${STEPS.length} tasks, the longest ${p.stats.maxTaskMs} ms`);
});

test("the coaming's outline from the eye is the helmet's line", { skip: !have && 'no glb (sim/data)' }, async () => {
  const { p } = await built();
  const meshes = p.added.filter((m) => /Coaming_(Hood|Pads)/.test(m.name));
  assert.equal(meshes.length, 2, 'the hood and the pads');
  const line = helmetLine();
  const ray = new THREE.Raycaster();
  // (the helmet's line is the glb's outline sampled every 1 deg: where it cuts a corner between two
  // samples, the pads' ends and the lip's rear corners, the parts follow the cut)
  let above = -Infinity, below = -Infinity;
  const rows = [];
  for (let a = -24.5; a <= 24.5 + 1e-9; a += 0.5) {
    const h = lineAt(line, a * DEG);
    const s = outlineAt(ray, meshes, a * DEG, -11 * DEG, -21 * DEG, 0.25 * DEG);
    assert.ok(h !== null && s !== null, `az ${a}: line ${h}, outline ${s}`);
    const d = (s - h) / DEG;
    rows.push(`${a.toFixed(1)}:${d.toFixed(3)}`);
    above = Math.max(above, d);
    below = Math.max(below, -d);
  }
  console.log(`  outline - helmet line (deg) by azimuth: ${rows.join(' ')}`);
  console.log(`  highest above ${above.toFixed(3)} deg, lowest below ${below.toFixed(3)} deg`);
  assert.ok(above <= 0.03, `the coaming stands above the helmet's line by ${above.toFixed(3)} deg`);
  assert.ok(below <= 0.1, `the coaming is ${below.toFixed(3)} deg under the helmet's line`);
});

test('the canopy bow keeps the glb band and reads slimmer from the eye', { skip: !have && 'no glb (sim/data)' }, async () => {
  const { root, p } = await built();
  let glb = null;
  root.traverse((o) => { if (o.isMesh && o.material.name === 'F35_canopy_bow' && !o.visible) glb = glb || o; });
  assert.ok(glb, 'the glb bow is hidden');
  const r = bowRings(glb.geometry);
  const h = r.rings.reduce((s, x) => s + x.half, 0) / r.rings.length;
  assert.ok(Math.abs(p.stats.bow.band - 2 * h) < 0.001, `band ${p.stats.bow.band} vs the glb's ${(2 * h).toFixed(4)}`);
  assert.equal(p.stats.bow.handholds, 2);
  // nothing of the rebuilt bow beyond the glb band's edges (the frame and the beads, ring by ring;
  // the handholds stand off the body's aft face)
  const parts = buildBow(r.rings);
  let over = 0;
  const v = new THREE.Vector3();
  for (const g of [parts.geometry, parts.beads]) {
    const P = g.attributes.position;
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      let best = null, bd = Infinity;
      for (const ring of r.rings) { const d = v.distanceToSquared(ring.o); if (d < bd) { bd = d; best = ring; } }
      const t = Math.abs(v.clone().sub(best.o).dot(best.t));
      over = Math.max(over, t - best.half);
    }
  }
  assert.ok(over < 0.0006, `the rebuilt bow reaches ${(over * 1000).toFixed(2)} mm past the glb band's edge`);
  const bow = p.added.filter((m) => /Canopy_Bow/.test(m.name));
  // its thickness from the eye at the top of the arch (straight ahead): the rebuilt bow and the glb's
  const ray = new THREE.Raycaster();
  const thick = (meshes) => {
    let lo = null, hi = null;
    for (let el = 5 * DEG; el <= 30 * DEG; el += 0.02 * DEG) {
      ray.set(EYE, dirOf(0, el));
      if (ray.intersectObjects(meshes, false).length) { if (lo === null) lo = el; hi = el; }
    }
    return lo === null ? 0 : (hi - lo) / DEG;
  };
  const tNew = thick(bow);
  glb.visible = true;
  const tGlb = thick([glb]);
  console.log(`  bow at the top of the arch from the eye: ${tNew.toFixed(2)} deg (the glb's ${tGlb.toFixed(2)})`);
  assert.ok(tNew > 4 && tNew < 6.2 && tNew < tGlb - 1, `the bow is ${tNew.toFixed(2)} deg thick from the eye (the glb's ${tGlb.toFixed(2)})`);
});

test('a part that fails leaves the glb part as it was', { skip: !have && 'no glb (sim/data)' }, async () => {
  const clean = await load();
  const tubOf = (root) => { let t = null; root.traverse((o) => { if (o.isMesh && o.material.name === 'F35_cockpit') t = t || o; }); return t; };
  const before = Array.from(tubOf(clean).geometry.index.array);
  // the coaming fails after it has cut the glb's shield out of the tub (in its change) and built
  // the hood: the tub keeps every triangle, the glb's pads stay, no hood
  const { root, p, warns } = await built((parts) => {
    const real = parts._coaming.bind(parts);
    parts._coaming = (ch) => { real(ch); throw new Error('injected'); };
  });
  assert.equal(p.stats.coaming.err, 'injected');
  assert.equal(warns.length, 1);
  assert.ok(!p.added.some((m) => /Coaming/.test(m.name)));
  let pad = null;
  root.traverse((o) => { if (o.isMesh && o.material.name === 'F35_glare_pad') pad = o; });
  assert.ok(pad.visible && !pad.userData.ckSkip, 'the glb pads are still there');
  // the tub lost only the bezel's frame (its own part), not the shield
  const tub = tubOf(root);
  const t = p.trimmed.find((x) => x.geometry === tub.geometry);
  assert.deepEqual(Array.from(t.index.array), before, 'the glb index is kept as it was');
  assert.equal(tub.geometry.index.count, before.length - p.stats.bezel.dropped * 3);
  // the other parts are there
  for (const s of STEPS.filter((x) => x !== 'coaming')) assert.ok(!p.stats[s].err, s);
});

test('setEnabled puts the glb parts back exactly, and the rebuilt ones again', { skip: !have && 'no glb (sim/data)' }, async () => {
  const clean = await load();
  const indexOf = (root) => {
    const out = new Map();
    root.traverse((o) => { if (o.isMesh && o.geometry.index) out.set(`${o.name}|${o.material.name}`, Array.from(o.geometry.index.array)); });
    return out;
  };
  const ref = indexOf(clean);
  const { root, p } = await built();
  const cut = indexOf(root);
  p.setEnabled(false);
  for (const [k, a] of indexOf(root)) if (ref.has(k)) assert.deepEqual(a, ref.get(k), k);
  assert.ok(p.added.every((m) => !m.visible) && p.hidden.every((m) => m.visible && !m.userData.ckSkip));
  p.setEnabled(true);
  for (const [k, a] of indexOf(root)) if (cut.has(k)) assert.deepEqual(a, cut.get(k), k);
  assert.ok(p.added.every((m) => m.visible) && p.hidden.every((m) => !m.visible && m.userData.ckSkip));
  p.dispose();
  assert.equal(p.added.length, 0);
  for (const [k, a] of indexOf(root)) if (ref.has(k)) assert.deepEqual(a, ref.get(k), k);
});
