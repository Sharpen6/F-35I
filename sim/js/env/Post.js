// Post: the HDR frame and its output transform.
//
//   const post = new Post({ renderer, env });        // after the Environment
//   post.setQuality('high');                          // tiers below
//   post.render(scene, camera);                       // instead of renderer.render(scene, camera)
//
// The scene is drawn into a half-float render target with 4x MSAA (the canvas itself has no
// MSAA and no depth: only the last pass draws to it). Everything in that target is scene-referred
// radiance (Environment units: a white surface in the noon sun is about 1). Then:
//
//   1. clouds      an optional module (env/Clouds.js) composites its volumes over the resolved
//                  frame into a second (single-sample) target, writing the scene's depth there too;
//                  the transparent things near the camera are drawn into it after the clouds,
//                  depth tested. One MSAA resolve per frame (colour, and the depth only with clouds);
//                  see setClouds()
//   2. sun         a tiny pass measures how much of the sun's disc is visible (terrain, the jet,
//                  the canopy frame or clouds in front of it) into a 1 x 1 target, read back by the
//                  output pass on the GPU (no CPU readback, no stall)
//   3. bloom       physically thresholded: only what is brighter than about twice a white surface
//                  in full sun after exposure (the sun, glints, lights at night, the burner)
//                  spills over its neighbours; a 13-tap downsample chain with a Karis average on
//                  the first level and a tent-filtered upsample chain (Jimenez, SIGGRAPH 2014)
//   4. output      exposure (Environment.exposure), sun glare when looking near the sun, and in the
//                  outside views faint lens ghosts (VIEW_OPTICS: the cockpit view is an eye, the
//                  others a camera), AgX with a look (contrast, saturation, a lifted toe), night
//                  vision (rod vision's Purkinje shift: blues hold, reds fade, and a partial
//                  desaturation, when the eye is dark adapted), optional vignette and grain, dither,
//                  sRGB
//
// The GPU time of the scene, the clouds and the post passes is measured with timer queries when
// the browser has EXT_disjoint_timer_query_webgl2 (gpuTimes, ms, smoothed; the bench shows them).
//
// The HTML helmet display and the menus are separate canvases on top and are not touched.
// Quality tiers scale the MSAA, the bloom chain and the glare; every effect can be switched off
// (post.options), and ?post=0 bypasses this whole module (main.js draws straight to the canvas
// with three's AgX tone mapping, as a fallback).

import * as THREE from 'three';
import { EMITTER_DECODE_GLSL } from './emitters.js';

/** Per quality: MSAA samples, bloom levels (first level at half resolution), lens ghosts. */
export const POST_TIERS = {
  low: { samples: 4, bloomLevels: 5, ghosts: false },
  medium: { samples: 4, bloomLevels: 6, ghosts: true },
  high: { samples: 4, bloomLevels: 7, ghosts: true },
};

/**
 * The sun's glare and lens ghosts by the kind of view (post.view: the camera mode, set by main.js
 * every frame). Glare lobes: [fraction of the sun's irradiance scattered, width (rad)], see lobe()
 * in the output pass.
 *
 * eye     the cockpit view is the pilot's own eye behind the canopy: no lens, so no ghosts, ever.
 *         The sun is a blinding disc in the eye's own scatter, the CIE 135 disability glare
 *         (L_veil / E = 10 / th^3 + 5 / th^2 + ..., th in degrees: ~15 / sr at 1 deg, 0.07 at 10):
 *         here a third of it out to ~10 deg and less beyond (the full veil, added to a picture on
 *         a screen, reads as a washed-out scene round the sun rather than as dazzle). The canopy's
 *         haze and scratches add their own glow (js/aircraft/pcd/canopy.js).
 * camera  the outside views (chase, orbit, fly-by, tower) are a camera with a modern multicoated
 *         lens: its glare (diffraction and the glass' veiling glare: half to two thirds of the
 *         eye's, the glare as it was for every view) and a few small, faint ghosts (GHOSTS).
 */
export const VIEW_OPTICS = {
  eye: { core: [0.03, 0.0075], veil: [0.006, 0.1], ghosts: false },
  camera: { core: [0.015, 0.0087], veil: [0.004, 0.09], ghosts: true },
};
/** The view modes that are the pilot's eye (the rest are VIEW_OPTICS.camera). */
const EYE_VIEWS = new Set(['cockpit']);

