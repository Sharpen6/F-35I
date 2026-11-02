// Dead Sea shaders (DeadSea.js): the lake surface and the terrain as the lake mirrors it.
//
// LAKE_FRAG runs on the terrain's own patches over the basin (TERRAIN_VERT, the same instances
// the terrain just drew), after the terrain: below LAKE_GATE the terrain shader writes only its
// land part and 1 - water into alpha (terrainShaders.js, uLake), and this pass adds the water,
// blended by 1 - destination alpha (DeadSea.js). So the shore keeps the terrain's own soft
// water edge (land cover, 10 m near the camera) and the lake needs no land cover of its own.
//
// The brine (density 1.24, ten times as viscous as sea water) damps the short waves: on calm
// mornings the lake is a mirror of the Judean and Moab walls, by afternoon light ripples blur
// the reflections, after sunset the western wind raises a chop (DeadSea.js windAt). The water
// itself is clear with dissolved organic matter absorbing the blue (Sokoletsky et al. 2006:
// about half the absorption at 440 nm): over the white salt and aragonite of the shallows it is
// milky turquoise, deep water is dark blue-green; its refractive index (1.39) makes it a little
// more reflective than fresh water (F0 0.027).
//
// Reflection: on high quality a planar mirror (DeadSea.js renders the terrain from below the
// lake into a half-resolution target with MIRROR_FRAG; premultiplied, alpha = terrain), looked
// up where the rippled reflected ray points, blurred by the ripples finer than a pixel (its
// mip chain); elsewhere the sky (sky-view LUT) and the cumulus layer, or on medium / low the
// walls' silhouette from a horizon profile around the camera (DeadSea.js _profile).
//
// Samplers (as the program uses them; tests/landscape_shots.mjs lists them): lake 8 (uHeights,
// uDetailArr, uMirrorTex, uLakeData, uProfile, uHorizon, the transmittance and sky-view LUTs),
// mirror 10 (uHeights, uOverview, uFarColor, uRiftColor, uNormalCore, uNormalFar, uHorizon, 3 LUTs).

import { ATMOSPHERE_PARS } from '../env/atmosphereGLSL.js';
import { DETAIL_LAYERS } from './detailTextures.js';
import { HORIZON_GLSL } from './horizonMap.js';
import { RIFT_NORMAL_GLSL, RIFT_COLOR_GLSL } from './riftGLSL.js';

/** Lake level (m MSL) of the height data: the whole north basin is flat at -427.0. */
export const LAKE_LEVEL = -427.0;
/**
 * Terrain below this height (m MSL) is the basin: its water is the lake pass's. Low enough to
 * leave the evaporation ponds (-391 .. -392) to the terrain, high enough to hold the shore
 * triangles of the far grid (200 m: one vertex in the water, the next 10-30 m up the shore).
 */
export const LAKE_GATE = -405.0;
/** Lake-local origin (world x, z, m) near the middle of the basin: wave coordinates stay exact. */
export const LAKE_ORIGIN = [42000, 30000];

const f1 = (v) => Number(v).toFixed(1);

/**
 * Haze in the basin, for the terrain (terrainShaders.js), the lake and its mirror. The
 * boundary layer's haze is anchored at sea level (atmosphere.js: Mie density exp(-h / 1.2 km)),
 * which makes the air at the lake (-427 m) 1.4 times as hazy as the coast's: the walls 10-20 km
 * away drowned in it (on the 40 km default visibility a wall 15 km across the lake kept 13 % of
 * its contrast). Here its density stops growing below BASIN_HAZE_FLOOR; above it, the same as
 * atmoAerial. Needs ATMOSPHERE_PARS.
 */
