// Camera modes for the flight sim: cockpit, chase, orbit, fly-by and tower.
//
//   const rig = new CameraRig(camera, { heightAt: (x, z) => terrain.heightAt(x, z) });
//   rig.setMode('chase');
//   rig.update(dt, {
//     position, quaternion,     // aircraft body origin (world) and body -> world, as drawn this frame
//     velocity, gLoad, gLateral, alpha, onGround, groundSpeed,
//     eye, eyeForward,          // AircraftVisual.info (body frame: +X right, +Y up, -Z forward)
//     airports,                 // terrain.airports, for the tower view
//     look,                     // input frame: dragX/dragY (px), wheel, lookX/lookY (-1..1), lookCenter
//   });
//
// Cockpit: the camera sits at the pilot's eye, rigid with the jet, turned by head look (mouse
// drag, hat, numpad) and shifted a little by the g load. Chase: a spring camera behind the jet
// that follows its attitude with a lag. Orbit: mouse drag and wheel around the jet. Fly-by: the
// camera waits ahead of the jet and watches it pass. Tower: a camera above the nearest airfield
// that tracks the jet with a zoom lens.

import * as THREE from 'three';

export const VIEWS = ['cockpit', 'chase', 'orbit', 'flyby', 'tower'];
export const VIEW_LABELS = { cockpit: 'Cockpit', chase: 'Chase', orbit: 'Orbit', flyby: 'Fly-by', tower: 'Tower' };

const DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const damp = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-4, tau));

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** Cheap smooth noise: sum of sines with incommensurate frequencies (deterministic). */
function wobble(t, seed) {
  return (Math.sin(t * 13.1 + seed) * 0.5 + Math.sin(t * 23.7 + seed * 2.3) * 0.3 + Math.sin(t * 41.3 + seed * 4.1) * 0.2);
}

export class CameraRig {
  constructor(camera, { heightAt = () => 0 } = {}) {
    this.camera = camera;
    this.heightAt = heightAt;
    this.mode = 'chase';
    this.defaultFov = { cockpit: 62, chase: 55, orbit: 50, flyby: 45, tower: 40 };
    this.fov = { ...this.defaultFov };
    // cockpit head
    this.head = { yaw: 0, pitch: 0, centering: false };
    this.gShift = new THREE.Vector3();
    // chase
    this.chase = { q: new THREE.Quaternion(), yaw: 0, pitch: 0, idle: 0, zoom: 1, init: false, vel: new THREE.Vector3() };
    // orbit
    this.orbit = { yaw: 0, pitch: 12 * DEG, dist: 30, init: false, auto: 0 };
    // fly-by
    this.flyby = { pos: new THREE.Vector3(), valid: false, lead: 300 };
    // tower
    this.tower = { pos: new THREE.Vector3(), airport: null, valid: false, q: new THREE.Quaternion(), init: false };
    this.time = 0;
    this._prevVel = new THREE.Vector3();
    this._accBody = new THREE.Vector3();
    this.shake = 0;
  }

  setMode(mode) {
    if (!VIEWS.includes(mode)) return;
    if (mode !== this.mode) {
      this.mode = mode;
      if (mode === 'flyby') this.flyby.valid = false;
      if (mode === 'tower') this.tower.valid = false;
      if (mode === 'chase') this.chase.init = false;
      if (mode === 'orbit') this.orbit.init = false;
    }
  }

  next(step = 1) {
    const i = VIEWS.indexOf(this.mode);
    this.setMode(VIEWS[(i + step + VIEWS.length) % VIEWS.length]);
    return this.mode;
  }

  /** After a teleport (spawn / reset): drop every smoothed state. */
  snap() {
    this.chase.init = false;
    this.orbit.init = false;
    this.flyby.valid = false;
    this.tower.valid = false;
    this.head.yaw = this.head.pitch = 0;
    this.gShift.set(0, 0, 0);
    this._prevVel.set(0, 0, 0);
    this._accBody.set(0, 0, 0);
  }

  get isCockpit() { return this.mode === 'cockpit'; }

  /** Ground height with a margin, for keeping cameras out of the terrain. */
  _floor(x, z, margin) {
    const h = this.heightAt(x, z);
    return (Number.isFinite(h) ? h : 0) + margin;
  }