/**
 * Lens ghosts of the camera views: each is the sun's light reflected twice inside the lens (off
 * two glass surfaces), so it carries at most ~R^2 of it, R ~ 0.2-0.3 % per multicoated surface: a
 * few millionths, less for the ghosts that also pass the aperture's edge. That light is spread over
 * the ghost's disc (the defocused image of the aperture), so the scene radiance it adds is
 * E f / solid angle (here 0.004-0.007 E / sr): a faint disc over dark ground at sunset, nothing
 * against the sky round the sun. t: where it lies on the line from the sun (0) through the centre
 * of the frame (1) to the mirror point (2); r: radius in image heights (fixed on the sensor: its
 * angle follows the field of view); f: share of the sun's irradiance; tint: the coatings' residual
 * reflection (green and magenta-amber).
 * (They were 0.012 E / sr whatever their size, up to a tenth of the frame wide: orange discs over
 * the picture at sunset, in the cockpit too.)
 */
export const GHOSTS = [
  { t: 0.58, r: 0.009, f: 2e-6, tint: [0.55, 1.0, 0.7] },
  { t: 1.32, r: 0.024, f: 8e-6, tint: [1.0, 0.62, 0.8] },
  { t: 1.78, r: 0.014, f: 4e-6, tint: [0.7, 0.8, 1.0] },
  { t: 2.04, r: 0.005, f: 5e-7, tint: [0.6, 1.0, 0.55] },
];

const FULLSCREEN_VERT = /* glsl */`
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

// ------------------------------------------------------------------------------------------
// bloom

const BLOOM_DOWN_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;          // 1 / source size
  uniform float uPrefilter;     // 1 on the first level: exposure, threshold and Karis average
  uniform float uExposure;
  uniform vec3 uThreshold;      // threshold, soft knee, clamp (exposure-scaled scene units)
  in vec2 vUv;
  out vec4 outColor;

  vec3 fetch(vec2 o) {
    vec3 c = texture(tSrc, vUv + o * uTexel).rgb;
    // no NaN / Inf from the scene into the chain (one bad pixel would light up the whole bloom)
    c = clamp(c, vec3(0.0), vec3(60000.0));
    return (c.r == c.r && c.g == c.g && c.b == c.b) ? c : vec3(0.0);
  }
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  // soft-knee threshold; the clamp keeps the sun's disc (tens of thousands) from flooding the
  // chain: its glare is drawn analytically in the output pass from its measured visibility
  vec3 threshold(vec3 c) {
    c = min(c * uExposure, vec3(uThreshold.z));
    float br = max(c.r, max(c.g, c.b));
    float T = uThreshold.x, K = uThreshold.y;
    float rq = clamp(br - T + K, 0.0, 2.0 * K);
    rq = rq * rq / (4.0 * K + 1e-4);
    return c * max(rq, br - T) / max(br, 1e-4);
  }
  void main() {
    vec3 a = fetch(vec2(-2.0, 2.0)), b = fetch(vec2(0.0, 2.0)), c = fetch(vec2(2.0, 2.0));
    vec3 d = fetch(vec2(-2.0, 0.0)), e = fetch(vec2(0.0, 0.0)), f = fetch(vec2(2.0, 0.0));
    vec3 g = fetch(vec2(-2.0, -2.0)), h = fetch(vec2(0.0, -2.0)), i = fetch(vec2(2.0, -2.0));
    vec3 j = fetch(vec2(-1.0, 1.0)), k = fetch(vec2(1.0, 1.0));
    vec3 l = fetch(vec2(-1.0, -1.0)), m = fetch(vec2(1.0, -1.0));
    vec3 o;
    if (uPrefilter > 0.5) {
      a = threshold(a); b = threshold(b); c = threshold(c); d = threshold(d); e = threshold(e);
      f = threshold(f); g = threshold(g); h = threshold(h); i = threshold(i);
      j = threshold(j); k = threshold(k); l = threshold(l); m = threshold(m);
      // Karis average: the five 2 x 2 groups weighted by 1 / (1 + luma), so one glint on the
      // water cannot make the whole bloom flicker
      vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25;
      vec3 g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
      float w0 = 0.5 / (1.0 + luma(g0)), w1 = 0.125 / (1.0 + luma(g1)), w2 = 0.125 / (1.0 + luma(g2));
      float w3 = 0.125 / (1.0 + luma(g3)), w4 = 0.125 / (1.0 + luma(g4));
      o = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    } else {
      o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    }
    outColor = vec4(o, 1.0);
  }`;

