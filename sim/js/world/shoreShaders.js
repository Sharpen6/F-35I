// Shore structure shaders (three.js ShaderMaterial, GLSL ES 3.0), used by js/world/Shore.js.
//
// SHORE_VERT / SHORE_FRAG draw everything Shore.js builds in one opaque program: the rubble
// mounds of the breakwaters, their concrete crests, quay walls, piers and pontoons, and the
// container cranes. The surface kind comes with the vertex colour's alpha (KIND below). With
// FOAM defined the same pair draws the white water on the sea along the breakwaters' exposed
// sides (blended over the terrain's water, which is drawn first).
//
// Light and haze are the terrain's (atmoSunIrradianceAt with the cumulus shadows, uAmbient, the
// ground bounce, atmoAerial), and every vertex is lowered with the earth's curvature like the
// terrain's, so a breakwater and the sea around it fade alike and stay together far away.
//
// The armour stones are 3D cells (about 1.8 m) in the mesh's own coordinates: a stone's tone,
// the dark gaps between stones and a facet per stone that catches the sun or not. Once a stone
// is smaller than about a pixel they give way to their mean (no shimmer far away).
//
// The Dead Sea's blocks (facade kind; vExp carries the style: 1 hotel, 0.5 house, 0 shed): floors
// of 3.3 m, hotels with a balcony slab and a recessed window band per floor, houses with
// windows, sheds with vertical cladding ribs; all fade to their mean before they alias. At night
// a share of the windows is lit (uShore.w: the buildings' share for the hour times the darkness).

import { ATMOSPHERE_CORE, ATMOSPHERE_PARS } from '../env/atmosphereGLSL.js';

// surface kinds (aCol.a * 255), Shore.js
export const KIND = { rubble: 0, crest: 1, deck: 2, wall: 3, steel: 4, panel: 5, dark: 6, facade: 7, roof: 8 };

const SRGB = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;

// atmoPathDepth divides 0 by 0 for a point exactly at the camera's height (buildingShaders.js)
const SAFE_H = /* glsl */ `
float atmoSafeH(float h) {
  float d = h - uCamAltitude;
  return abs(d) < 0.01 ? uCamAltitude + (d < 0.0 ? -0.01 : 0.01) : h;
}
`;

export const SHORE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#ifndef FOAM
  #include <shadowmap_pars_vertex>
