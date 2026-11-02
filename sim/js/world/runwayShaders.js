// Runway surface shaders (three.js ShaderMaterial, GLSL ES 3.0): the draped runway meshes of
// js/world/runwayMesh.js, drawn over the terrain's own runway paint (js/world/Runways.js).
//
// Vertex: as js/world/roadShaders.js: positions relative to the mesh origin, camera-relative
// through modelViewMatrix (double precision on the CPU), lowered by the earth's curvature as the
// terrain is, so a vertex lands where the terrain triangle under it is.
//
// Fragment, in the runway frame (s along from end 0, t to the right, metres):
//   tone      the pavement's albedo (Runways.js PAVE: aged asphalt 0.10-0.20 by how light the
//             imagery shows the runway, concrete ends ~0.25) times the light and dark sections of
//             the imagery's own pavement (data strip: paint taken out) relative to the runway's
//             median, tinted a little by it; far away it turns into the imagery's own tone, which
//             the terrain shows once the surface has faded out, so there is no step. The strip's
//             alpha is the share m of the surface the imagery shows darkened by rubber and oil;
//             the clean pavement is then tone / (1 - (1 - RUBBER_DARK) m) and the deposits are
//             drawn as streaks along the runway whose mean cover is m (far away, where the streaks
//             filter out, exactly m: the mean is the imagery's again).
//   asphalt   paving lanes with their own tone, sealed longitudinal joints, sealed transverse
//             cracks, meandering sealed cracks, darker patches, aggregate grain, oil drips;
//   concrete  where the data puts concrete ends: slabs with their own tone, sealed joints, the
//             odd replaced or cracked slab;
//   shoulders older, dustier, more cracked asphalt; blast pads with yellow chevrons;
//   markings  ICAO Annex 14 (threshold stripes, designation, centreline, aiming point, touchdown
//             zone pattern A, edge stripes, displaced threshold arrows): worn, chipped, crossed by
//             the sealant, blackened by the rubber in the touchdown zone;
//   by day    arresting gear (yellow discs, the cable on its rubber supports), inset light
//             fixtures (centreline, touchdown zone, threshold / end bars), tyre marks of the
//             turns onto and off the runway at the taxiways.
// Every pattern is box-filtered by the pixel's footprint along and across the runway (band()),
// and the noise comes from a mipmapped texture sampled with true gradients, so nothing crawls
// or shimmers; detail too fine for the pixel fades into its mean.
// Lit like the terrain (sun through the atmosphere, sky, the shadow map, the terrain's own
// horizon shadow), a GGX sheen (rubber is glossier than the dusty pavement), the terrain's aerial
// perspective, faded out with distance into the imagery.
//
// Depth: pulled towards the camera by (5 + priority) steps (roadShaders.js: 2 units of a 24-bit
// buffer and 1.2 % of the depth change across a pixel) near the camera, where the overlay lies in
// the terrain's exact mesh, and by up to 64 more steps between 3.2 and 12 km, where the coarser
// terrain levels leave the flat runway by up to about a metre. Taxiways (39+ steps) and aprons
// (7+) of js/world/roadShaders.js stay on top of the runway shoulders they cross.

import { ATMOSPHERE_PARS, ATMOSPHERE_CORE } from '../env/atmosphereGLSL.js';

/** Rows of a runway's strip in the atlas: the data's rows with STRIP_PAD repeated each side. */
export const STRIP_PAD = 4;
/** Columns of the per-runway data texture (Runways.js packs it). */
export const DATA_W = 32;
export const MAX_TURNS = 16;
export const MAX_CROSS = 4;

export const RUNWAY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
${ATMOSPHERE_CORE}

attribute vec2 aST;          // s along the runway from end 0, t to the right (m)
attribute vec2 aNrm;         // terrain normal x, z
attribute float aRw;         // the runway's row in the data texture

