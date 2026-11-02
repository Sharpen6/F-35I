// GLSL side of js/env/atmosphere.js. Every custom shader that wants the sky, the haze or
// the sun includes ATMOSPHERE_PARS (uniform declarations + functions); the uniform objects
// themselves live in Environment.uniforms and are shared by reference.
//
// Conventions: world space, Y up, metres; radiance is relative to a top-of-atmosphere sun
// illuminance of 1 and gets multiplied by uSunIlluminance.

import { LP_GLSL, NATURAL_SKY } from './lightPollution.js';

export const SKY_LUT_W = 256;
export const SKY_LUT_H = 128;

export const ATMOSPHERE_CORE = /* glsl */ `
uniform vec3 uSunDir;            // unit vector towards the sun
uniform vec3 uSunColor;          // sun irradiance at the camera (scene units, linear RGB)
uniform vec3 uAmbient;           // sky irradiance on a horizontal surface at ground level
uniform vec3 uFogColor;          // mean horizon haze radiance (simple fog for other shaders)
uniform float uFogDensity;       // extinction at the camera altitude (1/m): fog = 1 - exp(-d * uFogDensity)
uniform vec3 uCameraPos;         // camera world position
uniform float uEarthRadius;      // 6371000
uniform float uTime;             // seconds, for animation
uniform float uSunIlluminance;   // top-of-atmosphere sun irradiance (scene units)
uniform float uCamAltitude;      // camera height above MSL, m
uniform vec4 uAtmoGeom;          // Rg, Rt, rayleigh scale height, mie scale height
uniform vec3 uRayleigh;          // rayleigh scattering (1/m)
uniform vec3 uMie;               // mie scattering, mie extinction (1/m), mie g
uniform vec3 uOzone;             // ozone absorption (1/m) at the peak
uniform vec3 uGroundRadiance;    // radiance of the mean ground (for the sky below the horizon)
uniform float uGroundDatum;      // height of the sky-view LUT's ground sphere, m MSL (<= 0: Dead Sea)
uniform float uNight;            // 0 day .. 1 full night
uniform sampler2D uTransmittanceLUT;
uniform sampler2D uMultiScatLUT;

#ifndef ATMO_PI
#define ATMO_PI 3.141592653589793
#endif

// The sky-view LUT's ground sphere and the camera's radius in it. Below sea level (the Dead Sea
// basin, -430 m) the sphere drops to the lowest ground around the camera: with the sphere at MSL
// a ray to the far shore ended at a "ground" a few hundred metres away, its haze was missing and
// the water and the hills beyond showed as a black band. Densities stay relative to MSL (the air
// in the basin is just a little denser).
float atmoGroundRadius() { return uAtmoGeom.x + min(uGroundDatum, 0.0); }
float atmoCameraRadius() { return uAtmoGeom.x + max(uCamAltitude, min(uGroundDatum, 0.0) + 1.0); }

float atmoUvFromUnit(float u, float size) { return 0.5 / size + u * (1.0 - 1.0 / size); }

vec2 atmoTransmittanceUv(float r, float mu) {
  float Rg = uAtmoGeom.x, Rt = uAtmoGeom.y;
  float H = sqrt(Rt * Rt - Rg * Rg);
  float rho = sqrt(max(0.0, r * r - Rg * Rg));
  float disc = r * r * (mu * mu - 1.0) + Rt * Rt;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = Rt - r, dMax = rho + H;
  float xMu = clamp((d - dMin) / max(dMax - dMin, 1e-3), 0.0, 1.0);
  float xR = clamp(rho / H, 0.0, 1.0);
  return vec2(atmoUvFromUnit(xMu, 256.0), atmoUvFromUnit(xR, 64.0));
}

// Transmittance from radius r towards cos-zenith mu up to space (0 if the ray hits the ground).
vec3 atmoTransmittance(float r, float mu) {
  float Rg = uAtmoGeom.x;
  r = clamp(r, Rg, uAtmoGeom.y);
  float muHorizon = -sqrt(max(0.0, 1.0 - (Rg / r) * (Rg / r)));
  // smooth the terminator over the solar disc (~0.53 deg)
  float vis = clamp((mu - muHorizon) / 0.0093 + 0.5, 0.0, 1.0);
  vec3 t = texture(uTransmittanceLUT, atmoTransmittanceUv(r, max(mu, muHorizon + 0.0047))).rgb;
  return t * vis;
}

// ---- the cumulus field (js/env/Clouds.js; its exact CPU twin is js/env/cloudField.js) ----
uniform vec4 uCloudLayer;        // cumulus base, top (m MSL), field threshold, optical depth (0: no clouds)
uniform vec4 uCloudWind;         // field offset x, z (m: the wind's drift), feature scale (m), -

float atmoHash2(ivec2 p) {
  uvec2 q = uvec2(p);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = h * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return float(h) * (1.0 / 4294967295.0);
}
float atmoValueNoise(vec2 x) {
  vec2 i = floor(x), f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = atmoHash2(c), b = atmoHash2(c + ivec2(1, 0)), d = atmoHash2(c + ivec2(0, 1)), e = atmoHash2(c + ivec2(1, 1));
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
// Raw field 0..1 at a point in feature units ((world xz + wind) / scale).
float atmoCloudField(vec2 p) {
  float v = 0.5 * atmoValueNoise(p) + 0.25 * atmoValueNoise(p * 2.03 + 17.1)
    + 0.125 * atmoValueNoise(p * 4.07 + 31.7) + 0.0625 * atmoValueNoise(p * 8.13 + 7.3);
  return v / 0.9375;
}
// 0..1: inside a cumulus' footprint at world xz.
float atmoCloudCover(vec2 xz) {
  float v = atmoCloudField((xz + uCloudWind.xy) / uCloudWind.z);
  return smoothstep(uCloudLayer.z, uCloudLayer.z + 0.06, v);
}
// Sun transmittance through the cumulus above a world point: the field where the sun's ray
// crosses the layer's middle. No texture (the terrain is at its sampler limit), ~150 ALU.
float atmoCloudShadow(vec3 worldPos) {
  if (uCloudLayer.w <= 0.0 || worldPos.y > uCloudLayer.y) return 1.0;
  float mid = 0.5 * (uCloudLayer.x + uCloudLayer.y);
  float sy = max(uSunDir.y, 0.06);
  vec2 xz = worldPos.xz + uSunDir.xz * ((mid - worldPos.y) / sy);
  return exp(-uCloudLayer.w * atmoCloudCover(xz));
}

// Sun irradiance (scene units) arriving at altitude h (m MSL) at horizontal offset rel.xz
// from the camera: the local vertical tilts with the curvature of the earth. Without clouds.
vec3 atmoSunIrradianceClear(vec3 relToCamera, float h) {
  vec3 up = normalize(vec3(relToCamera.x, uEarthRadius + h, relToCamera.z));
  return uSunIlluminance * atmoTransmittance(uAtmoGeom.x + max(h, 0.0), dot(up, uSunDir));
}
// The same in the shadow of the cumulus (Clouds.js): what lights the ground.
vec3 atmoSunIrradianceAt(vec3 relToCamera, float h) {
  vec3 e = atmoSunIrradianceClear(relToCamera, h);
  return e * atmoCloudShadow(vec3(uCameraPos.x + relToCamera.x, h, uCameraPos.z + relToCamera.z));
}

// Earth curvature: lower a vertex by d^2 / 2R, d = horizontal distance to the camera.
float atmoCurvatureDrop(vec2 relXZ) {
  return dot(relXZ, relXZ) / (2.0 * uEarthRadius);
}

// Optical depths (rayleigh, mie) of a straight path of length L from height h0 to h1 in an
// exponential atmosphere (heights relative to MSL, flat earth: exact enough here).
vec2 atmoPathDepth(float h0, float h1, float L) {
  vec2 H = uAtmoGeom.zw;
  vec2 a = h0 / H;
  vec2 b = (h1 - h0) / H;
  vec2 f = mix((1.0 - exp(-b)) / b, 1.0 - 0.5 * b, step(abs(b), vec2(1e-3)));
  return L * exp(-a) * f;
}

vec3 atmoPathTransmittance(float h0, float h1, float L) {
  vec2 od = atmoPathDepth(h0, h1, L);
  return exp(-(uRayleigh * od.x + uMie.y * od.y));
}
`;

