// Clouds: fair-weather cumulus (ray marched volumes) and high cirrus, with weather presets.
//
//   const clouds = new Clouds(ctx);      // a graphics module (main.js _addGraphicsModules)
//   ?clouds=clear|few|scattered|broken|cirrus, or the Weather buttons in the menu (settings.clouds)
//
// Where the cumulus stand is one procedural field (js/env/cloudField.js, and its GLSL twin
// atmoCloudCover in atmosphereGLSL.js), drifting with the wind. Every frame:
//
//   1. cover     the field around the camera, in the wind's frame, in a 1024 x 1024 map (+-60 km),
//                so the ray marcher reads one texel instead of evaluating the noise at every step.
//                It is redrawn only when the camera or the drift has moved it by a texel.
//   2. march     at half (high, medium) or quarter (low) resolution, each pixel's ray crosses the
//                cumulus slab (spherical shells: the deck curves away at the horizon) up to the
//                scene's depth. Density: the field's footprint, pushed around in 3D by the noise and
//                narrowing towards the top, times a height profile (flat base, rounded top, taller in
//                the middle of a cloud), eroded by a tiling 3D Perlin-Worley noise (64^3, made on the
//                GPU at start-up) and, near the camera, by a finer Worley octave (~100 m cells):
//                wispy at the base, billowy above. Empty air is crossed in long steps, cloud in short
//                ones (12 m near the camera on high). Lit by the sun (or the moon at night) through
//                a short light march with a multiple scattering approximation, a two-lobe phase
//                function and the "powder" darkening of the sunlit creases; by the sky from above
//                and the ground from below, each dimmed by the cloud between (the base is darker
//                than the top); at night also by the cities' glow from below. The sun's colour is
//                taken at the cloud's height, so clouds stay lit after sunset on the ground. Then the
//                cirrus sheet (2D, streaked along the wind) above. Aerial perspective to the cloud.
//   3. resolve   the march starts each ray at a different offset every frame (interleaved gradient
//                noise, a 16-frame cycle); a temporal filter reprojects last frame's result to this
//                frame (by the cloud's own distance, so it holds while the camera turns and flies),
//                clamps it to this frame's neighbourhood (no ghosts) and blends ~10 % of the new
//                frame in: the noise averages away instead of boiling. Reset on cuts.
//   4. composite into the HDR frame (Post.js) with a depth-aware upsample: scene x transmittance +
//                in-scattered light, into Post's composite target, writing the scene's depth there
//                too: Post.js draws the transparent things near the camera (the burner plume, the
//                canopy, sprites) after this, depth tested, so a cloud behind the jet never covers
//                its plume, without a second MSAA resolve.
//
// The terrain, roads and vegetation get the clouds' shadows without a texture (atmoCloudShadow
// evaluates the same field where the sun's ray crosses the layer); three's own materials (the jet,
// buildings) get them per fragment from js/env/cloudShadowChunk.js. Inside a cloud the exposure
// meter sees less light (env.lightScale).
//
// The GPU time of the clouds is measured when the browser allows it (Post.js gpuTimes); on high,
// if it stays over budgetMs (2.5 ms) for two seconds, the clouds step down to the medium tier.

import * as THREE from 'three';
import { ATMOSPHERE_PARS } from './atmosphereGLSL.js';
import { thresholdFor, shadowAt, fieldAt } from './cloudField.js';

/**
 * Weather presets: cumulus coverage (fraction of the sky), base and top (m MSL), feature scale (m),
 * extinction (1/m). Fair-weather cumulus over Israel in summer: bases ~1500-2000 m, tops ~2500-3200 m
 * (the bases were ~1300 m: the Jerusalem sunset start at 1500 m was inside the clouds).
 */
export const CLOUD_PRESETS = {
  clear: { label: 'Clear' },
  few: { label: 'Few cumulus', cu: { coverage: 0.12, base: 1800, top: 2850, scale: 2600, density: 0.05 } },
  scattered: { label: 'Scattered', cu: { coverage: 0.32, base: 1700, top: 3150, scale: 3200, density: 0.055 } },
  broken: { label: 'Broken', cu: { coverage: 0.62, base: 1500, top: 2850, scale: 4200, density: 0.06 } },
  cirrus: { label: 'High cirrus', ci: { coverage: 0.5, alt: 9500, opacity: 0.5 }, cu: { coverage: 0.04, base: 1900, top: 2650, scale: 2600, density: 0.05 } },
};
export const DEFAULT_CLOUDS = 'few';

/**
 * Per quality: resolution divisor, most steps along a ray, fewest steps across the cloud slab
 * (a deck seen edge-on), light steps, detail erosion, the shortest step (m) and its growth with the
 * distance (a pixel covers more there), the distance (m) where the fine detail is gone.
 */
export const CLOUD_TIERS = {
  low: { div: 4, steps: 64, minSteps: 14, lightSteps: 3, detail: 0, dtMin: 30, dtGrow: 0.03, detailDist: 0 },
  medium: { div: 2, steps: 104, minSteps: 20, lightSteps: 4, detail: 1, dtMin: 18, dtGrow: 0.022, detailDist: 6000 },
  high: { div: 2, steps: 144, minSteps: 28, lightSteps: 5, detail: 1, dtMin: 12, dtGrow: 0.016, detailDist: 9000 },
};

const COVER_N = 1024;
const COVER_HALF = 60000;            // m: the cover map spans +-60 km around the camera
const MAX_DIST = 150000;             // m: the march ends here (the deck dissolves into the haze)
const NOISE_N = 64;
const WIND = [5.5, 0, 1.5];          // m/s: a summer day's westerly sea breeze (towards the east)
// cloud shadows: the sun's light under a cumulus is exp(-SHADOW_DEPTH) of the clear value. Not the
// cloud's optical depth (~50): most of the light gets through diffusely (~15 % under a 1 km cumulus)
const SHADOW_DEPTH = 1.8;
// The cities' light on the cloud bases at night (the terrain's city lights: Tel Aviv - Jaffa the
// brightest, then Jerusalem; the same centres as terrainShaders.js cityLights), sodium-orange
const CITY_GLOW = [1.0, 0.6, 0.3];
const CITY_GLOW_LEVEL = 1.6e-3;      // upward radiance under a city at night (as tuned at exposure 40)

