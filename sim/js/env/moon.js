// Moon position and phase for the sim's date and time, pure JS (node tests run it too).
//
// The sim keeps local SOLAR time and a day of the year (js/env/sun.js); the moon needs an absolute
// date: env.year (default 2026) picks the year. The moon is placed relative to the sun, so the
// angle between the two (and with it the phase) is right even though sun.js uses a simple model:
// the moon's hour angle is the sun's hour angle plus the difference in right ascension.
//
// Ephemeris: the low-precision lunar formulae of the Astronomical Almanac (about 0.3 deg in
// longitude, 0.2 deg in latitude; geocentric, then corrected for parallax, ~1 deg near the
// horizon). Phase from the elongation. Accurate enough for a sky picture; not for navigation.

import { SITE_LAT_DEG } from './sun.js';

const DEG = Math.PI / 180;
/** Longitude of the sim area (deg east): local solar time -> UT. */
export const SITE_LON_DEG = 34.8;

const sinD = (d) => Math.sin(d * DEG);
const cosD = (d) => Math.cos(d * DEG);
const norm360 = (d) => ((d % 360) + 360) % 360;

/** Julian day of a UT instant given as year, day of the year (1 = 1 January) and hours. */
export function julianDay(year, dayOfYear, hoursUT) {
  // JD of 1 January 0h UT (Gregorian), then days and hours
  const y = year - 1, A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  const jan1 = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * 14) + 1 + B - 1524.5;
  return jan1 + (dayOfYear - 1) + hoursUT / 24;
}

/** Sun's ecliptic longitude (deg) and right ascension (deg), low precision. */
function sunEcliptic(jd) {
  const n = jd - 2451545.0;
  const L = norm360(280.460 + 0.9856474 * n);
  const g = norm360(357.528 + 0.9856003 * n);
  const lambda = L + 1.915 * sinD(g) + 0.020 * sinD(2 * g);
  const eps = 23.439 - 0.0000004 * n;
  const ra = Math.atan2(cosD(eps) * sinD(lambda), cosD(lambda)) / DEG;
  return { lambda: norm360(lambda), ra: norm360(ra), eps };
}

/** Moon's geocentric ecliptic longitude, latitude (deg) and horizontal parallax (deg). */
function moonEcliptic(jd) {
  const T = (jd - 2451545.0) / 36525;
  const lambda = 218.32 + 481267.881 * T
    + 6.29 * sinD(135.0 + 477198.87 * T) - 1.27 * sinD(259.3 - 413335.36 * T)
    + 0.66 * sinD(235.7 + 890534.22 * T) + 0.21 * sinD(269.9 + 954397.74 * T)
    - 0.19 * sinD(357.5 + 35999.05 * T) - 0.11 * sinD(186.5 + 966404.03 * T);
  const beta = 5.13 * sinD(93.3 + 483202.02 * T) + 0.28 * sinD(228.2 + 960400.89 * T)
    - 0.28 * sinD(318.3 + 6003.15 * T) - 0.17 * sinD(217.6 - 407332.21 * T);
  const parallax = 0.9508 + 0.0518 * cosD(135.0 + 477198.87 * T) + 0.0095 * cosD(259.3 - 413335.36 * T)
    + 0.0078 * cosD(235.7 + 890534.22 * T) + 0.0028 * cosD(269.9 + 954397.74 * T);
  return { lambda: norm360(lambda), beta, parallax };
}

/**
 * World -> equatorial rotation for the star field (the sky turns with the local sidereal time).
 * Rows A, B, P: equatorial = (A . d, B . d, P . d) for a world direction d (X east, Y up, Z south).
 */
