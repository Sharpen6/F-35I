// F-35I flight dynamics: rigid-body 6-DOF with quaternions, fixed physics sub-steps, ISA atmosphere,
// table aerodynamics with Mach effects, F135 engine, fly-by-wire (fcs.js), oleo landing gear with
// tyre friction, nose-wheel steering and brakes, crash detection.
//
//   const fdm = new FlightModel(F35I_CONFIG, terrain);   // terrain: {heightAt, normalAt, surfaceAt}
//   fdm.reset(spawns.telnof_33);                          // returns {throttle, gearDown} it set up
//   fdm.step(dt, input);                                  // input: see DESIGN.md
//   visual.setPose(fdm.state.position, fdm.state.quaternion); visual.setControls(fdm.state.controls);
//
// Frames: world X east, Y up, Z south (north = -Z); body +X right, +Y up, -Z forward (DESIGN.md).
// Internally the dynamics use classic aero body axes (x forward, y right, z down; p, q, r).
// state.position is the world position of the body-frame origin (the model reference point); the mass
// centre sits config.mass.cg from it (see f35i_config.js).

import { Vector3, Quaternion } from 'three';
import { Aero } from './aero.js';
import { Engine } from './engine.js';
import { LandingGear } from './gear.js';
import { FlightControlSystem } from './fcs.js';
import { atmosphere, impactPressure, casFromImpactPressure, G0, KT, FT, RHO0 } from './atmosphere.js';
import { clamp, approach, D2R } from './tables.js';
import { F35I_CONFIG, parseContacts } from './f35i_config.js';

const TWO_PI = Math.PI * 2;

/** Make sure a ground object has heightAt / normalAt / surfaceAt (normal by finite differences). */
function wrapGround(g) {
  if (!g) g = {};
  const heightAt = g.heightAt ? g.heightAt.bind(g) : () => 0;
  const normalAt = g.normalAt ? g.normalAt.bind(g) : (x, z, out) => {
    const e = 1.0;
    const dx = heightAt(x + e, z) - heightAt(x - e, z);
    const dz = heightAt(x, z + e) - heightAt(x, z - e);
    return out.set(-dx / (2 * e), 1, -dz / (2 * e)).normalize();
  };
  const surfaceAt = g.surfaceAt ? g.surfaceAt.bind(g) : () => ({ type: 'runway', friction: 0.8 });
  return {
    heightAt,
    normalAt: (x, z, out) => {
      const r = normalAt(x, z, out);
      if (r && r !== out && r.isVector3) out.copy(r);
      if (!(out.y > 0)) out.set(0, 1, 0);
      return out;
    },
    surfaceAt,
  };
}

