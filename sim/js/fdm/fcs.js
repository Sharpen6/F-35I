// Fly-by-wire flight control system, F-35-like "carefree" handling.
//
// Structure (as on the real jet, whose control laws are built on nonlinear dynamic inversion):
//   outer loops turn stick inputs into commanded body rates,
//   inner loops invert the aircraft model: desired angular accelerations -> required moments ->
//   surface commands, using the same aero tables the physics uses (Aero.evaluate gives the
//   control-free moments and the control effectiveness at the current flight condition).
//
// Pitch (air):  C* law  C* = (nz - nz_gravity) + (Vco/g) q.  The stick commands C*; at high speed
//               that is load factor, at low speed pitch rate.  Hands-off the jet holds the flight
//               path angle (auto-trim, 1 g compensated for bank).  g limiter +9/-3, AoA limiter
//               25 deg (50 deg in the optional high-AoA mode), pitch-rate limit, tail-strike protection.
// Roll/yaw at high AoA: the roll command is capped to what the rudders can coordinate (sideslip
//               held within ~6 deg); a saturated rudder hands its share back to the ailerons.
// Roll (air):   stick commands stability-axis roll rate, up to ~200 deg/s, less at low dynamic
//               pressure, high AoA and supersonic.  Hands-off: bank-angle hold (wings level if < 5 deg).
// Yaw (air):    sideslip controller: turn coordination (zero sideslip), pedals command sideslip.
// Ground:       pitch stick commands a pitch attitude (60 % aft stick or more = the 12 deg take-off
//               attitude, proportional below, rotation rate limited); roll and yaw are direct; pedals
//               also steer the nose wheel (gear.js).
// Takeoff:      after lift-off the attitude mode is kept while the stick stays pulled, then the air
//               laws take over.  The stick still held at that moment is "ratcheted": the C* law
//               only sees stick beyond what was held (and the reference follows the stick down as it
//               is released), so the jet keeps its climb path instead of pulling to the AoA limit.

import { clamp, wrapPi, smoothstep, D2R } from './tables.js';
import { G0 } from './atmosphere.js';

export class FlightControlSystem {
  constructor(cfg) {
    this.cfg = cfg;   // config.fcs
    this.reset();
  }

  reset(opts = {}) {
    this.mode = opts.mode || 'ground';
    this.gammaHold = opts.gammaRef != null;
    this.gammaRef = opts.gammaRef || 0;
    this.gammaInt = 0;
    this.bankHold = opts.bankRef != null;
    this.bankRef = opts.bankRef || 0;
    this.groundInt = 0;          // pitch integrator used on the ground (overcomes the main-gear moment)
    this.timeAirborne = 0;
    this.spRef = 0;              // pitch stick ratchet (shaped units) after the ground / take-off laws
    this.out = { de: opts.de || 0, da: 0, dr: 0 };
    this.debug = { qCmd: 0, CsCmd: 0, nzCmd: 1, pCmd: 0, rCmd: 0, limiter: '' };
  }

  static shape(x, k) {
    return (1 - k) * x + k * x * x * x;
  }

