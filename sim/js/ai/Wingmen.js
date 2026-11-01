// Two AI wingmen, F-35I #2 and #3, flying a fingertip three-ship (a vic) on the player's jet.
//
// They are kinematic, not FlightModel instances: each one chases a moving target with a
// position -> velocity -> acceleration controller (closure speed capped by the stopping
// distance, so they never overshoot), the target's own acceleration fed forward, and an attitude
// that follows from the motion (nose along the flight path plus angle of attack, lift along the
// specific force), blended into the leader's attitude in the slot. They are drawn with the same
// AircraftVisual as the player's jet; the textures of the player's model are shared.
//
// Behaviour:
//   ground   the player spawned on the ground: they stand beside and behind him on the runway
//            (formation take-off) and roll and lift off with him
//   join     the player is airborne: they come in from 450 m behind and take their slots
//   slot     fingertip: 14 m out, 11 m back, 1.2 m low in the leader's body frame (they roll
//            with him), gear and flaps with him
//   orbit    the player landed (or crashed): they hold overhead in a 2.4 km circle and rejoin
//            when he is airborne again
//
//   const w = new Wingmen({ scene, AircraftVisual, terrain, baseUrl, leader });
//   await w.load();
//   w.reset(fdm.state);                 // after every spawn / reset
//   w.step(h, fdm.state, input);        // after every physics step
//   w.update(dt, camera, flying, alpha, lights);   // every frame (alpha: interpolation)

import * as THREE from 'three';

const DEG = Math.PI / 180;
const G = 9.81;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const damp = (dt, tau) => 1 - Math.exp(-dt / Math.max(tau, 1e-4));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// slots in the leader's body frame (+X right, +Y up, +Z aft)
const SLOTS = [
  { name: '#2', side: -1, air: [-14, -1.2, 11], ground: [-14, 0, 11], gearDelay: 0.5, phase: 0.0 },
  { name: '#3', side: 1, air: [14, -1.2, 11], ground: [14, 0, 11], gearDelay: 0.8, phase: 2.1 },
];

const ORBIT_R = 2400;            // m: holding circle
const ORBIT_V = 150;             // m/s
const CLOSE_MAX = 60;            // m/s: closure speed on a slot
const KP = 0.6;                  // 1/s: position loop
const KV = 2.0;                  // 1/s: velocity loop
const A_DECEL = 5;               // m/s^2: braking used for the closure limit
const A_LAT = 30;                // m/s^2: correction across the flight path in the slot (3 g)
const A_LAT_FAR = 8;             // m/s^2: the same while joining from far (about 40 deg of bank)
const A_FWD = [-7, 6];           // m/s^2: correction along it (idle + speed brake .. burner)
const GEAR_TIME = 6;             // s each way, as the FlightModel's gear

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _e = new THREE.Vector3();
const _a = new THREE.Vector3();
const _f = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'specularIntensityMap', 'specularColorMap', 'iridescenceMap', 'iridescenceThicknessMap', 'transmissionMap',
  'thicknessMap', 'anisotropyMap', 'lightMap'];

/**
 * Point the materials of `to` (a second copy of the same glTF) at the textures of `from`, so
 * the wingmen's textures are never uploaded to the GPU, then free the decoded copies. Both
 * trees come from the same file and the same set-up code, so they walk in step; anything that
 * does not match keeps its own texture.
 */
function texturesOf(root) {
  const set = new Set();
  root.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (!m) continue;
      for (const k in m) { const v = m[k]; if (v && v.isTexture) set.add(v); }
      if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; if (v && v.isTexture) set.add(v); }
    }
  });
  return set;
}

