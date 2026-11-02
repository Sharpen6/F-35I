// The cities' light in the night sky and under the clouds (light pollution), for central Israel
// and its neighbours.
//
//   const g = new SkyGlow();
//   g.update(camX, camY, camZ, cloudBaseM);   // when the camera has moved (Environment._updateNightSky)
//   g.src, g.city, g.zenithArt                // the uniforms below (LP_GLSL)
//
// In central Israel the night sky is lit far more by the cities than by the stars and the
// airglow: the light atlas of Falchi et al. (2016, Science Advances) has most of Gush Dan at tens
// of times the natural sky (the Milky Way is hidden for 98 % of Israelis), the Judean desert and
// the Dead Sea near natural, with the glows of Jerusalem, Arad and the Dead Sea works, and Amman
// on the horizons (the Israeli Astronomical Association's dark-sky surveys say the same). Here:
//
//   * natural units (n.u.): 1 = the natural sky at the zenith, 22.0 mag / arcsec^2 = 174 ucd/m^2;
//     near the horizon the airglow (van Rhijn) and the scattered starlight make it ~2.5x that
//   * each city (CITIES: a light output P, ~ million people under Israeli street lighting, and a
//     radius) adds at the zenith Z = K P (D^2 + R^2)^-1.25 (Walker's law, D km away; inside the
//     city it levels off), and a dome towards it: Z A lobe(azimuth) exp(-tan(elev) D / H), A
//     growing with the distance (a far city is all horizon glow, a near one fills the sky), the
//     lobe as wide as the city seen from there plus the haze's spread, H ~ the height of the
//     scattering haze. Calibrated to the atlas: ~50 n.u. over central Tel Aviv, ~11 at Ben Gurion,
//     ~2 at the north of the Dead Sea, ~2 30 km out at sea. Above the camera it fades with height
//   * under a cloud deck the cities' light is reflected down: the base of a cloud over Tel Aviv is
//     ~15 times brighter than the clear sky there (Kyba et al. 2015: overcast city nights 5-25x
//     the clear ones), orange-grey; it falls off within a few km beyond a city (the lit ground
//     sees the base at a grazing angle), so over the desert and out at sea the bases stay darker
//     than the sky: lit only by the little sky light that gets through the cloud
//   * display: the sim's night is "day for night" (the exposure stops at METER.max, far below a
//     dark-adapted eye's), and the eye adapts further in a darker place: a zenith of B0 n.u. (the
//     cities' glow, the natural sky and the moonlit sky) is drawn as level x ((B0 + floor) /
//     (ref + floor))^gamma: Tel Aviv's sky, ~25x the Dead Sea's, ~3x as bright on screen, and the
//     floor keeps a dark site's sky above the land it outlines. All else at night is drawn at that
//     zenith's gain (drawn / B0 per n.u., gain()): the domes on the horizons, the moonlit sky and
//     the moon's light on the land and the clouds (Environment: the moon's boost) keep their real
//     contrasts with the sky. Only the cities' light under a cloud base is drawn compressed
//     against the zenith (their geometric mean: ~4x the sky over central Tel Aviv, not ~15x). The
//     stars and the Milky Way are seen by the physical sky (atmosphereGLSL.js: the naked-eye limit
//     for its brightness)

import { lonLatToXZ } from '../world/coords.js';

/** One natural unit of night sky brightness (174 ucd/m^2) in scene units (32000 cd/m^2). */
export const NATURAL_SKY = 174e-6 / 32000;

/**
 * Light sources: lon, lat, P (light output, ~ million inhabitants at Israeli street lighting
 * levels; Amman's bright, Gaza's dim), R (km, the lit area's radius). Gush Dan is split in parts
 * so its glow has a shape.
 */