export class FlightModel {
  /**
   * @param config F35I_CONFIG (or a variant from configWithRig)
   * @param ground {heightAt(x, z), normalAt(x, z, out), surfaceAt(x, z)} - the Terrain
   */
  constructor(config = F35I_CONFIG, ground = null) {
    this.cfg = config;
    this.ground = wrapGround(ground);
    this.aero = new Aero(config.aero);
    this.engine = new Engine(config.engine);
    this.fcs = new FlightControlSystem(config.fcs);
    this.cg = new Vector3().fromArray(config.mass.cg);
    this.gear = new LandingGear(config.gear, this.cg, config.mass.massRef);
    this.h = 1 / config.substepHz;
    this.wind = new Vector3();          // world wind (m/s), the air mass moves with it

    // ---- physics state (CG)
    this._pos = new Vector3();
    this._vel = new Vector3();
    this._quat = new Quaternion();
    this.p = 0; this.q = 0; this.r = 0;     // aero body rates (rad/s)
    this.fuelKg = config.mass.fuelCapacity * config.mass.fuelDefault;
    this.gearPos = 1;
    this.flaps = 0;
    this.speedbrake = 0;
    this.canopy = 0;
    this.act = { de: 0, da: 0, dr: 0 };
    this.rollDistance = 0;
    this.time = 0;
    this.crashed = false;
    this.crashReason = '';
    this.lastTouchdown = null;
    this._acc = 0;
    this._throttle = 0;
    this._timeOnGround = 0;
    this._wasOnGround = true;

    // ---- sensor values carried from one sub-step to the next (FCS inputs)
    this._nz = 1; this._ny = 0; this._nx = 0; this._Qalpha = 0; this._ay = 0; this._gearPitch = 0;

    // ---- scratch
    this._ex = new Vector3(); this._ey = new Vector3(); this._ez = new Vector3();
    this._va = new Vector3(); this._F = new Vector3(); this._gF = new Vector3(); this._gM = new Vector3();
    this._omegaW = new Vector3(); this._tmp = new Vector3(); this._tmp2 = new Vector3();
    this._dq = new Quaternion(); this._origin = new Vector3();
    this._prevOrigin = new Vector3(); this._prevQuat = new Quaternion();
    this._atm = {};
    this._ao = {};
    this._fc = { alpha: 0, beta: 0, mach: 0, V: 0, p: 0, q: 0, r: 0, flaps: 0, gear: 1, speedbrake: 0, canopy: 0, hWing: Infinity };
    this._sens = {};
    this._mp = { mass: 0, Ixx: 0, Iyy: 0, Izz: 0, Ixz: 0 };
    this._geo = { S: config.aero.S, b: config.aero.b, cbar: config.aero.cbar, deRate: config.actuators.de.rate };
    this._gearCtx = { pos: this._pos, vel: this._vel, omegaW: this._omegaW, quat: this._quat, ground: this.ground,
      h: this.h, gearDown: true, brakeL: 0, brakeR: 0, parking: false, steerCmd: 0, nwsOn: true, groundSpeed: 0 };
    this._air = { V: 0, alpha: 0, beta: 0, mach: 0, qbar: 0, cas: 0, rho: RHO0, theta: 0, phi: 0, psi: 0, gamma: 0,
      hGround: 0, aglMains: Infinity, wowMain: false, wowNose: false };

    this.state = {
      position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), angularVelocity: new Vector3(),
      alpha: 0, beta: 0, ias: 0, tas: 0, mach: 0, gLoad: 1, altitude: 0, agl: 0, heading: 0, pitch: 0, roll: 0, vs: 0,
      onGround: true, wheels: [], gear: 1,
      engine: { rpm: 0, thrust: 0, ab: 0, fuelKg: 0, fuelFlow: 0, running: true, throttle: 0 },
      controls: {
        stick_pitch: 0, stick_roll: 0, pedals: 0, throttle: 0, flaps: 0, speedbrake: 0, gear: 1, nws: 0,
        roll_distance: 0, weapon_bays: 0, canopy: 0, refuel_door: 0, gun_door: 0, tailhook: 0, ab: 0,
        lights: { nav: true, landing: false, formation: false, anticoll: true },
      },
      crashed: false, crashReason: '', warnings: [],
      // extras (SI unless named): handy for the HMD / HUD and tests
      ias_kt: 0, tas_kt: 0, alt_ft: 0, vs_fpm: 0, gamma: 0, groundSpeed: 0, qbar: 0, mass: 0, time: 0,
      fcsMode: 'ground', p: 0, q: 0, r: 0, gLateral: 0, lastTouchdown: null, trimThrottle: 0,
    };
    this._stance = this._computeStance();
    this.reset({ x: 0, y: 0, z: 0, heading_deg: 0, on_ground: true });
  }

  setGround(ground) {
    this.ground = wrapGround(ground);
    this._gearCtx.ground = this.ground;
  }

  /** Replace the gear contact points, e.g. with AircraftVisual.info.gearContacts. */
  setGearContacts(list) {
    const c = parseContacts(list);
    if (!c) return false;
    this.gear.setContacts(c, this.cg, this.cfg.mass.massRef);
    this._stance = this._computeStance();
    return true;
  }

  // ------------------------------------------------------------------------------ mass properties
  mass() {
    const m = this.cfg.mass;
    return m.empty + m.pilotMisc + Math.max(0, this.fuelKg);
  }

  _massProps() {
    const m = this.cfg.mass;
    const mass = this.mass();
    const k = mass / m.massRef;
    const mp = this._mp;
    mp.mass = mass;
    mp.Ixx = m.Ixx * k; mp.Iyy = m.Iyy * k; mp.Izz = m.Izz * k; mp.Ixz = m.Ixz * k;
    return mp;
  }

  /** Static ground attitude from the gear geometry: pitch of the nose/main contact line, and the
   *  height of the body origin above the ground when standing on the gear. */
  _computeStance() {
    let n = null;
    let my = 0, mz = 0, k = 0;
    for (const u of this.gear.units) {
      if (u.isNose) n = u; else { my += u.pos[1]; mz += u.pos[2]; k++; }
    }
    my /= k; mz /= k;
    const pitch = Math.atan2(my - n.pos[1], mz - n.pos[2]);
    const originHeight = -(my * Math.cos(pitch) - mz * Math.sin(pitch));
    return { pitch, originHeight };
  }

  // ------------------------------------------------------------------------------ reset / spawn
  /**
   * Spawn from spawns.json: {x, y, z, heading_deg, on_ground, speed_ms} plus optional throttle (0..1),
   * gear (bool or 0..1), fuel (fraction) or fuelKg, flight_path_deg.  On the ground the wheels are put
   * on the terrain at (x, z) (y is the ground height); in the air y is the altitude MSL and speed_ms
   * the true airspeed, and the jet is trimmed for 1 g flight on that path (throttle too unless given).
   * Returns {throttle, gearDown} so the input layer can match its levers.
   */
  reset(spawn = {}) {
    const cfg = this.cfg;
    this.crashed = false;
    this.crashReason = '';
    this.lastTouchdown = null;
    this.time = 0;
    this._acc = 0;
    this.rollDistance = 0;
    this.p = this.q = this.r = 0;
    this.act.de = this.act.da = this.act.dr = 0;
    this.speedbrake = 0;
    this.canopy = 0;
    this.gear.reset();
    if (spawn.fuelKg != null) this.fuelKg = clamp(+spawn.fuelKg, 0, cfg.mass.fuelCapacity);
    else this.fuelKg = cfg.mass.fuelCapacity * clamp(spawn.fuel != null ? +spawn.fuel : cfg.mass.fuelDefault, 0, 1);

    const x = +spawn.x || 0, z = +spawn.z || 0;
    const heading = (+spawn.heading_deg || 0) * D2R;
    const onGround = spawn.on_ground !== false && !(spawn.speed_ms > 30 && spawn.on_ground == null);
    let throttle = spawn.throttle != null ? clamp(+spawn.throttle, 0, 1) : 0;
    let gearDown;

    if (onGround) {
      gearDown = true;
      this.gearPos = 1;
      const hG = this.ground.heightAt(x, z);        // the physics ground (spawn.y is the same height)
      const pitch = this._stance.pitch;
      this._setAttitude(heading, pitch, 0);
      // origin on the stance height above the ground, then the CG from it
      this._origin.set(x, hG + this._stance.originHeight, z);
      this._pos.copy(this.cg).applyQuaternion(this._quat).add(this._origin);
      this._vel.set(0, 0, 0);
      this.flaps = 1;
      this.engine.setSteady(0, true);
      this.fcs.reset({ mode: 'ground' });
      // let the struts settle on the parking brake, then put the jet back exactly on the spot
      const settle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, parkingBrake: true, gearHandle: true, nwsEnable: true };
      const fuel = this.fuelKg;
      for (let i = 0; i < 2.5 * cfg.substepHz && !this.crashed; i++) this._substep(this.h, settle);
      this.fuelKg = fuel;
      this.crashed = false;
      this.crashReason = '';
      const o = this._originWorld(this._origin);
      this._pos.x += x - o.x;
      this._pos.z += z - o.z;
      this._vel.set(0, 0, 0);
      this.p = this.q = this.r = 0;
      const pitchNow = Math.asin(clamp(this._fwd().y, -1, 1));
      const rollNow = this._euler().phi;
      this._setAttitude(heading, pitchNow, rollNow);
      this.gear.releaseAnchors();     // keep the settled contact state, re-anchor on the spot
      this.rollDistance = 0;
      this.engine.setSteady(throttle, true);
      this.fcs.reset({ mode: 'ground' });
      this._wasOnGround = true;
      this._timeOnGround = 10;
    } else {
      gearDown = spawn.gear != null ? !!(+spawn.gear >= 0.5 || spawn.gear === true) : false;
      this.gearPos = gearDown ? 1 : 0;
      const V = spawn.speed_ms != null ? +spawn.speed_ms : 200;
      const gamma = (+spawn.flight_path_deg || 0) * D2R;
      const alt = spawn.y != null ? +spawn.y : 3000;
      const trim = this.trim(V, alt, gamma, this.gearPos);
      if (spawn.throttle == null) throttle = trim.throttle;
      this.flaps = trim.flaps;
      this._setAttitude(heading, gamma + trim.alpha, 0);
      this._pos.set(x, alt, z);
      // velocity along the flight path
      this._vel.set(Math.sin(heading) * Math.cos(gamma), Math.sin(gamma), -Math.cos(heading) * Math.cos(gamma)).multiplyScalar(V);
      this._pos.add(this._tmp.copy(this.cg).applyQuaternion(this._quat));
      this.act.de = trim.de;
      this.engine.setSteady(throttle, this.fuelKg > 0);
      this.fcs.reset({ mode: 'air', gammaRef: gamma, bankRef: 0, de: trim.de });
      this._nz = Math.cos(gamma);
      this._wasOnGround = false;
      this._timeOnGround = 0;
    }
    this._throttle = throttle;
    this.state.trimThrottle = throttle;
    this._originWorld(this._origin);
    this._prevOrigin.copy(this._origin);
    this._prevQuat.copy(this._quat);
    this._publish(0, null);
    return { throttle, gearDown };
  }

  _setAttitude(heading, pitch, roll) {
    // body->world = Ry(-heading) Rx(pitch) Rz(-roll)
    const q = this._quat;
    const qy = this._dq.setFromAxisAngle(this._tmp.set(0, 1, 0), -heading);
    q.copy(qy);
    q.multiply(this._dq.setFromAxisAngle(this._tmp.set(1, 0, 0), pitch));
    q.multiply(this._dq.setFromAxisAngle(this._tmp.set(0, 0, 1), -roll));
    q.normalize();
  }

  _fwd() {
    return this._tmp2.set(0, 0, -1).applyQuaternion(this._quat);
  }

  _originWorld(out) {
    return out.copy(this.cg).negate().applyQuaternion(this._quat).add(this._pos);
  }

  /** Aero body axes in the world: ex forward, ey right, ez down. */
  _basis() {
    const { x, y, z, w } = this._quat;
    const ex = this._ex, ey = this._ey, ez = this._ez;
    // rotation matrix columns: col0 = body +X, col1 = body +Y, col2 = body +Z
    const m00 = 1 - 2 * (y * y + z * z), m10 = 2 * (x * y + z * w), m20 = 2 * (x * z - y * w);
    const m01 = 2 * (x * y - z * w), m11 = 1 - 2 * (x * x + z * z), m21 = 2 * (y * z + x * w);
    const m02 = 2 * (x * z + y * w), m12 = 2 * (y * z - x * w), m22 = 1 - 2 * (x * x + y * y);
    ey.set(m00, m10, m20);           // right
    ez.set(-m01, -m11, -m21);        // down
    ex.set(-m02, -m12, -m22);        // forward
  }

  _euler() {
    this._basis();
    const ex = this._ex, ey = this._ey, ez = this._ez;
    const theta = Math.asin(clamp(ex.y, -1, 1));
    const phi = Math.atan2(-ey.y, -ez.y);
    let psi = Math.atan2(ex.x, -ex.z);
    if (Math.abs(ex.y) > 0.999) psi = Math.atan2(-ez.x, ez.z) * (ex.y > 0 ? 1 : -1);
    return { theta, phi, psi };
  }

  // ------------------------------------------------------------------------------ trim
  /**
   * Trimmed 1 g flight at true airspeed V (m/s), altitude h (m), flight-path angle gamma (rad):
   * {alpha, throttle, thrust, de, flaps}.  Used for airborne spawns and by the tests.
   */
  trim(V, h, gamma = 0, gearPos = 0) {
    const cfg = this.cfg;
    const atm = atmosphere(h);
    const M = V / atm.a;
    const qbar = 0.5 * atm.rho * V * V;
    const W = this.mass() * G0;
    const cas = casFromImpactPressure(impactPressure(M, atm.p));
    const flaps = this._flapSchedule(cas, gearPos, 0.05, M);
    const fc = { alpha: 0.05, beta: 0, mach: M, V, p: 0, q: 0, r: 0, flaps, gear: gearPos, speedbrake: 0, canopy: 0, hWing: Infinity };
    const u = { de: 0, da: 0, dr: 0 };
    const ao = {};
    let alpha = 0.05, T = 0;
    for (let it = 0; it < 40; it++) {
      const clReq = (W * Math.cos(gamma) - T * Math.sin(alpha)) / (qbar * cfg.aero.S);
      for (let j = 0; j < 20; j++) {
        fc.alpha = alpha;
        const cl = this.aero.evaluate(fc, u, ao).CL;
        fc.alpha = alpha + 1e-3;
        const cl2 = this.aero.evaluate(fc, u, ao).CL;
        const slope = Math.max((cl2 - cl) / 1e-3, 0.3);
        alpha = clamp(alpha + (clReq - cl) / slope, -0.3, 0.6);
      }
      fc.alpha = alpha;
      this.aero.evaluate(fc, u, ao);
      const D = qbar * cfg.aero.S * ao.CD;
      T = (D + W * Math.sin(gamma)) / Math.cos(alpha);
    }
    // throttle for that thrust (steady state is monotonic in throttle)
    let lo = 0, hi = 1;
    if (this.engine.steadyThrust(0, atm, M) >= T) hi = 0;
    else if (this.engine.steadyThrust(1, atm, M) <= T) lo = 1;
    else {
      for (let i = 0; i < 40; i++) {
        const mid = 0.5 * (lo + hi);
        if (this.engine.steadyThrust(mid, atm, M) < T) lo = mid; else hi = mid;
      }
    }
    const throttle = 0.5 * (lo + hi);
    const de = clamp(-ao.Cm0 / ao.Cm_de, -1, 1);
    return { alpha, throttle, thrust: T, de, flaps, cas, mach: M };
  }

  _flapSchedule(cas, gearPos, alpha, mach) {
    const s = this.cfg.schedules;
    if (gearPos > 0.5) return clamp((s.flapsUpCas - cas) / (s.flapsUpCas - s.flapsFullCas), 0, 1);
    const mf = s.maneuverFlaps;
    if (mach > mf.maxMach) return 0;
    return clamp((alpha - mf.fromAlpha) * mf.perRad, 0, mf.max);
  }

  // ------------------------------------------------------------------------------ stepping
  /**
   * Advance by dt seconds of real time (fixed sub-steps of 1/substepHz; the pose published in
   * state is interpolated between the last two sub-steps so motion stays smooth at any frame rate).
   */
  step(dt, input = {}) {
    dt = clamp(+dt || 0, 0, 0.1);
    const h = this.h;
    this._acc += dt;
    let n = 0;
    const maxSteps = Math.ceil(0.1 / h) + 2;
    while (this._acc >= h - 1e-9 && n < maxSteps) {
      this._prevQuat.copy(this._quat);
      this._originWorld(this._prevOrigin);
      if (!this.crashed) this._substep(h, input);
      this._acc -= h;
      n++;
    }
    if (this._acc < 0) this._acc = 0;
    this._publish(this._acc / h, input);
    return this.state;
  }

  _substep(h, inp) {
    const cfg = this.cfg;
    const A = cfg.aero;
    const ground = this.ground;
    const mp = this._massProps();
    const m = mp.mass;
    this.time += h;

    // ---------------------------------------------------------------- attitude and air data
    const eu = this._euler();             // also fills _ex, _ey, _ez
    const ex = this._ex, ey = this._ey, ez = this._ez;
    const atm = atmosphere(this._pos.y, this._atm);
    const va = this._va.copy(this._vel).sub(this.wind);
    const u = va.dot(ex), v = va.dot(ey), w = va.dot(ez);
    const V = va.length();
    const alpha = V > 0.5 ? Math.atan2(w, u) : 0;
    const beta = V > 0.5 ? Math.asin(clamp(v / V, -1, 1)) : 0;
    const qbar = 0.5 * atm.rho * V * V;
    const M = V / atm.a;
    const cas = casFromImpactPressure(impactPressure(M, atm.p));
    const gs = Math.hypot(this._vel.x, this._vel.z);
    const spd = this._vel.length();
    const gamma = spd > 1 ? Math.asin(clamp(this._vel.y / spd, -1, 1)) : 0;
    const air = this._air;
    air.V = V; air.alpha = alpha; air.beta = beta; air.mach = M; air.qbar = qbar; air.cas = cas; air.rho = atm.rho;
    air.theta = eu.theta; air.phi = eu.phi; air.psi = eu.psi; air.gamma = gamma;

    // ---------------------------------------------------------------- ground proximity
    const hG = ground.heightAt(this._pos.x, this._pos.z);
    air.hGround = hG;
    const hCG = this._pos.y - hG;
    let aglMains = Infinity;
    if (hCG < 40) {
      for (const g of this.gear.units) {
        if (g.isNose) continue;
        this._tmp.set(g.pos[0] - this.cg.x, g.pos[1] - this.cg.y, g.pos[2] - this.cg.z).applyQuaternion(this._quat).add(this._pos);
        aglMains = Math.min(aglMains, this._tmp.y - ground.heightAt(this._tmp.x, this._tmp.z));
      }
    }
    air.aglMains = aglMains;
    let wowMain = false, wowNose = false;
    for (const g of this.gear.units) {
      if (!g.wow) continue;
      if (g.isNose) wowNose = true; else wowMain = true;
    }
    air.wowMain = wowMain; air.wowNose = wowNose;
    const onGround = wowMain || wowNose;

    // ---------------------------------------------------------------- discrete systems
    const thr = clamp(inp.throttle != null ? +inp.throttle : this._throttle, 0, 1);
    this._throttle = thr;
    const handleDown = inp.gearHandle !== false;
    if (handleDown) this.gearPos = Math.min(1, this.gearPos + h / cfg.gear.retractTime);
    else if (!onGround) this.gearPos = Math.max(0, this.gearPos - h / cfg.gear.retractTime);  // WOW interlock
    const flapT = this._flapSchedule(cas, this.gearPos, alpha, M);
    this.flaps = approach(this.flaps, flapT, cfg.actuators.flaps * h);
    let sbCmd = inp.speedbrake === true ? 1 : clamp(+inp.speedbrake || 0, 0, 1);
    if (cfg.schedules.autoSpeedbrakeOnRollout && wowMain && thr < 0.05 && gs > 15 && this._timeOnGround > 1) sbCmd = 1;
    if (thr > cfg.engine.abThrottle) sbCmd = 0;
    this.speedbrake = approach(this.speedbrake, sbCmd, cfg.actuators.speedbrake * h);
    const canopyT = inp.canopy && gs < 25 ? 1 : 0;
    this.canopy = approach(this.canopy, canopyT, cfg.actuators.canopy * h);

    // ---------------------------------------------------------------- aero (current surfaces)
    const fc = this._fc;
    fc.alpha = alpha; fc.beta = beta; fc.mach = M; fc.V = V;
    fc.p = this.p; fc.q = this.q; fc.r = this.r;
    fc.flaps = this.flaps; fc.gear = this.gearPos; fc.speedbrake = this.speedbrake; fc.canopy = this.canopy;
    fc.hWing = hCG + 0.15;
    const ao = this.aero.evaluate(fc, this.act, this._ao);

    // ---------------------------------------------------------------- flight control system
    const s = this._sens;
    s.V = V; s.qbar = qbar; s.mach = M; s.alpha = alpha; s.beta = beta;
    s.p = this.p; s.q = this.q; s.r = this.r;
    s.theta = eu.theta; s.phi = eu.phi; s.gamma = gamma;
    s.nz = this._nz; s.Qalpha = this._Qalpha; s.ay = this._ay;
    s.wowMain = wowMain; s.wowNose = wowNose; s.gearDown = this.gearPos; s.aglMains = aglMains;
    s.groundSpeed = gs; s.cas = cas;
    s.gearPitchMoment = this._gearPitch;
    // load factor per radian of AoA (g limiter gain schedule)
    const fc2 = this._fc2 || (this._fc2 = {});
    Object.assign(fc2, fc);
    fc2.alpha = alpha - 0.02;
    const dCLda = (ao.CL - this.aero.evaluate(fc2, this.act, this._ao2 || (this._ao2 = {})).CL) / 0.02;
    s.nAlpha = (qbar * A.S * Math.max(dCLda, 0)) / (m * G0);
    const cmd = this.fcs.update(h, inp, s, ao, mp, this._geo);
    this._actuate('de', cmd.de, h);
    this._actuate('da', cmd.da, h);
    this._actuate('dr', cmd.dr, h);
    const de = this.act.de, da = this.act.da, dr = this.act.dr;
    const Cm = ao.Cm0 + ao.Cm_de * de;
    const Cl = ao.Cl0 + ao.Cl_da * da + ao.Cl_dr * dr;
    const Cn = ao.Cn0 + ao.Cn_da * da + ao.Cn_dr * dr;
    const CY = A.CYbeta * Math.sin(clamp(beta, -1.2, 1.2)) + A.CYdr * dr;

    // ---------------------------------------------------------------- engine
    const burnt = this.engine.update(h, thr, atm, M, qbar, this.fuelKg);
    this.fuelKg = Math.max(0, this.fuelKg - burnt);
    const T = this.engine.thrust;

    // ---------------------------------------------------------------- forces and moments
    const qS = qbar * A.S;
    const ca = Math.cos(alpha), sa = Math.sin(alpha), cb = Math.cos(beta), sbt = Math.sin(beta);
    const X = qS * (-ao.CD * ca * cb + ao.CL * sa) + T;
    const Y = qS * (-ao.CD * sbt + CY);
    const Z = qS * (-ao.CD * sa * cb - ao.CL * ca);
    let Lm = qS * A.b * Cl, Mm = qS * A.cbar * Cm, Nm = qS * A.b * Cn;
    const F = this._F.set(0, 0, 0).addScaledVector(ex, X).addScaledVector(ey, Y).addScaledVector(ez, Z);

    // landing gear (world force, world moment about the CG)
    const omegaW = this._omegaW.set(0, 0, 0).addScaledVector(ex, this.p).addScaledVector(ey, this.q).addScaledVector(ez, this.r);
    const gc = this._gearCtx;
    gc.h = h;
    gc.gearDown = this.gearPos >= 0.999;
    const brake = clamp(+inp.brake || 0, 0, 1);
    gc.brakeL = Math.max(brake, clamp(+inp.brakeLeft || 0, 0, 1));
    gc.brakeR = Math.max(brake, clamp(+inp.brakeRight || 0, 0, 1));
    gc.parking = !!inp.parkingBrake;
    gc.steerCmd = clamp(+inp.yaw || 0, -1, 1);
    gc.nwsOn = inp.nwsEnable !== false;
    gc.groundSpeed = gs;
    let gev = null;
    this._gF.set(0, 0, 0);
    this._gM.set(0, 0, 0);
    if (hCG < 30) {
      gev = this.gear.compute(gc, this._gF, this._gM);
      F.add(this._gF);
      Lm += this._gM.dot(ex); Mm += this._gM.dot(ey); Nm += this._gM.dot(ez);
      this._gearPitch = this._gM.dot(ey);
    } else {
      for (const g of this.gear.units) { g.wow = g.wasWow = false; g.force = g.compression = 0; g.anchored = false; }
      this._gearPitch = 0;
    }
    this.rollDistance += this.gear.rollRate * h * (onGround ? 1 : 0);

    // specific force (load factors) for the next FCS frame
    const mg = m * G0;
    this._nz = -F.dot(ez) / mg;
    this._ny = F.dot(ey) / mg;
    this._nx = F.dot(ex) / mg;
    const axb = F.dot(ex) / m - G0 * ex.y;
    const ayb = F.dot(ey) / m - G0 * ey.y;
    const azb = F.dot(ez) / m - G0 * ez.y;
    this._ay = ayb;
    this._Qalpha = (u * (azb - this.p * v) - w * (axb + this.r * v)) / (u * u + w * w + 1e-3);

    // ---------------------------------------------------------------- integrate (semi-implicit Euler)
    this._vel.addScaledVector(F, h / m);
    this._vel.y -= G0 * h;
    this._pos.addScaledVector(this._vel, h);
    const { Ixx, Iyy, Izz, Ixz } = mp;
    const p = this.p, q = this.q, r = this.r;
    const Lt = Lm - (Izz - Iyy) * q * r + Ixz * p * q;
    const Nt = Nm - (Iyy - Ixx) * p * q - Ixz * q * r;
    const det = Ixx * Izz - Ixz * Ixz;
    const pdot = (Izz * Lt + Ixz * Nt) / det;
    const rdot = (Ixz * Lt + Ixx * Nt) / det;
    const qdot = (Mm - (Ixx - Izz) * p * r - Ixz * (p * p - r * r)) / Iyy;
    this.p = clamp(p + pdot * h, -20, 20);
    this.q = clamp(q + qdot * h, -20, 20);
    this.r = clamp(r + rdot * h, -20, 20);
    // quaternion: body (three) angular velocity = (q, -r, -p)
    const wx = this.q, wy = -this.r, wz = -this.p;
    const wn = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (wn > 1e-12) {
      const ang = wn * h;
      const sh = Math.sin(ang / 2) / wn;
      this._dq.set(wx * sh, wy * sh, wz * sh, Math.cos(ang / 2));
      this._quat.multiply(this._dq).normalize();
    }

    // ---------------------------------------------------------------- touchdown bookkeeping, crashes
    if (onGround) this._timeOnGround += h; else this._timeOnGround = 0;
    if (gev && gev.touchdown.length && !this._wasOnGround) {
      this.lastTouchdown = { time: this.time, sink: -this._vel.y, closing: gev.maxClosing, ias: cas, gs,
        pitch: eu.theta, alpha, wheel: gev.touchdown[0].name };
    }
    const nowOnGround = this.gear.units.some((g) => g.wow);
    this._wasOnGround = nowOnGround;
    this._checkCrash(gev, hCG);
  }

  _actuate(k, cmd, h) {
    const a = this.cfg.actuators[k];
    const cur = this.act[k];
    const want = (cmd - cur) / Math.max(a.tau, h);
    const rate = clamp(want, -a.rate, a.rate);
    this.act[k] = clamp(cur + rate * h, -1, 1);
  }

  _crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this._vel.set(0, 0, 0);
    this.p = this.q = this.r = 0;
  }

  _checkCrash(gev, hCG) {
    const cfg = this.cfg;
    if (this._nz > cfg.limits.overstressG || this._nz < cfg.limits.overstressNegG) {
      this._crash(`Structural failure: ${this._nz.toFixed(1)} g`);
      return;
    }
    if (gev) {
      if (gev.water) { this._crash('Ditched: the wheels touched water'); return; }
      if (gev.maxClosing > cfg.gear.touchdownCrashSink) {
        this._crash(`Hard landing: ${gev.maxClosing.toFixed(1)} m/s sink at touchdown, the gear collapsed`);
        return;
      }
      if (gev.overload) { this._crash('Landing gear collapsed (overload)'); return; }
    }
    // cheap gate: the airframe reaches ~9 m from the CG; on steep ground also look under the nose
    if (hCG > 150) return;
    if (hCG > 16) {
      const N = this._tmp.copy(this._ex).multiplyScalar(9.25).add(this._pos);
      if (N.y - this.ground.heightAt(N.x, N.z) > 16) return;
    }
    // airframe points against the terrain / water: collect every point below the surface, then name
    // the most telling cause
    const ground = this.ground;
    let hits = 0, water = false, underside = true, tipsOnly = true, tail = false, first = null;
    for (const pt of cfg.gear.airframePoints) {
      const P = this._tmp.set(pt.pos[0] - this.cg.x, pt.pos[1] - this.cg.y, pt.pos[2] - this.cg.z)
        .applyQuaternion(this._quat).add(this._pos);
      if (P.y >= ground.heightAt(P.x, P.z)) continue;
      hits++;
      first = first || pt.name;                      // the list runs nose to tail
      const surf = ground.surfaceAt(P.x, P.z) || {};
      if (surf.type === 'water') water = true;
      if (pt.pos[1] > 0) underside = false;          // body y < 0: belly, keel, inlets, nozzle, chin
      if (pt.name !== 'wingtip' && pt.name !== 'stabilator tip') tipsOnly = false;
      if (pt.name === 'nozzle' || pt.name === 'aft keel') tail = true;
    }
    if (!hits) return;
    if (water) this._crash('Crashed into the water');
    else if (this.gearPos < 0.999 && underside) this._crash('Belly landing: the landing gear was not down');
    else if (tipsOnly) this._crash(`${first === 'wingtip' ? 'Wingtip' : 'Stabilator tip'} struck the ground`);
    else if (tail && underside) this._crash('Tail strike');
    else this._crash(`Crashed: the ${first} hit the ground`);
  }

  // ------------------------------------------------------------------------------ output
  _publish(alphaInterp, inp) {
    const st = this.state;
    const cfg = this.cfg;
    const eu = this._euler();
    const air = this._air;
    this._originWorld(this._origin);
    st.position.lerpVectors(this._prevOrigin, this._origin, alphaInterp);
    st.quaternion.slerpQuaternions(this._prevQuat, this._quat, alphaInterp);
    st.velocity.copy(this._vel);
    st.angularVelocity.set(this.q, -this.r, -this.p);
    st.p = this.p; st.q = this.q; st.r = this.r;
    // air data (recomputed for the current state)
    const atm = atmosphere(this._pos.y, this._atm);
    const va = this._va.copy(this._vel).sub(this.wind);
    const V = va.length();
    const u = va.dot(this._ex), v = va.dot(this._ey), w = va.dot(this._ez);
    st.alpha = V > 0.5 ? Math.atan2(w, u) : 0;
    st.beta = V > 0.5 ? Math.asin(clamp(v / V, -1, 1)) : 0;
    st.tas = V;
    st.mach = V / atm.a;
    st.qbar = 0.5 * atm.rho * V * V;
    st.ias = casFromImpactPressure(impactPressure(st.mach, atm.p));
    st.ias_kt = st.ias / KT;
    st.tas_kt = V / KT;
    st.gLoad = this._nz;
    st.gLateral = this._ny;
    st.altitude = this._origin.y;
    st.alt_ft = st.altitude / FT;
    const hG = this.ground.heightAt(this._origin.x, this._origin.z);
    st.agl = Math.max(0, this._origin.y - hG - this._stance.originHeight);
    st.heading = ((eu.psi % TWO_PI) + TWO_PI) % TWO_PI;
    st.pitch = eu.theta;
    st.roll = eu.phi;
    st.vs = this._vel.y;
    st.vs_fpm = st.vs / FT * 60;
    const spd = this._vel.length();
    st.gamma = spd > 1 ? Math.asin(clamp(this._vel.y / spd, -1, 1)) : 0;
    st.groundSpeed = Math.hypot(this._vel.x, this._vel.z);
    st.mass = this.mass();
    st.time = this.time;
    st.onGround = this.gear.units.some((g) => g.wow);
    // wheels
    const units = this.gear.units;
    if (st.wheels.length !== units.length) st.wheels = units.map((g) => ({ name: g.name, wow: false, compression: 0, steer: 0, force: 0, staticCompression: g.cs }));
    for (let i = 0; i < units.length; i++) {
      const g = units[i], o = st.wheels[i];
      o.name = g.name; o.wow = g.wow; o.compression = g.compression; o.steer = g.steer; o.force = g.force;
      o.staticCompression = g.cs;
    }
    st.gear = this.gearPos;
    // engine
    const e = this.engine;
    st.engine.rpm = e.rpm;
    st.engine.thrust = e.thrust;
    st.engine.ab = e.ab;
    st.engine.fuelKg = this.fuelKg;
    st.engine.fuelFlow = e.fuelFlow;
    st.engine.running = e.running;
    st.engine.throttle = this._throttle;
    // controls for AircraftVisual.setControls (rig names)
    const c = st.controls;
    c.stick_pitch = this.act.de;
    c.stick_roll = this.act.da;
    c.pedals = this.act.dr;
    c.throttle = this._throttle;
    c.flaps = this.flaps;
    c.speedbrake = this.speedbrake;
    c.gear = this.gearPos;
    let nws = 0;
    for (const g of units) if (g.steerable) nws = g.steer / (60 * D2R);
    c.nws = clamp(nws, -1, 1);
    c.roll_distance = this.rollDistance;
    c.canopy = this.canopy;
    c.ab = e.ab;
    c.lights.landing = this.gearPos > 0.99;
    st.crashed = this.crashed;
    st.crashReason = this.crashReason;
    st.fcsMode = this.fcs.mode;
    st.lastTouchdown = this.lastTouchdown;
    // warnings
    const wn = st.warnings;
    wn.length = 0;
    if (!this.crashed) {
      const lim = cfg.limits;
      const gearDown = this.gearPos > 0.99;
      if (!st.onGround) {
        if (!gearDown && st.agl < 250 && st.ias < 190 * KT && st.vs < -1.5) wn.push('GEAR');
        const tti = st.vs < -1 ? st.agl / -st.vs : Infinity;
        if ((!gearDown && st.agl < 150 && st.vs < -4) || (tti < 5 && st.vs < -20)) wn.push('PULL UP');
        if (st.alpha > cfg.fcs.alphaMax + 2 * D2R && !(inp && inp.highAoA)) wn.push('AOA');
      }
      if (this._nz > cfg.fcs.nMax + 0.3 || this._nz < cfg.fcs.nMin - 0.3) wn.push('OVER-G');
      if (st.ias > lim.vne || st.mach > lim.mmo + 0.05) wn.push('OVERSPEED');
      if (!e.running) wn.push('ENGINE');
      else if (this.fuelKg < 800) wn.push('BINGO FUEL');
      if (inp && inp.parkingBrake && this._throttle > 0.5) wn.push('PARKING BRAKE');
    }
    return st;
  }
}

export default FlightModel;
