// Clouds: fair-weather cumulus (ray marched volumes) and high cirrus, with weather presets.
//
//   const clouds = new Clouds(ctx);      // a graphics module (main.js _addGraphicsModules)
//   ?clouds=clear|few|scattered|broken|cirrus, or the Weather buttons in the menu (settings.clouds)
//
// Where the cumulus stand is one procedural field (js/env/cloudField.js, and its GLSL twin
// atmoCloudCover in atmosphereGLSL.js), drifting with the wind. Every frame:
//
//   1. cover     the field around the camera is drawn into a 1024 x 1024 map (+-60 km), so the ray
//                marcher reads one texel instead of evaluating the noise at every step
//   2. march     at half (high, medium) or quarter (low) resolution, each pixel's ray crosses the
//                cumulus slab (spherical shells: the deck curves away at the horizon) up to the
//                scene's depth: density = the field's footprint x a height profile (flat base,
//                domed top, taller in the middle of a cloud), eroded by a tiling 3D Perlin-Worley
//                noise (64^3, made on the GPU at start-up) and finer detail at the edges; lit by
//                the sun (or the moon at night) through a short light march with a multiple
//                scattering approximation (Wrenninge's octaves) and a two-lobe phase function, and
//                by the sky and the ground; the sun's colour is taken at the cloud's height, so
//                clouds stay lit after sunset on the ground. Then the cirrus sheet (2D, streaked
//                along the wind) above. Aerial perspective from the camera to the cloud.
//   3. composite into the HDR frame (Post.js) with a depth-aware upsample: scene x transmittance
//                + in-scattered light. Post.js draws the transparent things near the camera (the
//                burner plume, the canopy, sprites) after this, so a cloud behind the jet never
//                covers its plume.
//
// The terrain gets the clouds' shadows without a texture (atmoSunIrradianceAt evaluates the same
// field where the sun's ray crosses the layer); three's own materials (the jet, buildings) get them
// per fragment from js/env/cloudShadowChunk.js. Inside a cloud the exposure meter sees less light
// (env.lightScale).

import * as THREE from 'three';
import { ATMOSPHERE_PARS } from './atmosphereGLSL.js';
import { thresholdFor, shadowAt, fieldAt } from './cloudField.js';

/** Weather presets: cumulus coverage (fraction of the sky), base and top (m MSL), feature scale (m). */
export const CLOUD_PRESETS = {
  clear: { label: 'Clear' },
  few: { label: 'Few cumulus', cu: { coverage: 0.12, base: 1350, top: 2350, scale: 2600, density: 0.05 } },
  scattered: { label: 'Scattered', cu: { coverage: 0.32, base: 1250, top: 2700, scale: 3200, density: 0.055 } },
  broken: { label: 'Broken', cu: { coverage: 0.62, base: 1050, top: 2300, scale: 4200, density: 0.06 } },
  cirrus: { label: 'High cirrus', ci: { coverage: 0.5, alt: 9500, opacity: 0.5 }, cu: { coverage: 0.04, base: 1500, top: 2300, scale: 2600, density: 0.05 } },
};
export const DEFAULT_CLOUDS = 'few';

/**
 * Per quality: resolution divisor, most steps along a ray, fewest steps across the cloud slab
 * (a deck seen edge-on), light steps, detail erosion.
 */
export const CLOUD_TIERS = {
  low: { div: 4, steps: 48, minSteps: 14, lightSteps: 3, detail: 0 },
  medium: { div: 2, steps: 72, minSteps: 20, lightSteps: 4, detail: 1 },
  high: { div: 2, steps: 96, minSteps: 28, lightSteps: 5, detail: 1 },
};

const COVER_N = 1024;
const COVER_HALF = 60000;            // m: the cover map spans +-60 km around the camera
const MAX_DIST = 150000;             // m: the march ends here (the deck dissolves into the haze)
const NOISE_N = 64;
const WIND = [5.5, 0, 1.5];          // m/s: a summer day's westerly sea breeze (towards the east)
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
    float r = 0.0;
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
// cover map: the raw field around the camera