const CITIES = [
  { name: 'Tel Aviv - Ramat Gan', lon: 34.79, lat: 32.08, P: 1.6, R: 5 },
  { name: 'Petah Tikva', lon: 34.89, lat: 32.09, P: 0.45, R: 4 },
  { name: 'Holon - Bat Yam - Rishon LeZion', lon: 34.77, lat: 31.98, P: 0.75, R: 5 },
  { name: 'Herzliya - Kfar Saba', lon: 34.87, lat: 32.18, P: 0.45, R: 5 },
  { name: 'Netanya', lon: 34.86, lat: 32.32, P: 0.25, R: 4 },
  { name: 'Rehovot - Yavne', lon: 34.79, lat: 31.89, P: 0.35, R: 4 },
  { name: 'Lod - Ramla - Modiin', lon: 34.93, lat: 31.92, P: 0.4, R: 5 },
  { name: 'Ashdod', lon: 34.65, lat: 31.80, P: 0.25, R: 4 },
  { name: 'Ashkelon', lon: 34.57, lat: 31.67, P: 0.15, R: 3 },
  { name: 'Jerusalem - Ramallah - Bethlehem', lon: 35.21, lat: 31.80, P: 1.2, R: 6 },
  { name: 'Hebron', lon: 35.10, lat: 31.53, P: 0.3, R: 3 },
  { name: 'Nablus', lon: 35.26, lat: 32.22, P: 0.2, R: 3 },
  { name: 'Beer Sheva', lon: 34.79, lat: 31.25, P: 0.3, R: 4 },
  { name: 'Gaza', lon: 34.45, lat: 31.45, P: 0.5, R: 8 },
  { name: 'Haifa - Krayot', lon: 35.02, lat: 32.80, P: 0.7, R: 6 },
  { name: 'Amman - Zarqa', lon: 35.93, lat: 31.97, P: 3.0, R: 8 },
  { name: 'Madaba - Jordan valley', lon: 35.75, lat: 31.75, P: 0.15, R: 4 },
  { name: 'Jericho', lon: 35.45, lat: 31.86, P: 0.05, R: 2 },
  { name: 'Arad - Dead Sea works - Ein Bokek', lon: 35.32, lat: 31.15, P: 0.12, R: 6 },
].map((c) => ({ ...c, ...lonLatToXZ(c.lon, c.lat) }));

/** Sources handed to the shaders (the strongest where the camera is; the rest join the zenith glow). */
export const LP_N = 10;

/** The model's constants (see the top). */
export const LP_MODEL = {
  walker: 1500,            // n.u. at the zenith per P km^-2.5
  horizon: [2, 0.25, 25],  // A = min(max, base + perKm D): a dome's horizon glow over its zenith glow
  scaleHeight: 4,          // km: H, how high a dome reaches (tan(elev) D / H)
  spread: 0.3,             // rad: the haze spreads a dome in azimuth beyond the city's own width
  extinctionKm: 120,       // a far dome dims through the haze
  altitudeKm: 4,           // the glow above the camera fades with height
  cloud: 15000,            // cloud base radiance (n.u.) per P / km^2 under a city ...
  cloudKm: 5,              // ... falling off as exp(-d / cloudKm) beyond it (Tel Aviv ~700, Ben Gurion ~40)
  level: 3.7e-5,           // display: the zenith drawn (scene units, luma) for a sky of ref n.u.
  ref: 11,                 // (Ben Gurion's sky)
  gamma: 0.5,              // from place to place
  floor: 3,                // n.u.: the darkest sites' skies drawn closer to the rest
};

/**
 * Colours (linear sRGB, luma 1): the cities' glow and the natural night sky. The cities' light is
 * sodium (~2100 K) and warm LEDs (3000 K), ~[1, 0.35, 0.05] (r = 1); the haze that scatters it
 * back down favours the shorter wavelengths (the air's molecules ~3x more blue than red), so the
 * glow is ~[1, 0.5, 0.1]: orange-yellow, orange-grey on the screen once the eye's rods take over
 * (Post.js night vision mixes ~60 % of a blue-grey scotopic picture into the darkest tones; with
 * a 3300 K glow the dome over Gush Dan came out a pinkish grey).
 */
export const LP_RGB = [1.631, 0.897, 0.163];
export const NAT_RGB = [0.74, 0.99, 1.84];
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * GLSL: the glow of the cities in direction dir (physical, n.u.) and as drawn; the cities' light
 * on a cloud base. The uniforms are filled by SkyGlow (Environment.uniforms).
 */