function shareTextures(from, to, whole) {
  const a = [], b = [];
  from.traverse((o) => { if (o.isMesh) a.push(o); });
  to.traverse((o) => { if (o.isMesh) b.push(o); });
  if (a.length !== b.length) return 0;
  const dropped = new Set();
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name) continue;
    const ma = Array.isArray(a[i].material) ? a[i].material : [a[i].material];
    const mb = Array.isArray(b[i].material) ? b[i].material : [b[i].material];
    if (ma.length !== mb.length) continue;
    for (let j = 0; j < mb.length; j++) {
      const A = ma[j], B = mb[j];
      if (!A || !B || A.type !== B.type || A.name !== B.name) continue;
      for (const k of TEX_SLOTS) {
        const ta = A[k], tb = B[k];
        if (!tb || !tb.isTexture) continue;
        const ia = ta && ta.image, ib = tb.image;
        const same = ta && ta.isTexture && ta !== tb && ia && ib && ia.width === ib.width && ia.height === ib.height &&
          ta.colorSpace === tb.colorSpace && ta.flipY === tb.flipY && ta.channel === tb.channel;
        if (same) {
          B[k] = ta;
          dropped.add(tb);
          n++;
        }
      }
    }
  }
  // textures nothing refers to any more go, and so do their decoded images (ImageBitmaps of
  // up to 64 MB) unless a texture still in use shows the same image
  const live = texturesOf(whole || to);
  const liveImages = new Set([...live].map((t) => t.image));
  for (const t of dropped) {
    if (live.has(t)) continue;
    const img = t.image;
    t.dispose();
    if (img && !liveImages.has(img) && typeof img.close === 'function') img.close();
  }
  return n;
}

class Wingman {
  constructor(slot, visual) {
    this.slot = slot;
    this.visual = visual;
    this.air = new THREE.Vector3().fromArray(slot.air);
    this.ground = new THREE.Vector3().fromArray(slot.ground);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.drawPos = new THREE.Vector3();
    this.drawQuat = new THREE.Quaternion();
    this.acc = new THREE.Vector3();          // filtered acceleration (attitude, throttle)
    this.T = new THREE.Vector3();            // target position
    this.Tprev = new THREE.Vector3();
    this.tVel = new THREE.Vector3();
    this.tVelPrev = new THREE.Vector3();
    this.tAcc = new THREE.Vector3();
    this.fdReset = true;
    this.err = 0;                            // m from the target
    this.gear = 1;
    this.handle = true;
    this.handleTimer = 0;
    this.throttle = 0;
    this.ab = 0;
    this.rollDistance = 0;
    this.head = { yaw: 0, pitch: 0, tilt: 0 };
    this.stick = { pitch: 0, roll: 0 };
    this.orbit = { theta: 0, dir: 1 };
    this.ctl = {
      stick_pitch: 0, stick_roll: 0, pedals: 0, throttle: 0, ab: 0, flaps: 0, speedbrake: 0, gear: 1, nws: 0,
      roll_distance: 0, canopy: 0, weapon_bays: 0, refuel_door: 0, gun_door: 0, tailhook: 0,
      lights: { nav: true, anticoll: true, formation: 0, landing: false },
      wheels: [], head: this.head,
    };
  }
}

export class Wingmen {
  constructor({ scene, AircraftVisual, terrain, baseUrl = 'data/aircraft/', leader = null } = {}) {
    this.scene = scene;
    this.AircraftVisual = AircraftVisual;
    this.terrain = terrain;
    this.baseUrl = baseUrl;
    this.leader = leader;
    this.items = [];
    this.mode = 'join';
    this.enabled = true;
    this.loaded = false;
    this.time = 0;
    this.airTime = 0;
    this.groundTime = 0;
    this.stance = 1.95;                      // m: body origin above the ground on the gear
    this.orbitCenter = new THREE.Vector3();
    this.orbitAlt = 1000;
    this.sharedTextures = 0;
    this._lAccF = new THREE.Vector3();
    this._lVelPrev = new THREE.Vector3();
    // stand-in for the sun's shadow target while the three jets stand side by side: an unseen
    // box about the size of the line-up, kept at its middle (see sharedShadow)
    this.shadowProxy = new THREE.Group();
    this.shadowProxy.name = 'WingmenShadowProxy';
    const box = new THREE.Mesh(new THREE.BoxGeometry(28, 2, 28), new THREE.MeshBasicMaterial());
    box.visible = false;
    this.shadowProxy.add(box);
    if (scene) scene.add(this.shadowProxy);
  }

