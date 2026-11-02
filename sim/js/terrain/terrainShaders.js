// Terrain shaders (three.js ShaderMaterial, GLSL ES 3.0).
//
// Vertex: CDLOD. Every patch instance is a 64 x 64 (or 32 x 32) grid; aNode = (origin in
// 25 m units from the far area's NW corner, grid step in units, level). Heights come from
// the packed R16UI height texture with texelFetch (exactly the data the CPU uses for
// heightAt); vertices morph towards the next coarser grid with distance; positions are built
// relative to the camera from exact integers (no float32 jitter 50 km from the origin) and
// lowered by the earth's curvature d^2 / 2R.
//
// Fragment: satellite colour (L0 tile near the camera, core overview, far image) with ground
// detail chosen by ESA WorldCover land cover: near the camera every class gets its own
// material from the detail texture array (detailTextures.js) or from analytic patterns:
// crop rows and furrows that follow each field (the field data, fieldAnalysis.js), orchards,
// vineyards and greenhouses where OpenStreetMap has them, woodland, garrigue, limestone,
// terraces on the hill slopes, sand ripples, the Dead Sea's salt and shoreline steps, urban
// paving. Every pattern keeps the imagery's mean colour, so the land looks the same from
// altitude, and fades out before it is too fine for the pixels (each along its own axes, so
// rows seen end-on stay). Then: water (sea, Dead Sea, ponds) with waves, Fresnel sky
// reflection, sun glint and surf; procedural runway paint; the aircraft's shadow and the
// terrain's own shadows (horizon map, horizonMap.js); sun light through the atmosphere; city
// lights at night; aerial perspective from the sky-view LUT so the haze matches the sky.
//
// GROUND_DETAIL (define, Terrain.js TERRAIN_QUALITY): 0 no near ground materials (low),
// 1 the materials without their costliest parts (medium: no imagery-guided field edges, no
// bicubic imagery, fewer texture layers, orchards as hedgerow bands without single crowns, no
// bales), 2 everything (high).
//
// Samplers (three.js counts vertex + fragment together; Direct3D 11 allows 16): L0 program
// 12 (uHeights, uOverview, uNormalCore, uLc, uDetailArr, uHorizon, uL0Color, uL0Data, the
// shadow map, 3 atmosphere LUTs), base program 12 (no L0 textures, plus uFarColor and
// uNormalFar). Four units are left for the lighting track.

import { ATMOSPHERE_PARS, ATMOSPHERE_CORE } from '../env/atmosphereGLSL.js';
import { DETAIL_LAYERS, SLOPE_SCALE, GLYPH_GRID } from './detailTextures.js';
import { HORIZON_GLSL } from './horizonMap.js';

export const MAX_RWY = 4;

const L = DETAIL_LAYERS;
const f1 = (v) => Number(v).toFixed(1);

export const TERRAIN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
${ATMOSPHERE_CORE}

attribute vec4 aNode;               // originU.x, originU.z, stepU, level
uniform highp usampler2D uHeights;  // packed: core 4097^2 at x 0..4096, far 2049^2 at x 4097..6145
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
float hCore(ivec2 p) { return decodeH(texelFetch(uHeights, clamp(p, ivec2(0), ivec2(4096)), 0).r); }
float hFar(ivec2 p) { return decodeH(texelFetch(uHeights, clamp(p, ivec2(0), ivec2(2048)) + ivec2(4097, 0), 0).r); }

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
#ifndef GROUND_DETAIL
  #define GROUND_DETAIL 2
#endif

varying vec3 vRel;
varying vec2 vWorldXZ;
varying float vH;
varying float vMorph;
varying float vLevel;

uniform sampler2D uOverview;         // core colour, 25 m / px
uniform sampler2D uNormalCore;        // normal x / z per core sample (4097^2)
#ifndef USE_L0
uniform sampler2D uFarColor;          // far colour, 200 m / px
uniform sampler2D uNormalFar;
#endif
uniform highp usampler2D uLc;         // land cover codes: overview 4096^2, far 2048^2 below it
uniform highp sampler2DArray uDetailArr;
uniform float uDetailStrength;        // mid-distance (macro) detail
uniform float uGroundDetail;          // near ground materials: 0 off, 1 on (the switch; GROUND_DETAIL is the quality tier)
uniform float uAlbedoGain;
uniform float uCityLights;            // night lights gain (0 = off)
uniform vec2 uCityNear;               // city lights fade in from .x to .y m (another module's street lamps nearer); 0, 0: everywhere
uniform vec2 uCamMod;                 // camera x, z modulo 256 m (exact, from the CPU)
uniform vec2 uCamMod1280;             // camera x, z modulo 1280 m (rotated layers: see the water)
uniform vec2 uTreeCover;              // 3D trees within .x m (fade .y m): plain ground under them
uniform float uDebugLod;
uniform float uDebugHeight;           // 1: output (height, x, z) of the rendered surface (tests)
uniform float uDebugView;             // 1 classes, 2 row direction, 3 near detail weight, 4 crop state, 5 terrain shadow

#ifdef USE_L0
uniform sampler2D uL0Color;           // 1024 x 1024 for this tile, 6.25 m / px
uniform highp usampler2D uL0Data;     // 640 x 640, 10 m: class | row direction | region random
uniform vec2 uL0Origin;               // tile NW corner (m)
uniform float uL0Fade;
uniform vec4 uRwyA[${MAX_RWY}];       // centre x, z, unit direction x, z (end 0 -> end 1)
uniform vec4 uRwyB[${MAX_RWY}];       // half length, half width, designator end 0, end 1
uniform vec4 uRwyC[${MAX_RWY}];       // overrun end 0, end 1, displaced threshold end 0, end 1
uniform int uRwyCount;
#endif

${HORIZON_GLSL}

#ifdef NORMAL_UNORM
  #define DECODE_N(v) ((v) * 2.0 - 1.0)
#else
  #define DECODE_N(v) (v)
#endif

#define DL_MACRO ${f1(L.MACRO.index)}
#define DL_WATER ${f1(L.WATER.index)}
#define DL_GLYPHS ${f1(L.GLYPHS.index)}
#define DL_SOIL ${f1(L.SOIL.index)}
#define DL_GRASS ${f1(L.GRASS.index)}
#define DL_SHRUB ${f1(L.SHRUB.index)}
#define DL_ROCK ${f1(L.ROCK.index)}
#define DL_SAND ${f1(L.SAND.index)}
#define DL_SALT ${f1(L.SALT.index)}
#define DL_URBAN ${f1(L.URBAN.index)}
#define DL_CANOPY ${f1(L.CANOPY.index)}
#define DL_LEAF ${f1(L.LEAF.index)}
#define DL_STRAW ${f1(L.STRAW.index)}
#define SLOPE_K ${(1 / SLOPE_SCALE).toFixed(3)}
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// per-pixel globals (set at the top of main)
vec2 gQ;          // world x, z modulo 256 m, exact near the camera
vec2 gDX, gDY;    // screen derivatives of x, z (m / px), exact
float gPx;        // metres per pixel: the long axis of the pixel's footprint on the ground

// ---- land cover --------------------------------------------------------------------
// class index (fieldAnalysis.js CLASS_CODES) of an ESA WorldCover code
uint classOf(uint c) { return c >= 100u ? 11u : (c == 95u ? 10u : c / 10u); }
// weights: wA = (water, tree, shrub, grass), wB = (crop, built-up, bare, wetland),
// wC = (orchard, vineyard, greenhouses, -): the classes OpenStreetMap maps (field data, L0 only)
void classAdd(uint ci, float h, float k, inout vec4 wA, inout vec4 wB, inout vec4 wC) {
  if (ci == 8u || (ci == 0u && abs(h) < 0.5)) wA.x += k;
  else if (ci == 1u || ci == 10u) wA.y += k;
  else if (ci == 2u) wA.z += k;
  else if (ci == 4u) wB.x += k;
  else if (ci == 5u) wB.y += k;
  else if (ci == 6u || ci == 7u) wB.z += k;
  else if (ci == 9u) wB.w += k;
  else if (ci == 12u) wC.x += k;
  else if (ci == 13u) wC.y += k;
  else if (ci == 14u) wC.z += k;
  else wA.w += k;                     // grass, moss, no data on land
}
// bilinear class weights from a code grid in uLc (pixel-is-area), uv 0..1 over the n x n grid at org
void lcSample(vec2 uv, float n, ivec2 org, float h, out vec4 wA, out vec4 wB) {
  vec2 p = uv * n - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 ip = ivec2(i);
  ivec2 mx = ivec2(int(n) - 1);
  wA = vec4(0.0); wB = vec4(0.0);
  vec4 wC = vec4(0.0);                // WorldCover has none of the mapped classes
  classAdd(classOf(texelFetch(uLc, clamp(ip, ivec2(0), mx) + org, 0).r), h, (1.0 - f.x) * (1.0 - f.y), wA, wB, wC);
  classAdd(classOf(texelFetch(uLc, clamp(ip + ivec2(1, 0), ivec2(0), mx) + org, 0).r), h, f.x * (1.0 - f.y), wA, wB, wC);
  classAdd(classOf(texelFetch(uLc, clamp(ip + ivec2(0, 1), ivec2(0), mx) + org, 0).r), h, (1.0 - f.x) * f.y, wA, wB, wC);
  classAdd(classOf(texelFetch(uLc, clamp(ip + ivec2(1, 1), ivec2(0), mx) + org, 0).r), h, f.x * f.y, wA, wB, wC);
}
// share of built-up land within ~3 km (Terrain.js urbanShare: 100 m cells over the core, 400 m
// over the far area, in uLc's free corner at x 2048.., y 4096..): the city lights' brightness
float urbanShare(vec2 xz) {
  bool core = max(abs(xz.x), abs(xz.y)) < 51150.0;
  vec2 p = core ? (xz + 51200.0) / 100.0 - 0.5 : (xz + 204800.0) / 400.0 - 0.5;
  ivec2 o = core ? ivec2(2048, 4096) : ivec2(3072, 4096);
  vec2 i = clamp(floor(p), vec2(0.0), vec2(1022.0));
  vec2 f = clamp(p - i, 0.0, 1.0);
  ivec2 ip = ivec2(i) + o;
  float a = float(texelFetch(uLc, ip, 0).r), b = float(texelFetch(uLc, ip + ivec2(1, 0), 0).r);
  float c = float(texelFetch(uLc, ip + ivec2(0, 1), 0).r), d = float(texelFetch(uLc, ip + ivec2(1, 1), 0).r);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) / 255.0;
}

