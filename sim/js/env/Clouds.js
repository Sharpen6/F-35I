// Clouds: fair-weather cumulus (ray marched volumes) and high cirrus, with weather presets.
//
//   const clouds = new Clouds(ctx);      // a graphics module (main.js _addGraphicsModules)
//   ?clouds=clear|few|scattered|broken|cirrus, or the Weather buttons in the menu (settings.clouds)
//
// Where the cumulus stand is one procedural field (js/env/cloudField.js: three levels of cells,
// each holding at most one cloud footprint, so many small puffs and fewer big clouds, grouped in
// clusters, sometimes in streets, thinner over the sea; js/env/cloudsWeather.js sets it from the
// preset and the time of day), drifting with the wind. Every frame:
//
//   1. cover     the field around the camera, in the wind's frame, in two maps: near (+-20 km, 39 m
//                texels) and far (+-150 km, 293 m, without the small puffs). Each texel holds the
//                signed distance to the nearest cloud's footprint and that cloud's height, radius
//                and raggedness. Redrawn only when the camera has moved a good part of the window
//                or the field's parameters changed (the time of day).
//   2. march     at half (high, medium) or quarter (low) resolution, each pixel's ray crosses the
//                cumulus slab (spherical shells: the deck curves away at the horizon) up to the
//                scene's depth. Empty air is skipped by the maps' distance. A cloud is shaped in
//                metres: a dome over its footprint (near-vertical sides, a rounded top, a flat base
//                at the condensation level), its surface pushed out and in by a tiling 3D Perlin-
//                Worley noise (turrets of ~600-75 m, bigger on bigger clouds) and near the camera by
//                a finer octave (~80-20 m): billows within billows above, ragged wisps low on the
//                sides and on the small fragments. The density rises from nothing to full within
//                ~10 m of that surface (40 m in the wisps; wider where a pixel covers more), so the
//                outlines are as sharp as a real cumulus' (a mean free path of ~20 m), and the step
//                follows the pixel's footprint: crisp at 1080p near and far, and in a telephoto.
//                Lit by the sun (or the moon at night): the optical depth towards it from six short
//                steps (12 m doubling, the first two with the fine octave: the shadowed creases
//                between billows) and three long ones through the other clouds' domes (1.2-4.8 km:
//                clouds shading each other at a low sun); single scattering with a two-lobe phase
//                function (the silver lining) plus multiple scattering as diffusion; the sky's light
//                from above and the ground's from below, dimmed by the cloud above and below; at
//                night also the cities' light from below (lightPollution.js: orange-grey bases over
//                Gush Dan). The light's colour is taken at the cloud's height (still lit after
//                sunset on the ground). Then the cirrus sheet (2D, streaked along the wind) above.
//                Aerial perspective to the cloud.
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
import { LP_GLSL } from './lightPollution.js';
import { FIELD, thresholdFor, shadowAt, cloudAt, cloudMapGLSL } from './cloudField.js';
import { CLOUD_PRESETS, DEFAULT_CLOUDS, fieldParams } from './cloudsWeather.js';

export { CLOUD_PRESETS, DEFAULT_CLOUDS };

/**
 * Per quality: resolution divisor, most steps along a ray, short and long light steps, the fine
 * detail octave (0/1), the shortest step (m) and the step per pixel footprint (a step of
 * stepPix x the width a pixel covers at that distance).
 */
export const CLOUD_TIERS = {
  low: { div: 4, steps: 80, lightSteps: 4, farSteps: 1, detail: 0, dtMin: 30, stepPix: 1.6 },
  medium: { div: 2, steps: 120, lightSteps: 5, farSteps: 2, detail: 1, dtMin: 14, stepPix: 1.25 },
  high: { div: 2, steps: 160, lightSteps: 6, farSteps: 3, detail: 1, dtMin: 8, stepPix: 1.0 },
};