  update(dt, ctx) {
    dt = clamp(dt || 0, 0, 0.25);
    this.time += dt;
    const cam = this.camera;
    const look = ctx.look || {};
    // body acceleration felt by the pilot (for the head shift): from the velocity change
    if (ctx.velocity && dt > 0) {
      _v1.copy(ctx.velocity).sub(this._prevVel).divideScalar(Math.max(dt, 1e-3));
      this._prevVel.copy(ctx.velocity);
      _q1.copy(ctx.quaternion).invert();
      _v1.applyQuaternion(_q1);
      this._accBody.lerp(_v1, damp(dt, 0.25));
    }
    switch (this.mode) {
      case 'cockpit': this._cockpit(dt, ctx, look); break;
      case 'chase': this._chase(dt, ctx, look); break;
      case 'orbit': this._orbit(dt, ctx, look); break;
      case 'flyby': this._flyby(dt, ctx, look); break;
      case 'tower': this._tower(dt, ctx, look); break;
      default: break;
    }
    // wheel zoom for the views without a distance (cockpit, fly-by, tower: field of view)
    const fov = this.fov[this.mode];
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    const near = this.mode === 'cockpit' ? 0.04 : 0.5;
    if (cam.near !== near) { cam.near = near; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }

  // ------------------------------------------------------------------------------ cockpit
  _cockpit(dt, ctx, look) {
    const cam = this.camera;
    const H = this.head;
    if (look.lookCenter) H.centering = true;
    const dragging = look.dragButton >= 0;
    if (dragging && (look.dragX || look.dragY)) {
      const k = 0.0042 * (this.fov.cockpit / 62);
      H.yaw -= look.dragX * k;
      H.pitch -= look.dragY * k;
      H.centering = false;
    }
    if (look.lookX || look.lookY) {
      H.yaw -= look.lookX * 110 * DEG * dt;
      H.pitch += look.lookY * 80 * DEG * dt;
      H.centering = false;
    }
    if (H.centering) {
      const a = damp(dt, 0.12);
      H.yaw += (0 - H.yaw) * a;
      H.pitch += (0 - H.pitch) * a;
      if (Math.abs(H.yaw) < 0.002 && Math.abs(H.pitch) < 0.002) { H.yaw = H.pitch = 0; H.centering = false; }
    }
    H.yaw = clamp(H.yaw, -165 * DEG, 165 * DEG);
    H.pitch = clamp(H.pitch, -60 * DEG, 88 * DEG);
    if (look.wheel) this.fov.cockpit = clamp(this.fov.cockpit * Math.pow(1.08, look.wheel), 22, 95);

    // eye point, base direction (the pilot's straight ahead) and head rotation
    const eye = ctx.eye || _v3.set(0, 1.08, -4.47);
    const fwd = ctx.eyeForward;
    const basePitch = fwd ? Math.atan2(fwd.y, Math.hypot(fwd.x, fwd.z)) : -6 * DEG;
    // head moves when looking around: lean to the side to look back, forward to look down
    const lean = _v1.set(
      -Math.sin(H.yaw) * 0.09 * Math.min(1, Math.abs(H.yaw) / (90 * DEG)),
      Math.max(0, H.pitch) * 0.03,
      -Math.max(0, -H.pitch) * 0.08 * Math.cos(H.yaw),
    );
    // g load pushes the head down / sideways; acceleration pushes it back
    const g = ctx.gLoad != null ? ctx.gLoad : 1;
    const target = _v2.set(
      clamp(-(this._accBody.x / 9.81) * 0.015, -0.03, 0.03),
      clamp(-(g - 1) * 0.0065, -0.035, 0.05),
      clamp((-this._accBody.z / 9.81) * 0.025, -0.03, 0.04),
    );
    if (ctx.onGround) target.y = clamp(target.y, -0.01, 0.01);
    this.gShift.lerp(target, damp(dt, 0.12));
    const local = _v3.copy(eye).add(lean).add(this.gShift);
    cam.position.copy(local).applyQuaternion(ctx.quaternion).add(ctx.position);

    // orientation: jet attitude * head yaw (about body up) * pitch (about the head's right)
    _e.set(basePitch + H.pitch, H.yaw, 0, 'YXZ');
    _q1.setFromEuler(_e);
    // shake: runway rumble and high-AoA buffet (small, in radians)
    const gs = ctx.onGround ? Math.min(1, (ctx.groundSpeed || 0) / 90) : 0;
    const aoa = ctx.alpha ? Math.max(0, ctx.alpha / DEG - 16) / 12 : 0;
    const amp = 0.0011 * gs + 0.0022 * Math.min(1, aoa) * Math.min(1, (ctx.qbar || 0) / 6000) + this.shake;
    if (amp > 0) {
      _e.set(wobble(this.time, 1.3) * amp, wobble(this.time, 5.1) * amp * 0.6, wobble(this.time, 9.7) * amp * 0.5, 'YXZ');
      _q2.setFromEuler(_e);
      _q1.multiply(_q2);
    }
    cam.quaternion.copy(ctx.quaternion).multiply(_q1);
  }

  // ------------------------------------------------------------------------------ chase
  _chase(dt, ctx, look) {
    const cam = this.camera;
    const C = this.chase;
    if (!C.init) { C.q.copy(ctx.quaternion); C.init = true; C.yaw = 0; C.pitch = 0; }
    // the camera frame follows the jet's attitude with a lag (you see it rotate first)
    C.q.slerp(ctx.quaternion, damp(dt, 0.22));
    if (look.dragButton >= 0 && (look.dragX || look.dragY)) {
      C.yaw -= look.dragX * 0.005;
      C.pitch = clamp(C.pitch - look.dragY * 0.005, -1.2, 1.2);
      C.idle = 0;
    } else {
      C.idle += dt;
    }
    if (look.lookX || look.lookY) {
      C.yaw -= look.lookX * 1.8 * dt;
      C.pitch = clamp(C.pitch + look.lookY * 1.4 * dt, -1.2, 1.2);
      C.idle = 0;
    }
    if (look.lookCenter) C.idle = 99;
    if (C.idle > 1.5) {
      // swing back behind the jet after the player lets go
      const a = damp(dt, 0.6);
      C.yaw *= 1 - a;
      C.pitch *= 1 - a;
    }
    if (look.wheel) C.zoom = clamp(C.zoom * Math.pow(1.12, look.wheel), 0.45, 4);
    const V = ctx.velocity ? ctx.velocity.length() : 0;
    const dist = (17 + Math.min(V, 400) * 0.012) * C.zoom;
    // offset behind and above, rotated by the player's look offset
    _e.set(C.pitch, C.yaw, 0, 'YXZ');
    _q1.setFromEuler(_e);
    const off = _v1.set(0, 0.17 * dist, dist).applyQuaternion(_q1).applyQuaternion(C.q);
    const target = _v2.set(0, 0.9, 0).applyQuaternion(ctx.quaternion).add(ctx.position);
    cam.position.copy(target).add(off);
    const floor = this._floor(cam.position.x, cam.position.z, 1.6);
    if (cam.position.y < floor) cam.position.y = floor;
    // look a little ahead of the jet so it sits below the centre of the picture
    const ahead = _v3.set(0, 0, -dist * 0.35).applyQuaternion(C.q).add(target);
    cam.up.set(0, 1, 0).applyQuaternion(C.q);
    _m.lookAt(cam.position, ahead, cam.up);
    cam.quaternion.setFromRotationMatrix(_m);
  }

  // ------------------------------------------------------------------------------ orbit
  _orbit(dt, ctx, look) {
    const cam = this.camera;
    const O = this.orbit;
    if (!O.init) {
      // start behind the jet's heading
      _v1.set(0, 0, 1).applyQuaternion(ctx.quaternion);
      O.yaw = Math.atan2(_v1.x, _v1.z) + 25 * DEG;
      O.init = true;
    }
    if (look.dragButton >= 0 && (look.dragX || look.dragY)) {
      O.yaw -= look.dragX * 0.006;
      O.pitch = clamp(O.pitch + look.dragY * 0.006, -80 * DEG, 85 * DEG);
    }
    if (look.lookX || look.lookY) {
      O.yaw -= look.lookX * 1.6 * dt;
      O.pitch = clamp(O.pitch + look.lookY * 1.2 * dt, -80 * DEG, 85 * DEG);
    }
    if (O.auto) O.yaw += O.auto * dt;
    if (look.wheel) O.dist = clamp(O.dist * Math.pow(1.15, look.wheel), 7, 2000);
    const target = _v2.set(0, 0.3, 0.8).applyQuaternion(ctx.quaternion).add(ctx.position);
    const cp = Math.cos(O.pitch);
    cam.position.set(Math.sin(O.yaw) * cp, Math.sin(O.pitch), Math.cos(O.yaw) * cp).multiplyScalar(O.dist).add(target);
    const floor = this._floor(cam.position.x, cam.position.z, 1.2);
    if (cam.position.y < floor) cam.position.y = floor;
    cam.up.set(0, 1, 0);
    _m.lookAt(cam.position, target, cam.up);
    cam.quaternion.setFromRotationMatrix(_m);
  }

  // ------------------------------------------------------------------------------ fly-by
  _flyby(dt, ctx, look) {
    const cam = this.camera;
    const F = this.flyby;
    const pos = ctx.position;
    const vel = ctx.velocity || _v3.set(0, 0, 0);
    const V = vel.length();
    if (F.valid) {
      // passed and well behind, or far away: set up the next pass
      const rel = _v1.copy(pos).sub(F.pos);
      const along = V > 1 ? rel.dot(_v2.copy(vel).divideScalar(V)) : 0;
      if (along > F.lead * 0.9 || rel.length() > F.lead * 3 + 200 || (V < 15 && rel.length() > 150)) F.valid = false;
    }
    if (!F.valid || look.lookCenter) {
      const dir = V > 15 ? _v1.copy(vel).divideScalar(V) : _v1.set(0, 0, -1).applyQuaternion(ctx.quaternion);
      F.lead = V > 15 ? clamp(V * 3.2, 180, 1500) : 40;
      // to the right of the path (or left, alternating), a little above it
      const side = _v2.crossVectors(dir, Y_AXIS);
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      side.normalize();
      F.side = F.side === 1 ? -1 : 1;
      const lateral = V > 15 ? 22 + Math.min(V, 300) * 0.06 : 28;
      F.pos.copy(pos).addScaledVector(dir, F.lead).addScaledVector(side, lateral * F.side);
      F.pos.y += V > 15 ? 6 : 0;
      const floor = this._floor(F.pos.x, F.pos.z, V > 15 ? 3 : 1.7);
      if (F.pos.y < floor) F.pos.y = floor;
      F.valid = true;
    }
    if (look.wheel) this.fov.flyby = clamp(this.fov.flyby * Math.pow(1.1, look.wheel), 8, 80);
    cam.position.copy(F.pos);
    cam.up.set(0, 1, 0);
    _m.lookAt(cam.position, pos, cam.up);
    cam.quaternion.setFromRotationMatrix(_m);
  }

  // ------------------------------------------------------------------------------ tower
  _pickTower(ctx) {
    const T = this.tower;
    const aps = ctx.airports || [];
    let best = null, bestD = Infinity;
    for (const ap of aps) {
      for (const rw of ap.runways || []) {
        if (!rw.ends || rw.ends.length < 2) continue;
        const a = rw.ends[0], b = rw.ends[1];
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const d = Math.hypot(ctx.position.x - mx, ctx.position.z - mz);
        // prefer long runways (the main one is where the tower looks)
        const score = d - (rw.length_m || 0) * 0.2;
        if (score < bestD) { bestD = score; best = { ap, rw, a, b, mx, mz }; }
      }
    }
    if (!best) {
      // no airports: a mast 300 m beside wherever the jet is
      T.pos.set(ctx.position.x + 300, 0, ctx.position.z + 300);
      T.pos.y = this._floor(T.pos.x, T.pos.z, 25);
      T.airport = null;
    } else {
      const { a, b, mx, mz } = best;
      let ux = b.x - a.x, uz = b.z - a.z;
      const L = Math.hypot(ux, uz) || 1;
      ux /= L; uz /= L;
      // the tower stands beside the runway's middle, on the side of the jet
      let nx = -uz, nz = ux;
      if ((ctx.position.x - mx) * nx + (ctx.position.z - mz) * nz < 0) { nx = -nx; nz = -nz; }
      const off = 230 + (best.rw.width_m || 45);
      T.pos.set(mx + nx * off - ux * L * 0.12, 0, mz + nz * off - uz * L * 0.12);
      T.pos.y = this._floor(T.pos.x, T.pos.z, 24);
      T.airport = best.ap;
    }
    T.valid = true;
    T.init = false;
  }

  _tower(dt, ctx, look) {
    const cam = this.camera;
    const T = this.tower;
    if (!T.valid || look.lookCenter || T.pos.distanceTo(ctx.position) > 30000) this._pickTower(ctx);
    cam.position.copy(T.pos);
    const d = T.pos.distanceTo(ctx.position);
    // zoom lens: keep the jet a sensible size; the wheel scales it
    if (look.wheel) T.zoom = clamp((T.zoom || 1) * Math.pow(1.12, look.wheel), 0.25, 4);
    const want = clamp(2 * Math.atan(26 * (T.zoom || 1) / Math.max(d, 1)) / DEG, 1.2, 60);
    // a new tower starts zoomed in; after that the lens follows the distance smoothly
    this.fov.tower = T.init ? this.fov.tower + (want - this.fov.tower) * damp(dt, 0.4) : want;
    cam.up.set(0, 1, 0);
    _m.lookAt(cam.position, ctx.position, cam.up);
    _q1.setFromRotationMatrix(_m);
    if (!T.init) { T.q.copy(_q1); T.init = true; }
    // the operator tracks with a slight lag
    T.q.slerp(_q1, damp(dt, 0.08));
    cam.quaternion.copy(T.q);
  }

  /** Name of the airfield the tower camera is at (for the toast). */
  get towerName() {
    return this.tower.airport ? `${this.tower.airport.name} (${this.tower.airport.icao})` : 'field';
  }
}
