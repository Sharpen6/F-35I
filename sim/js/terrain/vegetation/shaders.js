// Vegetation shaders (three.js ShaderMaterial, GLSL ES 3.0).
//
// Instances (one record per tree, see Scatter.js): aPos = base position (world m, float32),
// aD0 = species | variant << 4 | imagery weight (0..7) << 5, height / 0.125 m, crown width factor * 128, rotation (u8),
// aD1 = imagery colour under the tree (sRGB u8) and a rank 0..1 (thinning, randomness).
//
//   near meshes  per species / variant InstancedMesh, the procedural mesh scaled per tree,
//                wind sway, foliage with ragged (noise) edges, alpha to coverage
//   impostors    one draw for every tree in range: a camera-facing quad showing the frame of
//                the impostor atlas for the view's elevation (frames rendered at start-up from
//                the same meshes), lit per pixel from the frame's normals, per-pixel depth
//   decals       one draw: each tree's silhouette as seen from the sun, projected onto the
//                ground: the shadow, blended over the terrain with its haze kept
//
// Meshes and impostors cross-fade with complementary screen-space dither at the mesh range;
// impostors thin out (by rank) towards the far range. Light: sun through the atmosphere
// (wrapped diffuse, the crown's ambient occlusion, translucency against the light), sky and
// ground ambient, aerial perspective from the sky-view LUT, per vertex, as on the terrain.

import { ATMOSPHERE_PARS } from '../../env/atmosphereGLSL.js';
import { SPECIES_COUNT } from './species.js';

/** Elevation frames per impostor model: 0 .. 90 degrees. */
export const ELEV_FRAMES = 6;

const NOISE = /* glsl */ `
#define VEG_PI 3.141592653589793
// interleaved gradient noise (Jimenez 2014): stable per pixel, well spread
float vegIGN(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }

float vegH13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vegNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(vegH13(i), vegH13(i + vec3(1.0, 0.0, 0.0)), u.x), mix(vegH13(i + vec3(0.0, 1.0, 0.0)), vegH13(i + vec3(1.0, 1.0, 0.0)), u.x), u.y);
  float b = mix(mix(vegH13(i + vec3(0.0, 0.0, 1.0)), vegH13(i + vec3(1.0, 0.0, 1.0)), u.x), mix(vegH13(i + vec3(0.0, 1.0, 1.0)), vegH13(i + vec3(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}
`;

const COMMON = /* glsl */ `
#define VEG_NSP ${SPECIES_COUNT}
#define VEG_FRAMES ${ELEV_FRAMES}
uniform vec4 uSpA[VEG_NSP];   // tint amount, translucency, sway, far range factor
uniform vec4 uSpB[VEG_NSP];   // fluff (ragged crown edge), specular, shadow density, unused
uniform vec3 uSpC[VEG_NSP];   // the species' foliage colour (linear): the tint is a ratio to it
uniform vec4 uVeg;            // x: tint gain, y: wind, z: brightness, w: unused
uniform vec4 uLod;            // x: mesh range, y: mesh fade band, z: far range, w: far fade fraction
uniform vec3 uMainCam;        // the view camera (the shadow pass has its own cameraPosition)
${NOISE}
// mesh weight of a tree at distance d (1: mesh, 0: impostor), per-tree jittered range
float vegMeshWeight(float d, float rank) {
  float r = uLod.x * (0.85 + 0.3 * fract(rank * 7.31));
  return 1.0 - smoothstep(r - uLod.y, r, d);
}

// far fade: higher ranks give up earlier (thinning with distance), each over a band
float vegFarFade(float d, float rank, float farFactor) {
  float r = uLod.z * farFactor * (1.0 - 0.62 * rank);
  return 1.0 - smoothstep(r * (1.0 - uLod.w), r, d);
}
`;