const NEAR_N = 1024;
const NEAR_HALF = 20000;             // m: the near map spans +-20 km around the camera (39 m texels)
const FAR_N = 1024;
const FAR_HALF = 150000;             // m: the far map +-150 km (293 m texels, the big clouds only)
const MAX_DIST = 150000;             // m: the march ends here (the deck dissolves into the haze)
const NOISE_N = 64;
const P_SHAPE = 2400;                // m: the period of the shape noise (turrets ~600-75 m)
const P_DETAIL = 620;                // m: of the detail noise (~80-20 m); not a divisor of P_SHAPE
const WIND = [5.5, 0, 1.5];          // m/s: a summer day's westerly sea breeze (towards the east)
const RISE = 0.9;                    // m/s: the noise rises through the clouds (turrets grow and fade)
// cloud shadows: the sun's light under a cumulus is exp(-SHADOW_DEPTH) of the clear value. Not the
// cloud's optical depth (~50): most of the light gets through diffusely (~15 % under a 1 km cumulus)
const SHADOW_DEPTH = 1.8;

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
// cover maps: the field around the camera (cloudField.js cloudAt): signed distance (m), the cloud's
// height above the base (m), radius (m), raggedness

const COVER_FRAG = /* glsl */`
  precision highp float;
  uniform vec4 uWin;              // x0, z0 (field coordinates, min corner), size (m), levels
  in vec2 vUv;
  out vec4 outColor;
  ${ATMOSPHERE_PARS}
  ${cloudMapGLSL('atmo', 'uCloudLayer', 'uCloudWind', 'uCloudField')}
  void main() {
    vec4 m = atmoCloudMap(uWin.xy + vUv * uWin.z, uWin.w);
    outColor = vec4(clamp(m.x, -30000.0, 8000.0), m.yzw);
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
  uniform sampler2D tNear;        // cover maps: signed distance (m), height (m), radius (m), raggedness
  uniform sampler2D tFar;
  uniform vec4 uNearWin;          // x0, z0 (field coordinates, m), 1 / size, -
  uniform vec4 uFarWin;
  uniform vec2 uFullSize;
  uniform float uDiv;
  uniform mat4 uProjInv;
  uniform mat4 uViewInv;
  uniform vec4 uDepthParams;      // near, far, log2(far + 1), mode (0 log, 1 reversed, 2 standard)
  uniform vec4 uMarch;            // most steps, short light steps, long light steps, frame (0..15)
  uniform vec4 uStep;             // shortest step (m), step per pixel footprint, low-res pixel (rad), detail (0/1)
  uniform vec4 uLight;            // direction to the sun (or the moon), irradiance above the atmosphere
  uniform vec3 uLightTint;
  uniform vec3 uAmbSky;           // mean sky radiance on the clouds (scene units; not the moon itself)
  uniform vec3 uAmbGround;        // radiance of the ground below
  uniform vec4 uShape;            // -, -, extinction (1/m), -
  uniform vec4 uCirrus;           // altitude (m), field threshold, opacity (0: none), scale (m)
  uniform vec2 uEvolve;           // the noise's rise (m): shape, detail
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;   // in-scattered light, transmittance
  layout(location = 1) out vec4 outDist;    // distance to the cloud (km, light weighted), 0: none
  ${ATMOSPHERE_PARS}
  ${LP_GLSL}
  ${DEPTH_FN}

  float hg(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  }
  // the cover maps at field point q (m): the near one where it reaches (blended out towards its
  // edge), the far one beyond
  vec4 foot(vec2 q) {
    vec2 un = (q - uNearWin.xy) * uNearWin.z;
    vec4 f = textureLod(tFar, (q - uFarWin.xy) * uFarWin.z, 0.0);
    vec2 e = abs(un - 0.5) * 2.0;
    float wn = 1.0 - smoothstep(0.72, 0.92, max(e.x, e.y));
    if (wn > 0.0) f = mix(f, textureLod(tNear, un, 0.0), wn);
    return f;
  }
  // the size of the billows (m) on a cloud of height H and radius R
  float billowSize(vec4 F) { return clamp(0.4 * min(F.y, F.z), 30.0, 320.0); }
  // the dome over a cloud's footprint at height z above the base: signed distance (m), > 0 inside.
  // Near-vertical sides and a rounded top (a super-ellipse), cut flat at the base
  float dome(vec4 F, float z) {
    float H = max(F.y, 20.0), R = max(F.z, 20.0);
    float zt = clamp(z / H, 0.0, 1.0);
    float shrink = pow(max(1.0 - pow(zt, 2.5), 0.0), 0.4);
    return min(F.x - R * (1.0 - shrink), H - z);
  }
  // cumulus density 0..1 at field point q (m), height z above the base, F: the cover map there;
  // pix: the width (m) of a pixel (or a light step) there; detail: 0..1 the fine octave. sdf: the
  // signed distance (m, approximate) to the cloud's surface
  float density(vec2 q, float z, vec4 F, float pix, float detail, out float sdf) {
    float H = max(F.y, 20.0);
    float zt = z / H;
    // billows: the shape noise, more of it on bigger clouds, less where its finest octave would
    // be below a pixel (no shimmer)
    float A = billowSize(F) * (1.0 - 0.5 * smoothstep(60.0, 240.0, pix));
    vec4 n = textureLod(tNoise, vec3(q.x, z - uEvolve.x, q.y) * ${(1 / P_SHAPE).toFixed(8)}, 0.0);
    float bill = 0.55 * n.r + 0.45 * n.g;
    sdf = dome(F, z) + A * (bill - 0.5);
    // wispy low on the cloud and on the ragged small ones
    float wisp = max(F.w, 1.0 - smoothstep(0.04, 0.3, zt));
    if (detail > 0.0 && abs(sdf) < 70.0) {
      vec4 nd = textureLod(tNoise, vec3(q.x, z - uEvolve.y, q.y) * ${(1 / P_DETAIL).toFixed(8)} + 0.37, 0.0);
      float d = mix(nd.g, 1.0 - nd.b, wisp);
      sdf += detail * mix(30.0, 60.0, wisp) * (d - 0.5);
    }
    // from nothing to full within ~10 m of the surface (40 m in the wisps), wider where a pixel
    // is wider; the base flat and sharp
    float w = mix(10.0, 40.0, wisp) + 0.7 * pix;
    return clamp(sdf / w, 0.0, 1.0) * clamp(z / (5.0 + 0.7 * pix), 0.0, 1.0);
  }
  float heightOf(vec3 rel, float rc) {
    return length(vec3(rel.x, rel.y + rc, rel.z)) - uAtmoGeom.x;
  }
  // distances along the ray (from a camera at radius rc) to the sphere of radius R: (near, far)
  vec2 sphere(float rc, vec3 d, float R) {
    float b = rc * d.y;
    float c = rc * rc - R * R;
    float disc = b * b - c;
    vec2 r = vec2(-1.0);
    if (disc >= 0.0) { float s = sqrt(disc); r = vec2(-b - s, -b + s); }
    return r;
  }
  // interleaved gradient noise (Jimenez 2014), a new offset each frame: with the temporal filter
  // the ray starts cover a step evenly over 16 frames
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

  // optical depth towards the light from field point q, height z: short steps through this cloud
  // with its billows (12 m doubling; the first two with the fine octave: the creases between the
  // billows are in their neighbours' shadow), then long ones through the other clouds' domes
  // (1.2, 2.4, 4.8 km: at a low sun the clouds shade each other)
  float lightDepth(vec2 q, float z, vec3 Ld, float lu, float detail, float sigma0) {
    float tau = 0.0, lt = 0.0, ls = 12.0, sd;
    for (int k = 0; k < 6; k++) {
      if (k >= int(uMarch.y)) break;
      lt += ls * 0.5;
      vec2 qk = q + Ld.xz * lt;
      float zk = z + lu * lt;
      vec4 Fk = foot(qk);
      if (Fk.x > -billowSize(Fk) && zk > 0.0) tau += density(qk, zk, Fk, ls * 0.5, k < 2 ? detail : 0.0, sd) * ls;
      lt += ls * 0.5;
      ls *= 2.0;
    }
    for (int k = 0; k < 3; k++) {
      if (k >= int(uMarch.z)) break;
      float d = 1200.0 * exp2(float(k));
      float zk = z + lu * d;
      vec4 Fk = foot(q + Ld.xz * d);
      if (zk > 0.0) tau += clamp(dome(Fk, zk) / 120.0, 0.0, 1.0) * 400.0 * exp2(float(k));
    }
    return tau * sigma0;
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
        // steps: empty air is skipped by the cover maps' distance; near a cloud the step follows
        // the pixel's footprint (never shorter than uStep.x), outside the surface it is part of the
        // distance to it
        int steps = int(uMarch.x);
        float sigma0 = uShape.z;
        float t = t0 + max(uStep.x, t0 * uStep.z * uStep.y) * jit;
        vec3 sunE = vec3(-1.0), city = vec3(0.0);
        for (int i = 0; i < 256; i++) {
          if (i >= steps || t > t1 || T < 0.01) break;
          vec3 rel = dir * t;
          vec3 p = uCameraPos + rel;
          float z = heightOf(rel, rc) - base;
          float pix = t * uStep.z;
          float dtF = max(uStep.x, pix * uStep.y);
          vec2 q = p.xz + uCloudWind.xy;
          vec4 F = foot(q);
          // far from any footprint (more than its billows reach): skip by the horizontal distance
          float reach = 0.5 * billowSize(F) + 45.0 + pix;
          if (F.x < -reach) { t += max(-F.x - reach, dtF); continue; }
          float detail = uStep.w * (1.0 - smoothstep(12.0, 35.0, pix));
          float sdf;
          float dens = density(q, z, F, pix, detail, sdf);
          if (dens <= 0.0) { t += max(dtF, -sdf * 0.6); continue; }
          vec3 up = normalize(vec3(rel.x, rel.y + rc, rel.z));
          float lu = dot(up, uLight.xyz);
          if (sunE.x < 0.0) {
            // the light at the cloud's height (still lit when the sun has set on the ground), and
            // at night the cities' light under the cloud's base here (lightPollution.js)
            sunE = uLight.w * uLightTint * atmoTransmittance(Rg + base + z, lu);
            if (uLPBase.y > 0.0) city = lpCloudBase(p.xz);
          }
          float tau = lightDepth(q, z, uLight.xyz, lu, detail, sigma0);
          float powder = mix(1.0, 1.0 - 0.5 * exp(-2.0 * tau - dens * 4.0), 0.5 - 0.5 * cosT);
          vec3 S = sunScatter(sunE, tau, cosT, powder);
          // sky light from above, the ground's from below, each dimmed by the cloud between (the
          // dome above this point, the height above the base); the cities' light lights the base
          // and fades faster into the cloud, down to the ~15 % a thick cumulus lets through
          // diffusely (orange-grey bases; seen from above, a dim glow in the tops)
          float H = max(F.y, 20.0), R = max(F.z, 20.0);
          float rr = clamp(1.0 - F.x / R, 0.0, 1.0);
          float zTop = H * pow(max(1.0 - pow(rr, 2.5), 0.0), 0.4);
          float aoSky = 0.2 + 0.8 / (1.0 + 0.008 * max(zTop - z, 0.0));
          float aoGround = 0.3 + 0.7 / (1.0 + 0.01 * max(z, 0.0));
          float aoC = 0.15 + 0.85 / (1.0 + 0.02 * max(z, 0.0));
          S += uAmbSky * aoSky + uAmbGround * aoGround * 0.8 + city * aoC * 0.8;
          float sT = exp(-dens * sigma0 * dtF);
          L += T * S * (1.0 - sT);
          float w = T * (1.0 - sT);
          tw += t * w; wsum += w;
          T *= sT;
          t += dtF;
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

    // cirrus: a thin sheet high above. Patches (a low-frequency fBm, threshold from the preset's
    // coverage) of fibres: long streaks along the upper wind, 0.5-1 km across, bent by a domain warp
    if (uCirrus.z > 0.0 && uCamAltitude < uCirrus.x && T > 0.01) {
      vec2 sc = sphere(rc, dir, Rg + uCirrus.x);
      float tc = sc.y;
      if (tc > 0.0 && tc < tEnd && tc < 400000.0) {
        vec3 p = uCameraPos + dir * tc;
        vec2 w = normalize(vec2(${WIND[0].toFixed(2)}, ${WIND[2].toFixed(2)}));
        vec2 xz = p.xz + uCloudWind.xy * 2.5;
        vec2 r = vec2(dot(xz, w), dot(xz, vec2(-w.y, w.x))) / uCirrus.w;   // along, across the wind
        vec2 pr = r * vec2(0.35, 0.6) + vec2(13.7, 4.1);
        float patchv = (0.5 * atmoValueNoise(pr) + 0.25 * atmoValueNoise(pr * 2.03 + 17.1)
          + 0.125 * atmoValueNoise(pr * 4.07 + 31.7) + 0.0625 * atmoValueNoise(pr * 8.13 + 7.3)) / 0.9375;
        float mask = smoothstep(uCirrus.y, uCirrus.y + 0.2, patchv);
        float alpha = 0.0;
        if (mask > 0.0) {
          vec2 qc = r + 0.6 * vec2(atmoValueNoise(r * 0.9 + 3.1), atmoValueNoise(r * 0.9 + 7.7)) - 0.3;
          float fib = atmoValueNoise(qc * vec2(1.2, 9.0)) * 0.65 + atmoValueNoise(qc * vec2(2.6, 21.0)) * 0.35;
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
    vec4 sc = texture(tScene, vUv);
    vec3 s = sc.rgb;
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
    // the scene's alpha says what the pixel holds (js/env/emitters.js: a display's 0, a light's
    // mark); carried through, a light's mark fading with the cloud in front of it
    float sa = sc.a < -0.5 ? -64.0 + (sc.a + 64.0) * c.a : sc.a;
    outColor = vec4(s * c.a + c.rgb, sa);
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
const _cell = { sdf: 0, h: 0, r: 0, rag: 0 };

/** A cover map's target: half floats (metres), linear filtering, clamped at the window's edge. */
function coverTarget(n) {
  const t = new THREE.WebGLRenderTarget(n, n, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  t.texture.colorSpace = THREE.NoColorSpace;
  return t;
}

// the cirrus patches' threshold for a coverage: the value-noise fBm the march uses for them
// clusters around 0.5 (a fixed table: its quantiles)
function cirrusThreshold(coverage) {
  const c = Math.min(0.95, Math.max(0.05, coverage));
  return 0.5 + (0.5 - c) * 0.42;
}

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
    this.wind = [0, 0];                // field offset (m): field coordinates = world xz + wind
    FIELD.drift = this.wind;           // the CPU twin of the field drifts with it (cloudField.js)
    this._hour = 12;
    this._doy = 172;
    this._time = 0;                    // s, for the noise's rise
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

    // cover maps, near and far (redrawn when their window moves or the field changes: see render())
    this._nearRT = coverTarget(NEAR_N);
    this._farRT = coverTarget(FAR_N);
    this._coverMat = fsMaterial('CloudCover', COVER_FRAG, { ...U, uWin: { value: new THREE.Vector4() } });
    this._nearKey = '';
    this._farKey = '';

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
      tDepth: { value: null }, tNoise: { value: nt },
      tNear: { value: this._nearRT.texture }, tFar: { value: this._farRT.texture },
      uNearWin: { value: new THREE.Vector4() }, uFarWin: { value: new THREE.Vector4() },
      uFullSize: { value: new THREE.Vector2() }, uDiv: { value: 2 },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uDepthParams: { value: new THREE.Vector4() }, uMarch: { value: new THREE.Vector4() },
      uStep: { value: new THREE.Vector4() },
      uLight: { value: new THREE.Vector4() }, uLightTint: { value: new THREE.Color(1, 1, 1) },
      uAmbSky: { value: new THREE.Color() }, uAmbGround: { value: new THREE.Color() },
      uShape: { value: new THREE.Vector4(0, 0, 0.05, 0) }, uCirrus: { value: new THREE.Vector4() },
      uEvolve: { value: new THREE.Vector2() },
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
      // the threshold trims the field to the preset's coverage at the afternoon peak over the land
      // (cloudsWeather.js); other hours and the sea have less through the field's own parameters
      const peak = { ...FIELD, ...fieldParams(P.cu, 14, this._doy, this.env.year || 2026) };
      const threshold = thresholdFor(P.cu.coverage, peak);
      this.layer = { base: P.cu.base, top: P.cu.top, scale: P.cu.scale, threshold, opticalDepth: SHADOW_DEPTH, density: P.cu.density };
      U.uCloudLayer.value.set(P.cu.base, P.cu.top, threshold, this.enabled ? SHADOW_DEPTH : 0);
      U.uCloudWind.value.z = P.cu.scale;
      FIELD.threshold = threshold;
    } else {
      this.layer = null;
      U.uCloudLayer.value.w = 0;
    }
    this._applyField();
    this.cirrus = P.ci ? { alt: P.ci.alt, threshold: cirrusThreshold(P.ci.coverage), opacity: P.ci.opacity } : null;
    this.resetHistory();
  }

  /** The field's parameters for the preset, the hour and the day (cloudsWeather.js): FIELD, uCloudField. */
  _applyField() {
    const P = CLOUD_PRESETS[this.preset];
    if (!P?.cu) return;
    const f = fieldParams(P.cu, this._hour, this._doy, this.env.year || 2026);
    Object.assign(FIELD, f);
    this.env.uniforms.uCloudField.value.set(f.land, f.sea, f.streets, f.vert);
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

  /** The time of day changes the field (more cumulus over the land in the afternoon). */
  setTime(h, doy) {
    if (Number.isFinite(h)) this._hour = h;
    if (Number.isFinite(doy)) this._doy = doy;
    this._applyField();
    this.resetHistory();
  }

  /** The next frame starts the temporal filter afresh (a cut: teleport, time jump, new weather). */
  resetHistory() { this._histValid = false; }

  reset() { this.env.lightScale = 1; this.resetHistory(); }

  /**
   * How deep the world point (x, y, z) is in a cloud's dome (m; < 0 outside), from the CPU twin of
   * the cover map (no billows): the exposure inside a cloud, test scripts.
   */
  domeAt(x, y, z) {
    const L = this.layer;
    if (!L) return -1e6;
    const c = cloudAt(x + this.wind[0], z + this.wind[1], FIELD, _cell);
    const zz = y - L.base, H = Math.max(c.h, 20), R = Math.max(c.r, 20);
    const zt = Math.min(1, Math.max(0, zz / H));
    const shrink = Math.pow(Math.max(1 - Math.pow(zt, 2.5), 0), 0.4);
    return Math.min(c.sdf - R * (1 - shrink), H - zz, zz);
  }

  update(f) {
    // settings.clouds changed (the menu, the console): it replaces a ?clouds= override
    const s = this.app?.settings?.clouds;
    if (s !== this._setting) { this._setting = s; this._urlPreset = null; }
    const want = this._urlPreset || s || DEFAULT_CLOUDS;
    if (want !== this.preset) this.setPreset(want);
    const dt = Math.min(f.dt || 0, 0.25);
    this._time += dt;
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
      const inside = Math.min(1, Math.max(0, this.domeAt(cam.x, cam.y, cam.z) / 80));
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

  /** The five passes' programs, built ahead (js/env/warmup.js): each draws into a float target. */
  warmup(w) {
    if (!this.enabled) return;
    const q = this._quad, keep = q.material;
    for (const m of [this._noiseMat, this._coverMat, this._marchMat, this._resolveMat, this._compMat]) {
      if (!m) continue;
      q.material = m;
      w.compile(q, this._cam, { target: w.floatTarget() });
    }
    q.material = keep;
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

  /**
   * A cover map's window around field point (fx, fz): snapped to `snap` texels, so the same map
   * serves until the camera (or the drift) has moved that far; redrawn then, or when the field's
   * parameters changed. Returns the window's min corner in out.
   */
  _cover(target, n, half, snap, levels, fx, fz, keyName, out) {
    const texel = 2 * half / n, cell = texel * snap;
    const x0 = Math.round(fx / cell) * cell - half, z0 = Math.round(fz / cell) * cell - half;
    const F = this.env.uniforms.uCloudField.value, Ly = this.env.uniforms.uCloudLayer.value;
    const key = `${x0}|${z0}|${FIELD.scale}|${F.x.toFixed(4)}|${F.y.toFixed(4)}|${F.z.toFixed(3)}|${F.w.toFixed(3)}|${Ly.x}|${Ly.y}`;
    if (key !== this[keyName]) {
      this[keyName] = key;
      this._coverMat.uniforms.uWin.value.set(x0, z0, 2 * half, levels);
      this._pass(this._coverMat, target);
    }
    out.set(x0, z0, 1 / (2 * half), 0);
  }

  /** Ray march the clouds and filter them in time, at low resolution (Post.js, after the scene). */
  render(r, { depth, camera, width, height }) {
    if (!this._noiseReady) this._makeNoise();
    this._frame++;
    this._ensureTargets(width, height);
    const env = this.env, U = env.uniforms, T = this.tier;
    const M = this._marchMat.uniforms;
    // cover maps around the camera, in the wind's frame: near (+-20 km, redrawn every ~600 m of
    // travel) and far (+-150 km without the small puffs, every ~2.3 km)
    const cp = camera.getWorldPosition(_v);
    const fx = cp.x + this.wind[0], fz = cp.z + this.wind[1];
    if (this.layer) {
      this._cover(this._nearRT, NEAR_N, NEAR_HALF, 16, 3, fx, fz, '_nearKey', M.uNearWin.value);
      this._cover(this._farRT, FAR_N, FAR_HALF, 8, 2, fx, fz, '_farKey', M.uFarWin.value);
    }

    M.tDepth.value = depth;
    M.uFullSize.value.set(width, height);
    M.uDiv.value = T.div;
    camera.updateMatrixWorld();
    M.uProjInv.value.copy(camera.projectionMatrixInverse);
    M.uViewInv.value.copy(camera.matrixWorld);
    this._depthParams(camera, M.uDepthParams.value);
    M.uMarch.value.set(T.steps, T.lightSteps, T.farSteps, this.temporal ? this._frame % 16 : 0);
    // the angle a low-resolution pixel covers (the projection's vertical scale): the step and the
    // detail follow the pixel's footprint, so a telephoto view keeps its detail far away
    const pixRad = 2 / (camera.projectionMatrix.elements[5] * Math.max(1, Math.ceil(height / T.div)));
    M.uStep.value.set(T.dtMin, T.stepPix, pixRad, T.detail);
    // the light: the sun, or the (boosted) moon once the sun is down
    if (env.lightIsMoon && env.moon) {
      const e = env._moonLightBoosted ? env._moonLightBoosted() : 0;
      M.uLight.value.set(env.lightDirection.x, env.lightDirection.y, env.lightDirection.z, e);
      M.uLightTint.value.setRGB(1.04, 1.0, 0.93);
    } else {
      M.uLight.value.set(env.sunDirection.x, env.sunDirection.y, env.sunDirection.z, U.uSunIlluminance.value);
      M.uLightTint.value.setRGB(1, 1, 1);
    }
    // the sky's light without the moon's direct light (uAmbient has it for the terrain; the
    // clouds have the moon as their light: counted twice, the moonless side of a cloud glowed);
    // the cities' light under the bases comes from the shared uLP* uniforms (Environment)
    M.uAmbSky.value.copy(env.skyAmbient || U.uAmbient.value).multiplyScalar(1 / Math.PI);
    M.uAmbGround.value.copy(U.uGroundRadiance.value);
    M.uShape.value.set(0, 0, this.layer ? this.layer.density : 0.05, 0);
    M.uEvolve.value.set(this._time * RISE, this._time * RISE * 1.7);
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
    return [this._noiseRT, this._nearRT, this._farRT, this._marchRT, ...this._hist].filter(Boolean);
  }

  info() {
    return {
      preset: this.preset, quality: this.quality, fallback: this.fallback, tier: { ...this.tier },
      low: [this._lowW || 0, this._lowH || 0], temporal: this.temporal, layer: this.layer ? { ...this.layer } : null,
      field: { land: FIELD.land, sea: FIELD.sea, streets: FIELD.streets, vert: FIELD.vert },
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
