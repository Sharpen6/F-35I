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
//   1. clouds      an optional module (env/Clouds.js) composites its volumes into the HDR frame,
//                  using the resolved depth; see setClouds()
//   2. sun         a tiny pass measures how much of the sun's disc is visible (terrain, the jet,
//                  the canopy frame or clouds in front of it) into a 1 x 1 target, read back by the
//                  output pass on the GPU (no CPU readback, no stall)
//   3. bloom       physically thresholded: only what is brighter than about twice a white surface
//                  in full sun after exposure (the sun, glints, lights at night, the burner)
//                  spills over its neighbours; a 13-tap downsample chain with a Karis average on
//                  the first level and a tent-filtered upsample chain (Jimenez, SIGGRAPH 2014)
//   4. output      exposure (Environment.exposure), sun glare and faint lens ghosts when looking
//                  near the sun, AgX with a look (contrast, saturation), night vision (scotopic
//                  blue shift and desaturation when the eye is dark adapted), optional vignette and
//                  grain, dither, sRGB
//
// The HTML helmet display and the menus are separate canvases on top and are not touched.
// Quality tiers scale the MSAA, the bloom chain and the glare; every effect can be switched off
// (post.options), and ?post=0 bypasses this whole module (main.js draws straight to the canvas
// with three's AgX tone mapping, as a fallback).

import * as THREE from 'three';