float aaBand(float x, float a, float b, float px) {
  return clamp((x - a) / px + 0.5, 0.0, 1.0) * clamp((b - x) / px + 0.5, 0.0, 1.0);
}
// fraction of the window [x - w/2, x + w/2] where fract(x) < d (box-filtered stripes)
float stripes(float x, float w, float d) {
  w = max(w, 1e-3);
  float a = x - 0.5 * w, b = x + 0.5 * w;
  float ia = floor(a) * d + min(fract(a), d);
  float ib = floor(b) * d + min(fract(b), d);
  return clamp((ib - ia) / w, 0.0, 1.0);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// ---- detail texture array ------------------------------------------------------------
// layer at gQ / tile (tile must divide 256 m), explicit gradients (safe inside branches)
vec4 dl(float layer, float tile) {
  return textureGrad(uDetailArr, vec3(gQ / tile, layer), gDX / tile, gDY / tile);
}
// the same at an offset (m), e.g. towards the sun for cast shadows
vec4 dlAt(float layer, float tile, vec2 off) {
  return textureGrad(uDetailArr, vec3((gQ + off) / tile, layer), gDX / tile, gDY / tile);
}
// rotated by the 3-4-5 rotation (seamless when the tile divides 51.2 m)
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
vec4 dlRot(float layer, float tile) {
  return textureGrad(uDetailArr, vec3(ROT * gQ / tile, layer), ROT * gDX / tile, ROT * gDY / tile);
}
// mean of a layer (its 1 x 1 mip)
vec4 dlMean(float layer) { return textureLod(uDetailArr, vec3(0.5, 0.5, layer), 12.0); }
// slope (dh/dx, dh/dz in m / m) of a layer texel made for genTile and sampled at useTile
vec2 dlSlope(vec4 t, float genTile, float useTile) { return (t.rg - 0.5) * SLOPE_K * (genTile / useTile); }

// soil colour with the luminance of C (brownish, less saturated)
vec3 soilOf(vec3 C) { return dot(C, LUMA) * vec3(1.30, 0.97, 0.70); }
// two-material pattern with mean C: Ca where m = 0, the other material (solved) where m = 1,
// which covers the fraction f of the area
vec3 meanMix(vec3 C, vec3 Ca, float m, float f) {
  vec3 Cb = clamp((C - (1.0 - f) * Ca) / max(f, 0.05), 0.0, 1.0);
  return mix(Ca, Cb, m);
}
// the same from two reference colours: Ta where m = 0, Tb where m = 1 (covering the fraction f),
// both scaled per channel so that the mean is C. They keep their contrast and hue difference
// (dark olive shrubs on pale soil) and take the tint from the imagery; solving for one of them
// (meanMix) can give odd hues, such as red shrubs with no blue on a pink ground.
vec3 mixMean(vec3 C, vec3 Ta, vec3 Tb, float m, float f) {
  return min(mix(Ta, Tb, m) * C / mix(Ta, Tb, f), vec3(1.0));
}
// reference albedos (linear; only their ratios matter): limestone soil of the hills, browner
// soil of the plain, dry grass, garrigue cushions, forest floor and crowns, orchard soil and crowns
const vec3 REF_SOIL_HILL = vec3(0.52, 0.48, 0.42);
const vec3 REF_SOIL_LOW = vec3(0.52, 0.43, 0.32);
const vec3 REF_DRY_GRASS = vec3(0.50, 0.44, 0.30);
const vec3 REF_SHRUB = vec3(0.13, 0.145, 0.085);
const vec3 REF_FOREST_FLOOR = vec3(0.40, 0.34, 0.26);
const vec3 REF_CROWN = vec3(0.07, 0.10, 0.05);
const vec3 REF_ORCHARD_SOIL = vec3(0.45, 0.37, 0.27);
const vec3 REF_ORCHARD_CROWN = vec3(0.08, 0.11, 0.05);
const vec3 REF_VINE_SOIL = vec3(0.50, 0.42, 0.31);
const vec3 REF_VINE_LEAF = vec3(0.10, 0.14, 0.05);

#if GROUND_DETAIL > 0
// Orchard trees, planted on a grid of cells sp (m; along, across the rows) a few dm off its
// centres, crowns +-12 % in size, 4 % of the trees missing. A crown is an ellipsoid: radius R,
// half-height Rv, centre Hc above the soil. crownRay: the crown of the tree in cell "cell" against
// the ray that leaves the soil at lo (local m) and moves by ray (m, local) sideways per metre it
// rises (toward the eye or the sun). Returns the coverage, antialiased over the pixel's
// footprint across the crown's outline as the ray sees it; t: the height where the ray enters
// the crown (its side toward the eye or the sun), n: the normal there (local along, across, up).
float crownRay(vec2 lo, vec2 ray, vec2 cell, vec2 sp, float R, float Rv, float Hc, float rnd,
               vec2 dir, vec2 perp, out float t, out vec3 n) {
  vec2 h2 = hash22(cell + rnd * 97.0);
  vec2 cc = (cell + 0.5 + (h2 - 0.5) * 0.06) * sp;
  float sz = 0.88 + 0.24 * hash12(cell + 3.1);
  float present = step(0.04, hash12(cell + 17.3));
  float ir2 = 1.0 / (R * R * sz * sz), iv2 = 1.0 / (Rv * Rv * sz * sz);
  vec2 p = lo - cc;
  // |p + ray t|^2 / r^2 + (t - Hc)^2 / rv^2 = 1, i.e. a t^2 + 2 b t + c = 0
  float a = dot(ray, ray) * ir2 + iv2;
  float b = dot(p, ray) * ir2 - Hc * iv2;
  float c = dot(p, p) * ir2 + Hc * Hc * iv2 - 1.0;
  t = (-b + sqrt(max(b * b - a * c, 0.0))) / a;
  // q: the ray's closest approach in crown radii (< 1: it passes through); its gradient over
  // the soil (per m, local) turns 1 - q into pixels across the outline
  vec2 xs = p - b / a * ray;
  float q = sqrt(max(c - b * b / a + 1.0, 1e-6));
  vec2 gq = xs * ir2 / q;
  vec2 gw = gq.x * dir + gq.y * perp;
  float dq = abs(dot(gw, gDX)) + abs(dot(gw, gDY)) + 1e-4;
  n = normalize(vec3((p + ray * t) * ir2, (t - Hc) * iv2));
  return clamp((1.0 - q) / dq + 0.5, 0.0, 1.0) * present;
}
#endif

// Ground materials near the camera. C: imagery colour (raw albedo); Cm: the same at 25 m;
// wA / wB / wC: class weights; dir: row direction; rnd: the field's random (0..1); h: height
// (m); g: terrain slope (dh/dx, dh/dz). Texture layers are mip-filtered (anisotropic); analytic
// patterns filter themselves (box-filtered stripes, pixel-wide edges) and fade to their mean
// before a period is down to two pixels, measured along their own axis (fadeP), so rows seen
// end-on stay sharp while rows seen across fade.
// Returns the albedo; adds detail slopes to slope, multiplies sunVis by cast shadows and
// cavity by sky occlusion.
#if GROUND_DETAIL > 0
// 1 while a pattern of period P (m) spans 4 pixels or more along its axis (w: metres per pixel
// along it), 0 from 2 pixels (its Nyquist limit)
float fadeP(float w, float P) { return clamp(2.0 - 4.0 * w / P, 0.0, 1.0); }

vec3 groundMaterial(vec3 C, vec3 Cm, vec4 wA, vec4 wB, vec4 wC, vec2 dir, float rnd, float h, vec2 g,
                    inout vec2 slope, inout float sunVis, inout float cavity) {
  vec3 col = vec3(0.0);
  float wsum = 0.0;
  vec2 sl = vec2(0.0);
  float shade = 0.0;                                  // fraction of direct sun blocked
  float lumC = dot(C, LUMA);
  // sun offset for short cast shadows (per metre of object height), capped
  vec2 sunH = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
  float cotE = clamp(length(uSunDir.xz) / max(uSunDir.y, 0.02), 0.0, 6.0);
  bool day = uSunDir.y > 0.0;
  vec2 xz = vWorldXZ;
  vec2 perp = vec2(-dir.y, dir.x);
  float across = dot(xz, perp);                       // m, across the rows
  float along = dot(xz, dir);
  float wpx = abs(dot(gDX, perp)) + abs(dot(gDY, perp)) + 1e-4;   // across-row m per pixel
  float apx = abs(dot(gDX, dir)) + abs(dot(gDY, dir)) + 1e-4;     // along-row m per pixel
  vec2 sunL = vec2(dot(sunH, dir), dot(sunH, perp)) * cotE;       // toward the sun per m of height (along, across)
  // the view ray: from this point of the soil it rises toward the eye, vL (m; along, across)
  // per metre of height. Trees and vine rows hide the soil behind them along it.
  vec3 Vw = normalize(-vRel);
  float cotV = min(length(Vw.xz) / max(Vw.y, 0.02), 8.0);
  vec2 vL = vec2(dot(Vw.xz, dir), dot(Vw.xz, perp)) / max(length(Vw.xz), 1e-4) * cotV;
  // moisture, wear and tilth patches over the ground (5-30 m): visible where the fine layers
  // are already filtered away (a low pass from the ground, 100-300 m away)
  float patches = (dl(DL_MACRO, 64.0).r - dlMean(DL_MACRO).r) * 0.6;
  // where another module draws 3D trees: the ground between them, no painted crowns
  float k3d = uTreeCover.x > 0.0 ? 1.0 - smoothstep(uTreeCover.x, uTreeCover.x + uTreeCover.y, length(vRel)) : 0.0;

  // -- crops: ploughed furrows, green rows or beds, stubble with windrows and bales -----
  if (wB.x > 0.01) {
    // the field's state from its colour at 25 m (Israel's summer: mostly harvested or ploughed)
    float gr = Cm.g / (Cm.r + Cm.g + Cm.b + 1e-4) - 0.3333;
    float lm = dot(Cm, LUMA);
    float kGreen = smoothstep(0.018, 0.045, gr);
    float kStub = (1.0 - kGreen) * smoothstep(0.25, 0.33, lm);
    float kPlough = 1.0 - kGreen - kStub;
    float r1 = fract(rnd * 7.13), r2 = fract(rnd * 3.71), r3 = fract(rnd * 5.31);
    vec4 soil = dl(DL_SOIL, 4.0);
    vec4 soilM = dlMean(DL_SOIL);
    vec3 c = vec3(0.0);
    vec2 s2 = vec2(0.0);
    if (kPlough > 0.0) {
      // furrows 0.35-0.6 m apart, 8 cm deep, clods; ploughing "lands" 24-40 m wide whose
      // furrows were thrown the other way (a slightly different shade)
      float spacing = 0.35 + 0.25 * r1;
      float aa = fadeP(wpx, spacing);
      float sp = across / spacing;
      float pr = cos(6.2832 * sp);
      vec2 fs = perp * (-6.2832 / spacing * sin(6.2832 * sp) * 0.08 * aa * 0.5);
      float landW = 24.0 + 16.0 * r2;
      float land = (stripes(across / landW, wpx / landW, 0.5) - 0.5) * fadeP(wpx, landW);
      #if GROUND_DETAIL > 1
        // big clods and ridges (the soil layer 4x larger): texture that survives at 0.3-2 m per pixel
        vec4 big = dl(DL_SOIL, 16.0);
      #else
        vec4 big = soilM;
      #endif
      float lumMod = 1.0 + 0.16 * pr * aa + 0.9 * (soil.b - soilM.b) + 0.7 * (big.b - soilM.b) + 0.07 * land + patches;
      c += kPlough * C * lumMod;
      s2 += kPlough * (fs + dlSlope(soil, 4.0, 4.0) + dlSlope(big, 4.0, 16.0) * 2.5);
      cavity += wB.x * kPlough * 0.25 * (0.5 - 0.5 * pr) * aa;
    }
    if (kGreen > 0.0) {
      // vegetable beds (1.6-2 m with a path between, drip lines) or row crops (0.75-1 m)
      bool beds = r2 < 0.45;
      float spacing = beds ? 1.6 + 0.4 * r1 : 0.75 + 0.25 * r1;
      float duty = beds ? 0.72 : 0.55;
      float ws = wpx / spacing;
      float aa = fadeP(wpx, spacing);
      float sp = across / spacing;
      vec4 lf = dl(DL_LEAF, 2.0);
      float row = stripes(sp + duty * 0.5, ws, duty);
      float cover = 0.6 + 0.8 * lf.a;
      float m = mix(duty, row, aa) * mix(0.8, cover, aa);
      float f = duty * 0.8 * 0.98;
      vec3 soilC = soilOf(C) * 1.35 * (1.0 + 0.6 * (soil.b - soilM.b));
      vec3 cc = meanMix(C, soilC, m, f);
      cc *= 1.0 + 0.5 * (lf.b - 0.5) * m + patches;
      // black drip lines along the beds
      if (beds) cc *= 1.0 - 0.45 * stripes(sp + 0.03, ws, 0.02) * aa;
      c += kGreen * cc;
      float pr = sin(6.2832 * sp);
      s2 += kGreen * (perp * (-6.2832 / spacing * pr * (beds ? 0.1 : 0.06) * aa) + dlSlope(lf, 2.0, 2.0) * m);
      cavity += wB.x * kGreen * 0.35 * m;
    }
    if (kStub > 0.0) {
      // stubble: straw over soil; the harvester's passes (header 6-9 m) lie alternately
      // lighter and darker, straw windrows on some fields, bales on others, tramlines
      vec4 st = dl(DL_STRAW, 2.0);
      vec4 stM = dlMean(DL_STRAW);
      float header = 6.0 + 3.0 * r1;
      float sw = across / header;
      float ww = wpx / header;
      float pass = (stripes(sw * 0.5, ww * 0.5, 0.5) - 0.5) * fadeP(wpx, 2.0 * header);
      float windrow = (stripes(sw + 0.1, ww, 0.17) - 0.17) * step(0.3, r3) * step(r3, 0.7) * fadeP(wpx, header);   // mean-free
      // bales: 2.4 x 1.2 m, on the windrows the baler raked from three passes, every 30-50 m
      // (fields with r3 > 0.7); gone before they are under a pixel; high quality only
      float bale = 0.0, baleSh = 0.0;
      #if GROUND_DETAIL > 1
      float kBale = clamp(2.0 - 2.0 * max(apx / 2.4, wpx / 1.2), 0.0, 1.0);
      if (r3 > 0.7 && kBale > 0.0) {
        float bl = 30.0 + 20.0 * r2;
        vec2 cell = vec2(floor(along / bl), floor(sw / 3.0));
        vec2 jit = hash22(cell + 31.0 * rnd);
        float ba = along - (cell.x + 0.2 + 0.6 * jit.x) * bl;
        float bc = across - (cell.y + 0.5) * header * 3.0;
        bool present = jit.y > 0.3;
        bale = present ? aaBand(ba, -1.2, 1.2, apx) * aaBand(bc, -0.6, 0.6, wpx) * kBale : 0.0;
        // shadow on the ground: the bale (0.9 m tall) seen from the sun
        vec2 so = sunL * 0.9;
        float bs = present ? aaBand(ba + so.x, -1.2, 1.2, apx) * aaBand(bc + so.y, -0.6, 0.6, wpx) * kBale : 0.0;
        baleSh = bs * (1.0 - bale);
      }
      #endif
      float tram = across / (header * 3.0);
      float tw = wpx / (header * 3.0);
      float tl = (stripes(tram + 0.02, tw, 0.03) + stripes(tram - 0.07, tw, 0.03) - 0.06) * fadeP(wpx, header * 3.0);
      #if GROUND_DETAIL > 1
        // straw lying in tufts and swaths (1-4 m) between the passes
        float tufts = dl(DL_GRASS, 16.0).b - dlMean(DL_GRASS).b;
      #else
        float tufts = 0.0;
      #endif
      float lumMod = 1.0 + 0.6 * (st.b - stM.b) + 0.5 * tufts + 0.14 * pass + 0.3 * windrow - 0.22 * tl + patches;
      vec3 cs = C * lumMod;
      cs = mix(cs, C * vec3(1.25, 1.12, 0.85), bale);
      c += kStub * cs;
      s2 += kStub * (dlSlope(st, 2.0, 2.0) + dlSlope(soil, 4.0, 4.0) * 0.5);
      shade = max(shade, kStub * baleSh * 0.9);
    }
    col += wB.x * c;
    sl += wB.x * s2;
    wsum += wB.x;
  }

  // -- woodland: the WorldCover trees that are not mapped orchards, irregular crowns -------
  if (wA.y > 0.01) {
    vec4 t = dl(DL_CANOPY, 64.0);
    vec4 tM = dlMean(DL_CANOPY);
    float m = t.a;
    vec3 c = mixMean(C, REF_FOREST_FLOOR, REF_CROWN, m, tM.a) * (1.0 + 0.8 * (t.b - tM.b) * m);
    vec3 ground = mixMean(C, REF_FOREST_FLOOR, REF_CROWN, 0.0, tM.a);
    float ts = dlAt(DL_CANOPY, 64.0, sunH * cotE * 6.0).a;
    col += wA.y * mix(c, ground, k3d);
    sl += wA.y * dlSlope(t, 64.0, 64.0) * 0.6 * (1.0 - k3d);
    shade += wA.y * ts * (1.0 - m) * (1.0 - k3d);
    cavity += wA.y * 0.35 * m * (1.0 - k3d);
    wsum += wA.y;
  }

  // -- orchards (OpenStreetMap): crowns in rows ------------------------------------------
  // Citrus, avocado, mango, olives, almonds: 4-6 m apart in the row, 5.5-8 m between rows;
  // crowns are ellipsoids 0.36-0.48 of the in-row spacing in radius and 0.7-0.85 of that in
  // half-height, on 0.4-0.9 m of trunk (3-6 m tall trees). Close: every crown, found along the
  // view ray (it hides the soil behind it, the eye sees its near side), lit by its own normal,
  // its shadow on the soil traced along the sun's ray. Once the crowns along a row come closer
  // than 4 pixels: hedgerow bands (still sharp where the rows run away from the eye); once the
  // rows do: the mean. All three show the same crown cover as seen from the eye (fV: more
  // crown and less soil toward the horizon, as on real orchards) and the same mean shade.
  // Medium quality stops at the bands (the crowns' rays are the costliest part).
  if (wC.x > 0.01) {
    float r1 = fract(rnd * 3.1), r2 = fract(rnd * 7.7), r3 = fract(rnd * 13.3);
    vec2 sp = vec2(4.0 + 2.0 * r1, 0.0);
    sp.y = max(5.5 + 2.5 * r2, sp.x + 0.8);
    float R = (0.36 + 0.12 * r3) * sp.x;              // crown radius (m)
    float Rv = (0.7 + 0.15 * r2) * R;                 // crown half-height (m)
    float Hc = Rv + 0.4 + 0.5 * r1;                   // crown centre above the soil (m)
    float fCov = 3.1416 * R * R / (sp.x * sp.y) * 0.96;    // crown cover from above (4 % missing)
    float duty0 = 2.0 * R / sp.y;                     // a row's band across, from above
    // a crown's outline on the soil along the view ray: R across it, stretched along it
    float Ra = sqrt(R * R + Rv * Rv * vL.y * vL.y);   // half-width across the rows
    float Ap = 3.1416 * R * sqrt(R * R + Rv * Rv * cotV * cotV);
    float dutyV = min(2.0 * Ra / sp.y, 1.0);          // a row's band across, as seen
    float alongV = min(Ap * 0.96 / (sp.x * 2.0 * Ra), 1.0);   // the crowns' share of that band
    float fV = dutyV * alongV;
    float kRow = fadeP(wpx, sp.y);
    // mean shade on the soil: each crown's shadow is an ellipse R by sqrt(R^2 + (Rv cot e)^2)
    // whose centre is Hc cot e away from the sun, less the part under the crown itself
    // (two-disc lens); the soil the eye sees has the same share of it
    float q = min(Hc * cotE / (2.0 * R), 1.0);
    float lens = 2.0 * R * R * (acos(q) - q * sqrt(1.0 - q * q));
    float shM = min((3.1416 * R * sqrt(R * R + Rv * Rv * cotE * cotE) - lens) * 0.96 / (sp.x * sp.y), 1.0 - fCov);
    float shS = shM / (1.0 - fCov);                   // share of the soil in shade
    float m = fV, sh = shS * (1.0 - fV);
    vec2 s2 = vec2(0.0);
    if (kRow > 0.0) {
      // hedgerow bands as seen: the rows' outline along the view ray (half-width Ra, centred
      // Hc vL.y away from the eye); their shadows from the true rows, swept away from the sun
      // to the far edge of the ellipse's shadow, normalised to the mean shade
      float tT = across / sp.y - 0.5 + 0.5 * duty0;
      float tV = (across + vL.y * Hc) / sp.y - 0.5 + 0.5 * dutyV;
      float bandT = stripes(tT, wpx / sp.y, duty0);
      float band = stripes(tV, wpx / sp.y, dutyV);
      float e = Hc * abs(sunL.y) + sqrt(R * R + Rv * Rv * sunL.y * sunL.y) - R;
      float s = sign(sunL.y) * e / sp.y;
      float sweep = stripes(tT + max(s, 0.0), wpx / sp.y, min(duty0 + abs(s), 1.0));
      float e1 = min(abs(s), 1.0 - duty0);
      float shB = mix((1.0 - bandT) / (1.0 - duty0), max(sweep - bandT, 0.0) / max(e1, 0.02), smoothstep(0.02, 0.08, e1));
      float mRow = band * alongV;
      float shRow = min(shS * shB, 1.0) * (1.0 - mRow);
      // rounded tops across the band (once the band itself spans 4 pixels)
      float vv = fract(tV) / dutyV;
      float top = (1.0 - 2.0 * min(vv, 1.0)) * 1.2 * step(vv, 1.0) * fadeP(wpx, 2.0 * dutyV * sp.y);
      m = mix(m, mRow, kRow);
      sh = mix(sh, shRow, kRow);
      s2 = perp * top * alongV * kRow;
      #if GROUND_DETAIL > 1
      float kCrown = min(kRow, fadeP(apx, sp.x));
      if (kCrown > 0.0) {
        vec2 lo = vec2(along, across);
        // the crowns along the view ray, front (high) to back: at four heights through the
        // crown layer the ray is over one tree's cell; each tree once
        float crown = 0.0;
        vec3 nSum = vec3(0.0);
        vec2 last = vec2(1e9);
        float tz;
        vec3 nz;
        for (int i = 0; i < 4; i++) {
          vec2 cell = floor((lo + vL * (Hc + Rv * (0.75 - 0.5 * float(i)))) / sp);
          if (cell == last) continue;
          last = cell;
          float cv = crownRay(lo, vL, cell, sp, R, Rv, Hc, rnd, dir, perp, tz, nz) * (1.0 - crown);
          nSum += nz * cv;
          crown += cv;
        }
        // the soil's shadow: the crowns along the sun's ray from it
        float shC = 0.0;
        last = vec2(1e9);
        for (int i = 0; i < 4; i++) {
          vec2 cell = floor((lo + sunL * (Hc + Rv * (0.75 - 0.5 * float(i)))) / sp);
          if (cell == last) continue;
          last = cell;
          shC = max(shC, crownRay(lo, sunL, cell, sp, R, Rv, Hc, rnd, dir, perp, tz, nz));
        }
        shC *= 1.0 - crown;
        // the crowns' surface as slopes (dh/d along, dh/d across); steep flanks capped
        vec3 nn = nSum / max(crown, 1e-3);
        vec2 dome = -nn.xy / max(nn.z, 0.3) * crown;
        m = mix(m, crown, kCrown);
        sh = mix(sh, shC, kCrown);
        s2 = mix(s2, dome.x * dir + dome.y * perp, kCrown);
      }
      #endif
    }
    vec4 lf = dl(DL_LEAF, 2.0);
    vec3 c = mixMean(C, REF_ORCHARD_SOIL, REF_ORCHARD_CROWN, m, fCov) * (1.0 + 0.6 * (lf.b - 0.5) * m);
    vec3 ground = mixMean(C, REF_ORCHARD_SOIL, REF_ORCHARD_CROWN, 0.0, fCov);
    col += wC.x * mix(c, ground, k3d);
    sl += wC.x * s2 * (1.0 - k3d);
    shade += wC.x * sh * (1.0 - k3d);
    cavity += wC.x * 0.4 * m * (1.0 - k3d);
    wsum += wC.x;
  }

  // -- vineyards (OpenStreetMap): trellised rows 2.4-3.2 m apart, the canopy 0.9-1.3 m wide
  // from 0.5 to 1.8 m over bare soil; rounded tops, shadows on the soil beside the rows. Seen
  // along the view ray a row hides the soil behind it: its band on the soil is wider by the
  // canopy's height times the ray's slope across the rows and lies further from the eye
  if (wC.y > 0.01) {
    float r1 = fract(rnd * 5.3), r2 = fract(rnd * 9.1);
    float spacing = 2.4 + 0.8 * r1;
    float duty = (0.9 + 0.4 * r2) / spacing;
    float dutyV = min(duty + 1.3 * abs(vL.y) / spacing, 1.0);
    float aa = fadeP(wpx, spacing);
    float t0 = across / spacing - 0.5 + 0.5 * duty;
    float tV = (across + 1.15 * vL.y) / spacing - 0.5 + 0.5 * dutyV;
    float bandT = stripes(t0, wpx / spacing, duty);
    float band = stripes(tV, wpx / spacing, dutyV);
    vec4 lf = dl(DL_LEAF, 2.0);
    vec4 lfM = dlMean(DL_LEAF);
    float cov = clamp(0.85 + 0.8 * (lf.a - lfM.a), 0.0, 1.0);     // gaps along the row
    float f = duty * 0.85;
    float fV = dutyV * 0.85;
    float m = mix(fV, band * cov, aa);
    vec4 soil = dl(DL_SOIL, 4.0);
    vec4 soilM = dlMean(DL_SOIL);
    vec3 c = mixMean(C, REF_VINE_SOIL, REF_VINE_LEAF, m, f) * (1.0 + 0.5 * (lf.b - 0.5) * m + 0.6 * (soil.b - soilM.b) * (1.0 - m) + patches);
    float vv = fract(tV) / dutyV;
    float top = (1.0 - 2.0 * min(vv, 1.0)) * 1.4 * step(vv, 1.0) * aa * fadeP(wpx, 2.0 * dutyV * spacing);
    // the rows' shadow: swept s periods away from the sun across the soil; the eye sees the
    // part of it its own view of the rows leaves open
    float s = sunL.y * 1.8 / spacing;
    float sweep = stripes(t0 + max(s, 0.0), wpx / spacing, min(duty + abs(s), 1.0));
    float shS = min(abs(s), 1.0 - duty) * 0.85 / (1.0 - f);
    float sh = mix(shS * (1.0 - fV), max(sweep - bandT, 0.0) * 0.85 * (1.0 - m), aa);
    col += wC.y * c;
    sl += wC.y * (perp * top + dlSlope(soil, 4.0, 4.0) * (1.0 - m));
    shade += wC.y * sh;
    cavity += wC.y * 0.3 * m;
    wsum += wC.y;
  }

  // -- greenhouses and net houses (OpenStreetMap): bays of arched plastic roofs 8-9.6 m
  // wide along the field's direction, dark gutters between them, film seams every ~4 m, dust
  if (wC.z > 0.01) {
    float r1 = fract(rnd * 2.9), r2 = fract(rnd * 6.7);
    float bay = 8.0 + 1.6 * r1;
    float aa = fadeP(wpx, bay);
    float t = across / bay;
    float x = 2.0 * fract(t) - 1.0;                  // -1..1 across a bay
    // the arch: flat at the ridge, steep at the gutters (once a half bay spans 4 pixels)
    float roof = -x * 0.75 / sqrt(max(1.0 - 0.85 * x * x, 0.1)) * fadeP(wpx, 0.5 * bay);
    float gut = (stripes(t + 0.025, wpx / bay, 0.05) - 0.05) * aa;           // mean-free
    float seam = (stripes(along / 4.0, apx / 4.0, 0.04) - 0.04) * fadeP(apx, 4.0);
    float dust = (dl(DL_MACRO, 32.0).b - dlMean(DL_MACRO).b) * 0.8 + 0.12 * (r2 - 0.5);
    col += wC.z * C * (1.0 - 0.6 * gut - 0.4 * seam + dust);
    sl += wC.z * perp * roof;
    wsum += wC.z;
  }

  // -- shrubland (garrigue) and grass ---------------------------------------------------
  if (wA.z > 0.01 || wA.w > 0.01 || wB.w > 0.01) {
    vec4 sb = dl(DL_SHRUB, 16.0);
    vec4 sbM = dlMean(DL_SHRUB);
    float hill = smoothstep(120.0, 400.0, h);
    if (wA.z > 0.01) {
      float m = sb.a;
      // dark olive cushions on pale limestone soil (hills) or browner soil (plain)
      vec3 soilRef = mix(REF_SOIL_LOW, REF_SOIL_HILL, hill);
      vec3 c = mixMean(C, soilRef, REF_SHRUB, m, sbM.a) * (1.0 + 0.5 * (sb.b - sbM.b) + patches);
      float ts = dlAt(DL_SHRUB, 16.0, sunH * cotE * 0.7).a;
      col += wA.z * c;
      sl += wA.z * dlSlope(sb, 16.0, 16.0);
      shade += wA.z * ts * (1.0 - m);
      cavity += wA.z * 0.3 * m;
      wsum += wA.z;
    }
    float wg = wA.w + wB.w;
    if (wg > 0.01) {
      vec4 gt = dl(DL_GRASS, 4.0);
      vec4 gM = dlMean(DL_GRASS);
      #if GROUND_DETAIL > 1
        vec4 g16 = dl(DL_GRASS, 16.0);                // clumps and tufts 0.2-1 m
      #else
        vec4 g16 = gM;
      #endif
      // scattered cushions and stones on the hills, wetter darker patches in wetlands
      float sparse = sb.a * hill * 0.6;
      vec3 c = C * (1.0 + 0.6 * (gt.b - gM.b) + 0.45 * (g16.b - gM.b) + patches);
      c = mixMean(c, REF_DRY_GRASS, REF_SHRUB, sparse, sbM.a * hill * 0.6);
      c *= 1.0 - 0.25 * (wB.w / max(wg, 1e-3)) * (gt.a - gM.a);
      col += wg * c;
      sl += wg * (dlSlope(gt, 4.0, 4.0) + dlSlope(sb, 16.0, 16.0) * hill * 0.5);
      shade += wg * dlAt(DL_SHRUB, 16.0, sunH * cotE * 0.6).a * sparse;
      cavity += wg * 0.15 * gt.a;
      wsum += wg;
    }
  }

  // -- built-up: paving, asphalt, yards --------------------------------------------------
  if (wB.y > 0.01) {
    vec4 u = dl(DL_URBAN, 16.0);
    vec4 uM = dlMean(DL_URBAN);
    col += wB.y * C * (1.0 + 0.9 * (u.b - uM.b));
    sl += wB.y * dlSlope(u, 16.0, 16.0);
    wsum += wB.y;
  }

  // -- bare: Dead Sea salt and mud, coastal sand, limestone, gravel ---------------------
  if (wB.z > 0.01) {
    float kSalt = smoothstep(-370.0, -395.0, h);
    float kSand = (1.0 - kSalt) * smoothstep(90.0, 40.0, h) * smoothstep(0.38, 0.5, lumC);
    float kRock = (1.0 - kSalt - kSand) * smoothstep(80.0, 250.0, h);
    float kSoil = 1.0 - kSalt - kSand - kRock;
    vec3 c = vec3(0.0);
    vec2 s2 = vec2(0.0);
    if (kSalt > 0.0) {
      vec4 t = dl(DL_SALT, 16.0);
      vec4 tM = dlMean(DL_SALT);
      // shoreline steps of the falling lake (about 1 m a year): pale salt and dark mud bands
      float ph = (h + 430.0) / 1.1 + 0.8 * (dl(DL_MACRO, 64.0).r - 0.5);
      float wph = (abs(dot(g, gDX)) + abs(dot(g, gDY))) / 1.1;
      float band = (stripes(ph, wph, 0.35) - 0.35) * fadeP(wph, 1.0);
      float mud = t.a * smoothstep(-405.0, -420.0, h);
      c += kSalt * C * (1.0 + 0.9 * (t.b - tM.b) + 0.35 * band - 0.35 * mud);
      s2 += kSalt * dlSlope(t, 16.0, 16.0);
    }
    if (kSand > 0.0) {
      vec4 t = dl(DL_SAND, 8.0);
      vec4 tM = dlMean(DL_SAND);
      c += kSand * C * (1.0 + 1.2 * (t.b - tM.b) + patches * 0.5);
      s2 += kSand * dlSlope(t, 8.0, 8.0);
    }
    if (kRock > 0.0) {
      vec4 t = dl(DL_ROCK, 16.0);
      vec4 tM = dlMean(DL_ROCK);
      #if GROUND_DETAIL > 1
        vec4 t64 = dl(DL_ROCK, 64.0);                 // outcrops and scree, 1-6 m
      #else
        vec4 t64 = tM;
      #endif
      c += kRock * C * (1.0 + 0.8 * (t.b - tM.b) + 0.5 * (t64.b - tM.b) + patches * 0.5);
      s2 += kRock * dlSlope(t, 16.0, 16.0);
      cavity += wB.z * kRock * 0.4 * t.a;
    }
    if (kSoil > 0.0) {
      vec4 t = dl(DL_SOIL, 4.0);
      vec4 tM = dlMean(DL_SOIL);
      #if GROUND_DETAIL > 1
        vec4 t16 = dl(DL_SOIL, 16.0);
      #else
        vec4 t16 = tM;
      #endif
      c += kSoil * C * (1.0 + 0.8 * (t.b - tM.b) + 0.5 * (t16.b - tM.b) + patches);
      s2 += kSoil * dlSlope(t, 4.0, 4.0);
    }
    col += wB.z * c;
    sl += wB.z * s2;
    wsum += wB.z;
  }

  // the rest (water, runway) keeps the imagery
  float rest = max(0.0, 1.0 - wsum);
  col += rest * C;

  // -- terraces on the hill slopes: stone walls along the contours ----------------------
  float gs = length(g);
  float natural = wA.y + wA.z + wA.w + wB.x + wC.x + wC.y;
  float terr = smoothstep(260.0, 420.0, h) * smoothstep(0.07, 0.14, gs) * (1.0 - smoothstep(0.45, 0.65, gs)) * natural;
  if (terr > 0.01) {
    // terraced in patches (from the 256 m macro pattern), steps 1.2-2 m high
    vec4 mac = dl(DL_MACRO, 256.0);
    terr *= smoothstep(0.42, 0.55, mac.r);
    float dh = 1.2 + 0.8 * mac.a;
    float hh = h + 0.6 * (dl(DL_MACRO, 32.0).b - 0.5);
    float ph = hh / dh;
    float wph = (abs(dot(g, gDX)) + abs(dot(g, gDY))) / dh;
    float vis = fadeP(wph, 1.0) * terr;
    if (vis > 0.0) {
      float P = dh / max(gs, 0.05);                      // horizontal spacing of the walls (m)
      float wf = clamp(0.7 / P, 0.04, 0.3);             // wall + its top: ~0.7 m wide from above
      float f = fract(ph);
      float wall = stripes(ph - (1.0 - wf), wph, wf);
      vec2 gd = g / max(gs, 1e-3);                       // uphill
      // benches flatter than the slope, risers steep
      float gb = gs * 0.3;
      float gr = (gs - gb * (1.0 - wf)) / wf;
      vec2 add = gd * mix(gb - gs, gr - gs, wall) * 0.8;
      sl += add * vis;
      vec4 rk = dl(DL_ROCK, 16.0);
      vec3 stone = vec3(0.50, 0.47, 0.42) * (0.75 + 0.5 * rk.b);
      col = mix(col, stone, wall * vis * 0.85);
      // shadow of the wall above onto the bench when the sun is uphill
      float up = dot(sunH, gd);
      if (day && up > 0.05) {
        float tanE = uSunDir.y / (up * length(uSunDir.xz));
        float ls = (dh * 0.8) / max(tanE, 0.02) / P;     // shadow length in phase units
        float dist = (1.0 - wf) - f;                      // to the wall's foot, phase units
        float inSh = (1.0 - wall) * smoothstep(ls + wph, ls - wph, dist) * step(0.0, dist);
        shade = max(shade, inSh * vis);
      }
      cavity += 0.2 * wall * vis;
    }
  }

  slope += sl;
  sunVis *= 1.0 - clamp(shade, 0.0, 1.0) * 0.85;
  return col;
}
#endif

#ifdef USE_L0
// glyph g (0..12) at local coords q in 0..1 (x right, y up); cells of 4 x 4, glyph box 0.6 wide
float glyph(float g, vec2 q, vec2 dq) {
  if (g < 0.0 || q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
  float G = ${f1(GLYPH_GRID)};
  float cx = mod(g, G), cy = floor(g / G);
  vec2 uv = vec2((cx + 0.2 + 0.6 * q.x) / G, 1.0 - (cy + 1.0 - q.y) / G);
  vec2 d = vec2(dq.x * 0.6, dq.y) / G;
  return textureGrad(uDetailArr, vec3(uv, DL_GLYPHS), vec2(d.x, 0.0), vec2(0.0, d.y)).r;
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
    // blast pad / overrun: yellow chevrons, 30 m apart, pointing at the runway; older,
    // paler pavement towards its far end
    float u = -e - at;
    float chev = aaBand(mod(u, 30.0), 0.0, 1.4, pw) * step(4.0, -e) * fadeSub;
    vec3 pad = asphalt * mix(1.08, 1.45, smoothstep(60.0, ov, -e));
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

// B-spline bicubic sample of the L0 colour (smooth magnification of the 6.25 m texels)
vec3 l0Bicubic(vec2 uv) {
  vec2 st = uv * 1024.0 - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) / 1024.0;
  vec2 h1 = (i + 1.0 + w3 / g1 + 0.5) / 1024.0;
  vec3 a = textureLod(uL0Color, vec2(h0.x, h0.y), 0.0).rgb;
  vec3 b = textureLod(uL0Color, vec2(h1.x, h0.y), 0.0).rgb;
  vec3 c = textureLod(uL0Color, vec2(h0.x, h1.y), 0.0).rgb;
  vec3 d = textureLod(uL0Color, vec2(h1.x, h1.y), 0.0).rgb;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}
#endif

// City lights at night: street lamps where the land is built up, along streets turned to the
// district's street direction (field analysis) with irregular spacing (blocks of ~60-160 m)
// and gentle bends; every fifth street is a main road with closer, brighter lamps. Sodium
// orange and LED white per street, each lamp with a pool of light stretched along the road,
// so the pools of a street join into a lit line between darker blocks. A lamp is drawn
// as a spot of at least one pixel with its energy kept, so from altitude it stays a point; once
// lamps are closer than about two pixels they merge into the district's glow. Big, dense towns
// are brighter and have more LED lamps than villages: the density follows the share of
// built-up land within ~3 km (urbanShare, from the land cover; no town is named here). Where
// another module draws the real street lamps (Roads: uCityNear) these start beyond them as the
// glow alone (grid 0): a made-up street grid would not continue the real streets; the glow
// follows the built-up land and urbanShare. The brightness is artistic: the night exposure (at most 40x the noon one, Environment.js) is far
// from a dark-adapted eye, so a lamp here is ~1.5 scene units * m^2 (about 45,000 cd, ~30x real).
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + 1.0), f.x), f.y);
}
vec3 cityLights(vec2 xz, float built, vec2 dir, float rnd, float px, float grid) {
  // 0.05-0.15 around a village, 0.3-0.5 in a town, 0.7-0.9 in the middle of Tel Aviv
  float urb = urbanShare(xz);
  // brighter and dimmer districts (~0.5 km, mean 1), so the far glow is not one even carpet
  float district = 0.4 + 1.2 * vnoise(xz / 450.0 + 3.7);
  float dens = built * (0.35 + 1.65 * urb) * district;
  float led = clamp(0.15 + 0.65 * urb + 0.3 * (fract(rnd * 5.1) - 0.5), 0.0, 1.0);
  const vec3 SODIUM = vec3(1.0, 0.5, 0.15);
  const vec3 LEDW = vec3(1.0, 0.75, 0.52);                // ~4500 K street LEDs (linear)
  const float S = 32.0;                                   // lamp spacing along a street (m)
  const float FLUX = 1.5;                                 // per lamp (scene units * m^2)
  float B = S * (3.0 + floor(fract(rnd * 3.7) * 2.0));    // mean block size: 96 or 128 m
  float onP = min(dens * 0.75, 1.0);                      // share of lamps that are lit
  vec3 avg = mix(SODIUM, LEDW, led) * onP * FLUX * 5.0 / (S * B);   // lamps and pools, two streets a block
  float detail = (1.0 - smoothstep(16.0, 32.0, px)) * grid;   // streets ~5 px apart or more
  vec3 e = avg;
  if (detail > 0.0) {
    vec2 lo = vec2(dot(xz, dir), dot(xz, vec2(-dir.y, dir.x)));
    lo += 40.0 * vec2(vnoise(xz / 420.0), vnoise(xz / 420.0 + 7.3)) - 20.0;   // bends
    float best = 1e9, bright = 0.0, isLed = 0.0, spB = S;
    vec2 off = vec2(0.0);                                 // nearest lamp: across, along its street (m)
    for (int a = 0; a < 2; a++) {
      vec2 p = a == 0 ? lo : lo.yx;                       // streets along y, then along x
      float k0 = floor(p.x / B + 0.5);
      for (int t = -1; t <= 1; t++) {
        float k = k0 + float(t);
        vec2 hk = hash22(vec2(k, float(a) * 57.0 + floor(rnd * 64.0)));
        float xs = (k + 0.5 * (hk.x - 0.5)) * B;          // irregular street spacing
        float mainRd = step(0.8, hk.y);
        float sp = mix(S, 22.0, mainRd);
        float ph = hk.x * sp;
        float jj = floor((p.y - ph) / sp + 0.5);
        vec2 dv = p - vec2(xs, jj * sp + ph);
        float d = length(dv);
        if (d < best) {
          vec2 hl = hash22(vec2(jj, k * 1.37 + float(a) * 101.0));
          best = d;
          off = dv;
          spB = sp;
          bright = step(hl.x, mix(onP, 1.0, mainRd)) * mix(0.75, 1.25, mainRd) * (0.8 + 0.4 * hl.y);
          isLed = step(fract(hk.y * 13.7), mix(led, 0.6, mainRd));
        }
      }
    }
    float rs = max(1.0, px * 0.8);                        // the lamp, filtered over the pixel
    float spot = exp(-best * best / (rs * rs)) / (3.1416 * rs * rs);
    // the light on the road: stretched along the street so a street's pools join into a lit
    // line (how a city's street grid reads from the air at night); widened to the pixel
    vec2 sg = max(vec2(7.0, 0.6 * spB), vec2(px * 0.8));
    float pool = exp(-dot(off / sg, off / sg)) / (3.1416 * sg.x * sg.y);
    vec3 pts = mix(SODIUM, LEDW, isLed) * bright * FLUX * (0.8 * spot + 1.4 * pool);
    e = mix(avg, pts + avg * 0.2, detail);
  }
  return e;
}