const BLOOM_UP_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tLow;       // the smaller, already upsampled level
  uniform sampler2D tHigh;      // this level of the downsample chain
  uniform vec2 uTexel;          // 1 / size of tLow
  uniform float uScatter;       // 0..1: how much of the wide levels reaches this one
  in vec2 vUv;
  out vec4 outColor;
  void main() {
    vec4 d = vec4(uTexel, -uTexel.x, 0.0);
    vec3 s = texture(tLow, vUv - d.xy).rgb + 2.0 * texture(tLow, vUv - d.wy).rgb + texture(tLow, vUv - d.zy).rgb
      + 2.0 * texture(tLow, vUv + d.zw).rgb + 4.0 * texture(tLow, vUv).rgb + 2.0 * texture(tLow, vUv + d.xw).rgb
      + texture(tLow, vUv + d.zy).rgb + 2.0 * texture(tLow, vUv + d.wy).rgb + texture(tLow, vUv + d.xy).rgb;
    vec3 high = texture(tHigh, vUv).rgb;
    outColor = vec4(mix(high, s / 16.0, uScatter), 1.0);
  }`;

// ------------------------------------------------------------------------------------------
// sun visibility: how much of the disc shows in the HDR frame (1 x 1 target, 21 samples)

const SUN_VIS_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tScene;
  uniform vec2 uSunUv;          // sun centre (uv)
  uniform vec2 uDiscUv;         // disc radius in uv (x, y)
  uniform float uDiscRadiance;  // expected radiance of the visible disc (scene units)
  in vec2 vUv;
  out vec4 outColor;
  void main() {
    float vis = 0.0, n = 0.0;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        vec2 o = vec2(float(i), float(j)) * 0.38;
        if (dot(o, o) > 0.85) continue;
        vec2 uv = uSunUv + o * uDiscUv;
        n += 1.0;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { vis += 1.0; continue; }   // off screen: assume clear
        float L = dot(texture(tScene, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
        vis += smoothstep(0.08, 0.35, L / max(uDiscRadiance, 1e-6));
      }
    }
    outColor = vec4(vis / max(n, 1.0), 0.0, 0.0, 1.0);
  }`;

// ------------------------------------------------------------------------------------------
// output transform

const OUTPUT_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tSunVis;
  uniform float uExposure;
  uniform float uBloom;         // bloom strength (0: off)
  uniform vec4 uSun;            // xy: sun uv, z: 1 in front of the camera, w: glare strength
  uniform vec3 uSunColor;       // sun irradiance at the camera x exposure (scene units)
  uniform vec2 uRadPerUv;       // radians per uv unit (x, y), for the glare's angular falloff
  uniform float uGhosts;        // lens ghosts strength (0: off; the eye has none)
  uniform vec4 uGhost[${GHOSTS.length}];       // t (along the line sun -> centre), radius (image heights), radiance per irradiance (1 / sr)
  uniform vec3 uGhostTint[${GHOSTS.length}];
  uniform vec4 uGlare;          // scattered fractions and widths (rad) of the core and the veil
  uniform vec4 uLook;           // contrast (power about the pivot), saturation, pivot, toe lift
  uniform float uNightVision;   // 0 photopic .. 1 fully scotopic (dark-adapted eye)
  uniform float uEmitters;      // 0 by day .. 1 once the lights are on (env.lightsOn): the lights' path
  uniform vec2 uVignetteGrain;  // strengths (0: off)
  uniform float uTime;
  in vec2 vUv;
  out vec4 outColor;
