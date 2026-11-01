// Pratt & Whitney F135-PW-100 model: core spool dynamics, afterburner light-off and zone fill,
// thrust lapse with density and Mach, fuel flow.
//
// Throttle: 0 = idle, 0.75 = MIL (100 % N2, no afterburner), 0.75..1 = afterburner (min .. max).
// Steady dry thrust is linear in throttle (the engine control schedules N2 for that); the spool
// accelerates slowly at low N2 and faster near MIL, so idle -> MIL takes ~4.5 s.

import { clamp } from './tables.js';

const SIGMA_TROPOPAUSE = 0.29708;   // ISA density ratio at 11 km

export class Engine {
  constructor(cfg) {
    this.cfg = cfg;               // config.engine
    this.rpm = cfg.rpmIdle;       // N2, percent
    this.ab = 0;                  // afterburner fill 0..1
    this.abLit = false;
    this.abTimer = 0;             // light-off delay counter
    this.thrust = 0;              // N, along the body x axis (negative = windmill / ram drag)
    this.fuelFlow = 0;            // kg/s
    this.running = true;
  }

  /** Density lapse: sigma^n in the troposphere, proportional to sigma above the tropopause
   *  (constant temperature there). */
  static lapse(sigma, n, isothermal) {
    if (!isothermal) return Math.pow(sigma, n);
    return Math.pow(SIGMA_TROPOPAUSE, n) * (sigma / SIGMA_TROPOPAUSE);
  }

  inletFactor(M) {
    const c = this.cfg.inlet;
    return M <= c.fromMach ? 1 : Math.max(0.2, 1 - c.loss * (M - c.fromMach) * (M - c.fromMach));
  }

  /** Thrust at MIL, max afterburner and idle for the flight condition (N). */
  limits(atm, M, out = {}) {
    const c = this.cfg;
    const iso = atm.T < 216.66;
    const inlet = this.inletFactor(M);
    out.mil = c.milThrust * Engine.lapse(atm.sigma, c.milLapse, iso) * (1 + c.milMach[0] * M + c.milMach[1] * M * M) * inlet;
    out.max = c.maxThrust * Engine.lapse(atm.sigma, c.abLapse, iso) * (1 + c.abMach[0] * M + c.abMach[1] * M * M) * inlet;
    // Idle: a little thrust at low speed, net ram drag at high Mach (as in published engine decks).
    out.idle = c.idleThrust * Engine.lapse(atm.sigma, c.milLapse, iso) * (1 - c.idleMachDrag * M);
    return out;
  }

  /** Commanded N2 for a throttle position (steady dry thrust linear in throttle up to MIL). */
  rpmCommand(throttle) {
    const c = this.cfg;
    const tdry = clamp(throttle / c.milThrottle, 0, 1);
    return c.rpmIdle + (c.rpmMil - c.rpmIdle) * Math.pow(tdry, 1 / c.thrustRpmExponent);
  }

  afterburnerCommand(throttle) {
    const c = this.cfg;
    return throttle > c.abThrottle ? clamp((throttle - c.milThrottle) / (1 - c.milThrottle), 0, 1) : 0;
  }

  /** Set the engine to the steady state for a throttle position (spawns, trim). */
  setSteady(throttle, running = true) {
    this.running = running;
    this.rpm = running ? this.rpmCommand(throttle) : 0;
    const abc = running ? this.afterburnerCommand(throttle) : 0;
    this.ab = abc;
    this.abLit = abc > 0;
    this.abTimer = 0;
  }

  /** Steady thrust (N) for a throttle position at a flight condition. */
  steadyThrust(throttle, atm, M) {
    const lim = this.limits(atm, M, {});
    const c = this.cfg;
    const x = (this.rpmCommand(throttle) - c.rpmIdle) / (c.rpmMil - c.rpmIdle);
    const dry = lim.idle + (lim.mil - lim.idle) * Math.pow(clamp(x, 0, 1), c.thrustRpmExponent);
    return dry + this.afterburnerCommand(throttle) * (lim.max - lim.mil);
  }

  /**
   * Advance the engine by dt.  Returns the fuel burnt (kg).
   * @param throttle 0..1   @param atm atmosphere()   @param M Mach   @param qbar Pa   @param fuelKg fuel on board
   */
  update(dt, throttle, atm, M, qbar, fuelKg) {
    const c = this.cfg;
    if (fuelKg <= 0) this.running = false;
    const lim = this.limits(atm, M, this._lim || (this._lim = {}));

    if (this.running) {
      // ---- core spool: rate-limited first order; acceleration rate grows with N2
      const cmd = this.rpmCommand(throttle);
      const d = cmd - this.rpm;
      const above = Math.max(0, this.rpm - c.rpmIdle);
      const up = (c.spoolUp[0] + c.spoolUp[1] * above) * dt;
      const dn = (c.spoolDown[0] + c.spoolDown[1] * above) * dt;
      this.rpm += clamp(d * dt / c.spoolTau, -dn, up);
      // ---- afterburner: needs the core at MIL; light-off delay, then the zones fill
      const abc = this.afterburnerCommand(throttle);
      if (abc > 0 && this.rpm >= c.abMinRpm) {
        if (!this.abLit) {
          this.abTimer += dt;
          if (this.abTimer >= c.abLightDelay) { this.abLit = true; this.abTimer = 0; }
        }
      } else {
        this.abTimer = 0;
        if (this.ab <= 0.001) this.abLit = false;
      }
      const abTarget = this.abLit && abc > 0 && this.rpm >= c.abMinRpm ? abc : 0;
      if (abTarget > this.ab) this.ab = Math.min(abTarget, this.ab + c.abRateUp * dt);
      else this.ab = Math.max(abTarget, this.ab - c.abRateDown * dt);
      if (this.ab <= 0 && abTarget <= 0) this.abLit = false;

      const x = clamp((this.rpm - c.rpmIdle) / (c.rpmMil - c.rpmIdle), 0, 1);
      const dry = lim.idle + (lim.mil - lim.idle) * Math.pow(x, c.thrustRpmExponent);
      const abThrust = this.ab * Math.max(0, lim.max - lim.mil);
      this.thrust = dry + abThrust;
      // ---- fuel: constant TSFC per regime (calibrated to the brief: MIL ~0.8 kg/s, max AB ~3.5 kg/s at
      //      sea level static), rising with Mach; a floor at idle.
      const machF = 1 + c.tsfcMach * M;
      this.fuelFlow = Math.max(c.idleFuelFlow * Math.sqrt(atm.sigma),
        (c.tsfcDry * Math.max(0, dry) + c.tsfcAb * abThrust) * machF);
    } else {
      // flamed out: the spool winds down to a windmill speed, net ram drag
      const wind = clamp(c.windmillRpm * M, 0, 40);
      this.rpm += clamp((wind - this.rpm) * dt / 2.5, -6 * dt, 6 * dt);
      this.ab = 0;
      this.abLit = false;
      this.thrust = -c.windmillDragArea * qbar;
      this.fuelFlow = 0;
    }
    return Math.min(fuelKg, this.fuelFlow * dt);
  }
}
