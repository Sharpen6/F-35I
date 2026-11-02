// Scripted pilot for the automated tests (tests/e2e.mjs) and the benchmark (?bench=1).
//
// It flies through the normal pilot inputs only (stick, pedals, throttle lever, brakes, gear
// handle), so everything it does goes through the FCS and the flight model like a human's input.
// Plans:
//   takeoff   runway roll on the centreline (MIL, then afterburner), rotate at vr, gear up after a
//             positive climb, climb to `altitude`, then turn to `heading` (or toward `target` {x, z})
//             and hold altitude / speed (`cruiseKt`).
//   land      from a final: localizer and a 3 deg glide slope to an aim point 300 m past the
//             threshold at `approachKt`, flare, touchdown, nose down, brakes to a stop on the runway.
//             With `apc: true` it leaves the throttle to the auto-throttle (throttle null: the
//             input layer keeps the APC on) down to the touchdown, retard included.
//
// update(state, dt) returns the inputs to apply this step: {pitch, roll, yaw, throttle, brake,
// gearHandle, parkingBrake, nwsEnable, speedbrake}. `phase` names what it is doing; `events`
// records the milestones (time, phase, ias, altitude...) for the test report.
// World frame (sim/DESIGN.md): X east, Y up, Z south; headings clockwise from grid north (-Z).

const DEG = Math.PI / 180;
const KT = 0.514444;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * A runway end from airports.json, oriented for use from that end.
 * @returns {{airport, id, thr: {x,y,z}, far: {x,y,z}, hdg, dir: {x,z}, length, width}}
 */
export function findRunway(airports, id, icao = null) {
  for (const ap of airports || []) {
    if (icao && ap.icao !== icao) continue;
    for (const rw of ap.runways || []) {
      const ends = rw.ends || [];
      const i = ends.findIndex((e) => String(e.id) === String(id));
      if (i < 0 || ends.length < 2) continue;
      const e = ends[i], o = ends[1 - i];
      const hdg = e.heading_deg * DEG;
      return {
        airport: ap.icao, name: ap.name, id: e.id, thr: { x: e.x, y: e.y, z: e.z }, far: { x: o.x, y: o.y, z: o.z },
        hdg, dir: { x: Math.sin(hdg), z: -Math.cos(hdg) },
        length: rw.length_m || Math.hypot(o.x - e.x, o.z - e.z), width: rw.width_m || 45,
      };
    }
  }
  return null;
}

/** Position relative to a runway: along (m past the threshold), cross (m right of the centreline). */
export function runwayFrame(rw, p) {
  const dx = p.x - rw.thr.x, dz = p.z - rw.thr.z;
  return { along: dx * rw.dir.x + dz * rw.dir.z, cross: dx * -rw.dir.z + dz * rw.dir.x };
}