export const BASIN_HAZE_GLSL = /* glsl */ `
const float BASIN_HAZE_FLOOR = 0.0;
// atmoPathTransmittance with both ends raised to the floor. Its own (1 - e^-b) / b is 0 / 0
// (NaN, a black picture) when both ends end up at the same height: a camera and a point both
// below the floor. Here the series takes over before the division sees a zero.
vec3 basinTransmittance(float h0, float h1, float L) {
  vec2 H = uAtmoGeom.zw;
  float a0 = max(h0, BASIN_HAZE_FLOOR);
  vec2 b = (max(h1, BASIN_HAZE_FLOOR) - a0) / H;
  vec2 small = step(abs(b), vec2(1e-3));
  vec2 bs = mix(b, vec2(1.0), small);
  vec2 od = L * exp(-a0 / H) * mix((1.0 - exp(-bs)) / bs, 1.0 - 0.5 * b, small);
  return exp(-(uRayleigh * od.x + uMie.y * od.y));
}
// atmoAerial with basinTransmittance
vec3 basinAerial(vec3 radiance, vec3 dir, float L, float hPoint) {
  vec2 uv = atmoSkyViewUv(dir);
  vec3 sFull = texture(uSkyViewLUT, uv).rgb;
  vec3 tFull = texture(uSkyViewTLUT, uv).rgb;
  vec3 t = basinTransmittance(uCamAltitude, hPoint, L);
  vec3 share = clamp((1.0 - t) / max(1.0 - tFull, vec3(1e-4)), 0.0, 1.0);
  return radiance * t + uSunIlluminance * sFull * share;
}
`;

export const LAKE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_PARS}

varying vec3 vRel;
varying vec2 vWorldXZ;
varying float vH;

uniform highp sampler2DArray uDetailArr;  // wave layer: RG slope, B crest (detailTextures.js)
uniform sampler2D uMirrorTex;             // planar reflection, premultiplied, alpha = terrain; mipmapped
uniform sampler2D uLakeData;              // R: sqrt(distance to the shore / 1600 m)
uniform sampler2D uProfile;               // per azimuth: wall top above the lake (m), its distance (m), lit share, -
uniform mat4 uMirrorMatrix;               // mirror camera clip space of (position relative to it)
uniform vec4 uMirrorInfo;                 // on (0/1), 2 x camera height above the lake (m), mirror px per radian, max lod
uniform vec4 uWind;                       // unit vector the wind blows to (world x, z), speed (m/s), patchiness 0..1
uniform vec4 uRipple;                     // mean square slope: resolved, total; drift (m), -
uniform vec4 uLakeBox;                    // lake data: west x, north z (m), 1 / width, 1 / depth (1/m)
uniform vec4 uProfileInfo;                // profile centre x, z (m), on (0/1), -
uniform float uLakeDebug;                 // ?lakeDebug=: 1 the reflection alone, 2 the mirror lookup (uv, hit)

${HORIZON_GLSL}
${BASIN_HAZE_GLSL}

#define DL_WATER ${f1(DETAIL_LAYERS.WATER.index)}
const float LAKE_LEVEL = ${f1(LAKE_LEVEL)};
const float LAKE_GATE = ${f1(LAKE_GATE)};
const vec2 LAKE_ORIGIN = vec2(${f1(LAKE_ORIGIN[0])}, ${f1(LAKE_ORIGIN[1])});
const float F0 = 0.027;
// diffuse attenuation (1/m, r g b): red absorbed by the water, blue by the dissolved organic
// matter; reflectance of deep water and of the white salt / aragonite floor of the shallows
const vec3 K_ATT = vec3(0.42, 0.075, 0.09);
const vec3 R_DEEP = vec3(0.005, 0.03, 0.036);
const vec3 R_FLOOR = vec3(0.62, 0.64, 0.6);
const vec3 WALL_ALBEDO = vec3(0.36, 0.3, 0.24);   // the walls' mean (limestone, marl, sandstone)

// One scale of ripples: the wave layer squeezed along the wind (crests across it), turned by
// 'turn' (cos, sin), drifting downwind by 'drift' metres. Returns the world slope (dh/dx, dh/dz).
vec2 rippleLayer(vec2 lp, vec2 gdx, vec2 gdy, vec2 W, vec2 turn, float tile, float squeeze, float drift) {
  vec2 a = vec2(W.x * turn.x - W.y * turn.y, W.x * turn.y + W.y * turn.x);   // along
  vec2 b = vec2(-a.y, a.x);                                                  // across
  vec2 k = vec2(squeeze, 1.0) / tile;
  vec2 uv = vec2(dot(lp, a) - drift, dot(lp, b)) * k;
  vec2 ux = vec2(dot(gdx, a), dot(gdx, b)) * k, uy = vec2(dot(gdy, a), dot(gdy, b)) * k;
  vec2 s = textureGrad(uDetailArr, vec3(uv, DL_WATER), ux, uy).rg * 2.0 - 1.0;
  return a * (s.x * squeeze) + b * s.y;
}