const COVER_FRAG = /* glsl */`
  precision highp float;
  uniform vec4 uWin;              // x0, z0 (world, min corner), size (m)
  in vec2 vUv;
  out vec4 outColor;
  ${ATMOSPHERE_PARS}
  void main() {
    vec2 xz = uWin.xy + vUv * uWin.z;
    outColor = vec4(atmoCloudField((xz + uCloudWind.xy) / uCloudWind.z), 0.0, 0.0, 1.0);
  }`;

// ---------------------------------------------------------------------------------------
// ray march

const MARCH_FRAG = /* glsl */`
  precision highp float;
  precision highp sampler3D;
  uniform sampler2D tDepth;
  uniform sampler3D tNoise;
  uniform sampler2D tCover;
  uniform vec4 uCoverWin;         // x0, z0, 1 / size, -
  uniform vec2 uFullSize;
  uniform float uDiv;
  uniform mat4 uProjInv;
  uniform mat4 uViewInv;
  uniform vec4 uDepthParams;      // near, far, log2(far + 1), mode (0 log, 1 reversed, 2 standard)
  uniform vec4 uMarch;            // most steps, light steps, fewest steps across the slab, frame
  uniform vec4 uLight;            // direction to the sun (or the moon), irradiance above the atmosphere
  uniform vec3 uLightTint;
  uniform vec3 uAmbSky;           // mean sky radiance on the clouds (scene units)
  uniform vec3 uAmbGround;        // radiance of the ground below
  uniform vec4 uShape;            // shape period, detail period (m), extinction (1/m), detail (0/1)
  uniform vec4 uCirrus;           // altitude (m), field threshold, opacity (0: none), scale (m)
  uniform vec2 uWindXZ;           // drift of the 3D noise (m)
  in vec2 vUv;
  out vec4 outColor;
  ${ATMOSPHERE_PARS}

  float viewZ(float d) {
    if (uDepthParams.w < 0.5) return d >= 1.0 ? 1e9 : exp2(d * uDepthParams.z) - 1.0;
    float n = uDepthParams.x, f = uDepthParams.y;
    if (uDepthParams.w < 1.5) return d <= 0.0 ? 1e9 : n * f / (d * (f - n) + n);
    if (d >= 1.0) return 1e9;
    float z = d * 2.0 - 1.0;
    return 2.0 * n * f / ((f + n) - z * (f - n));
  }
  float hg(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  }
  float coverRaw(vec2 xz) {
    vec2 uv = (xz - uCoverWin.xy) * uCoverWin.z;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return atmoCloudField((xz + uCloudWind.xy) / uCloudWind.z);
    return texture(tCover, uv).r;
  }
  // cumulus density 0..1 at world xz and height h (m MSL)
  float density(vec3 p, float h, bool detail) {
    float base = uCloudLayer.x, top = uCloudLayer.y;
    float hf = (h - base) / (top - base);
    if (hf <= 0.0 || hf >= 1.0) return 0.0;
    float v = coverRaw(p.xz);
    float th = uCloudLayer.z;
    float cell = smoothstep(th - 0.03, th + 0.09, v);
    if (cell <= 0.0) return 0.0;
    // flat base, domed top; the middle of a cloud towers higher
    float topF = 0.3 + 0.7 * smoothstep(th, th + 0.16, v);
    float prof = smoothstep(0.0, 0.05, hf) * smoothstep(topF, topF * 0.45, hf);
    float shape = cell * prof;
    if (shape <= 0.0) return 0.0;
    vec3 q = vec3(p.x + uWindXZ.x, h, p.z + uWindXZ.y) / uShape.x;
    vec4 n = texture(tNoise, q);
    float billow = n.r * 0.6 + n.g * 0.4;
    float d = shape - (1.0 - billow) * 0.62;
    if (detail && d > 0.0 && d < 0.35) {
      vec3 qd = vec3(p.x + uWindXZ.x * 1.6, h, p.z + uWindXZ.y * 1.6) / uShape.y;
      vec4 nd = texture(tNoise, qd);
      float det = mix(nd.g, 1.0 - nd.g, smoothstep(0.2, 0.7, hf));   // wispy below, billowy above
      d -= (1.0 - det) * 0.22 * (1.0 - d / 0.35);
    }
    return clamp(d * 1.8, 0.0, 1.0);
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
  // white noise per pixel and frame: the start of each ray is jittered by up to one step (a
  // structured pattern such as interleaved gradient noise shows as stripes without a temporal filter)
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Light scattered towards the eye by a unit of cloud at optical depth tau from the sun:
  //   single scattering   phase (a strong forward lobe: the silver lining, and a weak backward
  //                       one) x the direct sun that is left, exp(-tau);
  //   multiple scattering a cloud is white because light bounces hundreds of times: the diffuse
  //                       light at depth tau falls off slowly, ~1 / (1 + 0.11 tau) (two-stream
  //                       diffusion with g = 0.85), and is isotropic. MS_A sets its level: a thick
  //                       sunlit cloud reaches ~0.7 of a white surface in the sun (E / pi), the base
  //                       of a 1 km cumulus with the sun overhead ~0.1-0.15 (both as observed).
  const float MS_A = 2.8;
  const float MS_K = 0.11;
  vec3 sunScatter(vec3 sunE, float tau, float cosT) {
    float ss = mix(hg(cosT, 0.8), hg(cosT, -0.25), 0.25);
    return sunE * (ss * exp(-tau) + MS_A * 0.0795775 / (1.0 + MS_K * tau));
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
    float jit = hash12(gl_FragCoord.xy + uMarch.w * vec2(37.0, 17.0));

    if (uCloudLayer.w > 0.0) {
      vec2 sb = sphere(rc, dir, Rg + base), st = sphere(rc, dir, Rg + top);
      float t0, t1;
      if (uCamAltitude < base) { t0 = sb.y; t1 = st.y; }
      else if (uCamAltitude < top) { t0 = 0.0; t1 = (sb.x > 0.0) ? sb.x : st.y; }
      else { t0 = st.x; t1 = (sb.x > 0.0) ? sb.x : st.y; if (st.x < 0.0) t1 = -1.0; }
      t0 = max(t0, 0.0);
      t1 = min(t1, tEnd);
      if (t1 > t0) {
        // step: fine near the camera, growing with distance (a pixel covers more there), but at
        // least uMarch.z steps across the slab, so a cloud deck seen edge-on is not skipped
        int steps = int(uMarch.x);
        float minSteps = uMarch.z;
        float span = t1 - t0;
        float dtSpan = span / minSteps;
        float t = t0;
        float dt = clamp(t * (0.02 + t / 40000.0), 20.0, dtSpan);
        t += dt * jit;
        vec3 sunE = vec3(-1.0);
        float sigma0 = uShape.z;
        for (int i = 0; i < 160; i++) {
          if (i >= steps || t > t1 || T < 0.01) break;
          dt = min(max(t * (0.02 + t / 40000.0), 20.0), max(dtSpan, 20.0));
          vec3 rel = dir * t;
          vec3 p = uCameraPos + rel;
          float h = heightOf(rel, rc);
          float dens = density(p, h, uShape.w > 0.5);
          if (dens > 0.0) {
            vec3 up = normalize(vec3(rel.x, rel.y + rc, rel.z));
            if (sunE.x < 0.0) {
              // the light at the cloud's height (still lit when the sun has set on the ground)
              sunE = uLight.w * uLightTint * atmoTransmittance(Rg + h, dot(up, uLight.xyz));
            }
            // optical depth towards the light: 5 steps of 70 m doubling (to ~2 km)
            float tau = 0.0, ls = 70.0, lt = 0.0;
            for (int k = 0; k < 6; k++) {
              if (k >= int(uMarch.y)) break;
              lt += ls * 0.5;
              vec3 lp = p + uLight.xyz * lt;
              float lh = h + dot(up, uLight.xyz) * lt;
              tau += density(lp, lh, false) * sigma0 * ls;
              lt += ls * 0.5;
              ls *= 2.0;
            }
            vec3 S = sunScatter(sunE, tau, cosT);
            // sky light from above, the ground's from below; less of it deep inside
            float hf = clamp((h - base) / (top - base), 0.0, 1.0);
            vec3 amb = uAmbSky * (0.35 + 0.65 * hf) + uAmbGround * (0.25 + 0.5 * (1.0 - hf));
            S += amb * (0.6 + 0.4 * exp(-dens * 3.0));
            float sigma = dens * sigma0;
            float sT = exp(-sigma * dt);
            L += T * S * (1.0 - sT);
            float w = T * (1.0 - sT);
            tw += t * w; wsum += w;
            T *= sT;
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
          T *= 1.0 - alpha;
        }
      }
    }
    outColor = vec4(L, T);
  }`;