/** Per quality: MSAA samples, bloom levels (first level at half resolution), lens ghosts. */
export const POST_TIERS = {
  low: { samples: 4, bloomLevels: 5, ghosts: false },
  medium: { samples: 4, bloomLevels: 6, ghosts: true },
  high: { samples: 4, bloomLevels: 7, ghosts: true },
};

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
  uniform float uPrev;          // last value (smoothing)
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
  uniform float uGhosts;        // lens ghosts strength (0: off)
  uniform vec4 uGlare;          // scattered fractions and widths (rad) of the core and the veil
  uniform vec4 uLook;           // contrast (power about the pivot), saturation, pivot, toe lift
  uniform float uNightVision;   // 0 photopic .. 1 fully scotopic (dark-adapted eye)
  uniform vec2 uVignetteGrain;  // strengths (0: off)
  uniform float uTime;
  in vec2 vUv;
  out vec4 outColor;

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
        // ghosts on the line through the screen centre, mirrored about it (as a lens shows them)
        vec2 axis = vec2(0.5) - uSun.xy;
        float edge = smoothstep(1.2, 0.3, length(axis));
        for (int i = 0; i < 4; i++) {
          float t = float(i) == 0.0 ? 0.55 : float(i) == 1.0 ? 1.25 : float(i) == 2.0 ? 1.6 : 2.15;
          float r = float(i) == 0.0 ? 0.03 : float(i) == 1.0 ? 0.06 : float(i) == 2.0 ? 0.018 : 0.09;
          vec3 tint = float(i) == 0.0 ? vec3(0.6, 0.8, 1.0) : float(i) == 1.0 ? vec3(1.0, 0.7, 0.45)
            : float(i) == 2.0 ? vec3(0.7, 1.0, 0.75) : vec3(0.75, 0.6, 1.0);
          vec2 p = uSun.xy + axis * t;
          float dist = length((vUv - p) * vec2(uRadPerUv.x / uRadPerUv.y, 1.0));
          float disc = smoothstep(r, r * 0.7, dist) * (0.6 + 0.4 * smoothstep(r * 0.4, r, dist));
          c += sunE * tint * disc * uGhosts * edge * 0.012;
        }
      }
    }

    // night vision: with a dark-adapted eye the rods take over. Their sensitivity peaks in the
    // blue-green (507 nm): blues hold their brightness, reds go dark (the Purkinje shift), colours
    // fade and a cool cast remains. Never all the way to grey (a cap of 60 %: the cones still see
    // the brighter things, and on a screen next to the HUD a fully grey night reads as a fault);
    // lights bright enough for the cones keep their colour
    if (uNightVision > 0.0) {
      float scot = dot(c, vec3(0.04, 0.45, 0.52));     // rod sensitivity in linear sRGB, roughly
      float k = 0.6 * uNightVision * smoothstep(0.6, 0.02, dot(c, vec3(0.2126, 0.7152, 0.0722)));
      c = mix(c, scot * vec3(0.62, 0.78, 1.0), k);
    }

    c = agx(c);

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
      glare: 1.0, glareCore: [0.015, 0.0087], glareVeil: [0.004, 0.09],  // [fraction, width rad]
    };
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
      uDiscRadiance: { value: 1 }, uPrev: { value: 1 },
    });
    this._outMat = fullscreenMaterial('Output', OUTPUT_FRAG, {
      tScene: { value: null }, tBloom: { value: null }, tSunVis: { value: null },
      uExposure: { value: 1 }, uBloom: { value: 0 }, uSun: { value: new THREE.Vector4() },
      uSunColor: { value: new THREE.Color() }, uRadPerUv: { value: new THREE.Vector2(1, 1) },
      uGhosts: { value: 0 }, uGlare: { value: new THREE.Vector4() }, uLook: { value: new THREE.Vector4(1, 1, 0.5, 0) },
      uNightVision: { value: 0 },
      uVignetteGrain: { value: new THREE.Vector2() }, uTime: { value: 0 },
    });
    this._time = 0;
    this._last = performance.now();
    this.stats = { w: 0, h: 0, samples: 0, bloomLevels: 0, passes: 0 };
  }

  setQuality(q) {
    this.quality = q;
    this.tier = POST_TIERS[q] || POST_TIERS.high;
    this._w = 0;                         // rebuild the targets on the next frame
  }

  /** A clouds module: render(renderer, {scene: hdrTarget, depth, camera, width, height}) composites into hdrTarget. */
  setClouds(clouds) { this.clouds = clouds; }

  _ensureTargets() {
    const r = this.renderer;
    r.getDrawingBufferSize(_size);
    const w = Math.max(1, Math.floor(_size.x)), h = Math.max(1, Math.floor(_size.y));
    if (w === this._w && h === this._h && this.hdr) return;
    this._w = w; this._h = h;
    this.hdr?.dispose();
    const depth = new THREE.DepthTexture(w, h);
    // a reversed depth buffer needs float depth to keep its precision; the log depth is fine in 24 bits
    depth.type = r.capabilities.reversedDepthBuffer ? THREE.FloatType : THREE.UnsignedIntType;
    this.hdr = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
      samples: this.tier.samples, depthTexture: depth,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this.hdr.texture.colorSpace = THREE.NoColorSpace;
    this.hdr.texture.name = 'PostHDR';
    // the clouds pass samples the resolved colour and depth while drawing into the MSAA buffers:
    // never let three attach the textures themselves (WEBGL_multisampled_render_to_texture, on
    // some mobile and XR browsers), which would make that a feedback loop
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

    // 1. scene (MSAA, resolved into hdr.texture and hdr.depthTexture by three after the call).
    // With clouds, the transparent things close to the camera (the burner plume, the canopy,
    // sprites, smoke) wait on layer 31 until the clouds are in: a cloud behind the jet must not
    // cover its plume. Far transparent things (tree impostors) stay in, under the clouds.
    const C = this.clouds && this.clouds.active?.() ? this.clouds : null;
    const near = C ? this._liftNear(scene, camera) : null;
    r.setRenderTarget(this.hdr);
    r.render(scene, camera);

    // 2. clouds: ray marched at low resolution, then drawn over the MSAA buffer (every pixel is
    // overwritten, so the content three invalidated after the resolve does not matter; the depth
    // stays), resolved again; then the near transparent things, depth tested against the scene
    if (C) {
      const ctx = { depth: this.hdr.depthTexture, color: this.hdr.texture, camera, width: this._w, height: this._h, post: this };
      C.render(r, ctx);
      r.autoClear = false;
      C.composite(r, this.hdr, ctx);
      if (near.length) this._renderNear(scene, camera);
      this._dropNear();
      r.autoClear = true;
    }

    const env = this.env;
    const exposure = (env.exposure ?? 1) * (env.exposureBias ?? 1);
    const o = this.options, L = this.look;

    // 3. sun visibility and glare parameters
    const out = this._outMat.uniforms;
    const sunDir = env.sunDirection;
    let glare = 0;
    if (o.glare && sunDir && sunDir.y > -0.03) {
      _v.copy(sunDir).multiplyScalar(1e5).add(camera.getWorldPosition(new THREE.Vector3()));
      _v.project(camera);
      const inFront = _v.z < 1 && _v.z > -1;
      const su = _v.x * 0.5 + 0.5, sv = _v.y * 0.5 + 0.5;
      // angular size of a uv unit (perspective camera: 2 tan(fov/2) per screen height)
      const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov || 60) / 2);
      const radY = 2 * tanY, radX = radY * camera.aspect;
      out.uRadPerUv.value.set(radX, radY);
      out.uSun.value.set(su, sv, inFront ? 1 : 0, 0);
      if (inFront && su > -0.6 && su < 1.6 && sv > -0.6 && sv < 1.6) {
        const S = this._sunMat.uniforms;
        S.tScene.value = this.hdr.texture;
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
    out.uGhosts.value = o.ghosts && this.tier.ghosts ? 1 : 0;

    // 4. bloom
    const levels = this._bloomDown.length;
    if (o.bloom && levels > 0) {
      const D = this._downMat.uniforms;
      D.uExposure.value = exposure;
      D.uThreshold.value.set(L.threshold, L.knee, L.clamp);
      let src = this.hdr.texture, sw = this._w, sh = this._h;
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
      out.tBloom.value = this.hdr.texture;
      out.uBloom.value = 0;
    }

    // 5. output
    out.tScene.value = this.hdr.texture;
    out.uExposure.value = exposure;
    out.uLook.value.set(L.contrast, L.saturation, L.pivot, L.toe ?? 0);
    out.uGlare.value.set(L.glareCore[0], L.glareCore[1], L.glareVeil[0], L.glareVeil[1]);
    out.uNightVision.value = o.nightVision ? (env.nightVision ?? 0) : 0;
    out.uVignetteGrain.value.set(o.vignette ? 0.35 : 0, o.grain ? 0.06 : 0);
    out.uTime.value = this._time;
    this._pass(this._outMat, null);

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

  _renderNear(scene, camera) {
    const r = this.renderer;
    const camMask = camera.layers.mask;
    for (const l of this._lights) { l.userData._postMask = l.layers.mask; l.layers.enable(31); }
    camera.layers.set(31);
    const autoShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;           // the shadow maps of this frame are done
    r.setRenderTarget(this.hdr);
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
    return { quality: this.quality, ...this.stats, options: { ...this.options }, look: { ...this.look }, clouds: !!this.clouds };
  }

  /** Render targets this module owns (GPU memory estimate). */
  targets() {
    return [this.hdr, ...this._bloomDown, ...this._bloomUp, this._sunVis].filter(Boolean);
  }

  dispose() {
    for (const t of this.targets()) t.dispose();
    this._quad.geometry.dispose();
    for (const m of [this._downMat, this._upMat, this._sunMat, this._outMat]) m.dispose();
  }
}