  get count() { return this.enabled && this.loaded ? this.items.length : 0; }

  /** True while the line-up should share one sun shadow (on the ground, side by side). */
  get sharedShadow() { return this.count > 0 && this.mode === 'ground'; }

  /** Load both visuals (one after the other: one glTF parse at a time). */
  async load(onProgress = () => {}) {
    for (let i = 0; i < SLOTS.length; i++) {
      const v = new this.AircraftVisual({ scene: null, baseUrl: this.baseUrl });
      await v.load((f) => onProgress((i + f) / SLOTS.length));
      if (this.leader && this.leader.root && v.root) {
        try { this.sharedTextures += shareTextures(this.leader.root, v.root, v.object3d); } catch (e) { console.warn('wingmen: texture sharing failed', e); }
      }
      v.object3d.name = `F35I_wingman${SLOTS[i].name}`;
      v.object3d.visible = false;
      this.scene.add(v.object3d);
      this.items.push(new Wingman(SLOTS[i], v));
    }
    const gc = this.items[0].visual.info && this.items[0].visual.info.gearContacts;
    if (Array.isArray(gc) && gc.length) {
      let lowest = 0;
      for (const c of gc) {
        const p = c.posParked || c.pos;
        const y = p ? (Array.isArray(p) ? p[1] : p.y) : 0;
        if (Number.isFinite(y)) lowest = Math.min(lowest, y);
      }
      if (lowest < -0.5) this.stance = -lowest;
    }
    this.loaded = true;
    this.setEnabled(this.enabled);
    return this;
  }

  setEnabled(on) {
    this.enabled = !!on;
    for (const w of this.items) w.visual.object3d.visible = this.enabled && this.loaded;
  }

  _height(x, z) {
    const h = this.terrain && this.terrain.heightAt ? this.terrain.heightAt(x, z) : 0;
    return Number.isFinite(h) ? h : 0;
  }

  /** Place the wingmen for the leader's (new) state: beside him on the ground, or joining. */
  reset(L) {
    if (!L || !this.loaded) return;
    this.time = 0;
    this.airTime = 0;
    this.groundTime = 0;
    this._lVelPrev.copy(L.velocity);
    this._lAccF.set(0, 0, 0);
    const onGround = !!L.onGround;
    this.mode = onGround ? 'ground' : 'join';
    if (onGround) this.stance = L.position.y - this._height(L.position.x, L.position.z);
    const yawQ = _qy.setFromAxisAngle(_up, -(L.heading || 0));
    for (const w of this.items) {
      if (onGround) {
        this._groundPose(w, L);
        w.gear = 1;
        w.handle = true;
      } else {
        // 450 m behind, 180 m out on his side, 40 m low, at the leader's speed
        _v1.set(w.slot.side * 180, -40, 450).applyQuaternion(yawQ);
        w.pos.copy(L.position).add(_v1);
        w.pos.y = Math.max(w.pos.y, this._height(w.pos.x, w.pos.z) + this.stance + 60);
        w.vel.copy(L.velocity);
        w.quat.copy(L.quaternion);
        const down = (L.gear || 0) > 0.5;
        w.gear = down ? 1 : 0;
        w.handle = down;
      }
      w.handleTimer = 0;
      w.acc.set(0, 0, 0);
      w.fdReset = true;
      w.prevPos.copy(w.pos);
      w.prevQuat.copy(w.quat);
      w.throttle = L.engine ? L.engine.throttle || 0 : 0;
      w.ab = 0;
      w.rollDistance = 0;
      w.err = w.pos.distanceTo(L.position);
    }
  }

  /** Rigid line-up on the runway: the leader's heading, wheels on the ground. */
  _groundPose(w, L) {
    const yawQ = _q1.setFromAxisAngle(_up, -(L.heading || 0));
    _v1.copy(w.ground).applyQuaternion(yawQ);
    const lh = L.position.y - this._height(L.position.x, L.position.z);
    w.pos.copy(L.position).add(_v1);
    w.pos.y = this._height(w.pos.x, w.pos.z) + lh;
    w.vel.copy(L.velocity);
    w.quat.copy(L.quaternion);
  }

