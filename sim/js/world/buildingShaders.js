// Building shaders (three.js ShaderMaterial, GLSL ES 3.0), used by js/world/Buildings.js.
//
// Two vertex shaders feed one fragment shader:
//   BOX_VERT   far buildings: one instance per building (InstancedBufferGeometry, 10-vertex box
//              with a ridge), oriented and sized from per-instance data; flat / gabled / hipped /
//              pyramidal roofs; buildings of chunks drawn in full detail are masked out (uMask);
//              each building grows out of the ground near its visibility distance (no popping)
//              and its walls reach down further far away (the coarser terrain LODs).
//   CHUNK_VERT near buildings: full geometry built by BuildingsWorker.js (walls along the real
//              footprint, parapets, roof houses, pitched roofs, domes, vaults).
// Both bend with the earth's curvature like the terrain (d^2 / 2R) so the buildings stand on it.
//
// The fragment shader draws procedural facades: windows on a grid of floors and bays per wall
// style (filtered: a box-filtered pulse train, so far facades turn into their mean colour
// instead of shimmering), shop fronts, open ground floors on columns, balconies, closed
// shutters, stone courses, corrugated metal, curtain walls with Fresnel sky reflection and a
// sun glint, roof tiles, metal seams, solar panels; at night lit windows (per window, blended
// into the mean lit fraction where windows get smaller than a pixel) and street light on the
// lower walls. Light and haze are the terrain's (atmoSunIrradianceAt, uAmbient, ground bounce,
// atmoAerial), so a building and the ground under it fade alike.

import { ATMOSPHERE_PARS, ATMOSPHERE_CORE } from '../env/atmosphereGLSL.js';

// wall styles, roof styles, roof shapes, surface kinds: sim/tools/world/buildings.py, BuildingsWorker.js
export const WALL = { plaster: 0, stone: 1, glass: 2, office: 3, industrial: 4, house: 5, greenhouse: 6, concrete: 7, public: 8, tower: 9, oldstone: 10 };
export const ROOF = { flat_res: 0, flat: 1, industrial: 2, tiles: 3, metal: 4, greenhouse: 5, dome: 6, concrete: 7, solar: 8 };

const SRGB = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;

// the end of both vertex shaders: p in object space (the mesh's matrix is a pure translation)
const EMIT = /* glsl */ `
void emit(vec3 p, vec3 n) {
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec3 rel = wp.xyz - uCameraPos;                 // uCameraPos: the view camera, also in the shadow pass
  float drop = atmoCurvatureDrop(rel.xz);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);       // exact (the offset to the camera is done in double)
  mv.xyz -= drop * viewMatrix[1].xyz;             // mat3(viewMatrix) * (0, drop, 0)
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  #ifndef DEPTH_PASS
    vRel = rel - vec3(0.0, drop, 0.0);
    vH = wp.y;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vec4 swp = vec4(wp.xyz + n * directionalLightShadows[ 0 ].shadowNormalBias, 1.0);
      vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * swp;
    #endif
  #endif
}
`;

const VERT_HEAD = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#ifndef DEPTH_PASS
  #include <shadowmap_pars_vertex>
  varying vec3 vRel;
  varying float vH;
  varying vec4 vInf;          // floor height (m), bay (m), seed, floors
#endif
${ATMOSPHERE_CORE}
${SRGB}
`;

export const BOX_VERT = /* glsl */ `
${VERT_HEAD}
attribute vec4 iA;            // x, z (tile-local), yaw, half length
attribute vec4 iB;            // half width, wall bottom, floor-0 level, apex (m MSL)
attribute vec4 iC;            // rise, shape, chunk, visibility size (m)
attribute vec4 iWall;         // rgb (sRGB), style / 255
attribute vec4 iRoof;         // rgb (sRGB), roof style / 255
attribute vec4 iInfo;         // floor height (0.05 m), bay (0.05 m), seed, floors
uniform uvec2 uMask;          // chunks of this tile drawn in full detail (bit per chunk)
uniform vec3 uVis;            // visibility distance per metre of size, growth band (fraction), extra wall depth per m
#ifndef DEPTH_PASS
  varying vec4 vWall;
  varying vec4 vRoof;
  varying vec3 vLoc;          // along a, above floor 0, along b (m)
  varying vec4 vDim;          // half length, half width, cos yaw, sin yaw