// Sky-view LUT access: everything that looks at the sky or the haze from the camera.
export const ATMOSPHERE_SKYVIEW = /* glsl */ `
uniform sampler2D uSkyViewLUT;   // in-scattered radiance from the camera, per direction
uniform sampler2D uSkyViewTLUT;  // transmittance from the camera to the ground / space, per direction

// Sky-view LUT coordinates (Hillaire 2020) for a world direction seen from the camera.
vec2 atmoSkyViewUv(vec3 dir) {
  float Rg = atmoGroundRadius();
  float r = atmoCameraRadius();
  float vHorizon = sqrt(max(r * r - Rg * Rg, 0.0));
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizon = ATMO_PI - beta;
  float zen = acos(clamp(dir.y, -1.0, 1.0));
  float v;
  if (zen < zenithHorizon) {
    float c = zen / zenithHorizon;
    v = (1.0 - sqrt(max(1.0 - c, 0.0))) * 0.5;
  } else {
    float c = (zen - zenithHorizon) / max(beta, 1e-5);
    v = sqrt(clamp(c, 0.0, 1.0)) * 0.5 + 0.5;
  }
  float ld = length(dir.xz), ls = length(uSunDir.xz);
  float lightViewCos = (ld > 1e-5 && ls > 1e-5) ? dot(dir.xz / ld, uSunDir.xz / ls) : 1.0;
  float u = sqrt(clamp(-lightViewCos * 0.5 + 0.5, 0.0, 1.0));
  return vec2(atmoUvFromUnit(u, ${SKY_LUT_W.toFixed(1)}), atmoUvFromUnit(v, ${SKY_LUT_H.toFixed(1)}));
}

// In-scattered radiance (scene units) of the whole view ray in direction dir.
vec3 atmoSkyRadiance(vec3 dir) {
  return uSunIlluminance * texture(uSkyViewLUT, atmoSkyViewUv(dir)).rgb;
}

// Aerial perspective: what a surface of radiance 'radiance' at distance L in direction dir
// (camera -> point, unit) and height hPoint looks like from the camera.
// In-scattering is the sky-view LUT value of that direction scaled by the share of the
// whole ray's extinction that lies in front of the point, so the haze matches the sky.
vec3 atmoAerial(vec3 radiance, vec3 dir, float L, float hPoint) {
  vec2 uv = atmoSkyViewUv(dir);
  vec3 sFull = texture(uSkyViewLUT, uv).rgb;
  vec3 tFull = texture(uSkyViewTLUT, uv).rgb;
  vec3 t = atmoPathTransmittance(uCamAltitude, hPoint, L);
  vec3 share = clamp((1.0 - t) / max(1.0 - tFull, vec3(1e-4)), 0.0, 1.0);
  return radiance * t + uSunIlluminance * sFull * share;
}

// Same, returning transmittance and in-scatter separately (for blending).
void atmoAerialParts(vec3 dir, float L, float hPoint, out vec3 t, out vec3 inscatter) {
  vec2 uv = atmoSkyViewUv(dir);
  vec3 sFull = texture(uSkyViewLUT, uv).rgb;
  vec3 tFull = texture(uSkyViewTLUT, uv).rgb;
  t = atmoPathTransmittance(uCamAltitude, hPoint, L);
  vec3 share = clamp((1.0 - t) / max(1.0 - tFull, vec3(1e-4)), 0.0, 1.0);
  inscatter = uSunIlluminance * sFull * share;
}
`;