export class TestPilot {
  /**
   * @param {object} o  {plan: 'takeoff' | 'land', runway (findRunway), vrKt, altitude (m), heading
   *                    (deg) | target {x, z}, cruiseKt, approachKt, glideDeg, aimM, throttle (start)}
   */
  constructor(o = {}) {
    this.plan = o.plan || 'takeoff';
    this.rw = o.runway || null;
    this.vr = (o.vrKt || 150) * KT;
    this.altitude = o.altitude ?? 3000;
    this.heading = o.heading ?? null;
    this.target = o.target || null;
    this.turnAfter = o.turnAfterAlt ?? 600;              // m above the field before the turn
    this.cruise = (o.cruiseKt || 350) * KT;
    this.vapp = (o.approachKt || 145) * KT;
    this.glide = (o.glideDeg || 3) * DEG;
    this.aim = o.aimM ?? 300;
    this.milTime = o.milTime ?? 3;                       // s at MIL before the burner
    this.apc = !!o.apc;                                  // land: the auto-throttle flies the throttle
    this.phase = this.plan === 'land' ? 'approach' : 'roll';
    this.t = 0;
    this.tPhase = 0;
    this.events = [];
    this._thr = o.throttle ?? 0.6;
    this._thrInt = 0;
    this._gammaPrev = null;
    this._gammaDot = 0;
    this.out = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, gearHandle: true, parkingBrake: false, nwsEnable: true, speedbrake: false };
    this.done = false;
  }

  _to(phase, st) {
    this.phase = phase;
    this.tPhase = 0;
    this.events.push({
      t: +this.t.toFixed(2), phase, ias_kt: +(st.ias / KT).toFixed(1), alt_m: +st.altitude.toFixed(1),
      agl_m: +(st.agl || 0).toFixed(2), vs: +(st.vs || 0).toFixed(2), pitch_deg: +(st.pitch / DEG).toFixed(2),
      heading_deg: +(st.heading / DEG).toFixed(1),
    });
  }

  // ---------------------------------------------------------------------------- inner loops
  /** Stick for a flight-path angle (rad): the FCS turns the stick into a C* (g / pitch-rate) demand. */
  _pitchFor(st, gammaCmd, gearDown, k = gearDown ? 0.16 : 0.09) {
    const e = (gammaCmd - st.gamma) / DEG;
    // the FCS holds the current flight path for a stick inside its free band (3 % after shaping,
    // ~5.5 % of travel): step over the band when the error is more than ~0.2 deg, so small errors
    // are still corrected instead of being held
    const band = 0.056 * Math.sign(e) * Math.min(1, Math.abs(e) / 0.2);
    const x = band + k * e - 0.06 * this._gammaDot / DEG;
    return clamp(x, -0.5, 0.6);
  }

  /** Stick for a bank angle (rad). */
  _rollFor(st, phiCmd) {
    const e = (phiCmd - st.roll) / DEG;
    return clamp(0.035 * e - 0.004 * (st.p || 0) / DEG, -0.5, 0.5);
  }

  /** Bank for a track (rad), limited to `maxBank`. */
  _bankForTrack(st, trackCmd, maxBank = 30 * DEG) {
    const v = st.velocity;
    const track = Math.atan2(v.x, -v.z);
    const e = wrap180((trackCmd - track) / DEG);
    return clamp(2.5 * e, -maxBank / DEG, maxBank / DEG) * DEG;
  }

  /** Throttle for an indicated airspeed (m/s), PI on top of the lever position, below the burner. */
  _throttleFor(st, vCmd, h, max = 0.75) {
    const e = (vCmd - st.ias) / KT;
    this._thrInt = clamp(this._thrInt + e * h * 0.004, -0.5, 0.5);
    this._thr = clamp(this._thr0 + 0.02 * e + this._thrInt, 0, max);
    return this._thr;
  }

  /** Nose-wheel steering / rudder pedals to hold the runway centreline. */
  _steer(st) {
    if (!this.rw) return 0;
    const f = runwayFrame(this.rw, st.position);
    const he = wrap180((st.heading - this.rw.hdg) / DEG);
    const gs = Math.max(st.groundSpeed || 0, 1);
    // aim back at the centreline within ~ 3 s, less heading change the faster we go
    const want = clamp(-Math.atan2(f.cross, Math.max(40, 3 * gs)) / DEG, -8, 8);
    return clamp(0.12 * (want - he) - 0.02 * (st.r || 0) / DEG, -1, 1);
  }

  _gearHeight(st) {
    // main wheels above the ground: the FDM's agl is the stance height, the mains sit 2.44 m aft
    return (st.agl || 0) - 2.44 * Math.sin(Math.max(0, st.pitch - 1.45 * DEG));
  }

  // ---------------------------------------------------------------------------- one step
  update(st, h) {
    this.t += h;
    this.tPhase += h;
    if (this._gammaPrev !== null) this._gammaDot += ((st.gamma - this._gammaPrev) / h - this._gammaDot) * Math.min(1, h / 0.15);
    this._gammaPrev = st.gamma;
    if (this._thr0 === undefined) this._thr0 = this._thr;
    const o = this.out;
    o.yaw = 0; o.brake = 0; o.parkingBrake = false; o.speedbrake = false; o.nwsEnable = true;
    if (this.plan === 'land') this._land(st, h, o);
    else this._takeoff(st, h, o);
    return o;
  }

  _takeoff(st, h, o) {
    const gearDown = st.gear > 0.5;
    const wowMain = (st.wheels || []).some((w) => w.name !== 'nose' && w.wow);
    switch (this.phase) {
      case 'roll':
        o.pitch = 0; o.roll = 0;
        o.throttle = this.tPhase < this.milTime ? 0.75 : 1.0;
        o.yaw = this._steer(st);
        if (this.tPhase >= this.milTime && !this._abEvent) { this._abEvent = true; this.events.push({ t: +this.t.toFixed(2), phase: 'afterburner', ias_kt: +(st.ias / KT).toFixed(1) }); }
        if (st.ias >= this.vr) this._to('rotate', st);
        break;
      case 'rotate':
        o.pitch = 0.9; o.roll = 0; o.throttle = 1.0;
        o.yaw = st.onGround ? this._steer(st) : 0;
        if (!st.onGround && !wowMain) this._to('liftoff', st);
        break;
      case 'liftoff':
        // hold the takeoff attitude until the climb is positive, then gear up
        o.pitch = 0.9; o.roll = this._rollFor(st, 0); o.throttle = 1.0;
        if (st.vs > 2 && (st.agl || 0) > 10) { o.gearHandle = false; this._to('gear up', st); }
        break;
      case 'gear up':
      case 'climb': {
        if (this.phase === 'gear up' && st.gear < 0.01) this._to('climb', st);
        const toGo = this.altitude - st.altitude;
        const gCmd = clamp(toGo * 0.02, -5, 12) * DEG;
        o.pitch = this._pitchFor(st, gCmd, gearDown);
        o.throttle = st.ias < 300 * KT ? 1.0 : 0.75;
        let phi = 0;
        const fieldAlt = this.rw ? this.rw.thr.y : 0;
        if (st.altitude - fieldAlt > this.turnAfter) phi = this._bankForTrack(st, this._headingCmd(st));
        o.roll = this._rollFor(st, phi);
        if (Math.abs(toGo) < 60) { this._thr0 = 0.75; this._thr = 0.75; this._to('cruise', st); }
        break;
      }
      case 'cruise': {
        const gCmd = clamp((this.altitude - st.altitude) * 0.04, -5, 5) * DEG;
        o.pitch = this._pitchFor(st, gCmd, gearDown);
        o.roll = this._rollFor(st, this._bankForTrack(st, this._headingCmd(st)));
        o.throttle = this._throttleFor(st, this.cruise, h, 0.75);
        break;
      }
      default: break;
    }
  }

  _headingCmd(st) {
    if (this.target) return Math.atan2(this.target.x - st.position.x, -(this.target.z - st.position.z));
    if (this.heading != null) return this.heading * DEG;
    return st.heading;
  }

  _land(st, h, o) {
    const rw = this.rw;
    const f = runwayFrame(rw, st.position);
    const gearDown = st.gear > 0.5;
    const hm = this._gearHeight(st);
    const wowMain = (st.wheels || []).some((w) => w.name !== 'nose' && w.wow);
    const wowNose = (st.wheels || []).some((w) => w.name === 'nose' && w.wow);
    o.gearHandle = true;
    switch (this.phase) {
      case 'approach': {
        // glide slope through the aim point; the antenna is the jet's reference point
        const ghs = rw.thr.y + 2.0 + Math.tan(this.glide) * (this.aim - f.along);
        const dev = st.position.y - ghs;                            // + = high
        const gCmd = -this.glide - clamp(dev * 0.06, -2.5, 2.5) * DEG;
        o.pitch = this._pitchFor(st, gCmd, gearDown);
        const trackCmd = rw.hdg - clamp(f.cross * 0.15, -15, 15) * DEG;
        o.roll = this._rollFor(st, this._bankForTrack(st, trackCmd, 20 * DEG));
        o.throttle = this.apc ? null : this._throttleFor(st, this.vapp, h, 0.75);
        if (hm < 14 && f.along > -500) this._to('flare', st);
        break;
      }
      case 'flare': {
        // sink rate proportional to the height of the mains (exponential flare, 2.5 s), power
        // kept on until the last couple of metres (the FCS caps the pitch at 14 deg near the ground,
        // tailStrikePitch in f35i_config.js)
        const vsCmd = -clamp(hm / 2.5, 0.4, 4.2);
        const gCmd = Math.asin(clamp(vsCmd / Math.max(st.tas || st.ias, 30), -0.2, 0.2));
        o.pitch = this._pitchFor(st, gCmd, gearDown, 0.26);
        const trackCmd = rw.hdg - clamp(f.cross * 0.15, -8, 8) * DEG;
        o.roll = this._rollFor(st, this._bankForTrack(st, trackCmd, 8 * DEG));
        o.yaw = 0;
        o.throttle = this.apc ? null : hm < 2 ? 0 : this._throttleFor(st, this.vapp, h, 0.75);
        if (wowMain || st.onGround) this._to('touchdown', st);
        break;
      }
      case 'touchdown':
        // let the nose down gently, idle
        o.throttle = 0; o.roll = 0;
        o.pitch = -0.15;
        o.yaw = this._steer(st);
        if (wowNose || this.tPhase > 4) this._to('rollout', st);
        break;
      case 'rollout':
        o.throttle = 0; o.roll = 0; o.pitch = 0;
        o.brake = 1; o.speedbrake = true;
        o.yaw = this._steer(st);
        if ((st.groundSpeed || 0) < 0.5) { this._to('stopped', st); this.done = true; }
        break;
      case 'stopped':
        o.throttle = 0; o.pitch = 0; o.roll = 0; o.brake = 1; o.parkingBrake = true;
        break;
      default: break;
    }
  }
}
