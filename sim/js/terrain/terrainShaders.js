// Terrain shaders (three.js ShaderMaterial, GLSL ES 3.0).
//
// Vertex: CDLOD. Every patch instance is a 64 x 64 (or 32 x 32) grid; aNode = (origin in
// 25 m units from the far area's NW corner, grid step in units, level). Heights come from
// R16UI textures with texelFetch (exactly the data the CPU uses for heightAt); vertices
// morph towards the next coarser grid with distance; positions are built relative to the
// camera from exact integers (no float32 jitter 50 km from the origin) and lowered by the
// earth's curvature d^2 / 2R.
//
// Fragment: satellite colour (L0 tile near the camera, core overview, far image) with a
// procedural detail texture chosen by ESA WorldCover land cover; water (sea, Dead Sea,
// ponds) with waves, Fresnel sky reflection and sun glint; procedural runway paint; the
// aircraft's shadow; sun light through the atmosphere; aerial perspective from the sky-view
// LUT so the haze matches the sky.

import { ATMOSPHERE_PARS, ATMOSPHERE_CORE } from '../env/atmosphereGLSL.js';
import { DETAIL_TILE_M } from './textures.js';

export const MAX_RWY = 4;

export const TERRAIN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
${ATMOSPHERE_CORE}

attribute vec4 aNode;               // originU.x, originU.z, stepU, level
uniform highp usampler2D uHCore;    // 4097 x 4097 core heights
uniform highp usampler2D uHFar;     // 2049 x 2049 far heights
uniform vec2 uCamHiU;               // camera xz in 25 m units, integer valued
uniform vec3 uCamLo;                // camera x, z remainder (m) in .x / .z; camera y in .y
uniform float uRange0;
uniform float uMorphStart;
uniform float uMorphEnd;

varying vec3 vRel;                  // camera-relative position as rendered (curved)
varying vec2 vWorldXZ;              // world x, z (m)
varying float vH;                   // terrain height, m MSL
varying float vMorph;
varying float vLevel;

float decodeH(uint v) { return float(v) * 0.05 - 500.0; }
float hCore(ivec2 p) { return decodeH(texelFetch(uHCore, clamp(p, ivec2(0), ivec2(4096)), 0).r); }
float hFar(ivec2 p) { return decodeH(texelFetch(uHFar, clamp(p, ivec2(0), ivec2(2048)), 0).r); }

// Height at a position in 25 m units: bilinear on the core grid (exact at samples), the far
// grid outside the core (same function as HeightField on the CPU).
float heightU(vec2 u) {
  // one return at the end: Direct3D's compiler (ANGLE on Windows) warns about an early return
  float h;
  vec2 c = u - 6144.0;
  if (c.x >= 0.0 && c.y >= 0.0 && c.x <= 4096.0 && c.y <= 4096.0) {
    vec2 i = min(floor(c), vec2(4095.0));
    vec2 f = c - i;
    ivec2 p = ivec2(i);
    float h00 = hCore(p), h10 = hCore(p + ivec2(1, 0));
    float h01 = hCore(p + ivec2(0, 1)), h11 = hCore(p + ivec2(1, 1));
    h = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  } else {
    vec2 g = u * 0.125;
    vec2 i = clamp(floor(g), vec2(0.0), vec2(2047.0));
    vec2 f = clamp(g - i, 0.0, 1.0);
    ivec2 p = ivec2(i);
    float h00 = hFar(p), h10 = hFar(p + ivec2(1, 0));
    float h01 = hFar(p + ivec2(0, 1)), h11 = hFar(p + ivec2(1, 1));
    h = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  }
  return h;
}