/** Everything: core uniforms and helpers plus sky-view access. */
export const ATMOSPHERE_PARS = ATMOSPHERE_CORE + ATMOSPHERE_SKYVIEW;

// ---------------------------------------------------------------------------------------
// Sky-view LUT pass (rendered into a 2-target render target, GLSL3)

export const SKYVIEW_LUT_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const SKYVIEW_LUT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outScatter;   // rgb: in-scattered light (x the sun), a: the twilight (n.u.)
layout(location = 1) out vec4 outTrans;
uniform vec3 uNightZenith;       // night sky radiance at the zenith (airglow, starlight, moonlit sky)
uniform vec3 uNightHorizon;      // ... at the horizon (the glow of the cities)
${ATMOSPHERE_CORE}
const float NATURAL_SKY = ${NATURAL_SKY.toExponential(4)};   // 1 natural unit of sky brightness (scene units)

float rayleighPhase(float c) { return 3.0 / (16.0 * ATMO_PI) * (1.0 + c * c); }
float miePhase(float c, float g) {
  float g2 = g * g;
  float k = 3.0 / (8.0 * ATMO_PI) * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

vec3 multiScat(float h, float muS) {
  vec2 uv = vec2(clamp(muS * 0.5 + 0.5, 0.0, 1.0), clamp(h / (uAtmoGeom.y - uAtmoGeom.x), 0.0, 1.0));
  uv = vec2(atmoUvFromUnit(uv.x, 32.0), atmoUvFromUnit(uv.y, 32.0));
  return texture(uMultiScatLUT, uv).rgb;
}

void main() {
  float Rg = atmoGroundRadius(), Rt = uAtmoGeom.y, Rmsl = uAtmoGeom.x;
  float r = atmoCameraRadius();
  // un-map the texel (texel centres cover [0, 1] exactly)
  float u = (vUv.x - 0.5 / ${SKY_LUT_W.toFixed(1)}) / (1.0 - 1.0 / ${SKY_LUT_W.toFixed(1)});
  float v = (vUv.y - 0.5 / ${SKY_LUT_H.toFixed(1)}) / (1.0 - 1.0 / ${SKY_LUT_H.toFixed(1)});
  float vHorizon = sqrt(max(r * r - Rg * Rg, 0.0));
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizon = ATMO_PI - beta;
  float zen;
  if (v < 0.5) {
    float c = 1.0 - 2.0 * v;
    zen = zenithHorizon * (1.0 - c * c);
  } else {
    float c = 2.0 * v - 1.0;
    zen = zenithHorizon + beta * c * c;
  }
  float lightViewCos = -(u * u * 2.0 - 1.0);
  float sinZ = sin(zen), cosZ = cos(zen);
  float sinL = sqrt(max(0.0, 1.0 - lightViewCos * lightViewCos));
  vec3 dir = vec3(sinZ * lightViewCos, cosZ, sinZ * sinL);   // local frame: +Y up, sun in XY
  float muS = clamp(uSunDir.y, -1.0, 1.0);
  vec3 sun = vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);

  // ray length to the ground or to space
  float mu = dir.y;
  float discG = r * r * (mu * mu - 1.0) + Rg * Rg;
  bool ground = mu < 0.0 && discG >= 0.0;
  float discT = r * r * (mu * mu - 1.0) + Rt * Rt;
  float dist = ground ? max(0.0, -r * mu - sqrt(max(discG, 0.0))) : max(0.0, -r * mu + sqrt(max(discT, 0.0)));

  float cosT = dot(dir, sun);
  float pr = rayleighPhase(cosT), pm = miePhase(cosT, uMie.z);
  vec3 thr = vec3(1.0);       // throughput incl. ozone
  vec3 odRM = vec3(0.0);      // optical depth without ozone (matches atmoPathTransmittance)
  vec3 L = vec3(0.0);
  const int N = 40;
  float tPrev = 0.0;
  for (int i = 0; i < N; i++) {
    float f = float(i + 1) / float(N);
    float t1 = dist * f * f;
    float dt = t1 - tPrev;
    float t = tPrev + 0.5 * dt;
    tPrev = t1;
    vec3 p = vec3(0.0, r, 0.0) + dir * t;
    float pr2 = length(p);
    float h = pr2 - Rmsl;
    float dR = exp(-h / uAtmoGeom.z), dM = exp(-h / uAtmoGeom.w);
    float dO = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0);
    vec3 extRM = uRayleigh * dR + uMie.y * dM;
    vec3 ext = extRM + uOzone * dO;
    float muSs = dot(p, sun) / pr2;
    vec3 ts = atmoTransmittance(pr2, muSs);
    vec3 ms = multiScat(h, muSs);
    vec3 sR = uRayleigh * dR, sM = vec3(uMie.x * dM);
    vec3 S = ts * (sR * pr + sM * pm) + ms * (sR + sM);
    vec3 stepT = exp(-ext * dt);
    L += thr * S * (1.0 - stepT) / max(ext, vec3(1e-12));
    thr *= stepT;
    odRM += extRM * dt;
  }
  // The night sky's own light (Environment: zero by day): the full value for a ray that leaves
  // the atmosphere, and for a ray that ends on the ground the share its haze scatters (so the haze
  // in front of the hills glows like the sky above them, and the sea reflects it).
  vec3 night = mix(uNightZenith, uNightHorizon, pow(1.0 - clamp(dir.y, 0.0, 1.0), 4.0));
  if (ground) night *= 1.0 - exp(-odRM);
  // the twilight's brightness for the eye (natural units, luma), kept apart from the night term:
  // the sky dome reads the stars' visibility from it (from the sum, the half float's rounding,
  // ~6e-8 x the sun, was ~20 n.u.: a dark site's sky read as Gush Dan's)
  float twilight = min(dot(L, vec3(0.2126, 0.7152, 0.0722)) * uSunIlluminance / NATURAL_SKY, 6e4);
  L += night / max(uSunIlluminance, 1e-6);
  outScatter = vec4(L, twilight);
  outTrans = vec4(exp(-odRM), 1.0);
}
`;

// ---------------------------------------------------------------------------------------
// Sky dome (a unit sphere around the camera; depth test off, drawn first)

export const SKY_DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  // z mid-range in both standard and reversed depth: never clipped by near / far
  gl_Position = vec4(p.xy, 0.5 * p.w, p.w);
}
`;

