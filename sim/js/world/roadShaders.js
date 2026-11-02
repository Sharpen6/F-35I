// Road shaders (three.js ShaderMaterial, GLSL ES 3.0): the draped ribbons of js/world/roadMesh.js.
//
// Vertex: positions relative to the chunk's centre; the camera-relative position is taken from
// modelViewMatrix (built in double precision on the CPU), lowered by the earth's curvature
// d^2 / 2R exactly as the terrain is, and drawn with the terrain's camera-relative transform, so
// a road vertex lands where the terrain triangle under it is.
//
// Fragment: the surface by class in road coordinates (u along, v across, metres): asphalt with
// grain, wheel tracks and patches, lane / edge / centre lines (Israeli practice: white lines,
// yellow left edge on dual carriageways), stop lines and zebra crossings at junctions, kerbs and
// sidewalks in towns (kerbs and zebras only on urban roads below motorway class), dirt tracks in
// the local soil colour, railways (ballast, sleepers, rails), taxiways (yellow centreline, edge
// lines, ICAO pattern A holding positions with the enhanced centreline), concrete aprons, and the
// concrete of bridge structures (class 14: fascia, parapets, piers, the deck's underside). Lit like
// the terrain (sun through the atmosphere, sky, the aircraft's shadow, the terrain's own shadow
// when gfx-terrain's horizon map is in: roadFrag(HORIZON_GLSL)) plus a little sheen, street lights
// and apron floodlights at night, then the same aerial perspective as the terrain, and faded out
// with distance into the imagery (which shows the roads beyond).
//
// Thin ribbons: a road narrower than WIDEN_PX on screen is widened to it in the vertex shader (on
// the terrain's tangent plane, along the mitred cross direction) and its coverage lowered to match,
// so far roads stay continuous lines of the right weight instead of dotted, crawling ones.
//
// Depth: every road fragment is pulled towards the camera by (priority + 7) steps of a constant
// (2 units of a 24-bit depth buffer) plus a slope term (1.2 % of the depth change across one
// pixel). The slope term covers the float error of coplanar surfaces at grazing angles; the
// priority puts motorways over side streets and bridges over everything (roadMesh.js LAYER);
// shoulders and sidewalks take six steps, under every carriageway (junctions). A lifted bridge
// deck (flag 128) takes the order of its class at ground level (the bridge layers' bias would put
// it in front of its own parapets and the cars on it); bridge structures none (solid geometry).
// polygonOffset cannot do this: the logarithmic depth buffer writes gl_FragDepth.

import { ATMOSPHERE_PARS, ATMOSPHERE_CORE } from '../env/atmosphereGLSL.js';

export const MAX_MASTS = 16;
/** Ribbons thinner than this on screen (px) are widened to it, at a lower opacity (vertex shader). */
export const WIDEN_PX = 1.5;

export const ROAD_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
${ATMOSPHERE_CORE}

attribute vec2 aUV;          // u along the road (m), v across (m, + right of travel)
attribute vec2 aJd;          // distance past the previous junction, to the next one (m)
attribute vec2 aNrm;         // terrain normal x, z
attribute vec4 aInfo;        // class, flags, lanes, depth priority
attribute vec4 aSect;        // carriageway width, left margin, right margin (dm), tone
attribute vec2 aRad;         // junction radii (0.25 m) / holding position direction
attribute vec2 aDir;         // the direction a vertex moves per metre of v when widened (/ 3; 0: never)

uniform float uPx;           // radians per pixel of the drawing buffer (0: no widening)

