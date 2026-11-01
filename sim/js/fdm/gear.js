// Landing gear: three oleo struts (spring + damper along the strut axis) with tyre friction
// (rolling resistance, anti-skid braking, cornering), nose-wheel steering, parking brake.
//
// Geometry: each contact point is given in the aircraft body frame (+X right, +Y up, -Z forward,
// origin = model reference point) at the STATIC position, i.e. where the tyre meets the ground when
// the jet stands on its gear (that is how the Blender model is posed).  The strut's free (fully
// extended) position is staticCompression lower along the body Y axis; the spring is sized so the
// static load of the reference mass compresses it back exactly to the modelled stance.

import { Vector3 } from 'three';
import { clamp } from './tables.js';

export class LandingGear {
  /**
   * @param cfg   config.gear
   * @param cg    body-frame centre of gravity (Vector3)
   * @param massRef reference mass for the spring sizing (kg)
   */
  constructor(cfg, cg, massRef) {
    this.cfg = cfg;
    this.units = [];
    this.events = { touchdown: [], maxClosing: 0, bottomed: false, overload: false, water: false, maxForceRatio: 0 };
    this.rollRate = 0;            // m/s of wheel travel (forward), for the spinning wheels
    this._t = {
      r: new Vector3(), P: new Vector3(), n: new Vector3(), up: new Vector3(), Pc: new Vector3(),
      rc: new Vector3(), vc: new Vector3(), f: new Vector3(), s: new Vector3(), F: new Vector3(),
      tmp: new Vector3(), D: new Vector3(), vpl: new Vector3(),
    };
    this.setContacts(cfg.contacts, cg, massRef);
  }

  /** (Re)build the struts from contact points [{name, pos: [x, y, z], radius}] (body frame). */
  setContacts(contacts, cg, massRef) {
    const c = this.cfg;
    this.cg = cg.clone();
    const list = contacts.map((k) => ({ name: k.name, pos: k.pos.slice(), radius: k.radius }));
    // the steerable nose wheel is the most forward contact; the others carry brakes
    let nose = list[0];
    for (const k of list) if (k.pos[2] < nose.pos[2]) nose = k;
    const mains = list.filter((k) => k !== nose);
    const zMain = mains.reduce((a, k) => a + k.pos[2], 0) / Math.max(1, mains.length);
    const noseShare = clamp((zMain - cg.z) / (zMain - nose.pos[2]), 0.02, 0.6);
    const W = massRef * c.g;
    this.noseShare = noseShare;
    this.units = list.map((k) => {
      const isNose = k === nose;
      const s = isNose ? c.nose : c.main;
      const Fstatic = isNose ? W * noseShare : (W * (1 - noseShare)) / mains.length;
      const k1 = Fstatic / s.staticCompression;         // F(c) = k/2 (c + c^3/cs^2): F(cs) = k cs
      const kLin = 2 * k1;                              // dF/dc at the static point
      const mEff = Fstatic / c.g;
      const bCrit = 2 * Math.sqrt(kLin * mEff);
      return {
        name: k.name, pos: k.pos, radius: k.radius, isNose,
        steerable: isNose, brakes: !isNose,
        cs: s.staticCompression, stroke: s.stroke, k: k1, Fstatic,
        bComp: s.dampingCompression * bCrit, bReb: s.dampingRebound * bCrit,
        // runtime state
        wow: false, wasWow: false, compression: 0, compressionRate: 0, force: 0, steer: 0,
        anchored: false, anchor: new Vector3(), slip: 0,
      };
    });
  }

  /** Let go of the parking-brake anchors (they re-capture where the wheels stand next step). */
  releaseAnchors() {
    for (const u of this.units) u.anchored = false;
  }

  reset() {
    for (const u of this.units) {
      u.wow = u.wasWow = false;
      u.compression = u.compressionRate = u.force = u.steer = 0;
      u.anchored = false;
    }
    this.rollRate = 0;
  }

  /** Max nose-wheel steering angle (rad) at ground speed v: full lock while taxiing, then limited to a
   *  lateral acceleration so a full pedal input stays controllable at speed (the rudder takes over). */
  maxSteer(v) {
    const c = this.cfg.steering;
    const wheelbase = this.wheelbase();
    const byAccel = Math.atan((wheelbase * c.lateralAccel) / Math.max(v * v, 1e-3));
    return Math.min(c.maxAngle, byAccel);
  }