#endif
${ATMOSPHERE_CORE}
${SRGB}
attribute vec4 aNrm;          // normal (xyz), exposure to the swell (w, 0..1)
attribute vec4 aCol;          // rgb: base colour (sRGB), a: kind / 255 (FOAM: r = across the band 0..1)
varying vec3 vRel;
varying float vH;
varying vec3 vN;
varying vec3 vLoc;            // position in the mesh (m): the procedural textures' coordinates
varying vec4 vCol;
varying float vExp;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 rel = wp.xyz - uCameraPos;
  float drop = atmoCurvatureDrop(rel.xz);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);       // exact (the offset to the camera is done in double)
  mv.xyz -= drop * viewMatrix[1].xyz;                     // mat3(viewMatrix) * (0, drop, 0)
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vRel = rel - vec3(0.0, drop, 0.0);
  vH = wp.y;
  vN = aNrm.xyz;                                          // the meshes are only translated
  vLoc = position;
  #ifdef FOAM
    vCol = aCol;
  #else
    vCol = vec4(srgbToLinear(aCol.rgb), floor(aCol.a * 255.0 + 0.5));
  #endif
  vExp = aNrm.w;
  #ifndef FOAM
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vec4 swp = vec4(wp.xyz + aNrm.xyz * directionalLightShadows[ 0 ].shadowNormalBias, 1.0);
      vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * swp;
    #endif
  #endif
}
`;

export const SHORE_FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <logdepthbuf_pars_fragment>
#ifndef FOAM
  #include <shadowmap_pars_fragment>
  uniform bool receiveShadow;
#endif
${ATMOSPHERE_PARS}
${SAFE_H}

uniform vec4 uShore;          // albedo gain (the terrain's), fine detail on (1) / off (0), sea state (0 calm .. 1), share of windows lit (0 by day)

varying vec3 vRel;
varying float vH;
varying vec3 vN;
varying vec3 vLoc;
varying vec4 vCol;
varying float vExp;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(vec3(i, 7.1)), b = hash13(vec3(i + vec2(1.0, 0.0), 7.1));
  float c = hash13(vec3(i + vec2(0.0, 1.0), 7.1)), d = hash13(vec3(i + vec2(1.0, 1.0), 7.1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

#ifdef FOAM
// ------------------------------------------------------------------------------------- white water
// across: 0 at the foot of the mound .. 1 at the band's outer edge; vExp: the side's exposure.
// A breaker arrives every ~9 s (the swell's period), throws white water against the stones and
// leaves patches that drift out and thin; far away the patches give way to their mean.
void main() {
  #include <logdepthbuf_fragment>
  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;
  float across = clamp(vCol.r, 0.0, 1.0);
  float t = uTime;
  vec2 q = vLoc.xz;
  float n1 = vnoise(q / 9.0 + vec2(0.05, -0.03) * t);
  float n2 = vnoise(q / 2.6 + vec2(-0.12, 0.08) * t);
  // the surge: a band running in toward the mound, then the backwash
  float ph = fract(t / 9.0 + n1 * 0.35);
  float surge = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.35, 1.0, ph));
  float reach = mix(0.35, 1.0, surge) * (0.5 + 0.5 * uShore.z);
  float body = (1.0 - smoothstep(reach * 0.55, reach, across)) * vExp;
  float patches = smoothstep(0.30, 0.70, n2 * 0.55 + n1 * 0.45 + 0.35 * (1.0 - across));
  float px = length(fwidth(q));                         // metres per pixel
  float fine = 1.0 - smoothstep(1.0, 3.0, px);
  float a = body * mix(0.55, patches, fine) * 0.9;
  if (a < 0.003) discard;
  vec3 sunE = atmoSunIrradianceAt(vRel, 0.0);
  vec3 foamR = vec3(0.82) * (sunE * max(uSunDir.y, 0.0) + uAmbient) / PI;
  vec3 tr, ins;
  atmoAerialParts(V, dist, atmoSafeH(vH), tr, ins);
  gl_FragColor = vec4(foamR * tr + ins, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
#else
// ------------------------------------------------------------------------------------- structures
// distance to the nearest and second nearest stone centre, and the nearest stone's id (0..1)
vec3 stones(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0, id = 0.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 c = i + g;
        vec3 o = vec3(hash13(c), hash13(c + 17.1), hash13(c + 31.7)) * 0.8 + 0.1;
        vec3 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = hash13(c + 5.3); }
        else if (d < d2) { d2 = d; }
      }
    }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}

// GGX sun highlight (times F and the sun's irradiance)
float sunSpec(vec3 N, vec3 V, float a) {
  vec3 H = normalize(uSunDir - V);
  float NdL = max(dot(N, uSunDir), 0.0), NdV = max(dot(N, -V), 1e-3), NdH = max(dot(N, H), 0.0);
  float a2 = a * a;
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = 0.5 * a;
  float G = 1.0 / ((NdL * (1.0 - k) + k) * (NdV * (1.0 - k) + k));
  return D * G * 0.25 * NdL;
}

void main() {
  #include <logdepthbuf_fragment>
  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;
  float kind = vCol.a;
  vec3 N = normalize(vN);
  if (dot(N, V) > 0.0 && kind > 3.5 && kind < 6.5) N = -N;   // thin crane plates seen from behind
  vec3 alb = vCol.rgb;
  vec3 fwL = fwidth(vLoc);
  float px = length(fwL);                                // metres per pixel
  float fine = uShore.y * (1.0 - smoothstep(0.5, 1.5, px));
  float rough = 0.6, f0 = 0.0;
  // the waterline: wet stones and concrete below the run-up (higher on the exposed sides)
  float t = uTime;
  float runUp = 0.35 + (0.5 + 1.1 * uShore.z) * vExp * (0.6 + 0.4 * sin(t * 0.7 + vLoc.x * 0.05 + vLoc.z * 0.04));
  float atSea = step(-20.0, vH);                          // the Dead Sea's blocks are not wet
  float wet = (1.0 - smoothstep(runUp - 0.25, runUp + 0.15, vH)) * atSea;
  float algae = (1.0 - smoothstep(0.05, 0.45, vH)) * (1.0 - 0.6 * vExp) * atSea;
  float foam = 0.0;
  vec3 emit = vec3(0.0);

  if (kind < 0.5) {
    // ---- rock / concrete armour
    float tone = 1.0, gap = 0.82;
    if (fine > 0.0) {
      vec3 s = stones(vLoc / 1.8);
      float g = smoothstep(0.02, 0.20, s.y - s.x);
      gap = mix(gap, mix(0.35, 1.0, g), fine);
      tone = mix(tone, 0.72 + 0.56 * s.z, fine);
      // each stone's own facet
      vec3 tilt = vec3(hash13(vec3(s.z, 1.3, 2.9)) - 0.5, 0.15, hash13(vec3(s.z, 4.1, 0.7)) - 0.5);
      N = normalize(N + tilt * 1.1 * fine * g);
    }
    alb *= tone * gap;
    alb = mix(alb, alb * vec3(0.42, 0.45, 0.40), wet);
    alb = mix(alb, vec3(0.045, 0.055, 0.035), algae * 0.6);
    // white water thrown up the exposed slope
    float n = vnoise(vLoc.xz / 3.0 + vec2(0.0, t * 0.4)) * 0.6 + vnoise(vLoc.xz / 1.1 - vec2(t * 0.9, 0.0)) * 0.4;
    float ph = fract(t / 9.0 + vnoise(vLoc.xz / 40.0) * 0.5);
    float splash = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.15, 0.6, ph));
    foam = vExp * (1.0 - smoothstep(0.2, 0.6 + 1.6 * splash, vH)) * smoothstep(0.35, 0.65, n + 0.25 * splash);
    foam *= 0.5 + 0.5 * uShore.z;
    rough = 0.8;
  } else if (kind < 2.5) {
    // ---- concrete crest roads, decks, pontoons: weathered, stained
    float st = vnoise(vLoc.xz / 7.0) * 0.6 + vnoise(vLoc.xz / 1.7) * 0.4 * fine;
    alb *= 0.86 + 0.28 * st;
    alb = mix(alb, alb * 0.55, wet * 0.8);
    rough = 0.75;
  } else if (kind < 3.5) {
    // ---- quay walls and deck sides: concrete, a dark band where the sea wets it
    float st = vnoise(vec2(vLoc.x + vLoc.z, vLoc.y * 3.0) / 4.0);
    alb *= 0.85 + 0.3 * st;
    alb = mix(alb, alb * vec3(0.38, 0.40, 0.36), wet);
    alb = mix(alb, vec3(0.05, 0.06, 0.04), algae * 0.7);
    rough = 0.8;
  } else if (kind < 4.5) {
    // ---- painted steel (crane frames): a little gloss
    f0 = 0.04;
    rough = 0.45;
  } else if (kind < 5.5) {
    // ---- panels (machinery houses, cabs)
    f0 = 0.04;
    rough = 0.5;
  } else if (kind < 6.5) {
    // ---- dark (glass, rubber)
    f0 = 0.04;
    rough = 0.25;
  } else if (kind < 7.5) {
    // ---- the Dead Sea's blocks: walls (hotels, houses, sheds)
    float style = vExp;
    vec2 tw = vec2(-N.z, N.x);                            // along the wall
    float u = dot(vLoc.xz, tw);
    // metres per pixel up the wall (the floors) and along it (the windows), from fwidth outside
    // the branch: a wall seen at a slant is foreshortened along only one of them
    float pxY = max(fwL.y, 1e-3), pxH = max(length(fwL.xz), 1e-3);
    float fy = vLoc.y / 3.3;
    float fl = floor(fy), fv = fract(fy);
    float wu = u / (style > 0.75 ? 3.6 : 4.2);
    float wi = floor(wu), fu = fract(wu);
    float kF = 1.0 - smoothstep(0.45, 1.1, pxY);          // the slabs (0.3 m) and their shadow
    float kB = 1.0 - smoothstep(0.8, 1.6, pxY);           // the window bands (2.1 m of 3.3 m)
    float kW = 1.0 - smoothstep(0.3, 0.8, pxH);           // single windows
    float glass = 0.0;
    if (style > 0.75) {
      // a balcony slab (lighter, its shadow under it) and a dark window band per floor
      // (each pattern gives way to its mean before it is down to two pixels: no speckle far off)
      float slab = mix(0.1, smoothstep(0.0, 0.03, fv) * (1.0 - smoothstep(0.08, 0.11, fv)), kF);
      float band = mix(0.6, smoothstep(0.2, 0.25, fv) * (1.0 - smoothstep(0.8, 0.85, fv)), kB);
      float mull = smoothstep(0.03, 0.07, fu) * (1.0 - smoothstep(0.93, 0.97, fu));
      glass = band * mix(0.85, mull, kW);
      alb *= mix(0.9, 1.0 + 0.12 * slab - 0.35 * (1.0 - smoothstep(0.11, 0.2, fv)) * (1.0 - slab), kF);
      alb = mix(alb, mix(alb * 0.62, vec3(0.05, 0.06, 0.07), kB), glass * mix(0.45, 1.0, kB));
    } else if (style > 0.25) {
      // houses: a window in each bay, a little dark
      float kH = 1.0 - smoothstep(0.4, 1.0, max(pxY, pxH));
      float win = smoothstep(0.3, 0.36, fv) * (1.0 - smoothstep(0.72, 0.78, fv)) * smoothstep(0.32, 0.38, fu) * (1.0 - smoothstep(0.66, 0.72, fu));
      glass = mix(0.12, win, kH);
      alb = mix(alb, alb * 0.25, glass);
    } else {
      // sheds: cladding ribs every 0.25 m, dust at the foot
      float rib = 0.5 + 0.5 * cos(6.2832 * u / 0.25);
      alb *= 1.0 - 0.1 * rib * (1.0 - smoothstep(0.03, 0.08, pxH));
    }
    alb *= 0.92 + 0.16 * hash13(vec3(floor(vLoc.xz / 37.0), 3.3));
    // lit windows at night: the buildings' window radiance (0.014), uShore.w of them lit (the
    // buildings' share for the hour times the darkness), warm or cool white; far off their mean
    if (uShore.w > 0.0 && glass > 0.0) {
      float hw = hash13(vec3(wi, fl, floor(vLoc.x * 0.01 + vLoc.z * 0.013)));
      float on = mix(uShore.w, step(hw, uShore.w), kW);
      vec3 tint = mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.9, 1.0), mix(0.25, step(0.75, fract(hw * 13.7)), kW));
      emit = 0.014 * tint * on * glass;
    }
    f0 = 0.02 + 0.03 * glass;
    rough = mix(0.8, 0.2, glass);
  } else {
    // ---- the blocks' flat roofs: concrete, tanks and plant
    float st = vnoise(vLoc.xz / 5.0) * 0.6 + vnoise(vLoc.xz / 1.3) * 0.4 * fine;
    alb *= 0.85 + 0.3 * st;
    rough = 0.85;
  }
  alb *= uShore.x;

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
  vec3 gndE = PI * uGroundRadiance * (0.5 - 0.5 * N.y) * 0.7;    // mostly sea below: darker than the mean ground
  vec3 radiance = alb * (sunE * NdL * shadow + skyE + gndE) / PI;
  if (f0 > 0.0) {
    vec3 R = reflect(V, N);
    float F = f0 + (1.0 - f0) * pow(1.0 - max(dot(N, -V), 0.0), 5.0);
    vec3 env = atmoSkyRadiance(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
    radiance += env * F * (R.y > 0.0 ? 1.0 : 0.3) * (1.0 - rough * 0.6) + sunE * sunSpec(N, V, rough) * F * shadow;
  }
  vec3 foamR = vec3(0.82) * (sunE * max(uSunDir.y, 0.0) * shadow + uAmbient) / PI;
  radiance = mix(radiance, foamR, clamp(foam, 0.0, 1.0) * 0.9);
  radiance += emit;

  vec3 color = atmoAerial(radiance, V, dist, atmoSafeH(vH));
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
#endif
`;