// Lighting: shared by meshes and impostors. NdL / NdU / VdL: the shading normal against the
// sun and the local up, the view direction (camera -> point) against the sun.
const LIGHT = /* glsl */ `
vec3 vegLight(vec3 albedo, float NdL, float NdU, float VdL, float ao, float trans, float spec, float NdH, vec3 sunE) {
  float wrap = 0.42;
  float diff = max(NdL + wrap, 0.0) / (1.0 + wrap);
  // the sun reaches the inside of the crown less
  float sunVis = mix(0.22, 1.0, smoothstep(0.2, 0.95, ao));
  vec3 E = sunE * diff * sunVis;
  // light through the leaves when the sun is behind the tree (rim of the crown brightest)
  float back = pow(max(VdL, 0.0), 3.0) * (0.45 + 0.55 * (1.0 - abs(NdL)));
  vec3 Et = sunE * trans * back * mix(0.5, 1.0, ao);
  vec3 sky = uAmbient * (0.62 + 0.38 * NdU) * ao;
  vec3 gnd = uGroundRadiance * VEG_PI * (0.5 - 0.5 * NdU) * ao;
  vec3 rad = albedo * (E + sky + gnd) / VEG_PI + albedo * vec3(1.15, 1.25, 0.7) * Et / VEG_PI;
  // waxy leaves (citrus, olive): a faint sheen towards the sun
  rad += sunE * spec * pow(max(NdH, 0.0), 24.0) * max(NdL, 0.0) * sunVis * 0.02;
  return rad * uVeg.z;
}
`;

// Coverage of a foliage / frond / fan fragment (0..1, kept above 0.5), and a leaf-scale AO.
const COVERAGE = /* glsl */ `
float vegCoverage(float part, vec2 uv, vec3 obj, float facing, float fluff, out float leafAO) {
  leafAO = 1.0;
  float cov = 1.0;
  if (part < 0.5) {
    // foliage clump: leafy noise, ragged where the surface turns away from the view
    // (three scales: gaps between twigs, sprays and small branches, about 1 m: the lumps that
    // still break a crown's outline at a few hundred metres)
    float n0 = vegNoise(obj * 0.85 + 3.0);
    float n1 = vegNoise(obj * 2.3);
    float n2 = vegNoise(obj * 5.7 + 7.0);
    float nz = 0.3 * n0 + 0.44 * n1 + 0.26 * n2;
    float edge = 1.0 - facing;
    cov = nz + 0.6 - edge * edge * fluff * 1.4;
    leafAO = 0.7 + 0.55 * nz;
  } else if (part > 1.5 && part < 2.5) {
    // palm frond: leaflets angled towards the tip, the rachis along the middle
    float t = uv.x, a = abs(uv.y);
    float ph = t * 26.0 - a * 2.4;
    float f = fract(ph);
    float leaflet = smoothstep(0.0, 0.12, f) * (1.0 - smoothstep(0.36, 0.5, f)) * (1.0 - smoothstep(0.82, 1.0, a));
    float rachis = 1.0 - smoothstep(0.05, 0.12, a);
    cov = max(leaflet, rachis);
    cov = mix(cov, 0.56, smoothstep(0.35, 0.9, fwidth(ph)));
    leafAO = 0.85 + 0.15 * f;
  } else if (part > 2.5) {
    // fan leaf: solid centre, split into segments towards the rim
    float ph = uv.x * 22.0;
    float f = fract(ph);
    float seg = smoothstep(0.04, 0.16, f) * (1.0 - smoothstep(0.84, 0.96, f));
    cov = uv.y < 0.45 ? 1.0 : mix(1.0, seg, smoothstep(0.45, 0.6, uv.y));
    cov = mix(cov, 0.8, smoothstep(0.35, 0.9, fwidth(ph)));
  }
  return cov;
}
`;