export const LP_GLSL = /* glsl */`
#define LP_N ${LP_N}
uniform vec4 uLPSrc[LP_N];   // per dome: xy kappa x the unit vector towards the city (world x, z), z: its horizon glow (n.u.), w: D / H
uniform vec4 uLPCity[LP_N];  // per city: x: its light on a cloud base (n.u. km^2), y: R^2 + H^2 (km^2), zw: centre (world x, z, km)
uniform vec4 uLPBase;        // x: the cities' glow at the zenith (n.u.), y: display gain (scene units per n.u., x the dusk fade-in), z: y x sqrt(zenith n.u.), w: moonlit sky (n.u.)
uniform vec3 uLPZenith;      // the drawn glow at the zenith and (mean over azimuth) the horizon: what the sky-view LUT holds
uniform vec3 uLPHorizon;
const vec3 LP_RGB = vec3(${LP_RGB.join(', ')});
const vec3 NAT_RGB = vec3(${NAT_RGB.join(', ')});
// the sky's brightness in direction dir (n.u.: natural + the cities'), art: the cities' part
float lpSky(vec3 dir, out float art) {
  float y = clamp(dir.y, 0.0, 1.0);
  float t = y / max(sqrt(1.0 - y * y), 0.03);          // tan(elevation)
  float hl = length(dir.xz);
  vec2 h = dir.xz / max(hl, 1e-4);
  art = uLPBase.x;
  for (int i = 0; i < LP_N; i++) {
    vec4 s = uLPSrc[i];
    art += s.z * exp(dot(h, s.xy) - length(s.xy) - t * s.w);
  }
  return art + 1.0 + 1.5 * exp(-3.0 * t);
}
// as drawn (scene units): at the display gain, the cities' light orange-grey (greyer towards the
// zenith, where the air's own scattering mixes in bluer light), the natural sky's blue; y: the
// direction's height
vec3 lpDisplay(float B, float art, float y) {
  vec3 lp = mix(LP_RGB, vec3(1.0), 0.4 * clamp(y, 0.0, 1.0));
  return (NAT_RGB * max(B - art, 0.0) + lp * art) * uLPBase.y;
}
// the cities' light under a cloud base at world xz (m), as drawn (scene units: compressed against
// the zenith, the geometric mean of the two)
vec3 lpCloudBase(vec2 xz) {
  vec2 p = xz * 0.001;
  float g = 0.0;
  for (int i = 0; i < LP_N; i++) {
    vec4 c = uLPCity[i];
    vec2 d = p - c.zw;
    float dd = dot(d, d);
    g += c.x / (c.y + dd) * exp(-sqrt(dd) * ${(1 / LP_MODEL.cloudKm).toFixed(4)});
  }
  return LP_RGB * (uLPBase.z * sqrt(g));
}
`;

/**
 * The domes where the camera is: the uniforms of LP_GLSL (src, city: LP_N x vec4; zenithArt), their
 * JS twins (sky, display, cloudBase) and the display law (drawn, gain).
 */
export class SkyGlow {
  constructor(model = LP_MODEL) {
    this.model = model;
    this.src = new Float32Array(LP_N * 4);
    this.city = new Float32Array(LP_N * 4);
    this.zenithArt = 0;                  // n.u.
    this._list = CITIES.map((c) => ({ c, D: 0, Z: 0, amp: 0 }));
  }

  /** Camera position (m, world) and the cloud base (m MSL). */
  update(x, y, z, cloudBase = 1800) {
    const M = this.model;
    const alt = Math.exp(-Math.max(0, y) / (M.altitudeKm * 1000));
    const H = Math.max(0.3, (cloudBase - 150) / 1000);
    let iso = 0;
    for (const e of this._list) {
      const c = e.c;
      const dx = (c.x - x) / 1000, dz = (c.z - z) / 1000;
      const D = Math.hypot(dx, dz);
      e.D = D;
      e.ux = D > 1e-3 ? dx / D : 0;
      e.uz = D > 1e-3 ? dz / D : 0;
      e.Z = M.walker * c.P * Math.pow(D * D + c.R * c.R, -1.25) * alt;
      const A = Math.min(M.horizon[2], M.horizon[0] + M.horizon[1] * D);
      e.amp = e.Z * A * Math.exp(-D / M.extinctionKm);
      const w = Math.atan2(c.R, D) + M.spread;
      e.kappa = 1 / (w * w);
      e.k = Math.max(D, 0.7 * c.R) / M.scaleHeight;
      e.cloud = M.cloud * c.P;
      e.r2 = c.R * c.R + H * H;
      iso += e.Z;
    }
    this.zenithArt = iso;
    const top = this._list.slice().sort((a, b) => b.amp - a.amp);
    this.src.fill(0);
    this.city.fill(0);
    for (let i = 0; i < LP_N; i++) {
      const e = top[i];
      if (!e) { this.city[i * 4 + 1] = 1; continue; }
      this.src.set([e.kappa * e.ux, e.kappa * e.uz, e.amp, e.k], i * 4);
      this.city.set([e.cloud, e.r2, e.c.x / 1000, e.c.z / 1000], i * 4);
    }
    return this;
  }