// The fallback reflection of the walls (no mirror): the horizon profile around the camera,
// seen from the lake point at 'rel' (camera-relative) in direction R.
vec3 profileReflection(vec3 rel, vec3 R, vec3 sky, vec3 sunE) {
  float lr = length(R.xz);
  vec3 c = sky;
  if (uProfileInfo.z > 0.5 && lr > 1e-4) {
    vec2 dir = R.xz / lr;
    float az = atan(dir.y, dir.x);
    vec4 pr = textureLod(uProfile, vec2(az * (0.5 / PI) + 0.5, 0.5), 0.0);   // in a branch: no implicit derivatives
    vec2 o = rel.xz + uCameraPos.xz - uProfileInfo.xy;
    float D = max(pr.g - dot(o, dir), 250.0);
    float top = pr.r - D * D / (2.0 * uEarthRadius);
    float el = atan(top, D);
    float rEl = asin(clamp(R.y, -1.0, 1.0));
    float k = smoothstep(el + 0.004, el - 0.004, rEl) * step(1.0, pr.r);
    if (k > 0.0) {
      vec3 wall = WALL_ALBEDO * (sunE * pr.b + uAmbient * 0.7) / PI;
      vec3 t = basinTransmittance(LAKE_LEVEL, LAKE_LEVEL + 0.5 * max(top, 0.0), D);
      c = mix(sky, wall * t + sky * (1.0 - t), k);
    }
  }
  return c;
}