varying vec3 vRel;
varying float vH;
varying vec2 vST;
varying vec2 vNrm;
flat varying float vRw;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 rel = mv.xyz * mat3(viewMatrix);          // camera-relative, world axes
  rel.y -= atmoCurvatureDrop(rel.xz);
  vRel = rel;
  vH = world.y;
  vST = aST;
  vNrm = aNrm;
  vRw = aRw;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * rel, 1.0);
  #include <logdepthbuf_vertex>
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * vec4(rel + cameraPosition, 1.0);
  #endif
}
`;

/**
 * The fragment shader; horizonGlsl: the terrain's HORIZON_GLSL (terrainSunVisibility) when the
 * terrain has horizon maps (Runways.js loads it, as Roads.js does).
 */
export const runwayFrag = (horizonGlsl = '') => /* glsl */ `
#include <common>
#include <packing>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
uniform bool receiveShadow;
${ATMOSPHERE_PARS}
${horizonGlsl ? horizonGlsl + '\n#define RWY_TERRAIN_SHADOW 1' : ''}

uniform sampler2D uStrip;        // imagery strips (sRGB rgb, deposits a), STRIP_PAD rows each side
uniform highp sampler2D uRwData; // per runway: ${DATA_W} RGBA32F texels (Runways.js _dataTexture)
uniform sampler2D uNoise;        // tiling noise: r grain, g blotches, b streaks / stains, a large patches
uniform sampler2D uGlyphs;       // runway digits and letters "0123456789LRC", 4 x 4 cells
uniform vec4 uFade;              // fade-out start, end (m), detail (0..1), layers in the atlas
uniform float uAlbedoGain;       // the terrain's imagery -> albedo factor

varying vec3 vRel;
varying float vH;
varying vec2 vST;
varying vec2 vNrm;
flat varying float vRw;

const float RUBBER_DARK = 0.3;   // rubber deposits / clean pavement (airfields.py RUBBER_DARK)
const vec3 PAINT_W = vec3(0.68, 0.68, 0.66);
const vec3 PAINT_Y = vec3(0.60, 0.43, 0.06);

// box-filtered coverage of the band [a, b] at x for a pixel footprint w
float band(float x, float a, float b, float w) {
  return clamp((min(b, x + 0.5 * w) - max(a, x - 0.5 * w)) / w, 0.0, 1.0);
}
// periodic dashes along x: on for [0, on) of every period; the duty cycle once below a pixel
float dashes(float x, float period, float on, float w) {
  float f = mod(x, period);
  float c = band(f, 0.0, on, w) + band(f, period, period + on, w) + band(f, -period, on - period, w);
  return mix(min(c, 1.0), on / period, smoothstep(0.2 * period, 0.5 * period, w));
}
// filled disc of radius r at distance d from its centre, for a footprint w
float disc(float d, float r, float w) { return clamp((r - d) / max(w, 1e-4) + 0.5, 0.0, 1.0); }
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
// a glyph of uGlyphs (index g) in the box q in [0, 1]^2 (x right, y away from the threshold)
float glyph(float g, vec2 q, vec2 dqx, vec2 dqy) {
  if (g < 0.0 || q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
  float G = 4.0;
  float cx = mod(g, G), cy = floor(g / G);
  vec2 uv = vec2((cx + 0.2 + 0.6 * q.x) / G, 1.0 - (cy + 1.0 - q.y) / G);
  vec2 sc = vec2(0.6 / G, 1.0 / G);
  return textureGrad(uGlyphs, uv, dqx * sc, dqy * sc).r;
}

// GGX sheen of the sun on the surface (radiance, scene units)
vec3 sunSpec(vec3 N, vec3 V, vec3 sunE, float rough, vec3 F0) {
  vec3 L = uSunDir;
  vec3 H = normalize(L - V);
  float NdL = max(dot(N, L), 0.0), NdV = max(dot(N, -V), 1e-3), NdH = max(dot(N, H), 0.0);
  float a = rough * rough, a2 = a * a;
  float D = a2 / (PI * pow(NdH * NdH * (a2 - 1.0) + 1.0, 2.0));
  float k = a * 0.5;
  float G = NdL / (NdL * (1.0 - k) + k) * NdV / (NdV * (1.0 - k) + k);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(H, -V), 0.0), 5.0);
  return sunE * D * G * F / (4.0 * NdV);
}