// Ground heights (the core's 25 m grid, as the terrain draws its triangles) and the sun hidden by
// the slope a tree stands on.
const GROUND = /* glsl */ `
uniform highp usampler2D uHCore;    // terrain heights (the core, 25 m), as the terrain draws them
float decodeH(uint v) { return float(v) * 0.05 - 500.0; }
float hCore(ivec2 p) { return decodeH(texelFetch(uHCore, clamp(p, ivec2(0), ivec2(4096)), 0).r); }
float groundAt(vec2 xz) {
  vec2 c = clamp((xz + 51200.0) / 25.0, vec2(0.0), vec2(4095.999));
  vec2 i = floor(c);
  vec2 f = c - i;
  ivec2 p = ivec2(i);
  float h00 = hCore(p), h10 = hCore(p + ivec2(1, 0)), h01 = hCore(p + ivec2(0, 1)), h11 = hCore(p + ivec2(1, 1));
  // the rendered triangle (split along the north-west / south-east diagonal)
  return f.x >= f.y ? h00 + f.x * (h10 - h00) + f.y * (h11 - h10) : h00 + f.y * (h01 - h00) + f.x * (h11 - h01);
}
// 1 where the sun reaches the tree, 0 where the hillside it stands on faces away from a low sun
// (the terrain is dark there too: no golden crowns on a slope in shade). Flat ground stays lit
// down to sunset; no horizon map, so a valley in a far ridge's shadow is not caught.
float vegSlopeSun(vec2 xz) {
  ivec2 p = ivec2(clamp(floor((xz + 51200.0) / 25.0 + 0.5), vec2(1.0), vec2(4095.0)));
  float dx = hCore(p + ivec2(1, 0)) - hCore(p - ivec2(1, 0));
  float dz = hCore(p + ivec2(0, 1)) - hCore(p - ivec2(0, 1));
  return smoothstep(-0.08, 0.02, dot(normalize(vec3(-dx, 50.0, -dz)), uSunDir));
}
`;

// ------------------------------------------------------------------------------------------
// near meshes

export const MESH_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
${ATMOSPHERE_PARS}
${COMMON}
${GROUND}
attribute vec3 aPos;
attribute vec4 aD0;
attribute vec4 aD1;
attribute vec3 aColor;
attribute vec4 aVert;

varying vec3 vRel;
varying vec3 vN;
varying vec3 vAlbedo;
varying vec3 vObj;
varying vec2 vUv;
varying float vAO;
flat varying float vPart;
flat varying float vSp;
varying float vFade;
#ifndef VEG_DEPTH
varying vec3 vSunE;
varying vec3 vT;
varying vec3 vIns;
#endif