export function celestialFrame(hoursLocal, dayOfYear = 172, year = 2026, latDeg = SITE_LAT_DEG) {
  const jd = julianDay(year, dayOfYear, hoursLocal - SITE_LON_DEG / 15);
  const sun = sunEcliptic(jd);
  // local sidereal time = hour angle + right ascension of the sun (consistent with sun.js)
  const theta = ((hoursLocal - 12) * 15 + sun.ra) * DEG;
  const phi = latDeg * DEG;
  const M = [0, Math.cos(phi), Math.sin(phi)];      // the equator on the meridian (due south)
  const W = [-1, 0, 0];                             // the equator in the west
  const P = [0, Math.sin(phi), -Math.cos(phi)];     // the celestial pole
  const c = Math.cos(theta), s = Math.sin(theta);
  const A = M.map((m, i) => c * m + s * W[i]);
  const B = M.map((m, i) => s * m - c * W[i]);
  return { A, B, P, lstDeg: ((theta / DEG) % 360 + 360) % 360 };
}

/**
 * The moon for local solar time hoursLocal on dayOfYear of year, seen from the sim area.
 * Returns {x, y, z} (unit vector, X east, Y up, Z south like sun.js), elevationDeg, azimuthDeg,
 * phaseAngleDeg (0 full .. 180 new), illumination (lit fraction of the disc, 0..1),
 * brightness (illuminance relative to a full moon at the same height, 0..1, with the
 * opposition surge), distanceKm.
 */
export function moonDirection(hoursLocal, dayOfYear = 172, year = 2026, latDeg = SITE_LAT_DEG) {
  const ut = hoursLocal - SITE_LON_DEG / 15;
  const jd = julianDay(year, dayOfYear, ut);
  const sun = sunEcliptic(jd);
  const m = moonEcliptic(jd);
  const eps = sun.eps;
  // equatorial
  const cb = cosD(m.beta), sb = sinD(m.beta), cl = cosD(m.lambda), sl = sinD(m.lambda);
  const xe = cb * cl, ye = cb * sl * cosD(eps) - sb * sinD(eps), ze = cb * sl * sinD(eps) + sb * cosD(eps);
  const ra = norm360(Math.atan2(ye, xe) / DEG);
  const dec = Math.asin(Math.max(-1, Math.min(1, ze)));
  // hour angle relative to the sim's sun (whose hour angle is (h - 12) * 15 deg)
  const H = ((hoursLocal - 12) * 15 + (sun.ra - ra)) * DEG;
  const phi = latDeg * DEG;
  let east = -Math.cos(dec) * Math.sin(H);
  let north = Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H);
  let up = Math.sin(dec) * Math.sin(phi) + Math.cos(dec) * Math.cos(phi) * Math.cos(H);
  // topocentric: the moon is ~60 earth radii away, so it sits lower by parallax x cos(altitude)
  const alt = Math.asin(Math.max(-1, Math.min(1, up)));
  const alt2 = alt - m.parallax * DEG * Math.cos(alt);
  const horiz = Math.hypot(east, north) || 1e-9;
  const k = Math.cos(alt2) / horiz;
  east *= k; north *= k; up = Math.sin(alt2);
  // phase: elongation from the sun, then the phase angle (sun - moon - earth)
  const cosPsi = cb * cosD(m.lambda - sun.lambda);
  const psi = Math.acos(Math.max(-1, Math.min(1, cosPsi)));
  const distKm = 6378.14 / Math.sin(m.parallax * DEG);
  const i = Math.atan2(149597870 * Math.sin(psi), distKm - 149597870 * Math.cos(psi));
  const illumination = (1 + Math.cos(i)) / 2;
  // brightness vs the full moon: the moon is not a Lambert sphere (rough, back-scattering),
  // a half moon gives ~10 % of the full moon's light (magnitude -12.7 + 0.026|i| + 4e-9 i^4)
  const iDeg = Math.abs(i / DEG);
  const brightness = Math.pow(10, -0.4 * (0.026 * iDeg + 4e-9 * Math.pow(iDeg, 4)));
  return {
    x: east, y: up, z: -north,
    elevationDeg: alt2 / DEG, azimuthDeg: norm360(Math.atan2(east, north) / DEG),
    phaseAngleDeg: iDeg, illumination, brightness, distanceKm: distKm,
    waxing: norm360(m.lambda - sun.lambda) < 180,
  };
}