  /**
   * One FCS frame.
   * @param h    time step (s)
   * @param inp  pilot input {pitch, roll, yaw, highAoA}
   * @param s    sensors: {V, qbar, mach, alpha, beta, p, q, r, theta, phi, gamma, nz, Qalpha, ay,
   *             wowMain, wowNose, gearDown (0..1 position), aglMains, groundSpeed, cas}
   * @param a    aero output for the current condition (Cm0, Cm_de, Cl0, Cl_da, Cl_dr, Cn0, Cn_da, Cn_dr)
   * @param mp   mass properties {mass, Ixx, Iyy, Izz, Ixz}
   * @param geo  {S, b, cbar}
   * @returns {de, da, dr} surface commands (-1..1)
   */
  update(h, inp, s, a, mp, geo) {
    const c = this.cfg;
    const dbg = this.debug;
    const rawPitch = clamp(inp.pitch || 0, -1, 1);
    const sp = FlightControlSystem.shape(rawPitch, c.stickShapePitch);
    const sr = FlightControlSystem.shape(clamp(inp.roll || 0, -1, 1), c.stickShapeRoll);
    const sy = clamp(inp.yaw || 0, -1, 1);
    const V = Math.max(s.V, 30);
    const qbarEff = Math.max(s.qbar, c.minQbar);
    const onGround = s.wowMain || s.wowNose;

    // ------------------------------------------------------------------ mode logic
    const prevMode = this.mode;
    if (onGround) {
      this.mode = 'ground';
      this.timeAirborne = 0;
    } else {
      this.timeAirborne += h;
      if (this.mode === 'ground') this.mode = sp > c.freeStick ? 'takeoff' : 'air';
      if (this.mode === 'takeoff' && (sp <= c.freeStick || this.timeAirborne > c.takeoffModeTime
        || s.gearDown < 0.99 || s.cas > c.takeoffModeMaxCas)) this.mode = 'air';
    }
    if (this.mode !== 'air') {           // re-arm the holds for the moment the air laws engage
      this.gammaHold = false;
      this.bankHold = false;
      this.spRef = 0;
    } else if (prevMode !== 'air') {
      // Ground / take-off attitude law -> C*: a pull still held means "keep this attitude", not
      // "pull to the AoA limit" (which is what the same stick asks of the C* law).  Ratchet it.
      this.spRef = Math.max(0, sp);
    }
    // pitch stick seen by the air law: beyond the ratchet; the ratchet follows the stick down
    this.spRef = Math.min(this.spRef, Math.max(0, sp));
    const spA = sp - this.spRef;

    let qCmd;
    let de;
    const Iyy = mp.Iyy, Ixx = mp.Ixx, Izz = mp.Izz, Ixz = mp.Ixz;
    const p = s.p, q = s.q, r = s.r;
    // gear pitching moment (main wheels only, i.e. once the nose wheel is off) is a known disturbance
    // during rotation and lift-off: the inversion compensates it
    const gearM = onGround && !s.wowNose ? s.gearPitchMoment : 0;
    // The stabilators move at a finite rate, so the pitch acceleration can only change so fast (jerk
    // J).  Large rate errors are closed along sqrt(2 J e) instead of e / tauQ: the surface starts
    // to come back early enough that the pitch rate does not overshoot at low dynamic pressure.
    const qSc = qbarEff * geo.S * geo.cbar;
    const jerk = (c.pitchJerkShare ?? 0.3) * Math.abs(a.Cm_de) * qSc * (geo.deRate || 3) / Iyy;
    const ndiPitch = (qc, Mext = 0) => {
      const e = qc - q;
      let qdot = e / c.tauQ;
      const qdMax = Math.sqrt(2 * jerk * Math.abs(e));
      if (Math.abs(qdot) > qdMax) qdot = Math.sign(e) * qdMax;
      const M = Iyy * qdot + (Ixx - Izz) * p * r + Ixz * (p * p - r * r) - Mext;
      return (M / qSc - a.Cm0) / a.Cm_de;
    };

    if (this.mode === 'ground' || this.mode === 'takeoff') {
      // ---------------------------------------------------------------- pitch attitude command
      // From the raw stick, linear up to rotateStick (the cubic shaping is for fine control in the
      // air; here it left a half pull at ~4 deg, which only flies off at ~260 kt).
      const thG = c.groundPitch;
      const rot = clamp(rawPitch / (c.rotateStick || 1), 0, 1);
      const thCmd = thG + rot * (c.takeoffPitch - thG);
      qCmd = clamp(c.kTheta * (thCmd - s.theta), -c.derotationRate, c.rotationRate);
      qCmd = this._limitAlphaG(qCmd, s, V, c.alphaMax, a, mp, geo, qbarEff);
      const ndi = ndiPitch(qCmd, gearM) + this.groundInt;
      const sat = Math.abs(ndi) >= 1;
      if (this.mode === 'ground' && !sat) this.groundInt = clamp(this.groundInt + c.kiGround * (qCmd - q) * h, -0.8, 0.8);
      if (this.mode === 'takeoff' || (s.wowNose && sp <= c.freeStick)) this.groundInt *= Math.exp(-h / 0.5);
      // Taxi speeds: the stick drives the stabilators directly (control check); the attitude law fades in.
      const w = this.mode === 'ground' ? smoothstep(c.groundLawSpeed[0], c.groundLawSpeed[1], s.V) : 1;
      de = (1 - w) * sp + w * ndi;
      if (sp < -c.freeStick && this.mode === 'ground') de = Math.min(de, sp);   // push: nose wheel down
      dbg.limiter = '';
    } else {
      // ---------------------------------------------------------------- C* pitch law (air)
      this.groundInt = 0;
      const nGz = Math.cos(s.theta) * Math.cos(s.phi);
      const free = Math.abs(spA) < c.freeStick;
      const pa = s.gearDown > 0.5;                       // power-approach (landing) gains
      let gdot = 0;
      if (free) {
        if (!this.gammaHold) {
          this.gammaHold = true;
          this.gammaRef = s.gamma;
          this.gammaInt = 0;
        }
        if (Math.abs(s.gamma) < c.gammaHoldMax && Math.abs(this.gammaRef) < c.gammaHoldMax) {
          const e = this.gammaRef - s.gamma;
          this.gammaInt = clamp(this.gammaInt + e * h, -c.gammaIntMax, c.gammaIntMax);
          gdot = clamp(c.kGamma * e + c.kiGamma * this.gammaInt, -c.gammaRateMax, c.gammaRateMax);
        } else {
          this.gammaRef = s.gamma;      // too steep to hold: follow, re-capture when back in range
          this.gammaInt = 0;
        }
      } else {
        this.gammaHold = false;
      }
      // Turn compensation (1/cos(phi)) with a lead on the bank rate: the load factor follows a C*
      // command with a ~0.4 s lag (path time constant), so rolling into a turn would otherwise lose
      // height.  Both fade out in fast rolls, which the pitch loop should not chase (an aileron roll
      // is flown at ~1 g, like a conventional jet).
      const phiDot = s.p + (s.q * Math.sin(s.phi) + s.r * Math.cos(s.phi)) * Math.tan(clamp(s.theta, -1.4, 1.4));
      const wRoll = 1 - smoothstep(c.bankCompRate[0], c.bankCompRate[1], Math.abs(phiDot));
      const lead = clamp(c.bankCompLead * bankCompSlope(s.phi, c.bankCompKnee) * phiDot,
        -c.bankCompLeadMax, c.bankCompLeadMax);
      const comp = 1 + (bankComp(s.phi, c.bankCompKnee) + lead - 1) * wRoll;
      // Hands-off load factor: nFree is perpendicular to the flight path (wind axes); C* works in
      // body axes.  Steady flight needs body nz = cos(gamma + alpha) = nGz, i.e. nFree cos(a) minus the
      // along-path specific force (thrust - drag, measured) times sin(a).  Without that term the
      // reference carried a bias of cos(gamma) - cos(theta): 0.014 g at a 13 deg AoA approach, enough
      // to flatten the path and bleed speed on the back side of the drag curve (a hands-off final
      // used to slow down and sink short of the runway).
      const ca0 = Math.cos(s.alpha), sa0 = Math.sin(s.alpha);
      const nxW = (s.nx ?? Math.sin(s.gamma)) * ca0 - s.nz * sa0;
      const nFree = (Math.cos(s.gamma) * comp + (V / G0) * gdot * Math.cos(s.phi)) * ca0 - nxW * sa0;
      const dnFree = nFree - nGz;
      const Vco = c.Vco;
      const up = pa ? c.cstarUpPA : c.cstarUp;
      const dn = pa ? c.cstarDownPA : c.cstarDown;
      const Cs = dnFree * (V + Vco) / V + (spA > 0 ? spA * up : spA * dn);
      const CsMeas = (s.nz - nGz) + (Vco / G0) * q;
      qCmd = (G0 * Cs) / (V + Vco) + c.kCstar * (Cs - CsMeas);
      dbg.CsCmd = Cs;
      dbg.nzCmd = nGz + Cs * V / (V + Vco);
      const aMax = inp.highAoA ? c.alphaMaxHigh : c.alphaMax;
      qCmd = this._limitAlphaG(qCmd, s, V, aMax, a, mp, geo, qbarEff);
      // tail-strike protection close to the ground with the gear down
      if (s.gearDown > 0.5 && s.aglMains < c.tailStrikeAgl) {
        qCmd = Math.min(qCmd, c.kTheta * (c.tailStrikePitch - s.theta));
      }
      de = ndiPitch(qCmd);
    }
    dbg.qCmd = qCmd;

    // ------------------------------------------------------------------ lateral / directional
    let da, dr;
    if (this.mode === 'ground') {
      // direct: half aileron authority, full rudder; the nose wheel steers from the pedals (gear.js)
      da = c.groundRollGain * sr;
      dr = sy;
      dbg.pCmd = 0;
      dbg.rCmd = 0;
    } else {
      const alpha = clamp(s.alpha, -1.2, 1.2);
      const ca = Math.cos(alpha), sa = Math.sin(alpha);
      // roll-rate authority schedule
      const fq = clamp(c.rollQbar[0] + (1 - c.rollQbar[0]) * (s.qbar - c.rollQbar[1]) / (c.rollQbar[2] - c.rollQbar[1]),
        c.rollQbar[0], 1);
      const aabs = Math.abs(alpha);
      const fa = aabs < c.rollAlpha[0] ? 1 : Math.max(c.rollAlpha[2], 1 - (1 - c.rollAlpha[2]) * (aabs - c.rollAlpha[0]) / (c.rollAlpha[1] - c.rollAlpha[0]));
      const fm = s.mach < c.rollMach[0] ? 1 : Math.max(c.rollMach[2], 1 - (1 - c.rollMach[2]) * (s.mach - c.rollMach[0]) / (c.rollMach[1] - c.rollMach[0]));
      const pMax = c.rollRateMax * fq * fa * fm;
      let pS;
      if (Math.abs(sr) >= c.freeStick || this.mode === 'takeoff') {
        pS = sr * pMax;
        this.bankHold = false;
      } else {
        if (!this.bankHold) {
          this.bankHold = true;
          this.bankRef = Math.abs(s.phi) < c.bankSnap ? 0 : s.phi;
        }
        if (Math.abs(s.theta) < c.bankHoldMaxPitch) {
          pS = clamp(c.kPhi * wrapPi(this.bankRef - s.phi), -c.bankHoldRate, c.bankHoldRate);
        } else {
          pS = 0;
          this.bankRef = s.phi;
        }
      }
      // High-AoA coordination: the sideslip grows as beta_dot = p sin(a) - r cos(a) + ay / V, and a
      // stability-axis roll (p = pS cos a) needs the yaw rate to keep up.  Where the rudders cannot
      // build it quickly (slow flight, 20-30 deg AoA, where gravity adds g sin(phi) / V as the bank
      // grows) cap the command to what the yaw axis already does plus a bounded sideslip build-up;
      // no effect at normal AoA, where sin(a) is small.
      if (sa > 0.1 && pS !== 0) {
        const sg = Math.sign(pS);
        const room = Math.max(0, c.rollBetaMax - sg * s.beta);
        const cap = Math.max(c.rollCoordMin, (sg * (r * ca - s.ay / V) + c.rollBetaGain * room) / (ca * sa));
        if (Math.abs(pS) > cap) pS = sg * cap;
      }
      const pCmd = pS * ca;
      // sideslip loop: zero sideslip (coordination) unless the pedals ask for some
      const betaMax = clamp(c.betaMax * c.betaQbarRef / Math.max(s.qbar, 1), c.betaMin, c.betaMax);
      const betaCmd = -sy * betaMax;
      const rCmd = (pCmd * sa + s.ay / V + c.kBeta * (s.beta - betaCmd)) / Math.max(ca, 0.3);
      const pdot = (pCmd - p) / c.tauP;
      const rdot = (rCmd - r) / c.tauR;
      const L = Ixx * pdot - Ixz * rdot + (Izz - Iyy) * q * r - Ixz * p * q;
      const N = Izz * rdot - Ixz * pdot + (Iyy - Ixx) * p * q + Ixz * q * r;
      const qsb = qbarEff * geo.S * geo.b;
      const cl = L / qsb - a.Cl0;
      const cn = N / qsb - a.Cn0;
      const det = a.Cl_da * a.Cn_dr - a.Cl_dr * a.Cn_da;
      da = (cl * a.Cn_dr - a.Cl_dr * cn) / det;
      dr = (a.Cl_da * cn - a.Cn_da * cl) / det;
      // Saturation: the joint solution expects the rudders' rolling moment (and the ailerons' yaw)
      // of the unclipped deflections.  When one surface runs out of travel, solve the other axis
      // again for the deflection the saturated one really has (slow flight at high AoA: the yaw
      // demand of a coordinated roll saturates the rudders, and the ailerons used to wind down to
      // nothing instead of rolling the jet).
      if (Math.abs(dr) > 1) {
        dr = Math.sign(dr);
        da = (cl - a.Cl_dr * dr) / a.Cl_da;
      } else if (Math.abs(da) > 1) {
        da = Math.sign(da);
        dr = (cn - a.Cn_da * da) / a.Cn_dr;
      }
      dbg.pCmd = pCmd;
      dbg.rCmd = rCmd;
    }

    const o = this.out;
    o.de = clamp(de, -1, 1);
    o.da = clamp(da, -1, 1);
    o.dr = clamp(dr, -1, 1);
    return o;
  }