void main() {
  float spv = floor(aD0.x * 255.0 + 0.5);
  int sp = int(mod(spv, 16.0));
  float h = aD0.y * 255.0 * 0.125;
  float wf = aD0.z * 255.0 / 128.0;
  float rot = aD0.w * 6.2831853;
  float rank = aD1.w;
  vec3 relMain = aPos - uMainCam;
  float d = length(relMain + vec3(0.0, 0.5 * h, 0.0));
  float m = vegMeshWeight(d, rank);
  vFade = m;
  if (m <= 0.0 || h <= 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    #include <logdepthbuf_vertex>
    return;
  }
  vec3 p = position * vec3(h * wf, h, h * wf);
  float c = cos(rot), s = sin(rot);
  p.xz = mat2(c, s, -s, c) * p.xz;
  vObj = p + vec3(rank * 37.0, 0.0, rank * 91.0);
  // wind: the crown sways (slow), leaves shiver (fast); gusts travel across the land
  float sw = aVert.w * uSpA[sp].z * uVeg.y;
  float ph = uTime * (1.1 + 0.5 * rank) + rank * 6.2831 + dot(aPos.xz, vec2(0.021, 0.013));
  p.xz += vec2(sin(ph), cos(ph * 0.83)) * sw * 0.011 * h + vec2(sin(uTime * 7.3 + p.y * 3.1), 0.0) * sw * 0.004 * h;
  vec3 n = normal / vec3(wf, 1.0, wf);
  n.xz = mat2(c, s, -s, c) * n.xz;
  vN = normalize(n);
  vec3 rel = aPos - cameraPosition + p;
  rel.y -= atmoCurvatureDrop(rel.xz);
  vRel = rel;
  // per tree: brightness and a little hue variation; the imagery's colour blends in, as a ratio
  // to the species' own colour (the crown keeps its light and dark sprays)
  float j = fract(rank * 13.7 + aD0.w * 3.1);
  vec3 tint = clamp(pow(aD1.rgb, vec3(2.2)) * uVeg.x / max(uSpC[sp], vec3(1e-3)), 0.25, 3.0);
  float ta = uSpA[sp].x * (aVert.y > 0.5 && aVert.y < 1.5 ? 0.25 : 1.0);
  vAlbedo = aColor * mix(vec3(1.0), tint, ta) * (0.86 + 0.28 * j) * vec3(1.0 + 0.06 * (j - 0.5), 1.0, 1.0 - 0.08 * (j - 0.5));
  vUv = uv;
  vAO = aVert.x;
  vPart = aVert.y;
  vSp = float(sp);
  vec4 mvPosition = vec4(mat3(viewMatrix) * rel, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #ifndef VEG_DEPTH
    float hW = aPos.y + p.y;
    float L = length(rel);
    vSunE = atmoSunIrradianceAt(rel, hW) * vegSlopeSun(aPos.xz);
    atmoAerialParts(rel / max(L, 1e-3), L, hW, vT, vIns);
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vec4 worldPosition = vec4(rel + cameraPosition, 1.0);
      vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * worldPosition;
    #endif
  #endif
}
`;

export const MESH_FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
uniform bool receiveShadow;
${ATMOSPHERE_PARS}
${COMMON}
${LIGHT}
${COVERAGE}
varying vec3 vRel;
varying vec3 vN;
varying vec3 vAlbedo;
varying vec3 vObj;
varying vec2 vUv;
varying float vAO;
flat varying float vPart;
flat varying float vSp;
varying float vFade;
#ifndef VEG_DEPTH
varying vec3 vSunE;
varying vec3 vT;
varying vec3 vIns;
#endif

void main() {
  #include <logdepthbuf_fragment>
  // complementary dither with the impostor of the same tree
  if (vegIGN(gl_FragCoord.xy) >= vFade) discard;
  int sp = int(vSp + 0.5);
  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  float leafAO;
  float cov = vegCoverage(vPart, vUv, vObj, abs(dot(N, V)), uSpB[sp].x, leafAO);
  float alpha = clamp((cov - 0.5) / max(fwidth(cov), 1e-3) + 0.5, 0.0, 1.0);
  if (alpha < 0.03) discard;
  #ifdef VEG_DEPTH
    gl_FragColor = vec4(1.0);
  #else
    float ao = vAO * leafAO;
    vec3 up = normalize(vec3(vRel.x / uEarthRadius, 1.0, vRel.z / uEarthRadius));
    float shadow = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      if (receiveShadow) {
        DirectionalLightShadow sh = directionalLightShadows[ 0 ];
        shadow = getShadow( directionalShadowMap[ 0 ], sh.shadowMapSize, sh.shadowIntensity, sh.shadowBias, sh.shadowRadius, vDirectionalShadowCoord[ 0 ] );
      }
    #endif
    vec3 H = normalize(uSunDir - V);
    vec3 rad = vegLight(vAlbedo, dot(N, uSunDir), dot(N, up), dot(V, uSunDir), ao, uSpA[sp].y, uSpB[sp].y, dot(N, H), vSunE * shadow);
    gl_FragColor = vec4(rad * vT + vIns, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  #endif
}
`;

// ------------------------------------------------------------------------------------------
// impostors

const IMPOSTOR_PARS = /* glsl */ `
uniform vec4 uModel[VEG_NSP * 2];     // x: bounding sphere radius about (0, 0.5, 0) (unit tree)
`;

export const IMPOSTOR_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
${ATMOSPHERE_PARS}
${COMMON}
${IMPOSTOR_PARS}
${GROUND}
attribute vec3 aPos;
attribute vec4 aD0;
attribute vec4 aD1;
attribute vec2 corner;

varying vec2 vUv;
flat varying vec3 vLayer;      // layer of frame k0, of frame k1, blend
flat varying vec3 vLb;         // sun direction in billboard space
flat varying vec3 vUb;         // up in billboard space
flat varying vec4 vP;          // mesh weight, far fade, depth scale (m), VdL
flat varying vec4 vS;          // tint amount, translucency, specular, NdH helper
varying vec3 vTint;
varying vec3 vSunE;
varying vec3 vT;
varying vec3 vIns;
varying vec3 vHb;              // half vector in billboard space

void cull() { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); }