  /** One physics step after the leader's (h = 1/120 s). */
  step(h, L, input = {}) {
    if (!this.enabled || !this.loaded || !L) return;
    this.time += h;
    // the leader's acceleration (finite difference, filtered)
    _v1.copy(L.velocity).sub(this._lVelPrev).divideScalar(h);
    this._lVelPrev.copy(L.velocity);
    if (_v1.lengthSq() < 400 * 400) this._lAccF.lerp(_v1, damp(h, 0.12));

    // modes
    const prevMode = this.mode;
    if (L.crashed) {
      if (this.mode !== 'orbit' && this.mode !== 'ground') this._enterOrbit(L, 1800, 600);
    } else if (this.mode === 'ground') {
      this.airTime = L.onGround ? 0 : this.airTime + h;
      if (this.airTime > 1 && ((L.agl || 0) > 8 || this.airTime > 4)) this.mode = 'slot';
    } else if (this.mode === 'slot' || this.mode === 'join') {
      this.groundTime = L.onGround ? this.groundTime + h : 0;
      if (this.groundTime > 2) this._enterOrbit(L, ORBIT_R, 700);
      else if (this.mode === 'join' && this.items.every((w) => w.err < 3)) this.mode = 'slot';
    } else if (this.mode === 'orbit') {
      if (!L.onGround && (L.agl || 0) > 60) this.mode = 'join';
    }
    // a new kind of target: restart its finite differences (join -> slot is the same target)
    if (this.mode !== prevMode && !(prevMode === 'join' && this.mode === 'slot')) for (const w of this.items) w.fdReset = true;

    for (const w of this.items) {
      w.prevPos.copy(w.pos);
      w.prevQuat.copy(w.quat);
      if (this.mode === 'ground') {
        if (L.crashed) { w.vel.set(0, 0, 0); continue; }   // they stay where they are
        this._groundPose(w, L);
        w.err = 0;
        w.throttle = L.engine ? L.engine.throttle || 0 : 0;
        w.ab = L.engine ? L.engine.ab || 0 : 0;
        if (L.onGround) w.rollDistance += L.groundSpeed * h || 0;
        this._gear(w, true, h);
        this._controls(w, L, 1, h);
        continue;
      }
      if (this.mode === 'orbit') this._orbitTarget(w, h);
      else this._slotTarget(w, L, h);
      this._fly(w, L, h);
      // gear: with the leader's handle (a moment later), up while holding
      const handle = this.mode === 'orbit' ? false : input.gearHandle !== false && (L.gear || 0) > 0.02;
      this._gear(w, handle, h);
      this._controls(w, L, 1 - smoothstep(12, 120, w.err), h);
    }
  }

  _enterOrbit(L, R, above) {
    this.mode = 'orbit';
    this.orbitCenter.copy(L.position);
    this.orbitR = R;
    this.orbitAlt = Math.max(L.position.y, this._height(L.position.x, L.position.z)) + above;
    for (const w of this.items) {
      const dx = w.pos.x - this.orbitCenter.x, dz = w.pos.z - this.orbitCenter.z;
      const th = Math.atan2(dz, dx);
      // turn the way it is already going
      const tx = -Math.sin(th), tz = Math.cos(th);
      w.orbit.dir = tx * w.vel.x + tz * w.vel.z >= 0 ? 1 : -1;
      w.orbit.theta = th + w.orbit.dir * 0.6;
    }
    // #3 holds 60 m behind #2 and 25 m outside
    if (this.items.length > 1) {
      this.items[1].orbit.dir = this.items[0].orbit.dir;
      this.items[1].orbit.theta = this.items[0].orbit.theta - this.items[0].orbit.dir * 0.025;
    }
  }