  wheelbase() {
    let zn = 0, zm = 0, nm = 0;
    for (const u of this.units) {
      if (u.isNose) zn = u.pos[2]; else { zm += u.pos[2]; nm++; }
    }
    return nm ? Math.max(1, zm / nm - zn) : 6;
  }

  /**
   * Gear forces for one step.
   * ctx: {pos (CG, world), vel (world), omegaW (world angular velocity), quat (body->world), ground,
   *       h (s), gearDown (bool: down and locked), brakeL, brakeR (0..1), parking (bool),
   *       steerCmd (-1..1), nwsOn (bool), groundSpeed (m/s)}
   * Adds the world force to fOut and the world moment about the CG to mOut.
   */
  compute(ctx, fOut, mOut) {
    const c = this.cfg;
    const t = this._t;
    const ev = this.events;
    ev.touchdown.length = 0;
    ev.maxClosing = 0;
    ev.bottomed = false;
    ev.overload = false;
    ev.water = false;
    ev.maxForceRatio = 0;
    this.rollRate = 0;
    let rollSum = 0, rollN = 0, noseRoll = 0;
    const { pos, vel, omegaW, quat, ground, h } = ctx;
    const up = t.up.set(0, 1, 0).applyQuaternion(quat);
    let noseWow = false;
    for (const u of this.units) if (u.isNose) noseWow = u.wow;

    for (const u of this.units) {
      // ---- steering (nose wheel): follows the pedals when NWS is engaged and the wheel is on the ground
      if (u.steerable) {
        const target = ctx.nwsOn && noseWow ? clamp(ctx.steerCmd, -1, 1) * this.maxSteer(ctx.groundSpeed) : 0;
        const rate = c.steering.rate * h;
        u.steer += clamp(target - u.steer, -rate, rate);
      }
      u.wow = false;
      u.force = 0;
      u.compression = 0;
      u.compressionRate = 0;
      if (!ctx.gearDown) { u.wasWow = false; u.anchored = false; continue; }

      // ---- free (extended) contact point in the world
      t.r.set(u.pos[0] - this.cg.x, u.pos[1] - u.cs - this.cg.y, u.pos[2] - this.cg.z).applyQuaternion(quat);
      t.P.copy(pos).add(t.r);
      const hG = ground.heightAt(t.P.x, t.P.z);
      if (t.P.y > hG + 0.05) { u.wasWow = false; u.anchored = false; continue; }
      ground.normalAt(t.P.x, t.P.z, t.n);
      const d = (hG - t.P.y) * t.n.y;              // depth below the local ground plane
      const an = up.dot(t.n);                       // strut axis against the ground normal
      if (d <= 0 || an < 0.2) { u.wasWow = false; u.anchored = false; continue; }
      const comp = d / an;                          // compression along the strut

      // ---- contact point (tyre on the ground) and its velocity
      t.Pc.copy(t.P).addScaledVector(up, comp);
      t.rc.copy(t.Pc).sub(pos);
      t.vc.crossVectors(omegaW, t.rc).add(vel);
      const vn = -t.vc.dot(t.n);                    // closing speed into the ground
      const cdot = vn / an;

      // ---- oleo: progressive air spring + orifice damping (stiffer in rebound), stiff end stop
      const cc = Math.min(comp, u.stroke);
      let Fs = 0.5 * u.k * (cc + (cc * cc * cc) / (u.cs * u.cs));
      if (comp > u.stroke) { Fs += c.bottomStiffness * u.k * (comp - u.stroke); ev.bottomed = true; }
      const Fd = cdot > 0 ? u.bComp * cdot : u.bReb * cdot;
      const Fn = Math.max(0, Fs + Fd);
      if (Fn <= 0) { u.anchored = false; continue; }
      u.wow = true;
      u.force = Fn;
      u.compression = comp;
      u.compressionRate = cdot;
      ev.maxForceRatio = Math.max(ev.maxForceRatio, Fn / u.Fstatic);
      if (Fn > c.overloadFactor * u.Fstatic) ev.overload = true;
      if (!u.wasWow) {
        ev.touchdown.push({ name: u.name, closing: vn });
        ev.maxClosing = Math.max(ev.maxClosing, vn);
      }
      u.wasWow = true;

      // ---- surface
      const surf = ground.surfaceAt(t.Pc.x, t.Pc.z) || {};
      const type = surf.type || 'runway';
      if (type === 'water') ev.water = true;
      const mu = surf.friction != null ? surf.friction : (type === 'runway' ? 0.8 : 0.5);
      const muRoll = c.rollingResistance[type] != null ? c.rollingResistance[type] : c.rollingResistance.ground;

      // ---- wheel axes on the ground plane: f rolling direction, s to the right
      const st = u.steer;
      t.f.set(Math.sin(st), 0, -Math.cos(st)).applyQuaternion(quat);
      t.f.addScaledVector(t.n, -t.f.dot(t.n)).normalize();
      t.s.crossVectors(t.f, t.n);
      const vf = t.vc.dot(t.f);
      const vs = t.vc.dot(t.s);
      if (!u.isNose) { rollSum += vf; rollN++; } else noseRoll = vf;

      let Fl = 0, Fy = 0;
      // The parking brake is a full brake application: it holds a stopped wheel (the anchor below)
      // and, once thrust or a slope makes the wheels slide, keeps braking like full pedals (it
      // used to stop acting altogether the moment the anchor let go).
      const pedal = u.brakes ? (u.pos[0] < 0 ? ctx.brakeL : ctx.brakeR) : 0;
      const brake = u.brakes && ctx.parking ? 1 : pedal;
      const hold = u.brakes && brake >= c.holdBrake;
      t.vpl.copy(t.vc).addScaledVector(t.n, -t.vc.dot(t.n));
      const vplane = t.vpl.length();
      if (hold && (u.anchored || vplane < c.anchorCapture)) {
        // ---- static friction while the brakes are held: a stiff spring to the spot where the wheel
        //      stopped, limited by the tyre friction (it slides, dragging the spot, beyond that)
        if (!u.anchored) { u.anchor.copy(t.Pc); u.anchored = true; }
        t.D.copy(t.Pc).sub(u.anchor);
        t.D.addScaledVector(t.n, -t.D.dot(t.n));
        t.F.copy(t.D).multiplyScalar(-c.anchorStiffness).addScaledVector(t.vpl, -c.anchorDamping);
        const lim = mu * Fn;
        const mag = t.F.length();
        if (mag > lim) {
          t.F.multiplyScalar(lim / mag);
          u.anchor.copy(t.Pc).addScaledVector(t.F, 1 / c.anchorStiffness);
        }
        if (vplane > c.anchorRelease) u.anchored = false;
        Fl = t.F.dot(t.f);
        Fy = t.F.dot(t.s);
      } else {
        u.anchored = false;
        // rolling resistance and anti-skid braking (never locks: the brake force tracks the friction)
        Fl = -muRoll * Fn * Math.tanh(vf / 0.3);
        if (brake > 0) Fl += -brake * c.brakeMu * mu * Fn * Math.tanh(vf / 0.5);
        // cornering: tyre side force from the slip angle; a castering (free) nose wheel carries none
        if (u.steerable && !ctx.nwsOn) {
          Fy = -c.casterDamping * vs;
        } else {
          const slip = Math.atan2(vs, Math.max(Math.abs(vf), c.slipMinSpeed));
          u.slip = slip;
          Fy = -c.lateralMu * mu * Fn * Math.tanh(slip / c.slipPeak);
        }
        // friction circle
        const Fh = Math.hypot(Fl, Fy);
        const lim = mu * Fn;
        if (Fh > lim) { Fl *= lim / Fh; Fy *= lim / Fh; }
      }

      // ---- total force and moment about the CG
      t.F.copy(t.n).multiplyScalar(Fn).addScaledVector(t.f, Fl).addScaledVector(t.s, Fy);
      fOut.add(t.F);
      t.tmp.crossVectors(t.rc, t.F);
      mOut.add(t.tmp);
    }
    // wheel travel: the mean of the main wheels (the visual spins every wheel by distance / radius)
    this.rollRate = rollN ? rollSum / rollN : noseRoll;
    return ev;
  }
}
