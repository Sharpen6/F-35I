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
// drag, hat, numpad: rates that build up and die away, the view smoothed a little). The head turns
// about the neck and the torso twists to look back, so the eye moves as a pilot's does; the g
// load shifts it; the seat vibrates on the runway (slab joints, roughness), drops at the
// touchdown, shakes in the high-AoA buffet (?shake=0: off). The wheel zooms (20-80 deg).
// Chase: a spring camera behind the jet that follows its attitude with a lag. Orbit: mouse drag
// and wheel around the jet. Fly-by: the camera waits ahead of the jet and watches it pass. Tower:
// a camera above the nearest airfield that tracks the jet with a zoom lens.

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
const _m = new THREE.Matrix4();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** The pilot's eyes from the neck's pivot (body frame, m): the head turns about the neck. */
const NECK_TO_EYE = new THREE.Vector3(0, 0.07, -0.09);

/** Cheap smooth noise: sum of sines with incommensurate frequencies (deterministic). */
function wobble(t, seed) {
  return (Math.sin(t * 13.1 + seed) * 0.5 + Math.sin(t * 23.7 + seed * 2.3) * 0.3 + Math.sin(t * 41.3 + seed * 4.1) * 0.2);
}

export class CameraRig {
  constructor(camera, { heightAt = () => 0 } = {}) {
    this.camera = camera;
    this.heightAt = heightAt;
    this.mode = 'chase';
    this.defaultFov = { cockpit: 60, chase: 55, orbit: 50, flyby: 45, tower: 40 };
    this.fov = { ...this.defaultFov };
    /** Cockpit zoom: the wheel's range of the vertical field of view (deg). */
    this.cockpitFovRange = [20, 80];
    // cockpit: the default view looks this far below the rig's design eye line (itself 6 deg below
    // the jet's axis): the view centre 8.5 deg below the axis puts the canopy bow (9-17 deg above
    // the axis, 0.5 m ahead) 18-26 deg above the centre along the top of the picture, and the glare
    // shield (14.6 deg below the axis) 11.6 deg below the horizon in cruise (3 deg AoA)
    this.cockpitLookDown = 2.5 * DEG;
    // cockpit head: yaw / pitch are where the pilot wants to look (+ = left / up; the test API and
    // the inputs write them), the view follows them through a short smoothing (ay / ap)
    this.head = { yaw: 0, pitch: 0, centering: false, ay: 0, ap: 0, vy: 0, vp: 0 };
    this.gShift = new THREE.Vector3();
    // cockpit vibration: runway rumble, touchdown, buffet (a damped spring per axis: seat height,
    // pitch, roll), and the state it needs; `vibration` scales it (0 off: ?shake=0)
    this.vibration = typeof location !== 'undefined' && new URLSearchParams(location.search).get('shake') === '0' ? 0 : 1;
    this._jolt = { y: 0, vy: 0, p: 0, vp: 0, r: 0, vr: 0 };
    this._wasOnGround = null;
    this._roll = 0;                    // m rolled on the ground (the runway's slab joints)
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
    const H = this.head;
    H.yaw = H.pitch = H.ay = H.ap = H.vy = H.vp = 0;
    this.gShift.set(0, 0, 0);
    this._prevVel.set(0, 0, 0);
    this._velInit = false;
    this._accBody.set(0, 0, 0);
    const J = this._jolt;
    J.y = J.vy = J.p = J.vp = J.r = J.vr = 0;
    this._wasOnGround = null;
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
    // body acceleration felt by the pilot (for the head shift): from the velocity change (none on
    // the first frame after a spawn: the jump from rest would read as a huge acceleration)
    if (ctx.velocity && dt > 0) {
      this._vyPrev = this._velInit ? this._prevVel.y : ctx.velocity.y;
      if (this._velInit) {
        _v1.copy(ctx.velocity).sub(this._prevVel).divideScalar(Math.max(dt, 1e-3));
        _q1.copy(ctx.quaternion).invert();
        _v1.applyQuaternion(_q1);
        this._accBody.lerp(_v1, damp(dt, 0.25));
      }
      this._prevVel.copy(ctx.velocity);
      this._velInit = true;
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
    // cockpit: 12 cm keeps the pilot's own face out of view (its skin sits a few cm ahead of the eye
    // and comes into view when acceleration pushes the head back); the canopy bow is ~0.4 m away
    const near = this.mode === 'cockpit' ? 0.12 : 0.5;
    if (cam.near !== near) { cam.near = near; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }

  // ------------------------------------------------------------------------------ cockpit
  _cockpit(dt, ctx, look) {
    const cam = this.camera;
    const H = this.head;
    // yaw / pitch set from outside since the last frame (the test API, a script): the view jumps there
    if (H.yaw !== H._ty || H.pitch !== H._tp) { H.ay = H.yaw; H.ap = H.pitch; H.vy = H.vp = 0; }
    if (look.lookCenter) H.centering = true;
    // mouse drag: the head follows the hand (the view a moment later, below)
    const dragging = look.dragButton >= 0;
    if (dragging && (look.dragX || look.dragY)) {
      const k = 0.0042 * (this.fov.cockpit / 62);
      H.yaw -= look.dragX * k;
      H.pitch -= look.dragY * k;
      H.centering = false;
    }
    // hat and numpad: a turn rate that builds up and dies away over ~0.15 s (not a jump to full rate)
    const a = damp(dt, 0.15);
    H.vy += ((look.lookX || 0) * -110 * DEG - H.vy) * a;
    H.vp += ((look.lookY || 0) * 80 * DEG - H.vp) * a;
    if (Math.abs(H.vy) + Math.abs(H.vp) > 1e-4) {
      H.yaw += H.vy * dt;
      H.pitch += H.vp * dt;
      if (look.lookX || look.lookY) H.centering = false;
    }
    if (H.centering) {
      const c = damp(dt, 0.12);
      H.yaw += (0 - H.yaw) * c;
      H.pitch += (0 - H.pitch) * c;
      if (Math.abs(H.yaw) < 0.002 && Math.abs(H.pitch) < 0.002) { H.yaw = H.pitch = 0; H.centering = false; }
    }
    H.yaw = clamp(H.yaw, -165 * DEG, 165 * DEG);
    H.pitch = clamp(H.pitch, -60 * DEG, 88 * DEG);
    // the view: smoothed (a head has mass; it also takes the jitter out of mouse steps)
    const s = damp(dt, 0.045);
    H.ay += (H.yaw - H.ay) * s;
    H.ap += (H.pitch - H.ap) * s;
    H._ty = H.yaw;
    H._tp = H.pitch;
    // zoom: the wheel sets a target field of view, reached smoothly
    const [f0, f1] = this.cockpitFovRange;
    if (look.wheel) this._zoomTarget = clamp((this._zoomTarget ?? this.fov.cockpit) * Math.pow(1.1, look.wheel), f0, f1);
    if (this._zoomTarget != null) {
      this.fov.cockpit += (this._zoomTarget - this.fov.cockpit) * damp(dt, 0.07);
      if (Math.abs(this.fov.cockpit - this._zoomTarget) < 0.05) { this.fov.cockpit = this._zoomTarget; this._zoomTarget = null; }
    }

    // eye point, base direction (the pilot's straight ahead) and head rotation
    const eye = ctx.eye || _v3.set(0, 1.08, -4.47);
    const fwd = ctx.eyeForward;
    const basePitch = (fwd ? Math.atan2(fwd.y, Math.hypot(fwd.x, fwd.z)) : -6 * DEG) - this.cockpitLookDown;
    // the head turns about the neck (the eyes 7 cm above and 9 cm ahead of it): looking aside
    // moves the eyes aside, looking down moves them forward and down; beyond ~60 deg the torso
    // twists and leans out to see behind, and leans forward to look down into the consoles
    const yaw = H.ay, pitch = H.ap;
    // (the neck turns up to ~90 deg and tips back less than forward; the torso does the rest)
    _e.set(pitch > 0 ? pitch * 0.6 : pitch, clamp(yaw, -90 * DEG, 90 * DEG), 0, 'YXZ');
    _q1.setFromEuler(_e);
    const lean = _v1.copy(NECK_TO_EYE).applyQuaternion(_q1).sub(NECK_TO_EYE);
    const twist = THREE.MathUtils.smoothstep(Math.abs(yaw), 60 * DEG, 150 * DEG);
    lean.x += -Math.sign(yaw) * 0.08 * twist;
    lean.z += -0.06 * twist;
    lean.z += -0.07 * THREE.MathUtils.smoothstep(-pitch, 20 * DEG, 60 * DEG) * Math.max(0, Math.cos(yaw));
    // g load pushes the head down / sideways; acceleration pushes it back
    const g = ctx.gLoad != null ? ctx.gLoad : 1;
    const target = _v2.set(
      clamp(-(this._accBody.x / 9.81) * 0.015, -0.03, 0.03),
      clamp(-(g - 1) * 0.0065, -0.035, 0.05),
      clamp((-this._accBody.z / 9.81) * 0.025, -0.03, 0.04),
    );
    if (ctx.onGround) target.y = clamp(target.y, -0.01, 0.01);
    this.gShift.lerp(target, damp(dt, 0.12));
    const J = this._vibration(dt, ctx);
    const local = _v3.copy(eye).add(lean).add(this.gShift);
    local.y += J.y;
    cam.position.copy(local).applyQuaternion(ctx.quaternion).add(ctx.position);

    // orientation: jet attitude * head yaw (about body up) * pitch (about the head's right), and
    // the vibration's small pitch and roll
    _e.set(basePitch + pitch + J.p, yaw, J.r, 'YXZ');
    _q1.setFromEuler(_e);
    cam.quaternion.copy(ctx.quaternion).multiply(_q1);
  }

  /**
   * The cockpit's vibration: a damped spring per axis (seat height m, pitch and roll rad) driven by
   * the runway (the slab joints every ~6 m and the surface's roughness, growing with ground speed),
   * the touchdown (an impulse from the sink rate) and the buffet at high angle of attack. Subtle:
   * millimetres and hundredths of a degree, a few tenths at a hard landing or deep in the buffet.
   */
  _vibration(dt, ctx) {
    const J = this._jolt;
    if (!(dt > 0)) return J;
    const onGround = !!ctx.onGround;
    const gs = ctx.groundSpeed || 0;
    const t = this.time;
    const s = this.vibration;
    // touchdown: the seat (and the pilot) drop with the sink rate, the nose dips a little
    if (this._wasOnGround === false && onGround) {
      // the sink rate of the frame before (the gear may have taken it already)
      const sink = ctx.velocity ? Math.max(0, -ctx.velocity.y, -(this._vyPrev ?? 0)) : 0;
      J.vy -= clamp(sink * 0.12, 0, 0.45) * s;
      J.vp -= clamp(sink * 0.03, 0, 0.1) * s;
    }
    this._wasOnGround = onGround;
    // forcing (accelerations of the springs): the runway's roughness, the buffet
    let fy = 0, fp = 0, fr = 0;
    if (onGround && gs > 0.5) {
      const v = Math.min(1, gs / 80);
      // a slab joint every 6 m: a knock (an impulse), some harder than others
      const j0 = Math.floor(this._roll / 6);
      this._roll += gs * dt;
      const j1 = Math.floor(this._roll / 6);
      if (j1 !== j0) {
        const k = (0.5 + 0.5 * Math.abs(Math.sin(j1 * 12.9898))) * v * s;
        J.vy -= 0.035 * k;
        J.vp += 0.03 * k * (Math.sin(j1 * 78.233) > 0 ? 1 : -1);
      }
      fy += wobble(t * 1.6, 2.2) * 350 * v * v;
      fp += wobble(t * 1.3, 7.7) * 0.5 * v * v;
      fr += wobble(t * 1.1, 4.4) * 0.3 * v;
    }
    const aoa = ctx.alpha ? Math.max(0, ctx.alpha / DEG - 16) / 12 : 0;
    const buffet = Math.min(1, aoa) * Math.min(1, (ctx.qbar || 0) / 6000) + this.shake;
    if (buffet > 0) {
      fp += wobble(t, 3.3) * 2.5 * buffet;
      fr += wobble(t * 0.9, 8.1) * 1.8 * buffet;
      fy += wobble(t * 1.2, 1.9) * 400 * buffet;
    }
    fy *= s; fp *= s; fr *= s;
    // springs: seat ~4.5 Hz, head pitch / roll ~6 Hz, damping 0.35 (semi-implicit Euler, sub-steps)
    const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    const wy = 2 * Math.PI * 4.5, wa = 2 * Math.PI * 6, z = 0.35;
    for (let i = 0; i < n; i++) {
      J.vy += (fy * 0.001 - wy * wy * J.y - 2 * z * wy * J.vy) * h; J.y += J.vy * h;
      J.vp += (fp - wa * wa * J.p - 2 * z * wa * J.vp) * h; J.p += J.vp * h;
      J.vr += (fr - wa * wa * J.r - 2 * z * wa * J.vr) * h; J.r += J.vr * h;
    }
    J.y = clamp(J.y, -0.05, 0.05);
    J.p = clamp(J.p, -0.02, 0.02);
    J.r = clamp(J.r, -0.02, 0.02);
    return J;
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