varying vec3 vRel;
varying float vH;
varying vec2 vXZ;
varying vec2 vUV;
varying vec2 vJd;
varying vec2 vNrm;
flat varying vec4 vInfo;
flat varying vec4 vSect;
flat varying vec2 vRad;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 rel = mv.xyz * mat3(viewMatrix);          // camera-relative, world axes
  float v = aUV.y;
  // Thin ribbons: a road narrower than WIDEN_PX pixels on screen is drawn that wide. Its triangles
  // would otherwise cover few pixel centres and break into dots that crawl as the camera moves.
  // Each vertex moves away from the ribbon's middle along aDir (the mitre directions, so joints
  // stay closed) on the tangent plane of its surface (aNrm), and v moves with it: the fragment
  // shader's coverage terms (band()) then find the true road inside a wider strip and lower the
  // opacity by the same factor, a continuous line of the right average colour.
  vec2 dir = aDir * 3.0;
  if (uPx > 0.0 && dot(dir, dir) > 0.25) {
    float W = 0.1 * (aSect.x + aSect.y + aSect.z);                 // carriageway + margins (m)
    float vc = 0.05 * (aSect.z - aSect.y);                          // middle of [vL, vR]
    float d = max(length(rel), 1.0);
    vec2 a = normalize(dir);
    float ca = (a.x * rel.x + a.y * rel.z) / d;                     // across direction vs the view ray
    float wPx = W * sqrt(max(1.0 - ca * ca, 0.0)) / (d * uPx);      // width on screen (px)
    float s = clamp(${WIDEN_PX.toFixed(2)} / max(wPx, 1e-3), 1.0, 16.0);
    float dv = (v - vc) * (s - 1.0);
    vec2 dxz = dir * dv;
    vec3 n = vec3(aNrm.x, sqrt(max(1.0 - dot(aNrm, aNrm), 0.01)), aNrm.y);
    vec3 off = vec3(dxz.x, -(n.x * dxz.x + n.z * dxz.y) / n.y, dxz.y);
    rel += off;
    world.xyz += off;
    v += dv;
  }
  rel.y -= atmoCurvatureDrop(rel.xz);
  vRel = rel;
  vH = world.y;
  vXZ = world.xz;
  vUV = vec2(aUV.x, v);
  vJd = aJd;
  vNrm = aNrm;
  vInfo = aInfo;
  vSect = aSect;
  vRad = aRad;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * rel, 1.0);
  #include <logdepthbuf_vertex>
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * vec4(rel + cameraPosition, 1.0);
  #endif
}
`;

/**
 * The fragment shader; horizonGlsl: the terrain's HORIZON_GLSL (terrainSunVisibility) when the terrain
 * has horizon maps (Roads.js loads it), then ground-level road surfaces share the terrain's shadows.
 */
export const roadFrag = (horizonGlsl = '') => /* glsl */ `
#include <common>
#include <packing>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
uniform bool receiveShadow;
${ATMOSPHERE_PARS}
${horizonGlsl ? horizonGlsl + '\n#define ROAD_TERRAIN_SHADOW 1' : ''}

uniform sampler2D uNoise;        // tiling noise: r grain, g blotches, b streaks, a large patches
uniform sampler2D uOverview;     // the terrain's core colour (25 m / px): soil colour of tracks
uniform vec2 uFade;              // fade-out start, end (m, 3D distance)
uniform float uAlbedoGain;       // the terrain's imagery -> albedo factor
uniform vec4 uArt;               // street lights on (0..1), scene irradiance per lux, detail (0..1), -
uniform vec4 uMasts[${MAX_MASTS}];  // apron floodlights: world x, z, height (m), lux at the foot
uniform int uMastCount;