#endif
${EMIT}

void main() {
  float ha = iA.w, hb = iB.x, bottom = iB.y, g0 = iB.z, top = iB.w;
  float rise = iC.x, shape = iC.y, vsize = iC.w;
  uint chunk = uint(iC.z + 0.5);
  uint bits = chunk < 32u ? uMask.x : uMask.y;
  bool hidden = ((bits >> (chunk & 31u)) & 1u) != 0u;
  // distance from the view camera to the building's middle
  vec3 mid = (modelMatrix * vec4(iA.x, 0.5 * (g0 + top), iA.y, 1.0)).xyz - uCameraPos;
  float d = length(mid);
  float rv = vsize * uVis.x;
  float grow = clamp((rv - d) / (uVis.y * rv), 0.0, 1.0);
  grow = grow * grow * (3.0 - 2.0 * grow);
  // shape: 0 flat (the two "slopes" are the flat roof), 1 gabled, 2 hipped, 3 pyramidal
  float rl = shape < 1.5 ? ha : (shape < 2.5 ? max(ha - hb, 0.0) : 0.0);
  float eave = top - rise;
  float sa = position.x, level = position.y, sb = position.z;
  // walls standing on the ground reach further down far away, where the terrain is coarser
  float yb = bottom - (bottom <= g0 + 0.01 ? uVis.z * max(d - 3500.0, 0.0) : 0.0);
  float y = level < 0.5 ? yb : bottom + ((level < 1.5 ? eave : top) - bottom) * grow;
  float pa = sa * (level > 1.5 ? rl : ha);
  float pb = sb * hb;
  float c = cos(iA.z), s = sin(iA.z);
  vec3 A = vec3(c, 0.0, s), B = vec3(-s, 0.0, c);
  vec3 p = vec3(iA.x, y, iA.y) + A * pa + B * pb;
  #ifndef DEPTH_PASS
    vWall = vec4(srgbToLinear(iWall.rgb), floor(iWall.a * 255.0 + 0.5));
    vRoof = vec4(srgbToLinear(iRoof.rgb), floor(iRoof.a * 255.0 + 0.5));
    vInf = vec4(iInfo.x * 0.05, iInfo.y * 0.05, iInfo.z, iInfo.w);
    vLoc = vec3(pa, y - g0, pb);
    vDim = vec4(ha, hb, c, s);
  #endif
  emit(p, normalize(A * sa + B * sb + vec3(0.0, level, 0.0)));
  // masked or beyond its distance: every vertex on one point outside the view (nothing drawn)
  if (hidden || grow <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const CHUNK_VERT = /* glsl */ `
${VERT_HEAD}
attribute vec4 aNrm;          // normal (xyz) and surface kind (w * 127): 0 wall, 1 roof, 2 parapet, 3 plain
attribute vec2 aFac;          // facade / roof coordinates (dm)
attribute vec4 aCol;          // rgb (sRGB), style / 255
attribute vec4 aInf;          // floor height (0.05 m), bay (0.05 m), seed, floors
#ifndef DEPTH_PASS
  varying vec3 vN;
  varying vec2 vFac;
  varying vec4 vCol;
  varying float vKind;
#endif
${EMIT}

uniform vec3 uVis;            // .z: extra wall depth per metre beyond 3.5 km (as the boxes)

void main() {
  vec3 n = normalize(aNrm.xyz);
  vec3 p = position;
  // wall bottoms (below floor 0) reach further down far away, where the terrain is coarser
  if (aFac.y < 0.0 && aNrm.w < 0.5 / 127.0) {          // walls only (roof coordinates go negative too)
    float d = length((modelMatrix * vec4(p, 1.0)).xyz - uCameraPos);
    p.y -= uVis.z * max(d - 3500.0, 0.0);
  }
  #ifndef DEPTH_PASS
    vN = n;
    vFac = aFac * 0.1;
    vCol = vec4(srgbToLinear(aCol.rgb), floor(aCol.a * 255.0 + 0.5));
    vInf = vec4(aInf.x * 0.05, aInf.y * 0.05, aInf.z, aInf.w);
    vKind = aNrm.w * 127.0;
  #endif
  emit(p, n);
}
`;

/** Shadow pass: depth only (the shadow map is a depth texture). */
export const DEPTH_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(1.0);
}
`;

export const BUILDING_FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
uniform bool receiveShadow;
${ATMOSPHERE_PARS}

uniform vec4 uLight;          // lit window fraction, window radiance, street light irradiance, lit share of shops
uniform vec3 uAlbedo;         // wall albedo gain, roof albedo gain (the terrain's), detail on (1) / off (0)
uniform float uDebug;         // 1: colour by level of detail

varying vec3 vRel;
varying float vH;
varying vec4 vInf;
#ifdef BOX
  varying vec4 vWall;
  varying vec4 vRoof;
  varying vec3 vLoc;
  varying vec4 vDim;
#else
  varying vec3 vN;
  varying vec2 vFac;
  varying vec4 vCol;
  varying float vKind;
#endif

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float hash12(vec2 p) { return hash13(vec3(p, 17.31)); }

// Box-filtered pulse train: share of [x - w/2, x + w/2] covered by the pulses [a, b] (0 <= a < b <= 1)
// that repeat with period 1. Exact, so a far facade gets exactly its mean window share.
float pulseI(float x, float a, float b) { return floor(x) * (b - a) + clamp(fract(x), a, b) - a; }
float pulse(float x, float w, float a, float b) {
  w = max(w, 1e-4);
  return (pulseI(x + 0.5 * w, a, b) - pulseI(x - 0.5 * w, a, b)) / w;
}
// one band [a, b] with an edge as wide as a pixel (w)
float band(float x, float a, float b, float w) {
  w = max(w, 1e-4);
  return clamp((x - a) / w + 0.5, 0.0, 1.0) * clamp((b - x) / w + 0.5, 0.0, 1.0);
}

// smooth value noise (for stains); far away it is faded out by the caller
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 1 while 2 m cells are several pixels wide, 0 once they shrink below a pixel (then means are used)
float detail0(vec2 fw) { return 1.0 - smoothstep(0.6, 1.6, max(fw.x, fw.y)); }

// sky (above the horizon) and the ground (below) in direction R; in a town the ground a window
// reflects is mostly other sunlit walls and roofs, brighter than the mean ground
vec3 envRadiance(vec3 R) {
  vec3 sky = atmoSkyRadiance(normalize(vec3(R.x, max(R.y, 0.01), R.z)));
  return mix(sky, uGroundRadiance * 2.2, smoothstep(0.0, -0.3, R.y));
}

// GGX sun highlight (times F and the sun's irradiance)
float sunSpec(vec3 N, vec3 V, float a) {
  vec3 L = uSunDir;
  vec3 H = normalize(L - V);
  float NdL = max(dot(N, L), 0.0), NdV = max(dot(N, -V), 1e-3), NdH = max(dot(N, H), 0.0);
  float a2 = a * a;
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = 0.5 * a;
  float G = 1.0 / ((NdL * (1.0 - k) + k) * (NdV * (1.0 - k) + k));
  return D * G * 0.25 * NdL;
}

// window layout of a wall style in a bay x floor cell: (x0, x1, y0, y1) as fractions
vec4 windowLayout(float st, float r) {
  vec4 L = vec4(0.5 - 0.22 - 0.08 * r, 0.5 + 0.22 + 0.08 * r, 0.30, 0.80);       // plaster blocks
  if (st == 1.0) L = vec4(0.5 - 0.17 - 0.06 * r, 0.5 + 0.17 + 0.06 * r, 0.30, 0.80);   // stone
  else if (st == 2.0) L = vec4(0.035, 0.965, 0.0, 1.0);                         // curtain wall (glass to the slab)
  else if (st == 9.0) L = vec4(0.5 - 0.28 - 0.08 * r, 0.5 + 0.28 + 0.08 * r, 0.22, 0.86);   // towers
  else if (st == 3.0) L = vec4(0.03, 0.97, 0.36, 0.92);                           // office ribbons
  else if (st == 4.0) L = vec4(0.5 - 0.30, 0.5 + 0.30, 0.66, 0.84);              // industrial clerestory
  else if (st == 5.0) L = vec4(0.5 - 0.16 - 0.05 * r, 0.5 + 0.16 + 0.05 * r, 0.30, 0.78);   // house
  else if (st == 8.0) L = vec4(0.5 - 0.30 - 0.06 * r, 0.5 + 0.30 + 0.06 * r, 0.24, 0.86);   // public
  else if (st == 10.0) L = vec4(0.5 - 0.11, 0.5 + 0.11, 0.34, 0.76);             // old stone
  return L;
}

void main() {
  #include <logdepthbuf_fragment>
  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;                                     // camera -> point
  float fh = max(vInf.x, 2.0), bay = max(vInf.y, 1.0), seed = vInf.z, floors = floor(vInf.w + 0.5);

  // ---- surface: normal, kind, facade coordinates, colour, style ----
  vec3 N;
  vec2 fac;
  float kind, sty;
  vec3 col;
  #ifdef BOX
    N = normalize(cross(dFdx(vRel), dFdy(vRel)));            // the faces are flat
    N = dot(N, V) > 0.0 ? -N : N;
    vec3 Ax = vec3(vDim.z, 0.0, vDim.w), Bx = vec3(-vDim.w, 0.0, vDim.z);
    bool roofFace = N.y > 0.3;
    bool alongB = abs(dot(N, Ax)) > abs(dot(N, Bx));          // a wall at +-a runs along b
    float L = alongB ? 2.0 * vDim.y : 2.0 * vDim.x;
    float s = alongB ? vLoc.z + vDim.y : vLoc.x + vDim.x;
    float nb = floor(L / bay + 0.5);
    vec2 wallFac = vec2(nb >= 1.0 ? s * nb * bay / L : 0.0, vLoc.y);
    fac = roofFace ? vLoc.xz : wallFac;
    kind = roofFace ? 1.0 : 0.0;
    col = roofFace ? vRoof.rgb : vWall.rgb;
    sty = roofFace ? vRoof.a : vWall.a;
  #else
    N = normalize(vN);
    fac = vFac;
    kind = floor(vKind + 0.5);
    col = vCol.rgb;
    sty = vCol.a;
  #endif
  vec2 fw = fwidth(fac);                                    // metres per pixel along u / v
  float near = uAlbedo.z * (1.0 - smoothstep(0.08, 0.5, max(fw.x, fw.y)));   // fine detail (< 0.5 m)

  // ---- light ----
  vec3 sunE = atmoSunIrradianceAt(vRel, vH);
  float shadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    if (receiveShadow) {
      DirectionalLightShadow sh = directionalLightShadows[ 0 ];
      shadow = getShadow( directionalShadowMap[ 0 ], sh.shadowMapSize, sh.shadowIntensity, sh.shadowBias, sh.shadowRadius, vDirectionalShadowCoord[ 0 ] );
    }
  #endif
  float NdL = max(dot(N, uSunDir), 0.0);
  vec3 skyE = uAmbient * (0.55 + 0.45 * N.y);
  vec3 gndE = PI * uGroundRadiance * (0.5 - 0.5 * N.y);     // light bounced off the ground

  vec3 radiance;
  if (kind > 0.5 && kind < 1.5) {
    // ================================================================= roofs
    float rs = sty;
    vec3 alb = col * uAlbedo.y;
    float spec = 0.0, rough = 0.5;
    vec2 fwr = fw;
    if (rs == 3.0) {
      // clay tiles: courses parallel to the ridge, tiles across them, each a little different
      float rows = pulse(fac.y / 0.34, fwr.y / 0.34 * 1.3, 0.0, 0.18);
      float cols = pulse(fac.x / 0.24, fwr.x / 0.24 * 1.3, 0.0, 0.12);
      float tv = hash12(floor(vec2(fac.x / 0.24 + 0.5 * floor(fac.y / 0.34), fac.y / 0.34)) + seed);
      alb *= 1.0 - 0.28 * rows - 0.12 * cols + near * 0.16 * (tv - 0.5) + 0.05;
      rough = 0.6;
    } else if (rs == 4.0 || rs == 2.0) {
      // metal: standing seams along the slope, a broad sheen
      float seams = pulse(fac.x / 0.6, fwr.x / 0.6 * 1.3, 0.0, 0.08);
      alb *= 1.0 - 0.18 * seams;
      spec = rs == 4.0 ? 0.35 : 0.15;
      rough = 0.35;
    } else if (rs == 5.0) {
      // greenhouse plastic: white, translucent, with ribs
      float ribs = pulse(fac.x / 3.0, fwr.x / 3.0 * 1.3, 0.0, 0.05) + pulse(fac.y / 1.2, fwr.y / 1.2 * 1.3, 0.0, 0.04);
      alb = mix(alb, vec3(0.62, 0.64, 0.62), 0.5) * (1.0 - 0.2 * ribs);
      spec = 0.25;
      rough = 0.25;
    } else if (rs == 8.0) {
      // solar panels in rows (dark glass) on a pale roof
      float panel = pulse(fac.y / 3.2, fwr.y / 3.2 * 1.3, 0.1, 0.72) * pulse(fac.x / 1.1, fwr.x / 1.1 * 1.3, 0.03, 0.97);
      alb = mix(alb * 1.1, vec3(0.025, 0.035, 0.06), panel);
      spec = 0.6 * panel;
      rough = 0.12;
    } else if (rs == 6.0) {
      spec = 0.45;                                           // domes (metal or glazed)
      rough = 0.3;
    } else {
      // flat roofs: stains, and near the camera small boxes (water tanks, air conditioners)
      float st = vnoise(fac / 3.7 + seed) - 0.5;
      float box = step(0.95, hash12(floor(fac / 2.5) + seed * 3.1)) * near;
      alb *= 1.0 + 0.16 * st * (1.0 - smoothstep(0.6, 2.5, max(fw.x, fw.y))) - 0.18 * box;
      if (rs == 0.0) {
        // solar water heaters (on nearly every Israeli home): collectors of dark glass with a white
        // tank behind each, in a block near the middle of the roof; one or two on a house
        vec2 cs = vec2(2.3, 2.0);
        vec2 zone = floors < 2.5 ? vec2(1.15, 1.0) * (1.0 + step(0.5, hash12(vec2(seed, 3.0)))) : vec2(4.6, 3.0);
        vec2 q = fac / cs + 0.5;
        float inZone = band(fac.x, -zone.x, zone.x, fw.x) * band(fac.y, -zone.y, zone.y, fw.y);
        float here = mix(0.7, step(hash12(floor(q) + seed * 1.37), 0.7), detail0(fw));
        vec2 qw = fw / cs * 1.3;
        float col_ = pulse(q.x, qw.x, 0.06, 0.94) * pulse(q.y, qw.y, 0.08, 0.50) * inZone * here;
        float tank = pulse(q.x, qw.x, 0.10, 0.90) * pulse(q.y, qw.y, 0.58, 0.80) * inZone * here;
        alb = mix(alb, vec3(0.035, 0.045, 0.065), col_);
        alb = mix(alb, vec3(0.62, 0.62, 0.60), tank);
        spec = 0.5 * col_;
        rough = 0.15;
      }
    }
    vec3 E = sunE * NdL * shadow + skyE;
    radiance = alb * E / PI;
    if (spec > 0.0) {
      vec3 R = reflect(V, N);
      float a = mix(rough, 0.6, smoothstep(0.2, 3.0, max(fw.x, fw.y)));
      float F = 0.04 + 0.96 * pow(1.0 - max(dot(N, -V), 0.0), 5.0);
      radiance += spec * (F * envRadiance(R) + sunE * shadow * F * sunSpec(N, V, a));
    }
  } else {
    // ================================================================= walls
    float st = mod(sty, 16.0);
    float flags = floor(sty / 16.0);
    bool pilotis = mod(flags, 2.0) > 0.5, shops = mod(floor(flags / 2.0), 2.0) > 0.5, balcony = mod(floor(flags / 4.0), 2.0) > 0.5;
    bool plainWall = kind > 1.5;                              // parapet inner faces, roof houses
    vec2 g = fac / vec2(bay, fh);                             // in bays, floors
    vec2 gw = fw / vec2(bay, fh) * 1.25;                      // filter width in cells
    vec2 cell = floor(g);
    // per-window variety (shutters, curtains, lit rooms) only while a window is several pixels
    // big: smaller, it reads as noise and shimmers in motion, so the means take over
    float detail = 1.0 - smoothstep(0.14, 0.42, max(gw.x, gw.y));
    float face = floor(atan(N.z, N.x) * 1.27 + 4.5);         // which wall (8 directions)
    float rnd = hash12(vec2(seed, 7.0));
    bool curtain = st == 2.0;
    bool resid = st == 0.0 || st == 1.0 || st == 5.0 || st == 10.0;
    float v = fac.y;
    float top = floors * fh;

    // wall material
    vec3 wallAlb = col * uAlbedo.x;
    if (curtain) wallAlb = mix(vec3(0.45, 0.46, 0.47), wallAlb, 0.5);    // aluminium frames
    float far = 1.0 - smoothstep(0.6, 2.5, max(fw.x, fw.y));
    if (st == 1.0 || st == 10.0) {
      // stone: courses 0.35 m, blocks with their own tone
      float course = floor(v / 0.35);
      float blk = hash12(vec2(floor(fac.x / 0.75 + 0.5 * mod(course, 2.0)), course) + seed);
      float joint = pulse(v / 0.35, fw.y / 0.35 * 1.3, 0.0, 0.06) + pulse(fac.x / 0.75 + 0.5 * mod(course, 2.0), fw.x / 0.75 * 1.3, 0.0, 0.03);
      wallAlb *= 1.0 + near * (0.14 * (blk - 0.5)) - 0.15 * joint;
    } else if (st == 4.0) {
      // corrugated metal
      wallAlb *= 1.0 - 0.14 * pulse(fac.x / 0.2, fw.x / 0.2 * 1.3, 0.0, 0.5) + 0.07;
    } else if (st == 7.0) {
      // concrete: formwork panels
      wallAlb *= 1.0 - 0.12 * (pulse(v / 1.2, fw.y / 1.2 * 1.3, 0.0, 0.03) + pulse(fac.x / 2.4, fw.x / 2.4 * 1.3, 0.0, 0.015));
    } else if (st == 6.0) {
      wallAlb = mix(wallAlb, vec3(0.6, 0.62, 0.6), 0.5) * (1.0 - 0.2 * pulse(fac.x / 3.0, fw.x / 3.0 * 1.3, 0.0, 0.05));
    }
    // stains and streaks, floor slabs
    wallAlb *= 1.0 + far * 0.10 * (vnoise(vec2(fac.x / 2.3, v / 9.0) + seed) - 0.5);
    if (!curtain && st != 4.0 && st != 6.0) wallAlb *= 1.0 - 0.07 * pulse(g.y, gw.y, 0.0, min(0.3 / fh, 0.2)) * step(1.5, floors);

    // ---- windows ----
    vec4 Lw = windowLayout(st, rnd);
    float hasWin = (plainWall || st == 6.0 || (st == 7.0 && floors < 1.5)) ? 0.0 : 1.0;   // no windows: sheds, greenhouses
    float upper = band(v, shops || pilotis ? fh : 0.0, top, fw.y) * hasWin;
    float ground = (shops || pilotis) ? band(v, 0.0, fh, fw.y) * hasWin : 0.0;
    float cov = pulse(g.x, gw.x, Lw.x, Lw.y) * pulse(g.y, gw.y, Lw.z, Lw.w);
    // balconies (stacks of recessed bays over each other): a solid parapet, the recess in shade
    // above it and a glass door at its back
    float balc = 0.0;
    if (balcony && !curtain) {
      float pB = 0.42;
      float isB = mix(pB, step(hash12(vec2(cell.x, seed + face * 13.0)), pB), detail);
      float covR = pulse(g.x, gw.x, 0.08, 0.92) * pulse(g.y, gw.y, 0.36, 0.96);
      float covD = pulse(g.x, gw.x, 0.20, 0.80) * pulse(g.y, gw.y, 0.36, 0.90);
      balc = isB * max(covR - covD, 0.0) * upper;
      cov = mix(cov, covD, isB);
    }
    float shopCov = (shops && !pilotis) ? pulse(g.x, gw.x, 0.05, 0.95) * pulse(g.y, gw.y, 0.06, 0.84) : 0.0;
    float pilo = pilotis ? (1.0 - pulse(g.x + 0.07, gw.x, 0.0, 0.14)) * ground : 0.0;   // void between columns
    float win = cov * upper + shopCov * ground;
    // per window: closed shutter, curtains, lit at night (pairs of windows = one flat)
    float h1 = hash13(vec3(cell.x, cell.y, seed + face * 31.0));
    float h2 = hash13(vec3(floor(cell.x / 2.0), cell.y, seed * 1.7 + face * 7.0));
    float h3 = hash13(vec3(cell.x * 1.3, cell.y * 0.7, seed + 91.0));
    float pShut = resid ? 0.28 : 0.0;
    float shut = mix(pShut, step(h1, pShut), detail);
    bool groundCell = v < fh;
    // some buildings and floors are busier than others: kept at the scale of buildings and floors,
    // which stay visible further than single windows, so a far city is not one even glow
    float busy = (0.2 + 1.6 * hash12(vec2(seed, 41.0 + face))) * mix(1.0, 0.35 + 1.3 * hash12(vec2(cell.y, seed + 5.0)), 1.0 - smoothstep(0.35, 0.9, gw.y));
    float litP = (shops && groundCell) ? uLight.w : min(uLight.x * busy, 1.0);
    float lit = mix(litP, step(h2, litP), detail);
    float curtainIn = mix(0.3, step(h3, 0.3), detail);
    // warm homes (2700-3000 K), whiter offices and shops
    vec3 tint = mix(vec3(1.0, 0.58, 0.26), vec3(1.0, 0.74, 0.44), mix(0.5, h3, detail));
    tint = mix(tint, vec3(0.86, 0.90, 1.0), resid ? 0.12 : 0.5);
    float glassW = win * (1.0 - shut * (groundCell && shops ? 0.0 : 1.0));
    float shutW = win - glassW;

    // ---- shading ----
    float ao = 0.62 + 0.38 * smoothstep(-0.5, 9.0, v);       // street canyons: less sky near the ground
    vec3 E = sunE * NdL * shadow + (skyE + gndE) * ao;
    // street lights (sodium and LED) on the lowest floors
    vec3 street = uLight.z * vec3(1.0, 0.66, 0.36) * exp(-max(v, 0.0) / 3.5) * step(N.y, 0.5);
    vec3 Ediff = E + street;
    // recesses (balconies, open ground floors) see little sun and sky
    vec3 Erec = (sunE * NdL * shadow * 0.25 + (skyE + gndE) * 0.45) * ao + street;
    vec3 wallR = wallAlb * Ediff / PI;
    vec3 shutR = mix(wallAlb, vec3(0.55, 0.53, 0.5), 0.6) * Ediff / PI * (1.0 - 0.15 * near * pulse(fac.y / 0.09, fw.y / 0.09 * 1.3, 0.0, 0.3));
    // glass: Fresnel reflection of the sky / ground, the sun, and the room behind it
    vec3 Ng = N;
    if (detail > 0.0) Ng = normalize(N + detail * 0.035 * (vec3(h1, h3, h2) - 0.5));
    float cosI = max(dot(Ng, -V), 0.0);
    float F0 = curtain ? 0.16 + 0.16 * rnd : (st == 3.0 || st == 9.0 ? 0.08 : 0.05);   // coated glass on towers
    float F = F0 + (1.0 - F0) * pow(1.0 - cosI, 5.0);
    float a = mix(curtain ? 0.05 : 0.08, 0.35, smoothstep(0.15, 1.5, max(gw.x, gw.y)));
    vec3 R = reflect(V, Ng);
    vec3 glassTint = curtain ? mix(vec3(1.0), normalize(col + 0.05) * 1.6, 0.45) : vec3(1.0);
    vec3 refl = glassTint * (envRadiance(R) + sunE * shadow * sunSpec(Ng, V, a));
    // the room behind: daylight from this window and others, ceilings, curtains
    float roomAlb = mix(0.12, 0.28, curtainIn) * (curtain ? 0.6 : 1.0);
    vec3 room = vec3(roomAlb) * (uAmbient * 0.45 + gndE * 0.5 + sunE * (NdL * shadow * 0.3 + 0.03)) / PI;
    float spandrel = curtain ? 1.0 - pulse(g.y, gw.y, 0.0, 0.84) : 0.0;   // opaque glass at the slabs
    vec3 emit = uLight.y * tint * lit * (1.0 - spandrel) * ((shops && groundCell) ? 1.8 : 1.0) * mix(1.0, 0.6 + 0.8 * h3, detail);
    vec3 glassR = F * refl + (1.0 - F) * (room * (1.0 - spandrel) + emit);
    // the parts
    vec3 recR = wallAlb * 0.35 * Erec / PI;
    float wallW = max(1.0 - win - balc - pilo, 0.0);
    shutR += uLight.y * tint * lit * 0.06;                     // light through the slats
    radiance = wallR * wallW + shutR * shutW + glassR * glassW + recR * (balc + pilo);
    // the metal frames of a curtain wall reflect a little too
    if (curtain) radiance += 0.3 * F * refl * wallW * upper;
    // below the floor (foundations)
    radiance *= v < 0.0 ? 0.85 : 1.0;
    if (plainWall) radiance = wallAlb * 0.9 * Ediff / PI;
  }

  // ---- aerial perspective (as the terrain) ----
  vec3 color = atmoAerial(radiance, V, dist, vH);
  if (uDebug > 0.5) {
    #ifdef BOX
      color = mix(color, vec3(0.1, 0.3, 1.0) * 0.4, 0.6);
    #else
      color = mix(color, vec3(1.0, 0.25, 0.1) * 0.4, 0.6);
    #endif
  }
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