void main() {
  float spv = floor(aD0.x * 255.0 + 0.5);
  int sp = int(mod(spv, 16.0));
  int variant = int(mod(floor(spv / 16.0), 2.0));
  float h = aD0.y * 255.0 * 0.125;
  float wf = aD0.z * 255.0 / 128.0;
  float rank = aD1.w;
  vec3 rel = aPos - cameraPosition;
  vec3 cRel = rel + vec3(0.0, 0.5 * h, 0.0);
  float d = length(cRel);
  float m = h > 0.0 ? vegMeshWeight(d, rank) : 1.0;
  float far = vegFarFade(d, rank, uSpA[sp].w);
  int model = sp * 2 + variant;
  float S = uModel[model].x * h * 1.02;
  // culling: empty slot, fully a mesh, faded out, outside the view
  vec3 cView = mat3(viewMatrix) * cRel;
  vec4 cc = projectionMatrix * vec4(cView, 1.0);
  float rc = S * max(projectionMatrix[0][0], projectionMatrix[1][1]);
  bool outside = cc.w < -S || cc.x < -cc.w - rc || cc.x > cc.w + rc || cc.y < -cc.w - rc || cc.y > cc.w + rc;
  if (m >= 1.0 || far <= 0.0 || outside) {
    cull();
    #include <logdepthbuf_vertex>
    return;
  }
  cRel.y -= atmoCurvatureDrop(cRel.xz);
  vec3 V = cRel / max(d, 1e-3);
  vec3 hr = vec3(-V.z, 0.0, V.x);
  float hl = length(hr);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 R = hl > 0.02 ? hr / hl : normalize(vec3(camRight.x, 0.0, camRight.z) + 1e-5);
  vec3 U = cross(R, V);
  float elev = asin(clamp(-V.y, -1.0, 1.0));
  float fk = clamp(elev, 0.0, 0.5 * VEG_PI) / (0.5 * VEG_PI) * float(VEG_FRAMES - 1);
  float k0 = min(floor(fk), float(VEG_FRAMES - 2));
  float base = float(model * VEG_FRAMES);
  vLayer = vec3(base + k0, base + k0 + 1.0, fk - k0);
  float se = clamp(sin(elev), 0.0, 1.0);
  float hw = S * wf, hh = S * mix(1.0, wf, se);
  vec3 P = cRel + R * corner.x * hw + U * corner.y * hh;
  float mirror = fract(rank * 5.3 + aD0.w * 11.0) < 0.5 ? -1.0 : 1.0;
  vUv = vec2(mirror > 0.0 ? corner.x * 0.5 + 0.5 : 0.5 - corner.x * 0.5, corner.y * 0.5 + 0.5);
  vec3 Rm = R * mirror;
  vec3 up = normalize(vec3(cRel.x / uEarthRadius, 1.0, cRel.z / uEarthRadius));
  vLb = vec3(dot(uSunDir, Rm), dot(uSunDir, U), dot(uSunDir, -V));
  vUb = vec3(dot(up, Rm), dot(up, U), dot(up, -V));
  vec3 Hw = normalize(uSunDir - V);
  vHb = vec3(dot(Hw, Rm), dot(Hw, U), dot(Hw, -V));
  #ifndef USE_LOGARITHMIC_DEPTH_BUFFER
    // no per-pixel depth: pull the quad towards the eye (same screen position) so its lower part
    // does not cut into the ground
    P *= 1.0 - min(0.4 * S, 0.5 * length(P)) / max(length(P), 1e-3);
  #endif
  vP = vec4(m, far, S, dot(V, uSunDir));
  // the imagery's colour decides more with distance: far trees match the ground they stand on
  float ta = uSpA[sp].x;
  vS = vec4(mix(ta, max(ta, 0.9), smoothstep(250.0, 1500.0, d)), uSpA[sp].y, uSpB[sp].y, 0.0);
  float j = fract(rank * 13.7 + aD0.w * 3.1);
  vTint = clamp(pow(aD1.rgb, vec3(2.2)) * uVeg.x / max(uSpC[sp], vec3(1e-3)), 0.25, 3.0);
  vS.w = 0.86 + 0.28 * j;
  float hWc = aPos.y + 0.5 * h;
  vSunE = atmoSunIrradianceAt(cRel, hWc) * vegSlopeSun(aPos.xz);
  atmoAerialParts(V, d, hWc, vT, vIns);
  vec4 mvPosition = vec4(mat3(viewMatrix) * P, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    vec4 worldPosition = vec4(P + cameraPosition, 1.0);
    vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * worldPosition;
  #endif
}
`;

export const IMPOSTOR_FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
uniform bool receiveShadow;
${ATMOSPHERE_PARS}
${COMMON}
${LIGHT}
uniform highp sampler2DArray uAtlasA;   // albedo (sRGB) + coverage
uniform highp sampler2DArray uAtlasN;   // normal x / y (billboard space), depth, ambient occlusion
varying vec2 vUv;
flat varying vec3 vLayer;
flat varying vec3 vLb;
flat varying vec3 vUb;
flat varying vec4 vP;
flat varying vec4 vS;
varying vec3 vTint;
varying vec3 vSunE;
varying vec3 vT;
varying vec3 vIns;
varying vec3 vHb;

void main() {
  if (vegIGN(gl_FragCoord.xy) < vP.x) discard;    // the mesh draws these pixels
  vec4 a0 = texture(uAtlasA, vec3(vUv, vLayer.x));
  vec4 a1 = texture(uAtlasA, vec3(vUv, vLayer.y));
  vec4 A = mix(a0, a1, vLayer.z);
  float cov = A.a;
  float alpha = clamp((cov - 0.5) / max(fwidth(cov), 1e-3) + 0.5, 0.0, 1.0) * vP.y;
  if (alpha < 0.03) discard;
  vec4 n0 = texture(uAtlasN, vec3(vUv, vLayer.x));
  vec4 n1 = texture(uAtlasN, vec3(vUv, vLayer.y));
  vec4 Nn = mix(n0, n1, vLayer.z);
  #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
    float off = (Nn.z * 2.0 - 1.0) * vP.z;
    gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(max(vFragDepth - off, 1.0)) * logDepthBufFC * 0.5;
  #endif
  vec2 nxy = Nn.xy * 2.0 - 1.0;
  vec3 n = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
  float shadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    if (receiveShadow) {
      DirectionalLightShadow sh = directionalLightShadows[ 0 ];
      shadow = getShadow( directionalShadowMap[ 0 ], sh.shadowMapSize, sh.shadowIntensity, sh.shadowBias, sh.shadowRadius, vDirectionalShadowCoord[ 0 ] );
    }
  #endif
  vec3 albedo = A.rgb * mix(vec3(1.0), vTint, vS.x) * vS.w;
  vec3 rad = vegLight(albedo, dot(n, vLb), dot(n, vUb), vP.w, Nn.w, vS.y, vS.z, dot(n, normalize(vHb)), vSunE * shadow);
  gl_FragColor = vec4(rad * vT + vIns, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ------------------------------------------------------------------------------------------
// ground shadows (decals)

export const DECAL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${ATMOSPHERE_PARS}
${COMMON}
${IMPOSTOR_PARS}
${GROUND}
uniform vec4 uShadow;               // x: range, y: strength, z: fade fraction, w: on (0 / 1)
attribute vec3 aPos;
attribute vec4 aD0;
attribute vec4 aD1;
attribute vec2 corner;
varying vec2 vUv;
flat varying float vLayer;
varying float vK;
varying vec3 vIns;

void cull() { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); }

void main() {
  float spv = floor(aD0.x * 255.0 + 0.5);
  int sp = int(mod(spv, 16.0));
  int variant = int(mod(floor(spv / 16.0), 2.0));
  float h = aD0.y * 255.0 * 0.125;
  float wf = aD0.z * 255.0 / 128.0;
  float rank = aD1.w;
  vec3 rel = aPos - cameraPosition;
  float d = length(rel + vec3(0.0, 0.5 * h, 0.0));
  vec3 L = uSunDir;
  float range = uShadow.x * (1.0 - 0.5 * rank);
  float fade = 1.0 - smoothstep(range * (1.0 - uShadow.z), range, d);
  fade *= smoothstep(0.03, 0.12, L.y) * vegFarFade(d, rank, uSpA[sp].w);
  if (h <= 0.0 || fade <= 0.0 || uShadow.w < 0.5) {
    cull();
    #include <logdepthbuf_vertex>
    return;
  }
  int model = sp * 2 + variant;
  float S = uModel[model].x * h * 1.02;
  // the tree's silhouette as the sun sees it (the impostor frame for the sun's elevation) ...
  vec3 Vs = -L;
  vec3 R = normalize(vec3(L.z, 0.0, -L.x) + 1e-6);
  vec3 U = cross(R, Vs);
  float elev = asin(clamp(L.y, 0.0, 1.0));
  float k = floor(clamp(elev / (0.5 * VEG_PI) * float(VEG_FRAMES - 1) + 0.5, 0.0, float(VEG_FRAMES - 1)));
  vLayer = float(model * VEG_FRAMES) + k;
  float se = sin(elev);
  vec3 C = rel + vec3(0.0, 0.5 * h, 0.0);
  vec3 Q = C + R * corner.x * S * wf + U * corner.y * S * mix(1.0, wf, se);
  // ... projected along the sun onto the level of the tree's base, then laid on the ground
  float t = (Q.y - rel.y) / max(L.y, 0.03);
  vec3 G = Q - L * t;
  // long shadows of low sun: not past ~5 tree heights
  vec2 off = G.xz - rel.xz;
  float lim = 5.0 * h + S;
  if (length(off) > lim) G.xz = rel.xz + off * lim / length(off);
  vec2 world = G.xz + cameraPosition.xz;
  G.y = groundAt(world) - cameraPosition.y;
  G.y -= atmoCurvatureDrop(G.xz);
  float gl = length(G);
  vec3 Gv = G * (1.0 - min(0.25 + 0.0015 * gl, 0.2 * gl) / max(gl, 1e-3));
  float mirror = fract(rank * 5.3 + aD0.w * 11.0) < 0.5 ? -1.0 : 1.0;
  vUv = vec2(mirror > 0.0 ? corner.x * 0.5 + 0.5 : 0.5 - corner.x * 0.5, corner.y * 0.5 + 0.5);
  // darkening: the share of the ground's light that comes straight from the sun
  float hG = G.y + cameraPosition.y;
  vec3 sunE = atmoSunIrradianceAt(G, hG) * max(L.y, 0.0);
  vec3 skyE = uAmbient;
  float ls = dot(sunE, vec3(0.2126, 0.7152, 0.0722)), la = dot(skyE, vec3(0.2126, 0.7152, 0.0722));
  float kLin = ls / max(ls + la, 1e-4);
  // where the tree took the imagery's colour, the imagery shows it with its shadow already
  // (a forest's ground is canopy and shade): lighter there than under a lone tree in a field
  float wImg = floor(spv / 32.0) / 7.0;
  vK = kLin * uShadow.y * fade * (0.75 + 0.25 * uSpB[sp].z) * (1.0 - 0.45 * wImg) * vegSlopeSun(aPos.xz);
  vec3 tt;
  atmoAerialParts(G / max(gl, 1e-3), gl, hG, tt, vIns);
  vec4 mvPosition = vec4(mat3(viewMatrix) * Gv, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
}
`;

export const DECAL_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform highp sampler2DArray uAtlasA;
varying vec2 vUv;
flat varying float vLayer;
varying float vK;
varying vec3 vIns;

void main() {
  #include <logdepthbuf_fragment>
  // a softer silhouette (bias towards a coarser mip): penumbra
  float cov = texture(uAtlasA, vec3(vUv, vLayer), 1.0).a;
  float kLin = smoothstep(0.12, 0.7, cov) * vK;
  if (kLin < 0.004) discard;
  vec3 ins = vIns;
  float k = kLin;
  #ifdef TONE_MAPPING
    // the frame is tone mapped and encoded: darken by the encoded ratio
    ins = toneMapping(ins);
    k = 1.0 - pow(max(1.0 - kLin, 0.0), 0.45);
  #endif
  ins = linearToOutputTexel(vec4(ins, 1.0)).rgb;
  // blended ONE, ONE_MINUS_SRC_ALPHA: ground * (1 - k) + haze * k
  gl_FragColor = vec4(ins * k, k);
}
`;

// ------------------------------------------------------------------------------------------
// impostor bake (multiple render targets: albedo + coverage, normal + depth + ao)

export const BAKE_VERT = /* glsl */ `
uniform float uRefHeight;     // metres: the leaf noise is in metres, as on the near meshes
uniform float uSphere;        // bounding sphere radius of the model (unit tree)
in vec3 aColor;
in vec4 aVert;
out vec3 vN;
out vec3 vAlbedo;
out vec3 vObj;
out vec2 vUv2;
out float vAO;
out float vPart;
out float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 c = modelViewMatrix * vec4(0.0, 0.5, 0.0, 1.0);
  vDepth = (mv.z - c.z) / uSphere;
  vN = normalize(normalMatrix * normal);
  vAlbedo = aColor;
  vObj = position * uRefHeight;
  vUv2 = uv;
  vAO = aVert.x;
  vPart = aVert.y;
  gl_Position = projectionMatrix * mv;
}
`;

export const BAKE_FRAG = /* glsl */ `
precision highp float;
uniform vec4 uSpB[${SPECIES_COUNT}];
uniform int uSp;
in vec3 vN;
in vec3 vAlbedo;
in vec3 vObj;
in vec2 vUv2;
in float vAO;
in float vPart;
in float vDepth;
layout(location = 0) out vec4 gAlbedo;
layout(location = 1) out vec4 gNormal;
${NOISE}
${COVERAGE}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  float leafAO;
  float cov = vegCoverage(vPart, vUv2, vObj, abs(N.z), uSpB[uSp].x, leafAO);
  if (cov < 0.5) discard;
  // impostors are seen from the front: a normal pointing away is folded towards the viewer
  N.z = abs(N.z);
  gAlbedo = vec4(toSRGB(clamp(vAlbedo, 0.0, 1.0)), 1.0);
  gNormal = vec4(N.xy * 0.5 + 0.5, clamp(vDepth * 0.5 + 0.5, 0.0, 1.0), clamp(vAO * leafAO, 0.0, 1.0));
}
`;