varying vec3 vRel;
varying float vH;
varying vec2 vXZ;
varying vec2 vUV;
varying vec2 vJd;
varying vec2 vNrm;
flat varying vec4 vInfo;
flat varying vec4 vSect;
flat varying vec2 vRad;

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
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
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
  // ---- depth bias (first: derivatives need uniform control flow) ----
  float steps = vInfo.w + 7.0;
  // Shoulders, verges and sidewalks sit under every carriageway, so a side road's pavement cuts
  // through the main road's shoulder or sidewalk at a junction whatever the drawing order
  // (not on bridges, nor aprons, whose (u, v) are slab coordinates). Six steps: fewer let the
  // terrain through in places (float error of the two meshes' positions, measured: 2 fail, 4 hold).
  // Bridge structures (class 14) are solid geometry: no bias. A lifted deck (flag 128) stands
  // off the terrain except where it comes down to it: the order of its class at ground level
  // (the bridge layers' big bias would push it in front of its own parapets and of the cars).
  int clsD = int(vInfo.x + 0.5), flD = int(vInfo.y + 0.5);
  if (clsD == 14) steps = 0.0;
  else if ((flD & 128) != 0) steps = 7.0 + mod(vInfo.w, 36.0);
  else if (clsD != 13 && (flD & 2) == 0 && abs(vUV.y) > 0.05 * vSect.x + 0.02) steps = 6.0;
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

  float u = vUV.x, v = vUV.y;
  float pu = max(length(vec2(dFdx(u), dFdy(u))), 1e-4);     // metres per pixel along
  float pv = max(length(vec2(dFdx(v), dFdy(v))), 1e-4);     // and across the road
  vec2 dX = dFdx(vXZ), dY = dFdy(vXZ);
  vec4 nF = textureGrad(uNoise, vXZ / 6.7, dX / 6.7, dY / 6.7) - 0.5;     // grain (~2.6 cm texels)
  vec4 nM = textureGrad(uNoise, vXZ / 47.0, dX / 47.0, dY / 47.0) - 0.5;  // blotches, stains
  vec4 nL = texture(uNoise, vXZ / 331.0) - 0.5;                            // large patches

  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;
  float fade = 1.0 - smoothstep(uFade.x, uFade.y, dist);
  float detail = uArt.z;

  int cls = int(vInfo.x + 0.5);
  int fl = int(vInfo.y + 0.5);
  float lanes = max(vInfo.z, 1.0);
  bool oneway = (fl & 1) != 0;
  bool urban = (fl & 4) != 0;
  bool unpaved = (fl & 8) != 0 || cls == 9;
  bool lit = (fl & 32) != 0;
  float cw = vSect.x * 0.1, mL = vSect.y * 0.1, mR = vSect.z * 0.1, tone = vSect.w / 255.0;
  float hc = 0.5 * cw;
  float vL = -hc - mL, vR = hc + mR;
  float rP = vRad.x * 0.25, rN = vRad.y * 0.25;
  float dP = vJd.x, dN = vJd.y;

  vec3 ground = texture(uOverview, (vXZ + 51200.0) / 102400.0).rgb * uAlbedoGain;
  float gLum = dot(ground, vec3(0.2126, 0.7152, 0.0722));

  vec3 albedo;
  float alpha;
  float rough = 0.6;
  vec3 F0 = vec3(0.04);
  float lightSide = 0.0;       // street light pole side (v), 0: none

  // ---- surface ----
  if (cls == 14) {
    // bridge structure: weathered concrete; on the vertical faces formwork joints every 2.4 m and
    // dark streaks of run-off down from the tops (v: metres below the face's top edge)
    float wall = clamp(length(vNrm) * 2.0 - 1.0, 0.0, 1.0);
    float c0 = 0.29 + 0.1 * tone;
    albedo = vec3(c0, c0 * 0.98, c0 * 0.935) * (1.0 + 0.16 * nM.g * detail + 0.08 * nL.a + 0.12 * nF.r * detail);
    albedo = mix(albedo, ground * 1.1, 0.12);
    float sk = floor(u / 0.6);
    float sl = 0.2 + 1.2 * hash11(sk * 3.7 + tone * 31.0);
    float streak = step(0.7, hash11(sk * 1.31 + tone * 7.0)) * exp(min(v, 0.0) / sl) * wall * smoothstep(0.4, 0.1, pu);
    albedo *= 1.0 - 0.16 * streak * detail;
    albedo *= 1.0 - 0.25 * band(mod(u + 1.2, 2.4), 1.19, 1.21, pu) * wall * detail;
    alpha = 1.0;
    rough = 0.85;
  } else if (cls == 13) {
    // apron: concrete slabs 5 m x 5 m along the apron's axis, joints, stains
    vec2 slab = floor(vec2(u, v) / 5.0);
    float sv = hash11(slab.x * 17.0 + slab.y * 131.0 + tone * 97.0);
    albedo = vec3(0.30, 0.295, 0.28) * (0.9 + 0.16 * sv + 0.25 * nM.g * detail + 0.12 * nL.a) * (1.0 + 0.25 * nF.r * detail);
    float joint = max(band(mod(u + 2.5, 5.0), 2.49, 2.51, pu), band(mod(v + 2.5, 5.0), 2.49, 2.51, pv));
    albedo *= 1.0 - 0.45 * joint * detail;
    albedo *= 1.0 - 0.35 * smoothstep(0.18, 0.4, nM.b + 0.15 * nL.g) * detail;      // oil and rubber stains
    alpha = 1.0;
    rough = 0.75;
  } else if (cls == 10 || cls == 11) {
    // railway: ballast on a bed with slopes, concrete sleepers every 0.6 m, two rails (1435 mm)
    float av = abs(v);
    vec3 ballast = vec3(0.245, 0.235, 0.22) * (0.75 + 0.55 * (nF.r + 0.5) * detail + 0.2 * nM.g);
    ballast = mix(ballast, vec3(0.20, 0.13, 0.08), 0.35 * band(av, 0.0, 0.75, pv));   // rust and brake dust between the rails
    vec3 slopeC = mix(ballast, ground, 0.45);
    albedo = av < hc ? ballast : slopeC;
    if (cls == 11) albedo = mix(vec3(0.36, 0.35, 0.33) * (1.0 + 0.2 * nM.g), slopeC, step(hc, av));   // light rail: slab track
    float sleeper = cls == 10 ? band(av, 0.0, 1.3, pv) * dashes(u, 0.6, 0.26, pu) : 0.0;
    albedo = mix(albedo, vec3(0.40, 0.39, 0.37) * (1.0 + 0.2 * nF.r), sleeper);
    float rail = band(av, 0.7175, 0.7895, pv);
    float railTop = band(av, 0.73, 0.775, pv);
    albedo = mix(albedo, vec3(0.16, 0.10, 0.07), rail);         // rusty rail sides
    albedo = mix(albedo, vec3(0.45, 0.45, 0.46), railTop);      // polished heads
    rough = mix(0.8, 0.22, railTop);
    F0 = mix(vec3(0.04), vec3(0.55), railTop);
    alpha = band(v, vL, vR, pv + 0.5) * mix(1.0, 0.85, step(hc, av));
  } else if (unpaved) {
    // dirt track in the local soil: compacted, lighter than the fields, two wheel ruts, a weedy middle
    vec3 soil = mix(ground, vec3(gLum), 0.3) * 1.18;
    soil *= 1.0 + 0.3 * nM.g * detail + 0.15 * nL.a + 0.15 * nF.r * detail;
    float av = abs(v);
    float rut = band(av, 0.55, 1.05, pv);
    soil *= 1.0 - 0.14 * rut;
    soil = mix(soil, ground * 0.9, 0.6 * band(av, 0.0, 0.35, pv) * (0.6 + 0.8 * nM.r));
    albedo = soil;
    alpha = band(v, vL + 0.4 * nM.b, vR - 0.4 * nM.a, pv + 1.2) * 0.9;
    rough = 0.95;
  } else {
    // asphalt (aged by the polyline's tone), grain, large patches
    float age = clamp(tone * 0.85 + 0.3 * nL.a + 0.15, 0.0, 1.0);
    if (cls <= 1) age *= 0.7;                       // motorways are resurfaced more often
    vec3 asph = mix(vec3(0.072, 0.071, 0.069), vec3(0.155, 0.150, 0.142), age);
    asph *= 1.0 + 0.30 * nF.r * detail + 0.10 * nM.g;
    // wheel tracks in every lane (polished, darker) and the oil strip between them
    if (cls != 12 && cw > 2.0) {
      float laneW = cw / lanes;
      float q = mod(v + hc, laneW) - 0.5 * laneW;    // position in the lane, 0 = its middle
      float aq = abs(q);
      float tracks = band(aq, 0.55, 1.15, pv);
      float oil = band(aq, 0.0, 0.35, pv);
      asph *= 1.0 - detail * (0.10 * tracks + 0.07 * oil * (0.5 + nM.r));
    }
    // patches: rectangular repairs a few metres long in some lanes
    float cell = floor(u / 23.0);
    float hp = hash11(cell * 7.13 + tone * 53.0);
    if (hp > 0.82 && detail > 0.3) {
      float a0 = 23.0 * cell + 23.0 * hash11(cell * 3.1 + 1.7) * 0.6, len = 3.0 + 9.0 * hash11(cell * 5.3);
      float side = hash11(cell * 9.7) > 0.5 ? 1.0 : -1.0;
      float pa = band(u, a0, a0 + len, pu) * band(v * side, 0.0, hc * 0.9, pv);
      asph = mix(asph, asph * (hp > 0.91 ? 0.72 : 1.28), pa * 0.8);
    }
    albedo = asph;
    alpha = 1.0;
    rough = 0.62;
    float av = abs(v);
    if (cls == 12) {
      // taxiway: paved shoulders beyond the full-strength pavement, lighter and dustier
      albedo = mix(albedo, albedo * 1.35 + 0.02, band(av, hc, 99.0, pv));
      alpha = band(v, vL, vR, pv + 0.3);
    } else if (urban && (mL > 0.5 || mR > 0.5) && cls >= 2 && cls <= 7) {
      // town: kerbs and sidewalks (paving stones), red / white kerbs near junctions (never on
      // motorways, whatever the data says: they have shoulders and barriers)
      float side = v < 0.0 ? mL : mR;
      float kerb = band(av, hc, hc + 0.2, pv) * step(0.5, side);
      float walk = step(hc + 0.2, av) * step(0.5, side);
      vec3 paving = vec3(0.235, 0.228, 0.215) * (1.0 + 0.25 * nM.g * detail + 0.2 * nF.g * detail);
      paving = mix(paving, ground * 0.95, 0.35);       // dust, trees' shade and the local stone
      float bricks = max(band(mod(u, 0.2), 0.0, 0.012, pu), band(mod(v, 0.1), 0.0, 0.01, pv)) * detail;
      paving *= 1.0 - 0.25 * bricks;
      albedo = mix(albedo, paving, walk);
      float nearJ = max(step(abs(dP), rP + 14.0) * step(0.1, rP), step(abs(dN), rN + 14.0) * step(0.1, rN));
      nearJ *= smoothstep(0.12, 0.05, max(pu, pv));     // painted kerbs only close up (they alias into dots)
      vec3 kerbC = mix(vec3(0.34, 0.335, 0.32), mix(vec3(0.42, 0.055, 0.045), vec3(0.62, 0.61, 0.58), step(1.0, mod(u, 2.0))), nearJ);
      albedo = mix(albedo, kerbC, kerb);
      alpha = band(v, vL, vR, pv + 0.12);
      lightSide = hc + 0.7;
    } else {
      // open road: shoulders a little dustier towards a ragged edge
      float sh = smoothstep(hc, max(vR, hc + 0.01), av);
      albedo = mix(albedo, mix(albedo, ground, 0.3), sh * 0.6);
      float edgeN = 0.25 * nM.b + 0.12 * nF.g;
      alpha = band(v, vL + edgeN, vR - edgeN, pv + 0.35);
      lightSide = hc + 1.0;
    }
  }

  // ---- markings ----
  float white = 0.0, yellow = 0.0;
  float inJ = 0.0;
  if (rP > 0.0) inJ = max(inJ, 1.0 - smoothstep(rP, rP + 0.4, abs(dP)));
  if (rN > 0.0) inJ = max(inJ, 1.0 - smoothstep(rN, rN + 0.4, abs(dN)));
  if (cls <= 6 && !unpaved) {
    if (oneway) {
      float laneW = cw / lanes;
      yellow = max(yellow, band(v, -hc + 0.05, -hc + 0.2, pv));         // left edge (median side)
      white = max(white, band(v, hc - 0.25, hc - 0.07, pv));            // right edge
      float period = cls <= 1 ? 12.0 : 9.0;
      for (int k = 1; k < 6; k++) {
        if (float(k) >= lanes) break;
        float c = -hc + float(k) * laneW;
        white = max(white, band(v, c - 0.07, c + 0.07, pv) * dashes(u, period, 3.0, pu));
      }
    } else {
      float nl = max(floor(lanes * 0.5), 1.0), laneW = hc / nl;
      bool solid = (fl & 16) != 0;
      float cl;
      if (solid) cl = cls == 2 ? max(band(v, -0.22, -0.09, pv), band(v, 0.09, 0.22, pv)) : band(v, -0.06, 0.06, pv);
      else cl = band(v, -0.06, 0.06, pv) * dashes(u, urban ? 9.0 : 12.0, 3.0, pu);
      white = max(white, cl);
      for (int k = 1; k < 4; k++) {
        if (float(k) >= nl) break;
        float c = float(k) * laneW;
        white = max(white, band(abs(v), c - 0.06, c + 0.06, pv) * dashes(u, 9.0, 3.0, pu));
      }
      if (!urban || cls <= 1) white = max(white, band(abs(v), hc - 0.2, hc - 0.07, pv));
    }
    white *= 1.0 - inJ;
    yellow *= 1.0 - inJ;
    // the minor road at a junction gets a stop line; town junctions get zebra crossings (not on
    // motorways and their ramps)
    float hw = hc + max(mL, mR);
    bool zebra = urban && cls >= 2;
    if (rN > 0.0) {
      float s0 = rN + (zebra && rN > 5.0 ? 4.3 : 0.3);
      if (hw + 1.0 < rN - 0.25) white = max(white, band(dN, s0, s0 + 0.4, pu) * band(v, oneway ? -hc : 0.0, hc, pv));
      if (zebra && rN > 5.0) white = max(white, band(dN, rN + 0.6, rN + 3.6, pu) * band(abs(v), 0.0, hc - 0.3, pv) * dashes(v + hc, 1.0, 0.5, pv));
    }
    if (rP > 0.0) {
      float s0 = rP + (zebra && rP > 5.0 ? 4.3 : 0.3);
      if (!oneway && hw + 1.0 < rP - 0.25) white = max(white, band(dP, s0, s0 + 0.4, pu) * band(v, -hc, 0.0, pv));
      if (zebra && rP > 5.0) white = max(white, band(dP, rP + 0.6, rP + 3.6, pu) * band(abs(v), 0.0, hc - 0.3, pv) * dashes(v + hc, 1.0, 0.5, pv));
    }
  } else if (cls == 12) {
    // taxiway: continuous yellow centreline, double edge lines, holding position (ICAO pattern A)
    yellow = max(yellow, band(v, -0.075, 0.075, pv));
    if ((fl & 64) != 0) yellow = max(yellow, max(band(abs(v), hc - 0.45, hc - 0.3, pv), band(abs(v), hc - 0.15, hc, pv)));
    float dir = vRad.x > 1.5 ? -1.0 : 1.0;
    if (vRad.x > 0.5) {
      float s = dP * dir;                         // < 0 on the taxiway side, > 0 towards the runway
      float lat = band(abs(v), 0.0, hc, pv);
      float solid = max(band(s, -0.75, -0.6, pu), band(s, -0.45, -0.3, pu));
      float dashed = max(band(s, -0.15, 0.0, pu), band(s, 0.15, 0.3, pu)) * dashes(v + 50.0, 2.0, 1.0, pv);
      yellow = max(yellow, lat * max(solid, dashed));
      // enhanced centreline: dashed lines beside the centreline for 45 m before the holding position
      float enh = band(s, -45.75, -0.9, pu) * dashes(-s, 4.0, 3.0, pu) * max(band(v, 0.225, 0.375, pv), band(v, -0.375, -0.225, pv));
      yellow = max(yellow, enh);
    }
  }
  float pw = smoothstep(4.0, 0.6, min(pu, pv) / 0.15);        // paint fades as it shrinks below a pixel
  white = clamp(white, 0.0, 1.0) * mix(0.55, 1.0, pw);
  yellow = clamp(yellow, 0.0, 1.0) * mix(0.55, 1.0, pw);
  vec3 paintW = vec3(0.60, 0.60, 0.58) * (0.9 + 0.25 * nM.g);           // worn white road paint
  vec3 paintY = vec3(0.56, 0.40, 0.055) * (0.9 + 0.2 * nM.g);
  albedo = mix(albedo, paintW, white * (1.0 - 0.3 * smoothstep(0.1, 0.4, nM.b) * detail));
  albedo = mix(albedo, paintY, yellow * (1.0 - 0.2 * smoothstep(0.15, 0.4, nM.b) * detail));
  rough = mix(rough, 0.45, max(white, yellow));

  // ---- light: sun through the atmosphere, sky, the aircraft's shadow (as the terrain) ----
  vec3 N = normalize(vec3(vNrm.x, sqrt(max(1.0 - dot(vNrm, vNrm), 0.01)), vNrm.y));
  if (cls == 14 && (fl & 128) != 0) N = vec3(0.0, -1.0, 0.0);      // a deck's underside
  vec3 upP = normalize(vec3(vRel.x / uEarthRadius, 1.0, vRel.z / uEarthRadius));
  N = normalize(N + upP - vec3(0.0, 1.0, 0.0));
  vec3 sunE = atmoSunIrradianceAt(vRel, vH);
  float shadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    if (receiveShadow) {
      DirectionalLightShadow sh = directionalLightShadows[ 0 ];
      shadow = getShadow( directionalShadowMap[ 0 ], sh.shadowMapSize, sh.shadowIntensity, sh.shadowBias, sh.shadowRadius, vDirectionalShadowCoord[ 0 ] );
    }
  #endif
  float NdL = max(dot(N, uSunDir), 0.0);
  vec3 skyE = uAmbient * (0.55 + 0.45 * dot(N, upP));
  #ifdef ROAD_TERRAIN_SHADOW
    // the terrain's shadow on surfaces at ground level (a lifted deck or a pier stands above
    // the valley the horizon map describes: left to the sun)
    if (cls != 14 && (fl & 128) == 0) shadow *= terrainSunVisibility(vXZ, vH, upP);
  #endif
  vec3 radiance = albedo * (sunE * NdL * shadow + skyE) / PI;
  radiance += sunSpec(N, V, sunE, rough, F0) * NdL * shadow * step(0.0, uSunDir.y);

  // ---- artificial light at night: street lights along lit roads, apron floodlights ----
  if (uArt.x > 0.0) {
    vec3 art = vec3(0.0);
    if (lit && lightSide > 0.0) {
      float S = cls <= 3 ? 42.0 : 33.0, hL = cls <= 3 ? 12.0 : 9.0;
      float k0 = floor(u / S);
      float lux = 0.0;
      for (int k = -1; k <= 1; k++) {
        float kk = k0 + float(k);
        float uk = (kk + 0.5) * S;
        // dual carriageways: poles in the median; two-way roads: staggered on both sides
        float vk = oneway ? (-hc - mL + 0.4) : (mod(kk, 2.0) < 1.0 ? -lightSide : lightSide);
        float d2 = (u - uk) * (u - uk) + (v - vk) * (v - vk);
        lux += pow(hL * hL / (hL * hL + d2), 1.5);
      }
      lux *= cls <= 3 ? 32.0 : 26.0;
      // sodium on highways, warm LED in towns (AirportLights.js LAMP: the same chromaticity, here
      // scaled to the luminance the lux above were set with)
      vec3 tint = cls <= 3 ? vec3(1.43, 0.51, 0.086) : vec3(1.29, 0.80, 0.41);
      art += tint * lux;
    }
    if (cls == 13 || cls == 12) {
      float lux = 0.0;
      for (int i = 0; i < ${MAX_MASTS}; i++) {
        if (i >= uMastCount) break;
        vec4 m = uMasts[i];
        vec2 d = vXZ - m.xy;
        float h2 = m.z * m.z;
        lux += m.w * pow(h2 / (h2 + dot(d, d)), 1.5);
      }
      art += vec3(1.0, 0.93, 0.82) * min(lux, 300.0);       // 4000 K metal halide / LED
    }
    radiance += albedo * art * (uArt.x * uArt.y) / PI;
  }

  // ---- aerial perspective (as the terrain), fade into the imagery ----
  vec3 color = atmoAerial(radiance, V, dist, vH);
  alpha *= fade;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