  _orbitTarget(w, h) {
    const R = (this.orbitR || ORBIT_R) + (w === this.items[1] ? 25 : 0);
    const om = (ORBIT_V / R) * w.orbit.dir;
    w.orbit.theta += om * h;
    const c = Math.cos(w.orbit.theta), s = Math.sin(w.orbit.theta);
    const C = this.orbitCenter;
    const floor = Math.max(this._height(C.x + R * c, C.z + R * s) + 300, this.orbitAlt);
    w.T.set(C.x + R * c, floor, C.z + R * s);
    w.tVel.set(-s * R * om, 0, c * R * om);
    w.tAcc.set(-c * R * om * om, 0, -s * R * om * om);
    w.fdReset = true;   // back to finite differences cleanly on the next slot target
  }

  _slotTarget(w, L, h) {
    // a little life: slow station-keeping wander of a few decimetres
    const t = this.time, p = w.slot.phase;
    _v1.set(
      Math.sin(t * 0.83 + p) * 0.35 + Math.sin(t * 0.31 + 2 * p) * 0.25,
      Math.sin(t * 0.67 + 3 * p) * 0.25,
      Math.sin(t * 0.43 + p) * 0.5,
    ).add(w.air).applyQuaternion(L.quaternion);
    w.T.copy(L.position).add(_v1);
    if (w.fdReset) {
      w.Tprev.copy(w.T);
      w.tVel.copy(L.velocity);
      w.tVelPrev.copy(L.velocity);
      w.tAcc.copy(this._lAccF);
      w.fdReset = false;
      return;
    }
    _v1.copy(w.T).sub(w.Tprev).divideScalar(h);
    w.Tprev.copy(w.T);
    if (_v1.distanceTo(L.velocity) > 300) _v1.copy(L.velocity);   // a teleport: ignore
    w.tVel.lerp(_v1, damp(h, 0.04));
    _v2.copy(w.tVel).sub(w.tVelPrev).divideScalar(h);
    w.tVelPrev.copy(w.tVel);
    if (_v2.length() > 120) _v2.setLength(120);
    w.tAcc.lerp(_v2, damp(h, 0.1));
  }

  _fly(w, L, h) {
    const e = _e.copy(w.T).sub(w.pos);
    const dist = e.length();
    w.err = dist;
    // closure: proportional, capped by what can be stopped in the distance left
    const close = Math.min(KP * dist, Math.sqrt(2 * A_DECEL * dist), this.mode === 'orbit' ? 90 : CLOSE_MAX);
    const a = _a.copy(w.tVel);
    if (dist > 1e-6) a.addScaledVector(e, close / dist);
    a.sub(w.vel).multiplyScalar(KV);                         // velocity error -> acceleration
    // split the correction along / across the flight path and limit each: gentle turns while
    // joining (about 40 deg of bank), the full 3 g for station keeping
    const speed = w.vel.length();
    const fwd = _f.copy(speed > 20 ? w.vel : w.tVel);
    if (fwd.lengthSq() < 1) fwd.set(0, 0, -1).applyQuaternion(w.quat);
    fwd.normalize();
    const along = a.dot(fwd);
    a.addScaledVector(fwd, -along);
    const aLat = A_LAT_FAR + (A_LAT - A_LAT_FAR) * (1 - smoothstep(40, 200, dist));
    if (a.length() > aLat) a.setLength(aLat);
    a.addScaledVector(fwd, clamp(along, A_FWD[0], A_FWD[1]));
    a.add(w.tAcc);                                           // the target's own acceleration
    // never into the leader
    const d = _d.copy(w.pos).sub(L.position);
    const dl = d.length();
    if (dl < 10 && dl > 1e-3) a.addScaledVector(d, (10 - dl) * 8 / dl);
    // and not into the ground
    const hg = this._height(w.pos.x, w.pos.z);
    const clear = this.mode === 'orbit' ? 150 : clamp((L.agl || 0) * 0.5, 2, 30);
    const floor = hg + this.stance + clear;
    if (w.pos.y < floor) a.y += (floor - w.pos.y) * 4 + Math.max(0, -w.vel.y) * 2;
    w.vel.addScaledVector(a, h);
    w.pos.addScaledVector(w.vel, h);
    const hard = hg + this.stance + 0.3;
    if (w.pos.y < hard) { w.pos.y = hard; if (w.vel.y < 0) w.vel.y = 0; }
    w.acc.lerp(a, damp(h, 0.15));

    // attitude from the motion: nose along the path plus AoA, lift along the specific force
    const V = w.vel.length();
    const f = _f.copy(V > 20 ? w.vel : L.velocity);
    if (f.lengthSq() < 1) f.set(0, 0, -1).applyQuaternion(L.quaternion);
    f.normalize();
    const up = _v2.copy(w.acc);
    up.y += G;                                               // specific force
    if (up.y < 0.3 * G) up.y = 0.3 * G;                      // no inverted push-overs
    up.addScaledVector(f, -up.dot(f));
    if (up.lengthSq() < 1e-4) up.copy(_up).addScaledVector(f, -f.y);
    up.normalize();
    const n = (w.acc.dot(up) + G * up.y) / G;
    const alpha = clamp(4.5 * DEG * n * (160 / Math.max(V, 60)) ** 2, -3 * DEG, 15 * DEG);
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    const z = _v1.copy(f).multiplyScalar(-ca).addScaledVector(up, -sa);    // body +Z (aft)
    const y = up.multiplyScalar(ca).addScaledVector(f, -sa);                // body +Y (up)
    const x = _v3.crossVectors(y, z).normalize();                           // body +X (right)
    _m.makeBasis(x, y, z);
    _q1.setFromRotationMatrix(_m);
    // in the slot: the leader's attitude
    const wSlot = this.mode === 'orbit' ? 0 : 1 - smoothstep(12, 120, w.err);
    if (wSlot > 0) _q1.slerp(L.quaternion, wSlot);
    w.quat.slerp(_q1, damp(h, 0.12));
    w.quat.normalize();
  }