  /** Clamp a pitch-rate command so that load factor stays in [nMin, nMax] and AoA in [alphaMin, aMax].
   *  Both limiters predict the steady pitch rate from the current forces (Qalpha = alpha_dot - q)
   *  and add a first-order correction; the AoA protection has the last word. */
  _limitAlphaG(qCmd, s, V, aMax, a, mp, geo, qbarEff) {
    const c = this.cfg;
    const nGz = Math.cos(s.theta) * Math.cos(s.phi);
    // g limiter, gain scheduled with the load factor per radian of AoA (Nalpha) for a constant time constant
    const kn = clamp(1 / (Math.max(s.nAlpha, 0.5) * c.tauN), c.kNmin, c.kNmax);
    const qnHi = (G0 / V) * (c.nMax - nGz) + kn * (c.nMax - s.nz);
    const qnLo = (G0 / V) * (c.nMin - nGz) + kn * (c.nMin - s.nz);
    let lim = '';
    if (qCmd > qnHi) { qCmd = qnHi; lim = 'g'; }
    if (qCmd < qnLo) { qCmd = qnLo; lim = 'g'; }
    // AoA limiter: alpha_dot = q + Qalpha.  Approach the limit along the smaller of a first-order
    // path and a braking curve sqrt(2 a e), a = part of the pitch acceleration the stabilators can
    // still produce, so the pitch rate is shed in time (no overshoot after a fast pull at low speed).
    const qSc = qbarEff * geo.S * geo.cbar / mp.Iyy;
    const aDn = Math.max(0.05, (a.Cm_de - a.Cm0) * qSc) * c.alphaBrakeShare;   // nose-down authority, rad/s^2
    const aUp = Math.max(0.05, (a.Cm_de + a.Cm0) * qSc) * c.alphaBrakeShare;
    const lead = c.tauQ * (s.q + s.Qalpha);                // where alpha will be one inner-loop lag later
    const eHi = aMax - s.alpha - lead;
    const eLo = c.alphaMin - s.alpha - lead;
    const qaHi = -s.Qalpha + (eHi > 0 ? Math.min(c.kAlpha * eHi, Math.sqrt(2 * aDn * eHi)) : c.kAlpha * eHi);
    const qaLo = -s.Qalpha + (eLo < 0 ? Math.max(c.kAlpha * eLo, -Math.sqrt(-2 * aUp * eLo)) : c.kAlpha * eLo);
    if (qCmd > qaHi) { qCmd = qaHi; lim = 'aoa'; }
    if (qCmd < qaLo) { qCmd = qaLo; lim = 'aoa'; }
    if (qCmd > c.pitchRateMax) { qCmd = c.pitchRateMax; lim = lim || 'q'; }
    if (qCmd < -c.pitchRateMax) { qCmd = -c.pitchRateMax; lim = lim || 'q'; }
    this.debug.limiter = lim;
    return qCmd;
  }
}

/** Bank compensation for the hands-off load factor: 1/cos(phi) up to the knee (level turn; 70 deg =
 *  2.9 g), easing linearly to zero at knife edge, cos(phi) beyond (-1 g inverted holds an inverted
 *  flight path).  Continuous everywhere. */
export function bankComp(phi, knee = 70 * D2R) {
  const a = Math.abs(wrapPi(phi));
  if (a <= knee) return 1 / Math.cos(a);
  if (a <= Math.PI / 2) return (Math.PI / 2 - a) / ((Math.PI / 2 - knee) * Math.cos(knee));
  return Math.cos(a);
}

/** d bankComp / d phi (signed). */
export function bankCompSlope(phi, knee = 70 * D2R) {
  const w = wrapPi(phi);
  const a = Math.abs(w);
  const sg = w < 0 ? -1 : 1;
  if (a <= knee) return sg * Math.sin(a) / (Math.cos(a) * Math.cos(a));
  if (a <= Math.PI / 2) return -sg / ((Math.PI / 2 - knee) * Math.cos(knee));
  return -sg * Math.sin(a);
}