void main() {
  #include <logdepthbuf_fragment>
  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    // the terrain's own surface: drawn again, a hair nearer so LEQUAL keeps it
    gl_FragDepth -= 2.0e-6;
  #endif
  // the land the terrain drew in full (alpha 1) above the gate
  if (vH > LAKE_GATE) discard;

  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;
  vec3 upP = normalize(vec3(vRel.x / uEarthRadius, 1.0, vRel.z / uEarthRadius));
  vec2 gdx = dFdx(vRel.xz), gdy = dFdy(vRel.xz);
  float px = sqrt(max(dot(gdx, gdx), dot(gdy, gdy)));
  vec2 lp = vWorldXZ - LAKE_ORIGIN;
  vec2 W = uWind.xy;

  // ---- ripples: cat's paws at calm (rippled patches on glassy water), even ripples in wind ----
  vec2 pw = (lp - W * uRipple.z * 0.6) / 420.0;
  float paws = 0.65 * atmoValueNoise(pw) + 0.35 * atmoValueNoise(pw * 2.7 + 5.3);
  float kLoc = mix(1.0, smoothstep(0.38, 0.72, paws) * 1.9 + 0.08, uWind.w);
  float mssTot = uRipple.y * kLoc;
  // three scales (main wavelength about tile / 6), each drifting at its phase speed
  float d = uRipple.z;
  vec2 s1 = rippleLayer(lp, gdx, gdy, W, vec2(1.0, 0.0), 5.0, 1.7, d * 1.0);
  vec2 s2 = rippleLayer(lp, gdx, gdy, W, vec2(0.83, 0.56), 1.9, 1.3, d * 0.62);
  vec2 s3 = rippleLayer(lp, gdx, gdy, W, vec2(0.95, -0.31), 17.0, 2.0, d * 1.85);
  // the share each scale keeps after its mip filtering (the rest roughens the glint and blurs)
  float r1 = 1.0 - smoothstep(5.0 / 96.0, 5.0 / 8.0, px);
  float r2 = 1.0 - smoothstep(1.9 / 96.0, 1.9 / 8.0, px);
  float r3 = 1.0 - smoothstep(17.0 / 96.0, 17.0 / 8.0, px);
  float wind3 = smoothstep(2.5, 6.0, uWind.z);
  vec3 wr = vec3(0.55, 0.3, 0.15 + 0.5 * wind3);
  float amp = sqrt(uRipple.x * kLoc / dot(wr, wr)) * 1.6;
  vec2 slope = (s1 * wr.x + s2 * wr.y + s3 * wr.z) * amp;
  float mssRes = uRipple.x * kLoc * dot(wr * wr, vec3(r1, r2, r3)) / dot(wr, wr);
  float mssU = max(mssTot - mssRes, 0.0) + 2.0e-5 + 1.5e-6 * min(dist, 30000.0) / 100.0;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y) + upP - vec3(0.0, 1.0, 0.0));

  // ---- light ----
  vec3 sunE = atmoSunIrradianceAt(vRel, LAKE_LEVEL);
  float vis = terrainSunVisibility(vWorldXZ, LAKE_LEVEL, upP);
  float cosI = clamp(dot(-V, N), 0.0, 1.0);
  vec3 R = reflect(V, N);
  R.y = max(R.y, 0.002 + abs(R.y) * 0.5);
  // the ripples finer than a pixel: their facets mirror, on average, sky higher above the
  // horizon (rippled water is darker than glassy water at grazing views), and the mean of their
  // Fresnel reflectance is lower than the smooth surface's
  float sigU = sqrt(mssU);
  R = normalize(R + upP * (1.1 * sigU));
  float cosF = clamp(cosI + 0.5 * sigU, 0.0, 1.0);
  float F = F0 + (1.0 - F0) * pow(1.0 - cosF, 5.0);

  // ---- reflection: the sky (the cumulus are not mirrored: their footprints alone, flat and
  // not where the drawn clouds are, read as floating ice), the mirror over it ----
  vec3 sky = atmoSkyRadiance(R);
  vec3 refl = sky;
  vec2 muv = vec2(-1.0);
  float hit = 0.0;
  if (uMirrorInfo.x > 0.5) {
    // where the mirror camera sees the reflected ray's point a few kilometres out (exact for
    // the unrippled ray: it runs along the mirror camera's own ray through this point)
    vec3 pm = vRel + vec3(0.0, uMirrorInfo.y, 0.0);
    vec4 c0 = uMirrorMatrix * vec4(pm + R * 6000.0, 1.0);
    muv = c0.xy / max(c0.w, 1e-3) * 0.5 + 0.5;
    if (c0.w > 1e-3 && all(greaterThan(muv, vec2(0.002))) && all(lessThan(muv, vec2(0.998)))) {
      // ripples finer than a pixel blur the reflection, mostly up and down
      float blur = 2.0 * sqrt(mssU) * uMirrorInfo.z;
      float lod = clamp(log2(max(blur * 0.5, 1.0)), 0.0, uMirrorInfo.w);
      vec2 dv = vec2(0.0, min(blur * 0.5, 64.0)) / vec2(textureSize(uMirrorTex, 0));
      vec4 m = textureLod(uMirrorTex, muv, lod) * 0.5
             + textureLod(uMirrorTex, clamp(muv + dv, 0.001, 0.999), lod) * 0.25
             + textureLod(uMirrorTex, clamp(muv - dv, 0.001, 0.999), lod) * 0.25;
      refl = m.rgb + (1.0 - m.a) * sky;
      hit = 0.5 + 0.5 * m.a;
    } else {
      refl = profileReflection(vRel, R, sky, sunE);
    }
  } else {
    refl = profileReflection(vRel, R, sky, sunE);
  }

  // ---- body: the floor through the water in the shallows, deep water offshore ----
  float dShore = texture(uLakeData, (vWorldXZ - uLakeBox.xy) * uLakeBox.zw).r;
  dShore = dShore * dShore * 1600.0;
  float shelf = mix(0.012, 0.07, atmoValueNoise(lp / 900.0 + 3.1));
  float depth = 0.08 + dShore * shelf;
  vec3 tr = exp(-2.0 * K_ATT * depth);
  float floorA = 0.85 + 0.3 * (atmoValueNoise(lp / 37.0) - 0.5);
  vec3 Rw = R_DEEP * (1.0 - tr) + R_FLOOR * floorA * tr;
  vec3 Ed = sunE * max(dot(upP, uSunDir), 0.0) * vis + uAmbient;
  vec3 body = Rw * Ed / PI;

  // ---- sun glint (GGX, the unresolved ripples as roughness) ----
  float a2 = max(mssU, 4.0e-4);
  float al = sqrt(a2);
  vec3 Hh = normalize(uSunDir - V);
  float NdH = max(dot(N, Hh), 0.0), NdL = max(dot(N, uSunDir), 0.0), NdV = max(cosI, 1e-3);
  float Dg = a2 / (PI * pow(NdH * NdH * (a2 - 1.0) + 1.0, 2.0));
  float kG = 0.5 * al;
  float G = NdL / (NdL * (1.0 - kG) + kG) / (NdV * (1.0 - kG) + kG);
  float Fs = F0 + (1.0 - F0) * pow(1.0 - max(dot(Hh, uSunDir), 0.0), 5.0);
  vec3 spec = sunE * vis * Fs * Dg * G * 0.25 * step(0.0, uSunDir.y);

  vec3 lake = refl * F + body * (1.0 - F) + spec;
  // seen from the camera: the terrain pass already added the haze in front (in-scatter)
  vec3 t = basinTransmittance(uCamAltitude, vH, dist);
  if (uLakeDebug > 0.5) lake = uLakeDebug < 1.5 ? refl : vec3(fract(muv), hit) * 0.3;
  gl_FragColor = vec4(lake * t, 1.0);
}
`;

/**
 * The terrain as the lake mirrors it: drawn from the mirror camera (below the lake), cheap:
 * colour from the overview / far images, normal maps, sun with the horizon map's shadows,
 * the haze between the lake and the point (the camera-to-lake part is the lake pass's).
 */
export const MIRROR_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_PARS}

varying vec3 vRel;
varying vec2 vWorldXZ;
varying float vH;

uniform sampler2D uOverview;
uniform sampler2D uFarColor;
uniform sampler2D uNormalCore;
uniform sampler2D uNormalFar;
uniform vec4 uRiftBox;
uniform float uNormalFarRows;
uniform sampler2D uRiftColor;
uniform vec4 uRiftColorBox;
uniform float uAlbedoGain;
uniform vec4 uMirrorInfo;      // on, 2 x camera height above the lake (m), -, -

${HORIZON_GLSL}
${BASIN_HAZE_GLSL}

#ifdef NORMAL_UNORM
  #define DECODE_N(v) ((v) * 2.0 - 1.0)
#else
  #define DECODE_N(v) (v)
#endif
${RIFT_NORMAL_GLSL}
${RIFT_COLOR_GLSL}
const float LAKE_LEVEL = ${f1(LAKE_LEVEL)};

void main() {
  #include <logdepthbuf_fragment>
  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;
  vec2 xz = vWorldXZ;
  float edge = max(abs(xz.x), abs(xz.y));
  float coreW = 1.0 - smoothstep(51200.0 - 4000.0, 51200.0, edge);
  // the core's colour and normals read everywhere (a texture() in a branch has no derivatives)
  vec3 col = mix(farColor(xz), texture(uOverview, (xz + 51200.0) / 102400.0).rgb, coreW);
  vec2 nxz = mix(farNormalXZ(xz), DECODE_N(texture(uNormalCore, ((xz + 51200.0) / 25.0 + 0.5) / 4097.0).rg), coreW);
  vec3 upP = normalize(vec3(vRel.x / uEarthRadius, 1.0, vRel.z / uEarthRadius));
  vec3 N = normalize(vec3(nxz.x, sqrt(max(1.0 - dot(nxz, nxz), 0.01)), nxz.y));
  N = normalize(N + upP - vec3(0.0, 1.0, 0.0));
  vec3 sunE = atmoSunIrradianceAt(vRel, vH);
  float vis = terrainSunVisibility(xz, vH, upP);
  float NdL = max(dot(N, uSunDir), 0.0);
  vec3 albedo = col * uAlbedoGain;
  vec3 radiance = albedo * (sunE * NdL * vis + uAmbient * (0.55 + 0.45 * dot(N, upP))) / PI;
  // the mirror camera sits as far below the lake as the camera above it: its ray meets the
  // lake after that height / V.y; the haze of the rest, from the lake up to the point
  float seg = max(dist - 0.5 * uMirrorInfo.y / max(V.y, 1e-3), 0.0);
  vec2 uv = atmoSkyViewUv(V);
  vec3 sFull = texture(uSkyViewLUT, uv).rgb;
  vec3 tFull = texture(uSkyViewTLUT, uv).rgb;
  vec3 tr = basinTransmittance(LAKE_LEVEL, vH, seg);
  vec3 share = clamp((1.0 - tr) / max(1.0 - tFull, vec3(1e-4)), 0.0, 1.0);
  gl_FragColor = vec4(radiance * tr + uSunIlluminance * sFull * share, 1.0);
}
`;