  /** JS twin of lpSky: { B, art } (n.u.) in direction (dx, dy, dz) (unit). */
  sky(dx, dy, dz) {
    const y = Math.min(1, Math.max(0, dy));
    const t = y / Math.max(Math.sqrt(1 - y * y), 0.03);
    const hl = Math.hypot(dx, dz);
    const hx = dx / Math.max(hl, 1e-4), hz = dz / Math.max(hl, 1e-4);
    let art = this.zenithArt;
    const s = this.src;
    for (let i = 0; i < LP_N; i++) {
      const kx = s[i * 4], kz = s[i * 4 + 1];
      art += s[i * 4 + 2] * Math.exp(hx * kx + hz * kz - Math.hypot(kx, kz) - t * s[i * 4 + 3]);
    }
    return { B: art + 1 + 1.5 * Math.exp(-3 * t), art };
  }

  /** The zenith as drawn (luma, scene units) for a zenith of B0 n.u. (the display law at the top). */
  drawn(B0) {
    const M = this.model;
    return M.level * Math.pow((B0 + M.floor) / (M.ref + M.floor), M.gamma);
  }

  /**
   * The display gain here (scene units per n.u.) with a moonlit sky of moon n.u. on top of the
   * cities' and the natural sky: the zenith as drawn over the zenith as it is.
   */
  gain(moon = 0) {
    const B0 = this.zenithArt + 1 + Math.max(0, moon);
    return this.drawn(B0) / B0;
  }

  /** JS twin of lpDisplay for a gain k (scene units per n.u., x the dusk fade) and height y: [r, g, b]. */
  display(B, art, k, y = 0, out = [0, 0, 0]) {
    const ky = 0.4 * Math.min(1, Math.max(0, y)), nat = Math.max(0, B - art);
    for (let c = 0; c < 3; c++) out[c] = (NAT_RGB[c] * nat + (LP_RGB[c] + (1 - LP_RGB[c]) * ky) * art) * k;
    return out;
  }

  /**
   * As drawn (gain k) at the zenith and, averaged over the azimuth, just above the horizon (the
   * sky-view LUT's night term, the ambient light's night floor): { zenith, horizon } [r, g, b].
   */
  means(k, n = 32) {
    const zs = this.sky(0, 1, 0);
    const zenith = this.display(zs.B, zs.art, k, 1);
    const horizon = [0, 0, 0], tmp = [0, 0, 0];
    const ce = Math.cos(0.0175), se = Math.sin(0.0175);
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) / n * 2 * Math.PI;
      const s = this.sky(Math.cos(a) * ce, se, Math.sin(a) * ce);
      this.display(s.B, s.art, k, se, tmp);
      for (let c = 0; c < 3; c++) horizon[c] += tmp[c] / n;
    }
    return { zenith, horizon };
  }

  /**
   * The cities' light on a cloud base at world (x, z) (n.u.; JS twin of lpCloudBase before the
   * display, which draws sqrt(this x the zenith n.u.) x the gain).
   */
  cloudBase(x, z) {
    let g = 0;
    const c = this.city;
    for (let i = 0; i < LP_N; i++) {
      const dx = x / 1000 - c[i * 4 + 2], dz = z / 1000 - c[i * 4 + 3];
      const dd = dx * dx + dz * dz;
      g += c[i * 4] / (c[i * 4 + 1] + dd) * Math.exp(-Math.sqrt(dd) / this.model.cloudKm);
    }
    return g;
  }

  /** For the tests and the README: the zenith brightness (n.u.) and the strongest domes here. */
  describe() {
    const top = this._list.slice().sort((a, b) => b.amp - a.amp).slice(0, 5);
    return {
      zenith: +(this.zenithArt + 1).toFixed(2),
      domes: top.map((e) => ({ name: e.c.name, km: +e.D.toFixed(1), horizon: +e.amp.toFixed(2) })),
    };
  }
}

export { CITIES as LP_CITIES, luma as lpLuma };