  _gear(w, down, h) {
    if (down !== w.handle) {
      w.handleTimer += h;
      if (w.handleTimer >= w.slot.gearDelay) { w.handle = down; w.handleTimer = 0; }
    } else {
      w.handleTimer = 0;
    }
    w.gear = clamp(w.gear + (w.handle ? h : -h) / GEAR_TIME, 0, 1);
  }

  /** Surfaces, power, gear, head for AircraftVisual.setControls. */
  _controls(w, L, inSlot, h) {
    const c = w.ctl;
    const Lc = L.controls || {};
    const V = Math.max(w.vel.length(), 1);
    // power: what the motion needs (drag ~ V^2, gravity along the path), the leader's in the slot
    const fwd = _v1.copy(w.vel).divideScalar(V);
    const need = w.acc.dot(fwd) + G * fwd.y + 0.00012 * V * V;
    let thr = need <= 7 ? 0.75 * clamp(need / 7, 0.05, 1) : 0.75 + 0.25 * clamp((need - 7) / 3.6, 0, 1);
    const lThr = L.engine ? L.engine.throttle ?? Lc.throttle ?? 0 : Lc.throttle || 0;
    const lAb = L.engine ? L.engine.ab || 0 : 0;
    if (this.mode === 'ground') thr = lThr;
    else thr += (lThr - thr) * inSlot;
    w.throttle += (thr - w.throttle) * damp(h, 0.6);
    const ab = this.mode === 'ground' ? lAb : clamp((w.throttle - 0.75) / 0.25, 0, 1) * (1 - inSlot) + lAb * inSlot;
    w.ab += (ab - w.ab) * damp(h, 0.4);
    // surfaces: the leader's in the slot, else from the rates
    _q1.copy(w.prevQuat).invert().multiply(w.quat);
    const s = Math.sqrt(Math.max(0, 1 - _q1.w * _q1.w));
    const ang = 2 * Math.atan2(s, Math.abs(_q1.w)) * (_q1.w < 0 ? -1 : 1);
    const k = s > 1e-9 ? ang / s / h : 0;
    const pRate = -_q1.z * k, qRate = _q1.x * k;
    const nLoad = (w.acc.y + G) / G;
    const sp = clamp((nLoad - 1) / 8 + qRate * 0.3, -0.5, 1);
    const sr = clamp(pRate / 3, -1, 1);
    w.stick.pitch += (sp - w.stick.pitch) * damp(h, 0.1);
    w.stick.roll += (sr - w.stick.roll) * damp(h, 0.1);
    c.stick_pitch = w.stick.pitch + ((Lc.stick_pitch || 0) - w.stick.pitch) * inSlot;
    c.stick_roll = w.stick.roll + ((Lc.stick_roll || 0) - w.stick.roll) * inSlot;
    c.pedals = (Lc.pedals || 0) * inSlot;
    const flapsOwn = w.gear > 0.5 ? clamp((110 - V) / 30, 0, 1) : 0;
    c.flaps = flapsOwn + ((Lc.flaps || 0) - flapsOwn) * inSlot;
    c.speedbrake = this.mode === 'ground' ? Lc.speedbrake || 0 : 0;
    c.throttle = w.throttle;
    c.ab = w.ab;
    c.gear = w.gear;
    c.nws = this.mode === 'ground' ? Lc.nws || 0 : 0;
    c.roll_distance = w.rollDistance;
    // struts: parked on the ground, hanging in the air
    const onGround = this.mode === 'ground';
    const info = w.visual.info;
    const gc = info && Array.isArray(info.gearContacts) ? info.gearContacts : [];
    if (c.wheels.length !== gc.length) c.wheels = gc.map((g) => ({ name: g.name, compression: 0, steer: 0 }));
    for (let i = 0; i < gc.length; i++) {
      const target = onGround ? (Number.isFinite(gc[i].staticCompression) ? gc[i].staticCompression : 0.05) : 0;
      c.wheels[i].compression += (target - c.wheels[i].compression) * damp(h, 0.25);
    }
    // the pilot looks at the leader (or down at the field while holding)
    const look = this.mode === 'orbit' ? this.orbitCenter : L.position;
    _v2.copy(look).sub(w.pos).applyQuaternion(_q2.copy(w.quat).invert());
    const yaw = clamp(Math.atan2(-_v2.x, -_v2.z), -100 * DEG, 100 * DEG);
    const pitch = clamp(Math.atan2(_v2.y, Math.hypot(_v2.x, _v2.z)), -45 * DEG, 60 * DEG);
    w.head.yaw += (yaw - w.head.yaw) * damp(h, 0.5);
    w.head.pitch += (pitch - w.head.pitch) * damp(h, 0.5);
  }

