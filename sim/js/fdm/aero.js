// Aerodynamic coefficient model: table lookups in angle of attack and Mach number.
//
// Conventions (classic flight-mechanics "aero body axes", used inside the FDM only):
//   x forward, y right, z down; p roll (right wing down +), q pitch (nose up +), r yaw (nose right +).
//   alpha = atan2(w, u), beta = asin(v / V).
// Control inputs are normalised surface commands in -1..1:
//   de > 0 nose-up stabilator, da > 0 roll right, dr > 0 yaw right (rudders), as the Blender rig names
//   them (stick_pitch, stick_roll, pedals).
// The moments are linear in the controls, so evaluate() also returns the control-free part and the
// control effectiveness, which the fly-by-wire computer (fcs.js) inverts (nonlinear dynamic inversion,
// as the real F-35 control laws do).

import { lerpTable, table, clamp, smoothstep, R2D } from './tables.js';

export class Aero {
  constructor(cfg) {
    this.cfg = cfg;   // config.aero
  }

  /**
   * @param fc flight condition: {alpha, beta (rad), mach, V (m/s TAS), p, q, r (rad/s),
   *            flaps, gear, speedbrake, canopy (0..1), hWing (m, wing above ground; Infinity if high)}
   * @param u  controls {de, da, dr} (-1..1)
   * @param out filled with CL, CD, CY (wind/stability axes), Cl, Cm, Cn (body axes, about the CG) plus
   *            the control-free parts Cl0, Cm0, Cn0 and effectiveness Cm_de, Cl_da, Cl_dr, Cn_da, Cn_dr.
   */
  evaluate(fc, u, out) {
    const A = this.cfg;
    const M = fc.mach;
    // Reverse flow (tail slides): mirror the angle into -90..90 deg and flip the lift.
    let alpha = fc.alpha;
    let rev = 1;
    if (alpha > Math.PI / 2) { alpha = Math.PI - alpha; rev = -1; }
    else if (alpha < -Math.PI / 2) { alpha = -Math.PI - alpha; rev = -1; }
    const ad = alpha * R2D;
    const aabs = Math.abs(ad);
    const sb = Math.sin(clamp(fc.beta, -1.2, 1.2));       // saturating sideslip for the lateral terms
    const V = Math.max(fc.V, 1);

    // ---------------------------------------------------------------- lift
    // Low-speed clean lift curve split into its linear part (|alpha| <= linearTo) and the vortex /
    // post-stall remainder; Mach scales the two parts separately (lift-slope rise to M 1, fall after,
    // and the loss of high-alpha lift at high subsonic Mach).
    const clAll = lerpTable(A.CL.alpha, A.CL.cl, ad);
    const adLin = clamp(ad, -A.CL.linearTo, A.CL.linearTo);
    const clLin = lerpTable(A.CL.alpha, A.CL.cl, adLin);
    let CL = clLin * table(A.CL.machLinear, M) + (clAll - clLin) * table(A.CL.machHigh, M);
    const flapFade = 1 - smoothstep(A.flaps.fadeAlpha[0], A.flaps.fadeAlpha[1], aabs);
    CL += A.flaps.dCL * fc.flaps * flapFade;

    // Ground effect (McCormick): induced drag factor phi, small lift gain near the ground.
    let kInduced = 1;
    if (fc.hWing < 4 * A.b) {
      const x = 16 * Math.max(fc.hWing, 0.2) / A.b;
      const phi = (x * x) / (1 + x * x);
      kInduced = phi;
      CL *= 1 + A.groundEffect.dCL * (1 - phi);
    }
    CL *= rev;

    // ---------------------------------------------------------------- drag
    const cd0 = table(A.CD0, M) + A.gear.dCD * fc.gear + A.flaps.dCD * fc.flaps
      + A.speedbrake.dCD * fc.speedbrake + A.canopy.dCD * fc.canopy;
    const K = table(A.K, M) * (1 + A.kHighCL * Math.max(0, Math.abs(CL) - A.kHighCLFrom)) * kInduced;
    const sa = Math.sin(alpha);
    const cdPolar = cd0 + K * CL * CL;
    const cdFlat = cd0 + A.CDflat * sa * sa;          // separated flow at very high alpha
    const CD = Math.max(cdPolar, cdFlat) + A.CDbeta * sb * sb;   // continuous; no bias at small alpha

    // ---------------------------------------------------------------- side force
    const CY = A.CYbeta * sb + A.CYdr * u.dr;

    // ---------------------------------------------------------------- pitch
    // Static stability from the normal force acting staticMargin * cbar behind the CG (negative = the
    // relaxed-stability airframe is slightly unstable subsonic), a nose-down break at high alpha,
    // damping, configuration increments.  Stabilator effectiveness falls supersonic and at high alpha.
    const ca = Math.cos(alpha);
    const CN = CL * rev * ca + CD * sa;                // body normal-force coefficient
    const SM = table(A.staticMargin, M);
    const cmHigh = -A.CmHighAlpha * smoothstep(A.CmHighAlphaFrom[0], A.CmHighAlphaFrom[1], aabs) * Math.sign(ad);
    const qhat = fc.q * A.cbar / (2 * V);
    const Cm0 = A.Cm0 - SM * CN + cmHigh + A.Cmq * qhat
      + A.flaps.dCm * fc.flaps + A.gear.dCm * fc.gear + A.speedbrake.dCm * fc.speedbrake;
    const Cm_de = A.Cm_de * table(A.Cm_deMach, M) * table(A.Cm_deAlpha, aabs);

    // ---------------------------------------------------------------- roll
    const phat = fc.p * A.b / (2 * V);
    const rhat = fc.r * A.b / (2 * V);
    const clr = A.Clr0 + A.ClrCL * clamp(CL, -1.5, 1.5);
    const Cl0 = table(A.Clbeta, aabs) * sb + table(A.Clp, aabs) * phat + clr * rhat;
    const Cl_da = table(A.Cl_da, aabs) * table(A.Cl_daMach, M);
    const Cl_dr = A.Cl_dr;

    // ---------------------------------------------------------------- yaw
    const dirMach = table(A.directionalMach, M);
    const Cn0 = table(A.Cnbeta, aabs) * dirMach * sb + A.Cnp * phat + table(A.Cnr, aabs) * rhat;
    const Cn_dr = table(A.Cn_dr, aabs) * dirMach;
    const Cn_da = A.Cn_da;

    out.CL = CL;
    out.CD = CD;
    out.CY = CY;
    out.Cm0 = Cm0;
    out.Cm_de = Cm_de;
    out.Cl0 = Cl0;
    out.Cl_da = Cl_da;
    out.Cl_dr = Cl_dr;
    out.Cn0 = Cn0;
    out.Cn_da = Cn_da;
    out.Cn_dr = Cn_dr;
    out.Cm = Cm0 + Cm_de * u.de;
    out.Cl = Cl0 + Cl_da * u.da + Cl_dr * u.dr;
    out.Cn = Cn0 + Cn_da * u.da + Cn_dr * u.dr;
    return out;
  }
}

/** Ground-effect-free, control-free lift coefficient at (alpha, mach) for trim estimates. */
export function liftCoefficient(aeroCfg, alpha, mach, flaps = 0) {
  const ad = alpha * R2D;
  const clAll = lerpTable(aeroCfg.CL.alpha, aeroCfg.CL.cl, ad);
  const adLin = clamp(ad, -aeroCfg.CL.linearTo, aeroCfg.CL.linearTo);
  const clLin = lerpTable(aeroCfg.CL.alpha, aeroCfg.CL.cl, adLin);
  const fade = 1 - smoothstep(aeroCfg.flaps.fadeAlpha[0], aeroCfg.flaps.fadeAlpha[1], Math.abs(ad));
  return clLin * table(aeroCfg.CL.machLinear, mach) + (clAll - clLin) * table(aeroCfg.CL.machHigh, mach)
    + aeroCfg.flaps.dCL * flaps * fade;
}