const FULLSCREEN_VERT = /* glsl */`
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ---------------------------------------------------------------------------------------
// 3D noise: tiling Perlin-Worley (r) and Worley fBm at three frequencies (g, b, a)

const NOISE_FRAG = /* glsl */`
  precision highp float;
  uniform float uLayer;
  in vec2 vUv;
  out vec4 outColor;
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float worley(vec3 p, float period) {
    vec3 id = floor(p), f = fract(p);
    float d = 1.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 n = vec3(float(x), float(y), float(z));
      vec3 c = mod(id + n, period);
      vec3 r = n + hash33(c) - f;
      d = min(d, dot(r, r));
    }
    return clamp(sqrt(d), 0.0, 1.0);
  }
  float gnoise(vec3 p, float period) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float v[8];
    for (int k = 0; k < 8; k++) {
      vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
      vec3 g = normalize(hash33(mod(i + o, period)) * 2.0 - 1.0);
      v[k] = dot(g, f - o);
    }
    float x0 = mix(v[0], v[1], u.x), x1 = mix(v[2], v[3], u.x), x2 = mix(v[4], v[5], u.x), x3 = mix(v[6], v[7], u.x);
    return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z);
  }
  float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
  void main() {
    vec3 p = vec3(vUv, (uLayer + 0.5) / ${NOISE_N.toFixed(1)});
    float pf = 0.0, amp = 0.5, fr = 4.0;
    for (int o = 0; o < 4; o++) { pf += amp * gnoise(p * fr, fr); amp *= 0.5; fr *= 2.0; }
    pf = clamp(pf * 0.9 + 0.5, 0.0, 1.0);
    float w1 = 1.0 - worley(p * 4.0, 4.0), w2 = 1.0 - worley(p * 8.0, 8.0);
    float w3 = 1.0 - worley(p * 16.0, 16.0), w4 = 1.0 - worley(p * 32.0, 32.0);
    float wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
    float pw = clamp(remap(pf, wf - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
    outColor = vec4(pw, w2 * 0.625 + w3 * 0.25 + w4 * 0.125, w3 * 0.625 + w4 * 0.375, w4);
  }`;

// ---------------------------------------------------------------------------------------
// cover map: the raw field around the camera, in field coordinates (world xz + the drift)

const COVER_FRAG = /* glsl */`
  precision highp float;
  uniform vec4 uWin;              // x0, z0 (field coordinates, min corner), size (m)
  in vec2 vUv;
  out vec4 outColor;
  ${ATMOSPHERE_PARS}
  void main() {
    vec2 f = uWin.xy + vUv * uWin.z;
    outColor = vec4(atmoCloudField(f / uCloudWind.z), 0.0, 0.0, 1.0);
  }`;

// ---------------------------------------------------------------------------------------
// ray march

const DEPTH_FN = /* glsl */`
  float viewZ(float d) {
    if (uDepthParams.w < 0.5) return d >= 1.0 ? 1e9 : exp2(d * uDepthParams.z) - 1.0;
    float n = uDepthParams.x, f = uDepthParams.y;
    if (uDepthParams.w < 1.5) return d <= 0.0 ? 1e9 : n * f / (d * (f - n) + n);
    if (d >= 1.0) return 1e9;
    float z = d * 2.0 - 1.0;
    return 2.0 * n * f / ((f + n) - z * (f - n));
  }`;

const MARCH_FRAG = /* glsl */`
  precision highp float;
  precision highp sampler3D;
  uniform sampler2D tDepth;
  uniform sampler3D tNoise;
  uniform sampler2D tCover;
  uniform vec4 uCoverWin;         // x0, z0 (field coordinates), 1 / size, -
  uniform vec2 uFullSize;
  uniform float uDiv;
  uniform mat4 uProjInv;
  uniform mat4 uViewInv;
  uniform vec4 uDepthParams;      // near, far, log2(far + 1), mode (0 log, 1 reversed, 2 standard)
  uniform vec4 uMarch;            // most steps, light steps, fewest steps across the slab, frame (0..15)
  uniform vec4 uStep;             // shortest step (m), growth with distance, detail distance (m), -
  uniform vec4 uLight;            // direction to the sun (or the moon), irradiance above the atmosphere
  uniform vec3 uLightTint;
  uniform vec3 uAmbSky;           // mean sky radiance on the clouds (scene units)
  uniform vec3 uAmbGround;        // radiance of the ground below
  uniform vec3 uCityGlow;         // upward radiance under the brightest city at night
  uniform vec4 uShape;            // shape period, detail period (m), extinction (1/m), detail (0/1)
  uniform vec4 uCirrus;           // altitude (m), field threshold, opacity (0: none), scale (m)
  uniform vec2 uWindXZ;           // drift of the 3D noise (m)
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;   // in-scattered light, transmittance
  layout(location = 1) out vec4 outDist;    // distance to the cloud (km, light weighted), 0: none
  ${ATMOSPHERE_PARS}
  ${DEPTH_FN}

  float hg(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  }
  float remap01(float v, float lo, float hi) { return clamp((v - lo) / max(hi - lo, 1e-4), 0.0, 1.0); }
  // the footprint field at field coordinates (world xz + drift)
  float coverAt(vec2 f) {
    vec2 uv = (f - uCoverWin.xy) * uCoverWin.z;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return atmoCloudField(f / uCloudWind.z);
    return texture(tCover, uv).r;
  }
  // The footprint is pushed around by up to +-WARP m (the noise's ~270 m Worley octaves): the
  // walls lean, bulge and break up with height instead of standing as extruded outlines. Empty air
  // (EMPTY: no footprint even after the push) is crossed in long steps.
  const float WARP = 150.0;
  const float EMPTY = 0.07;
  // cumulus density 0..1 at world position p, height h (m MSL); lod 0: all the detail .. 1: none.
  // aoSky / aoGround: how much of the sky above / the ground below reaches this point
  float density(vec3 p, float h, float lod, out float aoSky, out float aoGround) {
    aoSky = 1.0; aoGround = 1.0;
    float base = uCloudLayer.x, top = uCloudLayer.y;
    float hf = (h - base) / (top - base);
    if (hf <= 0.0 || hf >= 1.0) return 0.0;
    vec4 n = texture(tNoise, vec3(p.x + uWindXZ.x, h, p.z + uWindXZ.y) / uShape.x);
    vec2 warp = (n.gb - vec2(0.55, 0.5)) * (2.0 * WARP);
    float v = coverAt(p.xz + uCloudWind.xy + warp);
    // narrower towards the top (towers, not prisms)
    float th = uCloudLayer.z + 0.08 * hf * hf;
    float cell = smoothstep(th - 0.02, th + 0.1, v);
    if (cell <= 0.0) return 0.0;
    // flat base, rounded top; the middle of a cloud towers higher
    float topF = 0.35 + 0.65 * smoothstep(th, th + 0.18, v);
    float prof = smoothstep(0.0, 0.07, hf) * smoothstep(topF, topF * 0.4, hf);
    float shape = cell * prof;
    if (shape <= 0.0) return 0.0;
    // erosion: the noise eats the edges and the top first (a remap, so the core stays solid)
    float billow = n.r * 0.6 + n.g * 0.4;
    float d = remap01(shape, (1.0 - billow) * 0.72, 1.0);
    if (d <= 0.0) return 0.0;
    // near the camera: the fine Worley octaves (~100, 50, 25 m), wispy below, billowy above
    if (lod < 0.999 && d < 0.75) {
      vec4 nd = texture(tNoise, vec3(p.x + uWindXZ.x * 1.6, h, p.z + uWindXZ.y * 1.6) / uShape.y);
      float det = mix(nd.g, 1.0 - nd.g, smoothstep(0.1, 0.5, hf));
      d = remap01(d, det * 0.38 * (1.0 - lod), 1.0);
    }
    // the cloud above and below this point (a column of ~1 km leaves ~20 % of the sky's light)
    float hTop = base + topF * (top - base) * 0.92;
    aoSky = mix(0.18, 1.0, exp(-max(hTop - h, 0.0) * cell / 380.0));
    aoGround = mix(0.35, 1.0, exp(-max(h - base, 0.0) * cell / 260.0));
    return clamp(d * 1.5, 0.0, 1.0);
  }
  float heightOf(vec3 rel, float rc) {
    return length(vec3(rel.x, rel.y + rc, rel.z)) - uAtmoGeom.x;
  }
  // distances along the ray (from a camera at radius rc) to the sphere of radius R: (near, far)
  vec2 sphere(float rc, vec3 d, float R) {
    float b = rc * d.y;
    float c = rc * rc - R * R;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(-1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }
  // interleaved gradient noise (Jimenez 2014), a new offset each frame: with the temporal filter
  // the ray starts cover a step evenly over 16 frames
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  // the cities' glow on the cloud bases (Tel Aviv - Jaffa, Jerusalem, and the rest of the coast)
  vec3 cityGlow(vec2 xz) {
    float tlv = exp(-length(xz - vec2(-22900.0, -31600.0)) / 14000.0);
    float jlm = exp(-length(xz - vec2(17900.0, 3500.0)) / 9000.0);
    return uCityGlow * (0.12 + 0.9 * tlv + 0.5 * jlm);
  }

  // Light scattered towards the eye by a unit of cloud at optical depth tau from the sun:
  //   single scattering   phase (a strong forward lobe: the silver lining, and a weak backward
  //                       one) x the direct sun that is left, exp(-tau);
  //   multiple scattering a cloud is white because light bounces hundreds of times: the diffuse
  //                       light at depth tau falls off slowly, ~1 / (1 + 0.11 tau) (two-stream
  //                       diffusion with g = 0.85), and is isotropic. MS_A sets its level: a thick
  //                       sunlit cloud reaches ~0.7 of a white surface in the sun (E / pi), the base
  //                       of a 1 km cumulus with the sun overhead ~0.1-0.15 (both as observed).
  //   powder              the diffuse light builds up over the first few metres inside: the thin
  //                       sunlit edges and creases are darker seen with the sun behind (pow).
  const float MS_A = 2.8;
  const float MS_K = 0.11;
  vec3 sunScatter(vec3 sunE, float tau, float cosT, float pow) {
    float ss = mix(hg(cosT, 0.8), hg(cosT, -0.25), 0.25);
    return sunE * (ss * exp(-tau) + MS_A * 0.0795775 / (1.0 + MS_K * tau) * pow);
  }

  void main() {
    // the ray of this pixel
    vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dv = normalize(vp.xyz / vp.w);
    vec3 dir = normalize(mat3(uViewInv) * dv);
    ivec2 ft = ivec2(floor(gl_FragCoord.xy) * uDiv + uDiv * 0.5);
    ft = clamp(ft, ivec2(0), ivec2(uFullSize) - 1);
    float tMax = min(viewZ(texelFetch(tDepth, ft, 0).r) / max(-dv.z, 1e-4), float(${MAX_DIST}.0));

    float Rg = uAtmoGeom.x;
    float rc = Rg + uCamAltitude;
    float base = uCloudLayer.x, top = uCloudLayer.y;
    vec3 L = vec3(0.0);
    float T = 1.0;
    float tw = 0.0, wsum = 0.0;
    float cosT = dot(dir, uLight.xyz);
    // the earth in the way?
    vec2 g = sphere(rc, dir, Rg + min(uGroundDatum, 0.0));
    float tGround = (g.x > 0.0) ? g.x : 1e12;
    float tEnd = min(tMax, tGround);
    float jit = ign(gl_FragCoord.xy + 5.588238 * uMarch.w);

    if (uCloudLayer.w > 0.0) {
      vec2 sb = sphere(rc, dir, Rg + base), st = sphere(rc, dir, Rg + top);
      float t0, t1;
      if (uCamAltitude < base) { t0 = sb.y; t1 = st.y; }
      else if (uCamAltitude < top) { t0 = 0.0; t1 = (sb.x > 0.0) ? sb.x : st.y; }
      else { t0 = st.x; t1 = (sb.x > 0.0) ? sb.x : st.y; if (st.x < 0.0) t1 = -1.0; }
      t0 = max(t0, 0.0);
      t1 = min(t1, tEnd);
      if (t1 > t0) {
        // step: short near the camera, growing with distance, but at least uMarch.z steps across
        // the slab, so a cloud deck seen edge-on is not skipped; three times longer in empty air
        int steps = int(uMarch.x);
        float dtSpan = max((t1 - t0) / uMarch.z, uStep.x);
        float t = t0;
        float dt = min(uStep.x + t * uStep.y + t * t / 250000.0, dtSpan);
        t += dt * jit;
        vec3 sunE = vec3(-1.0);
        float sigma0 = uShape.z;
        bool coarse = true, wasLong = false;
        int emptyRun = 0;
        float aoS, aoG, aoS2, aoG2;
        for (int i = 0; i < 200; i++) {
          if (i >= steps || t > t1 || T < 0.01) break;
          dt = min(uStep.x + t * uStep.y + t * t / 250000.0, dtSpan);
          vec3 rel = dir * t;
          vec3 p = uCameraPos + rel;
          float h = heightOf(rel, rc);
          if (coarse) {
            // empty air: no footprint here even after the warp, or above the tallest top it allows
            float v = coverAt(p.xz + uCloudWind.xy) + EMPTY;
            float th = uCloudLayer.z;
            float hfTop = 0.35 + 0.65 * smoothstep(th, th + 0.18, v);
            if (v < th || (h - base) / (top - base) > hfTop + 0.03) { t += dt * 3.0; wasLong = true; continue; }
            // a cloud may start within the last long step: go back and walk in short steps (not
            // after short ones: back in a footprint whose cloud was eroded away, walk on)
            coarse = false;
            if (wasLong) { t = max(t0, t - dt * 2.0); wasLong = false; continue; }
          }
          wasLong = false;
          float lod = uShape.w > 0.5 ? smoothstep(uStep.z * 0.5, uStep.z, t) : 1.0;
          float dens = density(p, h, lod, aoS, aoG);
          if (dens > 0.0) {
            emptyRun = 0;
            vec3 up = normalize(vec3(rel.x, rel.y + rc, rel.z));
            float lu = dot(up, uLight.xyz);
            if (sunE.x < 0.0) {
              // the light at the cloud's height (still lit when the sun has set on the ground)
              sunE = uLight.w * uLightTint * atmoTransmittance(Rg + h, lu);
            }
            // optical depth towards the light: steps of 70 m doubling (to ~2 km)
            float tau = 0.0, ls = 70.0, lt = 0.0;
            for (int k = 0; k < 6; k++) {
              if (k >= int(uMarch.y)) break;
              lt += ls * 0.5;
              tau += density(p + uLight.xyz * lt, h + lu * lt, 1.0, aoS2, aoG2) * sigma0 * ls;
              lt += ls * 0.5;
              ls *= 2.0;
            }
            float powder = mix(1.0, 1.0 - 0.5 * exp(-2.0 * tau - dens * 4.0), 0.5 - 0.5 * cosT);
            vec3 S = sunScatter(sunE, tau, cosT, powder);
            // sky light from above, the ground's (and the cities') from below
            S += uAmbSky * aoS + (uAmbGround + cityGlow(p.xz)) * aoG * 0.8;
            float sigma = dens * sigma0;
            float sT = exp(-sigma * dt);
            L += T * S * (1.0 - sT);
            float w = T * (1.0 - sT);
            tw += t * w; wsum += w;
            T *= sT;
          } else if (++emptyRun > 6) {
            coarse = true;
            emptyRun = 0;
          }
          t += dt;
        }
      }
    }
    // aerial perspective between the camera and the clouds
    if (wsum > 0.0) {
      float dm = tw / wsum;
      vec3 rel = dir * dm;
      vec3 tA, inA;
      atmoAerialParts(dir, dm, heightOf(rel, rc), tA, inA);
      L = inA * (1.0 - T) + tA * L;
    }

    // cirrus: a thin sheet high above. Patches (a low-frequency field, threshold from the preset's
    // coverage) of fibres: long streaks along the upper wind, 0.5-1 km across, bent by a domain warp
    if (uCirrus.z > 0.0 && uCamAltitude < uCirrus.x && T > 0.01) {
      vec2 sc = sphere(rc, dir, Rg + uCirrus.x);
      float tc = sc.y;
      if (tc > 0.0 && tc < tEnd && tc < 400000.0) {
        vec3 p = uCameraPos + dir * tc;
        vec2 w = normalize(vec2(${WIND[0].toFixed(2)}, ${WIND[2].toFixed(2)}));
        vec2 xz = p.xz + uCloudWind.xy * 2.5;
        vec2 r = vec2(dot(xz, w), dot(xz, vec2(-w.y, w.x))) / uCirrus.w;   // along, across the wind
        float patchv = atmoCloudField(r * vec2(0.35, 0.6) + vec2(13.7, 4.1));
        float mask = smoothstep(uCirrus.y, uCirrus.y + 0.2, patchv);
        float alpha = 0.0;
        if (mask > 0.0) {
          vec2 q = r + 0.6 * vec2(atmoValueNoise(r * 0.9 + 3.1), atmoValueNoise(r * 0.9 + 7.7)) - 0.3;
          float fib = atmoValueNoise(q * vec2(1.2, 9.0)) * 0.65 + atmoValueNoise(q * vec2(2.6, 21.0)) * 0.35;
          alpha = uCirrus.z * mask * smoothstep(0.42, 0.85, fib);
        }
        alpha *= smoothstep(400000.0, 150000.0, tc);
        if (alpha > 0.0) {
          vec3 up = normalize(vec3(dir.x * tc, dir.y * tc + rc, dir.z * tc));
          vec3 sunC = uLight.w * uLightTint * atmoTransmittance(Rg + uCirrus.x, dot(up, uLight.xyz));
          vec3 Lc = sunC * (0.6 * hg(cosT, 0.8) + 0.04) + uAmbSky * 0.7;
          vec3 tA, inA;
          atmoAerialParts(dir, tc, uCirrus.x, tA, inA);
          L += T * (inA * alpha + tA * Lc * alpha);
          float wc = T * alpha;
          tw += tc * wc; wsum += wc;
          T *= 1.0 - alpha;
        }
      }
    }
    outColor = vec4(L, T);
    outDist = vec4(wsum > 1e-4 ? tw / wsum * 0.001 : 0.0, 0.0, 0.0, 1.0);
  }`;

// ---------------------------------------------------------------------------------------
// temporal filter (low resolution): last frame's result reprojected, clamped, blended

const RESOLVE_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tCur;         // this frame's march: light, transmittance
  uniform sampler2D tDist;        // this frame's distance to the cloud (km)
  uniform sampler2D tHist;        // the filtered result of the last frame
  uniform mat4 uProjInv;
  uniform mat4 uViewInv;
  uniform mat4 uPrevVP;           // last frame's projection x view, the camera at the origin
  uniform vec3 uCamDelta;         // camera position now - last frame (m)
  uniform vec2 uLowSize;
  uniform vec2 uBlend;            // weight of this frame (static camera), of a moving one
  uniform float uDefaultKm;       // distance for pixels without cloud (the layer)
  in vec2 vUv;
  out vec4 outColor;
  void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    ivec2 hi = ivec2(uLowSize) - 1;
    vec4 c = texelFetch(tCur, px, 0);
    // this frame's neighbourhood: mean and spread (variance clipping, Salvi 2016) and bounds
    vec4 m1 = vec4(0.0), m2 = vec4(0.0), mn = c, mx = c;
    float dk = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        ivec2 q = clamp(px + ivec2(i, j), ivec2(0), hi);
        vec4 s = texelFetch(tCur, q, 0);
        m1 += s; m2 += s * s;
        mn = min(mn, s); mx = max(mx, s);
        dk = max(dk, texelFetch(tDist, q, 0).r);
      }
    }
    m1 /= 9.0;
    vec4 sd = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
    vec4 lo = max(mn, m1 - 1.25 * sd), up = min(mx, m1 + 1.25 * sd);
    // where was this cloud last frame? (its own distance: holds while the camera turns and flies)
    float d = texelFetch(tDist, px, 0).r;
    d = (d > 0.0 ? d : (dk > 0.0 ? dk : uDefaultKm)) * 1000.0;
    vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = normalize(mat3(uViewInv) * normalize(vp.xyz / vp.w));
    vec4 pc = uPrevVP * vec4(dir * d + uCamDelta, 1.0);
    vec2 puv = pc.xy / max(pc.w, 1e-6) * 0.5 + 0.5;
    bool valid = pc.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0))) && uBlend.x < 1.0;
    vec4 o;
    if (valid) {
      vec4 h = clamp(texture(tHist, puv), lo, up);
      // a moving image keeps less of its history (less smearing)
      float motion = length((puv - vUv) * uLowSize);
      float a = mix(uBlend.x, uBlend.y, clamp(motion / 3.0, 0.0, 1.0));
      o = mix(h, c, a);
    } else {
      // no history (a cut, or just come into view): this frame, smoothed a little
      o = mix(c, m1, 0.5);
    }
    outColor = o;
  }`;

// ---------------------------------------------------------------------------------------
// composite into the HDR frame, depth-aware upsample; writes the scene's depth too

const COMPOSITE_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tScene;
  uniform sampler2D tCloud;
  uniform sampler2D tDepth;
  uniform vec2 uLowSize;
  uniform vec2 uFullSize;
  uniform float uDiv;
  uniform vec4 uDepthParams;
  in vec2 vUv;
  out vec4 outColor;
  ${DEPTH_FN}
  void main() {
    vec3 s = texture(tScene, vUv).rgb;
    ivec2 fp = ivec2(gl_FragCoord.xy);
    float dz = texelFetch(tDepth, fp, 0).r;
    float z0 = log(viewZ(dz));
    // 3 x 3 low-resolution texels around this pixel: a gaussian of the distance (a little wider
    // than bilinear) times a depth weight (no cloud bleeding over the jet's or a hill's silhouette)
    vec2 q = gl_FragCoord.xy / uDiv - 0.5;
    vec2 c0 = floor(q + 0.5);
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 lp = clamp(c0 + vec2(float(i), float(j)), vec2(0.0), uLowSize - 1.0);
        ivec2 ft = clamp(ivec2(lp * uDiv + uDiv * 0.5), ivec2(0), ivec2(uFullSize) - 1);
        float zk = log(viewZ(texelFetch(tDepth, ft, 0).r));
        vec2 d = lp - q;
        float w = exp(-dot(d, d) * 1.1) * exp(-abs(zk - z0) * 6.0) + 1e-6;
        acc += texelFetch(tCloud, ivec2(lp), 0) * w;
        wsum += w;
      }
    }
    vec4 c = acc / wsum;
    outColor = vec4(s * c.a + c.rgb, 1.0);
    // the scene's depth, for the transparent things Post.js draws next
    gl_FragDepth = dz;
  }`;

function fsMaterial(name, fragmentShader, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({
    name, uniforms, vertexShader: FULLSCREEN_VERT, fragmentShader, glslVersion: THREE.GLSL3,
    depthTest: false, depthWrite: false, toneMapped: false, ...extra,
  });
}

function lowTarget(w, h, count = 1) {
  const t = new THREE.WebGLRenderTarget(w, h, {
    count, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  for (const x of t.textures) x.colorSpace = THREE.NoColorSpace;
  return t;
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class Clouds {
  constructor(ctx) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;
    this.env = ctx.env;
    this.app = ctx.app;
    this.enabled = true;
    this.preset = null;
    this.quality = 'high';
    this.tier = CLOUD_TIERS.high;
    this.wind = [0, 0];                // field offset (m)
    /** The temporal filter (off: every frame stands alone, as noisy as the march). */
    this.temporal = true;
    /** GPU time budget of the clouds on high (ms; null: never step down). */
    this.budgetMs = 2.5;
    this.fallback = null;              // the tier the budget stepped down to
    this._frame = 0;
    this._over = 0;
    const U = this.env.uniforms;

    // fullscreen triangle
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    this._quad = new THREE.Mesh(g, null);
    this._quad.frustumCulled = false;
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // 3D noise
    this._noiseRT = new THREE.WebGL3DRenderTarget(NOISE_N, NOISE_N, NOISE_N, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    });
    const nt = this._noiseRT.texture;
    nt.minFilter = nt.magFilter = THREE.LinearFilter;
    nt.wrapS = nt.wrapT = nt.wrapR = THREE.RepeatWrapping;
    nt.generateMipmaps = false;
    nt.colorSpace = THREE.NoColorSpace;
    this._noiseMat = fsMaterial('CloudNoise', NOISE_FRAG, { uLayer: { value: 0 } });
    this._noiseReady = false;

    // cover map (redrawn when its window moves: see render())
    this._coverRT = new THREE.WebGLRenderTarget(COVER_N, COVER_N, {
      type: THREE.UnsignedByteType, format: THREE.RedFormat, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this._coverRT.texture.colorSpace = THREE.NoColorSpace;
    this._coverMat = fsMaterial('CloudCover', COVER_FRAG, { ...U, uWin: { value: new THREE.Vector4() } });
    this._coverKey = '';

    // march (two targets: light + transmittance, distance), temporal filter (two, ping-pong)
    this._marchRT = null;
    this._hist = [null, null];
    this._histIndex = 0;
    this._histValid = false;
    this._histN = 0;                     // frames since the filter started afresh
    this._prevVP = new THREE.Matrix4();
    this._prevPos = new THREE.Vector3();
    this._prevDir = new THREE.Vector3();
    this._marchMat = fsMaterial('CloudMarch', MARCH_FRAG, {
      ...U,
      tDepth: { value: null }, tNoise: { value: nt }, tCover: { value: this._coverRT.texture },
      uCoverWin: { value: new THREE.Vector4() }, uFullSize: { value: new THREE.Vector2() }, uDiv: { value: 2 },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uDepthParams: { value: new THREE.Vector4() }, uMarch: { value: new THREE.Vector4() },
      uStep: { value: new THREE.Vector4() },
      uLight: { value: new THREE.Vector4() }, uLightTint: { value: new THREE.Color(1, 1, 1) },
      uAmbSky: { value: new THREE.Color() }, uAmbGround: { value: new THREE.Color() }, uCityGlow: { value: new THREE.Color() },
      uShape: { value: new THREE.Vector4(2200, 800, 0.05, 0) }, uCirrus: { value: new THREE.Vector4() },
      uWindXZ: { value: new THREE.Vector2() },
    });
    this._resolveMat = fsMaterial('CloudResolve', RESOLVE_FRAG, {
      tCur: { value: null }, tDist: { value: null }, tHist: { value: null },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() }, uCamDelta: { value: new THREE.Vector3() },
      uLowSize: { value: new THREE.Vector2() }, uBlend: { value: new THREE.Vector2(0.1, 0.3) }, uDefaultKm: { value: 5 },
    });
    // the composite writes the scene's depth into Post's composite target (depth test always)
    this._compMat = fsMaterial('CloudComposite', COMPOSITE_FRAG, {
      tScene: { value: null }, tCloud: { value: null }, tDepth: { value: null },
      uLowSize: { value: new THREE.Vector2() }, uFullSize: { value: new THREE.Vector2() }, uDiv: { value: 2 },
      uDepthParams: { value: new THREE.Vector4() },
    }, { depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth });

    // without the HDR chain (?post=0) there is nowhere to draw them: no clouds, no shadows
    if (!this.app?.post) this.enabled = false;
    // preset: ?clouds= wins for this session (until the menu is used), then the saved setting
    // (settings.clouds, the menu's Weather buttons), then the default
    const p = new URLSearchParams(location.search).get('clouds');
    this._urlPreset = p && CLOUD_PRESETS[p] ? p : null;
    this._setting = this.app?.settings?.clouds;
    this.setPreset(this._urlPreset || this._setting || DEFAULT_CLOUDS);
    this.app?.post?.setClouds?.(this);
    if (this.app) this.app.clouds = this;   // the menu asks for the preset in effect (Menu.js)
  }

  /** The menu's choice: replaces a ?clouds= override. */
  choose(name) {
    this._urlPreset = null;
    if (this.app?.settings) this.app.settings.clouds = name;
    this._setting = name;
    this.setPreset(name);
  }

  /** 'clear' | 'few' | 'scattered' | 'broken' | 'cirrus'. */
  setPreset(name) {
    if (!CLOUD_PRESETS[name]) name = DEFAULT_CLOUDS;
    this.preset = name;
    const P = CLOUD_PRESETS[name];
    const U = this.env.uniforms;
    if (P.cu) {
      this.layer = { base: P.cu.base, top: P.cu.top, scale: P.cu.scale, threshold: thresholdFor(P.cu.coverage), opticalDepth: SHADOW_DEPTH, density: P.cu.density };
      U.uCloudLayer.value.set(P.cu.base, P.cu.top, this.layer.threshold, this.enabled ? this.layer.opticalDepth : 0);
      U.uCloudWind.value.z = P.cu.scale;
    } else {
      this.layer = null;
      U.uCloudLayer.value.w = 0;
    }
    this.cirrus = P.ci ? { alt: P.ci.alt, threshold: thresholdFor(P.ci.coverage), opacity: P.ci.opacity } : null;
    this.resetHistory();
  }

  /** Something to draw (Post.js asks before splitting the frame). */
  active() {
    return this.enabled && (!!this.layer || !!this.cirrus);
  }

  setQuality(q) {
    this.quality = CLOUD_TIERS[q] ? q : 'high';
    this.tier = CLOUD_TIERS[this.quality];
    this.fallback = null;
    this._over = 0;
    this._lowW = 0;
  }

  setTime() { this.resetHistory(); }

  /** The next frame starts the temporal filter afresh (a cut: teleport, time jump, new weather). */
  resetHistory() { this._histValid = false; }

  reset() { this.env.lightScale = 1; this.resetHistory(); }

  update(f) {
    // settings.clouds changed (the menu, the console): it replaces a ?clouds= override
    const s = this.app?.settings?.clouds;
    if (s !== this._setting) { this._setting = s; this._urlPreset = null; }
    const want = this._urlPreset || s || DEFAULT_CLOUDS;
    if (want !== this.preset) this.setPreset(want);
    const dt = Math.min(f.dt || 0, 0.25);
    this.wind[0] -= WIND[0] * dt;
    this.wind[1] -= WIND[2] * dt;
    const U = this.env.uniforms;
    U.uCloudWind.value.x = this.wind[0];
    U.uCloudWind.value.y = this.wind[1];
    const env = this.env;
    env.lightScale = 1;
    if (!this.layer || !this.enabled) return;
    const L = this.layer;
    const dir = env.lightDirection || env.sunDirection;
    // (the shadows on the jet and the other standard materials are per fragment now:
    // js/env/cloudShadowChunk.js; the directional light itself is left alone)
    // what the exposure meter sees (the eye adapts a little): less in a cloud's shadow, much less
    // inside a cloud. On every frame: the test API's settle() adapts the exposure between frames
    // that are not drawn
    const cam = f.camera.getWorldPosition(_v);
    let scale = 0.55 + 0.45 * shadowAt(cam.x, cam.y, cam.z, dir, L, this.wind);
    if (cam.y > L.base && cam.y < L.top) {
      const v = fieldAt((cam.x + this.wind[0]) / L.scale, (cam.z + this.wind[1]) / L.scale);
      const inside = Math.min(1, Math.max(0, (v - L.threshold) / 0.08));
      scale *= 1 - 0.55 * inside;
    }
    env.lightScale = scale;
    this._checkBudget();
  }

  /** On high, step down to medium if the measured GPU time stays over budget (Post.js gpuTimes). */
  _checkBudget() {
    const g = this.app?.post?.gpuTimes;
    if (!this.budgetMs || !g || !(g.clouds > 0) || this.quality !== 'high' || this.fallback) return;
    this._over = g.clouds > this.budgetMs ? this._over + 1 : Math.max(0, this._over - 2);
    if (this._over > 120) {
      this.fallback = 'medium';
      this.tier = CLOUD_TIERS.medium;
      this._lowW = 0;
      console.info(`Clouds: ${g.clouds.toFixed(2)} ms on the GPU (budget ${this.budgetMs} ms): medium tier`);
    }
  }

  _ensureTargets(width, height) {
    const div = this.tier.div;
    const w = Math.max(1, Math.ceil(width / div)), h = Math.max(1, Math.ceil(height / div));
    if (this._marchRT && this._lowW === w && this._lowH === h) return;
    this._marchRT?.dispose();
    for (const t of this._hist) t?.dispose();
    this._marchRT = lowTarget(w, h, 2);
    this._hist = [lowTarget(w, h), lowTarget(w, h)];
    this._lowW = w; this._lowH = h;
    this._histValid = false;
  }

  _pass(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quad, this._cam);
  }

  _makeNoise() {
    const r = this.renderer;
    for (let z = 0; z < NOISE_N; z++) {
      this._noiseMat.uniforms.uLayer.value = z;
      this._quad.material = this._noiseMat;
      r.setRenderTarget(this._noiseRT, z);
      r.render(this._quad, this._cam);
    }
    this._noiseReady = true;
  }

  _depthParams(camera, out) {
    const r = this.renderer;
    const mode = r.capabilities.logarithmicDepthBuffer ? 0 : (r.capabilities.reversedDepthBuffer ? 1 : 2);
    out.set(camera.near, camera.far, Math.log2(camera.far + 1), mode);
  }

  /** Ray march the clouds and filter them in time, at low resolution (Post.js, after the scene). */
  render(r, { depth, camera, width, height }) {
    if (!this._noiseReady) this._makeNoise();
    this._frame++;
    this._ensureTargets(width, height);
    const env = this.env, U = env.uniforms, T = this.tier;
    // cover map around the camera, in the wind's frame, snapped to its texels: the same map serves
    // until the camera or the drift moves it by a texel (~117 m)
    const cp = camera.getWorldPosition(_v);
    const texel = 2 * COVER_HALF / COVER_N;
    const fx = cp.x + this.wind[0], fz = cp.z + this.wind[1];
    const x0 = Math.floor((fx - COVER_HALF) / texel) * texel, z0 = Math.floor((fz - COVER_HALF) / texel) * texel;
    const key = `${x0}|${z0}|${U.uCloudWind.value.z}`;
    if (key !== this._coverKey) {
      this._coverKey = key;
      this._coverMat.uniforms.uWin.value.set(x0, z0, 2 * COVER_HALF, 0);
      this._pass(this._coverMat, this._coverRT);
    }

    const M = this._marchMat.uniforms;
    M.tDepth.value = depth;
    M.uCoverWin.value.set(x0, z0, 1 / (2 * COVER_HALF), 0);
    M.uFullSize.value.set(width, height);
    M.uDiv.value = T.div;
    camera.updateMatrixWorld();
    M.uProjInv.value.copy(camera.projectionMatrixInverse);
    M.uViewInv.value.copy(camera.matrixWorld);
    this._depthParams(camera, M.uDepthParams.value);
    M.uMarch.value.set(T.steps, T.lightSteps, T.minSteps, this.temporal ? this._frame % 16 : 0);
    M.uStep.value.set(T.dtMin, T.dtGrow, Math.max(1, T.detailDist), 0);
    // the light: the sun, or the (boosted) moon once the sun is down
    if (env.lightIsMoon && env.moon) {
      const e = env._moonLightBoosted ? env._moonLightBoosted() : 0;
      M.uLight.value.set(env.lightDirection.x, env.lightDirection.y, env.lightDirection.z, e);
      M.uLightTint.value.setRGB(1.04, 1.0, 0.93);
    } else {
      M.uLight.value.set(env.sunDirection.x, env.sunDirection.y, env.sunDirection.z, U.uSunIlluminance.value);
      M.uLightTint.value.setRGB(1, 1, 1);
    }
    M.uAmbSky.value.copy(U.uAmbient.value).multiplyScalar(1 / Math.PI);
    M.uAmbGround.value.copy(U.uGroundRadiance.value);
    // the cities' light under the clouds: on with the street lights (uNight, which also carries
    // the gain that keeps the lights as they were tuned while the eye adapts further)
    const glow = CITY_GLOW_LEVEL * (U.uNight?.value || 0);
    M.uCityGlow.value.setRGB(CITY_GLOW[0] * glow, CITY_GLOW[1] * glow, CITY_GLOW[2] * glow);
    M.uShape.value.set(2200, 800, this.layer ? this.layer.density : 0.05, T.detail);
    M.uWindXZ.value.set(this.wind[0] * 0.3, this.wind[1] * 0.3);
    if (this.cirrus) M.uCirrus.value.set(this.cirrus.alt, this.cirrus.threshold, this.cirrus.opacity, 9000);
    else M.uCirrus.value.set(0, 0, 0, 1);
    this._pass(this._marchMat, this._marchRT);

    // temporal filter: last frame's result, reprojected by the clouds' distance
    const R = this._resolveMat.uniforms;
    const prev = this._hist[this._histIndex], next = this._hist[1 - this._histIndex];
    // a cut (teleport, a new camera, a fast swing) starts afresh
    const moved = cp.distanceTo(this._prevPos);
    const dirNow = camera.getWorldDirection(_d);
    const turned = this._prevDir.lengthSq() > 0 ? dirNow.angleTo(this._prevDir) : 0;
    const cut = !this._histValid || !this.temporal || moved > 400 || turned > 0.6;
    R.tCur.value = this._marchRT.textures[0];
    R.tDist.value = this._marchRT.textures[1];
    R.tHist.value = prev.texture;
    R.uProjInv.value.copy(camera.projectionMatrixInverse);
    R.uViewInv.value.copy(camera.matrixWorld);
    R.uPrevVP.value.copy(this._prevVP);
    R.uCamDelta.value.copy(cp).sub(this._prevPos);
    R.uLowSize.value.set(this._lowW, this._lowH);
    // after a cut, a running mean (1/2, 1/3 ...) until the usual 10 %: a clean picture in a few frames
    this._histN = cut ? 0 : this._histN + 1;
    const a = cut ? 1 : Math.max(0.1, 1 / (this._histN + 1));
    R.uBlend.value.set(a, Math.max(a, 0.3));
    const L = this.layer;
    R.uDefaultKm.value = L ? Math.max(1, Math.abs(0.5 * (L.base + L.top) - cp.y) * 0.002) : 10;
    this._pass(this._resolveMat, next);
    this._histIndex = 1 - this._histIndex;
    this._histValid = true;
    this._result = next;
    // this frame's camera for the next one (projection x view rotation; the position apart)
    _m.copy(camera.matrixWorldInverse);
    _m.elements[12] = _m.elements[13] = _m.elements[14] = 0;
    this._prevVP.multiplyMatrices(camera.projectionMatrix, _m);
    this._prevPos.copy(cp);
    this._prevDir.copy(dirNow);
  }

  /** Blend the clouds into Post's composite target; writes the scene's depth there too. */
  composite(r, target, { color, depth, camera, width, height }) {
    const C = this._compMat.uniforms;
    C.tScene.value = color;
    C.tCloud.value = (this._result || this._hist[this._histIndex]).texture;
    C.tDepth.value = depth;
    C.uLowSize.value.set(this._lowW, this._lowH);
    C.uFullSize.value.set(width, height);
    C.uDiv.value = this.tier.div;
    this._depthParams(camera, C.uDepthParams.value);
    this._pass(this._compMat, target);
  }

  /** Render targets owned here (GPU memory estimate). */
  targets() {
    return [this._noiseRT, this._coverRT, this._marchRT, ...this._hist].filter(Boolean);
  }

  info() {
    return {
      preset: this.preset, quality: this.quality, fallback: this.fallback, tier: { ...this.tier },
      low: [this._lowW || 0, this._lowH || 0], temporal: this.temporal, layer: this.layer ? { ...this.layer } : null,
    };
  }

  dispose() {
    for (const t of this.targets()) t.dispose();
    this._quad.geometry.dispose();
    for (const m of [this._noiseMat, this._coverMat, this._marchMat, this._resolveMat, this._compMat]) m.dispose();
    if (this.app?.post?.clouds === this) this.app.post.setClouds(null);
    this.env.uniforms.uCloudLayer.value.w = 0;
  }
}