void main() {
  int rw = int(vRw + 0.5);
  vec4 P0 = texelFetch(uRwData, ivec2(0, rw), 0);   // length, half width, shoulder, atlas layer
  vec4 P1 = texelFetch(uRwData, ivec2(1, rw), 0);   // overrun end 0, end 1, displaced threshold end 0, end 1
  vec4 P2 = texelFetch(uRwData, ivec2(2, rw), 0);   // concrete from pavement end 0, end 1, rubber end 0, end 1
  vec4 P3 = texelFetch(uRwData, ivec2(3, rw), 0);   // strip s0, s1, half width T, paint wear
  vec4 P4 = texelFetch(uRwData, ivec2(4, rw), 0);   // flags, designator end 0, end 1, depth priority
  vec4 P5 = texelFetch(uRwData, ivec2(5, rw), 0);   // cable s (two; < 0 none), turn-offs, crossings
  vec4 P6 = texelFetch(uRwData, ivec2(6, rw), 0);   // the imagery's clean pavement (luminance), its albedo

  float dist = max(length(vRel), 1e-3);
  // ---- depth bias (first: derivatives need uniform control flow) ----
  float steps = 5.0 + P4.w + 64.0 * smoothstep(3200.0, 12000.0, dist);
  #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
    float fd = log2( vFragDepth ) * logDepthBufFC * 0.5;
    float slope = max(abs(dFdx(fd)), abs(dFdy(fd)));
    gl_FragDepth = fd - steps * (1.2e-7 + 0.012 * slope);
  #elif defined( USE_REVERSED_DEPTH_BUFFER )
    float fd = gl_FragCoord.z;
    float slope = max(abs(dFdx(fd)), abs(dFdy(fd)));
    gl_FragDepth = fd + steps * (fd * 1.5e-6 + 0.012 * slope);
  #else
    float fd = gl_FragCoord.z;
    float slope = max(abs(dFdx(fd)), abs(dFdy(fd)));
    gl_FragDepth = fd - steps * (1.2e-7 + 0.012 * slope);
  #endif

  // ---- the runway frame, the pixel's footprint, noise, the imagery strip ----
  vec2 st = vST;
  vec2 dX = dFdx(st), dY = dFdy(st);
  float s = st.x, t = st.y;
  float pu = max(length(vec2(dX.x, dY.x)), 1e-4);      // metres per pixel along the runway
  float pv = max(length(vec2(dX.y, dY.y)), 1e-4);      // and across
  vec4 nF = textureGrad(uNoise, st / 6.7, dX / 6.7, dY / 6.7) - 0.5;          // grain (2.6 cm texels)
  vec4 nM = textureGrad(uNoise, st / 47.0, dX / 47.0, dY / 47.0) - 0.5;       // blotches, stains
  vec4 nL = textureGrad(uNoise, st / 331.0, dX / 331.0, dY / 331.0) - 0.5;    // large patches
  vec2 sk = vec2(1.0 / 400.0, 1.0 / 4.0);                                       // streaks along the runway
  vec4 nS = textureGrad(uNoise, st * sk, dX * sk, dY * sk) - 0.5;
  vec2 sk2 = vec2(1.0 / 23.0, 1.0 / 0.9);
  vec4 nT = textureGrad(uNoise, st * sk2 + 0.37, dX * sk2, dY * sk2) - 0.5;     // short tyre marks

  float len = P0.x, hw = P0.y, sh = P0.z;
  float layers = uFade.w;
  float T = P3.z;
  vec2 suv = vec2((s - P3.x) / (P3.y - P3.x), (P0.w * ${(32 + 2 * STRIP_PAD).toFixed(1)} + ${STRIP_PAD.toFixed(1)} + (t + T) / (2.0 * T) * 32.0) / (${(32 + 2 * STRIP_PAD).toFixed(1)} * layers));
  vec2 sg = vec2(1.0 / (P3.y - P3.x), 32.0 / (2.0 * T * ${(32 + 2 * STRIP_PAD).toFixed(1)} * layers));
  vec4 strip = textureGrad(uStrip, suv, dX * sg, dY * sg);
  float detail = uFade.z;

  int flags = int(P4.x + 0.5);
  bool closed = (flags & 2) != 0;
  float wear = P3.w;
  bool end1 = s > 0.5 * len;
  float e = end1 ? len - s : s;                  // from the nearer runway end (< 0: blast pad / overrun)
  float disp = end1 ? P1.w : P1.z;
  float ed = e - disp;                           // from that end's threshold
  float tt = end1 ? -t : t;                      // to the right of a pilot landing on that end
  float at = abs(t);
  float W = hw + sh;
  float lda = len - disp;                        // landing distance on that end (about)
  vec3 V = vRel / dist;

  // ---- coverage: the pavement and shoulders, ragged a little at the outer edge ----
  float rag = sh > 0.5 ? 0.35 * nM.b + 0.15 * nF.g : 0.1 * nM.b;
  float alpha = band(at, -1.0, W + rag, pv + 0.2) * band(s, -P1.x - 0.3 + rag, len + P1.y + 0.3 - rag, pu + 0.2);
  // crossing runways: the primary one draws the crossing (airfields.py runways.json "cross")
  int nCross = int(P5.w + 0.5);
  for (int k = 0; k < ${MAX_CROSS}; k++) {
    if (k >= nCross) break;
    vec4 c0 = texelFetch(uRwData, ivec2(24 + 2 * k, rw), 0);
    vec4 c1 = texelFetch(uRwData, ivec2(25 + 2 * k, rw), 0);
    vec2 r = vec2(s - c0.x, t - c0.y);
    float sb = r.x * c0.z + r.y * c0.w, tb = -r.x * c0.w + r.y * c0.z;
    float pb = max(pu, pv);
    alpha *= 1.0 - band(tb, -c1.x, c1.x, pb) * band(sb, c1.y, c1.z, pb);
  }

  // ---- the pavement's tone; rubber and oil as streaks of mean cover m ----
  // the albedo of the runway's asphalt (P6.y) and of concrete, times the imagery's clean pavement
  // relative to the runway's median (compressed: the 10 m pixels exaggerate it with paint and
  // soil), tinted a little by the imagery (it carries the soil's tint too); far away into the
  // imagery's own pavement, which the terrain shows once the surface has faded out
  vec3 img = srgbToLinear(strip.rgb);
  float m = strip.a;
  float yI = max(dot(img, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  float clean = 1.0 / (1.0 - (1.0 - RUBBER_DARK) * m);
  float rel = pow(clamp(yI * clean / P6.x, 0.5, 2.0), 0.7);
  vec3 tint = mix(vec3(1.0), img / yI, 0.45);
  float farK = smoothstep(0.5 * uFade.x, uFade.x, dist);
  vec3 Pimg = img * clean * uAlbedoGain;
  vec3 P = mix(P6.y * rel * tint, Pimg, farK);
  vec3 Pc = mix(max(1.3 * P6.y, 0.24) * rel * tint, Pimg, farK);
  // touchdown zones: the deposits are tyre marks (long and short streaks) along the lanes the
  // wheels take; elsewhere the keel's darkening is finer and more even
  float tdzZone = band(ed, 120.0, 1100.0, 80.0 + pu) * smoothstep(hw * 0.75, hw * 0.25, at);
  float streak = nS.g * 2.4 + nS.b * 0.8;
  streak = mix(streak * 0.45, streak + nT.b * 1.6, tdzZone);
  float cov = clamp(m * (1.0 + streak * detail), 0.0, 1.0);

  bool onPad = at < hw && e < 0.0;
  float shoulder = 1.0 - band(at, -1.0, hw, pv);
  float fromEnd = end1 ? len + P1.y - s : s + P1.x;      // from the pavement's end
  float concLen = end1 ? P2.y : P2.x;
  float conc = band(fromEnd, -1.0, concLen, pu) * (1.0 - shoulder) * step(0.5, concLen);

  // ---- asphalt: lanes, joints, cracks, patches, grain ----
  float nl = max(floor(hw / 4.6 + 0.5), 1.0);
  float laneW = hw / nl;
  float lane = floor(t / laneW);
  float sec = floor((s + 37.0 * lane) / 280.0);           // paving sessions: ~280 m sections
  float laneTone = 1.0 + 0.07 * (hash21(vec2(lane * 3.1 + vRw * 17.0, sec)) - 0.5) * detail;
  vec3 asph = P * laneTone * (1.0 + 0.22 * nF.r * detail + 0.09 * nM.g + 0.05 * nL.g);
  float sealant = 0.0;
  // longitudinal joints between the paving lanes: sealed (a ~10 cm overband, wavering) in the
  // sections the crews have done, ~70 m pieces each with its own start (more on a worn field)
  float jIdx = lane + (fract(t / laneW) > 0.5 ? 1.0 : 0.0);
  float qj = t - jIdx * laneW;
  float wv = 0.035 * nM.r;
  float jSeg = floor(s / 70.0 + hash11(jIdx * 5.1 + vRw * 3.0));
  float jOn = step(0.6 - 0.3 * wear, hash21(vec2(jSeg, jIdx * 3.3 + vRw)));
  sealant = max(sealant, 0.65 * band(qj + wv, -0.05, 0.05, pv) * jOn * step(at, W));
  // transverse cracks every ~13 m, sealed, across some lanes, wavering
  float cell = floor(s / 13.0);
  float hc = hash11(cell * 1.37 + vRw * 7.1);
  float sc = (cell + 0.15 + 0.7 * hc) * 13.0 + 0.3 * nM.r + 0.12 * nF.g;
  float laneOn = step(0.35 + 0.3 * wear, hash21(vec2(cell, lane * 1.7)));
  float crackT = band(s, sc - 0.035, sc + 0.035, pu) * laneOn * step(0.25, hc);
  // meandering sealed cracks (the zero line of a smooth noise), more on the old shoulders
  float nmz = nM.g + 0.35 * nF.b;
  float fz = max(fwidth(nmz), 1e-4);
  float meander = band(nmz, -0.004, 0.004, fz) * (1.0 - smoothstep(0.08, 0.3, max(pu, pv)));
  meander *= mix(step(0.15, nL.r + 0.1 * wear), 1.0, shoulder);
  sealant = max(sealant, crackT * (1.0 - smoothstep(0.6, 2.5, pu)));
  sealant = max(sealant, meander);
  // patches: rectangles of newer, darker asphalt in a lane, edges sealed
  float pcell = floor(s / 41.0);
  float hp = hash21(vec2(pcell, lane + vRw * 5.3));
  if (hp > 0.9 && detail > 0.3) {
    float a0 = (pcell + 0.1 + 0.5 * hash11(pcell * 3.1 + lane)) * 41.0;
    float plen = 4.0 + 11.0 * hash11(pcell * 5.3 + lane * 2.0);
    float lo = lane * laneW + 0.4, hi = (lane + 1.0) * laneW - 0.4 - 1.5 * hash11(pcell + lane * 9.0);
    float pa = band(s, a0, a0 + plen, pu) * band(t, lo, hi, pv);
    asph = mix(asph, P * (hp > 0.96 ? 0.82 : 0.68) * (1.0 + 0.15 * nF.r * detail), pa);
    float rim = pa * (1.0 - band(s, a0 + 0.1, a0 + plen - 0.1, pu) * band(t, lo + 0.1, hi - 0.1, pv));
    sealant = max(sealant, rim * (1.0 - smoothstep(0.3, 1.2, pu)));
  }
  // oil and fuel: drips along the keel, stains where the jets hold at the runway ends
  float hold = band(ed, -20.0, 260.0, pu) * smoothstep(4.0, 1.0, at);
  float drip = smoothstep(0.24, 0.36, nM.b + 0.15 * nF.b) * (0.25 + 0.75 * hold) * smoothstep(6.0, 1.5, at);
  asph *= 1.0 - 0.3 * drip * detail;

  // ---- concrete: slabs (7.5 m along, the lanes across), joints, odd slabs ----
  float slabS = floor(s / 7.5);
  float hs = hash21(vec2(slabS, lane * 1.3 + vRw));
  vec3 conCol = Pc * (1.0 + 0.10 * (hs - 0.5) + 0.06 * nM.g + 0.12 * nF.r * detail);
  conCol *= hs > 0.965 ? 1.1 : 1.0;                       // a replaced slab: newer, lighter
  float jT = band(mod(s, 7.5), -0.02, 0.02, pu) + band(mod(s, 7.5), 7.48, 7.52, pu);
  float jL = band(qj, -0.02, 0.02, pv);
  float joints = clamp(jT + jL, 0.0, 1.0);
  // a corner crack across some slabs
  float sx = mod(s, 7.5), sy = t - lane * laneW;
  float cc = band(sx * 0.6 + sy - 2.2 - 0.3 * hs, -0.02, 0.02, max(pu, pv)) * step(0.82, hash11(slabS * 2.3 + lane)) * step(sx, 4.0);
  vec3 conc3 = conCol * (1.0 - 0.45 * joints * (1.0 - smoothstep(0.15, 0.5, max(pu, pv))) * detail);
  conc3 *= 1.0 - 0.4 * cc * (1.0 - smoothstep(0.1, 0.4, max(pu, pv))) * detail;

  vec3 albedo = mix(asph, conc3, conc);
  // shoulders: older, dustier asphalt; blast pads: their own (imagery) tone, a little older
  albedo = mix(albedo, albedo * 1.08 + vec3(0.02, 0.015, 0.006), shoulder);
  // sealant: black and a little glossy, on asphalt (concrete has its own joints)
  albedo = mix(albedo, P * 0.32, sealant * 0.75 * detail * (1.0 - conc));
  // rubber deposits
  vec3 rubberC = P * RUBBER_DARK;
  albedo = mix(albedo, rubberC, cov * (1.0 - shoulder));

  // ---- markings (white; yellow on the blast pads) ----
  float white = 0.0, yellow = 0.0;
  vec2 dqx = vec2(end1 ? -dX.y : dX.y, end1 ? -dX.x : dX.x);
  vec2 dqy = vec2(end1 ? -dY.y : dY.y, end1 ? -dY.x : dY.x);
  if (at < hw + 1.0) {
    // edge stripes (0.9 m, the whole length)
    white = max(white, band(at, hw - 0.9, hw, pv) * step(0.0, e));
    if (e >= -2.0 && ed > -2.0) {
      // threshold stripes 6..36 m (ICAO: 4 / 6 / 8 / 12 / 16 stripes by width, to 3 m from the edge)
      float N = hw >= 29.0 ? 16.0 : hw >= 22.0 ? 12.0 : hw >= 14.0 ? 8.0 : hw >= 11.0 ? 6.0 : 4.0;
      float outer = min(hw - 3.0, 27.0), w = outer / N;
      float stripe = dashes(at - w, 2.0 * w, w, pv) * band(at, 0.0, outer, pv);
      white = max(white, stripe * band(ed, 6.0, 36.0, pu));
      // designation: 9 m digits 48..57 m (with a letter: the letter there, the digits 63..72 m)
      float desig = end1 ? P4.z : P4.y;
      float num = mod(desig, 100.0), suf = floor(desig / 100.0);
      float tens = floor(num / 10.0), ones = mod(num, 10.0);
      float y0 = suf > 0.0 ? 63.0 : 48.0;
      vec2 sq = vec2(1.0 / 4.0, 1.0 / 9.0);
      if (ed > 40.0 && ed < 80.0) {
        float yN = (ed - y0) / 9.0;
        white = max(white, glyph(tens, vec2((tt + 5.0) / 4.0, yN), dqx * sq, dqy * sq));
        white = max(white, glyph(ones, vec2((tt - 1.0) / 4.0, yN), dqx * sq, dqy * sq));
        if (suf > 0.0) white = max(white, glyph(9.0 + suf, vec2((tt + 2.0) / 4.0, (ed - 48.0) / 9.0), dqx * sq, dqy * sq));
      }
      // centreline: 30 m stripes, 20 m gaps, from 12 m past the designation to the other end's
      float clw = hw >= 22.0 ? 0.45 : 0.3;
      float c0 = disp + y0 + 21.0;
      float clOn = band(e, c0, 1e5, pu);
      // one pattern from end 0's first stripe on, cut where end 1's would start
      white = max(white, band(t, -clw, clw, pv) * dashes(s - (P1.z + (P4.y >= 100.0 ? 84.0 : 69.0)), 50.0, 30.0, pu) * clOn);
      // aiming point and touchdown zone (pattern A), for runways long enough
      if (lda >= 1200.0) {
        float aim0 = lda >= 2400.0 ? 400.0 : 300.0;
        float inner = min(9.0, max(4.5, 0.4 * hw)), aw = hw >= 20.0 ? 8.0 : 5.0;
        white = max(white, band(ed, aim0, aim0 + 50.0, pu) * band(at, inner, inner + aw, pv));
        float tz = 0.0;
        for (int k = 1; k <= 6; k++) {
          float e0 = 150.0 * float(k);
          if (abs(e0 - aim0 - 25.0) < 75.0) continue;
          if (e0 > lda * 0.5 - 30.0 || (lda < 2400.0 && k > 4)) break;
          float bars = k <= 2 ? 3.0 : (k <= 5 ? 2.0 : 1.0);
          float lat = dashes(at - inner, 3.3, 1.8, pv) * band(at, inner, inner + bars * 3.3 - 1.5, pv);
          tz = max(tz, band(ed, e0, e0 + 22.5, pu) * lat);
        }
        white = max(white, tz);
      }
      // displaced threshold: the transverse bar and arrows along the centre before it
      if (disp > 0.0) {
        white = max(white, band(ed, -1.8, 0.0, pu) * step(at, hw - 0.9));
        if (ed < 0.0 && e > 0.0) {
          float a = mod(-ed, 60.0);
          float shaft = band(at, 0.0, 0.45, pv) * band(a, 10.0, 40.0, pu);
          float head = band(at, 0.0, 0.45 + 0.6 * (10.0 - a), pv) * band(a, 2.0, 10.0, pu) * step(a, 10.0);
          white = max(white, max(shaft, head) * step(10.0, -ed));
        }
      }
    }
  }
  if (onPad) {
    // blast pad / overrun: yellow chevrons 30 m apart pointing at the runway, 0.9 m wide
    float u = -e - at;
    yellow = max(yellow, band(mod(u, 30.0), 0.0, 1.27, max(pu, pv)) * step(8.0, -e) * step(-e, P1.x + P1.y + 1.0));
  }
  // arresting gear: yellow discs 3 m across, 9 m apart, over the cable
  for (int k = 0; k < 2; k++) {
    float cs = k == 0 ? P5.x : P5.y;
    if (cs < 0.0) continue;
    float ds = s - cs;
    if (abs(ds) < 4.0 && at < hw + 3.0) {
      float kk = floor(t / 9.0 + 0.5);
      float dd = length(vec2(ds, t - kk * 9.0));
      yellow = max(yellow, disc(dd, 1.5, max(pu, pv)) * step(abs(kk * 9.0), hw - 1.6));
    }
  }
  float wearN = smoothstep(-0.3, 0.25, nM.g + 0.6 * nF.g - 0.55 * wear + 0.25);
  float paintVis = mix(0.55, 1.0, wearN * (1.0 - 0.6 * wear)) * (1.0 - 0.92 * cov) * (1.0 - 0.8 * sealant);
  white = clamp(white, 0.0, 1.0) * paintVis * mix(1.0, 0.45, float(closed));
  yellow = clamp(yellow, 0.0, 1.0) * paintVis;
  albedo = mix(albedo, PAINT_W * (0.92 + 0.15 * nM.g), white);
  albedo = mix(albedo, PAINT_Y * (0.92 + 0.15 * nM.g), yellow);

  // ---- by day: the cable, inset light fixtures, tyre marks of the turns ----
  float pmax = max(pu, pv);
  float small = 1.0 - smoothstep(0.08, 0.3, pmax);           // centimetre detail fades out
  for (int k = 0; k < 2; k++) {
    float cs = k == 0 ? P5.x : P5.y;
    if (cs < 0.0) continue;
    // 32 mm steel cable on rubber supports every 2.4 m, across the runway and the shoulders
    float ds = s - cs;
    float cable = band(ds, -0.016, 0.016, pu) * step(at, W + 1.0);
    float sup = disc(length(vec2(ds, mod(t + 1.2, 2.4) - 1.2)), 0.09, pmax) * step(at, W);
    albedo = mix(albedo, vec3(0.05, 0.05, 0.052), max(cable * 0.9, sup) * small);
  }
  // inset lights: steel rings 30 cm across with a lens slot (centreline every 30 m, touchdown
  // zone barrettes every 60 m to 900 m, threshold / end bars every ~3 m)
  bool lit = (flags & 4) != 0;
  if (lit && small > 0.0 && at < hw + 1.0) {
    float fix = 0.0;
    bool cl = (flags & 24) != 0;
    if (cl && ed > 30.0) fix = max(fix, disc(length(vec2(mod(s - P1.z - 30.0 + 15.0, 30.0) - 15.0, t)), 0.15, pmax));
    bool tdzL = (flags & (end1 ? 64 : 32)) != 0;
    if (tdzL && ed > 30.0 && ed < 930.0) {
      float ee = mod(ed + 30.0, 60.0) - 30.0;
      float lt = at < 9.75 ? 9.0 : at < 11.25 ? 10.5 : 12.0;
      fix = max(fix, disc(length(vec2(ee, at - lt)), 0.15, pmax));
    }
    float nb = floor(2.0 * hw / 3.0);
    float bt = (t + hw) / (2.0 * hw) * nb;
    float bk = floor(bt + 0.5);
    float bar = disc(length(vec2(e, (bt - bk) * 2.0 * hw / nb)), 0.15, pmax);
    if (disp > 0.0) bar = max(bar, disc(length(vec2(ed, (bt - bk) * 2.0 * hw / nb)), 0.15, pmax));
    fix = max(fix, bar);
    albedo = mix(albedo, vec3(0.16, 0.16, 0.165), fix * small);
  }
  // tyre marks where the aircraft turn between the centreline and a taxiway (both ways)
  int nTurn = int(P5.z + 0.5);
  float turnM = 0.0;
  if (detail > 0.3 && at < W) {
    for (int k = 0; k < ${MAX_TURNS}; k++) {
      if (k >= nTurn) break;
      vec4 tr = texelFetch(uRwData, ivec2(8 + k, rw), 0);   // s, side, taxiway direction (ds, dt)
      if (abs(s - tr.x) > 160.0) continue;
      for (int h = -1; h <= 1; h += 2) {
        float hh = float(h);
        if (hh * tr.z < -0.3) continue;              // the taxiway leads back the other way
        float c = clamp(hh * tr.z, 0.0, 1.0);
        float R = mix(32.0, 140.0, c * c);
        R = max(R, hw * 0.6);
        float sc0 = tr.x - hh * sqrt(max(R * R - (R - hw) * (R - hw), 0.0));
        vec2 d = vec2(s - sc0, t - tr.y * R);
        if (d.x * hh < 0.0 || t * tr.y < 0.0) continue;
        float r = length(d) - R;
        float wd = band(r, -2.4, 2.4, pmax) * (0.55 + 0.45 * smoothstep(-0.2, 0.3, nS.g + nT.b));
        float gear = max(band(abs(r), 1.05, 1.45, pmax), band(abs(r), 2.0, 2.3, pmax)) * step(0.0, nT.g + 0.15);
        turnM = max(turnM, 0.35 * wd + 0.45 * gear * small);
      }
    }
  }
  albedo = mix(albedo, rubberC * 1.2, turnM * (1.0 - white));
  if (closed) albedo = mix(albedo, albedo * vec3(1.05, 1.04, 0.98), 0.5);   // bleached, dusty

  // ---- light: sun through the atmosphere, sky, shadows (as the terrain) ----
  float rough = mix(0.82, 0.48, clamp(cov * (1.0 - shoulder) + turnM, 0.0, 1.0));
  rough = mix(rough, 0.6, max(white, yellow));
  rough = mix(rough, 0.55, sealant * (1.0 - conc));
  vec3 N = normalize(vec3(vNrm.x, sqrt(max(1.0 - dot(vNrm, vNrm), 0.01)), vNrm.y));
  vec3 upP = normalize(vec3(vRel.x / uEarthRadius, 1.0, vRel.z / uEarthRadius));
  N = normalize(N + upP - vec3(0.0, 1.0, 0.0));
  vec3 sunE = atmoSunIrradianceAt(vRel, vH);
  float shadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    if (receiveShadow) {
      DirectionalLightShadow shd = directionalLightShadows[ 0 ];
      shadow = getShadow( directionalShadowMap[ 0 ], shd.shadowMapSize, shd.shadowIntensity, shd.shadowBias, shd.shadowRadius, vDirectionalShadowCoord[ 0 ] );
    }
  #endif
  #ifdef RWY_TERRAIN_SHADOW
    shadow *= terrainSunVisibility(vRel.xz + cameraPosition.xz, vH, upP);
  #endif
  float NdL = max(dot(N, uSunDir), 0.0);
  vec3 skyE = uAmbient * (0.55 + 0.45 * dot(N, upP));
  vec3 radiance = albedo * (sunE * NdL * shadow + skyE) / PI;
  radiance += sunSpec(N, V, sunE, rough, vec3(0.04)) * NdL * shadow * step(0.0, uSunDir.y);

  // ---- aerial perspective (as the terrain), fade into the imagery ----
  vec3 color = atmoAerial(radiance, V, dist, vH);
  alpha *= 1.0 - smoothstep(uFade.x, uFade.y, dist);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