void main() {
  #include <logdepthbuf_fragment>
  if (uDebugHeight > 0.5) { gl_FragColor = vec4(vH, vWorldXZ, 1.0); return; }
  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;                      // camera -> point
  vec2 xz = vWorldXZ;
  gQ = vRel.xz + uCamMod;
  gDX = dFdx(vRel.xz);
  gDY = dFdy(vRel.xz);
  // the pixel's footprint on the ground, an ellipse: its long and short axes (m)
  float fa = dot(gDX, gDX), fb = dot(gDX, gDY), fc = dot(gDY, gDY);
  float ft = 0.5 * (fa + fc), fd = sqrt(max(ft * ft - (fa * fc - fb * fb), 0.0));
  float px = sqrt(ft + fd);                  // metres per pixel (long axis)
  float pxMin = sqrt(max(ft - fd, 0.0));
  gPx = px;
  // the scale the ground materials resolve: the short axis, up to the anisotropy the texture
  // filtering covers (their analytic patterns filter along their own axes), so the near detail
  // does not end where the long axis of a grazing view reaches a few metres
  #if GROUND_DETAIL > 1
    float pxDetail = max(pxMin, px * 0.25);
  #else
    float pxDetail = max(pxMin, px * 0.5);
  #endif
  float edge = max(abs(xz.x), abs(xz.y));
  float coreW = 1.0 - smoothstep(51200.0 - 4000.0, 51200.0, edge);   // core -> far imagery

  // ---- colour and land cover: far image, core overview, L0 tile near the camera ----
  vec2 uvFar = (xz + 204800.0) / 409600.0;
  vec2 uvCore = (xz + 51200.0) / 102400.0;
  vec3 colCore = texture(uOverview, uvCore).rgb;
  #ifdef USE_L0
    // L0 patches lie in the core; at its edge the overview's 200 m mip stands in for the far image
    vec3 col = coreW < 1.0 ? textureLod(uOverview, uvCore, 3.0).rgb : colCore;
  #else
    vec3 col = texture(uFarColor, uvFar).rgb;
  #endif
  vec4 wA, wB;
  lcSample(uvFar, 2048.0, ivec2(0, 4096), vH, wA, wB);
  if (coreW > 0.0) {
    vec4 cA, cB;
    lcSample(uvCore, 4096.0, ivec2(0), vH, cA, cB);
    wA = mix(wA, cA, coreW); wB = mix(wB, cB, coreW);
  }
  vec4 wC = vec4(0.0);
  vec2 rowDir = vec2(1.0, 0.0);
  float rnd = 0.5;
  float l0w = 0.0;
  vec3 colMean = colCore;
  #ifdef USE_L0
    vec2 uvL0 = (xz - uL0Origin) / 6400.0;
    vec3 colL0 = texture(uL0Color, uvL0).rgb;
    l0w = uL0Fade * (1.0 - smoothstep(9000.0, 14000.0, dist)) * coreW;
    #if GROUND_DETAIL > 1
      float kb = (1.0 - smoothstep(1.5, 3.0, px)) * uGroundDetail;
      if (kb > 0.0) colL0 = mix(colL0, l0Bicubic(uvL0), kb);
    #endif
    colCore = mix(colCore, colL0, l0w);
    if (l0w > 0.0) {
      colMean = mix(colMean, textureLod(uL0Color, uvL0, 2.0).rgb, l0w);
      // the field data's 2 x 2 texels (10 m) around the point, weighted bilinearly
      vec2 p = (xz - uL0Origin) / 10.0 - 0.5;
      vec2 i = floor(p);
      vec2 f = p - i;
      ivec2 ip = ivec2(i);
      uint v00 = texelFetch(uL0Data, clamp(ip, ivec2(0), ivec2(639)), 0).r;
      uint v10 = texelFetch(uL0Data, clamp(ip + ivec2(1, 0), ivec2(0), ivec2(639)), 0).r;
      uint v01 = texelFetch(uL0Data, clamp(ip + ivec2(0, 1), ivec2(0), ivec2(639)), 0).r;
      uint v11 = texelFetch(uL0Data, clamp(ip + ivec2(1, 1), ivec2(0), ivec2(639)), 0).r;
      vec4 S = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
      #if GROUND_DETAIL > 1
        // near the camera: times how alike the imagery is here and at each texel's centre, so
        // a field's edge follows the edge the imagery shows (6.25 m, bicubic) instead of the
        // 10 m grid (joint bilateral upsampling of the field data)
        if (pxDetail < 8.0 && uGroundDetail > 0.0) {
          vec2 tc = (vec2(ip) + 0.5) / 640.0;
          const vec2 D1 = vec2(1.0 / 640.0, 0.0);
          vec3 lp = log2(colL0 + 0.02);
          vec3 e00 = log2(textureLod(uL0Color, tc, 0.7).rgb + 0.02) - lp;
          vec3 e10 = log2(textureLod(uL0Color, tc + D1.xy, 0.7).rgb + 0.02) - lp;
          vec3 e01 = log2(textureLod(uL0Color, tc + D1.yx, 0.7).rgb + 0.02) - lp;
          vec3 e11 = log2(textureLod(uL0Color, tc + D1.xx, 0.7).rgb + 0.02) - lp;
          S *= exp(-vec4(dot(e00, e00), dot(e10, e10), dot(e01, e01), dot(e11, e11)) / 0.12) + 0.05;
          S /= dot(S, vec4(1.0));
        }
      #endif
      vec4 tA = vec4(0.0), tB = vec4(0.0), tC = vec4(0.0);
      classAdd(v00 & 15u, vH, S.x, tA, tB, tC);
      classAdd(v10 & 15u, vH, S.y, tA, tB, tC);
      classAdd(v01 & 15u, vH, S.z, tA, tB, tC);
      classAdd(v11 & 15u, vH, S.w, tA, tB, tC);
      // the land classes sharpened near the camera (a field's edge a metre or two wide, not a
      // 10 m blend); the water keeps its soft shore (surf, wet sand)
      float P = 1.0 + 5.0 * (1.0 - smoothstep(0.5, 4.0, pxDetail)) * uGroundDetail;
      if (P > 1.01) {
        vec3 a3 = pow(tA.yzw, vec3(P));
        vec4 b4 = pow(tB, vec4(P)), c4 = pow(tC, vec4(P));
        float sum = a3.x + a3.y + a3.z + dot(b4, vec4(1.0)) + dot(c4, vec4(1.0));
        if (sum > 1e-6) {
          float k = (1.0 - tA.x) / sum;
          tA.yzw = a3 * k; tB = b4 * k; tC = c4 * k;
        }
      }
      wA = mix(wA, tA, l0w); wB = mix(wB, tB, l0w); wC = tC * l0w;
      // the field under the point (row direction, random): the one with the largest summed
      // weight over the four texels (a field's texels share bits 4-15): its edges run as
      // smooth curves between the texels, no 10 m staircase
      uint g00 = v00 >> 4u, g10 = v10 >> 4u, g01 = v01 >> 4u, g11 = v11 >> 4u;
      float s0 = S.x + (g10 == g00 ? S.y : 0.0) + (g01 == g00 ? S.z : 0.0) + (g11 == g00 ? S.w : 0.0);
      float s1 = S.y + (g00 == g10 ? S.x : 0.0) + (g01 == g10 ? S.z : 0.0) + (g11 == g10 ? S.w : 0.0);
      float s2 = S.z + (g00 == g01 ? S.x : 0.0) + (g10 == g01 ? S.y : 0.0) + (g11 == g01 ? S.w : 0.0);
      float s3 = S.w + (g00 == g11 ? S.x : 0.0) + (g10 == g11 ? S.y : 0.0) + (g01 == g11 ? S.z : 0.0);
      uint vn = v00;
      float sb = s0;
      if (s1 > sb) { vn = v10; sb = s1; }
      if (s2 > sb) { vn = v01; sb = s2; }
      if (s3 > sb) { vn = v11; }
      float th = float((vn >> 4u) & 127u) * (3.14159265 / 128.0);
      rowDir = vec2(cos(th), sin(th));
      rnd = (float(vn >> 11u) + 0.5) / 32.0;
    }
  #endif
  col = mix(col, colCore, coreW);

  // ---- normal (normal maps, tilted with the earth's curvature) ----
  vec2 nC = DECODE_N(texture(uNormalCore, ((xz + 51200.0) / 25.0 + 0.5) / 4097.0).rg);
  #ifdef USE_L0
    vec2 nF = coreW < 1.0 ? DECODE_N(textureLod(uNormalCore, ((xz + 51200.0) / 25.0 + 0.5) / 4097.0, 3.0).rg) : nC;
  #else
    vec2 nF = DECODE_N(texture(uNormalFar, ((xz + 204800.0) / 200.0 + 0.5) / 2049.0).rg);
  #endif
  vec2 nxz = mix(nF, nC, coreW);
  vec3 N = normalize(vec3(nxz.x, sqrt(max(1.0 - dot(nxz, nxz), 0.01)), nxz.y));
  vec2 gradH = -N.xz / max(N.y, 0.05);       // terrain slope dh/dx, dh/dz
  vec3 upP = normalize(vec3(vRel.x / uEarthRadius, 1.0, vRel.z / uEarthRadius));

  // ---- runways (L0 tiles): asphalt and paint over the imagery, premultiplied ----
  vec3 rwPre = vec3(0.0);
  float rwCov = 0.0;
  #ifdef USE_L0
    if (uRwyCount > 0 && l0w > 0.0) {
      float dn = dl(DL_MACRO, 32.0).g;
      float grain = dl(DL_URBAN, 16.0).b - 0.5;
      for (int i = 0; i < ${MAX_RWY}; i++) {
        if (i >= uRwyCount) break;
        vec4 rw = runwayShade(xz, uRwyA[i], uRwyB[i], uRwyC[i], px, dn, grain);
        rwPre = rwPre * (1.0 - rw.a) + rw.rgb * rw.a;
        rwCov = rwCov + rw.a - rwCov * rw.a;
      }
      float k = l0w * smoothstep(9000.0, 5000.0, dist);
      rwPre *= k;
      rwCov *= k;
      wA.x *= 1.0 - rwCov;
    }
  #endif

  // ---- mid-distance detail by land cover (mean-free luminance), fading out with distance ----
  float land = (1.0 - wA.x) * (1.0 - rwCov);
  vec4 dMean = dlMean(DL_MACRO);
  vec4 d1 = dl(DL_MACRO, 256.0);
  vec4 d2 = dlRot(DL_MACRO, 51.2);
  vec4 dd = d1 * 0.62 + d2 * 0.38 - dMean;
  float natural = wA.z + wA.w + wB.w;
  float macro = (wA.y + wC.x) * dd.g * 0.9 + natural * dd.r * 0.7 + (wB.x + wC.y) * dd.r * 0.55 + wB.y * dd.a * 0.6
              + wB.z * dd.b * 0.75 + wC.z * dd.a * 0.3;
  // the ground materials take over below ~6 m per pixel (their own patterns filter themselves)
  #if GROUND_DETAIL > 0
    float nearK = (1.0 - smoothstep(4.0, 8.0, pxDetail)) * uGroundDetail * l0w;
  #else
    float nearK = 0.0;
  #endif
  float macroK = (1.0 - smoothstep(500.0, 4000.0, dist)) * (1.0 - 0.6 * nearK);
  col *= 1.0 + macro * macroK * uDetailStrength * land;

  // ---- near ground materials ----
  vec2 dSlope = vec2(0.0);
  float sunVis = 1.0, cavity = 0.0;
  float fade = 1.0 - smoothstep(0.25, 1.2, px);
  #if GROUND_DETAIL > 0
  if (nearK * land > 0.0) {
    vec3 gm = groundMaterial(col, colMean, wA, wB, wC, rowDir, rnd, vH, gradH, dSlope, sunVis, cavity);
    col = mix(col, gm, nearK * land);
    dSlope *= nearK * land;
    sunVis = mix(1.0, sunVis, nearK * land);
    cavity *= nearK * land;
  }
  #endif
  N = normalize(N / max(N.y, 0.05) + vec3(-dSlope.x, 0.0, -dSlope.y));
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
  // the terrain's own shadow (hills and mountains, horizonMap.js)
  float terrainVis = terrainSunVisibility(xz, vH, upP);
  vec3 albedo = col * uAlbedoGain * (1.0 - rwCov) + rwPre;

  float NdL = max(dot(N, uSunDir), 0.0);
  vec3 skyE = uAmbient * (0.55 + 0.45 * dot(N, upP)) * (1.0 - 0.5 * clamp(cavity, 0.0, 1.0));
  vec3 radiance = albedo * (sunE * NdL * shadow * sunVis * terrainVis + skyE) / PI;

  // ---- water ----
  float water = smoothstep(0.3, 0.7, wA.x);
  // wet sand along the shore (land side)
  float wet = smoothstep(0.02, 0.3, wA.x) * (1.0 - water) * step(vH, 3.0);
  radiance *= 1.0 - 0.35 * wet;
  if (water > 0.0) {
    float t = uTime;
    vec2 qA = gQ / 64.0 + t * vec2(0.013, 0.008);
    vec2 qB = gQ / 16.0 + t * vec2(-0.024, 0.016);
    // the rotated layer uses the camera modulo 1280 m: a 1280 m wrap moves it by ROT * (1280, 0) / 256
    // = (4, 3) whole tiles (with the 256 m coordinate it jumped by (0.8, 0.6) of a tile every 256 m)
    vec2 qC = ROT * (vRel.xz + uCamMod1280) / 256.0 + t * vec2(0.0025, -0.0018);
    vec4 tA = textureGrad(uDetailArr, vec3(qA, DL_WATER), gDX / 64.0, gDY / 64.0);
    vec4 tB = textureGrad(uDetailArr, vec3(qB, DL_WATER), gDX / 16.0, gDY / 16.0);
    vec4 tC = textureGrad(uDetailArr, vec3(qC, DL_WATER), ROT * gDX / 256.0, ROT * gDY / 256.0);
    vec2 sA = tA.rg * 2.0 - 1.0;
    vec2 sB = tB.rg * 2.0 - 1.0;
    vec2 sC = transpose(ROT) * (tC.rg * 2.0 - 1.0);
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
    vec3 spec = sunE * Fs * Dg * 0.25 * shadow * terrainVis * step(0.0, dot(Nw, uSunDir));
    // body colour: the satellite colour of the water (dark offshore, lighter in the shallows)
    vec3 body = albedo * 0.8 * (sunE * max(dot(upP, uSunDir), 0.0) * terrainVis + uAmbient) / PI;
    vec3 wr = body * (1.0 - F) + skyR * F + spec;
    // surf: broken white water in the band where the sea meets the beach (sea level only)
    float surfBand = smoothstep(0.98, 0.6, wA.x) * step(abs(vH), 3.0);
    if (surfBand > 0.0) {
      float crest = tB.b * 0.6 + tA.b * 0.6;
      float foam = surfBand * smoothstep(0.35, 0.75, crest + 0.5 * (1.0 - wA.x));
      vec3 foamC = vec3(0.8) * (sunE * max(dot(upP, uSunDir), 0.0) * terrainVis + uAmbient) / PI;
      wr = mix(wr, foamC, foam * 0.85);
    }
    radiance = mix(radiance, wr, water);
  }

  // ---- city lights at night ----
  // beyond another module's street lamps where it has them (they fade out over the same band)
  // (and there as the glow alone, on every tier: a made-up street grid next to the real one
  // would not continue its streets). Without such a module the street grid is drawn on every
  // tier: the glow alone reads as an evenly lit plain from a few hundred metres, and the grid
  // costs only at night, on built-up pixels.
  float cityK = uCityNear.y > 0.0 ? smoothstep(uCityNear.x, uCityNear.y, dist) : 1.0;
  float cityGrid = uCityNear.y > 0.0 ? 0.0 : 1.0;
  if (uNight > 0.0 && uCityLights > 0.0 && wB.y > 0.05 && cityK > 0.0) {
    radiance += cityLights(xz, wB.y * land, rowDir, rnd, px, cityGrid) * (uNight * uCityLights * cityK);
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
  if (uDebugView > 0.5) {
    // false colours (display-referred, after tone mapping is skipped below)
    vec3 dbg = vec3(0.0);
    if (uDebugView < 1.5) {
      dbg = wA.x * vec3(0.0, 0.3, 0.9) + wA.y * vec3(0.0, 0.45, 0.0) + wA.z * vec3(0.6, 0.6, 0.1) + wA.w * vec3(0.7, 0.9, 0.3)
          + wB.x * vec3(0.9, 0.5, 0.9) + wB.y * vec3(0.9, 0.0, 0.0) + wB.z * vec3(0.7) + wB.w * vec3(0.0, 0.7, 0.7)
          + wC.x * vec3(0.95, 0.6, 0.0) + wC.y * vec3(0.5, 0.0, 0.6) + wC.z * vec3(1.0);
    } else if (uDebugView < 2.5) {
      float th = atan(rowDir.y, rowDir.x) * 2.0;
      dbg = (0.5 + 0.5 * cos(th + vec3(0.0, 2.09, 4.19))) * (0.6 + 0.4 * fract(rnd * 7.0));
    } else if (uDebugView < 3.5) {
      dbg = vec3(nearK * land, fade, sunVis);
    } else if (uDebugView < 4.5) {
      float gr = colMean.g / (colMean.r + colMean.g + colMean.b + 1e-4) - 0.3333;
      float lm = dot(colMean, LUMA);
      float kGreen = smoothstep(0.018, 0.045, gr);
      float kStub = (1.0 - kGreen) * smoothstep(0.25, 0.33, lm);
      dbg = vec3(kStub, kGreen, 1.0 - kGreen - kStub) * wB.x;
    } else {
      // terrain shadow: grey = lit by the sun over the horizon map, red = behind a hill
      dbg = mix(vec3(0.8, 0.0, 0.0), vec3(0.7), terrainVis) * (0.4 + 0.6 * max(NdL, 0.0));
    }
    gl_FragColor = vec4(dbg, 1.0);
    return;
  }

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