void main() {
  vec2 grid = position.xz;
  float stepU = aNode.z;
  float level = aNode.w;
  vec2 posU = aNode.xy + grid * stepU;                    // exact integers
  float h0 = heightU(posU);
  vec2 rel0 = (posU - uCamHiU) * 25.0 - uCamLo.xz;
  float d = length(vec3(rel0.x, h0 - uCamLo.y, rel0.y));
  float range = uRange0 * exp2(level);
  float morph = clamp((d - uMorphStart * range) / ((uMorphEnd - uMorphStart) * range), 0.0, 1.0);
  vec2 posUm = posU - mod(grid, 2.0) * stepU * morph;     // odd vertices slide onto even ones
  float h = heightU(posUm);
  vec2 relXZ = (posUm - uCamHiU) * 25.0 - uCamLo.xz;
  vec3 rel = vec3(relXZ.x, h - atmoCurvatureDrop(relXZ) - uCamLo.y, relXZ.y);

  vRel = rel;
  vWorldXZ = posUm * 25.0 - 204800.0;
  vH = h;
  vMorph = morph;
  vLevel = level;

  vec4 mvPosition = vec4(mat3(viewMatrix) * rel, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>

  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    vec4 worldPosition = vec4(rel + cameraPosition, 1.0);
    vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * worldPosition;
  #endif
}
`;

export const TERRAIN_FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
uniform bool receiveShadow;
${ATMOSPHERE_PARS}

varying vec3 vRel;
varying vec2 vWorldXZ;
varying float vH;
varying float vMorph;
varying float vLevel;

uniform sampler2D uOverview;          // core colour, 25 m / px
uniform sampler2D uFarColor;          // far colour, 200 m / px
uniform sampler2D uNormalCore;        // normal x / z per core sample
uniform sampler2D uNormalFar;
uniform highp usampler2D uLcOverview; // land cover codes, 25 m / px
uniform highp usampler2D uLcFar;      // 200 m / px
uniform sampler2D uDetail;
uniform sampler2D uWaterNormal;
uniform float uDetailStrength;
uniform float uAlbedoGain;
uniform float uDebugLod;
uniform float uDebugHeight;           // 1: output (height, x, z) of the rendered surface (tests)

#ifdef USE_L0
uniform sampler2D uL0Color;           // 1024 x 1024 for this tile, 6.25 m / px
uniform highp usampler2D uL0Lc;       // 640 x 640 codes, 10 m / px
uniform vec2 uL0Origin;               // tile NW corner (m)
uniform float uL0Fade;
uniform sampler2D uDigits;
uniform vec4 uRwyA[${MAX_RWY}];       // centre x, z, unit direction x, z (end 0 -> end 1)
uniform vec4 uRwyB[${MAX_RWY}];       // half length, half width, designator end 0, end 1
uniform vec4 uRwyC[${MAX_RWY}];       // overrun end 0, end 1, displaced threshold end 0, end 1
uniform int uRwyCount;
#endif

#ifdef NORMAL_UNORM
  #define DECODE_N(v) ((v) * 2.0 - 1.0)
#else
  #define DECODE_N(v) (v)
#endif

// land cover weights: w0 = (water, tree, natural vegetation, crop), w1 = (built-up, bare)
void lcAdd(uint c, float h, float k, inout vec4 w0, inout vec2 w1) {
  if (c == 80u || (c == 0u && abs(h) < 0.5)) w0.x += k;
  else if (c == 10u) w0.y += k;
  else if (c == 40u) w0.w += k;
  else if (c == 50u) w1.x += k;
  else if (c == 60u || c == 70u) w1.y += k;
  else w0.z += k;
}
// bilinear class weights from a code grid (pixel-is-area), uv in 0..1 over the grid
void lcSample(highp usampler2D tex, vec2 uv, float n, float h, out vec4 w0, out vec2 w1) {
  vec2 p = uv * n - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 ip = ivec2(i);
  ivec2 mx = ivec2(int(n) - 1);
  w0 = vec4(0.0); w1 = vec2(0.0);
  lcAdd(texelFetch(tex, clamp(ip, ivec2(0), mx), 0).r, h, (1.0 - f.x) * (1.0 - f.y), w0, w1);
  lcAdd(texelFetch(tex, clamp(ip + ivec2(1, 0), ivec2(0), mx), 0).r, h, f.x * (1.0 - f.y), w0, w1);
  lcAdd(texelFetch(tex, clamp(ip + ivec2(0, 1), ivec2(0), mx), 0).r, h, (1.0 - f.x) * f.y, w0, w1);
  lcAdd(texelFetch(tex, clamp(ip + ivec2(1, 1), ivec2(0), mx), 0).r, h, f.x * f.y, w0, w1);
}

float aaBand(float x, float a, float b, float px) {
  return clamp((x - a) / px + 0.5, 0.0, 1.0) * clamp((b - x) / px + 0.5, 0.0, 1.0);
}

#ifdef USE_L0
// glyph g (0..12) at local coords q in 0..1 (x right, y up)
float glyph(float g, vec2 q, vec2 dq) {
  if (g < 0.0 || q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
  vec2 uv = vec2((g + q.x) / 13.0, q.y);
  return textureGrad(uDigits, uv, vec2(dq.x / 13.0, dq.y), vec2(dq.x / 13.0, dq.y)).r;
}

// Runway paint (ICAO-like): returns albedo in .rgb, coverage of the paved area in .a.
// A = centre x, z, unit direction (end 0 -> end 1); B = half length, half width, designators;
// C = paved overrun beyond end 0 / end 1, displaced threshold at end 0 / end 1 (m).
vec4 runwayShade(vec2 xz, vec4 A, vec4 B, vec4 C, float px, float dn, float grain) {
  vec2 d = xz - A.xy;
  float s = dot(d, A.zw);
  float t = dot(d, vec2(-A.w, A.z));
  float hl = B.x, hw = B.y;
  bool end1 = s > 0.0;
  float ov = end1 ? C.y : C.x;
  float inside = clamp((hl + ov - abs(s)) / px + 0.5, 0.0, 1.0) * clamp((hw - abs(t)) / px + 0.5, 0.0, 1.0);
  if (inside <= 0.0) return vec4(0.0);
  float e = hl - abs(s);                 // distance from the nearer runway end (< 0: overrun)
  float ed = e - (end1 ? C.w : C.z);     // distance from that end's threshold
  float tt = end1 ? -t : t;              // + = right, seen by a pilot landing on that end
  float desig = end1 ? B.w : B.z;
  float pw = max(px, 0.05);
  float at = abs(t);
  float fadeSub = mix(1.0, 0.35, smoothstep(0.6, 3.0, px));   // markings below a pixel
  float rubber = aaBand(ed, 150.0, 900.0, 30.0) * smoothstep(14.0, 4.0, at) * (0.55 + 0.45 * dn);
  vec3 asphalt = vec3(0.115, 0.113, 0.11) * (1.0 + 0.3 * grain) * (1.0 - 0.5 * rubber);
  if (e < 0.0) {
    // blast pad / overrun: yellow chevrons, 30 m apart, pointing at the runway
    float u = -e - at;
    float chev = aaBand(mod(u, 30.0), 0.0, 1.4, pw) * step(4.0, -e) * fadeSub;
    vec3 pad = asphalt * 1.08;
    return vec4(mix(pad, vec3(0.52, 0.40, 0.06), chev), inside);
  }
  float paint = 0.0;
  // edge lines
  paint = max(paint, aaBand(at, hw - 1.5, hw - 0.6, pw));
  // displaced threshold: white bar across, arrows (dashes) along the centre before it
  if (ed < 0.0) {
    paint = max(paint, aaBand(t, -0.45, 0.45, pw) * aaBand(mod(e, 50.0), 10.0, 30.0, pw));
  }
  paint = max(paint, aaBand(ed, -1.8, 0.0, pw) * step(0.5, end1 ? C.w : C.z));
  // threshold stripes (6..36 m from the threshold), up to 6 on each side of the centre
  float q = (at - 1.9) / 3.2;
  float stripe = (q >= 0.0 && q < 6.0) ? aaBand(fract(q) * 3.2, 0.0, 1.6, pw) : 0.0;
  paint = max(paint, stripe * aaBand(ed, 6.0, 36.0, pw));
  // designation: digits 9 m tall (42..51 m), letter below them (42..51 m, digits 56..65 m)
  float num = mod(desig, 100.0), suf = floor(desig / 100.0);
  float tens = floor(num / 10.0), ones = mod(num, 10.0);
  float yNum = (ed - (suf > 0.0 ? 56.0 : 42.0)) / 9.0;
  vec2 dqd = vec2(pw / 4.0, pw / 9.0);
  paint = max(paint, glyph(tens, vec2((tt + 5.0) / 4.0, yNum), dqd));
  paint = max(paint, glyph(ones, vec2((tt - 1.0) / 4.0, yNum), dqd));
  if (suf > 0.0) paint = max(paint, glyph(9.0 + suf, vec2((tt + 2.0) / 4.0, (ed - 42.0) / 9.0), dqd));
  // centreline: 30 m dashes, 20 m gaps, from 75 m past the threshold
  float cl = aaBand(t, -0.45, 0.45, pw) * step(75.0, ed) * aaBand(mod(ed - 75.0, 50.0), 0.0, 30.0, pw);
  paint = max(paint, cl);
  // aiming point (400..450 m) and touchdown zone bars
  paint = max(paint, aaBand(ed, 400.0, 450.0, pw) * aaBand(at, 6.0, 15.0, pw));
  float tz = 0.0;
  for (int k = 1; k <= 6; k++) {
    float e0 = 150.0 * float(k);
    if (k == 3) continue;
    float bars = k <= 2 ? 3.0 : (k <= 5 ? 2.0 : 1.0);
    float inBar = aaBand(ed, e0, e0 + 22.5, pw);
    float qb = (at - 6.0) / 3.0;
    float lat = (qb >= 0.0 && qb < bars) ? aaBand(fract(qb) * 3.0, 0.0, 1.8, pw) : 0.0;
    tz = max(tz, inBar * lat);
  }
  paint = max(paint, tz) * fadeSub;
  return vec4(mix(asphalt, vec3(0.62), paint), inside);
}
#endif

void main() {
  #include <logdepthbuf_fragment>
  if (uDebugHeight > 0.5) { gl_FragColor = vec4(vH, vWorldXZ, 1.0); return; }
  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;                      // camera -> point
  vec2 xz = vWorldXZ;
  vec2 dX = dFdx(xz), dY = dFdy(xz);
  float px = max(length(dX), length(dY));    // metres per pixel
  float edge = max(abs(xz.x), abs(xz.y));
  float coreW = 1.0 - smoothstep(51200.0 - 4000.0, 51200.0, edge);   // core -> far imagery

  // ---- colour and land cover: far image, core overview, L0 tile near the camera ----
  vec2 uvFar = (xz + 204800.0) / 409600.0;
  vec2 uvCore = (xz + 51200.0) / 102400.0;
  vec3 col = texture(uFarColor, uvFar).rgb;
  vec3 colCore = texture(uOverview, uvCore).rgb;
  vec4 w0; vec2 w1;
  lcSample(uLcFar, uvFar, 2048.0, vH, w0, w1);
  if (coreW > 0.0) {
    vec4 c0; vec2 c1;
    lcSample(uLcOverview, uvCore, 4096.0, vH, c0, c1);
    w0 = mix(w0, c0, coreW); w1 = mix(w1, c1, coreW);
  }
  #ifdef USE_L0
    vec2 uvL0 = (xz - uL0Origin) / 6400.0;
    vec3 colL0 = texture(uL0Color, uvL0).rgb;
    float l0w = uL0Fade * (1.0 - smoothstep(9000.0, 14000.0, dist)) * coreW;
    colCore = mix(colCore, colL0, l0w);
    if (l0w > 0.0) {
      vec4 t0; vec2 t1;
      // jitter the land cover lookup by a few metres so class borders are not 10 m squares
      vec2 jit = (textureGrad(uDetail, xz / 61.0, dX / 61.0, dY / 61.0).rg - 0.5) * 8.0;
      lcSample(uL0Lc, (xz + jit - uL0Origin) / 6400.0, 640.0, vH, t0, t1);
      w0 = mix(w0, t0, l0w); w1 = mix(w1, t1, l0w);
    }
  #endif
  col = mix(col, colCore, coreW);

  // ---- normal (normal maps, tilted with the earth's curvature) ----
  vec2 nC = DECODE_N(texture(uNormalCore, ((xz + 51200.0) / 25.0 + 0.5) / 4097.0).rg);
  vec2 nF = DECODE_N(texture(uNormalFar, ((xz + 204800.0) / 200.0 + 0.5) / 2049.0).rg);
  vec2 nxz = mix(nF, nC, coreW);
  vec3 N = normalize(vec3(nxz.x, sqrt(max(1.0 - dot(nxz, nxz), 0.01)), nxz.y));
  vec3 upP = normalize(vec3(vRel.x / uEarthRadius, 1.0, vRel.z / uEarthRadius));

  // ---- runways (L0 tiles): asphalt and paint over the imagery, premultiplied ----
  vec3 rwPre = vec3(0.0);
  float rwCov = 0.0;
  #ifdef USE_L0
    if (uRwyCount > 0 && l0w > 0.0) {
      float dn = textureGrad(uDetail, xz / 37.0, dX / 37.0, dY / 37.0).g;
      float grain = textureGrad(uDetail, xz / 9.0, dX / 9.0, dY / 9.0).b - 0.5;
      for (int i = 0; i < ${MAX_RWY}; i++) {
        if (i >= uRwyCount) break;
        vec4 rw = runwayShade(xz, uRwyA[i], uRwyB[i], uRwyC[i], px, dn, grain);
        rwPre = rwPre * (1.0 - rw.a) + rw.rgb * rw.a;
        rwCov = rwCov + rw.a - rwCov * rw.a;
      }
      float k = l0w * smoothstep(9000.0, 5000.0, dist);
      rwPre *= k;
      rwCov *= k;
      w0.x *= 1.0 - rwCov;
    }
  #endif

  // ---- procedural detail by land cover (mean-free), fading out with distance ----
  vec4 dMean = textureLod(uDetail, vec2(0.5), 16.0);   // 1 x 1 mip = channel means
  vec4 d1 = texture(uDetail, xz / ${DETAIL_TILE_M.toFixed(1)});
  vec2 xr = vec2(xz.x * 0.8 - xz.y * 0.6, xz.x * 0.6 + xz.y * 0.8);
  vec4 d2 = texture(uDetail, xr / 71.0);
  vec4 dd = d1 * 0.62 + d2 * 0.38 - dMean;
  float land = (1.0 - w0.x) * (1.0 - rwCov);
  float detail = w0.y * dd.g * 0.9 + w0.z * dd.r * 0.7 + w0.w * dd.r * 0.55 + w1.x * dd.a * 0.6 + w1.y * dd.b * 0.75;
  float near = 1.0 - smoothstep(500.0, 4000.0, dist);
  // a finer layer close to the ground (takeoff, landing, taxiing)
  float near2 = 1.0 - smoothstep(150.0, 900.0, dist);
  if (near2 > 0.0) {
    mat2 rot = mat2(0.6, 0.8, -0.8, 0.6);
    vec4 d3 = textureGrad(uDetail, rot * xz / 17.0, rot * dX / 17.0, rot * dY / 17.0) - dMean;
    detail += near2 * (0.45 * d3.r * (w0.z + w0.w + w0.y) + 0.5 * d3.b * w1.y + 0.35 * d3.a * w1.x);
  }
  col *= 1.0 + detail * near * uDetailStrength * land;
  // bump from the detail pattern (screen-space derivatives), stronger for rock and trees
  float bumpH = (w0.y * dd.g * 0.6 + w1.y * dd.b * 0.8 + (w0.z + w0.w) * dd.r * 0.15) * near * land;
  {
    vec3 sX = dFdx(vRel), sY = dFdy(vRel);
    float hX = dFdx(bumpH), hY = dFdy(bumpH);
    vec3 r1 = cross(sY, N), r2 = cross(N, sX);
    float det = dot(sX, r1);
    vec3 grad = sign(det) * (hX * r1 + hY * r2);
    N = normalize(abs(det) * N - grad * 0.9);
  }
  N = normalize(N + upP - vec3(0.0, 1.0, 0.0));

  // ---- light ----
  vec3 sunE = atmoSunIrradianceAt(vRel, vH);
  float shadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    if (receiveShadow) {
      DirectionalLightShadow sh = directionalLightShadows[ 0 ];
      shadow = getShadow( directionalShadowMap[ 0 ], sh.shadowMapSize, sh.shadowIntensity, sh.shadowBias, sh.shadowRadius, vDirectionalShadowCoord[ 0 ] );
    }
  #endif
  vec3 albedo = col * uAlbedoGain * (1.0 - rwCov) + rwPre;

  float NdL = max(dot(N, uSunDir), 0.0);
  vec3 skyE = uAmbient * (0.55 + 0.45 * dot(N, upP));
  vec3 radiance = albedo * (sunE * NdL * shadow + skyE) / PI;

  // ---- water ----
  float water = smoothstep(0.3, 0.7, w0.x);
  if (water > 0.0) {
    float t = uTime;
    vec2 uA = xz / 83.0 + t * vec2(0.010, 0.006);
    vec2 uB = xz / 21.0 + t * vec2(-0.019, 0.013);
    vec2 uC = xz / 347.0 + t * vec2(0.0031, -0.0022);
    vec2 sA = textureGrad(uWaterNormal, uA, dX / 83.0, dY / 83.0).rg * 2.0 - 1.0;
    vec2 sB = textureGrad(uWaterNormal, uB, dX / 21.0, dY / 21.0).rg * 2.0 - 1.0;
    vec2 sC = textureGrad(uWaterNormal, uC, dX / 347.0, dY / 347.0).rg * 2.0 - 1.0;
    vec2 slope = sA * 0.5 + sB * 0.3 + sC * 0.7;
    vec3 Nw = normalize(vec3(-slope.x, 1.0, -slope.y) + upP - vec3(0.0, 1.0, 0.0));
    vec3 R = reflect(V, Nw);
    R.y = abs(R.y);
    vec3 skyR = atmoSkyRadiance(normalize(R));
    float cosI = clamp(dot(-V, Nw), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);
    // sun glint (GGX); roughness grows where the wave texture is filtered away
    float a = mix(0.07, 0.22, smoothstep(300.0, 25000.0, dist));
    float a2 = a * a;
    vec3 Hh = normalize(uSunDir - V);
    float NdH = max(dot(Nw, Hh), 0.0);
    float Dg = a2 / (PI * pow(NdH * NdH * (a2 - 1.0) + 1.0, 2.0));
    float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(Hh, uSunDir), 0.0), 5.0);
    vec3 spec = sunE * Fs * Dg * 0.25 * shadow * step(0.0, dot(Nw, uSunDir));
    // body colour: the satellite colour of the water (dark offshore, lighter in the shallows)
    vec3 body = albedo * 0.8 * (sunE * max(dot(upP, uSunDir), 0.0) + uAmbient) / PI;
    vec3 wr = body * (1.0 - F) + skyR * F + spec;
    radiance = mix(radiance, wr, water);
  }

  // ---- aerial perspective, and the far edge dissolving into the sky's own haze ----
  vec3 color = atmoAerial(radiance, V, dist, vH);
  float farFade = smoothstep(204800.0 - 30000.0, 204800.0 - 800.0, edge);
  if (farFade > 0.0) {
    vec2 suv = atmoSkyViewUv(V);
    vec3 beyond = uSunIlluminance * texture(uSkyViewLUT, suv).rgb + texture(uSkyViewTLUT, suv).rgb * uGroundRadiance;
    color = mix(color, beyond, farFade);
  }

  if (uDebugLod > 0.5) {
    vec3 lc = 0.5 + 0.5 * cos(6.2831 * (vLevel / 9.0 + vec3(0.0, 0.33, 0.67)));
    color = mix(color, lc * (0.03 + 0.2 * (1.0 - 0.6 * vMorph)), 0.6);
  }

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