export const SKY_DOME_FRAG = /* glsl */ `
varying vec3 vDir;
uniform float uShowSun;     // 0 for the environment map (no sun, moon or stars in the ambient light)
uniform vec3 uMoonDir;      // unit vector towards the moon
uniform vec4 uMoonLight;    // rgb: mean radiance of the full moon's disc above the atmosphere, a: earthshine
uniform mat3 uCelestial;    // world -> equatorial frame (x: RA 0h, z: the celestial pole): the stars turn
uniform float uStarVis;     // 0 by day .. 1 at night
uniform vec3 uNightZenith;  // the night term of the sky-view LUT (the cities' mean glow and the moonlit sky)
uniform vec3 uNightHorizon;
${ATMOSPHERE_PARS}
${LP_GLSL}
const float NATURAL_SKY = ${NATURAL_SKY.toExponential(4)};   // 1 natural unit of sky brightness (scene units)

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// Stars on a grid of cells over the celestial sphere: one cell in ~140 has a star, at a point in
// it (jittered) taken straight out to the sphere, and shown where that lies in the cell: ~6,500 in
// the whole sky, as many as the real sky has to magnitude 6.3, whatever the resolution or the zoom
// (they were the stars within ~1.3 px of the sphere: twice as many at 960 x 540 as at 1080p, and
// they went out when zooming in). Each has a magnitude from its rank: the number of stars brighter
// than m grows ~3x a magnitude (N(<m) ~ 7 x 10^(0.47 m) in the whole sky), so the ranks run from
// -1.8 (Sirius) to 6.3. A star shows when it is brighter than the naked-eye limit of the sky behind
// it (nelm: from the sky's physical brightness, the twilight, the moonlit sky and the cities'
// glow), dimmed by the air on its way (ext, mag; tint: its reddening): on a moonless night ~20 over
// central Tel Aviv, ~300 at Ben Gurion, ~1,500 over the Dead Sea, ~2,100 in the Negev above the
// horizon (js/env/README.md); the brightest come out first at dusk. Points one pixel wide whatever
// the resolution (px: a pixel in cells, measured outside any branch), the brightness compressed
// (x1.6 a magnitude, not 2.5: on a screen the bright ones would be blobs and the faint ones
// nothing). One return (HLSL).
const float STAR_SCALE = 0.0031;   // radiance of a 1-pixel star of magnitude 1 (scene units)
vec3 stars(vec3 q0, float px, float nelm, float ext, vec3 tint0) {
  vec3 q = q0 * 260.0;
  vec3 c = floor(q);
  float h = hash13(c);
  vec3 o = vec3(0.0);
  if (h >= 0.99287) {
    float u = max((1.0 - h) * 140.3, 1e-5);         // rank: ~0 the brightest .. 1 the faintest
    float m = 6.3 + log(u) * 0.924 + ext;              // log10(u) / 0.47
    float fade = smoothstep(nelm + 0.2, nelm - 0.8, m);
    vec3 jitter = vec3(hash13(c + 7.1), hash13(c + 3.7), hash13(c + 1.3)) - 0.5;
    vec3 sp = normalize(c + 0.5 + jitter * 0.6) * 260.0;   // the star on the sphere
    vec3 inCell = step(c, sp) * step(sp, c + 1.0);
    float d = length(q - sp);
    float peak = STAR_SCALE * exp2(-0.6644 * (m - 1.0)) * min(1.0, 0.5 / px);
    float s = smoothstep(px * 1.3, px * 0.2, d) * peak * fade * inCell.x * inCell.y * inCell.z;
    float t = hash13(c + 9.9);
    vec3 tint = t < 0.3 ? vec3(0.78, 0.86, 1.0) : t < 0.8 ? vec3(1.0, 0.97, 0.92) : vec3(1.0, 0.8, 0.6);
    o = tint * tint0 * s;
  }
  return o;
}
// The naked-eye limiting magnitude for a sky of B natural units (Schaefer's fit, as in the light
// pollution atlases: NELM = 7.93 - 5 log10(10^(4.316 - b / 5) + 1), b in mag / arcsec^2 = 22.0 -
// 2.5 log10 B): 6.6 under a natural sky, ~3.8 over Tel Aviv
float nakedEyeLimit(float B) {
  return 7.93 - 5.0 * log(0.824 * sqrt(max(B, 1e-3)) + 1.0) / 2.302585;
}

float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1)), k = hash13(i + vec3(0, 1, 1)), l = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(k, l, f.x), f.y), f.z);
}

// The Milky Way: a faint band along the galactic plane (north galactic pole RA 192.86, Dec 27.13;
// centre RA 266.40, Dec -28.94, low in the south on summer nights), brighter towards the centre,
// broken up by dust lanes. Faint: the glow of the cities hides most of it in central Israel.
float milkyWay(vec3 q) {
  const vec3 NGP = vec3(-0.8676, -0.1981, 0.4560);
  const vec3 GC = vec3(-0.0549, -0.8734, -0.4838);
  float b = dot(q, NGP);
  float band = exp(-b * b / 0.022);
  float core = 0.35 + 0.65 * pow(max(dot(q, GC), 0.0), 3.0);
  float n = vnoise3(q * 9.0) * 0.6 + vnoise3(q * 23.0) * 0.4;
  float dust = smoothstep(0.35, 0.75, vnoise3(q * 14.0 + 3.1)) * exp(-b * b / 0.004);
  return band * core * (0.7 + 0.6 * n) * (1.0 - 0.6 * dust);
}

// The moon's near side, from selenographic latitude / longitude of the main maria (dark basalt
// plains) and two bright young craters; soft edges broken up by noise. Values ~ normal albedo / mean.
float moonAlbedo(vec3 p) {
  float a = 1.18;
  // (lat, lon, radius) in degrees, darkness
  const int N = 15;
  vec4 M[N];
  M[0] = vec4(18.0, -57.0, 24.0, 0.42);   // Oceanus Procellarum
  M[1] = vec4(33.0, -16.0, 17.0, 0.5);    // Imbrium
  M[2] = vec4(28.0, 17.5, 10.0, 0.52);    // Serenitatis
  M[3] = vec4(8.5, 31.0, 11.0, 0.55);     // Tranquillitatis
  M[4] = vec4(17.0, 59.0, 7.5, 0.5);      // Crisium
  M[5] = vec4(-8.0, 51.0, 9.0, 0.45);     // Fecunditatis
  M[6] = vec4(-21.0, -17.0, 10.0, 0.4);   // Nubium
  M[7] = vec4(-24.0, -39.0, 5.5, 0.45);   // Humorum
  M[8] = vec4(-15.0, 35.0, 5.5, 0.45);    // Nectaris
  M[9] = vec4(56.0, -25.0, 6.0, 0.38);    // Frigoris (a long strip)
  M[10] = vec4(56.0, 5.0, 6.0, 0.38);
  M[11] = vec4(55.0, 30.0, 5.0, 0.35);
  M[12] = vec4(13.0, 4.0, 4.5, 0.4);      // Vaporum
  M[13] = vec4(-10.0, -23.0, 6.0, 0.38);  // Cognitum
  M[14] = vec4(7.0, -31.0, 6.5, 0.38);    // Insularum
  float n = vnoise3(p * 11.0) * 0.6 + vnoise3(p * 31.0) * 0.4;
  float dark = 0.0;
  for (int i = 0; i < N; i++) {
    float la = radians(M[i].x), lo = radians(M[i].y);
    vec3 c = vec3(cos(la) * sin(lo), sin(la), cos(la) * cos(lo));
    float ang = acos(clamp(dot(p, c), -1.0, 1.0));
    float r = radians(M[i].z) * (0.85 + 0.3 * n);
    dark = max(dark, M[i].w * smoothstep(r, r * 0.55, ang));
  }
  a *= 1.0 - dark;
  // Tycho and Copernicus: small bright spots
  vec3 ty = vec3(cos(radians(-43.3)) * sin(radians(-11.2)), sin(radians(-43.3)), cos(radians(-43.3)) * cos(radians(-11.2)));
  vec3 co = vec3(cos(radians(9.6)) * sin(radians(-20.1)), sin(radians(9.6)), cos(radians(9.6)) * cos(radians(-20.1)));
  a += 0.5 * smoothstep(0.9997, 0.99995, dot(p, ty)) + 0.35 * smoothstep(0.9997, 0.99995, dot(p, co));
  return a * (0.88 + 0.24 * n);
}

void main() {
  vec3 dir = normalize(vDir);
  vec2 uv = atmoSkyViewUv(dir);
  vec4 sv = texture(uSkyViewLUT, uv);
  vec3 L = uSunIlluminance * sv.rgb;
  float Rg = atmoGroundRadius();
  float r = atmoCameraRadius();
  float muHorizon = -sqrt(max(0.0, 1.0 - (Rg / r) * (Rg / r)));
  // the star field's cells per pixel (derivatives outside the branches below)
  vec3 qs = uCelestial * dir;
  float starPx = max(fwidth(qs.x) + fwidth(qs.y) + fwidth(qs.z), 4e-6) * 156.0;
  // the sky's brightness for the eye (natural units: the stars and the Milky Way); the cities'
  // domes in their own directions (js/env/lightPollution.js: the LUT holds their mean over the
  // azimuth)
  float art = 0.0, Bsky = 1.0;
  if (dir.y >= muHorizon && uLPBase.y > 0.0) {
    float p = pow(1.0 - clamp(dir.y, 0.0, 1.0), 4.0);
    Bsky = lpSky(dir, art);
    L = max(L + lpDisplay(Bsky, art, dir.y) - mix(uLPZenith, uLPHorizon, p), 0.0);
  }
  if (dir.y < muHorizon) {
    // below the geometric horizon: hazy ground beyond the terrain
    L += texture(uSkyViewTLUT, uv).rgb * uGroundRadiance;
  } else if (uShowSun > 0.5) {
    vec3 tr = atmoTransmittance(r, dir.y);
    // sun disc (angular radius 0.2666 deg) through the atmosphere. Limb darkening per channel
    // (I ~ mu^a, a = 0.40 / 0.50 / 0.65 for red / green / blue: the rim is redder), normalised so
    // the disc as a whole still gives the sun's irradiance. atan2 keeps small angles precise.
    const float SUN_R = 0.004654;
    float ang = atan(length(cross(dir, uSunDir)), dot(dir, uSunDir));
    float aa = max(fwidth(ang), 1e-5);
    float disc = smoothstep(SUN_R + aa, SUN_R - aa, ang);
    if (disc > 0.0) {
      float x = clamp(ang / SUN_R, 0.0, 1.0);
      float mu = sqrt(max(1e-4, 1.0 - x * x));
      vec3 al = vec3(0.40, 0.50, 0.65);
      vec3 limb = pow(vec3(mu), al) * (al + 2.0) * 0.5;
      L += disc * limb * uSunIlluminance * tr / (ATMO_PI * SUN_R * SUN_R);
    }
    // moon: a sphere lit by the sun (the phase follows), Lommel-Seeliger shading (a dusty
    // surface: the full moon is flat, not darker at the rim), maria, and earthshine on the dark side
    const float MOON_R = 0.00452;
    float angM = atan(length(cross(dir, uMoonDir)), dot(dir, uMoonDir));
    if (angM < MOON_R * 1.6 && uMoonLight.g > 0.0) {
      float aaM = max(fwidth(angM), 1e-5);
      float discM = smoothstep(MOON_R + aaM, MOON_R - aaM, angM);
      // the moon's north on the sky points to the celestial pole (latitude 31.8 N)
      vec3 ncp = vec3(0.0, 0.5270, -0.8499);
      vec3 upM = normalize(ncp - uMoonDir * dot(ncp, uMoonDir));
      vec3 rightM = cross(uMoonDir, upM);
      vec3 d = dir - uMoonDir * dot(dir, uMoonDir);
      vec2 s = vec2(dot(d, rightM), dot(d, upM)) / MOON_R;
      float z = sqrt(max(0.0, 1.0 - dot(s, s)));
      vec3 n = rightM * s.x + upM * s.y - uMoonDir * z;   // surface normal (world)
      float mu0 = dot(n, uSunDir), mu = z;
      // the side facing us: selenographic (x east = towards Mare Crisium, y north, z to the earth)
      vec3 sel = normalize(vec3(s.x, s.y, z));
      float alb = moonAlbedo(sel);
      float lit = mu0 > 0.0 ? 2.0 * mu0 / (mu0 + mu + 1e-4) : 0.0;
      float shine = uMoonLight.a;
      vec3 tm = atmoTransmittance(r, uMoonDir.y);
      L += discM * alb * (lit + shine) * uMoonLight.rgb * tm;
    }
    // stars and the Milky Way where the sky is dark enough to show them: the eye sees by the
    // physical sky (the twilight from the LUT's alpha, the moonlit sky, the cities' glow), not by
    // the one drawn. The Milky Way's brightest star clouds add ~1.2 natural units: seen where that
    // is more than ~10-25 % of the sky (under a natural sky, over the Dead Sea and the Negev),
    // hidden in Gush Dan and under a bright moon (Falchi et al. 2016); drawn at the night's gain
    if (uStarVis > 0.0) {
      const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
      float tl = max(dot(tr, LUMA), 1e-4);
      float Bphys = Bsky + uLPBase.w + sv.a;
      float ext = -1.0857 * log(tl);                    // the air's extinction, magnitudes
      L += stars(qs, starPx, nakedEyeLimit(Bphys), ext, tr / tl);
      float mwNu = milkyWay(qs) * 1.2;
      float mw = smoothstep(0.85, 1.0, uStarVis) * smoothstep(0.08, 0.25, mwNu / Bphys);
      L += vec3(0.85, 0.9, 1.0) * (uLPBase.y * mwNu * mw) * tr;
    }
  }
  gl_FragColor = vec4(L, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
