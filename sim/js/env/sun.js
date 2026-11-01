// Sun position for the sim area (31.8 N), pure JS.
//
// hoursLocal is local SOLAR time: 12.0 = the sun due south at its highest. With the default
// day 172 (21 June) the sun sets at about 19.0 (DESIGN.md); clock time in Israel (IDT, UTC+3)
// is about 0.7 h later in summer.

export const SITE_LAT_DEG = 31.8;

const DEG = Math.PI / 180;

/** Solar declination (rad) for a day of the year (1..365). */
export function declination(dayOfYear) {
  return -23.44 * DEG * Math.cos(2 * Math.PI / 365 * (dayOfYear + 10));
}

/**
 * Unit vector towards the sun in the world frame (X east, Y up, Z south = -north).
 * Returns {x, y, z, elevationDeg, azimuthDeg} (azimuth from north, clockwise).
 */
export function sunDirection(hoursLocal, dayOfYear = 172, latDeg = SITE_LAT_DEG) {
  const phi = latDeg * DEG;
  const dec = declination(dayOfYear);
  const H = (hoursLocal - 12) * 15 * DEG; // hour angle, + afternoon (sun in the west)
  const east = -Math.cos(dec) * Math.sin(H);
  const north = Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H);
  const up = Math.sin(dec) * Math.sin(phi) + Math.cos(dec) * Math.cos(phi) * Math.cos(H);
  const az = (Math.atan2(east, north) / DEG + 360) % 360;
  return { x: east, y: up, z: -north, elevationDeg: Math.asin(Math.max(-1, Math.min(1, up))) / DEG, azimuthDeg: az };
}

/** Local solar time of sunset (geometric centre of the disc on the horizon). */
export function sunsetHours(dayOfYear = 172, latDeg = SITE_LAT_DEG) {
  const c = -Math.tan(latDeg * DEG) * Math.tan(declination(dayOfYear));
  return 12 + Math.acos(Math.max(-1, Math.min(1, c))) / DEG / 15;
}