  /** Every frame: interpolated poses, controls, lights; alpha as for the player's jet. */
  update(dt, camera, flying = true, alpha = 1, lights = null, leaderPos = null) {
    if (!this.loaded) return;
    const on = this.enabled;

    for (const w of this.items) {
      const v = w.visual;
      v.object3d.visible = on;
      if (!on) continue;
      w.drawPos.lerpVectors(w.prevPos, w.pos, clamp(alpha, 0, 1));
      w.drawQuat.slerpQuaternions(w.prevQuat, w.quat, clamp(alpha, 0, 1));
      v.setPose(w.drawPos, w.drawQuat);
      const L = w.ctl.lights;
      if (lights) {
        L.nav = !!lights.nav;
        L.anticoll = !!lights.anticoll;
        L.formation = lights.formation || 0;
        L.landing = !!lights.landing && w.gear > 0.9;
      }
      v.setControls(w.ctl);
      if (typeof window !== 'undefined') v.viewportHeight = window.innerHeight;
      v.update(dt, camera);
    }
    if (leaderPos && on) {
      const c = this.shadowProxy.position.copy(leaderPos);
      for (const w of this.items) c.add(w.drawPos);
      c.divideScalar(this.items.length + 1);
      this.shadowProxy.updateMatrixWorld();
    }
  }

  dispose() {
    this.scene.remove(this.shadowProxy);
    for (const w of this.items) {
      this.scene.remove(w.visual.object3d);
      if (w.visual.dispose) w.visual.dispose();
    }
    this.items.length = 0;
    this.loaded = false;
  }
}