${EMITTER_DECODE_GLSL}

  // ---- AgX (Troy Sobotka; the three.js / Blender 4 fit), with an ASC CDL look in its log space
  const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
    vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
    vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 AgXInset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 AgXOutset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }
  vec3 agx(vec3 c) {
    const float minEv = -12.47393, maxEv = 4.026069;
    c = LINEAR_SRGB_TO_LINEAR_REC2020 * c;
    c = AgXInset * c;
    c = max(c, 1e-10);
    c = clamp((log2(c) - minEv) / (maxEv - minEv), 0.0, 1.0);
    c = agxContrast(c);
    // look (after the sigmoid, where Blender applies its AgX looks): contrast as a power about a
    // pivot (mid-tones keep their brightness, shadows deepen, highlights open up), then saturation
    vec3 p = vec3(uLook.z);
    c = mix(p * pow(max(c, 0.0) / p, vec3(uLook.x)),
            1.0 - (1.0 - p) * pow(max(1.0 - c, 0.0) / (1.0 - p), vec3(uLook.x)), step(p, c));
    // toe: AgX's sigmoid crushes everything below ~1 % of white; lift the deep shadows a little
    // (shade under a clear sky, a moonlit field), leaving black black and the mid-tones as they are
    vec3 omc = 1.0 - clamp(c, 0.0, 1.0);
    c += uLook.w * c * omc * omc * omc * omc;
    float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = l2 + uLook.y * (c - l2);
    c = AgXOutset * c;
    c = pow(max(vec3(0.0), c), vec3(2.2));
    c = LINEAR_REC2020_TO_LINEAR_SRGB * c;
    return clamp(c, 0.0, 1.0);
  }
  // a light's tone curve: AgX's own curve (look included) on its brightest channel, the others in
  // proportion. AgX itself bleaches any bright saturated colour (a red light at 3 on the display
  // comes out pink, at 64 white); a light seen at night keeps its hue (README "Lights at night")
  vec3 agxHue(vec3 c) {
    float m = max(c.r, max(c.g, c.b));
    return m > 1e-6 ? c * (agx(vec3(m)).g / m) : vec3(0.0);
  }
  vec3 srgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Glare around the sun: light scattered in the lens (or the eye) spreads the sun's irradiance
  // over the neighbouring directions. Each lobe is a normalised 2D Lorentzian-like profile
  // w / (2 pi (theta^2 + w^2)^1.5) (1 / sr, integrates to 1 over the plane), so the added radiance
  // is irradiance x fraction x profile: a bright core of a few degrees and a faint wide veil.
  float lobe(float th, float w) {
    float q = th * th + w * w;
    return w / (6.2831853 * q * sqrt(q));
  }

  void main() {
    vec3 c = texture(tScene, vUv).rgb;
    c = clamp(c, vec3(0.0), vec3(60000.0));
    c = (c.r == c.r && c.g == c.g && c.b == c.b) ? c : vec3(0.0);
    c *= uExposure;
    if (uBloom > 0.0) c += texture(tBloom, vUv).rgb * uBloom;

    // sun glare and ghosts (already exposure-scaled through uSunColor)
    if (uSun.w > 0.0 && uSun.z > 0.5) {
      float vis = texture(tSunVis, vec2(0.5)).r;
      vec2 d = (vUv - uSun.xy) * uRadPerUv;
      float th = length(d);
      vec3 sunE = uSunColor * vis * uSun.w;
      c += sunE * (uGlare.x * lobe(th, uGlare.y) + uGlare.z * lobe(th, uGlare.w));
      if (uGhosts > 0.0) {
        // ghosts on the line from the sun through the frame's centre (as a lens shows them), each
        // a soft disc a little brighter at its rim (the defocused aperture); they fade as the sun
        // leaves the frame. uGhost.z is the share of the irradiance over the disc's solid angle
        vec2 axis = vec2(0.5) - uSun.xy;
        float edge = smoothstep(1.2, 0.3, length(axis));
        vec2 asp = vec2(uRadPerUv.x / uRadPerUv.y, 1.0);
        for (int i = 0; i < ${GHOSTS.length}; i++) {
          vec4 g = uGhost[i];
          float dist = length((vUv - (uSun.xy + axis * g.x)) * asp);
          float disc = smoothstep(g.y, g.y * 0.82, dist) * (0.78 + 0.22 * smoothstep(g.y * 0.45, g.y, dist));
          c += sunE * uGhostTint[i] * (disc * g.z * uGhosts * edge);
        }
      }
    }

    // what the pixel holds (js/env/emitters.js): a surface (alpha >= 0.5), a cockpit display (~0)
    // or a light (alpha <= -64, its share of the pixel em)
    float sa = texture(tScene, vUv).a;
    float em = emitterWeight(sa) * uEmitters;

    // night vision: with a dark-adapted eye the rods take over. Their sensitivity peaks in the
    // blue-green (507 nm): blues hold their brightness, reds go dark (the Purkinje shift), colours
    // fade and a cool cast remains. Never all the way to grey (a cap of 60 %: the cones still see
    // the brighter things, and on a screen next to the HUD a fully grey night reads as a fault);
    // lights bright enough for the cones keep their colour
    if (uNightVision > 0.0) {
      float scot = dot(c, vec3(0.04, 0.45, 0.52));     // rod sensitivity in linear sRGB, roughly
      float k = 0.6 * uNightVision * smoothstep(0.6, 0.02, dot(c, vec3(0.2126, 0.7152, 0.0722)));
      // self-lit cockpit displays (the PCD, switch LEDs, the kneeboard: js/aircraft/pcd/interior.js
      // DISPLAY_ALPHA) write alpha 0 into the scene target and keep their colours: they are bright
      // enough for the cones, and a greyed display reads as a fault. A light (an emitter's mark) is
      // seen by the cones too, its halo by the rods: by its share of the pixel
      k *= step(0.5, abs(sa)) * (1.0 - em);
      c = mix(c, scot * vec3(0.62, 0.78, 1.0), k);
    }

    c = em > 0.0 ? mix(agx(c), agxHue(c), em) : agx(c);

    if (uVignetteGrain.x > 0.0) {
      vec2 q = vUv - 0.5;
      c *= 1.0 - uVignetteGrain.x * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
    }
    if (uVignetteGrain.y > 0.0) {
      float g = hash12(gl_FragCoord.xy + fract(uTime * 7.13) * 431.0) - 0.5;
      c *= 1.0 + g * uVignetteGrain.y * (1.0 - 0.6 * dot(c, vec3(0.33)));
    }
    c = srgb(c);
    // dither (triangular, 1/255): no banding in the dusk and night skies
    float n = hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 17.31) - 1.0;
    c += n / 255.0;
    outColor = vec4(c, 1.0);
  }`;

function fullscreenMaterial(name, fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({
    name, uniforms, vertexShader: FULLSCREEN_VERT, fragmentShader,
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, toneMapped: false,
  });
}

function halfTarget(w, h) {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  t.texture.colorSpace = THREE.NoColorSpace;
  return t;
}

const _v = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _c = new THREE.Vector3();
const _size = new THREE.Vector2();

/**
 * GPU time per pass with EXT_disjoint_timer_query_webgl2 (one query at a time: the passes are in
 * sequence). Results arrive a frame or more later; they are smoothed. No extension: times stay empty.
 */
class GpuTimer {
  constructor(renderer) {
    this.gl = renderer.getContext();
    let ext = null;
    try { ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch (e) { ext = null; }
    this.ext = ext;
    this.times = {};
    this._pending = [];
    this._free = [];
    this._open = null;
  }
  begin(name) {
    if (!this.ext || this._open) return;
    const q = this._free.pop() || this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._open = { name, q };
  }
  end() {
    if (!this._open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this._pending.push(this._open);
    this._open = null;
  }
  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this._pending.length) {
      const p = this._pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      this._pending.shift();
      const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
      if (!disjoint && Number.isFinite(ms)) {
        const o = this.times[p.name];
        this.times[p.name] = o === undefined ? ms : o + (ms - o) * 0.1;
      }
      this._free.push(p.q);
    }
    // a context that never answers (lost, throttled tab): do not pile queries up
    while (this._pending.length > 24) this._free.push(this._pending.shift().q);
  }
  dispose() {
    for (const p of this._pending) this.gl.deleteQuery(p.q);
    for (const q of this._free) this.gl.deleteQuery(q);
    this._pending = []; this._free = [];
  }
}

export class Post {
  constructor({ renderer, env, quality = 'high' }) {
    this.renderer = renderer;
    this.env = env;
    /** Switches (the settings and the console can change them at any time). */
    this.options = { bloom: true, glare: true, ghosts: true, vignette: false, grain: false, nightVision: true };
    /**
     * Look: AgX contrast (power about the pivot), saturation and toe lift; bloom strength and
     * threshold (scene units x exposure). (1.12 / 1.12 crushed the shade under a clear sky into
     * navy: shade 10:1 below the sunlit side came out at ~35/255.)
     */
    this.look = {
      contrast: 1.04, saturation: 1.04, pivot: 0.42, toe: 0.25,  // AgX look
      bloom: 0.08, threshold: 2.0, knee: 1.0, clamp: 64, scatter: 0.72,
      glare: 1.0,                        // x the glare lobes of VIEW_OPTICS
    };
    /**
     * The kind of view (the camera mode: 'cockpit' is the pilot's eye, the rest a camera, see
     * VIEW_OPTICS); main.js sets it before every frame.
     */
    this.view = 'chase';
    this.clouds = null;                  // a module with render(renderer, ctx) (env/Clouds.js)
    this.tier = POST_TIERS[quality] || POST_TIERS.high;
    this.quality = quality;
    this._w = 0; this._h = 0;

    // fullscreen triangle
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    this._quad = new THREE.Mesh(g, null);
    this._quad.frustumCulled = false;
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.hdr = null;                     // the scene target (MSAA, depth texture)
    this._comp = null;                   // with clouds: the composited frame (single sample, depth)
    this._bloomDown = [];
    this._bloomUp = [];
    this._sunVis = halfTarget(1, 1);

    this._downMat = fullscreenMaterial('BloomDown', BLOOM_DOWN_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 },
      uExposure: { value: 1 }, uThreshold: { value: new THREE.Vector3(2, 1, 64) },
    });
    this._upMat = fullscreenMaterial('BloomUp', BLOOM_UP_FRAG, {
      tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.7 },
    });
    this._sunMat = fullscreenMaterial('SunVisibility', SUN_VIS_FRAG, {
      tScene: { value: null }, uSunUv: { value: new THREE.Vector2() }, uDiscUv: { value: new THREE.Vector2() },
      uDiscRadiance: { value: 1 },
    });
    this._outMat = fullscreenMaterial('Output', OUTPUT_FRAG, {
      tScene: { value: null }, tBloom: { value: null }, tSunVis: { value: null },
      uExposure: { value: 1 }, uBloom: { value: 0 }, uSun: { value: new THREE.Vector4() },
      uSunColor: { value: new THREE.Color() }, uRadPerUv: { value: new THREE.Vector2(1, 1) },
      uGhost: { value: GHOSTS.map(() => new THREE.Vector4()) },
      uGhostTint: { value: GHOSTS.map((g) => new THREE.Vector3(...g.tint)) },
      uGhosts: { value: 0 }, uGlare: { value: new THREE.Vector4() }, uLook: { value: new THREE.Vector4(1, 1, 0.5, 0) },
      uNightVision: { value: 0 }, uEmitters: { value: 0 },
      uVignetteGrain: { value: new THREE.Vector2() }, uTime: { value: 0 },
    });
    this._time = 0;
    this._last = performance.now();
    this.stats = { w: 0, h: 0, samples: 0, bloomLevels: 0, passes: 0 };
    this._timer = new GpuTimer(renderer);
    /** GPU ms per pass ({ scene, clouds, post }), smoothed; null without timer queries. */
    this.gpuTimes = this._timer.ext ? this._timer.times : null;
  }

  setQuality(q) {
    this.quality = q;
    this.tier = POST_TIERS[q] || POST_TIERS.high;
    this._w = 0;                         // rebuild the targets on the next frame
  }

  /**
   * A clouds module (env/Clouds.js): active(), render(renderer, ctx) marches and filters them,
   * composite(renderer, target, ctx) writes the resolved frame with the clouds, and the scene's
   * depth, into the single-sample target Post gives it (ctx: {color, depth, camera, width, height}).
   */
  setClouds(clouds) { this.clouds = clouds; }

  _depthTexture(w, h) {
    const depth = new THREE.DepthTexture(w, h);
    // a reversed depth buffer needs float depth to keep its precision; the log depth is fine in 24 bits
    depth.type = this.renderer.capabilities.reversedDepthBuffer ? THREE.FloatType : THREE.UnsignedIntType;
    return depth;
  }

  /** With clouds: a single-sample target for the composited frame (the scene's depth written into it). */
  _ensureComp() {
    if (this._comp && this._comp.width === this._w && this._comp.height === this._h) return this._comp;
    this._comp?.dispose();
    this._comp = new THREE.WebGLRenderTarget(this._w, this._h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
      depthTexture: this._depthTexture(this._w, this._h),
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this._comp.texture.colorSpace = THREE.NoColorSpace;
    this._comp.texture.name = 'PostComposite';
    return this._comp;
  }

  _ensureTargets() {
    const r = this.renderer;
    r.getDrawingBufferSize(_size);
    const w = Math.max(1, Math.floor(_size.x)), h = Math.max(1, Math.floor(_size.y));
    if (w === this._w && h === this._h && this.hdr) return;
    this._w = w; this._h = h;
    this.hdr?.dispose();
    this._comp?.dispose();
    this._comp = null;
    const depth = this._depthTexture(w, h);
    this.hdr = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
      samples: this.tier.samples, depthTexture: depth,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this.hdr.texture.colorSpace = THREE.NoColorSpace;
    this.hdr.texture.name = 'PostHDR';
    // the clouds read the resolved colour and depth: never let three attach the textures to the
    // MSAA framebuffer itself (WEBGL_multisampled_render_to_texture, on some mobile and XR browsers)
    r.properties.get(this.hdr).__useRenderToTexture = false;
    for (const t of [...this._bloomDown, ...this._bloomUp]) t.dispose();
    this._bloomDown = [];
    this._bloomUp = [];
    let bw = w, bh = h;
    for (let i = 0; i < this.tier.bloomLevels; i++) {
      bw = Math.max(1, Math.ceil(bw / 2)); bh = Math.max(1, Math.ceil(bh / 2));
      this._bloomDown.push(halfTarget(bw, bh));
      this._bloomUp.push(halfTarget(bw, bh));
    }
    this.stats.w = w; this.stats.h = h; this.stats.samples = this.tier.samples; this.stats.bloomLevels = this.tier.bloomLevels;
  }

  _pass(material, target) {
    const r = this.renderer;
    this._quad.material = material;
    r.setRenderTarget(target);
    r.render(this._quad, this._camera);
    this.stats.passes++;
  }

  /**
   * Builds the passes' programs ahead (js/env/warmup.js), as render() draws them: bloom and the
   * sun's visibility into float targets, the output pass into the canvas (its sRGB variant).
   */
  warmup(w) {
    const q = this._quad, keep = q.material;
    for (const m of [this._downMat, this._upMat, this._sunMat]) {
      q.material = m;
      w.compile(q, this._camera, { target: w.floatTarget() });
    }
    q.material = this._outMat;
    w.compile(q, this._camera, { target: null });
    q.material = keep;
  }

  /** Draw the frame: scene into the HDR target, clouds, bloom, glare, output to the canvas. */
  render(scene, camera) {
    const r = this.renderer;
    this._ensureTargets();
    const now = performance.now();
    this._time += Math.min(0.25, (now - this._last) / 1000);
    this._last = now;
    this.stats.passes = 0;
    const autoReset = r.info.autoReset;
    r.info.autoReset = false;
    r.info.reset();
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    const T = this._timer;
    T.poll();

    // 1. scene (MSAA, resolved into hdr.texture by three after the call; the depth only with
    // clouds, which need it: without them three skips that blit and discards the MSAA depth).
    // With clouds, the transparent things close to the camera (the burner plume, the canopy,
    // sprites, smoke) wait on layer 31 until the clouds are in: a cloud behind the jet must not
    // cover its plume. Far transparent things (tree impostors) stay in, under the clouds.
    const C = this.clouds && this.clouds.active?.() ? this.clouds : null;
    const near = C ? this._liftNear(scene, camera) : null;
    this.hdr.resolveDepthBuffer = !!C;
    T.begin('scene');
    r.setRenderTarget(this.hdr);
    r.render(scene, camera);
    T.end();

    // 2. clouds: ray marched and filtered at low resolution, then composited over the resolved
    // frame into the single-sample composite target, with the scene's depth (the composite writes
    // it), and the near transparent things on top, depth tested. (Drawing the composite and those
    // back into the MSAA target cost two more colour + depth resolves, and blended over colour
    // that three had already invalidated after the first one.)
    let frame = this.hdr.texture;
    if (C) {
      T.begin('clouds');
      const comp = this._ensureComp();
      const ctx = { depth: this.hdr.depthTexture, color: this.hdr.texture, camera, width: this._w, height: this._h, post: this };
      C.render(r, ctx);
      C.composite(r, comp, ctx);
      r.autoClear = false;
      if (near.length) this._renderNear(scene, camera, comp);
      this._dropNear();
      r.autoClear = true;
      frame = comp.texture;
      T.end();
    }
    T.begin('post');

    const env = this.env;
    const exposure = (env.exposure ?? 1) * (env.exposureBias ?? 1);
    const o = this.options, L = this.look;

    // 3. sun visibility and glare parameters: an eye or a camera (VIEW_OPTICS)
    const out = this._outMat.uniforms;
    const optics = EYE_VIEWS.has(this.view) ? VIEW_OPTICS.eye : VIEW_OPTICS.camera;
    const sunDir = env.sunDirection;
    let glare = 0;
    if (o.glare && sunDir && sunDir.y > -0.03) {
      _v.copy(sunDir).multiplyScalar(1e5).add(camera.getWorldPosition(_cp));
      _v.project(camera);
      const inFront = _v.z < 1 && _v.z > -1;
      const su = _v.x * 0.5 + 0.5, sv = _v.y * 0.5 + 0.5;
      // angular size of a uv unit (perspective camera: 2 tan(fov/2) per screen height)
      const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov || 60) / 2);
      const radY = 2 * tanY, radX = radY * camera.aspect;
      out.uRadPerUv.value.set(radX, radY);
      // the ghosts' radiance per unit of the sun's irradiance: their share over their disc's
      // solid angle (the disc's profile holds ~0.8 of a flat disc's light)
      for (let i = 0; i < GHOSTS.length; i++) {
        const g = GHOSTS[i], a = g.r * radY;
        out.uGhost.value[i].set(g.t, g.r, g.f / (0.8 * Math.PI * a * a), 0);
      }
      out.uSun.value.set(su, sv, inFront ? 1 : 0, 0);
      if (inFront && su > -0.6 && su < 1.6 && sv > -0.6 && sv < 1.6) {
        const S = this._sunMat.uniforms;
        S.tScene.value = frame;
        S.uSunUv.value.set(su, sv);
        const R = 0.004654;              // the sun's angular radius
        S.uDiscUv.value.set(R / radX, R / radY);
        S.uDiscRadiance.value = env.sunDiscRadiance ? env.sunDiscRadiance() : 1000;
        const t = this._sunVis;
        this._pass(this._sunMat, t);
        out.tSunVis.value = t.texture;
        // irradiance from the sun at the camera (scene units), exposure scaled
        const sc = env.uniforms?.uSunColor?.value;
        if (sc) out.uSunColor.value.copy(sc).multiplyScalar(exposure);
        glare = L.glare;
      }
    }
    out.uSun.value.w = glare;
    out.uGhosts.value = o.ghosts && this.tier.ghosts && optics.ghosts ? 1 : 0;

    // 4. bloom
    const levels = this._bloomDown.length;
    if (o.bloom && levels > 0) {
      const D = this._downMat.uniforms;
      D.uExposure.value = exposure;
      D.uThreshold.value.set(L.threshold, L.knee, L.clamp);
      let src = frame, sw = this._w, sh = this._h;
      for (let i = 0; i < levels; i++) {
        D.tSrc.value = src;
        D.uTexel.value.set(1 / sw, 1 / sh);
        D.uPrefilter.value = i === 0 ? 1 : 0;
        const t = this._bloomDown[i];
        this._pass(this._downMat, t);
        src = t.texture; sw = t.width; sh = t.height;
      }
      const U = this._upMat.uniforms;
      U.uScatter.value = L.scatter;
      let low = this._bloomDown[levels - 1];
      for (let i = levels - 2; i >= 0; i--) {
        U.tLow.value = low.texture;
        U.tHigh.value = this._bloomDown[i].texture;
        U.uTexel.value.set(1 / low.width, 1 / low.height);
        const t = this._bloomUp[i];
        this._pass(this._upMat, t);
        low = t;
      }
      out.tBloom.value = low.texture;
      out.uBloom.value = L.bloom;
    } else {
      out.tBloom.value = frame;
      out.uBloom.value = 0;
    }

    // 5. output
    out.tScene.value = frame;
    out.uExposure.value = exposure;
    out.uLook.value.set(L.contrast, L.saturation, L.pivot, L.toe ?? 0);
    out.uGlare.value.set(optics.core[0], optics.core[1], optics.veil[0], optics.veil[1]);
    out.uNightVision.value = o.nightVision ? (env.nightVision ?? 0) : 0;
    // the lights' own tone curve from sunset (env.lightsOn): by day the frame is AgX's throughout
    out.uEmitters.value = env.lightsOn ?? 0;
    out.uVignetteGrain.value.set(o.vignette ? 0.35 : 0, o.grain ? 0.06 : 0);
    out.uTime.value = this._time;
    this._pass(this._outMat, null);
    T.end();

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.info.autoReset = autoReset;
  }

  /**
   * Moves the transparent objects near the camera that do not write depth (bounds < 150 m, within
   * 800 m; not the transmissive glass, which samples the opaque frame) to layer 31 only, and lists
   * the lights. They are out of this frame's shadow pass too: glass, plumes and sprites should not
   * cast shadows anyway. Transparent materials that write depth (foliage cards, say) stay in the
   * main pass: they cast their shadows and their depth already stops the clouds in front of them.
   */
  _liftNear(scene, camera) {
    const list = this._near || (this._near = []);
    const lights = this._lights || (this._lights = []);
    list.length = 0; lights.length = 0;
    const cp = camera.getWorldPosition(_cp);
    scene.traverseVisible((o) => {
      if (o.isLight) { lights.push(o); return; }
      if (!(o.isMesh || o.isSprite || o.isPoints || o.isLine)) return;
      if (!o.layers.test(camera.layers)) return;
      const m = o.material;
      if (!m) return;
      // decals (polygon offset) lie on opaque surfaces whose depth already stops the clouds
      const lift = (x) => x.transparent && !x.depthWrite && !(x.transmission > 0) && !x.polygonOffset;
      if (Array.isArray(m)) { if (!m.length || !m.every(lift)) return; }
      else if (!lift(m)) return;
      let r = 1, d;
      if (o.isSprite) d = _c.setFromMatrixPosition(o.matrixWorld).distanceTo(cp);
      else {
        const g = o.geometry;
        if (!g) return;
        if (!g.boundingSphere) g.computeBoundingSphere();
        const bs = g.boundingSphere;
        if (!bs || !Number.isFinite(bs.radius)) return;
        r = bs.radius * o.matrixWorld.getMaxScaleOnAxis();
        if (r > 150) return;
        d = _c.copy(bs.center).applyMatrix4(o.matrixWorld).distanceTo(cp) - r;
      }
      if (d > 800) return;
      o.userData._postMask = o.layers.mask;
      o.layers.set(31);
      list.push(o);
    });
    return list;
  }

  _renderNear(scene, camera, target) {
    const r = this.renderer;
    const camMask = camera.layers.mask;
    for (const l of this._lights) { l.userData._postMask = l.layers.mask; l.layers.enable(31); }
    camera.layers.set(31);
    const autoShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;           // the shadow maps of this frame are done
    r.setRenderTarget(target);
    r.render(scene, camera);
    r.shadowMap.autoUpdate = autoShadow;
    camera.layers.mask = camMask;
    for (const l of this._lights) l.layers.mask = l.userData._postMask;
  }

  _dropNear() {
    for (const o of this._near) o.layers.mask = o.userData._postMask;
    this._near.length = 0;
  }

  /** For the test API and the bench. */
  info() {
    const g = this.gpuTimes ? Object.fromEntries(Object.entries(this.gpuTimes).map(([k, v]) => [k, +v.toFixed(3)])) : null;
    return { quality: this.quality, ...this.stats, view: this.view, options: { ...this.options }, look: { ...this.look }, clouds: !!this.clouds, gpuMs: g };
  }

  /** Render targets this module owns (GPU memory estimate). */
  targets() {
    return [this.hdr, this._comp, ...this._bloomDown, ...this._bloomUp, this._sunVis].filter(Boolean);
  }

  dispose() {
    this._timer.dispose();
    for (const t of this.targets()) t.dispose();
    this._quad.geometry.dispose();
    for (const m of [this._downMat, this._upMat, this._sunMat, this._outMat]) m.dispose();
  }
}
