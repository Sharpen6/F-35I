// International Standard Atmosphere (ISA 1976) and air-data helpers.
//
// Heights are geometric metres above mean sea level (the world Y of the sim); the layers are
// defined on geopotential height, so we convert first.  Valid from below the Dead Sea (-435 m)
// up to 47 km, far beyond what the F-35 can reach.

export const G0 = 9.80665;          // m/s^2, standard gravity (also used as the sim's gravity)
export const R_AIR = 287.05287;     // J/(kg K)
export const GAMMA = 1.4;
export const T0 = 288.15;           // K
export const P0 = 101325;           // Pa
export const RHO0 = 1.225;          // kg/m^3
export const A0 = Math.sqrt(GAMMA * R_AIR * T0);   // 340.294 m/s
export const KT = 0.514444;         // m/s per knot
export const FT = 0.3048;           // m per foot

const R_EARTH_GEOPOT = 6356766;     // m, the radius ISA uses for geopotential height

/**
 * Atmosphere at geometric height h (m MSL).
 * Fills and returns `out` = {T (K), p (Pa), rho (kg/m^3), a (m/s), sigma (rho/rho0), delta (p/p0), theta (T/T0)}.
 */
export function atmosphere(h, out = {}) {
  const H = (R_EARTH_GEOPOT * h) / (R_EARTH_GEOPOT + h);
  let T, p;
  if (H < 11000) {                       // troposphere, -6.5 K/km
    T = T0 - 0.0065 * H;
    p = P0 * Math.pow(T / T0, 5.255877);
  } else if (H < 20000) {                // tropopause, isothermal
    T = 216.65;
    p = 22632.06 * Math.exp(-1.5768852e-4 * (H - 11000));
  } else if (H < 32000) {                // stratosphere 1, +1 K/km
    T = 216.65 + 0.001 * (H - 20000);
    p = 5474.889 * Math.pow(216.65 / T, 34.163218);
  } else {                               // stratosphere 2, +2.8 K/km
    T = 228.65 + 0.0028 * (Math.min(H, 47000) - 32000);
    p = 868.0187 * Math.pow(228.65 / T, 12.201149);
  }
  const rho = p / (R_AIR * T);
  out.T = T;
  out.p = p;
  out.rho = rho;
  out.a = Math.sqrt(GAMMA * R_AIR * T);
  out.sigma = rho / RHO0;
  out.delta = p / P0;
  out.theta = T / T0;
  return out;
}

/** Pitot impact pressure qc = pt - p for flight Mach number M at static pressure p
 *  (isentropic below M 1, Rayleigh pitot formula behind the normal shock above). */
export function impactPressure(M, p) {
  if (M <= 1) return p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  return p * (166.9215801 * Math.pow(M, 7) / Math.pow(7 * M * M - 1, 2.5) - 1);
}

/** Calibrated airspeed (m/s) from impact pressure, i.e. what the airspeed indicator shows (sea-level
 *  standard calibration).  Above a0 (661.5 kt) the supersonic pitot relation is inverted numerically. */
export function casFromImpactPressure(qc) {
  const r = qc / P0 + 1;
  const sub = A0 * Math.sqrt(5 * (Math.pow(r, 2 / 7) - 1));
  if (sub <= A0) return sub;
  // supersonic: r = 166.92 m^7 / (7 m^2 - 1)^2.5 with m = CAS/a0; fixed-point iteration converges fast
  let m = sub / A0;
  for (let i = 0; i < 20; i++) {
    m = 0.881284 * Math.sqrt(r * Math.pow(1 - 1 / (7 * m * m), 2.5));
  }
  return m * A0;
}

/** CAS (m/s) for true airspeed V (m/s) at height h. */
export function casFromTas(V, h, atm = atmosphere(h)) {
  return casFromImpactPressure(impactPressure(V / atm.a, atm.p));
}

/** True airspeed (m/s) that gives calibrated airspeed cas (m/s) at height h (bisection). */
export function tasFromCas(cas, h) {
  const atm = atmosphere(h);
  let lo = 0, hi = 2000;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (casFromTas(mid, h, atm) < cas) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}
