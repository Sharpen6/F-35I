// Stand-in for js/fdm/FlightModel.js (sim/DESIGN.md interface), used with index.html?stubs=1.
// Not a 6-DOF model: the stick drives the attitude rates directly (as a fly-by-wire jet feels),
// the aircraft is a point mass with thrust, lift (from the angle of attack), drag and gravity,
// the nose weathervanes into the airflow, and on the ground it rolls on its wheels with rolling
// friction, brakes and nose-wheel steering, rotates above 140 kt and lifts off when the lift
// carries it. Enough to exercise the app shell, the cameras, the HMD and the sound.

import * as THREE from 'three';

const G = 9.81, DEG = Math.PI / 180, KT = 0.514444, FT = 0.3048;
const STANCE_H = 2.03;          // body origin above the ground on the gear
const STANCE_PITCH = 1.4 * DEG;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const approach = (x, t, r) => (x < t ? Math.min(t, x + r) : Math.max(t, x - r));

const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3(), _v = new THREE.Vector3();
const _F = new THREE.Vector3(), _l = new THREE.Vector3(), _dq = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class FlightModel {
  constructor(config = {}, ground = null) {
    this.cfg = config;
    this.ground = ground || { heightAt: () => 0, surfaceAt: () => ({ type: 'runway', friction: 0.8 }) };
    this.mass = 18000;
    this.state = {
      position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(),
      alpha: 0, beta: 0, ias: 0, tas: 0, mach: 0, gLoad: 1, altitude: 0, agl: 0, heading: 0, pitch: 0, roll: 0, vs: 0,
      onGround: true, wheels: [
        { name: 'nose', wow: true, compression: 0.05, steer: 0 },
        { name: 'left', wow: true, compression: 0.05, steer: 0 },
        { name: 'right', wow: true, compression: 0.05, steer: 0 },
      ],
      gear: 1, engine: { rpm: 66, thrust: 0, ab: 0, fuelKg: 5000, throttle: 0, running: true },
      controls: { stick_pitch: 0, stick_roll: 0, pedals: 0, throttle: 0, flaps: 0, speedbrake: 0, gear: 1, nws: 0, roll_distance: 0, canopy: 0, ab: 0,
        weapon_bays: 0, refuel_door: 0, gun_door: 0, tailhook: 0, lights: { nav: true, anticoll: true, landing: true, formation: false } },
      crashed: false, crashReason: '', warnings: [],
    };
    this.reset({ x: 0, y: 0, z: 0, heading_deg: 0, on_ground: true });
  }

  reset(spawn = {}) {
    const s = this.state;
    const hdg = (spawn.heading_deg || 0) * DEG;
    this.onGround = spawn.on_ground !== false;
    this.gear = this.onGround ? 1 : (spawn.gear != null ? +spawn.gear : 0);
    this.canopy = 0;
    this.rpm = 66; this.ab = 0;
    this.rollDist = 0;
    this.steer = 0;
    this.time = 0;
    s.crashed = false; s.crashReason = '';
    s.engine.fuelKg = 8278 * 0.6;
    const gy = this.ground.heightAt(spawn.x || 0, spawn.z || 0);
    const pitch = this.onGround ? STANCE_PITCH : ((spawn.flight_path_deg || 0) + 3) * DEG;
    _e.set(pitch, -hdg, 0, 'YXZ');
    s.quaternion.setFromEuler(_e);
    if (this.onGround) {
      s.position.set(spawn.x || 0, gy + STANCE_H, spawn.z || 0);
      s.velocity.set(0, 0, 0);
    } else {
      s.position.set(spawn.x || 0, spawn.y != null ? spawn.y : gy + 1500, spawn.z || 0);
      const V = spawn.speed_ms || 180, gam = (spawn.flight_path_deg || 0) * DEG;
      s.velocity.set(Math.sin(hdg) * Math.cos(gam), Math.sin(gam), -Math.cos(hdg) * Math.cos(gam)).multiplyScalar(V);
    }
    const throttle = spawn.throttle != null ? +spawn.throttle : (this.onGround ? 0 : 0.6);
    this.rpm = this.onGround ? 66 : 66 + 34 * Math.min(1, throttle / 0.75);
    this._publish({ throttle });
    return { throttle, gearDown: this.gear > 0.5 };
  }

  step(dt, input = {}) {
    const s = this.state;
    dt = clamp(dt || 0, 0, 0.1);
    if (s.crashed || dt === 0) { this._publish(input); return s; }
    this.time += dt;
    const thr = clamp(input.throttle || 0, 0, 1);
    // engine
    const rpmT = 66 + 34 * Math.min(1, thr / 0.75);
    this.rpm = approach(this.rpm, rpmT, (rpmT > this.rpm ? 7 : 9) * dt);
    this.ab = approach(this.ab, thr > 0.75 && this.rpm > 97 ? (thr - 0.75) / 0.25 : 0, 1.2 * dt);
    const h = s.position.y;
    const sigma = Math.exp(-h / 9000);
    const dry = 6000 + 119000 * Math.pow(clamp((this.rpm - 66) / 34, 0, 1), 1.6);
    const thrust = (dry + 66000 * this.ab) * Math.pow(sigma, 0.7);
    s.engine.fuelKg = Math.max(0, s.engine.fuelKg - (0.1 + 0.8 * (this.rpm - 66) / 34 + 2.7 * this.ab) * dt);
    // gear and canopy
    const wantGear = input.gearHandle === false && !this.onGround ? 0 : 1;
    this.gear = approach(this.gear, wantGear, dt / 6);
    const V0 = s.velocity.length();
    this.canopy = approach(this.canopy, input.canopy && V0 < 25 ? 1 : 0, dt / 4);

    // attitude: the stick commands rates (body axes), the nose weathervanes into the airflow
    const q = s.quaternion;
    _f.set(0, 0, -1).applyQuaternion(q);
    _u.set(0, 1, 0).applyQuaternion(q);
    _r.set(1, 0, 0).applyQuaternion(q);
    const V = Math.max(V0, 0.01);
    const qbar = 0.5 * 1.225 * sigma * V * V;
    const auth = clamp(qbar / 9000, 0, 1);
    let pRate = (input.roll || 0) * 190 * DEG * auth;
    let qRate = (input.pitch || 0) * Math.min(22 * DEG, (8.5 * G) / V) * Math.max(auth, 0.25);
    let rRate = (input.yaw || 0) * 6 * DEG * auth;
    _v.copy(s.velocity).divideScalar(V);
    const beta = Math.asin(clamp(_v.dot(_r), -1, 1));
    const alpha = Math.atan2(-_v.dot(_u), _v.dot(_f));
    if (V0 > 30 && !this.onGround) rRate += beta * 1.6;      // turn coordination (nose into the wind)
    if (this.onGround) {
      pRate = 0;
      rRate = 0;
      // rotation above 140 kt
      const pitch = Math.asin(clamp(_f.y, -1, 1));
      if (V0 < 140 * KT) qRate = (STANCE_PITCH - pitch) * 4;
      else qRate = clamp(qRate, (STANCE_PITCH - pitch) * 4, 6 * DEG);
    }
    // body rates: + pitch = nose up (about +X), + yaw = nose right (about -Y), + roll = right wing down (about -Z)
    _dq.setFromEuler(_e.set(qRate * dt, -rRate * dt, -pRate * dt, 'YXZ'));
    q.multiply(_dq).normalize();

    // forces: thrust, lift, drag, gravity
    _f.set(0, 0, -1).applyQuaternion(q);
    _u.set(0, 1, 0).applyQuaternion(q);
    const CL = clamp(3.6 * alpha, -1.0, 1.6) * clamp(V0 / 20, 0, 1);
    const CD = 0.022 + 0.17 * CL * CL + 0.02 * this.gear + 0.03 * (input.speedbrake || 0);
    _l.copy(_u).addScaledVector(_v, -_u.dot(_v)).normalize();
    _F.copy(_f).multiplyScalar(thrust)
      .addScaledVector(_l, qbar * 42.7 * CL)
      .addScaledVector(_v, -qbar * 42.7 * CD);
    this._gLoad = clamp(_F.dot(_u) / (this.mass * G), -5, 12);    // load factor: aero + thrust along body up
    _F.y -= this.mass * G;
    const gy = this.ground.heightAt(s.position.x, s.position.z);
    // ground: wheels carry the weight, friction, brakes, steering
    if (this.onGround) {
      const fwd = _v.set(_f.x, 0, _f.z).normalize();
      const spd = s.velocity.dot(fwd);
      const surf = this.ground.surfaceAt ? this.ground.surfaceAt(s.position.x, s.position.z) : { friction: 0.8 };
      const brake = (input.parkingBrake ? 1 : 0) + (input.brake || 0);
      const roll = 0.015 * this.mass * G * Math.sign(spd);
      const brk = Math.min(1, brake) * 0.6 * (surf.friction || 0.8) * this.mass * G * Math.sign(spd);
      let along = _F.dot(fwd) - roll - brk;
      if (Math.abs(spd) < 0.3 && brake > 0.5 && Math.abs(_F.dot(fwd)) < 0.6 * this.mass * G) along = -spd * this.mass / dt;
      let newSpd = spd + along / this.mass * dt;
      if (spd !== 0 && Math.sign(newSpd) !== Math.sign(spd) && brake > 0) newSpd = 0;
      // nose wheel steering: turn rate from the wheel angle
      const maxSteer = clamp(60 * DEG * Math.min(1, 6 / Math.max(1, Math.abs(newSpd))), 2 * DEG, 60 * DEG);
      this.steer = approach(this.steer, (input.yaw || 0) * maxSteer, 1.0 * dt);
      const yawRate = newSpd * Math.tan(this.steer) / 6.0;
      _dq.setFromAxisAngle(_u.set(0, 1, 0), -yawRate * dt);
      q.premultiply(_dq).normalize();
      _f.set(0, 0, -1).applyQuaternion(q);
      fwd.set(_f.x, 0, _f.z).normalize();
      const liftUp = _F.y + this.mass * G;
      s.velocity.copy(fwd).multiplyScalar(newSpd);
      this.rollDist += newSpd * dt;
      // lift-off when the wings carry the jet
      if (liftUp > this.mass * G * 1.02 && newSpd > 60) {
        this.onGround = false;
        s.velocity.y = 0.5;
      }
      s.position.addScaledVector(s.velocity, dt);
      if (this.onGround) s.position.y = gy + STANCE_H;
    } else {
      s.velocity.addScaledVector(_F, dt / this.mass);
      s.position.addScaledVector(s.velocity, dt);
      // touchdown
      if (s.position.y <= gy + STANCE_H) {
        const pitch = Math.asin(clamp(_f.y, -1, 1));
        _r.set(1, 0, 0).applyQuaternion(q);
        const bank = Math.asin(clamp(-_r.y, -1, 1));
        const surf = this.ground.surfaceAt ? this.ground.surfaceAt(s.position.x, s.position.z) : { type: 'runway' };
        if (surf.type === 'water') this._crash('Crashed into the water');
        else if (this.gear < 0.99) this._crash('Belly landing: the landing gear was not down');
        else if (s.velocity.y < -4) this._crash(`Hard landing: ${(-s.velocity.y).toFixed(1)} m/s sink at touchdown`);
        else if (Math.abs(bank) > 25 * DEG) this._crash('Wingtip struck the ground');
        else if (pitch < -8 * DEG || pitch > 18 * DEG) this._crash('Crashed: the nose hit the ground');
        else {
          this.onGround = true;
          s.position.y = gy + STANCE_H;
          s.velocity.y = 0;
          _e.setFromQuaternion(q, 'YXZ');
          _e.z = 0;
          q.setFromEuler(_e);
        }
      }
    }
    this._thrust = thrust;
    this._publish(input);
    return s;
  }

  _crash(reason) {
    this.state.crashed = true;
    this.state.crashReason = reason;
    this.state.velocity.set(0, 0, 0);
  }

  _publish(input) {
    const s = this.state;
    const q = s.quaternion;
    _f.set(0, 0, -1).applyQuaternion(q);
    _u.set(0, 1, 0).applyQuaternion(q);
    _r.set(1, 0, 0).applyQuaternion(q);
    const V = s.velocity.length();
    s.tas = V;
    const sigma = Math.exp(-s.position.y / 9000);
    s.ias = V * Math.sqrt(sigma);
    s.mach = V / 340;
    if (V > 1) {
      _v.copy(s.velocity).divideScalar(V);
      s.alpha = Math.atan2(-_v.dot(_u), _v.dot(_f));
      s.beta = Math.asin(clamp(_v.dot(_r), -1, 1));
    } else { s.alpha = 0; s.beta = 0; }
    s.gLoad = this.onGround ? 1 : (this._gLoad != null ? this._gLoad : 1);
    s.altitude = s.position.y;
    const gy = this.ground.heightAt(s.position.x, s.position.z);
    s.agl = Math.max(0, s.position.y - gy - STANCE_H);
    s.heading = ((Math.atan2(_f.x, -_f.z) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    s.pitch = Math.asin(clamp(_f.y, -1, 1));
    s.roll = Math.atan2(-_r.y, _u.y);
    s.vs = s.velocity.y;
    s.onGround = this.onGround;
    s.groundSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    for (const w of s.wheels) { w.wow = this.onGround; w.compression = this.onGround ? 0.05 : 0; w.steer = w.name === 'nose' ? this.steer : 0; }
    s.gear = this.gear;
    const thr = clamp((input && input.throttle) || 0, 0, 1);
    s.engine.rpm = this.rpm;
    s.engine.ab = this.ab;
    s.engine.thrust = this._thrust || 0;
    s.engine.throttle = thr;
    const c = s.controls;
    c.stick_pitch = clamp((input && input.pitch) || 0, -1, 1);
    c.stick_roll = clamp((input && input.roll) || 0, -1, 1);
    c.pedals = clamp((input && input.yaw) || 0, -1, 1);
    c.throttle = thr;
    c.gear = this.gear;
    c.ab = this.ab;
    c.canopy = this.canopy;
    c.nws = clamp(this.steer / (60 * DEG), -1, 1);
    c.roll_distance = this.rollDist;
    c.flaps = this.gear > 0.5 ? 1 : 0;
    c.speedbrake = (input && input.speedbrake) || 0;
    // warnings (as the real model names them)
    const w = s.warnings;
    w.length = 0;
    if (!s.crashed && !this.onGround) {
      if (this.gear < 0.99 && s.agl < 250 && s.ias < 190 * KT && s.vs < -1.5) w.push('GEAR');
      if ((this.gear < 0.99 && s.agl < 150 && s.vs < -4) || (s.vs < -20 && s.agl / -s.vs < 5)) w.push('PULL UP');
      if (s.alpha > 27 * DEG) w.push('AOA');
    }
    if (s.gLoad > 9.3) w.push('OVER-G');
    s.ias_kt = s.ias / KT;
    s.alt_ft = s.altitude / FT;
    s.vs_fpm = s.vs / FT * 60;
  }
}

/** The real FlightModel takes a config; the stand-in ignores it. */
export const F35I_CONFIG = {};
