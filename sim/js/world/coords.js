// World coordinates of the sim (see sim/DESIGN.md, "World frame and units").
//
// Projection: transverse Mercator on WGS84,
//   +proj=tmerc +lat_0=31.80 +lon_0=35.025 +k=1 +x_0=0 +y_0=0
// World frame (three.js, Y up): X = easting (east), Y = height above mean sea level,
// Z = -northing (north is -Z).
//
// The projection uses the Krueger n-series to order n^6 (Karney 2011, "Transverse Mercator
// with an accuracy of a few nanometers"), the same method PROJ uses for tmerc, so the
// results agree with pyproj to well below a millimetre over the whole far area.

export const ORIGIN = { lat: 31.80, lon: 35.025 };

/** Half size of the 102.4 km core square and of the 409.6 km far square, metres. */
export const CORE_HALF = 51200;
export const FAR_HALF = 204800;

const A_WGS84 = 6378137.0;
const F_WGS84 = 1 / 298.257223563;
const K0 = 1.0;

const E2 = F_WGS84 * (2 - F_WGS84);
const E = Math.sqrt(E2);
const N = F_WGS84 / (2 - F_WGS84);
const N2 = N * N, N3 = N2 * N, N4 = N3 * N, N5 = N4 * N, N6 = N5 * N;

// Rectifying radius.
const AR = A_WGS84 / (1 + N) * (1 + N2 / 4 + N4 / 64 + N6 / 256);

// Forward (conformal -> rectifying) coefficients alpha_1..6.
const ALPHA = [
  N / 2 - 2 * N2 / 3 + 5 * N3 / 16 + 41 * N4 / 180 - 127 * N5 / 288 + 7891 * N6 / 37800,
  13 * N2 / 48 - 3 * N3 / 5 + 557 * N4 / 1440 + 281 * N5 / 630 - 1983433 * N6 / 1935360,
  61 * N3 / 240 - 103 * N4 / 140 + 15061 * N5 / 26880 + 167603 * N6 / 181440,
  49561 * N4 / 161280 - 179 * N5 / 168 + 6601661 * N6 / 7257600,
  34729 * N5 / 80640 - 3418889 * N6 / 1995840,
  212378941 * N6 / 319334400,
];

// Inverse (rectifying -> conformal) coefficients beta_1..6.
const BETA = [
  N / 2 - 2 * N2 / 3 + 37 * N3 / 96 - N4 / 360 - 81 * N5 / 512 + 96199 * N6 / 604800,
  N2 / 48 + N3 / 15 - 437 * N4 / 1440 + 46 * N5 / 105 - 1118711 * N6 / 3870720,
  17 * N3 / 480 - 37 * N4 / 840 - 209 * N5 / 4480 + 5569 * N6 / 90720,
  4397 * N4 / 161280 - 11 * N5 / 504 - 830251 * N6 / 7257600,
  4583 * N5 / 161280 - 108847 * N6 / 3991680,
  20648693 * N6 / 638668800,
];

const DEG = Math.PI / 180;
const LAT0 = ORIGIN.lat * DEG;
const LON0 = ORIGIN.lon * DEG;

/** tan of the conformal latitude for tau = tan(phi) (Karney eq. 7-9). */
function tauPrime(tau) {
  const s = Math.hypot(1, tau);
  const sig = Math.sinh(E * Math.atanh(E * tau / s));
  return tau * Math.hypot(1, sig) - sig * s;
}

/** Inverse of tauPrime by Newton iteration (Karney eq. 19-21). */
function tauFromTauPrime(taup) {
  let tau = taup;
  for (let i = 0; i < 6; i++) {
    const tp = tauPrime(tau);
    const dtau = (taup - tp) * (1 + (1 - E2) * tau * tau) /
      ((1 - E2) * Math.hypot(1, tp) * Math.hypot(1, tau));
    tau += dtau;
    if (Math.abs(dtau) < 1e-14 * Math.max(1, Math.abs(tau))) break;
  }
  return tau;
}

/** Scaled (k0 * A) TM coordinates relative to the equator and the central meridian. */
function forwardRaw(lat, dlon) {
  const taup = tauPrime(Math.tan(lat));
  const xip = Math.atan2(taup, Math.cos(dlon));
  const etap = Math.asinh(Math.sin(dlon) / Math.hypot(taup, Math.cos(dlon)));
  let xi = xip, eta = etap;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1];
    xi += a * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
    eta += a * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
  }
  return { e: K0 * AR * eta, n: K0 * AR * xi };
}

// Northing of the projection origin (lat_0 on the central meridian).
const N_ORIGIN = forwardRaw(LAT0, 0).n;

/** Projected easting/northing in metres (false easting/northing 0). */
export function lonLatToEN(lon, lat) {
  const r = forwardRaw(lat * DEG, lon * DEG - LON0);
  return { e: r.e, n: r.n - N_ORIGIN };
}

/** Inverse of lonLatToEN. */
export function enToLonLat(e, n) {
  const xi = (n + N_ORIGIN) / (K0 * AR);
  const eta = e / (K0 * AR);
  let xip = xi, etap = eta;
  for (let j = 1; j <= 6; j++) {
    const b = BETA[j - 1];
    xip -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etap -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const taup = Math.sin(xip) / Math.hypot(Math.sinh(etap), Math.cos(xip));
  const tau = tauFromTauPrime(taup);
  return {
    lon: (LON0 + Math.atan2(Math.sinh(etap), Math.cos(xip))) / DEG,
    lat: Math.atan(tau) / DEG,
  };
}

/** Geographic (degrees) -> world {x, z}: x = easting, z = -northing. */
export function lonLatToXZ(lon, lat) {
  const p = lonLatToEN(lon, lat);
  return { x: p.e, z: -p.n };
}

/** World {x, z} -> geographic {lon, lat} in degrees. */
export function xzToLonLat(x, z) {
  return enToLonLat(x, -z);
}

/** Heading in degrees (0 = north = -Z, 90 = east = +X) of a world direction (dx, dz). */
export function headingDegFromXZ(dx, dz) {
  const h = Math.atan2(dx, -dz) / DEG;
  return (h + 360) % 360;
}

/** Unit world direction {x, z} for a heading in degrees. */
export function xzFromHeadingDeg(deg) {
  const a = deg * DEG;
  return { x: Math.sin(a), z: -Math.cos(a) };
}