// ---------------------------------------------------------------------------------------
// composite into the HDR frame, depth-aware upsample

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
  float viewZ(float d) {
    if (uDepthParams.w < 0.5) return d >= 1.0 ? 1e9 : exp2(d * uDepthParams.z) - 1.0;
    float n = uDepthParams.x, f = uDepthParams.y;
    if (uDepthParams.w < 1.5) return d <= 0.0 ? 1e9 : n * f / (d * (f - n) + n);
    if (d >= 1.0) return 1e9;
    float z = d * 2.0 - 1.0;
    return 2.0 * n * f / ((f + n) - z * (f - n));
  }
  void main() {
    vec3 s = texture(tScene, vUv).rgb;
    ivec2 fp = ivec2(gl_FragCoord.xy);
    float z0 = log(viewZ(texelFetch(tDepth, fp, 0).r));
    // 3 x 3 low-resolution texels around this pixel: a gaussian of the distance (a little wider
    // than bilinear: it also smooths the ray jitter) times a depth weight (no cloud bleeding over
    // the jet's or a hill's silhouette)
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
  }`;

function fsMaterial(name, fragmentShader, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({
    name, uniforms, vertexShader: FULLSCREEN_VERT, fragmentShader, glslVersion: THREE.GLSL3,
    depthTest: false, depthWrite: false, toneMapped: false, ...extra,
  });
}

const _v = new THREE.Vector3();
const _size = new THREE.Vector2();

export class Clouds {
  constructor(ctx) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;
    this.env = ctx.env;
    this.app = ctx.app;
    this.enabled = true;
    this.preset = null;
    this.tier = CLOUD_TIERS.high;
    this.wind = [0, 0];                // field offset (m)
    this._frame = 0;
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

    // cover map
    this._coverRT = new THREE.WebGLRenderTarget(COVER_N, COVER_N, {
      type: THREE.UnsignedByteType, format: THREE.RedFormat, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this._coverRT.texture.colorSpace = THREE.NoColorSpace;
    this._coverMat = fsMaterial('CloudCover', COVER_FRAG, { ...U, uWin: { value: new THREE.Vector4() } });
    this._coverWin = new THREE.Vector4();

    // march + composite
    this._cloudRT = null;
    this._marchMat = fsMaterial('CloudMarch', MARCH_FRAG, {
      ...U,
      tDepth: { value: null }, tNoise: { value: nt }, tCover: { value: this._coverRT.texture },
      uCoverWin: { value: new THREE.Vector4() }, uFullSize: { value: new THREE.Vector2() }, uDiv: { value: 2 },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uDepthParams: { value: new THREE.Vector4() }, uMarch: { value: new THREE.Vector4() },
      uLight: { value: new THREE.Vector4() }, uLightTint: { value: new THREE.Color(1, 1, 1) },
      uAmbSky: { value: new THREE.Color() }, uAmbGround: { value: new THREE.Color() },
      uShape: { value: new THREE.Vector4(2200, 330, 0.05, 0) }, uCirrus: { value: new THREE.Vector4() },
      uWindXZ: { value: new THREE.Vector2() },
    });
    this._compMat = fsMaterial('CloudComposite', COMPOSITE_FRAG, {
      tScene: { value: null }, tCloud: { value: null }, tDepth: { value: null },
      uLowSize: { value: new THREE.Vector2() }, uFullSize: { value: new THREE.Vector2() }, uDiv: { value: 2 },
      uDepthParams: { value: new THREE.Vector4() },
    });

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
  }

  /** Something to draw (Post.js asks before splitting the frame). */
  active() {
    return this.enabled && (!!this.layer || !!this.cirrus);
  }

  setQuality(q) {
    this.tier = CLOUD_TIERS[q] || CLOUD_TIERS.high;
    this._lowW = 0;
  }

  reset() { this.env.lightScale = 1; }

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
  }

  _ensureTargets(width, height) {
    const div = this.tier.div;
    const w = Math.max(1, Math.ceil(width / div)), h = Math.max(1, Math.ceil(height / div));
    if (this._cloudRT && this._lowW === w && this._lowH === h) return;
    this._cloudRT?.dispose();
    this._cloudRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    this._cloudRT.texture.colorSpace = THREE.NoColorSpace;
    this._lowW = w; this._lowH = h;
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

  /** Ray march the clouds into the low-resolution target (Post.js, after the scene). */
  render(r, { depth, camera, width, height }) {
    if (!this._noiseReady) this._makeNoise();
    this._frame++;
    this._ensureTargets(width, height);
    const env = this.env, U = env.uniforms;
    // cover map around the camera (snapped to its texels, so it does not crawl)
    const cp = camera.getWorldPosition(_v);
    const texel = 2 * COVER_HALF / COVER_N;
    const x0 = Math.floor((cp.x - COVER_HALF) / texel) * texel, z0 = Math.floor((cp.z - COVER_HALF) / texel) * texel;
    this._coverMat.uniforms.uWin.value.set(x0, z0, 2 * COVER_HALF, 0);
    this._pass(this._coverMat, this._coverRT);

    const M = this._marchMat.uniforms;
    M.tDepth.value = depth;
    M.uCoverWin.value.set(x0, z0, 1 / (2 * COVER_HALF), 0);
    M.uFullSize.value.set(width, height);
    M.uDiv.value = this.tier.div;
    camera.updateMatrixWorld();
    M.uProjInv.value.copy(camera.projectionMatrixInverse);
    M.uViewInv.value.copy(camera.matrixWorld);
    this._depthParams(camera, M.uDepthParams.value);
    M.uMarch.value.set(this.tier.steps, this.tier.lightSteps, this.tier.minSteps, this._frame % 64);
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
    M.uShape.value.set(2200, 330, this.layer ? this.layer.density : 0.05, this.tier.detail);
    M.uWindXZ.value.set(this.wind[0] * 0.3, this.wind[1] * 0.3);
    if (this.cirrus) M.uCirrus.value.set(this.cirrus.alt, this.cirrus.threshold, this.cirrus.opacity, 9000);
    else M.uCirrus.value.set(0, 0, 0, 1);
    this._pass(this._marchMat, this._cloudRT);
  }

  /** Blend the clouds into the HDR target (drawn over it: autoClear off). */
  composite(r, target, { color, depth, camera, width, height }) {
    const C = this._compMat.uniforms;
    C.tScene.value = color;
    C.tCloud.value = this._cloudRT.texture;
    C.tDepth.value = depth;
    C.uLowSize.value.set(this._lowW, this._lowH);
    C.uFullSize.value.set(width, height);
    C.uDiv.value = this.tier.div;
    this._depthParams(camera, C.uDepthParams.value);
    this._pass(this._compMat, target);
  }

  /** Render targets owned here (GPU memory estimate). */
  targets() {
    return [this._noiseRT, this._coverRT, this._cloudRT].filter(Boolean);
  }

  info() {
    return { preset: this.preset, tier: { ...this.tier }, low: [this._lowW || 0, this._lowH || 0], layer: this.layer ? { ...this.layer } : null };
  }

  dispose() {
    for (const t of this.targets()) t.dispose();
    this._quad.geometry.dispose();
    for (const m of [this._noiseMat, this._coverMat, this._marchMat, this._compMat]) m.dispose();
    if (this.app?.post?.clouds === this) this.app.post.setClouds(null);
    this.env.uniforms.uCloudLayer.value.w = 0;
  }
}
